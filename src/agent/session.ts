/**
 * Session persistence and `--resume` support.
 *
 * Sessions live under `.darwin/` inside the project rather than in the home
 * directory. A coding agent's conversation is about one repository, so storing it
 * beside that repository keeps `--resume` naturally scoped per project, avoids
 * mapping a working directory onto a home-directory slug, and makes sessions easy
 * to inspect or delete. The cost is two `.gitignore` entries.
 */
import type { Dirent } from 'node:fs';
import { access, cp, mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { SessionManager } from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';

import { darwinDir, userProjectSessionsDir } from '../paths.js';

const SESSIONS_DIRNAME = 'sessions';
const POINTER_FILENAME = 'last-session.json';
/** Per-session append-only event record; a sibling of `background/` and `offload/`. */
export const TRAJECTORY_FILENAME = 'trajectory.jsonl';
/** Per-session opt-in diagnostics log; the same sibling convention. */
export const DIAGNOSTICS_FILENAME = 'diagnostics.log';
/**
 * Per-session ownership marker (SER-091), the same sibling convention:
 * `<sessionsDir>/<sessionId>/lease.json` names the one process that may append to
 * this session's record and overwrite its snapshot.
 */
export const LEASE_FILENAME = 'lease.json';
/**
 * A lease written on another host cannot be checked with `process.kill(pid, 0)`, so
 * it counts as live until its `startedAt` is this old; then it is stale and taken over.
 * There is no heartbeat: this is the only bound, and it is stated in the user guide.
 */
export const FOREIGN_LEASE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** Longest `hostname`/`startedAt` text a lease record may put into a notice, in code points. */
const MAX_LEASE_FIELD_CHARS = 64;

interface SessionPointer {
  sessionId: string;
  updatedAt: string;
}

export interface SessionPaths {
  /** Root of the tool's per-project state. */
  stateDir: string;
  /** Storage base directory handed to the SDK. */
  sessionsDir: string;
  /** File recording the most recent session id, so `--resume` can find it. */
  pointerFile: string;
}

export function sessionPaths(projectRoot: string): SessionPaths {
  const stateDir = userProjectSessionsDir(projectRoot);
  return {
    stateDir,
    sessionsDir: stateDir,
    pointerFile: path.join(stateDir, POINTER_FILENAME),
  };
}

function legacySessionPaths(projectRoot: string): SessionPaths {
  const stateDir = darwinDir(projectRoot);
  return {
    stateDir,
    sessionsDir: path.join(stateDir, SESSIONS_DIRNAME),
    pointerFile: path.join(stateDir, POINTER_FILENAME),
  };
}

/** `<sessionsDir>/<sessionId>/trajectory.jsonl`, the append-only event record. */
export function trajectoryPath(projectRoot: string, sessionId: string): string {
  return path.join(sessionPaths(projectRoot).sessionsDir, sessionId, TRAJECTORY_FILENAME);
}

/**
 * `<sessionsDir>/<sessionId>/diagnostics.log`, written only when `diagnostics: true`.
 *
 * Derived here, beside the record, because it is the same per-session sibling
 * convention and there must be exactly one place that knows the layout — a second
 * path scheme for the second artifact in the same directory is how they drift apart.
 */
export function diagnosticsPath(projectRoot: string, sessionId: string): string {
  return path.join(sessionPaths(projectRoot).sessionsDir, sessionId, DIAGNOSTICS_FILENAME);
}

/** The SDK snapshot `--resume` and `--session` restore, for one session and agent. */
export function snapshotPath(projectRoot: string, sessionId: string, agentId: string): string {
  return snapshotPathIn(sessionPaths(projectRoot), sessionId, agentId);
}

/** Directory the SDK owns for one session; the copy source for a fork. */
export function sessionDir(projectRoot: string, sessionId: string): string {
  return path.join(sessionPaths(projectRoot).sessionsDir, 'session', sessionId);
}

/** `<sessionsDir>/<sessionId>`, holding the trajectory, background logs and offload files. */
export function sessionStateDir(projectRoot: string, sessionId: string): string {
  return path.join(sessionPaths(projectRoot).sessionsDir, sessionId);
}

/** `<sessionsDir>/<sessionId>/lease.json` — the state dir, never the SDK's `session/<id>`. */
export function leasePath(projectRoot: string, sessionId: string): string {
  return leasePathIn(sessionPaths(projectRoot), sessionId);
}

function leasePathIn(paths: SessionPaths, sessionId: string): string {
  return path.join(paths.sessionsDir, sessionId, LEASE_FILENAME);
}

/** Whether this project has a restorable snapshot for `sessionId`. */
export function hasSnapshot(projectRoot: string, sessionId: string, agentId: string): Promise<boolean> {
  return snapshotExists(sessionPaths(projectRoot), sessionId, agentId);
}

/**
 * Every session id this project has a directory for, newest first.
 *
 * Ids are timestamp-prefixed and so sort chronologically, which is why a reverse
 * lexical sort is the right recency order and no `stat` call is needed. Both
 * layouts are listed: `session/<id>` is the SDK's snapshot directory, while
 * `<id>/` holds the trajectory — a session may have either without the other
 * (recording disabled, or a trajectory from a session whose snapshot was deleted).
 */
export async function listSessionIds(projectRoot: string): Promise<string[]> {
  const paths = sessionPaths(projectRoot);
  const found = new Set<string>();

  for (const directory of [path.join(paths.sessionsDir, 'session'), paths.sessionsDir]) {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // No sessions yet, or an unreadable directory: nothing to list either way.
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'session') continue;
      if (isValidSessionId(entry.name)) found.add(entry.name);
    }
  }

  return [...found].sort().reverse();
}

