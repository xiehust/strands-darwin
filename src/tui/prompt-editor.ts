const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const rgiEmoji = new RegExp('^\\p{RGI_Emoji}$', 'v');
const leadingNonPrinting = new RegExp('^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Nonspacing_Mark}\\p{Enclosing_Mark}\\p{Surrogate}]+', 'v');
const spacingMark = new RegExp('\\p{Spacing_Mark}', 'v');

export type CursorAffinity = 'upstream' | 'downstream';

export interface EditorCursor {
  /** UTF-16 source offset, always snapped to a grapheme boundary. */
  offset: number;
  /** Which visual side owns an offset shared by two soft-wrapped rows. */
  affinity: CursorAffinity;
}

interface Boundary {
  offset: number;
  column: number;
}

export interface VisualRow {
  text: string;
  prefix: 'you> ' | '...> ' | '     ';
  start: number;
  end: number;
  width: number;
  boundaries: readonly Boundary[];
}

export interface EditorLayout {
  rows: readonly VisualRow[];
  cursor: { row: number; column: number };
}

export interface EditorValue {
  text: string;
  cursor: EditorCursor;
}

interface Grapheme {
  text: string;
  display: string;
  start: number;
  end: number;
  width: number;
}

const PROMPT_WIDTH = 5;

/**
 * Builds the exact visual rows used by the prompt renderer.
 *
 * One cell is reserved at the terminal's right edge. A real terminal cursor
 * cannot sit at `x === columns`, and writing there makes terminals disagree on
 * whether wrapping happens immediately or on the next character.
 */
export function layoutEditor(text: string, columns: number, cursor: EditorCursor): EditorLayout {
  const contentWidth = Math.max(1, columns - PROMPT_WIDTH - 1);
  const rows: VisualRow[] = [];
  let logicalStart = 0;
  let logicalIndex = 0;

  for (;;) {
    const newline = text.indexOf('\n', logicalStart);
    const logicalEnd = newline === -1 ? text.length : newline;
    const graphemes = segment(text.slice(logicalStart, logicalEnd), logicalStart);
    appendLogicalRows(rows, graphemes, logicalStart, logicalEnd, logicalIndex, contentWidth);
    logicalIndex += 1;
    if (newline === -1) break;
    logicalStart = newline + 1;
  }

  const safeCursor = snapCursor(text, cursor);
  const rowIndex = findCursorRow(rows, safeCursor);
  const row = rows[rowIndex] as VisualRow;
  const boundary = nearestOffsetBoundary(row.boundaries, safeCursor.offset);

  return {
    rows,
    cursor: { row: rowIndex, column: PROMPT_WIDTH + boundary.column },
  };
}

export function insertAtCursor(value: EditorValue, inserted: string): EditorValue {
  const cursor = snapCursor(value.text, value.cursor);
  const text = value.text.slice(0, cursor.offset) + inserted + value.text.slice(cursor.offset);
  const desiredOffset = cursor.offset + inserted.length;
  const boundaries = sourceBoundaries(text);
  const offset = boundaries.find((boundary) => boundary >= desiredOffset) ?? text.length;
  return {
    text,
    // Insertion can merge with a combining-mark/ZWJ suffix. In that case there
    // is no boundary at desiredOffset, so keep the cursor after the merged
    // grapheme rather than leaving it inside one (or making it jump backward).
    cursor: { offset, affinity: 'upstream' },
  };
}

export function backspaceAtCursor(value: EditorValue): EditorValue {
  const cursor = snapCursor(value.text, value.cursor);
  if (cursor.offset === 0) return { ...value, cursor };
  const previous = previousBoundary(value.text, cursor.offset);
  return {
    text: value.text.slice(0, previous) + value.text.slice(cursor.offset),
    cursor: { offset: previous, affinity: 'downstream' },
  };
}

