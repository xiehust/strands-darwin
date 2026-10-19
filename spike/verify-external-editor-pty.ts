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
 * SER-124 requirement -> proving check (same real CLI and editor, no mock layer):
 * R1 separate/combined chord, repeated prefix, one-shot launch -> "alias round trip".
 * R2 exact multiline draft/edit, no model/userInput until Enter -> "alias round trip".
 * R3 Ctrl+X alone keeps text/cursor/image/frame -> "privacy"; no timer or UI row.
 * R4 intervening printable/movement/control keys and paste keep their behavior and
 *    disarm; bare Ctrl+E still row-end -> "invalidation".
 * R5 permission/history/rewind/compaction never arm; async acquisition invalidates
 *    without a key -> "modal ownership", "async wake", "compaction".
 * R6 submission/queueing, session replacement, editor handoff reset -> "queue",
 *    "session replacement", "alias round trip", "invalidation".
 * R7 same callback eligibility/fence -> "busy", "queue", T4/T5 and process suite P13
 *    (idle, queue/draining/clear, peer/goal, live delegation, editorActive).
 * R8 unchanged/nonzero/SIGINT preserve draft/cursor -> T3 via alias; Ctrl+G regression
 *    -> T1/T4/T6-T9. Existing process suite P1-P12 retains security/caps/cleanup proof.
 * Controls use separate writes with settled frames unless explicitly testing a batch.
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
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ preserveRecentMessages: 1, promptSuggestions: false }));

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
const CTRL_X = '\u0018';
const CTRL_E = '\u0005';
const CHORD = CTRL_X + CTRL_E;
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
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
/** One handoff, then wait for the real editor to own the terminal as launch number `n`. */
async function openEditor(n: number, input = CTRL_G): Promise<number> {
  const mark = tui.mark();
  tui.send(input);
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
    await keys(CTRL_X, 'abc');
    await keys(CTRL_X, 'abc'); // re-arm one prefix, not a second launch
    const after = await openEditor(2, CTRL_E);
    tui.send('\r');
    await notice('fixture editor closed without changes — draft unchanged', after);
    await keys('X', 'aXbc');
  });

  await step('nonzero exit: draft and cursor restored with a notice (T3)', async () => {
    await setMode('fail');
    const after = await openEditor(3, CHORD);
    tui.send('\r');
    await notice('fixture editor exited with code 3 — draft unchanged', after);
    await keys('Y', 'aXYbc');
  });

  await step('sigint: Ctrl+C ends only the editor; darwin and the draft survive (T3)', async () => {
    await setMode('sigint');
    const after = await openEditor(4, CHORD);
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
    await keys(LEFT, 'with image');
    const frameBeforePrefix = tui.frame;
    await keys(CTRL_X, 'with image');
    check.equal(tui.frame, frameBeforePrefix, 'Ctrl+X alone changes no frame row or image chip');
    check.ok(chip(), 'Ctrl+X alone keeps the image');
    await keys('Z', 'with imagZe'); // proves the cursor did not move
    await keys('\u007f', 'with image');
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
    const aliasMark = tui.mark();
    tui.send(CHORD);
    await notice('Ctrl+G opens the external editor only while darwin is idle — draft unchanged', aliasMark);
    check.equal((await launched()).length, before, 'the alias uses the same busy refusal');
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

  // SER-124 cases below use dynamic launch counts so the original Ctrl+G cases
  // above keep their independently observable launch numbers.

  await step('alias round trip: separate and combined chords edit exact multiline text once, unsent until Enter (R1, R2, R6)', async () => {
    for (const combined of [false, true]) {
      const original = `ALIAS-${combined ? 'combined' : 'separate'} 世界\ne\u0301 🧪\n\tindented\n\nlast`;
      const expected = original + ' edited';
      const callsBefore = await modelCalls();
      const durableBefore = await homeText();
      const before = (await launched()).length;
      tui.send(paste(original));
      await settled(() => draft() === original.split('\n')[0] && tui.frame.includes('last'), 'multiline draft');
      await setMode('interactive');
      if (!combined) {
        await keys(CTRL_X, original.split('\n')[0]!);
        await keys(CTRL_X, original.split('\n')[0]!);
      }
      const after = await openEditor(before + 1, combined ? CHORD : CTRL_E);
      check.equal((await launched()).at(-1)?.content, original, 'exact multiline draft, including blank line and tab');
      tui.send(CHORD); // while the real editor owns the tty, never a second handoff
      await delay(100);
      tui.send(' edited');
      await delay(100);
      tui.send('\r');
      await notice('draft replaced from fixture editor — not sent', after);
      check.equal((await launched()).length, before + 1, 'one launch for the chord');
      check.deepEqual(await modelCalls(), callsBefore, 'no model call from the edit');
      check.equal(await homeText(), durableBefore, 'no userInput or draft persisted before Enter');
      check.ok((await readFile(keysLog, 'utf8')).includes(JSON.stringify(CHORD)), 'repeated chord reached the editor');

      // The prefix is consumed even after a successful handoff. Bare E must not
      // launch; G independently reopens and observes the exact returned bytes.
      await keys(CTRL_E, original.split('\n')[0]!);
      await setMode('unchanged');
      const reopened = await openEditor(before + 2);
      check.equal((await launched()).at(-1)?.content, expected, 'exact edited draft round trip, no quotes injected');
      tui.send('\r');
      await notice('closed without changes', reopened);
      check.deepEqual(await modelCalls(), callsBefore, 'reopening is still unsent');
      const mark = tui.mark();
      tui.send('\r');
      await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
      await settled(() => idle() && draft() === '', 'explicit send complete');
      check.deepEqual((await modelCalls()).slice(callsBefore.length).map((call) => call.text), [expected], 'only Enter sends once');
      check.ok((await homeText()).includes(JSON.stringify(expected).slice(1, -1)), 'sent multiline prompt is recorded');
    }
  });

  await step('invalidation: intervening keys/paste retain behavior; bare E is row-end; G consumes a prefix (R3, R4, R6)', async () => {
    const before = (await launched()).length;
    for (const [intervening, expected] of [
      ['Z', 'Zabc'], [LEFT, 'abc'], ['\u0002', 'abc'], // Ctrl+B keeps its display-only action
      [paste('P'), 'Pabc'], [paste(CHORD), 'abc'], [paste(''), 'abc'],
    ]) {
      await keys('abc', 'abc');
      await keys(HOME_KEY, 'abc');
      await keys(CTRL_X, 'abc');
      await keys(intervening!, expected!);
      await keys(CTRL_E, expected!);
      await keys('!', expected! + '!'); // E behaved normally, not as an editor command
      await keys(HOME_KEY, expected! + '!');
      await keys(KILL, '');
    }
    check.equal((await launched()).length, before, 'no stale or pasted prefix launched');
    // Bare E moves only to the current row end, never the whole draft end.
    tui.send(paste('abc\nxyz'));
    await settled(() => draft() === 'abc' && tui.frame.includes('xyz'), 'two rows');
    tui.send('\u001b[1;5H'); // Ctrl+Home: whole draft start
    await keys(CTRL_E, 'abc');
    await keys('!', 'abc!');
    await setMode('unchanged');
    await keys(CTRL_X, 'abc!');
    const after = await openEditor(before + 1); // another editor handoff consumes X
    check.equal((await launched()).at(-1)?.content, 'abc!\nxyz', 'bare E stayed on its row');
    tui.send('\r');
    await notice('closed without changes', after);
    await keys(CTRL_E, 'abc!');
    check.equal((await launched()).length, before + 1, 'G did not return an armed prefix');
    tui.send('\u001b[1;5F'); // Ctrl+End
    await keys('\u0015', 'abc!');
    await keys('\u007f', 'abc!'); // remove the newline
    await keys(HOME_KEY, 'abc!');
    await keys(KILL, '');
  });

  await step('modal ownership: history/rewind/async permission cannot arm or retain the chord (R5)', async () => {
    const before = (await launched()).length;
    for (const rewind of [false, true]) {
      if (rewind) tui.send(ESC + ESC);
      else { await keys(CTRL_X, ''); tui.send('\u0012'); }
      await settled(() => tui.frame.includes(rewind ? 'rewind' : 'search'), 'chooser owns keys');
      const frame = tui.frame;
      tui.send(CHORD);
      await delay(250);
      check.equal(tui.frame, frame, 'combined chord does not edit the query');
      tui.send(CTRL_X);
      await delay(100);
      tui.send(CTRL_E);
      await delay(100);
      check.equal(tui.frame, frame, 'separate chord does not edit the query');
      tui.send(ESC);
      await settled(() => !tui.frame.includes(rewind ? 'rewind' : 'search') && draft() === '', 'chooser closed');
      await keys(CTRL_E, '');
    }
    const mark = tui.mark();
    tui.submit('delayed-permission');
    await settled(() => tui.frame.includes('working…'), 'waiting for tool request');
    await keys('abc', 'abc');
    await keys(HOME_KEY, 'abc');
    await keys(CTRL_X, 'abc');
    await writeFile(path.join(cwd, 'permission-release'), ''); // no key as permission takes ownership
    await settled(() => tui.frame.includes('allow?'), 'async permission owns keys');
    tui.send(CTRL_E);
    await delay(100);
    tui.send(CHORD);
    await delay(300);
    check.ok(tui.frame.includes('allow?'), 'permission stays intact');
    tui.send('n');
    await tui.waitFor('tool step done', { from: mark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === 'abc', 'denied turn ended');
    await keys(CTRL_E, 'abc');
    await keys('!', 'abc!');
    check.equal((await launched()).length, before, 'no editor under or after a modal owner');
    check.ok(!existsSync(path.join(cwd, 'permission-sentinel')), 'no accidental approval');
    await keys(HOME_KEY, 'abc!');
    await keys(KILL, '');
  });

  await step('queue: submission clears the prefix; queued work retains the existing refusal (R6, R7)', async () => {
    const before = (await launched()).length;
    await rm(path.join(cwd, 'hold-release'));
    const mark = tui.mark();
    tui.submit('hold');
    await settled(() => tui.frame.includes('working…'), 'held turn');
    await keys('queued-alias', 'queued-alias');
    await keys(CTRL_X, 'queued-alias');
    tui.send('\r');
    await settled(() => draft() === '' && tui.frame.includes('queued'), 'prompt queued');
    await keys(CTRL_E, '');
    const refusalMark = tui.mark();
    tui.send(CHORD);
    await notice('draft unchanged', refusalMark);
    await writeFile(path.join(cwd, 'hold-release'), '');
    await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === '', 'queue drained');
    await keys(CTRL_E, '');
    check.equal((await launched()).length, before, 'no launch across queueing and drain');
    check.equal((await modelCalls()).filter((call) => call.text === 'queued-alias').length, 1, 'queued prompt sent once');
  });

  await step('async wake: an idle prefix cannot survive an entire automatic turn without intervening keys (R5, R6)', async () => {
    const before = (await launched()).length;
    await rm(path.join(cwd, 'job-release'));
    const mark = tui.mark();
    tui.submit('start-job J2');
    await settled(() => tui.frame.includes('allow?'), 'background job approval');
    tui.send('y');
    await tui.waitFor('tool step done', { from: mark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === '', 'background job running, composer idle');
    await keys('abc', 'abc');
    await keys(HOME_KEY, 'abc');
    await keys(CTRL_X, 'abc');
    const wakeMark = tui.mark();
    await writeFile(path.join(cwd, 'job-release'), '');
    await tui.waitFor('wake ack', { from: wakeMark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === 'abc', 'automatic turn finished with draft intact');
    // No key since X: checking eligibility only when E arrives would launch now.
    await keys(CTRL_E, 'abc');
    await keys('!', 'abc!');
    check.equal((await launched()).length, before, 'async ownership invalidated the prefix');
    await keys(HOME_KEY, 'abc!');
    await keys(KILL, '');
  });

  await step('compaction: ignores both chord forms and cannot hand back an armed prefix (R5)', async () => {
    const before = (await launched()).length;
    await keys('/compact', '/compact');
    await keys(ESC, '/compact'); // dismiss completion so Enter submits
    await keys(CTRL_X, '/compact');
    tui.send('\r');
    await settled(() => tui.frame.includes('compacting'), 'compaction owns keys');
    tui.send(CHORD);
    await delay(200);
    tui.send(CTRL_X);
    await delay(200);
    await writeFile(path.join(cwd, 'summary-release'), '');
    await settled(() => idle() && !tui.frame.includes('compacting') && draft() === '', 'compaction ended');
    await keys(CTRL_E, ''); // no key between X under compaction and this E at idle
    check.equal((await launched()).length, before, 'no prefix armed under compaction');
    check.ok((await modelCalls()).some((call) => call.text === 'Please summarize this conversation.'), 'real summarizer call observed');
  });

  await step('session replacement: clear consumes the old prefix and never arms during the handoff (R6)', async () => {
    const before = (await launched()).length;
    const mark = tui.mark();
    await writeFile(path.join(cwd, 'hold-session'), '');
    await keys('/clear', '/clear');
    await keys(ESC, '/clear');
    await keys(CTRL_X, '/clear');
    tui.send('\r');
    const deadline = Date.now() + 10_000;
    while (!existsSync(path.join(cwd, 'session-waiting')) && Date.now() < deadline) await delay(20);
    check.ok(existsSync(path.join(cwd, 'session-waiting')), 'successor is held mid-construction');
    tui.send(CTRL_X);
    await delay(200);
    await writeFile(path.join(cwd, 'session-release'), '');
    await tui.waitFor('new session', { from: mark, timeoutMs: 30_000 });
    await settled(() => idle() && draft() === '', 'successor ready');
    await keys(CTRL_E, '');
    check.equal((await launched()).length, before, 'old prefix absent; no prefix armed during successor construction');
    await rm(path.join(cwd, 'hold-session'));
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