/**
 * Readable and sortable, e.g. `session-20260813-091422`.
 *
 * The SDK validates session ids against lowercase letters, digits, hyphens and
 * underscores, so an ISO timestamp cannot be used verbatim — its `T` and `:`
 * are both rejected.
 */
export function newSessionId(): string {
  const [date = '', time = ''] = new Date().toISOString().split('T');
  const compactDate = date.replace(/-/g, '');
  const compactTime = time.replace(/[:.Z]/g, '');
  return `session-${compactDate}-${compactTime}`;
}

/** The three ways a caller can choose the conversation for this run. */
export type SessionSelector =
  | { kind: 'new' }
  | { kind: 'continue' }
  | { kind: 'id'; sessionId: string };

export interface ResolvedSession {
  sessionId: string;
  /** Whether the selector named a snapshot that should be restored. */
  restoreRequested: boolean;
  /** This process's ownership of the session; release it when the runtime lets go. */
  lease: SessionLease;
  /**
   * One bounded sentence about how the lease was obtained when that is worth saying:
   * a stale lease taken over, or a bare `--resume` that found its session open
   * elsewhere and started fresh. Absent for the ordinary uncontested acquisition.
   */
  leaseNotice?: string;
}

/** Mirrors the SDK's accepted session-id alphabet. */
export function isValidSessionId(value: string): boolean {
  return /^[a-z0-9_-]+$/.test(value);
}

/**
 * An explicitly named session with no restorable snapshot in this project.
 *
 * Named so `cli.ts` can refuse it the way it refuses a `ConfigError` — one plain
 * line, exit code 1 — instead of letting a typo'd `--resume <id>` / `--session <id>`
 * crash the TUI branch with a stack trace. It is never a fallback: the caller asked
 * for one specific conversation, so darwin must not silently open another.
 */