export function deleteAtCursor(value: EditorValue): EditorValue {
  const cursor = snapCursor(value.text, value.cursor);
  if (cursor.offset === value.text.length) return { ...value, cursor };
  const next = nextBoundary(value.text, cursor.offset);
  return {
    text: value.text.slice(0, cursor.offset) + value.text.slice(next),
    cursor: { offset: cursor.offset, affinity: 'downstream' },
  };
}

export function moveHorizontal(
  text: string,
  cursor: EditorCursor,
  direction: -1 | 1,
  layout: EditorLayout,
): EditorCursor {
  const safe = snapCursor(text, cursor);
  // A soft wrap gives one source offset two visual caret positions. Traverse that
  // visual boundary before advancing to another grapheme.
  const shared = layout.rows.some((row, index) => row.end === safe.offset && layout.rows[index + 1]?.start === safe.offset);
  if (shared && direction < 0 && safe.affinity === 'downstream') {
    return { offset: safe.offset, affinity: 'upstream' };
  }
  if (shared && direction > 0 && safe.affinity === 'upstream') {
    return { offset: safe.offset, affinity: 'downstream' };
  }
  return direction < 0
    ? { offset: previousBoundary(text, safe.offset), affinity: 'downstream' }
    : { offset: nextBoundary(text, safe.offset), affinity: 'upstream' };
}

export function moveToRowEdge(layout: EditorLayout, edge: 'start' | 'end'): EditorCursor {
  const row = layout.rows[layout.cursor.row] as VisualRow;
  return edge === 'start'
    ? { offset: row.start, affinity: 'downstream' }
    : { offset: row.end, affinity: 'upstream' };
}

export function moveVertical(
  layout: EditorLayout,
  direction: -1 | 1,
  preferredColumn?: number,
): { cursor: EditorCursor; preferredColumn: number } {
  const desired = preferredColumn ?? Math.max(0, layout.cursor.column - PROMPT_WIDTH);
  const targetIndex = Math.max(0, Math.min(layout.rows.length - 1, layout.cursor.row + direction));
  return {
    cursor: cursorAtColumn(layout.rows[targetIndex] as VisualRow, desired),
    preferredColumn: desired,
  };
}

export function snapCursor(text: string, cursor: EditorCursor): EditorCursor {
  const offset = Math.max(0, Math.min(text.length, cursor.offset));
  const boundaries = sourceBoundaries(text);
  let snapped = 0;
  for (const boundary of boundaries) {
    if (boundary > offset) break;
    snapped = boundary;
  }
  return { offset: snapped, affinity: cursor.affinity };
}

function appendLogicalRows(
  output: VisualRow[],
  graphemes: readonly Grapheme[],
  logicalStart: number,
  logicalEnd: number,
  logicalIndex: number,
  contentWidth: number,
): void {
  if (graphemes.length === 0) {
    output.push(makeRow([], logicalStart, logicalEnd, logicalIndex === 0 ? 'you> ' : '...> '));
    return;
  }

  let row: Grapheme[] = [];
  let width = 0;
  let continuation = false;

  for (const grapheme of graphemes) {
    if (row.length > 0 && width + grapheme.width > contentWidth) {
      output.push(makeRow(row, row[0]!.start, row[row.length - 1]!.end, continuation ? '     ' : logicalIndex === 0 ? 'you> ' : '...> '));
      row = [];
      width = 0;
      continuation = true;
    }
    row.push(grapheme);
    width += grapheme.width;
  }

  output.push(makeRow(row, row[0]!.start, logicalEnd, continuation ? '     ' : logicalIndex === 0 ? 'you> ' : '...> '));
}

function makeRow(graphemes: readonly Grapheme[], start: number, end: number, prefix: VisualRow['prefix']): VisualRow {
  const boundaries: Boundary[] = [{ offset: start, column: 0 }];
  let column = 0;
  for (const grapheme of graphemes) {
    column += grapheme.width;
    boundaries.push({ offset: grapheme.end, column });
  }
  return {
    text: graphemes.map((grapheme) => grapheme.display).join(''),
    prefix,
    start,
    end,
    width: column,
    boundaries,
  };
}

