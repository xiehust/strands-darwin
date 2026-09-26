/** SER-103: real files/processes in an owned HOME; no providers or network.
 * Pins snapshotless cross-project inventory, bounded/unsafe reads, immutable state,
 * local CLI grammar/import boundaries and canonical discovery. Pty coverage is in
 * verify-list-agents-pty.ts. Run: pnpm tsx spike/verify-list-agents.ts
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { leaseFileIn } from '../src/agent/session-lease.js';
import { formatLocalAgents, readLocalAgents, MAX_AGENT_LEASE_BYTES, MAX_AGENT_PROJECT_ENTRIES, MAX_AGENT_ROWS, MAX_AGENT_SESSION_ENTRIES } from '../src/list-agents.js';
import { projectKey, userDarwinDir, userProjectSessionsDir, userSessionsDir } from '../src/paths.js';
import { BUILTIN_COMMAND_NAMES, loadCustomCommands } from '../src/commands/custom-commands.js';
import { computeCompletions } from '../src/tui/prompt-completion.js';
import { formatHelpReport } from '../src/tui/help-format.js';
import { ownPrivateHome } from './shared.js';

const HOME = ownPrivateHome('list-agents');
const REPO = path.resolve(import.meta.dirname, '..');
const startedAt = '2026-09-26T05:11:10.000Z';
const live = { pid: process.pid, hostname: os.hostname(), startedAt };
const projectA = path.join(HOME, 'project-a');
const projectB = path.join(HOME, 'project-b');

async function seed(project: string, id: string, value: unknown): Promise<string> {
  const file = leaseFileIn(userProjectSessionsDir(project), id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

/** Content, names, modes, size and mtimes, never atime (ordinary reads may update it). */
async function digest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(file: string): Promise<void> {
    const info = await lstat(file);
    hash.update(`${path.relative(directory, file)}:${info.mode}:${info.mtimeMs}:`);
    if (info.isSymbolicLink()) hash.update(await readlink(file));
    else if (info.isDirectory()) {
      for (const name of (await readdir(file)).sort()) await walk(path.join(file, name));
    } else if (info.isFile()) hash.update(await readFile(file));
  }
  await walk(directory);
  return hash.digest('hex');
}

async function inHome(label: string, work: () => Promise<void>): Promise<void> {
  const home = path.join(HOME, label);
  await mkdir(home);
  process.env['HOME'] = home;
  try { await work(); } finally { process.env['HOME'] = HOME; }
}

function cli(args: string[] = [], home = HOME, probe = '') {
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO, 'spike/fixtures/list-agents-guard.ts'), 'list-agents', ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, HOME: home, LIST_AGENTS_GUARD_PROBE: probe, AWS_EC2_METADATA_DISABLED: 'true', DARWIN_MODEL_PRICES_FETCH: 'off' },
  });
}

function passed(label: string): void { console.log(`PASS ${label}`); }

