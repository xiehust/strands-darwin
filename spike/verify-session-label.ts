/** SER-116 real owned-HOME acceptance, no provider transport or mock filesystem.
 * R1 literal/trim/Unicode cap/invalid zero-write -> validation and tree hashes.
 * R2 owner-state safety, atomic bounded record, tolerant no-repair reads -> real files/links/FIFO.
 * R3 resume and clear/rewind isolation -> real runtime + SDK snapshots/checkpoints.
 * R4 snapshot/trajectory/pointer/lease invariance -> hash maps before/after rename.
 * R5 display-only duplicates/ID-only resume and CLI read-only closure -> listing/grammar/import walk.
 * R6 help/completion -> canonical inventory and registered pty suite.
 * Run: pnpm tsx spike/verify-session-label.ts
 */
import { strict as check } from 'node:assert';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { sessionPaths, sessionStateDir, SessionNotFoundError } from '../src/agent/session.js';
import { readSessionLabel, sessionLabelPath, MAX_SESSION_LABEL_BYTES, RENAME_USAGE } from '../src/agent/session-label.js';
import { writeSessionLabel } from '../src/agent/session-label-write.js';
import { runSessionsCommand } from '../src/cli-sessions.js';
import { configPath } from '../src/config.js';
import { BUILTIN_COMMAND_NAMES } from '../src/commands/custom-commands.js';
import { formatHelpReport, MAX_HELP_COMMANDS } from '../src/tui/help-format.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Private HOME protects ordinary umask-created state; don't hide that production layout.
process.umask(0o002);
ownPrivateHome('session-label');
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-label-project-'));
await mkdir(path.dirname(configPath()), { recursive: true });
await writeFile(configPath(), JSON.stringify({ memory: false,
  models: [{ enable: true, provider: 'bedrock', model: 'fake.label', region: 'us-west-2' }],
}));
const model = new CaptureModel('offline label answer');
setRuntimeModelFactoryForTest(async () => model);
const create = (session: { kind: 'new' } | { kind: 'id'; sessionId: string }) =>
  AgentRuntime.create({ projectRoot: root, session, permissionBridge: allowAllBridge });
async function turn(runtime: AgentRuntime, text: string): Promise<void> {
  for await (const _event of runtime.send(text)) { /* real SDK invocation */ }
  await runtime.markResumable(); // The ordinary driver's completed-turn step.
}
async function hashes(directory = sessionPaths(root).sessionsDir, omitLabel = false): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && !(omitLabel && entry.name === 'label.json')) {
        found[path.relative(directory, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
      }
    }
  }
  await walk(directory);
  return found;
}
async function listing(now: number): Promise<string> {
  let text = '';
  check.equal(await runSessionsCommand({ projectRoot: root, out: (part) => { text += part; }, err: () => { throw new Error('unexpected stderr'); } }, now), 0);
  return text;
}


header('SER-116 — literal bounds, owner-state only');
let runtime = await create({ kind: 'new' });
const id = runtime.info.sessionId;
const file = sessionLabelPath(root, id);
check.equal(path.dirname(file), sessionStateDir(root, id));
check.equal(runtime.sessionLabel, undefined);
await turn(runtime, 'first prompt stays visible');
const core = await hashes(undefined, true);
check.ok(Object.keys(core).some((key) => key.endsWith('lease.json')));
check.ok(Object.keys(core).some((key) => key.endsWith('snapshot_latest.json')));
check.ok(Object.keys(core).some((key) => key.endsWith('trajectory.jsonl')));
check.ok(Object.keys(core).includes('last-session.json'));
const now = Date.now();
const plain = await listing(now);
const literal = '中😀 e\u0301  $HOME /tmp/* "quoted" <label>';
check.equal(await runtime.renameSession(`  ${literal}  `), `Session label set: ${JSON.stringify(literal)}`);
check.equal(runtime.sessionLabel, literal);
check.equal(await readSessionLabel(root, id), literal);
check.equal((await stat(file)).mode & 0o777, 0o600);
check.ok((await stat(file)).size <= MAX_SESSION_LABEL_BYTES);
check.deepEqual(await hashes(undefined, true), core);
check.equal((await listing(now)).replace(/  label: .*\n/g, '\n'), plain);
// Atomic publications are whole records, and overlapping user submissions keep
// disk and accessor ordered without ever entering the model queue.
const overlap = await Promise.all([runtime.renameSession('first label'), runtime.renameSession('👩‍👩‍👧‍👦 last label')]);
check.ok(overlap.every((notice) => notice.startsWith('Session label set:')));
check.equal(runtime.sessionLabel, '👩‍👩‍👧‍👦 last label');
check.equal(await readSessionLabel(root, id), runtime.sessionLabel);
let publishing = true;
const observe = (async () => {
  while (publishing) {
    const value = JSON.parse(await readFile(file, 'utf8')) as { version: number; label: string };
    check.equal(value.version, 1);
    check.ok(['👩‍👩‍👧‍👦 last label', 'atomic one', 'atomic two'].includes(value.label));
  }
})();
try {
  for (const label of ['atomic one', 'atomic two', 'atomic one']) await runtime.renameSession(label);
} finally { publishing = false; await observe; }
check.ok(!(await readdir(path.dirname(file))).some((name) => name.endsWith('.tmp')));
const max = '😀'.repeat(80);
await runtime.renameSession(max);
check.equal(await readSessionLabel(root, id), max);
for (const bad of ['', '   ', '😀'.repeat(81), 'x'.repeat(81), 'x\ny', 'x\ry', '\nedge',
  'edge\t', 'x\u0000y', 'x\u001by', 'x\u007fy', 'x\u009by', 'x\u2028y', 'x\u2029y', 'x\u202ey', '\ud800']) {
  const before = await hashes();
  check.ok(!(await runtime.renameSession(bad)).startsWith('Session label set:'));
  check.equal(runtime.sessionLabel, max);
  check.deepEqual(await hashes(), before);
}
check.equal(await runtime.renameSession(''), RENAME_USAGE);
check.deepEqual(await hashes(undefined, true), core);
check.equal(model.calls.length, 1);
assert('R1/R4 literal preservation, exact 80-point Unicode boundary, rejected controls/overflow zero-write, core hashes and no invocation', true);


