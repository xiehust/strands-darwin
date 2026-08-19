/**
 * `darwin sessions` + `--resume <id>` — listing the snapshot store and reopening by choice.
 *
 * No terminal and no model: the listing's whole logic lives in `src/cli-sessions.ts`,
 * driven here over real snapshot/trajectory fixtures in an owned HOME. The properties
 * with no single assertion are defended deliberately:
 *
 * - **Listing changes nothing it read.** Every file under the project's store —
 *   snapshots, trajectories, the resume pointer — is hashed before and after, and the
 *   two maps must be identical (no pointer moves, no rewrites, no new files).
 * - **Absence is an answer.** A session that ran with recording off reads
 *   `(not recorded)`; a project with no sessions is a normal notice, exit 0.
 * - **Bare `--resume` is untouched.** `--resume` alone, or followed by another flag,
 *   still parses to the pointer-following `continue` selector; only a plain token
 *   after it becomes an id.
 * - **A named session that does not exist is a refusal, never a fallback.**
 *   `resolveSession` answers `SessionNotFoundError` for a bogus id and for an id
 *   that lives in another project's store.
 *
 * Run: pnpm tsx spike/verify-sessions-command.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  resolveSession,
  SessionNotFoundError,
  sessionPaths,
  snapshotPath,
  trajectoryPath,
} from '../src/agent/session.js';
import { CliUsageError, parseCliArgs } from '../src/cli-args.js';
import {
  formatAge,
  isSessionsInvocation,
  MAX_PROMPT_PREVIEW_CHARS,
  parseSessionsArgs,
  runSessionsCommand,
} from '../src/cli-sessions.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Owned HOME before any path is derived: everything below resolves under
// `~/.darwin/sessions/<project-key>/`, and the suite must never touch the real one.
const OWNED_HOME = ownPrivateHome('sessions-command');
const ROOT = path.join(OWNED_HOME, 'project');
const OTHER_ROOT = path.join(OWNED_HOME, 'other-project');

/** Must match `AGENT_ID` in `src/agent/runtime.ts`. */
const AGENT_ID = 'darwin';

let seq = 0;

function line(record: Record<string, unknown>): string {
  seq += 1;
  return `${JSON.stringify({ v: 1, seq, t: '2026-08-18T00:00:01.000Z', ...record })}\n`;
}

/** Writes a restorable snapshot for `sessionId` and pins its mtime for age assertions. */
async function seedSnapshot(root: string, sessionId: string, mtime: Date): Promise<string> {
  const file = snapshotPath(root, sessionId, AGENT_ID);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ sessionId, messages: [] }), 'utf8');
  await utimes(file, mtime, mtime);
  return file;
}

async function seedTrajectory(root: string, sessionId: string, lines: string): Promise<string> {
  const file = trajectoryPath(root, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines, 'utf8');
  return file;
}

/** sha256 of every file under `dir`, keyed by relative path — the mutation-freedom witness. */
async function hashTree(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true });
  } catch {
    return hashes;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    hashes.set(path.relative(dir, file), createHash('sha256').update(await readFile(file)).digest('hex'));
  }
  return hashes;
}

function sameTree(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function runSessions(root: string, now?: number): Promise<Captured> {
  let out = '';
  let err = '';
  const io = {
    projectRoot: root,
    out: (text: string) => { out += text; },
    err: (text: string) => { err += text; },
  };
  const code = now === undefined ? await runSessionsCommand(io) : await runSessionsCommand(io, now);
  return { code, out, err };
}

function usageError(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof CliUsageError ? error.message : undefined;
  }
}

