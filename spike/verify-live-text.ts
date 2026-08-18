/**
 * Pure contracts for the bounded live answer region. No terminal, no model.
 *
 * The property that matters is arithmetic, so it is testable without Ink: the
 * block a frame draws for still-arriving text is never taller than the rows it
 * was given. `spike/probe-live-frame-overflow.tsx` shows what happens when it is
 * (a whole-screen repaint, scrollback included, per text delta).
 */
import { hiddenRowsNotice, liveTextView, MINIMUM_LIVE_BLOCK_ROWS, wrapToRows } from '../src/tui/live-text.js';
import { assert, header, report } from './shared.js';

/** Rows the block actually occupies: label + notice + text + bottom margin. */
function blockHeight(text: string, columns: number, maxRows: number): number {
  const view = liveTextView(text, columns, maxRows);
  if (view.rows.length === 0) return 0;
  return 1 + (view.hiddenRows > 0 ? 1 : 0) + view.rows.length + 1;
}

header('live text — wrapping to real terminal rows');
assert('short text is one row', wrapToRows('hello', 80).length === 1);
assert('explicit newlines are rows', wrapToRows('a\nb\nc', 80).length === 3);
assert('a blank line keeps its row so the text does not shift up',
  wrapToRows('a\n\nb', 80).join('|') === 'a||b');
assert('a paragraph longer than the terminal wraps at words',
  wrapToRows('alpha beta gamma delta', 12).join('|') === 'alpha beta|gamma delta');
assert('the last column is left empty, so a full row cannot self-wrap',
  wrapToRows('abcdefghij', 10).join('|') === 'abcdefghi|j');
assert('a single token wider than the terminal is broken by graphemes',
  wrapToRows('aaaaaaaaaaaa', 6).join('|') === 'aaaaa|aaaaa|aa');
assert('leading indentation survives — it is the shape of printed code',
  wrapToRows('    if (x) {', 80)[0] === '    if (x) {');
assert('wide characters cost two cells',
  wrapToRows('中文中文', 6).join('|') === '中文|中文');
assert('a tab becomes the same visible tab stop the editor uses',
  wrapToRows('\tx', 80)[0] === '    x');

header('live text — the tail that fits');
assert('empty text draws nothing at all', blockHeight('', 80, 10) === 0);
const short = 'one\ntwo\nthree';
assert('text that fits is shown whole and reports nothing hidden',
  liveTextView(short, 80, 10).rows.map((row) => row.text).join('|') === 'one|two|three' &&
  liveTextView(short, 80, 10).hiddenRows === 0);

const long = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
for (const maxRows of [4, 5, 8, 12, 24, 50]) {
  assert(`a 200-line answer fits ${maxRows} rows`, blockHeight(long, 80, maxRows) <= maxRows);
}
// Round 2: the block used to clamp up to its minimum, which meant a frame with
// less room than that overflowed by the difference. It now yields the frame
// instead — the answer is the participant whose text `<Static>` history is already
// guaranteed to hold in full. `verify-frame-budget.ts` owns who gets those rows.
for (const maxRows of [0, 1, 2, 3]) {
  assert(`a grant of ${maxRows} rows draws a block that fits it`, blockHeight(long, 80, maxRows) <= maxRows);
}
assert('an answer that fits without a notice is still shown below the minimum',
  blockHeight('one line', 80, 3) === 3 && liveTextView('one line', 80, 3).hiddenRows === 0);
assert('a tail that would need a notice yields the frame entirely',
  blockHeight(long, 80, 3) === 0 && liveTextView(long, 80, 3).rows.length === 0);
assert('the minimum is what a tail with its notice costs', MINIMUM_LIVE_BLOCK_ROWS === 4);
const tail = liveTextView(long, 80, 12);
assert('the tail is the newest rows, in order',
  tail.rows[tail.rows.length - 1]?.text === 'line 200' &&
  tail.rows.map((row) => row.text).join('|').includes('line 199|line 200'));
assert('a tail row remembers which logical line it came from',
  tail.rows[tail.rows.length - 1]?.line === 199);
assert('everything dropped is counted', tail.hiddenRows + tail.rows.length === 200);
assert('the notice says how much scrolled out',
  hiddenRowsNotice(tail.hiddenRows).includes(String(tail.hiddenRows)));
assert('one hidden row is singular', hiddenRowsNotice(1) === '… 1 earlier line scrolled out of the live view');

const wrapped = 'x'.repeat(4000);
assert('one enormous unbroken paragraph is bounded too — the common streaming case',
  blockHeight(wrapped, 80, 10) <= 10 && liveTextView(wrapped, 80, 10).hiddenRows > 0);
assert('a narrow terminal is still bounded', blockHeight(long, 4, 6) <= 6);

report();