const peer = spawn(process.execPath, ['-e', 'console.log("ready"); setTimeout(() => {}, 120000)'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise<void>((resolve, reject) => { peer.stdout.once('data', () => resolve()); peer.once('error', reject); });
try {
  const currentFile = await seed(projectA, 'snapshotless-current', live);
  await seed(projectB, 'snapshotless-peer', { ...live, pid: peer.pid });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert(dead && dead !== process.pid);
  await seed(projectA, 'dead', { ...live, pid: dead });
  await seed(projectA, 'foreign', { ...live, hostname: 'another-host' });
  await seed(projectA, 'malformed', '{');
  await seed(projectA, 'bad-date', { ...live, startedAt: 'not-a-date' });
  await seed(projectA, 'oversized', ' '.repeat(MAX_AGENT_LEASE_BYTES + 1));
  const invalidPids = [0, -1, -process.pid, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1, '123', null];
  for (const [index, pid] of invalidPids.entries()) await seed(projectA, `invalid-pid-${index}`, { ...live, pid });
  await seed(projectA, 'terminal-date', { ...live, startedAt: `${startedAt}\u001b[2J` });
  const projectDir = userProjectSessionsDir(projectA);
  await mkdir(path.join(projectDir, 'missing-lease'));
  await mkdir(path.join(projectDir, 'file-link'));
  await symlink(currentFile, path.join(projectDir, 'file-link', 'lease.json'));
  await symlink(path.dirname(currentFile), path.join(projectDir, 'directory-link'));
  await symlink(projectDir, path.join(userSessionsDir(), projectKey(path.join(HOME, 'linked-project'))));
  await mkdir(path.join(projectDir, 'bad\u001b[2Jname'));
  await mkdir(path.join(userSessionsDir(), 'bad\u001b[2Jproject'));
  // The snapshot subtree, pointer, config and prompt-bearing files must not be read.
  await mkdir(path.join(projectDir, 'session'));
  await writeFile(path.join(projectDir, 'session', 'snapshot_latest.json'), 'SECRET_SNAPSHOT');
  await writeFile(path.join(projectDir, 'last-session.json'), 'SECRET_POINTER');
  await writeFile(path.join(path.dirname(currentFile), 'trajectory.jsonl'), 'SECRET_PROMPT');
  await writeFile(path.join(userDarwinDir(), 'config.json'), 'INVALID_CONFIG_MUST_NOT_LOAD');
  const before = await digest(HOME);
  const inventory = await readLocalAgents();
  assert.deepEqual(inventory.rows.map(row => row.sessionId).sort(), ['snapshotless-current', 'snapshotless-peer']);
  assert.equal(inventory.rows.find(row => row.current)?.pid, process.pid);
  assert.equal(inventory.rows.find(row => !row.current)?.pid, peer.pid);
  assert.deepEqual(new Set(inventory.rows.map(row => row.projectKey)), new Set([projectKey(projectA), projectKey(projectB)]));
  assert(inventory.rows.every(row => row.startedAt === startedAt));
  assert.equal(inventory.omissions['dead leases'], 1);
  assert.equal(inventory.omissions['foreign-host leases'], 1);
  assert.equal(inventory.omissions['oversized leases'], 1);
  assert.equal(inventory.omissions['malformed leases (including invalid PIDs)'], invalidPids.length + 3);
  assert.equal(inventory.omissions['unsafe lease files'], 1);
  assert.equal(inventory.omissions['unreadable, missing or unsafe directories'], 2);
  assert.equal(inventory.omissions['invalid session entries'], 1);
  assert.equal(inventory.omissions['invalid project keys'], 1);
  assert.equal(inventory.omissions['missing leases'], 2);
  const text = formatLocalAgents(inventory);
  assert(text.includes('PROJECT KEY (not cwd)') && text.includes('(current process)'));
  assert(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(text));
  assert(!text.includes('SECRET_') && !text.includes('INVALID_CONFIG'));
  for (const phrase of ['this HOME', 'older/non-registering', 'other users/HOMEs/hosts', 'ordinary OS children', 'in-process SDK subagents', 'not authenticated', 'does not enable communication']) assert(text.includes(phrase));
  const result = cli();
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trimEnd(), formatLocalAgents({ ...inventory, rows: inventory.rows.map(row => ({ ...row, current: false })) }));
  assert.equal(await digest(HOME), before, 'listing changes no bytes, names, modes or mtimes, including stale leases');
  passed('cross-project snapshotless processes, fields, exclusions, scope and CLI shared projection; state hashes unchanged');

  const hostile = formatLocalAgents({ ...inventory, rows: [{ ...inventory.rows[0]!, sessionId: '\u001b]52;c;attack\u0007\n\u202e' + 'x'.repeat(300), projectKey: '\u009b2J', startedAt: '\rINJECT' }] });
  assert(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e]/.test(hostile));
  assert(hostile.includes('...') && !hostile.includes('x'.repeat(256)));
  passed('projection sanitizes terminal controls and bounds every untrusted cell');
} finally {
  const exited = new Promise<void>(resolve => peer.once('exit', () => resolve()));
  peer.kill('SIGTERM');
  await exited;
}

await inHome('named-session', async () => {
  await seed(projectA, 'session', live);
  assert.deepEqual((await readLocalAgents()).rows.map(row => row.sessionId), ['session']);
});
passed('legal explicit session id named session is not mistaken for snapshot-only state');

await inHome('lease-byte-boundary', async () => {
  await seed(projectA, 'exact-cap', JSON.stringify(live).padEnd(MAX_AGENT_LEASE_BYTES, ' '));
  await seed(projectA, 'over-cap', JSON.stringify(live).padEnd(MAX_AGENT_LEASE_BYTES + 1, ' '));
  const inventory = await readLocalAgents();
  assert.deepEqual(inventory.rows.map(row => row.sessionId), ['exact-cap']);
  assert.equal(inventory.omissions['oversized leases'], 1);
});
passed('exact lease byte cap accepted; one extra byte rejected');