async function main(): Promise<void> {
  header('sessions — structural: no model, no writes by construction');
  {
    const source = readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'cli-sessions.ts'),
      'utf8',
    );
    assert('cli-sessions.ts imports nothing from the SDK — no model call by construction',
      !source.includes("'@strands-agents"));
    assert('cli-sessions.ts uses no write API — the store cannot be mutated by construction',
      !/writeFile|appendFile|createWriteStream|mkdir|unlink|rename|truncate|utimes|\brm\b|cp\(/.test(source));
    assert('cli-sessions.ts opens the record through readTrajectory, not a second reader',
      source.includes('readTrajectory'));
  }

  header('sessions — argument surface');
  {
    assert('darwin sessions routes as a subcommand', isSessionsInvocation(['sessions']));
    assert('an agent run does not route as sessions', !isSessionsInvocation(['--resume']));
    assert('sessions takes no arguments', usageError(() => parseSessionsArgs([])) === undefined);
    assert('sessions refuses stray arguments as usage errors',
      usageError(() => parseSessionsArgs(['list']))?.includes('takes no arguments') === true);
  }

  header('sessions — empty project is a normal notice');
  {
    const empty = await runSessions(ROOT);
    assert('exit code 0 with nothing to list', empty.code === 0);
    assert('absence is stated, not raised', empty.out.includes('no resumable sessions in this project'));
    assert('nothing on stderr', empty.err === '');
  }

  header('sessions — listing over real fixtures');
  const NOW = Date.parse('2026-08-19T12:00:00.000Z');
  const recorded = 'session-20260819-020000';
  const bare = 'session-20260818-020000';
  const damaged = 'session-20260817-020000';
  const unresumable = 'session-20260816-020000';
  const longPrompt = `fix the frame budget ${'overflow '.repeat(20)}`;
  {
    await seedSnapshot(ROOT, recorded, new Date(NOW - 5 * 60_000));
    await seedTrajectory(ROOT, recorded,
      line({ turn: 1, type: 'userInput', text: '  fix the\nframe budget overflow  ' }));
    await seedSnapshot(ROOT, bare, new Date(NOW - 3 * 60 * 60_000));
    await seedSnapshot(ROOT, damaged, new Date(NOW - 2 * 24 * 60 * 60_000));
    await seedTrajectory(ROOT, damaged, 'not json at all\n{"broken":\n');
    await seedTrajectory(ROOT, unresumable,
      line({ turn: 1, type: 'userInput', text: 'orphaned trajectory' }));
    const paths = sessionPaths(ROOT);
    await writeFile(paths.pointerFile,
      `${JSON.stringify({ sessionId: bare, updatedAt: '2026-08-18T09:00:00.000Z' }, null, 2)}\n`, 'utf8');

    const before = await hashTree(paths.stateDir);
    const listing = await runSessions(ROOT, NOW);
    const after = await hashTree(paths.stateDir);
    const rows = listing.out.split('\n').filter((row) => row.startsWith('session-'));

    assert('exit code 0', listing.code === 0);
    assert('every resumable session is listed once', rows.length === 3);
    assert('newest first by activity',
      rows[0]?.startsWith(recorded) === true &&
      rows[1]?.startsWith(bare) === true &&
      rows[2]?.startsWith(damaged) === true);
    assert('age comes from the snapshot, humanized',
      rows[0]?.includes('5m ago') === true &&
      rows[1]?.includes('3h ago') === true &&
      rows[2]?.includes('2d ago') === true);
    assert('first user prompt shown where recorded, whitespace collapsed to one line',
      rows[0]?.includes('fix the frame budget overflow') === true);
    assert('a session with no trajectory reads (not recorded) — absence is an answer',
      rows[1]?.includes('(not recorded)') === true);
    assert('a corrupt trajectory degrades to (not recorded), never an error',
      rows[2]?.includes('(not recorded)') === true && listing.err === '');
    assert('the pointer target is marked (last)',
      rows[1]?.includes('(last)') === true &&
      rows[0]?.includes('(last)') === false && rows[2]?.includes('(last)') === false);
    assert('a session without a restorable snapshot is skipped and the skip is stated',
      !listing.out.includes(unresumable) &&
      listing.out.includes('1 session(s) without a restorable snapshot not listed'));
    assert('the listing points at the resume verb', listing.out.includes('darwin --resume <id>'));
    assert('the store is byte-identical after the listing (no pointer moves, no rewrites)',
      before.size > 0 && sameTree(before, after));
  }

  header('sessions — a long first prompt stays one bounded row cell');
  {
    const verbose = 'session-20260819-030000';
    await seedSnapshot(ROOT, verbose, new Date(NOW - 60_000));
    await seedTrajectory(ROOT, verbose, line({ turn: 1, type: 'userInput', text: longPrompt }));
    const listing = await runSessions(ROOT, NOW);
    const row = listing.out.split('\n').find((r) => r.startsWith(verbose));
    assert('the excerpt is capped and marked as cut',
      row !== undefined && row.includes('…') &&
      row.includes(longPrompt.slice(0, 32)) && !row.includes(longPrompt.trim()));
    assert('the cap is the declared constant',
      (row?.match(/fix the frame budget [overflow ]+…/)?.[0]?.replace('…', '').length ?? 0) <=
        MAX_PROMPT_PREVIEW_CHARS);
  }

  header('formatAge — coarse, human, monotonic');
  {
    assert('under a minute reads just now', formatAge(30_000) === 'just now');
    assert('minutes', formatAge(5 * 60_000) === '5m ago');
    assert('hours', formatAge(3 * 60 * 60_000 + 60_000) === '3h ago');
    assert('days', formatAge(49 * 60 * 60_000) === '2d ago');
  }

  header('--resume grammar — bare form unchanged, id form strict');
  {
    assert('bare --resume still follows the pointer',
      parseCliArgs(['--resume']).session.kind === 'continue');
    assert('--resume before another flag stays bare — existing usages keep parsing',
      parseCliArgs(['--resume', '--yolo']).session.kind === 'continue' &&
      parseCliArgs(['--resume', '--yolo']).permissionModeOverride === 'yolo');
    const named = parseCliArgs(['--resume', 'session-a']).session;
    assert('--resume <id> selects that session',
      named.kind === 'id' && named.sessionId === 'session-a');
    const headless = parseCliArgs(['-p', 'hi', '--resume', 'session-a']).session;
    assert('--resume <id> works with -p as well', headless.kind === 'id');
    assert('an invalid id alphabet is a usage error',
      usageError(() => parseCliArgs(['--resume', 'Not/An/Id']))?.includes('Invalid session id') === true);
    assert('--resume <id> plus --session is refused — two id sources',
      usageError(() => parseCliArgs(['--resume', 'session-a', '--session', 'session-b']))
        ?.includes('may not both name a session') === true);
    assert('the refusal is order-independent',
      usageError(() => parseCliArgs(['--session', 'session-b', '--resume', 'session-a']))
        ?.includes('may not both name a session') === true);
    assert('--resume <id> twice is refused',
      usageError(() => parseCliArgs(['--resume', 'session-a', '--resume', 'session-b']))
        ?.includes('may be specified only once') === true);
    assert('--session alone is untouched',
      parseCliArgs(['--session', 'session-a']).session.kind === 'id');
  }

  header('resolving a named session — refusal, never fallback');
  {
    const known = await resolveSession(ROOT, { kind: 'id', sessionId: recorded }, AGENT_ID);
    assert('a listed id resolves to that session and requests restore',
      known.sessionId === recorded && known.restoreRequested);

    const bogus = await resolveSession(ROOT, { kind: 'id', sessionId: 'session-nope' }, AGENT_ID)
      .then(() => undefined, (error: unknown) => error);
    assert('a bogus id is a SessionNotFoundError, not a crash and not a fallback',
      bogus instanceof SessionNotFoundError &&
      bogus.message.includes('does not exist in this project'));

    const foreign = 'session-20260819-990000';
    await seedSnapshot(OTHER_ROOT, foreign, new Date(NOW));
    const crossProject = await resolveSession(ROOT, { kind: 'id', sessionId: foreign }, AGENT_ID)
      .then(() => undefined, (error: unknown) => error);
    assert('another project\'s session id is refused here — stores stay per-project',
      crossProject instanceof SessionNotFoundError);
    const otherListing = await runSessions(OTHER_ROOT, NOW);
    assert('and its own project still lists it', otherListing.out.includes(foreign));
    const thisListing = await runSessions(ROOT, NOW);
    assert('while this project\'s listing never shows it', !thisListing.out.includes(foreign));

    const trajectoryOnly = await resolveSession(ROOT, { kind: 'id', sessionId: unresumable }, AGENT_ID)
      .then(() => undefined, (error: unknown) => error);
    assert('a session with a trajectory but no snapshot is refused on resume too',
      trajectoryOnly instanceof SessionNotFoundError);
  }

  report();
}

await main();
