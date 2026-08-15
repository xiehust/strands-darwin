import { strict as nodeAssert } from 'node:assert';

import {
  backspaceAtCursor,
  cellWidth,
  deleteAtCursor,
  deleteWordBefore,
  insertAtCursor,
  killToRowEdge,
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

const tabs = layoutEditor('a\tb', 20, atEnd('a\tb').cursor);
check('tabs render with stable hit-test width', () => {
  nodeAssert.equal(tabs.rows[0]?.text, 'a    b');
  nodeAssert.equal(tabs.rows[0]?.width, 6);
});

header('prompt editor — readline chords (kill and word delete)');
const kill = (text: string, offset: number, edge: 'start' | 'end', columns = 40): EditorValue => {
  const cursor = { offset, affinity: 'downstream' } as const;
  return killToRowEdge({ text, cursor }, layoutEditor(text, columns, cursor), edge);
};
check('ctrl+k kills from the cursor to the end of the line', () => {
  nodeAssert.deepEqual(kill('alpha beta', 5, 'end'), {
    text: 'alpha',
    cursor: { offset: 5, affinity: 'upstream' },
  });
});
check('ctrl+u kills from the start of the line to the cursor', () => {
  nodeAssert.deepEqual(kill('alpha beta', 6, 'start'), {
    text: 'beta',
    cursor: { offset: 0, affinity: 'downstream' },
  });
});
check('kills stop at an explicit newline, never crossing it', () => {
  nodeAssert.equal(kill('abcd\nx', 2, 'end').text, 'ab\nx');
  nodeAssert.equal(kill('abcd\nx', 6, 'start').text, 'abcd\n');
});
check('kills are scoped to the visual row at a soft wrap', () => {
  // 'abcdef' at 10 columns wraps as 'abcd' / 'ef'; offset 5 sits on the second row.
  nodeAssert.equal(kill('abcdef', 5, 'end', 10).text, 'abcde');
  nodeAssert.equal(kill('abcdef', 5, 'start', 10).text, 'abcdf');
});
check('a kill at its own edge is a no-op', () => {
  nodeAssert.equal(kill('alpha', 5, 'end').text, 'alpha');
  nodeAssert.equal(kill('alpha', 0, 'start').text, 'alpha');
  nodeAssert.equal(kill('', 0, 'end').text, '');
});
check('a killed joined emoji goes whole, never split', () => {
  const text = `ab ${family}${family}`;
  nodeAssert.equal(kill(text, 3, 'end').text, 'ab ');
});

const wordDelete = (text: string, offset?: number): EditorValue =>
  deleteWordBefore({ text, cursor: { offset: offset ?? text.length, affinity: 'upstream' } });
check('ctrl+w deletes the whitespace-delimited word before the cursor', () => {
  nodeAssert.deepEqual(wordDelete('alpha beta'), {
    text: 'alpha ',
    cursor: { offset: 6, affinity: 'downstream' },
  });
});
check('ctrl+w consumes trailing whitespace before the word', () => {
  nodeAssert.equal(wordDelete('alpha beta   ').text, 'alpha ');
});
check('ctrl+w mid-word deletes only up to the cursor', () => {
  nodeAssert.deepEqual(wordDelete('alpha beta', 8), {
    text: 'alpha ta',
    cursor: { offset: 6, affinity: 'downstream' },
  });
});
check('ctrl+w crosses a newline like any other whitespace', () => {
  nodeAssert.equal(wordDelete('alpha\nbeta\n').text, 'alpha\n');
});
check('ctrl+w treats joined emoji and combining sequences as word graphemes', () => {
  nodeAssert.equal(wordDelete(`ok ${family}e\u0301`).text, 'ok ');
});
check('ctrl+w on an empty draft or at offset 0 is a no-op', () => {
  nodeAssert.equal(wordDelete('').text, '');
  nodeAssert.equal(wordDelete('alpha', 0).text, 'alpha');
});
check('ctrl+w on pure whitespace deletes all of it', () => {
  nodeAssert.equal(wordDelete('   ').text, '');
});

report();
