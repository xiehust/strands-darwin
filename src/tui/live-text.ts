/**
 * How much of a still-arriving answer the live frame is allowed to show.
 *
 * Ink repaints the live (non-`<Static>`) region by erasing the lines it wrote
 * last time — but only while that region fits the terminal. As soon as the frame
 * is taller than the viewport, `shouldClearTerminalForFrame()` in `ink/ink.js`
 * takes over and each render writes `clearTerminal + the whole static transcript`
 * straight to stdout, bypassing the throttled log. At text-delta rate that is the
 * flicker a long answer produces, and `clearTerminal` erases the scrollback with
 * it, so the transcript scrolled away too. Measured in
 * `spike/probe-live-frame-overflow.tsx`: 43 whole-screen clears for a 60-line
 * answer in a 24-row terminal, 0 once the region is bounded.
 *
 * So the streaming text is shown as a *tail*: the newest rows that fit, with a
 * count of what scrolled out. Nothing is lost — the assembled block still enters
 * `<Static>` history in full when it closes (`turn-state.ts`), which is the one
 * write that may safely be taller than the screen.
 *
 * The wrapping is done here rather than by Ink because the row count has to be
 * exact: the caller renders one `<Text wrap="truncate-end">` per row, so the
 * block's height is what this module says it is and cannot grow under Ink's own
 * word wrap.
 */
import { cellWidth } from './prompt-editor.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The `agent` label above the text and the blank row below it. */
const LABEL_AND_MARGIN_ROWS = 2;

/**
 * Shortest block this can draw: the label, one row of answer, the notice that
 * says rows are missing, and the bottom margin. A budget below it is not a fit
 * but a floor — a frame with less room to spare than this has already lost to
 * its own furniture.
 */
export const MINIMUM_LIVE_BLOCK_ROWS = LABEL_AND_MARGIN_ROWS + 2;

/** Same visible tab stop the prompt editor uses, so row widths stay honest. */
const TAB = '    ';

export interface LiveTextView {
  /** Rows to draw, already wrapped to the terminal width, oldest first. */
  readonly rows: readonly string[];
  /** Wrapped rows dropped off the top; `0` when the whole answer fits. */
  readonly hiddenRows: number;
}

const EMPTY: LiveTextView = { rows: [], hiddenRows: 0 };

/**
 * The tail of `text` that fits `maxRows` terminal rows.
 *
 * `maxRows` covers the whole block the caller draws — the `agent` label, its
 * bottom margin, and the "scrolled out" notice — not just the text, because the
 * budget it comes from is a slice of the viewport, and a label that overflows
 * costs exactly as much as a line of answer would.
 */
export function liveTextView(text: string, columns: number, maxRows: number): LiveTextView {
  if (text === '') return EMPTY;

  const rows = wrapToRows(text, columns);
  const budget = Math.max(1, maxRows - LABEL_AND_MARGIN_ROWS);
  if (rows.length <= budget) return { rows, hiddenRows: 0 };

  // One row of the budget pays for the notice that says rows are missing: a tail
  // that silently starts mid-sentence reads as lost output.
  const kept = Math.max(1, budget - 1);
  return { rows: rows.slice(rows.length - kept), hiddenRows: rows.length - kept };
}

/** One line of prose about the rows that no longer fit. */
export function hiddenRowsNotice(hiddenRows: number): string {
  return `… ${hiddenRows} earlier line${hiddenRows === 1 ? '' : 's'} scrolled out of the live view`;
}

/**
 * Wraps `text` into terminal rows the way the live block draws them.
 *
 * The last column is left empty: terminals disagree about whether writing the
 * final cell wraps immediately or on the next character, and a row that wraps
 * on its own is a row Ink did not count.
 */
export function wrapToRows(text: string, columns: number): readonly string[] {
  const width = Math.max(1, columns - 1);
  const rows: string[] = [];
  for (const line of text.split('\n')) rows.push(...wrapLine(line.replaceAll('\t', TAB), width));
  return rows;
}

/**
 * Greedy word wrap, falling back to a grapheme break for a word wider than the
 * terminal. An empty logical line stays one row: it is a paragraph break, and
 * dropping it would move the text under the cursor as the answer arrives.
 */
function wrapLine(line: string, width: number): string[] {
  const rows: string[] = [];
  let row = '';
  let rowWidth = 0;
  /** True once this row exists only because a wrap started it. */
  let wrapped = false;

  const flush = (): void => {
    // A space that survived to the end of a row is invisible but still cost a
    // cell, which is how a wrapped row ends up one column wider than the width.
    rows.push(row.replace(/\s+$/u, ''));
    row = '';
    rowWidth = 0;
    wrapped = true;
  };

  for (const token of line.match(/\s+|\S+/gu) ?? []) {
    const tokenWidth = textWidth(token);

    if (/^\s/u.test(token)) {
      // Runs of spaces are dropped at a wrap point, but kept at the start of a
      // logical line: that indentation is the shape of the code being printed.
      if (rowWidth === 0 && wrapped) continue;
      if (rowWidth + tokenWidth > width) {
        flush();
        continue;
      }
      row += token;
      rowWidth += tokenWidth;
      continue;
    }

    if (rowWidth > 0 && rowWidth + tokenWidth > width) flush();
    if (tokenWidth <= width) {
      row += token;
      rowWidth += tokenWidth;
      continue;
    }

    // A single token wider than the terminal — a path, a URL, a base64 blob.
    for (const { segment } of segmenter.segment(token)) {
      const graphemeWidth = cellWidth(segment);
      if (rowWidth > 0 && rowWidth + graphemeWidth > width) flush();
      row += segment;
      rowWidth += graphemeWidth;
    }
  }

  rows.push(row);
  return rows;
}

function textWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) width += cellWidth(segment);
  return width;
}
