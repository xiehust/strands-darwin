/**
 * SER-084 free pty scenario: production CLI/App, real local SDK model and files,
 * no provider transport or mock layer. Run: pnpm tsx spike/verify-composer-yank.ts
 * Each control byte is a separate write, separated by a settled current-frame
 * check (Ink folds control bytes glued to text). Negative checks hold the current
 * frame, not accumulated scrollback; a printable marker proves the next cursor.
 * Owned temp HOME/cwd, price fetch disabled. Includes all undo-reset seams,
 * permission/search/compaction ownership and a narrow soft-wrap/cap case.
 */
import { strict as nodeAssert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LAST_CUT_CAP, LAST_CUT_OVERFLOW_NOTICE } from '../src/tui/prompt-editor.js';
import { REPO_ROOT, startTui } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-yank-'));
const home = path.join(root, 'home');
const cwd = path.join(root, 'project');
await mkdir(path.join(home, '.darwin'), { recursive: true });
await mkdir(cwd);
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({
  preserveRecentMessages: 1,
}));
const tui = startTui({ cwd, cols: 60, rows: 20,
  entry: path.join(REPO_ROOT, 'spike/fixtures/composer-yank-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
const YANK = '\u0019';
const UNDO = '\u001f';
const HOME = '\u001b[H';
const END = '\u001b[F';
const UP = '\u001b[A';
const BACK = '\u007f';
const DELETE = '\u001b[3~';
const ESC = '\u001b';
const draft = () => /you> ?([^\r\n]*)/.exec(tui.frame)?.[1]?.trimEnd();
const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, {
  timeoutMs: 30_000, settleMs: 150, label,
});
async function keys(input: string, expected: string): Promise<void> {
  tui.send(input);
  await settled(() => draft() === expected, `draft ${JSON.stringify(expected)}`);
}
async function emptyYank(expected = ''): Promise<void> {
  await keys(YANK, expected);
  // A following printable key proves the cursor too, and gives no-op keys a render.
  await keys('~', `${expected}~`);
  await keys(BACK, expected);
}
async function seedCut(text = 'CUT'): Promise<void> {
  await keys(text, text);
  await keys('\u0015', '');
}
async function localReset(): Promise<void> {
  // All callers leave a short one-line draft; ordinary deletes must not populate.
  await keys(`${END}${BACK.repeat(100)}`, '');
  const mark = tui.mark();
  tui.submit('/usage');
  await tui.waitFor('usage', { from: mark, timeoutMs: 30_000 });
  await settled(() => draft() === '', 'empty after local submission');
}
async function sendTurn(text: string): Promise<void> {
  const mark = tui.mark();
  tui.submit(text);
  await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
  await settled(() => draft() === '' && !tui.frame.includes('working…'), 'turn finished');
}
async function probe(name: string, action: () => Promise<void>): Promise<void> {
  await action();
  assert(name, true);
}


header('SER-084 — exact draft-local cut/yank in a real pty');
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
  await probe('empty yank and ordinary Backspace/Delete never populate the register', async () => {
    await emptyYank();
    await keys('ab', 'ab');
    await keys(BACK, 'a');
    await keys(`${HOME}${DELETE}`, '');
    await emptyYank();
  });
  await probe('cut/move/type/repeated yank retains intervening edits; undo is still snapshot restoration', async () => {
    await keys('alpha beta', 'alpha beta');
    await keys('\u0017', 'alpha');
    await keys(`${HOME}X`, 'Xalpha');
    await keys(YANK, 'Xbetaalpha');
    await keys(YANK, 'Xbetabetaalpha');
    await keys(UNDO, 'alpha beta');
    await keys('!', 'alpha beta!');
    await keys(YANK, 'alpha beta!beta');
  });
  await localReset();
  await probe('no-op K/U/W and Alt cuts preserve the slot, nonempty cuts replace rather than coalesce', async () => {
    await seedCut('first');
    for (const key of ['\u000b', '\u0015', '\u0017', '\u001bd', '\u001b\u007f']) await keys(key, '');
    await keys(YANK, 'first');
    await keys(' second', 'first second');
    await keys('\u0017', 'first');
    await keys(YANK, 'first second');
    await keys(`${HOME}${DELETE}`, 'irst second');
    await keys(`${END}${BACK}`, 'irst secon');
    await keys(YANK, 'irst seconsecond');
  });
  await localReset();
  await probe('Alt+Backspace, Alt+D and Alt+Delete feed exact cuts, including ZWJ/combining text', async () => {
    const word = '👩‍👩‍👧‍👦e\u0301';
    await keys(`ok ${word}`, `ok ${word}`);
    await keys('\u001b\u007f', 'ok');
    await keys(YANK, `ok ${word}`);
    await keys(`${HOME}\u001bd`, ` ${word}`);
    await keys(YANK, `ok ${word}`);
    await keys(`${HOME}\u001b[3;3~`, ` ${word}`);
    await keys(YANK, `ok ${word}`);
  });
  await localReset();
  await probe('Ctrl+K cuts at cursor, and soft-wrapped Ctrl+U keeps the other visual row', async () => {
    await keys('abcdef', 'abcdef');
    await keys(`${HOME}\u001b[C\u001b[C`, 'abcdef');
    await keys('\u000b', 'ab');
    await keys(`${HOME}X`, 'Xab');
    await keys(YANK, 'Xcdefab');
    await localReset();
    tui.resize(40, 24);
    await settled(() => tui.frame.includes('you>'), 'narrow frame');
    const rawStart = tui.raw.length;
    const wrapped = `${'a'.repeat(34)}WRAPTAIL`;
    tui.send(wrapped);
    await settled(() => /\n +WRAPTAIL/.test(tui.frame), 'wrapped suffix');
    tui.send('\u0015');
    await settled(() => !tui.frame.includes('WRAPTAIL'), 'cut only second visual row');
    tui.send(YANK);
    await settled(() => /\n +WRAPTAIL/.test(tui.frame), 'yanked wrapped suffix');
    nodeAssert.ok(!tui.raw.slice(rawStart).includes('\u001b[2J'), 'no overflow clear after resize');
    tui.resize(60, 20);
    await settled(() => draft() === wrapped, 'exact unwrapped draft');
  });
  await localReset();

  await probe('local-only edits have made no model calls; submission clears the cut', async () => {
    await nodeAssert.rejects(readFile(path.join(cwd, 'model-calls')), { code: 'ENOENT' });
    await seedCut();
    await sendTurn('history seed');
    await emptyYank();
  });
  await probe('recall acceptance clears a cut made on an empty draft', async () => {
    await seedCut();
    tui.send(UP);
    await settled(() => draft() === 'history seed', 'recalled prompt');
    await emptyYank('history seed');
  });
  await localReset();
  await probe('search owns Ctrl+Y, Escape keeps the register/cursor, acceptance clears it', async () => {
    await seedCut();
    await keys('draft', 'draft');
    tui.send('\u0012');
    await settled(() => tui.frame.includes('search'), 'history search open');
    const before = tui.frame;
    tui.send(YANK);
    await settled(() => tui.frame === before, 'Ctrl+Y inert during search');
    await keys(ESC, 'draft');
    await keys(YANK, 'draftCUT');
    tui.send('\u0012');
    await settled(() => tui.frame.includes('search'), 'search reopened');
    tui.send('history seed');
    await settled(() => tui.frame.includes('history seed'), 'search match');
    await keys('\t', 'history seed');
    await emptyYank('history seed');
  });
  await localReset();
  await probe('queue submission and take-back both clear the cut; cancel return does too', async () => {
    const mark = tui.mark();
    tui.submit('!sleep 30');
    await tui.waitFor('running ! command', { from: mark, timeoutMs: 30_000, settleMs: 200 });
    await seedCut();
    tui.submit('queued draft');
    await settled(() => tui.frame.includes('queued · queued draft') && draft() === '', 'enqueued');
    await emptyYank();
    await seedCut('TAKE');
    await keys(UP, 'queued draft');
    await emptyYank('queued draft');
    tui.send('\r');
    await settled(() => tui.frame.includes('queued · queued draft') && draft() === '', 're-enqueued');
    await seedCut('CANCEL');
    tui.send('\u0003');
    await settled(() => draft() === 'queued draft' && !tui.frame.includes('running ! command'), 'cancel return');
    await emptyYank('queued draft');
  });
  await localReset();
  await probe('clear replaces the session with an empty register', async () => {
    await seedCut();
    const mark = tui.mark();
    tui.submit('/clear');
    await tui.waitFor('new session', { from: mark, timeoutMs: 30_000, settleMs: 200 });
    await emptyYank();
  });
  await sendTurn('rewind seed');
  await sendTurn('second seed');
  await probe('Esc-Esc rewind search owns Ctrl+Y; branch acceptance clears even without submission', async () => {
    await seedCut('BRANCH');
    tui.send(`${ESC}${ESC}`);
    await settled(() => tui.frame.includes('rewind'), 'rewind chooser');
    const before = tui.frame;
    tui.send(YANK);
    await settled(() => tui.frame === before, 'Ctrl+Y inert in rewind search');
    const mark = tui.mark();
    tui.send('\r');
    await tui.waitFor('rewound conversation into new session', { from: mark, timeoutMs: 30_000 });
    await settled(() => draft() === 'second seed', 'branch prompt unsent');
    await emptyYank('second seed');
  });
  await localReset();

  await probe('over-cap cut deletes and warns, clears stale yank, and stays fully undoable', async () => {
    await seedCut('STALE');
    const huge = 'Z'.repeat(LAST_CUT_CAP + 1);
    tui.send(`\u001b[200~${huge}\u001b[201~`);
    await settled(() => tui.frame.includes('draft rows not shown'), 'large pasted draft');
    const mark = tui.mark();
    await keys('\u0017', '');
    await tui.waitFor(LAST_CUT_OVERFLOW_NOTICE.slice(0, LAST_CUT_OVERFLOW_NOTICE.indexOf(';')), { from: mark, timeoutMs: 30_000 });
    await emptyYank();
    tui.send(UNDO);
    await settled(() => tui.frame.includes('draft rows not shown'), 'large draft restored');
    // Deleting again proves undo restored the full over-cap word, not a preview.
    const again = tui.mark();
    await keys('\u0017', '');
    await tui.waitFor('yank cleared', { from: again, timeoutMs: 30_000 });
    await emptyYank();
    nodeAssert.ok(!tui.raw.includes('\u001b]52;'), 'no clipboard OSC emitted');
  });
  await probe('Ctrl+Y cannot approve a real permission and preserves the held draft/register', async () => {
    const mark = tui.mark();
    tui.submit('permission');
    await tui.waitFor('permission preparing', { from: mark, timeoutMs: 30_000 });
    await seedCut('HELD');
    await keys('draft', 'draft');
    await writeFile(path.join(cwd, 'release-permission'), '');
    await settled(() => tui.frame.includes('allow?'), 'permission prompt');
    tui.send(YANK);
    await settled(() => tui.frame.includes('allow?'), 'permission still pending after Ctrl+Y');
    await nodeAssert.rejects(readFile(path.join(cwd, 'yank-permission-sentinel')), { code: 'ENOENT' });
    tui.send('n');
    await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
    await settled(() => draft() === 'draft', 'held draft after denial');
    await keys(YANK, 'draftHELD');
    await nodeAssert.rejects(readFile(path.join(cwd, 'yank-permission-sentinel')), { code: 'ENOENT' });
  });
  await localReset();
  await probe('compaction owns keys and paste, then returns an empty register and usable editor', async () => {
    const mark = tui.mark();
    tui.submit('/compact');
    await tui.waitFor('compacting conversation', { from: mark, timeoutMs: 30_000, settleMs: 200 });
    tui.send(YANK);
    await settled(() => tui.frame.includes('compacting conversation'), 'compaction owns Ctrl+Y');
    tui.send('blocked');
    tui.send('\u001b[200~blocked-paste\u001b[201~');
    await settled(() => !tui.frame.includes('blocked'), 'typing and paste ignored');
    await writeFile(path.join(cwd, 'release-summary'), '');
    await tui.waitFor('conversation compacted', { from: mark, timeoutMs: 30_000 });
    await settled(() => draft() === '', 'empty after compaction');
    await emptyYank();
  });

  tui.send('\u0004');
  nodeAssert.equal(await tui.exitedWithin(30_000), 0);
  report();
} catch (error) {
  // Keep bounded failure evidence outside the repository for diagnosis.
  await writeFile(path.join(root, 'failure.txt'), tui.raw.slice(-100_000));
  console.error(`pty evidence: ${root}/failure.txt\n${tui.frame}`);
  process.exitCode = 1;
  throw error;
} finally {
  tui.kill();
  // Preserve failure artifacts, but successful tests own and remove their fixtures.
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true });
}