function findCursorRow(rows: readonly VisualRow[], cursor: EditorCursor): number {
  const exactStarts = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.start === cursor.offset);
  const exactEnds = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.end === cursor.offset);

  if (cursor.affinity === 'downstream' && exactStarts.length > 0) return exactStarts[exactStarts.length - 1]!.index;
  if (cursor.affinity === 'upstream' && exactEnds.length > 0) return exactEnds[0]!.index;

  const containing = rows.findIndex((row) => cursor.offset >= row.start && cursor.offset <= row.end);
  return containing === -1 ? rows.length - 1 : containing;
}

function cursorAtColumn(row: VisualRow, requested: number): EditorCursor {
  const column = Math.max(0, requested);
  let best = row.boundaries[0] as Boundary;
  for (const boundary of row.boundaries) {
    if (Math.abs(boundary.column - column) < Math.abs(best.column - column)) best = boundary;
  }
  const affinity: CursorAffinity = best.offset === row.end ? 'upstream' : 'downstream';
  return { offset: best.offset, affinity };
}

function nearestOffsetBoundary(boundaries: readonly Boundary[], offset: number): Boundary {
  let best = boundaries[0] as Boundary;
  for (const boundary of boundaries) {
    if (Math.abs(boundary.offset - offset) < Math.abs(best.offset - offset)) best = boundary;
  }
  return best;
}

function previousBoundary(text: string, offset: number): number {
  let previous = 0;
  for (const boundary of sourceBoundaries(text)) {
    if (boundary >= offset) break;
    previous = boundary;
  }
  return previous;
}

function nextBoundary(text: string, offset: number): number {
  for (const boundary of sourceBoundaries(text)) {
    if (boundary > offset) return boundary;
  }
  return text.length;
}

function sourceBoundaries(text: string): number[] {
  const boundaries = [0];
  for (const part of segmenter.segment(text)) boundaries.push(part.index + part.segment.length);
  return boundaries;
}

function segment(text: string, sourceStart: number): Grapheme[] {
  return [...segmenter.segment(text)].map((part) => {
    // Ink/string-width intentionally gives a tab zero width. Render a visible
    // fixed tab stop so source offsets and hit-testing still have a real cell.
    const display = part.segment === '\t' ? '    ' : part.segment;
    return {
      text: part.segment,
      display,
      start: sourceStart + part.index,
      end: sourceStart + part.index + part.segment.length,
      width: part.segment === '\t' ? 4 : cellWidth(part.segment),
    };
  });
}

/** A dependency-free subset of the same Unicode terminal-width rules Ink uses. */
export function cellWidth(grapheme: string): number {
  if (grapheme === '\t' || /^(?:\p{Control}|\p{Mark}|\p{Default_Ignorable_Code_Point})+$/u.test(grapheme)) return 0;
  if (isEmojiPresentation(grapheme) || /\p{Extended_Pictographic}.*\u200d.*\p{Extended_Pictographic}/u.test(grapheme) || /^[\d#*].*\u20e3$/u.test(grapheme)) return 2;
  const visible = grapheme.replace(leadingNonPrinting, '');
  const codePoint = visible.codePointAt(0);
  if (codePoint === undefined) return 0;

  let width = isFullwidth(codePoint) ? 2 : 1;
  let first = true;
  for (const character of visible) {
    if (first) {
      first = false;
      continue;
    }
    if (spacingMark.test(character) || (character >= '\uff00' && character <= '\uffef')) {
      width += isFullwidth(character.codePointAt(0) as number) ? 2 : 1;
    }
  }
  return width;
}

function isEmojiPresentation(grapheme: string): boolean {
  return rgiEmoji.test(grapheme);
}

function isFullwidth(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}
