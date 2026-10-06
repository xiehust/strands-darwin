/**
 * SER-113 production-CLI pty acceptance for Ctrl+G external editing (in `pnpm test`).
 * Real pty, real CLI/App/runtime/SDK loop, local scripted model, real fixture editor
 * and clipboard helper processes; owned HOME/cwd/TMPDIR; no provider, no network.
 * Run: pnpm tsx spike/verify-external-editor-pty.ts
 *
 * Requirement -> step below:
 * T1 Ctrl+G hands the terminal to VISUAL (quoted path with a space + flag; EDITOR ignored),
 *    keys reach the editor, the frame redraws editable and bounded afterwards -> "changed".
 * T2 the edited draft appears unsent: no model call, no userInput/draft bytes in HOME until
 *    an explicit Enter, which then sends it normally -> "changed".
 * T3 unchanged / nonzero / SIGINT edits restore the exact draft and cursor; darwin survives
 *    the editor's Ctrl+C -> "unchanged", "failed", "sigint".
 * T4 a second Ctrl+G during the edit goes to the editor and never launches twice -> "changed".
 * T5 busy, permission and history-search states refuse or ignore Ctrl+G -> "busy", "permission", "search".
 * T6 the attached image and the stash stay out of the temp file; the image survives; a pending
 *    clipboard read is invalidated -> "privacy".
 * T7 queued automatic work (a task wake) does not drain while the editor is open, then
 *    drains normally, and the Static notice committed meanwhile is printed -> "drains".
 * T8 darwin shutdown reaps the editor and removes its storage; no storage leaks -> "shutdown".
 * T9 neither VISUAL nor EDITOR set -> one guidance notice, draft untouched -> "unset".
 * Each control byte is its own write, separated by a settled current-frame check.
 */
import { strict as check } from 'node:assert';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EDITOR_TEMP_PREFIX } from '../src/tui/external-editor.js';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-ext-editor-pty-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'project');
const tmp = path.join(root, 'tmp');
const bin = path.join(root, 'editor bin');
const launches = path.join(root, 'editor-launches.jsonl');
const keysLog = path.join(root, 'editor-keys.log');
const modeFile = path.join(root, 'editor-mode');
await mkdir(path.join(home, '.darwin'), { recursive: true, mode: 0o700 });
await mkdir(cwd);
await mkdir(tmp, { mode: 0o700 });
await mkdir(bin);
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ preserveRecentMessages: 1 }));

