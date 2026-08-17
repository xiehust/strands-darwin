/**
 * Pure contracts for the bounded live answer region. No terminal, no model.
 *
 * The property that matters is arithmetic, so it is testable without Ink: the
 * block a frame draws for still-arriving text is never taller than the rows it
 * was given. `spike/probe-live-frame-overflow.tsx` shows what happens when it is
 * (a whole-screen repaint, scrollback included, per text delta).
 */
import { liveRowBudget } from '../src/tui/App.js';
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
  liveTextView(short, 80, 10).rows.join('|') === 'one|two|three' &&
  liveTextView(short, 80, 10).hiddenRows === 0);

const long = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join('\n');
for (const maxRows of [4, 5, 8, 12, 24, 50]) {
  assert(`a 200-line answer fits ${maxRows} rows`, blockHeight(long, 80, maxRows) <= maxRows);
}
assert('below the four-row minimum the block stops shrinking instead of lying',
  blockHeight(long, 80, 2) === MINIMUM_LIVE_BLOCK_ROWS && blockHeight(long, 80, 0) === MINIMUM_LIVE_BLOCK_ROWS);
const tail = liveTextView(long, 80, 12);
assert('the tail is the newest rows, in order',
  tail.rows[tail.rows.length - 1] === 'line 200' &&
  tail.rows.join('|').includes('line 199|line 200'));
assert('everything dropped is counted', tail.hiddenRows + tail.rows.length === 200);
assert('the notice says how much scrolled out',
  hiddenRowsNotice(tail.hiddenRows).includes(String(tail.hiddenRows)));
assert('one hidden row is singular', hiddenRowsNotice(1) === '… 1 earlier line scrolled out of the live view');

const wrapped = 'x'.repeat(4000);
assert('one enormous unbroken paragraph is bounded too — the common streaming case',
  blockHeight(wrapped, 80, 10) <= 10 && liveTextView(wrapped, 80, 10).hiddenRows > 0);
assert('a narrow terminal is still bounded', blockHeight(long, 4, 6) <= 6);

header('live text — the row budget');
assert('the budget is the viewport minus the measured chrome, minus a spare row',
  liveRowBudget(50, 14) === 35);
assert('an unmeasured first frame assumes chrome rather than guessing low',
  liveRowBudget(50, undefined) === 35);
assert('chrome taller than the terminal still leaves the newest lines visible',
  liveRowBudget(10, 40) === MINIMUM_LIVE_BLOCK_ROWS);
assert('the budget never goes negative', liveRowBudget(1, 1) === MINIMUM_LIVE_BLOCK_ROWS);

report();