export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${JSON.stringify(sessionId)} does not exist in this project.`);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * An explicitly named session whose lease another live process holds (SER-091).
 *
 * The sibling of {@link SessionNotFoundError}, refused in the same shape and for the
 * same reason: the caller asked for one specific conversation, and opening it twice
 * is how its snapshot and trajectory get corrupted (last writer wins on both). Never
 * a fallback — bare `--resume` is the forgiving selector, and it starts fresh instead.
 */
export class SessionInUseError extends Error {
  constructor(readonly sessionId: string, readonly lease: SessionLeaseRecord) {
    super(`Session ${JSON.stringify(sessionId)} is open ${describeHolder(lease)}; close it or start a new session.`);
    this.name = 'SessionInUseError';
  }
}

/** What `lease.json` holds: the owning process, where it runs, and when it took the session. */
export interface SessionLeaseRecord {
  pid: number;
  hostname: string;
  /** ISO-8601, the moment the lease was written. */
  startedAt: string;
}

/**
 * This process's hold on one session. Nothing but {@link release} ever removes the
 * file, and release removes it only while it still names this process — a takeover
 * by a later launch (after a crash or the unref'd exit fallback) is never undone by
 * the dead owner's belated cleanup.
 */
export interface SessionLease {
  readonly sessionId: string;
  readonly file: string;
  readonly record: SessionLeaseRecord;
  /** Idempotent and non-throwing: a lease that cannot be removed is left for the next launch to take over. */
  release(): Promise<void>;
}

/** How a lease file on disk reads right now; `none` when there is no file. */
export type LeaseStatus =
  | { kind: 'none' }
  | { kind: 'live'; record: SessionLeaseRecord }
  | { kind: 'stale'; record: SessionLeaseRecord | undefined };

/** The facts {@link classifyLease} needs, injectable so the rule is testable without a second process. */
export interface LeaseEnvironment {
  hostname: string;
  /** Epoch milliseconds. */
  now: number;
  pidAlive: (pid: number) => boolean;
}

/**
 * Picks the session id for this run and takes its lease. `continue` retains the
 * TUI's forgiving behavior and starts fresh when there is no pointer — or when the
 * pointed session is open in another live process (the notice says so). An explicit
 * id is strict: it means "continue this persisted conversation", so a typo must not
 * silently create a different empty session, and a live lease is a refusal
 * ({@link SessionInUseError}), never a fallback.
 */
export async function resolveSession(
  projectRoot: string,
  selector: SessionSelector,
  agentId: string,
): Promise<ResolvedSession> {
  const paths = sessionPaths(projectRoot);
  await migrateLegacySelection(projectRoot, paths, selector, agentId);

  if (selector.kind === 'continue') {
    const previous = await readPointer(paths.pointerFile);
    if (previous !== undefined) {
      const exists = await snapshotExists(paths, previous, agentId);
      if (exists) {
        const acquired = await acquireLease(paths, previous);
        if (acquired.kind === 'acquired') {
          return {
            sessionId: previous,
            restoreRequested: true,
            lease: acquired.lease,
            ...(acquired.notice === undefined ? {} : { leaseNotice: acquired.notice }),
          };
        }
        const fresh = await acquireFresh(paths);
        return {
          ...fresh,
          leaseNotice: `session ${previous} is open ${describeHolder(acquired.record)}; started a fresh session instead`,
        };
      }
    }
  }

  if (selector.kind === 'id') {
    if (!isValidSessionId(selector.sessionId)) {
      throw new Error(`Invalid session id ${JSON.stringify(selector.sessionId)}.`);
    }
    if (!(await snapshotExists(paths, selector.sessionId, agentId))) {
      throw new SessionNotFoundError(selector.sessionId);
    }
    const acquired = await acquireLease(paths, selector.sessionId);
    if (acquired.kind === 'held') throw new SessionInUseError(selector.sessionId, acquired.record);
    return {
      sessionId: selector.sessionId,
      restoreRequested: true,
      lease: acquired.lease,
      ...(acquired.notice === undefined ? {} : { leaseNotice: acquired.notice }),
    };
  }

  return acquireFresh(paths);
}

/**
 * A brand-new id and its lease. The id is timestamp-derived, so a collision is a
 * second darwin started in the same millisecond in the same project — the `wx`
 * write refuses it and the next id is tried, bounded.
 */
async function acquireFresh(paths: SessionPaths): Promise<ResolvedSession> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sessionId = newSessionId();
    const acquired = await acquireLease(paths, sessionId);
    if (acquired.kind === 'acquired') {
      return { sessionId, restoreRequested: false, lease: acquired.lease };
    }
    // Ids carry milliseconds: wait for the next one rather than retrying the same id.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Could not allocate a fresh session id: every candidate is already leased.');
}

type AcquireOutcome =
  | { kind: 'acquired'; lease: SessionLease; notice?: string }
  | { kind: 'held'; record: SessionLeaseRecord };

/**
 * Writes `lease.json` with `wx`. An existing file is read and classified: live means
 * `held`; stale means the file is removed and the `wx` write tried once more, so two
 * launches taking over the same stale lease at the same instant still end with one
 * holder (the second `wx` sees the first's file and reads it back as live). Never a
 * manual unlock: liveness, not a flag, decides.
 */
async function acquireLease(paths: SessionPaths, sessionId: string): Promise<AcquireOutcome> {
  const file = leasePathIn(paths, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const record: SessionLeaseRecord = { pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  let notice: string | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(file, body, { encoding: 'utf8', flag: 'wx' });
      return { kind: 'acquired', lease: makeLease(sessionId, file, record), ...(notice === undefined ? {} : { notice }) };
    } catch (error) {
      if (!isExisting(error)) throw error;
    }
    const status = classifyLease(await readLeaseRecord(file), defaultLeaseEnvironment());
    if (status.kind === 'live') return { kind: 'held', record: status.record };
    if (status.kind === 'none') continue; // Removed between the write and the read: try again.
    notice = status.record === undefined
      ? `session ${sessionId}: replaced an unreadable lease file`
      : `session ${sessionId}: took over a stale lease left by ${describeHolderShort(status.record)}`;
    await rm(file, { force: true });
  }
  // Both attempts lost the race to a competitor whose lease now reads live.
  const status = classifyLease(await readLeaseRecord(file), defaultLeaseEnvironment());
  if (status.kind === 'live') return { kind: 'held', record: status.record };
  throw new Error(`Could not take the lease for session ${JSON.stringify(sessionId)}: ${file} keeps reappearing.`);
}

function makeLease(sessionId: string, file: string, record: SessionLeaseRecord): SessionLease {
  let released = false;
  return {
    sessionId,
    file,
    record,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        const current = await readLeaseRecord(file);
        if (current === undefined || current.pid !== record.pid || current.hostname !== record.hostname) return;
        await rm(file, { force: true });
        // A session that never wrote anything else leaves no directory behind, so
        // `darwin sessions` and `trajectory list` do not count every aborted launch.
        // `rmdir` refuses a non-empty directory, which is exactly the intent.
        await rmdir(path.dirname(file)).catch(() => undefined);
      } catch {
        // Left in place: it names a pid that is about to be dead, so it is stale.
      }
    },
  };
}

/**
 * The lease rule (SER-091). Same host: the pid decides — alive (including `EPERM`,
 * which means it exists under another user) is live, gone is stale. Other host: live
 * until `startedAt` is {@link FOREIGN_LEASE_STALE_AFTER_MS} old, unparseable dates
 * count as stale. A record that does not parse is stale with no holder to name.
 */
export function classifyLease(record: SessionLeaseRecord | undefined, environment: LeaseEnvironment): LeaseStatus {
  if (record === undefined) return { kind: 'stale', record: undefined };
  if (record.hostname === environment.hostname) {
    return environment.pidAlive(record.pid) ? { kind: 'live', record } : { kind: 'stale', record };
  }
  const started = Date.parse(record.startedAt);
  if (Number.isNaN(started) || environment.now - started >= FOREIGN_LEASE_STALE_AFTER_MS) {
    return { kind: 'stale', record };
  }
  return { kind: 'live', record };
}

/** `process.kill(pid, 0)` — signal 0 checks existence; `EPERM` means it exists under another user. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EPERM';
  }
}

function defaultLeaseEnvironment(): LeaseEnvironment {
  return { hostname: os.hostname(), now: Date.now(), pidAlive };
}

/**
 * How one session's lease reads right now, for `darwin sessions` — a read of one
 * file and one signal-0 probe, no write. An absent file is `none`.
 */
export async function inspectLease(projectRoot: string, sessionId: string): Promise<LeaseStatus> {
  const file = leasePath(projectRoot, sessionId);
  try {
    await access(file);
  } catch {
    return { kind: 'none' };
  }
  return classifyLease(await readLeaseRecord(file), defaultLeaseEnvironment());
}

/** The parsed record, or `undefined` for a missing, unreadable or malformed file. */
async function readLeaseRecord(file: string): Promise<SessionLeaseRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof SessionLeaseRecord, unknown>>;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { pid, hostname, startedAt } = parsed;
    if (!Number.isInteger(pid) || typeof hostname !== 'string' || typeof startedAt !== 'string') return undefined;
    return {
      pid: pid as number,
      hostname: boundField(hostname),
      startedAt: boundField(startedAt),
    };
  } catch {
    return undefined;
  }
}

function boundField(value: string): string {
  const points = [...value];
  return points.length > MAX_LEASE_FIELD_CHARS ? `${points.slice(0, MAX_LEASE_FIELD_CHARS).join('')}…` : value;
}

/** `in pid N since <time>` on this host, `on <host> in pid N since <time>` elsewhere. */
export function describeHolder(record: SessionLeaseRecord, hostname = os.hostname()): string {
  return `${describeHolderLocation(record, hostname)} since ${record.startedAt}`;
}

/** The holder without the time: `in pid N`, or `on <host> in pid N` for another host. */
export function describeHolderLocation(record: SessionLeaseRecord, hostname = os.hostname()): string {
  const where = record.hostname === hostname ? '' : `on ${record.hostname} `;
  return `${where}in pid ${record.pid}`;
}

/** `pid N (started <time>)`, with the host named only when it is not this one. */
function describeHolderShort(record: SessionLeaseRecord): string {
  const where = record.hostname === os.hostname() ? '' : ` on ${record.hostname}`;
  return `pid ${record.pid}${where} (started ${record.startedAt})`;
}

function isExisting(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'EEXIST';
}

async function snapshotExists(paths: SessionPaths, sessionId: string, agentId: string): Promise<boolean> {
  try {
    await access(snapshotPathIn(paths, sessionId, agentId));
    return true;
  } catch {
    return false;
  }
}

/** The one place the snapshot layout is spelled out; both callers derive it here. */
function snapshotPathIn(paths: SessionPaths, sessionId: string, agentId: string): string {
  return path.join(
    paths.sessionsDir,
    'session',
    sessionId,
    'scopes',
    'agent',
    agentId,
    'snapshots',
    'snapshot_latest.json',
  );
}

async function migrateLegacySelection(
  projectRoot: string,
  target: SessionPaths,
  selector: SessionSelector,
  agentId: string,
): Promise<void> {
  const legacy = legacySessionPaths(projectRoot);
  const sessionId = selector.kind === 'id'
    ? selector.sessionId
    : selector.kind === 'continue'
      ? await readPointer(legacy.pointerFile)
      : undefined;
  if (sessionId === undefined || await snapshotExists(target, sessionId, agentId)) return;
  if (!(await snapshotExists(legacy, sessionId, agentId))) return;

  const source = path.join(legacy.sessionsDir, 'session', sessionId);
  const destination = path.join(target.sessionsDir, 'session', sessionId);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  const legacyBackground = path.join(legacy.sessionsDir, sessionId, 'background');
  try {
    await access(legacyBackground);
    const targetBackground = path.join(target.sessionsDir, sessionId, 'background');
    await mkdir(path.dirname(targetBackground), { recursive: true });
    await cp(legacyBackground, targetBackground, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (selector.kind === 'continue') {
    await mkdir(target.stateDir, { recursive: true });
    await writeFile(target.pointerFile, `${JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  }
}

