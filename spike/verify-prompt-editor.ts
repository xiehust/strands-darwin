import { strict as nodeAssert } from 'node:assert';

import {
  backspaceAtCursor,
  cellWidth,
  cursorFromClick,
  deleteAtCursor,
  insertAtCursor,
  layoutEditor,
  moveHorizontal,
  moveToRowEdge,
  moveVertical,
  type EditorValue,
} from '../src/tui/prompt-editor.js';
import { assert, header, report } from './shared.js';

function check(what: string, assertion: () => void): void {
  try {
    assertion();
    assert(what, true);
  } catch (error) {
    assert(what, false);
    throw error;
  }
}

const atEnd = (text: string): EditorValue => ({
  text,
  cursor: { offset: text.length, affinity: 'upstream' },
});

header('prompt editor — insertion and deletion');
let value = insertAtCursor({ text: 'ac', cursor: { offset: 1, affinity: 'downstream' } }, 'b');
check('text inserts at the cursor', () => {
  nodeAssert.deepEqual(value, { text: 'abc', cursor: { offset: 2, affinity: 'upstream' } });
});
value = backspaceAtCursor(value);
check('backspace removes the preceding grapheme', () => nodeAssert.equal(value.text, 'ac'));
value = deleteAtCursor({ text: 'abc', cursor: { offset: 1, affinity: 'downstream' } });
check('delete removes the following grapheme', () => nodeAssert.equal(value.text, 'ac'));

const family = '👩‍👩‍👧‍👦';
value = backspaceAtCursor(atEnd(`a${family}`));
check('backspace treats a joined emoji as one grapheme', () => {
  nodeAssert.deepEqual(value, { text: 'a', cursor: { offset: 1, affinity: 'downstream' } });
});
value = deleteAtCursor({ text: `e\u0301x`, cursor: { offset: 0, affinity: 'downstream' } });
check('delete treats a combining sequence as one grapheme', () => nodeAssert.equal(value.text, 'x'));
check('horizontal movement cannot enter a joined emoji', () => {
  const cursor = atEnd(family).cursor;
  nodeAssert.equal(moveHorizontal(family, cursor, -1, layoutEditor(family, 20, cursor)).offset, 0);
});
check('insertion cannot leave the cursor inside a newly merged grapheme', () => {
  nodeAssert.deepEqual(
    insertAtCursor({ text: '\u0301x', cursor: { offset: 0, affinity: 'downstream' } }, 'e'),
    { text: 'e\u0301x', cursor: { offset: 2, affinity: 'upstream' } },
  );
});

header('prompt editor — cells and wrapping');
check('cell widths cover ASCII, CJK, emoji, combining, and joined emoji', () => {
  nodeAssert.equal(cellWidth('a'), 1);
  nodeAssert.equal(cellWidth('界'), 2);
  nodeAssert.equal(cellWidth('🙂'), 2);
  nodeAssert.equal(cellWidth('©'), 1);
  nodeAssert.equal(cellWidth('©️'), 2);
  nodeAssert.equal(cellWidth('कि'), 2);
  nodeAssert.equal(cellWidth('ｶﾞ'), 2);
  nodeAssert.equal(cellWidth('e\u0301'), 1);
  nodeAssert.equal(cellWidth(family), 2);
});

const wrapped = layoutEditor('abcdef', 10, { offset: 4, affinity: 'downstream' });
check('long logical lines wrap into visual rows', () => {
  nodeAssert.deepEqual(wrapped.rows.map((row) => [row.prefix, row.text]), [
    ['you> ', 'abcd'],
    ['     ', 'ef'],
  ]);
  nodeAssert.deepEqual(wrapped.cursor, { row: 1, column: 5 });
});
check('terminal resize recomputes visual rows and cursor geometry', () => {
  const wide = layoutEditor('abcdef', 20, { offset: 4, affinity: 'downstream' });
  nodeAssert.equal(wide.rows.length, 1);
  nodeAssert.deepEqual(wide.cursor, { row: 0, column: 9 });
  nodeAssert.equal(wrapped.rows.length, 2);
  nodeAssert.deepEqual(wrapped.cursor, { row: 1, column: 5 });
});
check('home and end use visual row boundaries', () => {
  nodeAssert.deepEqual(moveToRowEdge(wrapped, 'start'), { offset: 4, affinity: 'downstream' });
  nodeAssert.deepEqual(moveToRowEdge(wrapped, 'end'), { offset: 6, affinity: 'upstream' });
});
check('left and right traverse both caret sides of a soft wrap', () => {
  const upstream = { offset: 4, affinity: 'upstream' } as const;
  const downstream = { offset: 4, affinity: 'downstream' } as const;
  nodeAssert.deepEqual(moveHorizontal('abcdef', upstream, 1, layoutEditor('abcdef', 10, upstream)), downstream);
  nodeAssert.deepEqual(moveHorizontal('abcdef', downstream, -1, layoutEditor('abcdef', 10, downstream)), upstream);
});

const multiline = layoutEditor('abcd\nx', 20, atEnd('abcd\nx').cursor);
check('explicit newlines retain prompt prefixes', () => {
  nodeAssert.deepEqual(multiline.rows.map((row) => [row.prefix, row.text]), [
    ['you> ', 'abcd'],
    ['...> ', 'x'],
  ]);
});
check('vertical movement clamps to the nearest adjacent-row column', () => {
  const up = moveVertical(multiline, -1);
  nodeAssert.equal(up.cursor.offset, 1);
  const down = moveVertical(layoutEditor('abcd\nx', 20, { offset: 3, affinity: 'downstream' }), 1);
  nodeAssert.equal(down.cursor.offset, 6);
});

header('prompt editor — click hit testing');
const clickLayout = layoutEditor('a界b', 20, atEnd('a界b').cursor);
check('clicks map to nearest valid wide-character boundary', () => {
  nodeAssert.deepEqual(cursorFromClick(clickLayout, 0, 5), { offset: 0, affinity: 'downstream' });
  nodeAssert.deepEqual(cursorFromClick(clickLayout, 0, 6), { offset: 1, affinity: 'downstream' });
  nodeAssert.deepEqual(cursorFromClick(clickLayout, 0, 7), { offset: 1, affinity: 'downstream' });
  nodeAssert.deepEqual(cursorFromClick(clickLayout, 0, 9), { offset: 3, affinity: 'upstream' });
});
check('clicks outside visual input rows are ignored', () => {
  nodeAssert.equal(cursorFromClick(clickLayout, 2, 5), undefined);
});

const tabs = layoutEditor('a\tb', 20, atEnd('a\tb').cursor);
check('tabs render with stable hit-test width', () => {
  nodeAssert.equal(tabs.rows[0]?.text, 'a    b');
  nodeAssert.equal(tabs.rows[0]?.width, 6);
});

report();
