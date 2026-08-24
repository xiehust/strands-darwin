/**
 * Offline checks for the built-in self-reflection trajectory locator.
 *
 * Run: pnpm tsx spike/verify-self-reflection.ts
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { userProjectSessionsDir } from '../src/paths.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('self-reflection-test');

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PROJECT_ROOT = '/tmp/darwin-self-reflection-project';
const LOCATOR = path.join(
  REPO_ROOT,
  'src/skills/builtin/self-reflection/scripts/locate-trajectory.mjs',
);
const SESSIONS_DIR = userProjectSessionsDir(PROJECT_ROOT);

interface LocatorResult {
  code: number | null;
  out: string;
  err: string;
}

function line(seq: number, turn: number, type: string, rest: object = {}): string {
  return JSON.stringify({
    v: 1,
    seq,
    t: `2026-08-24T00:00:${String(seq).padStart(2, '0')}.000Z`,
    turn,
    type,
    ...rest,
  });
}

async function session(id: string, lines: readonly string[], mtimeMs: number): Promise<string> {
  const directory = path.join(SESSIONS_DIR, id);
  await mkdir(directory, { recursive: true });
  const trajectory = path.join(directory, 'trajectory.jsonl');
  await writeFile(trajectory, `${lines.join('\n')}\n`, 'utf8');
  const when = new Date(mtimeMs);
  await utimes(trajectory, when, when);
  return trajectory;
}

function locate(sessionId?: string): LocatorResult {
  const args = [LOCATOR, '--project', PROJECT_ROOT];
  if (sessionId !== undefined) args.push('--session', sessionId);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  return { code: result.status, out: result.stdout, err: result.stderr };
}

async function stateDigest(): Promise<string> {
  const hash = createHash('sha256');
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      hash.update(`${entry.isDirectory() ? 'd' : 'f'}:${path.relative(SESSIONS_DIR, file)}\n`);
      if (entry.isDirectory()) await visit(file);
      else hash.update(await readFile(file));
    }
  }
  await visit(SESSIONS_DIR);
  return hash.digest('hex');
}

async function main(): Promise<void> {
  header('self-reflection locator — closed subject cutoff');

  const base = Date.parse('2026-08-24T00:00:00.000Z');
  const past = await session(
    'session-past',
    [
      line(0, 0, 'runStarted'),
      line(1, 1, 'userInput', { text: 'past request one' }),
      line(2, 1, 'turnEnded', { stopReason: 'endTurn' }),
      line(3, 2, 'userInput', { text: 'past request two' }),
      line(6, 2, 'turnEnded', { stopReason: 'endTurn' }),
      line(7, 3, 'userInput', { text: 'past open tail' }),
    ],
    base + 1_000,
  );
  const current = await session(
    'session-current',
    [
      line(0, 0, 'runStarted'),
      line(1, 1, 'userInput', { text: 'completed request' }),
      line(4, 1, 'turnEnded', { stopReason: 'endTurn' }),
      line(5, 2, 'userInput', { text: 'reflect on this session now' }),
    ],
    base + 2_000,
  );

  const selected = locate();
  assert('default selection succeeds', selected.code === 0);
  assert(
    'default selection identifies the current open-tail record',
    selected.out.includes('session: session-current') &&
      selected.out.includes('selected-by: newest trajectory mtime') &&
      selected.out.includes('last-user-input: reflect on this session now'),
  );
  assert(
    'the open userInput is excluded by an explicit latest-closed cutoff',
    selected.out.includes('closed-through-turn: 1') &&
      selected.out.includes('closed-through-seq: 4') &&
      !selected.out.includes('closed-through-turn: 2'),
  );

  const named = locate('session-past');
  assert('explicit past selection succeeds', named.code === 0);
  assert(
    'explicit selection remains authoritative and returns its own closed cutoff',
    named.out.includes('session: session-past') &&
      named.out.includes('selected-by: explicit --session') &&
      named.out.includes('last-user-input: past open tail') &&
      named.out.includes('closed-through-turn: 2') &&
      named.out.includes('closed-through-seq: 6'),
  );
  assert(
    'selected trajectory paths are exact',
    selected.out.includes(`trajectory: ${current}`) && named.out.includes(`trajectory: ${past}`),
  );

  const missing = locate('session-missing');
  assert(
    'a missing explicit id refuses without falling back',
    missing.code !== 0 &&
      missing.err.includes('session "session-missing" has no trajectory') &&
      missing.out === '',
  );

  await session(
    'session-open-only',
    [line(0, 0, 'runStarted'), line(1, 1, 'userInput', { text: 'unfinished request' })],
    base + 3_000,
  );
  const noClosedDefault = locate();
  assert(
    'the newest selected record with no closed turn refuses instead of falling back',
    noClosedDefault.code !== 0 &&
      noClosedDefault.err.includes('session "session-open-only" has no closed turn') &&
      noClosedDefault.out === '',
  );
  const noClosedNamed = locate('session-open-only');
  assert(
    'a named record with no closed turn also refuses without a subject block',
    noClosedNamed.code !== 0 &&
      noClosedNamed.err.includes('session "session-open-only" has no closed turn') &&
      noClosedNamed.out === '',
  );

  const before = await stateDigest();
  locate('session-past');
  locate('session-open-only');
  locate('session-missing');
  const after = await stateDigest();
  assert('successful and refused locator paths leave all session-state bytes unchanged', after === before);
  // The no-closed fixture was added after `before`; compare stable subject bytes directly too.
  assert(
    'successful and refused reads do not mutate selected trajectories',
    (await readFile(current, 'utf8')).endsWith('"text":"reflect on this session now"}\n') &&
      (await readFile(past, 'utf8')).includes('"seq":6'),
  );
  assert('locator never creates or updates the resume pointer', await stat(path.join(SESSIONS_DIR, 'session')).then(() => false, () => true));
}

await main();
report();
