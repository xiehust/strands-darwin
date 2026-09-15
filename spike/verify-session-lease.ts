/**
 * Session lease (SER-091) — one live process per session.
 *
 * Two darwin processes given the same session would both overwrite the SDK's
 * `snapshot_latest.json` and both append to `trajectory.jsonl`, last writer wins on
 * each. `resolveSession` therefore takes `<sessionsDir>/<id>/lease.json` with the `wx`
 * flag whenever a session is selected, and what this suite pins, offline and in an
 * owned HOME, is the whole rule:
 *
 * - **Shape and place.** `{ pid, hostname, startedAt }` beside the trajectory, in the
 *   state dir — never the SDK's `session/<id>` and never under the project root.
 * - **Live vs stale is liveness, not a flag.** Same host: `process.kill(pid, 0)`
 *   decides (`EPERM` is alive). Another host: live until `startedAt` is
 *   `FOREIGN_LEASE_STALE_AFTER_MS` old. A record that does not parse is stale. There
 *   is no unlock file and no flag; a stale lease never blocks anyone.
 * - **Three shapes.** Explicit `--resume <id>` / `--session <id>` against a live lease
 *   is `SessionInUseError`, naming pid and start time, never a fallback. Bare
 *   `--resume` (`--continue`) against a live lease starts a *fresh* session and says why
 *   in `leaseNotice`. A stale lease is taken over — the file is rewritten — and the
 *   notice says whose it was.
 * - **Release.** `shutdown()` and the `/clear` retire remove the lease only while it
 *   still names this pid; the successor holds its own lease on its own id. A failed
 *   `create()` (bad config) leaves no lease behind.
 * - **The real process.** Through `cli.ts` with the offline `startup-cli` fixture:
 *   headless `-p --resume <id>` / `--session <id>` refuse on stderr with exit 1 and
 *   leave the lease bytes alone; `-p --continue` runs fresh with one `lease:` line; a
 *   stale lease is taken over, stated, and gone again after the process exits.
 *
 * Run: pnpm tsx spike/verify-session-lease.ts
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import {
  classifyLease,
  FOREIGN_LEASE_STALE_AFTER_MS,
  inspectLease,
  leasePath,
  pidAlive,
  readLastSessionId,
  resolveSession,
  SessionInUseError,
  SessionNotFoundError,
  sessionPaths,
  sessionStateDir,
  snapshotPath,
  writePointer,
  type SessionLeaseRecord,
} from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('session-lease');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const AGENT_ID = 'darwin';
/** What `spike/fixtures/startup-cli.ts`'s CaptureModel answers — the proof a run never reached a provider. */
const FIXTURE_REPLY = 'provider calls are forbidden in the startup fixture';

// SECTION: fixtures

setRuntimeModelFactoryForTest(async () => new CaptureModel('ok'));
const GOOD_CONFIG = `${JSON.stringify({ permissionMode: 'default', model: 'us.anthropic.claude-sonnet-4-6', region: 'us-west-2', memory: false }, null, 2)}\n`;
await writeFile(configPath(), GOOD_CONFIG, 'utf8');

const ROOT = await mkdtemp(path.join(os.tmpdir(), 'darwin-lease-project-'));
const HOST = os.hostname();
/** A pid that certainly existed and certainly no longer does. */
const DEAD_PID = spawnSync(process.execPath, ['-e', '0']).pid ?? 1;

/** A restorable-looking snapshot for `resolveSession`; the runtime sections use real ones. */
async function seedSnapshot(sessionId: string): Promise<void> {
  const file = snapshotPath(ROOT, sessionId, AGENT_ID);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{}', 'utf8');
}