header('SER-116 — durable resume, unnamed successors, duplicate labels');
const savingOnExit = runtime.renameSession(literal);
await runtime.shutdown();
check.ok((await savingOnExit).startsWith('Session label set:'));
const labelBytes = await readFile(file);
check.ok(!(await runtime.renameSession('retired rename')).startsWith('Session label set:'));
check.deepEqual(await readFile(file), labelBytes);
runtime = await create({ kind: 'id', sessionId: id });
check.equal(runtime.sessionLabel, literal);
check.ok(runtime.info.resumed);
check.deepEqual(await readFile(file), labelBytes);
const beforeClear = await hashes();
let successor = await runtime.startNewSession();
check.equal(successor.sessionLabel, undefined);
check.equal(await readSessionLabel(root, successor.info.sessionId), undefined);
check.deepEqual(await readFile(file), labelBytes);
// Clear changes leases, not predecessor snapshot/trajectory/pointer/label.
const afterClear = await hashes();
for (const [key, digest] of Object.entries(beforeClear)) {
  if (!key.endsWith('lease.json')) check.equal(afterClear[key], digest, key);
}
await successor.shutdown();
runtime = await create({ kind: 'id', sessionId: id });
const { readRewindCatalogue } = await import('../src/agent/rewind.js');
const checkpoint = (await readRewindCatalogue(root, id)).checkpoints[0];
check.ok(checkpoint);
const beforeRewind = await hashes();
successor = await runtime.startRewind(checkpoint);
check.equal(successor.sessionLabel, undefined);
check.equal(await readSessionLabel(root, successor.info.sessionId), undefined);
const afterRewind = await hashes();
for (const [key, digest] of Object.entries(beforeRewind)) {
  if (!key.endsWith('lease.json')) check.equal(afterRewind[key], digest, key);
}
await turn(successor, 'second prompt stays visible');
await successor.renameSession(literal);
const beforeList = await hashes();
const named = await listing(now + 60_000);
check.ok(named.includes(id));
check.ok(named.includes(successor.info.sessionId));
check.equal(named.split(`label: ${JSON.stringify(literal)}`).length - 1, 2);
check.ok(named.includes('first prompt stays visible'));
check.ok(named.includes('second prompt stays visible'));
check.ok(named.includes('(last)'));
check.ok(named.includes(`(open in pid ${process.pid})`));
check.ok(named.indexOf(successor.info.sessionId) < named.indexOf(id));
check.deepEqual(await hashes(), beforeList);
await successor.renameSession('display-only-label');
const idOnly = await hashes();
await check.rejects(create({ kind: 'id', sessionId: 'display-only-label' }), SessionNotFoundError);
check.deepEqual(await hashes(), idOnly);
check.ok(!model.calls.some((call) => call.tools.some((name) => /rename|label/.test(name))));
await successor.shutdown();
assert('R3/R5 same-ID restore, clear/rewind unnamed, predecessor preserved, duplicate display labels, CLI retains prompts/IDs/order/pointer/live lease and remains read-only', true);


