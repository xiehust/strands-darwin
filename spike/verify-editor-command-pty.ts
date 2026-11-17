/** SER-133 real production CLI/local-model/editor PTY acceptance (no provider/network).
 * C1 parser/reservation/help/completion: verify-editor-command.ts + verify-tui completion.
 * C2 blank seed, exact Unicode/multiline editable bytes, zero calls/durable input until Enter.
 * C3 unchanged/failure/UTF-8/caps/args/config preserve exact draft/cursor/image.
 * C4 image retained through later send; stash/image never enter file, stash recoverable.
 * C5 busy/queue/search/permission/compaction/session/delegation ownership, no delayed editor.
 * C6 model/expansion/wake cannot launch; authenticated peer: verify-collaboration-drivers.ts.
 * C7 text/json/stream-json before factory construction; dev-REPL before send.
 * C8 private modes/env/cleanup/shutdown; inherited handoff: external-editor P1-P13 and PTY T1-T9/R1-R8.
 * C9 unchanged /reply and chords: verify-reply-command[-pty], verify-external-editor[-pty].
 * Run: pnpm tsx spike/verify-editor-command-pty.ts
 */
import { strict as check } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EDITOR_TEMP_PREFIX } from '../src/tui/external-editor.js';
import { EDITOR_UNSUPPORTED } from '../src/commands/editor-command.js';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-editor-command-pty-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project'), tmp = path.join(root, 'tmp');
const bin = path.join(root, 'bin'), ledger = path.join(root, 'editors'), mode = path.join(root, 'mode');
for (const dir of [home, cwd, tmp, bin]) await mkdir(dir, { mode: 0o700 });
await mkdir(path.join(home, '.darwin'));
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ promptSuggestions: false, sessionRecap: false, updateCheck: false }));
await mkdir(path.join(home, '.darwin/commands'));
await writeFile(path.join(home, '.darwin/commands/blank-expansion.md'), '/editor');
const edited = '第一问 🧪\n\ne\u0301 русский\n\t  code > # literal';
const editor = path.join(bin, 'fixture editor');
await writeFile(editor, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const file = process.argv.at(-1), mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ file, content: fs.readFileSync(file, 'utf8'),
  dirMode: fs.statSync(path.dirname(file)).mode & 511, fileMode: fs.statSync(file).mode & 511,
  secret: process.env.AWS_SECRET_ACCESS_KEY ?? null, darwin: process.env.DARWIN, pid: process.pid }) + '\\n');