const editor = path.join(bin, 'fixture editor');
await writeFile(editor, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = process.argv[process.argv.length - 1];
const mode = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim() : 'interactive';
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), file, mode,
  darwin: process.env.DARWIN ?? null, secret: process.env.AWS_SECRET_ACCESS_KEY ?? null,
  content: fs.readFileSync(file, 'utf8'),
}) + '\\n');
const count = fs.readFileSync(${JSON.stringify(launches)}, 'utf8').trim().split('\\n').length;
process.stdout.write('EDITOR-READY ' + count + '\\n');
if (mode === 'sigint') { setInterval(() => {}, 1000); return; }
process.stdin.setRawMode(true);
let typed = '';
process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  fs.appendFileSync(${JSON.stringify(keysLog)}, JSON.stringify(text) + '\\n');
  if (!text.includes('\\r')) { typed += text.replace(/[\\u0000-\\u001f]/g, ''); return; }
  process.stdin.setRawMode(false);
  if (mode === 'fail') process.exit(3);
  if (mode === 'interactive') fs.appendFileSync(file, typed);
  process.exit(0);
});
`);
await chmod(editor, 0o755);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==', 'base64');
await writeFile(path.join(root, 'clipboard.png'), png);
await writeFile(path.join(bin, 'wl-paste'), `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(root)};
const mode = fs.existsSync(dir + '/clip-mode') ? fs.readFileSync(dir + '/clip-mode', 'utf8') : 'immediate';
fs.appendFileSync(dir + '/clip-starts', mode + '\\n');
const done = () => { process.stdout.write(fs.readFileSync(dir + '/clipboard.png')); fs.appendFileSync(dir + '/clip-done', mode + '\\n'); };
if (mode === 'immediate') done();
else { const timer = setInterval(() => { if (fs.existsSync(dir + '/clip-release')) { clearInterval(timer); done(); } }, 20); }
`);
await chmod(path.join(bin, 'wl-paste'), 0o755);

const ROWS = 24;
const baseEnv = {
  HOME: home, TMPDIR: tmp, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true',
  PATH: `${bin}:${process.env['PATH'] ?? ''}`, WAYLAND_DISPLAY: 'editor-test', AWS_SECRET_ACCESS_KEY: 'withheld-value',
};
function launch(env: Record<string, string>): TuiSession {
  return startTui({ cwd, cols: 90, rows: ROWS, entry: path.join(REPO_ROOT, 'spike/fixtures/external-editor-cli.ts'), env });
}
const tui = launch({ ...baseEnv, VISUAL: `'${editor}' --from-visual`, EDITOR: path.join(root, 'editor-should-not-run') });

const CTRL_G = '\u0007';
const LEFT = '\u001b[D';
const HOME_KEY = '\u001b[H';
const KILL = '\u000b';
const ESC = '\u001b';
const draft = (session: TuiSession = tui): string | undefined => {
  const matches = [...session.frame.matchAll(/you> ?([^\r\n]*)/g)];
  return matches.at(-1)?.[1]?.trimEnd();
};
const settled = (predicate: () => boolean, label: string, session: TuiSession = tui) =>
  session.waitUntil(predicate, { timeoutMs: 30_000, settleMs: 200, label });
async function keys(input: string, expected: string, session: TuiSession = tui): Promise<void> {
  session.send(input);
  await settled(() => draft(session) === expected, `draft ${JSON.stringify(expected)}`, session);
}
interface Launch { pid: number; argv: string[]; cwd: string; file: string; mode: string; darwin: string | null; secret: string | null; content: string }
async function launched(): Promise<Launch[]> {
  if (!existsSync(launches)) return [];
  return (await readFile(launches, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Launch);
}
async function modelCalls(): Promise<Array<{ text: string; afterTool: boolean }>> {
  const text = await readFile(path.join(cwd, 'editor-model-calls.jsonl'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { text: string; afterTool: boolean });
}
async function homeText(dir = home): Promise<string> {
  let all = '';
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) all += await homeText(name);
    else if (entry.isFile()) all += await readFile(name, 'utf8');
  }
  return all;
}
async function setMode(mode: string): Promise<void> { await writeFile(modeFile, mode); }
/** Ctrl+G, then wait for the fixture editor to own the terminal as launch number `n`. */
async function openEditor(n: number): Promise<number> {
  const mark = tui.mark();
  tui.send(CTRL_G);
  await tui.waitFor(`EDITOR-READY ${n}`, { from: mark, timeoutMs: 30_000 });
  await delay(150);
  return tui.mark();
}
async function notice(text: string, from: number, session: TuiSession = tui): Promise<void> {
  await session.waitFor(text, { from, timeoutMs: 30_000, settleMs: 200 });
}
async function step(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
    assert(label, true);
  } catch (error) {
    assert(`${label} — ${error instanceof Error ? error.message : String(error)}`, false);
    throw error;
  }
}
const chip = () => tui.frame.includes('Ctrl+O remove');
const stashed = () => tui.frame.includes('stash: Ctrl+S');
const idle = () => !tui.frame.includes('working…') && draft() !== undefined;

header('SER-113 — Ctrl+G external editor in the production CLI (local transport)');
let failed = false;
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });

  await step('changed: VISUAL gets the exact draft and the keys; result replaces the draft unsent (T1, T2, T4)', async () => {
    await keys('draft 世界', 'draft 世界');
    const after = await openEditor(1);
    tui.send(' edited');
    await delay(100);
    tui.send(CTRL_G); // a repeated chord while the editor owns the terminal
    await delay(100);
    tui.send('\r');
    await notice('draft replaced from fixture editor — not sent', after);
    await settled(() => draft() === 'draft 世界 edited', 'edited draft shown');
    const [first] = await launched();
    check.equal((await launched()).length, 1, 'exactly one launch');
    check.equal(first?.argv[0], '--from-visual', 'VISUAL (quoted path with a space + flag) won over EDITOR');
    check.equal(first?.content, 'draft 世界', 'the temp file held the exact draft');
    check.equal(first?.darwin, '1', 'DARWIN=1 in the editor env');
    check.equal(first?.secret, null, 'credential-shaped variable withheld');
    check.equal(first?.cwd, cwd, 'session cwd');
    check.ok(first?.file.startsWith(tmp + path.sep), 'storage under TMPDIR, outside the project');
    const keyLog = await readFile(keysLog, 'utf8');
    check.ok(keyLog.includes(JSON.stringify(CTRL_G)), 'the second Ctrl+G reached the editor, not darwin');
    check.ok(keyLog.includes(' edited'), 'typed keys reached the editor');
    check.deepEqual(await modelCalls(), [], 'no model call before Enter');
    const durable = await homeText();
    check.ok(!durable.includes('edited') && !durable.includes('"userInput"'), 'no draft bytes or userInput in HOME before Enter');
    check.ok(tui.frame.split('\n').length <= ROWS, 'the redrawn frame fits the terminal');
    await keys('Z', 'draft 世界 editedZ'); // cursor at the end, editable
    await keys('\u007f', 'draft 世界 edited');
    const mark = tui.mark();
    tui.send('\r');
    await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === '', 'turn finished');
    check.deepEqual((await modelCalls()).map((call) => call.text), ['draft 世界 edited'], 'Enter sent the edited draft once');
    check.ok((await homeText()).includes('draft 世界 edited'), 'the sent prompt is now recorded');
  });

  await step('unchanged: the exact draft and cursor survive (T3)', async () => {
    await setMode('unchanged');
    await keys('abc', 'abc');
    await keys(LEFT, 'abc');
    await keys(LEFT, 'abc');
    const after = await openEditor(2);
    tui.send('\r');
    await notice('fixture editor closed without changes — draft unchanged', after);
    await keys('X', 'aXbc');
  });

  await step('nonzero exit: draft and cursor restored with a notice (T3)', async () => {
    await setMode('fail');
    const after = await openEditor(3);
    tui.send('\r');
    await notice('fixture editor exited with code 3 — draft unchanged', after);
    await keys('Y', 'aXYbc');
  });

  await step('sigint: Ctrl+C ends only the editor; darwin and the draft survive (T3)', async () => {
    await setMode('sigint');
    const after = await openEditor(4);
    tui.send('\u0003');
    await notice('fixture editor was ended by SIGINT — draft unchanged', after);
    await keys('W', 'aXYWbc');
    check.equal((await modelCalls()).length, 1, 'no model call from failed edits');
    await keys(HOME_KEY, 'aXYWbc');
    await keys(KILL, '');
  });

  await step('privacy: stash and image stay in memory; a pending clipboard read is invalidated (T6)', async () => {
    await keys('STASHED-SECRET', 'STASHED-SECRET');
    tui.send('\u0013');
    await settled(() => draft() === '' && stashed(), 'draft stashed');
    await keys('with image', 'with image');
    tui.send('\u000f');
    await settled(() => chip(), 'image attached');
    await setMode('unchanged');
    let after = await openEditor(5);
    tui.send('\r');
    await notice('closed without changes', after);
    await settled(() => chip() && stashed() && draft() === 'with image', 'image and stash intact');
    const fifth = (await launched())[4];
    check.equal(fifth?.content, 'with image', 'only the draft text reached the temp file');
    check.ok(!fifth?.content.includes('STASHED') && !fifth?.content.includes('iVBOR'), 'no stash text or image bytes');
    // Remove the image, start a held clipboard read, then open the editor before it lands.
    const removed = tui.mark();
    tui.send('\u000f');
    await notice('clipboard image removed', removed);
    await writeFile(path.join(root, 'clip-mode'), 'hold');
    tui.send('\u000f');
    const deadline = Date.now() + 10_000;
    while (!(await readFile(path.join(root, 'clip-starts'), 'utf8').catch(() => '')).includes('hold') && Date.now() < deadline) await delay(20);
    after = await openEditor(6);
    await writeFile(path.join(root, 'clip-release'), '');
    while (!(await readFile(path.join(root, 'clip-done'), 'utf8').catch(() => '')).includes('hold') && Date.now() < deadline + 10_000) await delay(20);
    tui.send('\r');
    await notice('closed without changes', after);
    await delay(500);
    check.ok(!chip() && !tui.screen.slice(after).includes('image attached'), 'the stale clipboard read did not attach');
    await keys(HOME_KEY, 'with image');
    await keys(KILL, '');
  });

  await step('busy: Ctrl+G refuses while a turn runs (T5)', async () => {
    const before = (await launched()).length;
    const mark = tui.mark();
    tui.submit('hold');
    await settled(() => tui.frame.includes('working…'), 'busy');
    tui.send(CTRL_G);
    await notice('Ctrl+G opens the external editor only while darwin is idle — draft unchanged', mark);
    check.equal((await launched()).length, before, 'no launch while busy');
    await writeFile(path.join(cwd, 'hold-release'), '');
    await tui.waitFor('held answer', { from: mark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === '', 'turn finished');
  });

  await step('permission: the prompt owns Ctrl+G; no launch, prompt intact (T5)', async () => {
    const before = (await launched()).length;
    const mark = tui.mark();
    tui.submit('permission');
    await settled(() => tui.frame.includes('allow?'), 'permission prompt');
    tui.send(CTRL_G);
    await delay(600);
    check.equal((await launched()).length, before, 'no launch under a permission prompt');
    check.ok(tui.frame.includes('allow?'), 'permission prompt still pending');
    tui.send('n');
    await tui.waitFor('tool step done', { from: mark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === '', 'turn finished');
    check.ok(!existsSync(path.join(cwd, 'permission-sentinel')), 'denied command never ran');
  });

  await step('search: history search owns Ctrl+G (T5)', async () => {
    const before = (await launched()).length;
    tui.send('\u0012');
    await settled(() => tui.frame.includes('search'), 'history search open');
    const frame = tui.frame;
    tui.send(CTRL_G);
    await delay(600);
    check.equal((await launched()).length, before, 'no launch during search');
    check.equal(tui.frame, frame, 'search frame unchanged');
    tui.send(ESC);
    await settled(() => !tui.frame.includes('search') && draft() === '', 'search closed');
  });

  await step('drains: a task wake waits for the editor, then drains; its notice is printed (T7)', async () => {
    const mark = tui.mark();
    tui.submit('start-job J1');
    await settled(() => tui.frame.includes('allow?'), 'bash start permission');
    tui.send('y');
    await tui.waitFor('tool step done', { from: mark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === '', 'turn finished');
    const callsBefore = (await modelCalls()).length;
    await setMode('unchanged');
    const n = (await launched()).length + 1;
    const after = await openEditor(n);
    await writeFile(path.join(cwd, 'job-release'), '');
    await delay(2_500); // the job ends and its wake is enqueued while the editor owns the terminal
    check.equal((await modelCalls()).length, callsBefore, 'no wake turn while the editor is open');
    tui.send('\r');
    await notice('closed without changes', after);
    await tui.waitFor('wake ack', { from: after, timeoutMs: 30_000 });
    const calls = await modelCalls();
    check.ok(calls.slice(callsBefore).some((call) => call.text.startsWith('<task-notification')), 'the wake drained after the editor');
    check.ok(tui.screen.slice(after).includes('J1'), 'the job completion committed during the edit is printed after resume');
    await settled(() => idle() && draft() === '', 'wake turn finished');
  });

  await step('shutdown: SIGTERM to darwin reaps the editor and removes its storage (T8)', async () => {
    await setMode('interactive');
    const n = (await launched()).length + 1;
    await openEditor(n);
    const last = (await launched()).at(-1);
    check.ok(last !== undefined && existsSync(path.dirname(last.file)), 'storage exists while editing');
    tui.kill('SIGTERM');
    await tui.exitedWithin(20_000);
    let alive = true;
    const deadline = Date.now() + 5_000;
    while (alive && Date.now() < deadline) {
      try { process.kill(last!.pid, 0); await delay(25); } catch { alive = false; }
    }
    check.ok(!alive, 'the editor process was reaped');
    check.ok(!existsSync(path.dirname(last!.file)), 'its private directory was removed');
    check.deepEqual((await readdir(tmp)).filter((name) => name.startsWith(EDITOR_TEMP_PREFIX)), [], 'no editor storage left in TMPDIR');
  });
} catch {
  failed = true;
} finally {
  tui.kill();
}

if (!failed) {
  const unset: Record<string, string> = { ...baseEnv };
  const plain = launch({ ...unset, VISUAL: '', EDITOR: '' });
  try {
    await step('unset: guidance notice, draft untouched, nothing launched (T9)', async () => {
      await plain.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
      const before = (await launched()).length;
      await keys('keep me', 'keep me', plain);
      const mark = plain.mark();
      plain.send(CTRL_G);
      await notice('Ctrl+G needs an external editor: set VISUAL or EDITOR', mark, plain);
      await keys('!', 'keep me!', plain);
      check.equal((await launched()).length, before, 'no editor guessed or launched');
    });
  } catch {
    // reported by step()
  } finally {
    plain.kill();
  }
}

await rm(root, { recursive: true, force: true });
report();