header('SER-116 — tolerant reads and refusal without repair');
for (const body of ['{broken', '{}', 'null', JSON.stringify({ version: 2, label: 'valid' }),
  JSON.stringify({ version: 1, label: ' padded ' }), JSON.stringify({ version: 1, label: 'bad\nline' }),
  JSON.stringify({ version: 1, label: 'x'.repeat(81) }), JSON.stringify({ version: 1, label: 'ok', extra: true }),
  'x'.repeat(MAX_SESSION_LABEL_BYTES + 1)]) {
  await writeFile(file, body);
  const before = await hashes();
  check.equal(await readSessionLabel(root, id), undefined);
  await listing(now);
  check.deepEqual(await hashes(), before);
}
await writeFile(file, Buffer.concat([Buffer.from('{"version":1,"label":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
const corrupt = await hashes();
check.equal(await readSessionLabel(root, id), undefined);
check.deepEqual(await hashes(), corrupt);
await rm(file);
const absent = await hashes();
check.equal(await readSessionLabel(root, id), undefined);
check.deepEqual(await hashes(), absent);

const target = path.join(root, 'target');
await writeFile(target, 'sentinel');
async function refused(): Promise<void> {
  const before = await lstat(file);
  await check.rejects(writeSessionLabel(root, id, 'never saved'));
  check.equal(await readSessionLabel(root, id), undefined);
  const after = await lstat(file);
  check.equal(after.ino, before.ino);
  check.equal(after.mode, before.mode);
  check.equal(await readFile(target, 'utf8'), 'sentinel');
  check.ok(!(await readdir(path.dirname(file))).some((name) => name.endsWith('.tmp')));
}
await symlink(target, file); await refused(); await rm(file);
await link(target, file); await refused(); await rm(file);
await mkdir(file); await refused(); await rm(file, { recursive: true });
check.equal(spawnSync('mkfifo', [file]).status, 0);
await refused(); await rm(file);
await writeFile(file, 'sentinel'); await chmod(file, 0o666); await refused(); await rm(file);
await writeFile(file, 'x'.repeat(MAX_SESSION_LABEL_BYTES + 1)); await refused(); await rm(file);

const dir = sessionStateDir(root, id);
const saved = `${dir}-saved`;
await rename(dir, saved);
await symlink(saved, dir);
await check.rejects(writeSessionLabel(root, id, 'redirected directory'));
check.equal(await readSessionLabel(root, id), undefined);
check.ok(!(await readdir(saved)).includes('label.json'));
await rm(dir); await rename(saved, dir);
const ancestors = [os.homedir()];
for (let parent = path.dirname(dir); parent !== os.homedir(); parent = path.dirname(parent)) ancestors.push(parent);
for (const parent of ancestors) await chmod(parent, 0o755);
await chmod(dir, 0o777);
await check.rejects(writeSessionLabel(root, id, 'externally writable directory'));
check.equal(await readSessionLabel(root, id), undefined);
for (const parent of ancestors) await chmod(parent, 0o700);
await chmod(dir, 0o700);
// An ancestor link below HOME is refused, while a machine-level HOME link works.
const store = sessionPaths(root).sessionsDir;
const storeSaved = `${store}-saved`;
await rename(store, storeSaved); await symlink(storeSaved, store);
await check.rejects(writeSessionLabel(root, id, 'ancestor link'));
check.equal(await readSessionLabel(root, id), undefined);
await rm(store); await rename(storeSaved, store);
const home = os.homedir();
const homeLink = path.join(root, 'home-link');
await symlink(home, homeLink);
process.env['HOME'] = homeLink;
check.equal(await writeSessionLabel(root, id, 'home alias'), 'home alias');
check.equal(await readSessionLabel(root, id), 'home alias');
process.env['HOME'] = home;
assert('R2 absent/malformed reads are byte-zero; metadata/ancestor links, hard links, FIFO, directory, unsafe modes and oversize state refused; HOME alias accepted', true);

header('SER-116 — read-only metadata import closure and discoverability');
const seen = new Set<string>();
async function readerClosure(sourceFile: string): Promise<void> {
  if (seen.has(sourceFile)) return;
  seen.add(sourceFile);
  const source = await readFile(sourceFile, 'utf8');
  check.ok(!/@strands-agents|session-label-write|writeFile|appendFile|\brename\(|\bunlink\(|\bmkdir\(|\brm\(/.test(source), sourceFile);
  for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) {
    const specifier = match[1]!;
    if (specifier.startsWith('.')) await readerClosure(path.resolve(path.dirname(sourceFile), specifier.replace(/\.js$/, '.ts')));
  }
}
await readerClosure(path.join(import.meta.dirname, '../src/agent/session-label.ts'));
check.ok(BUILTIN_COMMAND_NAMES.includes('rename'));
check.ok(MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length);
check.ok(MAX_HELP_COMMANDS >= BUILTIN_COMMAND_NAMES.length);
check.match(formatHelpReport(), /\/rename.*\/rename <label>/);
assert('R5/R6 label read closure acquires no writer/SDK and canonical help/completion expose rename', true);
await rm(root, { recursive: true, force: true });
report();
