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
import { access, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { SessionManager } from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';

import { darwinDir, userProjectSessionsDir } from '../paths.js';

const SESSIONS_DIRNAME = 'sessions';
const POINTER_FILENAME = 'last-session.json';
/** Per-session append-only event record; a sibling of `background/` and `offload/`. */
export const TRAJECTORY_FILENAME = 'trajectory.jsonl';
/** Per-session opt-in diagnostics log; the same sibling convention. */
export const DIAGNOSTICS_FILENAME = 'diagnostics.log';

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
}

/** Mirrors the SDK's accepted session-id alphabet. */
export function isValidSessionId(value: string): boolean {
  return /^[a-z0-9_-]+$/.test(value);
}

/**
 * Picks the session id for this run. `continue` retains the TUI's forgiving
 * behavior and starts fresh when there is no pointer. An explicit id is strict:
 * it means "continue this persisted conversation", so a typo must not silently
 * create a different empty session.
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
      if (exists) return { sessionId: previous, restoreRequested: true };
    }
  }

  if (selector.kind === 'id') {
    if (!isValidSessionId(selector.sessionId)) {
      throw new Error(`Invalid session id ${JSON.stringify(selector.sessionId)}.`);
    }
    if (!(await snapshotExists(paths, selector.sessionId, agentId))) {
      throw new Error(`Session ${JSON.stringify(selector.sessionId)} does not exist in this project.`);
    }
    return { sessionId: selector.sessionId, restoreRequested: true };
  }

  return { sessionId: newSessionId(), restoreRequested: false };
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
