/**
 * SER-128: real CLI/Ink/SDK, private HOME/cwd, offline local model transport.
 * Run: pnpm tsx spike/verify-composer-vertical-pty.ts (also in pnpm test).
 *
 * Requirement-to-test checklist:
 * V1 repeated Up/Down in ONE PTY write: exact multiline insertion witnesses.
 * V2 preceding cursor/text changes in that write: horizontal/edge, paste, join.
 * V3 Unicode soft wraps at 70/24 columns: exact graphemes and both wrap sides.
 * V4 preferred column: retain through short rows/reversal; reset on typing/move.
 * V5 permission/compaction/history/rewind owners: blocked movement, restored caret.
 *    Menu/queue/recall precedence: existing verify-tui.ts completion/queue/recall.
 * V6 editing never sends: absent model ledger; owner setup calls exactly accounted.
 *
 * Movement expectations are explicit source strings, NOT moveVertical's output.
 * layoutEditor only projects those strings to compare every current visible row.
 * No wait separates keys inside the tested batch; settled waits fence setup/results.
 * Failure retains pty.raw and model-calls in the printed temp directory.
 */
import { strict as check } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { layoutEditor } from '../src/tui/prompt-editor.js';
import { REPO_ROOT, startTui } from './tui-driver.js';
import { assert, header, report } from './shared.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-composer-vertical-'));
const cwd = path.join(root, 'project');
const home = path.join(root, 'home');
await mkdir(cwd);
await mkdir(path.join(home, '.darwin'), { recursive: true });
await writeFile(path.join(home, '.darwin/config.json'), JSON.stringify({ preserveRecentMessages: 1 }));
const tui = startTui({ cwd, cols: 70, rows: 24,
  entry: path.join(REPO_ROOT, 'spike/fixtures/composer-yank-cli.ts'),
  env: { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
const UP = '\u001b[A';
const DOWN = '\u001b[B';
const LEFT = '\u001b[D';
const RIGHT = '\u001b[C';
const START = '\u001b[1;5H';
const END = '\u001b[1;5F';
const ROW_END = '\u001b[F';
const BACK = '\u007f';
const paste = (text: string) => `\u001b[200~${text}\u001b[201~`;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
let columns = 70;
let current = '';
const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, {
  timeoutMs: 15_000, settleMs: 150, label,
});
async function draft(expected: string): Promise<void> {
  const wanted = layoutEditor(expected, columns, { offset: expected.length, affinity: 'upstream' })
    .rows.map((row) => `${row.prefix}${row.text}`.trimEnd());
  await settled(() => {
    const lines = tui.frame.replaceAll('\r', '').split('\n');
    const first = lines.findLastIndex((line) => line.startsWith('you>'));
    return first >= 0 && JSON.stringify(lines.slice(first, first + wanted.length).map((line) => line.trimEnd())) === JSON.stringify(wanted);
  }, `exact draft ${JSON.stringify(expected)}`);
  current = expected;
}
async function clear(): Promise<void> {
  tui.send(END + BACK.repeat([...segmenter.segment(current)].length));
  await draft('');
}
async function seed(text: string): Promise<void> {
  await clear();
  tui.send(paste(text));
  await draft(text);
}
async function witness(name: string, keys: string, expected: string): Promise<void> {
  tui.send(keys); // Intentionally ONE write: no intervening repaint/await.
  await draft(expected);
  assert(`${columns} columns — ${name}`, true);
}

header('SER-128 — current-editor vertical movement in batched terminal input');
try {
  await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 200 });
  for (const width of [70, 24]) {
    columns = width;
    tui.resize(columns, 24);
    await draft(current);
    const multiline = 'aaa\nbbb\nccc\nddd';
    await seed(multiline);
    await witness('V1 Up+Up insertion (original reproduction)', UP + UP + '!', 'aaa\nbbb!\nccc\nddd');
    await seed(multiline);
    await witness('V1 Down+Down after whole-draft start', START + DOWN + DOWN + '!', 'aaa\nbbb\n!ccc\nddd');
    await seed(multiline);
    await witness('V2 typing and Left precede Up+Up', 'X' + LEFT + LEFT + UP + UP + '!', 'aaa\nbb!b\nccc\ndddX');
    await seed(multiline);
    await witness('V2 newline deletion precedes Down+Down', START + DOWN + BACK + DOWN + DOWN + '!', 'aaabbb\nccc\nddd!');
    await clear();
    await witness('V2 paste and Up+Up share one write', paste(multiline) + UP + UP + '!', 'aaa\nbbb!\nccc\nddd');

    const uneven = 'abcdef\nx\nuvwxyz\n012345';
    await seed(uneven);
    await witness('V4 Up retains column through a short row', UP + UP + UP + '!', 'abcdef!\nx\nuvwxyz\n012345');
    await seed(uneven);
    await witness('V4 Down retains column through a short row', START + RIGHT.repeat(5) + DOWN + DOWN + '!', 'abcdef\nx\nuvwxy!z\n012345');
    await seed(uneven);
    await witness('V4 direction reversal retains preferred column', UP + UP + DOWN + '!', 'abcdef\nx\nuvwxyz!\n012345');
    await seed(uneven);
    await witness('V4 typing resets preferred column', START + RIGHT.repeat(5) + DOWN + 'Q' + DOWN + '!', 'abcdef\nxQ\nuv!wxyz\n012345');
    await seed(uneven);
    await witness('V4 horizontal movement resets preferred column', UP + UP + LEFT + DOWN + '!', 'abcdef\nx\n!uvwxyz\n012345');

    // Each of a/b/c fills exactly one visual row: prefix 5 + spare cell 1;
    // 界 and the joined emoji occupy two cells each, e + acute occupies one.
    const stem = (letter: string) => letter.repeat(columns - 11);
    const row = (letter: string) => `${stem(letter)}界👩‍💻e\u0301`;
    const wrapped = `${row('a')}${row('b')}${row('c')}\n1234567`;
    await seed(wrapped);
    await witness('V3 Unicode soft-wrap Up+Up', UP + UP + '!', `${row('a')}${'b'.repeat(7)}!${row('b').slice(7)}${row('c')}\n1234567`);
    await seed(wrapped);
    await witness('V3 Down+Down and Left keep combining grapheme whole', START + ROW_END + DOWN + DOWN + LEFT + '!', `${row('a')}${row('b')}${stem('c')}界👩‍💻!e\u0301\n1234567`);
    await seed(wrapped);
    await witness('V3 upstream landing crosses wrap before next Down', START + ROW_END + DOWN + RIGHT + DOWN + '!', `${row('a')}${row('b')}${row('c')}\n!1234567`);
    await seed(wrapped);
    await witness('V3 downstream landing survives Down/Up reversal', START + ROW_END + RIGHT + DOWN + UP + '!', `${row('a')}!${row('b')}${row('c')}\n1234567`);
    await seed('a👩‍💻e\u0301z\n界x\nb👩‍💻e\u0301z\nq👩‍💻e\u0301z');
    await witness('V3 multiline Unicode retains column at a joined-emoji boundary', LEFT + UP + UP + UP + LEFT + '!', 'a👩‍💻!e\u0301z\n界x\nb👩‍💻e\u0301z\nq👩‍💻e\u0301z');
  }
  check.ok(!existsSync(path.join(cwd, 'model-calls')), 'editing must not invoke even the local model');
  assert('V6 all movement/paste witnesses stay unsent with no model calls', true);

  await clear();
  columns = 70;
  tui.resize(columns, 24);
  await draft('');
  for (const text of ['seed one', 'seed two']) {
    const mark = tui.mark();
    tui.submit(text); // Explicit local-model setup for both search owners/compaction.
    await tui.waitFor('local answer', { from: mark, timeoutMs: 30_000 });
    await settled(() => !tui.frame.includes('working…'), 'seed turn finished');
    await draft('');
  }

  await seed('aaa\nbbb\nccc\nddd');
  const moved = tui.raw.length;
  tui.send(START + RIGHT + RIGHT);
  await settled(() => tui.raw.length > moved, 'cursor on first row before search');
  tui.send('\u0012');
  await settled(() => tui.frame.includes('search'), 'history search owner');
  tui.send(UP + UP + DOWN);
  await settled(() => tui.frame.includes('search'), 'history search retains arrows');
  tui.send('\u001b');
  await draft('aaa\nbbb\nccc\nddd');
  await witness('V5 history search restores exact draft/cursor', '!', 'aa!a\nbbb\nccc\nddd');
  await clear();

  tui.submit('/rewind');
  await settled(() => tui.frame.includes('rewind prompts'), 'rewind search owner');
  tui.send(UP + UP + DOWN);
  await settled(() => tui.frame.includes('rewind prompts'), 'rewind search retains arrows');
  tui.send('\u001b');
  await draft('/rewind');
  await witness('V5 rewind search cancels without editing/sending', '!', '/rewind!');
  await clear();

  const permissionMark = tui.mark();
  tui.submit('permission');
  await tui.waitFor('permission preparing', { from: permissionMark, timeoutMs: 30_000 });
  tui.send(paste('aaa\nbbb\nccc\nddd'));
  await draft('aaa\nbbb\nccc\nddd');
  await writeFile(path.join(cwd, 'release-permission'), '');
  await settled(() => tui.frame.includes('allow? y n') && tui.frame.includes('[parent] bash'), 'permission owner');
  tui.send(UP + UP + DOWN + '!');
  await settled(() => tui.frame.includes('allow? y n'), 'arrows/text do not answer permission');
  check.ok(!existsSync(path.join(cwd, 'yank-permission-sentinel')));
  tui.send('n');
  await tui.waitFor('local answer', { from: permissionMark, timeoutMs: 30_000 });
  await draft('aaa\nbbb\nccc\nddd');
  await witness('V5 permission blocked arrows/text and preserved hidden cursor', '!', 'aaa\nbbb\nccc\nddd!');
  await clear();

  const compactMark = tui.mark();
  tui.submit('/compact');
  await tui.waitFor('compacting conversation', { from: compactMark, timeoutMs: 30_000, settleMs: 200 });
  tui.send(UP + UP + DOWN + DOWN + '!');
  await settled(() => tui.frame.includes('compacting conversation'), 'compaction owns batch');
  await writeFile(path.join(cwd, 'release-summary'), '');
  await tui.waitFor('conversation compacted', { from: compactMark, timeoutMs: 30_000 });
  await draft('');
  await witness('V5 compaction blocked arrows/text; composer resumes empty', 'ok', 'ok');

  check.deepEqual((await readFile(path.join(cwd, 'model-calls'), 'utf8')).trim().split('\n'), [
    '"seed one"', '"seed two"', '"permission"', '"tool result"', '"Please summarize this conversation."',
  ]);
  check.ok(!existsSync(path.join(cwd, 'yank-permission-sentinel')));
  assert('V6 only explicit local setup/permission continuation/compaction invoked the model', true);

  tui.send('\u0004');
  check.equal(await tui.exitedWithin(30_000), 0);
  report();
} catch (error) {
  await writeFile(path.join(root, 'pty.raw'), tui.raw);
  console.error(`SER-128 PTY artifacts: ${root}`);
  process.exitCode = 1;
  throw error;
} finally {
  tui.kill();
  if (process.exitCode !== 1) await rm(root, { recursive: true, force: true });
}