async function readPointer(pointerFile: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(pointerFile, 'utf8');
  } catch {
    // No pointer yet, or unreadable: treated the same as "nothing to resume".
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SessionPointer>;
    return typeof parsed.sessionId === 'string' && parsed.sessionId !== '' ? parsed.sessionId : undefined;
  } catch {
    return undefined;
  }
}


function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

/**
 * The session id bare `--resume` would reopen right now, or `undefined`.
 *
 * A read-only projection of `last-session.json` for `darwin sessions`: an absent or
 * unreadable pointer is the ordinary "nothing to resume" answer, never an error.
 */
export async function readLastSessionId(projectRoot: string): Promise<string | undefined> {
  return readPointer(sessionPaths(projectRoot).pointerFile);
}

/** Records `sessionId` as the session a later `--resume` should pick up. */
export async function writePointer(projectRoot: string, sessionId: string): Promise<void> {
  const paths = sessionPaths(projectRoot);
  await mkdir(paths.stateDir, { recursive: true });
  const pointer: SessionPointer = { sessionId, updatedAt: new Date().toISOString() };
  await writeFile(paths.pointerFile, `${JSON.stringify(pointer, null, 2)}\n`, 'utf8');
}

/**
 * Builds the SDK session manager.
 *
 * `saveLatestOn: 'invocation'` (the default) snapshots after each turn finishes,
 * which is what `--resume` reads back. The snapshot is keyed by session id *and*
 * agent id, so the agent id must stay stable across runs for resume to find it.
 */
export function createSessionManager(projectRoot: string, sessionId: string): SessionManager {
  const paths = sessionPaths(projectRoot);
  return new SessionManager({
    sessionId,
    storage: new LocalFileStorage(paths.sessionsDir),
    saveLatestOn: 'invocation',
  });
}
