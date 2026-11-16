/** SER-132 real CLI/local-model/editor PTY acceptance (fast suite, no provider/network).
 * R1 exact Unicode/multiline seed + resumed transcript -> quoted round trip / resume.
 * R2 literal quotes, unsent/no model or durable userInput until Enter -> round trip.
 * R3 no-answer/args/unchanged/failure/caps/editor config -> local refusals / preservation.
 * R4 image/stash never in temp bytes, retained on edit -> privacy.
 * R5 busy/queue/modal/permission/repeat/session ownership -> owners; direct authenticated
 * peer refusal -> verify-collaboration-drivers.ts; pure peer/goal/delegation/drain
 * eligibility and inherited shutdown -> verify-external-editor.ts P13/P12.
 * R6 private/no-shell/scrubbed/cleanup -> real editor ledger + external-editor.ts P1-P12;
 * unchanged Ctrl+G/alias -> verify-external-editor-pty.ts T1-T9/R1-R8.
 * R7 reservation/help/all completions -> verify-reply-command.ts + verify-tui completion.
 * R8 headless (all formats)/dev-REPL -> driver refusals, real CLI processes.
 * Run: pnpm tsx spike/verify-reply-command-pty.ts
 */
import { strict as check } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EDITOR_TEMP_PREFIX } from '../src/tui/external-editor.js';
import { REPLY_UNSUPPORTED } from '../src/commands/reply-command.js';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-reply-pty-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'project'), tmp = path.join(root, 'tmp');
const bin = path.join(root, 'bin'), ledger = path.join(root, 'editors'), mode = path.join(root, 'mode');
for (const dir of [home, cwd, tmp, bin]) await mkdir(dir, { mode: 0o700 });
await mkdir(path.join(home, '.darwin'));
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ promptSuggestions: false, sessionRecap: false, updateCheck: false }));
const editedReply = 'reply 世界\n# keep this comment-looking line\n> edited literal quote';
const editor = path.join(bin, 'fixture editor');
await writeFile(editor, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const file = process.argv.at(-1), mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8');
fs.appendFileSync(${JSON.stringify(ledger)}, JSON.stringify({ file, content: fs.readFileSync(file, 'utf8'),
  dirMode: fs.statSync(path.dirname(file)).mode & 511, fileMode: fs.statSync(file).mode & 511,
  secret: process.env.AWS_SECRET_ACCESS_KEY ?? null, darwin: process.env.DARWIN, pid: process.pid }) + '\\n');
process.stdout.write('REPLY-EDITOR-READY\\n');
process.stdin.setRawMode(true);
process.stdin.on('data', chunk => {
  if (!chunk.toString().includes('\\r')) return;
  process.stdin.setRawMode(false);
  if (mode === 'fail') process.exit(7);
  if (mode === 'invalid') fs.writeFileSync(file, Buffer.from([255]));
  if (mode === 'oversize') fs.writeFileSync(file, 'a'.repeat(65537));
  if (mode === 'bytes') fs.writeFileSync(file, '🧪'.repeat(65537));
  if (mode === 'changed') fs.appendFileSync(file, ${JSON.stringify(editedReply)});
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
  PATH: `${bin}:${process.env['PATH'] ?? ''}`, WAYLAND_DISPLAY: 'reply-fixture', AWS_SECRET_ACCESS_KEY: 'withheld',
  DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' };
const entry = path.join(REPO_ROOT, 'spike/fixtures/external-editor-cli.ts');
const sessions: TuiSession[] = [];
function launch(extra: Record<string, string> = {}, args: string[] = []): TuiSession {
  const session = startTui({ cwd, cols: 90, rows: 24, entry, args, env: { ...env, ...extra } });
  sessions.push(session); return session;
}
let tui = launch();
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
const draft = () => [...tui.frame.matchAll(/you> ?([^\r\n]*)/g)].at(-1)?.[1]?.trimEnd();
const ready = async () => tui.waitUntil(() => draft() !== undefined && !tui.frame.includes('working…'), { timeoutMs: 30_000, settleMs: 150 });
const calls = async () => (await readFile(path.join(cwd, 'editor-model-calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { text: string });
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
  tui.send('\u001b[1;5F'); // whole draft end
  await delay(40);
  for (let row = 0; row < 10; row += 1) {
    tui.send('\u0015'); await delay(20); // row start kill
    tui.send('\u007f'); await delay(20); // remove newline, joining the previous row
  }
  await tui.waitUntil(() => draft() === '', { timeoutMs: 10_000, settleMs: 100 });
}
async function command(text: string, left = 0): Promise<number> {
  const mark = tui.mark();
  tui.send(paste(text));
  await tui.waitUntil(() => draft() === text, { timeoutMs: 10_000, settleMs: 100 });
  tui.send('\u001b'); // dismiss slash completion, then explicit human Enter
  await delay(80);
  for (let index = 0; index < left; index += 1) { tui.send('\u001b[D'); await delay(40); }
  // Cursor movement reopens slash completion; dismiss it without moving the caret.
  if (left > 0) { tui.send('\u001b'); await delay(80); }
  tui.send('\r');
  return mark;
}
async function ask(text: string, answer: string): Promise<void> {
  const mark = await command(text);
  await tui.waitFor(answer, { from: mark, timeoutMs: 30_000 }); await ready();
}
async function openReply(left = 0): Promise<number> {
  const mark = await command('/reply', left);
  await tui.waitFor('REPLY-EDITOR-READY', { from: mark, timeoutMs: 30_000 });
  await delay(100); return tui.mark();
}
async function closeEditor(mark: number, notice: string): Promise<void> {
  tui.send('\r'); await tui.waitFor(notice, { from: mark, timeoutMs: 30_000, settleMs: 150 }); await ready();
  for (const record of await editors()) check.ok(!existsSync(path.dirname(record.file)), 'private storage removed after settlement');
}
async function refuse(text: string, notice: string): Promise<void> {
  const before = await calls(), count = (await editors()).length, disk = await durable();
  const mark = await command(text);
  await tui.waitFor(notice, { from: mark, timeoutMs: 30_000, settleMs: 150 });
  check.equal(draft(), text, 'local refusal retains exact command draft');
  check.equal((await editors()).length, count, 'nothing launched');
  check.deepEqual(await calls(), before, 'no model work');
  check.equal(await durable(), disk, 'no userInput or other durable state');
  await clearDraft();
}
const quote = '> 第一问 🧪\n> \n> e\u0301 русский\n> \t  code > # literal\n\n';
let passed = false;
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 200 });
  await refuse('/reply', 'nothing to reply to');
  await refuse('/reply argument', '/reply takes no arguments');
  await ask('old answer', 'local answer');
  await ask('reply-unicode', 'code > # literal');
  const before = await calls(), disk = await durable();
  const mark = await openReply();
  const first = (await editors()).at(-1)!;
  check.equal(first.content, quote, 'newest completed answer, exact Unicode/multiline seed');
  check.equal(first.dirMode, 0o700); check.equal(first.fileMode, 0o600);
  check.equal(first.secret, null); check.equal(first.darwin, '1');
  check.ok(first.file.startsWith(tmp + path.sep));
  tui.send('/reply'); // repeated invocation is editor input, never a second editor
  await delay(100);
  await closeEditor(mark, 'not sent; Enter sends it');
  check.equal((await editors()).length, 1);
  check.deepEqual(await calls(), before, 'no provider request before Enter');
  check.equal(await durable(), disk, 'no trajectory userInput or draft bytes before Enter');
  check.ok(tui.frame.split('\n').length <= 24, 'redrawn frame stays bounded');
  // Ctrl+G must see exactly the edited draft, not inject quotes again.
  await writeFile(mode, 'unchanged');
  let opened = tui.mark(); tui.send('\u0007');
  await tui.waitFor('REPLY-EDITOR-READY', { from: opened, timeoutMs: 30_000 }); await delay(100);
  check.equal((await editors()).at(-1)?.content, quote + editedReply);
  await closeEditor(tui.mark(), 'closed without changes');
  check.deepEqual(await calls(), before);
  const sent = tui.mark(); tui.send('\r');
  await tui.waitFor('local answer', { from: sent, timeoutMs: 30_000 }); await ready();
  check.deepEqual((await calls()).slice(before.length).map(call => call.text), [quote + editedReply]);
  check.ok((await durable()).includes(JSON.stringify(quote + editedReply).slice(1, -1)));
  console.log('R1/R2/R6 exact quoted round trip, literal retention and unsent-until-Enter passed');
  tui.send(paste('STASH-PRIVATE'));
  await tui.waitUntil(() => draft() === 'STASH-PRIVATE', { timeoutMs: 10_000 });
  tui.send('\u0013');
  await tui.waitUntil(() => draft() === '' && tui.frame.includes('stash: Ctrl+S'), { timeoutMs: 10_000 });
  tui.send('\u000f');
  await tui.waitUntil(() => tui.frame.includes('Ctrl+O remove'), { timeoutMs: 10_000 });
  for (const [result, notice] of [
    ['unchanged', 'closed without changes'], ['fail', 'exited with code 7'],
    ['invalid', 'not valid UTF-8'], ['oversize', 'result exceeds'], ['bytes', 'result exceeds'],
  ]) {
    await writeFile(mode, result!);
    const callBefore = await calls(), diskBefore = await durable();
    const after = await openReply(2);
    const record = (await editors()).at(-1)!;
    check.equal(record.content, '> local answer\n\n');
    check.ok(!record.content.includes('STASH') && !record.content.includes(png.toString('base64')));
    await closeEditor(after, notice!);
    check.equal(draft(), '/reply');
    check.ok(tui.frame.includes('Ctrl+O remove') && tui.frame.includes('stash: Ctrl+S'));
    tui.send('!'); await tui.waitUntil(() => draft() === '/rep!ly', { timeoutMs: 10_000 }); // exact mid-draft cursor preserved
    check.deepEqual(await calls(), callBefore); check.equal(await durable(), diskBefore);
    await clearDraft();
  }
  await writeFile(mode, 'changed');
  const privacyDisk = await durable(), privacyCalls = await calls();
  await closeEditor(await openReply(), 'not sent; Enter sends it');
  check.ok(tui.frame.includes('Ctrl+O remove') && tui.frame.includes('stash: Ctrl+S'));
  check.deepEqual(await calls(), privacyCalls); check.equal(await durable(), privacyDisk);
  tui.send('\u000f'); await tui.waitUntil(() => !tui.frame.includes('Ctrl+O remove'), { timeoutMs: 10_000 });
  await clearDraft(); tui.send('\u0013');
  await tui.waitUntil(() => draft() === 'STASH-PRIVATE', { timeoutMs: 10_000 });
  await clearDraft();
  console.log('R3/R4 unchanged and failed edits retain composer/cursor/image; stash/image privacy passed');
  await command('hold');
  await tui.waitUntil(() => tui.frame.includes('working…'), { timeoutMs: 10_000, settleMs: 100 });
  await refuse('/reply', '/reply opens the external editor only while darwin is idle');
  await command('queued correction');
  await tui.waitUntil(() => tui.frame.includes('queued ·'), { timeoutMs: 10_000, settleMs: 100 });
  await refuse('/reply', '/reply opens the external editor only while darwin is idle');
  await writeFile(path.join(cwd, 'hold-release'), '');
  await tui.waitFor('local answer', { from: tui.mark(), timeoutMs: 30_000 }); await ready();
  check.ok(!(await calls()).some(call => call.text.startsWith('/reply')), 'reply never queued or model-invoked');
  // Modal owners consume input before the human command route.
  for (const search of [true, false]) {
    const count = (await editors()).length, models = await calls();
    tui.send(search ? '\u0012' : '\u001b\u001b');
    await tui.waitUntil(() => tui.frame.includes(search ? 'search' : 'rewind'), { timeoutMs: 10_000 });
    tui.send('/reply\r'); await delay(200);
    check.equal((await editors()).length, count); check.deepEqual(await calls(), models);
    tui.send('\u001b'); await ready(); await clearDraft();
  }
  const permissionMark = await command('permission');
  await tui.waitUntil(() => tui.frame.includes('allow?'), { timeoutMs: 10_000 });
  const permissionEditors = (await editors()).length, permissionCalls = await calls();
  tui.send('/reply\r'); await delay(200);
  check.equal((await editors()).length, permissionEditors); check.deepEqual(await calls(), permissionCalls);
  check.ok(tui.frame.includes('allow?'));
  tui.send('n'); await tui.waitFor('tool step done', { from: permissionMark, timeoutMs: 30_000 }); await ready();
  // Refuse while the real successor factory is awaiting completion.
  await writeFile(path.join(cwd, 'hold-session'), '');
  const clearMark = await command('/clear');
  const deadline = Date.now() + 10_000;
  while (!existsSync(path.join(cwd, 'session-waiting')) && Date.now() < deadline) await delay(20);
  check.ok(existsSync(path.join(cwd, 'session-waiting')));
  await refuse('/reply', '/reply waits until queued or automatic work has run');
  await writeFile(path.join(cwd, 'session-release'), '');
  await tui.waitFor('new session', { from: clearMark, timeoutMs: 30_000 }); await ready();
  await rm(path.join(cwd, 'hold-session'));
  console.log('R5 busy/queued/modal/permission/session ownership and no queued reply passed');
  await ask('reply-unicode', 'code > # literal');
  await command('/exit'); await tui.exitedWithin(20_000);
  const resumeCalls = await calls();
  tui = launch({}, ['--resume']);
  await tui.waitFor('(resumed)', { timeoutMs: 60_000 }); await ready();
  await writeFile(mode, 'unchanged');
  const resumeDisk = await durable();
  await closeEditor(await openReply(), 'closed without changes');
  check.equal((await editors()).at(-1)?.content, quote, 'restored full transcript supplies the exact answer');
  check.deepEqual(await calls(), resumeCalls); check.equal(await durable(), resumeDisk);
  await clearDraft();
  await ask('reply-cap', 'aaaaaaaaaaaaaaaa');
  await refuse('/reply', '/reply quoted answer exceeds 65,536 code points / 256 KiB UTF-8');
  console.log('R1/R3 resumed transcript and post-quote cap refusal passed');
  await command('/exit'); await tui.exitedWithin(20_000);
  // The saved cap answer is intentionally replaced for editor-configuration cases.
  tui = launch(); await tui.waitFor('you>', { timeoutMs: 60_000 });
  await ask('config answer', 'local answer');
  await command('/exit'); await tui.exitedWithin(20_000);
  for (const [visual, guidance] of [
    ['', '/reply needs an external editor: set VISUAL or EDITOR'],
    ['vim; true', 'VISUAL not used'],
    [path.join(root, 'missing-editor'), 'could not start missing-editor'],
  ]) {
    tui = launch({ VISUAL: visual! }, ['--resume']);
    await tui.waitFor('(resumed)', { timeoutMs: 60_000 }); await ready();
    await refuse('/reply', guidance!);
    await command('/exit'); await tui.exitedWithin(20_000);
  }
  check.deepEqual((await readdir(tmp)).filter(name => name.startsWith(EDITOR_TEMP_PREFIX)), []);
  console.log('R3 unset/invalid/launch failure local guidance and cleanup passed');
  const driverCalls = await calls(), driverEditors = (await editors()).length, driverDisk = await durable();
  for (const format of ['text', 'json', 'stream-json']) {
    for (const input of ['/reply', '/reply argument']) {
      const result = spawnSync(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), [entry, '-p', input, '--output-format', format],
        { cwd, env: { ...process.env, ...env }, input: '', encoding: 'utf8', timeout: 30_000 });
      check.equal(result.status, 2, result.stderr); check.equal(result.stdout, '');
      check.ok(result.stderr.includes(REPLY_UNSUPPORTED));
    }
  }
  check.deepEqual(await calls(), driverCalls); check.equal((await editors()).length, driverEditors);
  check.equal(await durable(), driverDisk, 'headless refuses before runtime/trajectory startup');
  tui = launch({ EDITOR_DRIVER: 'repl' });
  await tui.waitFor('you>', { timeoutMs: 60_000 });
  for (const input of ['/reply', '/reply argument']) {
    const mark = tui.mark(); tui.submit(input);
    await tui.waitFor(REPLY_UNSUPPORTED, { from: mark, timeoutMs: 30_000 });
  }
  check.deepEqual(await calls(), driverCalls); check.equal((await editors()).length, driverEditors);
  tui.submit('/exit'); await tui.exitedWithin(20_000);
  console.log('R8 real headless text/json/stream-json and dev-REPL local refusals passed');
  passed = true;
  console.log('SER-132 real-process PTY acceptance passed');
} finally {
  for (const session of sessions) session.kill();
  if (passed) await rm(root, { recursive: true, force: true });
  else console.error(`SER-132 failed; owned artifacts retained at ${root}`);
}