process.stdout.write('BLANK-EDITOR-READY\\n');
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => {
  if (!chunk.toString().includes('\\r')) return;
  process.stdin.setRawMode(false);
  if (mode === 'fail') process.exit(7);
  if (mode === 'invalid') fs.writeFileSync(file, Buffer.from([255]));
  if (mode === 'oversize') fs.writeFileSync(file, 'a'.repeat(65537));
  if (mode === 'bytes') fs.writeFileSync(file, '🧪'.repeat(65537));
  if (mode === 'changed') fs.writeFileSync(file, ${JSON.stringify(edited)});
  process.exit(0);
});
`);
await chmod(editor, 0o755);
await writeFile(mode, 'changed');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==', 'base64');
await writeFile(path.join(root, 'clipboard.png'), png);
await writeFile(path.join(bin, 'wl-paste'), `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(path.join(root, 'clipboard.png'))}));\n`);
await chmod(path.join(bin, 'wl-paste'), 0o755);
const env = { HOME: home, TMPDIR: tmp, VISUAL: `'${editor}' --wait`, EDITOR: '',
  PATH: `${bin}:${process.env['PATH'] ?? ''}`, WAYLAND_DISPLAY: 'editor-command-fixture', AWS_SECRET_ACCESS_KEY: 'withheld',
  DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' };
const entry = path.join(REPO_ROOT, 'spike/fixtures/external-editor-cli.ts');
const sessions: TuiSession[] = [];
function launch(extra: Record<string, string> = {}): TuiSession {
  const session = startTui({ cwd, cols: 90, rows: 24, entry, env: { ...env, ...extra } });
  sessions.push(session); return session;
}
let tui = launch();
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
const draft = () => [...tui.frame.matchAll(/you> ?([^\r\n]*)/g)].at(-1)?.[1]?.trimEnd();
const ready = async () => tui.waitUntil(() => draft() !== undefined && !tui.frame.includes('working…'), { timeoutMs: 30_000, settleMs: 150 });
const calls = async () => (await readFile(path.join(cwd, 'editor-model-calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { text: string; images: number });
const factories = async () => readFile(path.join(cwd, 'editor-model-factories.jsonl'), 'utf8').catch(() => '');
const editors = async () => (await readFile(ledger, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { file: string; content: string; dirMode: number; fileMode: number; darwin: string; secret: null; pid: number });
async function durable(dir = home): Promise<string> {
  let text = '';
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) text += await durable(file);
    else if (item.isFile()) text += await readFile(file, 'utf8');
  }
  return text;
}
async function clearDraft(): Promise<void> {
  tui.send('\u001b[1;5F'); await delay(40);
  for (let row = 0; row < 10; row += 1) {
    tui.send('\u0015'); await delay(20);
    tui.send('\u007f'); await delay(20);
  }
  await tui.waitUntil(() => draft() === '', { timeoutMs: 10_000, settleMs: 100 });
}
async function command(text: string, left = 0): Promise<number> {
  const mark = tui.mark(); tui.send(paste(text));
  await tui.waitUntil(() => draft() === text.trimEnd(), { timeoutMs: 10_000, settleMs: 100 });
  tui.send('\u001b'); await delay(80);
  for (let index = 0; index < left; index += 1) { tui.send('\u001b[D'); await delay(40); }
  if (left > 0) { tui.send('\u001b'); await delay(80); }
  tui.send('\r'); return mark;
}
async function ask(text: string, answer = 'local answer'): Promise<void> {
  const mark = await command(text); await tui.waitFor(answer, { from: mark, timeoutMs: 30_000 }); await ready();
}
async function openBlank(text = '/editor', left = 0): Promise<number> {
  const mark = await command(text, left);
  await tui.waitFor('BLANK-EDITOR-READY', { from: mark, timeoutMs: 30_000 }); await delay(100);
  check.equal((await editors()).at(-1)?.content, '', 'only a blank seed, never command/answer/stash/image');
  return tui.mark();
}
async function closeEditor(mark: number, notice: string): Promise<void> {
  tui.send('\r'); await tui.waitFor(notice, { from: mark, timeoutMs: 30_000, settleMs: 150 }); await ready();
  for (const record of await editors()) check.ok(!existsSync(path.dirname(record.file)), 'private storage removed');
}
async function refuse(text: string, notice: string, left = 0): Promise<void> {
  const before = await calls(), count = (await editors()).length, disk = await durable();
  const mark = await command(text, left);
  await tui.waitFor(notice, { from: mark, timeoutMs: 30_000, settleMs: 150 });
  check.equal(draft(), text.trimEnd(), 'local refusal retains exact command draft');
  check.equal((await editors()).length, count); check.deepEqual(await calls(), before); check.equal(await durable(), disk);
  if (left > 0) {
    tui.send('!');
    const index = text.length - left;
    await tui.waitUntil(() => draft() === `${text.slice(0, index)}!${text.slice(index)}`, { timeoutMs: 10_000 });
    check.ok(tui.frame.includes('Ctrl+O remove'), 'image preserved with cursor');
  }
  await clearDraft();
}
let passed = false;
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 200 });
  tui.send(paste('STASH-PRIVATE'));
  await tui.waitUntil(() => draft() === 'STASH-PRIVATE', { timeoutMs: 10_000 });
  tui.send('\u0013');
  await tui.waitUntil(() => draft() === '' && tui.frame.includes('stash: Ctrl+S'), { timeoutMs: 10_000 });
  tui.send('\u000f'); await tui.waitUntil(() => tui.frame.includes('Ctrl+O remove'), { timeoutMs: 10_000 });
  const disk = await durable();
  const mark = await openBlank(); // No previous answer is needed.
  const first = (await editors()).at(-1)!;
  check.equal(first.dirMode, 0o700); check.equal(first.fileMode, 0o600);
  check.equal(first.secret, null); check.equal(first.darwin, '1'); check.ok(first.file.startsWith(tmp + path.sep));
  tui.send('/editor'); await delay(100); // Editor input is not another invocation.
  await closeEditor(mark, 'not sent; Enter sends it');
  check.equal((await editors()).length, 1);
  check.deepEqual(await calls(), [], 'zero model requests before later Enter');
  check.equal(await durable(), disk, 'zero durable userInput or draft bytes');
  check.ok(tui.frame.includes('Ctrl+O remove') && tui.frame.includes('stash: Ctrl+S'));
  check.ok(tui.frame.split('\n').length <= 24, 'no additional frame surface');
  // Measure exact composer bytes through the existing keyboard seeds, not the frame.
  tui.send('Z'); await delay(100); tui.send('\u007f'); await delay(100);
  await writeFile(mode, 'unchanged');
  for (const chord of ['\u0007', '\u0018\u0005']) {
    const keyboardMark = tui.mark(); tui.send(chord);
    await tui.waitFor('BLANK-EDITOR-READY', { from: keyboardMark, timeoutMs: 30_000 }); await delay(100);
    check.equal((await editors()).at(-1)?.content, edited, 'exact edited composer bytes, no context injection');
    await closeEditor(tui.mark(), 'closed without changes');
  }
  check.deepEqual(await calls(), []); check.equal(await durable(), disk);
  const sent = tui.mark(); tui.send('\r');
  await tui.waitFor('local answer', { from: sent, timeoutMs: 30_000 }); await ready();
  check.deepEqual(await calls(), [{ text: edited, afterTool: false, images: 1 }], 'separate Enter sends exact text and retained image once');
  check.ok((await durable()).includes(JSON.stringify(edited).slice(1, -1)));
  tui.send('\u0013'); await tui.waitUntil(() => draft() === 'STASH-PRIVATE', { timeoutMs: 10_000 }); await clearDraft();
  // With completed answer context present the seed is still blank.
  const answerDisk = await durable(), answerCalls = await calls();
  await closeEditor(await openBlank(), 'closed without changes');
  check.deepEqual(await calls(), answerCalls); check.equal(await durable(), answerDisk); await clearDraft();
  console.log('C2/C4/C8 blank/no-answer/context-independent seed, exact editable Unicode round trip, private handoff, retained image and later Enter passed');
  tui.send(paste('SECOND-STASH')); await tui.waitUntil(() => draft() === 'SECOND-STASH', { timeoutMs: 10_000 });
  tui.send('\u0013'); await tui.waitUntil(() => draft() === '' && tui.frame.includes('stash: Ctrl+S'), { timeoutMs: 10_000 });
  tui.send('\u000f'); await tui.waitUntil(() => tui.frame.includes('Ctrl+O remove'), { timeoutMs: 10_000 });
  for (const [result, notice] of [
    ['unchanged', 'closed without changes'], ['fail', 'exited with code 7'],
    ['invalid', 'not valid UTF-8'], ['oversize', 'result exceeds'], ['bytes', 'result exceeds'],
  ]) {
    await writeFile(mode, result!);
    const before = await calls(), beforeDisk = await durable();
    await closeEditor(await openBlank('/editor', 2), notice!);
    check.equal(draft(), '/editor');
    check.ok(tui.frame.includes('Ctrl+O remove') && tui.frame.includes('stash: Ctrl+S'));
    tui.send('!'); await tui.waitUntil(() => draft() === '/edit!or', { timeoutMs: 10_000 });
    check.deepEqual(await calls(), before); check.equal(await durable(), beforeDisk); await clearDraft();
  }
  await refuse('/editor argument', '/editor takes no arguments', 2);
  check.ok(tui.frame.includes('stash: Ctrl+S'));
  await writeFile(mode, 'changed');
  const privacyCalls = await calls(), privacyDisk = await durable();
  await closeEditor(await openBlank(), 'not sent; Enter sends it');
  check.ok(tui.frame.includes('Ctrl+O remove') && tui.frame.includes('stash: Ctrl+S'));
  check.deepEqual(await calls(), privacyCalls); check.equal(await durable(), privacyDisk);
  tui.send('\u000f'); await tui.waitUntil(() => !tui.frame.includes('Ctrl+O remove'), { timeoutMs: 10_000 });
  await clearDraft(); tui.send('\u0013'); await tui.waitUntil(() => draft() === 'SECOND-STASH', { timeoutMs: 10_000 }); await clearDraft();
  console.log('C3/C4 unchanged, failures, UTF-8, both caps and arguments preserve exact cursor/image; changed edit leaves stash private/recoverable passed');
  await command('hold');
  await tui.waitUntil(() => tui.frame.includes('working…'), { timeoutMs: 10_000, settleMs: 100 });
  await refuse('/editor', '/editor opens the external editor only while darwin is idle');
  await command('queued correction');
  await tui.waitUntil(() => tui.frame.includes('queued ·'), { timeoutMs: 10_000, settleMs: 100 });
  await refuse('/editor', '/editor opens the external editor only while darwin is idle');
  const releasedTurn = tui.mark(); await writeFile(path.join(cwd, 'hold-release'), '');
  await tui.waitFor('local answer', { from: releasedTurn, timeoutMs: 30_000 }); await ready();
  check.ok(!(await calls()).some(call => call.text === '/editor'), 'refusal never queued a command');
  for (const search of [true, false]) {
    const count = (await editors()).length, models = await calls();
    tui.send(search ? '\u0012' : '\u001b\u001b');
    await tui.waitUntil(() => tui.frame.includes(search ? 'search' : 'rewind'), { timeoutMs: 10_000 });
    tui.send('/editor\r'); await delay(200);
    check.equal((await editors()).length, count); check.deepEqual(await calls(), models);
    tui.send('\u001b'); await ready(); await clearDraft();
  }
  const permissionMark = await command('permission');
  await tui.waitUntil(() => tui.frame.includes('allow?'), { timeoutMs: 10_000 });
  const permissionEditors = (await editors()).length, permissionCalls = await calls();
  tui.send('/editor\r'); await delay(200);
  check.equal((await editors()).length, permissionEditors); check.deepEqual(await calls(), permissionCalls);
  check.ok(tui.frame.includes('allow?'));
  tui.send('n'); await tui.waitFor('tool step done', { from: permissionMark, timeoutMs: 30_000 }); await ready();
  for (let turn = 0; turn < 8; turn += 1) await ask(`compaction context ${turn}`);
  const compactMark = await command('/compact');
  await tui.waitUntil(() => tui.frame.includes('compacting'), { timeoutMs: 10_000 });
  const compactEditors = (await editors()).length, compactCalls = await calls();
  tui.send('/editor\r'); await delay(200);
  check.equal((await editors()).length, compactEditors); check.deepEqual(await calls(), compactCalls);
  await writeFile(path.join(cwd, 'summary-release'), '');
  await tui.waitFor('compacted', { from: compactMark, timeoutMs: 30_000 }); await ready(); await clearDraft();
  await writeFile(path.join(cwd, 'hold-session'), '');
  const clearMark = await command('/clear');
  const sessionDeadline = Date.now() + 10_000;
  while (!existsSync(path.join(cwd, 'session-waiting')) && Date.now() < sessionDeadline) await delay(20);
  check.ok(existsSync(path.join(cwd, 'session-waiting')), 'successor factory is held');
  await refuse('/editor', '/editor waits until queued or automatic work has run');
  await writeFile(path.join(cwd, 'session-release'), '');
  await tui.waitFor('new session', { from: clearMark, timeoutMs: 30_000 }); await ready();
  await rm(path.join(cwd, 'hold-session'));
  const provenanceEditors = (await editors()).length;
  await ask('/editorial'); check.equal((await calls()).at(-1)?.text, '/editorial', 'ordinary parser boundary');
  await ask('/blank-expansion'); check.equal((await calls()).at(-1)?.text, '/editor', 'expansion is literal model input, not human command authority');
  await ask('editor-model-text', '/editor');
  check.equal((await editors()).length, provenanceEditors, 'expansion/model text never launches');
  const childMark = await command('start-delegation');
  await tui.waitFor('tool step done', { from: childMark, timeoutMs: 30_000 }); await ready();
  check.ok((await calls()).some(call => call.text === 'editor-child-hold'), 'real child model is waiting for release');
  await refuse('/editor', '/editor waits until background delegations settle');
  const childWakeMark = tui.mark(); await writeFile(path.join(cwd, 'child-release'), '');
  await tui.waitFor('wake ack', { from: childWakeMark, timeoutMs: 30_000 }); await ready();
  check.equal((await editors()).length, provenanceEditors, 'child report/wake cannot launch');
  const jobMark = await command('start-job /editor');
  await tui.waitUntil(() => tui.frame.includes('allow?'), { timeoutMs: 10_000 }); tui.send('y');
  await tui.waitFor('tool step done', { from: jobMark, timeoutMs: 30_000 }); await ready();
  await writeFile(mode, 'unchanged');
  const wakeEditor = await openBlank();
  const wakeCalls = await calls(); await writeFile(path.join(cwd, 'job-release'), ''); await delay(750);
  check.deepEqual(await calls(), wakeCalls, 'shared drain holds wakes during editor suspension');
  const wakeMark = tui.mark(); await closeEditor(wakeEditor, 'closed without changes');
  await tui.waitFor('wake ack', { from: wakeMark, timeoutMs: 30_000 }); await ready();
  check.equal((await editors()).length, provenanceEditors + 1, 'session wake text never opens an editor');
  check.equal(draft(), '/editor', 'automatic wake preserves command draft'); await clearDraft();
  console.log('C5/C6 busy/queue/modal/permission/compaction/session/delegation fences, expansion/model/child/wake provenance passed');
  await command('/exit'); await tui.exitedWithin(20_000);
  for (const [visual, guidance] of [
    ['', '/editor needs an external editor: set VISUAL or EDITOR'],
    ['vim; true', 'VISUAL not used'],
    [path.join(root, 'missing-editor'), 'could not start missing-editor'],
  ]) {
    tui = launch({ VISUAL: visual! }); await tui.waitFor('you>', { timeoutMs: 60_000 });
    tui.send('\u000f'); await tui.waitUntil(() => tui.frame.includes('Ctrl+O remove'), { timeoutMs: 10_000 });
    await refuse('/editor', guidance!, 2);
    await command('/exit'); await tui.exitedWithin(20_000);
  }
  tui = launch({ VISUAL: '', EDITOR: `'${editor}' --fallback` }); await tui.waitFor('you>', { timeoutMs: 60_000 });
  await closeEditor(await openBlank(), 'closed without changes'); await clearDraft();
  await command('/exit'); await tui.exitedWithin(20_000);
  check.deepEqual((await readdir(tmp)).filter(name => name.startsWith(EDITOR_TEMP_PREFIX)), []);
  const driverCalls = await calls(), driverEditors = (await editors()).length, driverDisk = await durable(), driverFactories = await factories();
  for (const format of ['text', 'json', 'stream-json']) {
    for (const input of ['/editor', '/editor argument']) {
      const result = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [entry, '-p', input, '--output-format', format],
        { cwd, env: { ...process.env, ...env }, input: '', encoding: 'utf8', timeout: 30_000 });
      check.equal(result.status, 2, result.stderr); check.equal(result.stdout, ''); check.ok(result.stderr.includes(EDITOR_UNSUPPORTED));
    }
  }
  check.deepEqual(await calls(), driverCalls); check.equal((await editors()).length, driverEditors);
  check.equal(await factories(), driverFactories, 'headless refuses before model/runtime construction');
  check.equal(await durable(), driverDisk, 'headless refuses before trajectory startup');
  tui = launch({ EDITOR_DRIVER: 'repl' }); await tui.waitFor('you>', { timeoutMs: 60_000 });
  for (const input of ['/editor', '/editor argument']) {
    const mark = tui.mark(); tui.submit(input); await tui.waitFor(EDITOR_UNSUPPORTED, { from: mark, timeoutMs: 30_000 });
  }
  check.deepEqual(await calls(), driverCalls); check.equal((await editors()).length, driverEditors);
  tui.submit('/exit'); await tui.exitedWithin(20_000);
  console.log('C3/C7 unset/invalid/missing editor, EDITOR fallback, all headless formats before construction and dev-REPL before send passed');
  tui = launch(); await tui.waitFor('you>', { timeoutMs: 60_000 });
  await openBlank(); const last = (await editors()).at(-1)!;
  tui.kill('SIGTERM'); await tui.exitedWithin(20_000);
  await tui.waitUntil(() => { try { process.kill(last.pid, 0); return false; } catch { return true; } }, { timeoutMs: 5_000 });
  check.ok(!existsSync(path.dirname(last.file)), 'shutdown reaps editor and private storage');
  check.deepEqual((await readdir(tmp)).filter(name => name.startsWith(EDITOR_TEMP_PREFIX)), []);
  console.log('C8 /editor shutdown uses inherited reaping and cleanup passed');
  passed = true;
} finally {
  for (const session of sessions) session.kill();
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`SER-133 PTY artifacts retained: ${root}`);
}