await inHome('row-cap', async () => {
  for (let index = 0; index < MAX_AGENT_ROWS + 2; index++) await seed(projectA, `live-${index}`, live);
  const before = await digest(os.homedir());
  const inventory = await readLocalAgents();
  assert.equal(inventory.rows.length, MAX_AGENT_ROWS);
  assert.equal(inventory.omissions[`live holders beyond row limit ${MAX_AGENT_ROWS}`], 2);
  assert.equal(formatLocalAgents(inventory).split('\n').filter(line => line.includes(' | ')).length, MAX_AGENT_ROWS + 1);
  assert.equal(await digest(os.homedir()), before);
});
await inHome('session-cap', async () => {
  for (const project of [projectA, projectB]) {
    const directory = userProjectSessionsDir(project);
    await mkdir(directory, { recursive: true });
    for (let index = 0; index < MAX_AGENT_SESSION_ENTRIES / 2 + 1; index++) await mkdir(path.join(directory, `missing-${index}`));
  }
  const inventory = await readLocalAgents();
  assert.equal(inventory.omissions['missing leases'], MAX_AGENT_SESSION_ENTRIES);
  assert(inventory.limits.some(line => line.includes(`session-entry scan limit ${MAX_AGENT_SESSION_ENTRIES}`)));
  assert(inventory.limits.some(line => line.includes('remaining projects not inspected (count unknown)')));
});
await inHome('project-cap', async () => {
  await mkdir(userSessionsDir(), { recursive: true });
  for (let index = 0; index < MAX_AGENT_PROJECT_ENTRIES + 1; index++) await mkdir(path.join(userSessionsDir(), `invalid-${index}`));
  const inventory = await readLocalAgents();
  assert.equal(inventory.omissions['invalid project keys'], MAX_AGENT_PROJECT_ENTRIES);
  assert(inventory.limits.some(line => line.includes(`project-entry scan limit ${MAX_AGENT_PROJECT_ENTRIES}`)));
});
passed('row limit counts omitted live holders; total scan limits stop with explicit unknown remainder');

await inHome('read-failures', async () => {
  const file = await seed(projectA, 'unreadable', live);
  assert.notEqual(process.getuid?.(), 0, 'permission fixtures must run as an ordinary user');
  await chmod(file, 0);
  try {
    const inventory = await readLocalAgents();
    assert.equal(inventory.rows.length, 0);
    assert.equal(inventory.omissions['unreadable or unsafe lease files'], 1);
  } finally { await chmod(file, 0o600); }
  const directory = userProjectSessionsDir(projectA);
  await chmod(directory, 0);
  try {
    assert.equal((await readLocalAgents()).omissions['unreadable, missing or unsafe directories'], 1);
  } finally { await chmod(directory, 0o700); }
  await chmod(userSessionsDir(), 0);
  try {
    const result = cli([], os.homedir());
    assert.equal(result.status, 0, result.stderr);
    assert(result.stdout.includes('inventory unavailable'));
  } finally { await chmod(userSessionsDir(), 0o700); }
  // A directory or FIFO in place of the lease cannot hang the reader.
  await rm(file);
  await mkdir(file);
  assert.equal((await readLocalAgents()).omissions['unsafe lease files'], 1);
  await rm(file, { recursive: true });
  assert.equal(spawnSync('mkfifo', [file]).status, 0);
  assert.equal((await readLocalAgents()).omissions['unsafe lease files'], 1);
});
await inHome('root-symlink', async () => {
  await symlink(path.join(HOME, '.darwin'), userDarwinDir());
  assert.equal((await readLocalAgents()).state, 'unavailable');
});
await inHome('sessions-symlink', async () => {
  await mkdir(userDarwinDir());
  await symlink(path.join(HOME, '.darwin', 'sessions'), userSessionsDir());
  assert.equal((await readLocalAgents()).state, 'unavailable');
});
passed('real EACCES, nonregular lease files, and root/session symlinks degrade honestly without following or hanging');

await inHome('empty-cli', async () => {
  const before = await digest(os.homedir());
  const missing = cli([], os.homedir());
  assert.equal(missing.status, 0, missing.stderr);
  assert(missing.stdout.includes('inventory missing'));
  assert.equal(await digest(os.homedir()), before, 'empty CLI creates no config or state');
  await mkdir(userSessionsDir(), { recursive: true });
  const empty = cli([], os.homedir());
  assert.equal(empty.status, 0, empty.stderr);
  assert(empty.stdout.includes('no live same-host session lease holders found'));
  for (const probe of ['read', 'network', 'signal', 'config']) {
    const forbidden = cli([], os.homedir(), probe);
    assert.equal(forbidden.status, 90, `tripwire ${probe}: ${forbidden.stderr}`);
  }
  for (const args of [['extra'], ['--help'], ['--cancel', '1'], ['--json']]) {
    const result = cli(args, os.homedir());
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert(result.stderr.includes('list-agents takes no arguments'));
  }
});
assert.deepEqual(computeCompletions('/list-a', BUILTIN_COMMAND_NAMES), ['list-agents']);
assert(formatHelpReport().includes('/list-agents — list local session lease holders (no messaging)'));
const commandDir = path.join(projectA, '.darwin', 'commands');
await mkdir(commandDir, { recursive: true });
await writeFile(path.join(commandDir, 'list-agents.md'), 'must not shadow the built-in');
const custom = await loadCustomCommands(projectA, []);
assert(!custom.commands.some(command => command.name === 'list-agents'));
assert(custom.problems.some(problem => problem.reason.includes('built-in command /list-agents')));
passed('real CLI empty/misuse cases without config, runtime, SDK, HOME content reads or network; reserved completion/help discovery');