async function seedLease(sessionId: string, record: Partial<SessionLeaseRecord> | string): Promise<string> {
  const file = leasePath(ROOT, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof record === 'string' ? record : `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

async function readLease(sessionId: string): Promise<SessionLeaseRecord | undefined> {
  try {
    return JSON.parse(await readFile(leasePath(ROOT, sessionId), 'utf8')) as SessionLeaseRecord;
  } catch {
    return undefined;
  }
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(() => undefined, (error: unknown) => error);
}

/** Every `lease.json` under `dir`, relative — the "never under the project root" witness. */
async function leaseFilesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name === 'lease.json').map((entry) => path.join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

// SECTION: pure rule

header('lease rule — liveness decides, never a flag');
{
  const source = await readFile(path.join(REPO_ROOT, 'src', 'agent', 'session.ts'), 'utf8');
  assert('the lease is written with the wx flag', source.includes("flag: 'wx'"));
  assert('the resolver reads no environment or argv override — liveness is the only key', !source.includes('process.env') && !source.includes('process.argv'));

  const now = Date.parse('2026-09-15T12:00:00.000Z');
  const env = { hostname: 'here', now, pidAlive: (pid: number) => pid === 100 };
  const local = { pid: 100, hostname: 'here', startedAt: '2026-09-15T11:00:00.000Z' };
  assert('same host, pid alive → live', classifyLease(local, env).kind === 'live');
  assert('same host, pid gone → stale', classifyLease({ ...local, pid: 101 }, env).kind === 'stale');
  const foreign = { pid: 100, hostname: 'elsewhere', startedAt: new Date(now - FOREIGN_LEASE_STALE_AFTER_MS + 60_000).toISOString() };
  assert('other host, younger than the bound → live (the pid cannot be checked)', classifyLease(foreign, env).kind === 'live');
  const oldForeign = { ...foreign, startedAt: new Date(now - FOREIGN_LEASE_STALE_AFTER_MS).toISOString() };
  assert('other host, at the bound → stale', classifyLease(oldForeign, env).kind === 'stale');
  assert('other host, unparseable start → stale', classifyLease({ ...foreign, startedAt: 'not a date' }, env).kind === 'stale');
  const unreadable = classifyLease(undefined, env);
  assert('an unparseable record is stale with no holder to name', unreadable.kind === 'stale' && unreadable.record === undefined);
  assert('the foreign bound is the documented 24 hours', FOREIGN_LEASE_STALE_AFTER_MS === 24 * 60 * 60 * 1000);

  assert('pidAlive: this process is alive', pidAlive(process.pid));
  assert('pidAlive: an exited process is not', !pidAlive(DEAD_PID));
  assert('pidAlive: non-positive and non-integer pids are dead, not a signal to the group', !pidAlive(0) && !pidAlive(-1) && !pidAlive(1.5));
  // pid 1 belongs to root: from an unprivileged user `kill(1, 0)` is EPERM, which must read alive.
  if (process.getuid?.() !== 0) assert('pidAlive: EPERM counts as alive', pidAlive(1));
}

// SECTION: resolveSession

header('selecting a session writes its lease — shape, place, wx');
{
  const fresh = await resolveSession(ROOT, { kind: 'new' }, AGENT_ID);
  const file = leasePath(ROOT, fresh.sessionId);
  assert('the lease lives in the state dir beside the trajectory, not the SDK snapshot dir',
    file === path.join(sessionStateDir(ROOT, fresh.sessionId), 'lease.json') && !file.includes(`${path.sep}session${path.sep}`));
  assert('the lease is under the owned HOME store', file.startsWith(path.join(HOME, '.darwin', 'sessions')));
  const record = await readLease(fresh.sessionId);
  assert('the record is { pid, hostname, startedAt } naming this process',
    record !== undefined && record.pid === process.pid && record.hostname === HOST && ISO.test(record.startedAt)
      && Object.keys(record).sort().join(',') === 'hostname,pid,startedAt');
  assert('the handle reports the same record', fresh.lease.record.pid === process.pid && fresh.lease.file === file);
  assert('an uncontested acquisition carries no notice', fresh.leaseNotice === undefined);
  assert('nothing was written under the project root', (await leaseFilesUnder(ROOT)).length === 0);
  const inspected = await inspectLease(ROOT, fresh.sessionId);
  assert('inspectLease reads it back as live', inspected.kind === 'live' && inspected.record.pid === process.pid);

  await fresh.lease.release();
  assert('release removes the file', !existsSync(file));
  assert('…and the empty state directory, so an aborted launch leaves no session behind', !existsSync(path.dirname(file)));
  assert('inspectLease on a released session is none', (await inspectLease(ROOT, fresh.sessionId)).kind === 'none');
  await fresh.lease.release();
  assert('release is idempotent', !existsSync(file));
}

header('explicit id against a live lease — refused with pid and time, never a fallback');
{
  const id = 'session-20260915-010000';
  await seedSnapshot(id);
  const startedAt = '2026-09-15T09:30:00.000Z';
  const file = await seedLease(id, { pid: process.pid, hostname: HOST, startedAt });
  const bytes = await readFile(file, 'utf8');
  const error = await rejection(resolveSession(ROOT, { kind: 'id', sessionId: id }, AGENT_ID));
  assert('SessionInUseError, the SessionNotFoundError sibling', error instanceof SessionInUseError && !(error instanceof SessionNotFoundError));
  assert('the message names the session, the pid and the start time, and what to do',
    error instanceof Error && error.message === `Session "${id}" is open in pid ${process.pid} since ${startedAt}; close it or start a new session.`);
  assert('the error carries the holder record', error instanceof SessionInUseError && error.lease.pid === process.pid && error.sessionId === id);
  assert('the live lease is byte-identical — wx never overwrote it', (await readFile(file, 'utf8')) === bytes);
  assert('a missing session is still SessionNotFoundError, checked before the lease',
    (await rejection(resolveSession(ROOT, { kind: 'id', sessionId: 'session-nope' }, AGENT_ID))) instanceof SessionNotFoundError
      && !existsSync(leasePath(ROOT, 'session-nope')));
}

header('bare --resume against a live lease — a fresh session, and the reason stated');
{
  const held = 'session-20260915-010000';
  await writePointer(ROOT, held);
  const file = leasePath(ROOT, held);
  const bytes = await readFile(file, 'utf8');
  const pointerBefore = await readFile(sessionPaths(ROOT).pointerFile, 'utf8');
  const resolved = await resolveSession(ROOT, { kind: 'continue' }, AGENT_ID);
  assert('a different, fresh session is selected', resolved.sessionId !== held && resolved.restoreRequested === false);
  assert('the notice says which session is open where, and that a fresh one started',
    resolved.leaseNotice === `session ${held} is open in pid ${process.pid} since 2026-09-15T09:30:00.000Z; started a fresh session instead`);
  assert('the fresh session holds its own lease', (await readLease(resolved.sessionId))?.pid === process.pid);
  assert('the held session\'s lease is untouched', (await readFile(file, 'utf8')) === bytes);
  assert('the pointer is not moved by the refusal', (await readFile(sessionPaths(ROOT).pointerFile, 'utf8')) === pointerBefore
    && await readLastSessionId(ROOT) === held);
  await resolved.lease.release();
  await rm(file);
}

header('stale lease — taken over, rewritten, stated');
{
  const id = 'session-20260915-020000';
  await seedSnapshot(id);
  await seedLease(id, { pid: DEAD_PID, hostname: HOST, startedAt: '2026-09-15T08:00:00.000Z' });
  const resolved = await resolveSession(ROOT, { kind: 'id', sessionId: id }, AGENT_ID);
  assert('the explicit id resolves and requests restore', resolved.sessionId === id && resolved.restoreRequested);
  assert('the file now names this process', (await readLease(id))?.pid === process.pid);
  assert('one bounded notice names the dead holder',
    resolved.leaseNotice === `session ${id}: took over a stale lease left by pid ${DEAD_PID} (started 2026-09-15T08:00:00.000Z)`);
  await resolved.lease.release();

  await seedLease(id, 'not json {{{');
  const replaced = await resolveSession(ROOT, { kind: 'id', sessionId: id }, AGENT_ID);
  assert('an unreadable lease is replaced and said so', replaced.leaseNotice === `session ${id}: replaced an unreadable lease file`
    && (await readLease(id))?.pid === process.pid);
  await replaced.lease.release();

  await writePointer(ROOT, id);
  await seedLease(id, { pid: DEAD_PID, hostname: HOST, startedAt: '2026-09-15T08:00:00.000Z' });
  const continued = await resolveSession(ROOT, { kind: 'continue' }, AGENT_ID);
  assert('bare --resume takes a stale lease over too, resuming the pointed session',
    continued.sessionId === id && continued.restoreRequested && continued.leaseNotice?.startsWith(`session ${id}: took over a stale lease`) === true);
  await continued.lease.release();
}

header('foreign hostname — live until the documented bound, then taken over');
{
  const id = 'session-20260915-030000';
  await seedSnapshot(id);
  const young = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await seedLease(id, { pid: DEAD_PID, hostname: 'other-machine.example', startedAt: young });
  const error = await rejection(resolveSession(ROOT, { kind: 'id', sessionId: id }, AGENT_ID));
  assert('a young lease from another host is live even though its pid is dead here',
    error instanceof SessionInUseError && error.message === `Session "${id}" is open on other-machine.example in pid ${DEAD_PID} since ${young}; close it or start a new session.`);
  await writePointer(ROOT, id);
  const fallback = await resolveSession(ROOT, { kind: 'continue' }, AGENT_ID);
  assert('bare --resume names the host in its fresh-session notice',
    fallback.sessionId !== id && fallback.leaseNotice?.includes(`is open on other-machine.example in pid ${DEAD_PID} since ${young}; started a fresh session instead`) === true);
  await fallback.lease.release();

  const old = new Date(Date.now() - FOREIGN_LEASE_STALE_AFTER_MS - 1000).toISOString();
  await seedLease(id, { pid: DEAD_PID, hostname: 'other-machine.example', startedAt: old });
  const taken = await resolveSession(ROOT, { kind: 'id', sessionId: id }, AGENT_ID);
  assert('past the bound it is stale: taken over and the host is named',
    taken.leaseNotice === `session ${id}: took over a stale lease left by pid ${DEAD_PID} on other-machine.example (started ${old})`
      && (await readLease(id))?.hostname === HOST);
  await taken.lease.release();
}

header('release — only while the file still names this process');
{
  const id = 'session-20260915-040000';
  await seedSnapshot(id);
  const mine = await resolveSession(ROOT, { kind: 'id', sessionId: id }, AGENT_ID);
  // Another launch took the lease over (this pid "died" from its point of view).
  const theirs = { pid: process.pid + 100_000, hostname: HOST, startedAt: '2026-09-15T10:00:00.000Z' };
  await seedLease(id, theirs);
  await mine.lease.release();
  assert('a lease rewritten by another holder is left alone by the old owner\'s release',
    JSON.stringify(await readLease(id)) === JSON.stringify(theirs));
  await rm(leasePath(ROOT, id));
}

// SECTION: runtime

header('runtime — holds the lease for its life, /clear re-leases, shutdown releases');
{
  const runtime = await AgentRuntime.create({ projectRoot: ROOT, session: { kind: 'new' }, permissionBridge: allowAllBridge });
  const firstId = runtime.info.sessionId;
  assert('a fresh runtime holds its session\'s lease', (await readLease(firstId))?.pid === process.pid && runtime.info.leaseNotice === undefined);

  // An explicit id needs a restorable snapshot before the lease is even consulted;
  // persist one exactly the way the end of a turn does.
  const agent = (runtime as unknown as { agent: import('@strands-agents/sdk').Agent }).agent;
  await agent.sessionManager?.saveSnapshot({ target: agent, isLatest: true });
  const busy = await rejection(AgentRuntime.create({ projectRoot: ROOT, session: { kind: 'id', sessionId: firstId }, permissionBridge: allowAllBridge }));
  assert('a second runtime on the same id in the same process is refused too — the pid is alive',
    busy instanceof SessionNotFoundError === false && busy instanceof SessionInUseError && busy.lease.pid === process.pid);
  assert('the refusal left the first lease in place', (await readLease(firstId))?.pid === process.pid);

  const successor = await runtime.startNewSession();
  const secondId = successor.info.sessionId;
  assert('/clear: the successor has a new id and its own lease', secondId !== firstId && (await readLease(secondId))?.pid === process.pid);
  assert('/clear: the retired predecessor\'s lease is released', !existsSync(leasePath(ROOT, firstId)));

  await successor.shutdown();
  assert('shutdown releases the lease', !existsSync(leasePath(ROOT, secondId)));
  assert('no lease file remains anywhere in the store', (await leaseFilesUnder(sessionPaths(ROOT).stateDir)).length === 0);
}

header('runtime — a failed create leaves no lease behind');
{
  await writeFile(configPath(), `${JSON.stringify({ permissionMode: 'not-a-mode' })}\n`, 'utf8');
  const error = await rejection(AgentRuntime.create({ projectRoot: ROOT, session: { kind: 'new' }, permissionBridge: allowAllBridge }));
  assert('the config problem is the error the caller sees', error instanceof Error && error.name === 'ConfigError');
  assert('the lease taken before the config was read is released again', (await leaseFilesUnder(sessionPaths(ROOT).stateDir)).length === 0);
  await writeFile(configPath(), GOOD_CONFIG, 'utf8');
}

// SECTION: real process

/**
 * One real `darwin -p` through `cli.ts`, with the offline `startup-cli` fixture as the
 * model factory; `cwd` is the fixture project and HOME the owned one, so the run
 * resolves the same store the sections above wrote to.
 */
async function headless(args: readonly string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    [path.join(REPO_ROOT, 'spike', 'fixtures', 'startup-cli.ts'), '-p', 'say ok', ...args],
    { cwd: ROOT, env: { ...process.env, HOME, DARWIN_MODEL_PRICES_FETCH: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const code = await Promise.race([
    new Promise<number | null>((resolve) => child.once('close', resolve)),
    new Promise<never>((_, reject) => setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('headless run did not exit'));
    }, 90_000)),
  ]);
  return { code, stderr, stdout };
}

header('real process — a completed headless run leaves a resumable session and no lease');
const seeded = await headless([]);
const seededId = await readLastSessionId(ROOT);
assert('the run completed with the fixture reply', seeded.code === 0 && seeded.stdout.includes(FIXTURE_REPLY));
assert('the pointer names the session it created', seededId !== undefined && seededId.startsWith('session-'));
assert('the process released its lease on shutdown', seededId !== undefined && !existsSync(leasePath(ROOT, seededId)));
assert('an ordinary run writes no lease: line', !seeded.stderr.split('\n').some((line) => line.startsWith('lease: ')));

if (seededId !== undefined) {
  header('real process — explicit id against a live lease refuses on stderr, exit 1');
  const startedAt = '2026-09-15T11:11:11.000Z';
  const file = await seedLease(seededId, { pid: process.pid, hostname: HOST, startedAt });
  const bytes = await readFile(file, 'utf8');
  for (const flag of ['--resume', '--session']) {
    const refused = await headless([flag, seededId]);
    assert(`${flag} <id>: exit 1 and nothing on stdout`, refused.code === 1 && refused.stdout === '');
    assert(`${flag} <id>: one error line naming the pid and start time`,
      refused.stderr.includes(`error: Session "${seededId}" is open in pid ${process.pid} since ${startedAt}; close it or start a new session.`));
    assert(`${flag} <id>: the live lease is byte-identical`, (await readFile(file, 'utf8')) === bytes);
  }
  const snapshotBefore = await readFile(snapshotPath(ROOT, seededId, AGENT_ID), 'utf8');

  header('real process — -p --continue against a live lease runs a fresh session and says why');
  const continued = await headless(['--continue']);
  assert('the run completed with the fixture reply', continued.code === 0 && continued.stdout.includes(FIXTURE_REPLY));
  const leaseLines = continued.stderr.split('\n').filter((line) => line.startsWith('lease: '));
  assert('exactly one lease: line, naming the open session and the fresh start',
    leaseLines.length === 1 && leaseLines[0] === `lease: session ${seededId} is open in pid ${process.pid} since ${startedAt}; started a fresh session instead`);
  const freshId = await readLastSessionId(ROOT);
  assert('the fresh session completed a turn and became the pointer target, as any completed turn does',
    freshId !== undefined && freshId !== seededId);
  assert('the held session\'s snapshot and lease are untouched',
    (await readFile(snapshotPath(ROOT, seededId, AGENT_ID), 'utf8')) === snapshotBefore && (await readFile(file, 'utf8')) === bytes);
  assert('the fresh session\'s lease is released after exit', freshId !== undefined && !existsSync(leasePath(ROOT, freshId)));

  header('real process — a stale lease is taken over, stated, and gone after exit');
  await seedLease(seededId, { pid: DEAD_PID, hostname: HOST, startedAt: '2026-09-15T07:00:00.000Z' });
  const resumed = await headless(['--resume', seededId]);
  assert('the run completed with the fixture reply', resumed.code === 0 && resumed.stdout.includes(FIXTURE_REPLY));
  assert('the session: record still names the requested id', resumed.stderr.includes(`session: ${seededId}\n`));
  assert('one lease: line names the dead holder',
    resumed.stderr.includes(`lease: session ${seededId}: took over a stale lease left by pid ${DEAD_PID} (started 2026-09-15T07:00:00.000Z)\n`));
  assert('the lease is released again once the process exits', !existsSync(leasePath(ROOT, seededId)));
}

await rm(ROOT, { recursive: true, force: true });

report();
