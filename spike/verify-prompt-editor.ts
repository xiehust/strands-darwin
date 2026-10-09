import { strict as nodeAssert } from 'node:assert';

import {
  backspaceAtCursor,
  cellWidth,
  deleteAtCursor,
  deleteWordAfter,
  deleteWordBefore,
  insertAtCursor,
  killToRowEdge,
  layoutEditor,
  moveHorizontal,
  moveToDraftEdge,
  moveToRowEdge,
  moveVertical,
  moveWordHorizontal,
  popUndo,
  pushUndo,
  UNDO_CAP,
  LAST_CUT_CAP,
  LAST_CUT_OVERFLOW_NOTICE,
  updateLastCut,
  type EditorValue,
  type EditorDeletion,
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
check('whole-draft edges preserve raw UTF-16 offsets and outward grapheme-safe affinity', () => {
  for (const text of ['', 'a👩‍💻e\u0301\nb']) {
    nodeAssert.deepEqual(moveToDraftEdge(text, 'start'), { offset: 0, affinity: 'downstream' });
    nodeAssert.deepEqual(moveToDraftEdge(text, 'end'), { offset: text.length, affinity: 'upstream' });
    for (const columns of [10, 70]) {
      const beginning = moveToDraftEdge(text, 'start');
      const ending = moveToDraftEdge(text, 'end');
      nodeAssert.equal(layoutEditor(text, columns, beginning).cursor.row, 0);
      nodeAssert.equal(layoutEditor(text, columns, ending).cursor.row, layoutEditor(text, columns, ending).rows.length - 1);
    }
  }
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
  return killToRowEdge({ text, cursor }, layoutEditor(text, columns, cursor), edge).value;
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
  deleteWordBefore({ text, cursor: { offset: offset ?? text.length, affinity: 'upstream' } }).value;
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

header('prompt editor — word navigation and forward word delete');
const wordLeft = (text: string, offset: number): number =>
  moveWordHorizontal(text, { offset, affinity: 'upstream' }, -1).offset;
const wordRight = (text: string, offset: number): number =>
  moveWordHorizontal(text, { offset, affinity: 'downstream' }, 1).offset;
check('word left jumps to the start of the previous ASCII word', () => {
  nodeAssert.deepEqual(
    moveWordHorizontal('alpha beta', { offset: 10, affinity: 'upstream' }, -1),
    { offset: 6, affinity: 'downstream' },
  );
  nodeAssert.equal(wordLeft('alpha beta', 6), 0);
});
check('word right jumps to the end of the next ASCII word', () => {
  nodeAssert.deepEqual(
    moveWordHorizontal('alpha beta', { offset: 0, affinity: 'downstream' }, 1),
    { offset: 5, affinity: 'upstream' },
  );
  nodeAssert.equal(wordRight('alpha beta', 5), 10);
});
check('a punctuation run is one whitespace-delimited word, matching ctrl+w', () => {
  nodeAssert.equal(wordLeft('run --flag=value now', 17), 4);
  nodeAssert.equal(wordRight('run --flag=value now', 3), 16);
});
check('word jumps consume a whole whitespace run', () => {
  nodeAssert.equal(wordLeft('a   b', 4), 0);
  nodeAssert.equal(wordRight('a   b', 1), 5);
});
check('word jumps land on grapheme boundaries around joined emoji', () => {
  const text = `${family} ok`;
  nodeAssert.equal(wordLeft(text, text.length), family.length + 1);
  nodeAssert.equal(wordLeft(text, family.length + 1), 0);
  nodeAssert.equal(wordRight(text, 0), family.length);
});
check('word jumps treat a CJK run as one word', () => {
  nodeAssert.equal(wordLeft('你好 世界', 5), 3);
  nodeAssert.equal(wordLeft('你好 世界', 3), 0);
  nodeAssert.equal(wordRight('你好 世界', 2), 5);
});
check('word jumps cross a newline like any other whitespace', () => {
  nodeAssert.equal(wordLeft('alpha\nbeta', 6), 0);
  nodeAssert.equal(wordRight('alpha\nbeta', 5), 10);
});
check('word jumps at the edges of the text are no-ops', () => {
  nodeAssert.equal(wordLeft('alpha', 0), 0);
  nodeAssert.equal(wordRight('alpha', 5), 5);
  nodeAssert.equal(wordLeft('', 0), 0);
  nodeAssert.equal(wordRight('', 0), 0);
});

const wordDeleteAfter = (text: string, offset: number): EditorValue =>
  deleteWordAfter({ text, cursor: { offset, affinity: 'downstream' } }).value;
check('alt+d deletes the whitespace-delimited word after the cursor', () => {
  nodeAssert.deepEqual(wordDeleteAfter('alpha beta', 0), {
    text: ' beta',
    cursor: { offset: 0, affinity: 'downstream' },
  });
});
check('alt+d consumes leading whitespace before the word', () => {
  nodeAssert.equal(wordDeleteAfter('alpha   beta', 5).text, 'alpha');
});
check('alt+d mid-word deletes only from the cursor', () => {
  nodeAssert.deepEqual(wordDeleteAfter('alpha beta', 8), {
    text: 'alpha be',
    cursor: { offset: 8, affinity: 'downstream' },
  });
});
check('alt+d crosses a newline like any other whitespace', () => {
  nodeAssert.equal(wordDeleteAfter('alpha\nbeta', 5).text, 'alpha');
});
check('alt+d treats joined emoji and combining sequences as word graphemes', () => {
  nodeAssert.equal(wordDeleteAfter(`ok ${family}e\u0301`, 2).text, 'ok');
});
check('alt+d at the end of the text or on an empty draft is a no-op', () => {
  nodeAssert.equal(wordDeleteAfter('alpha', 5).text, 'alpha');
  nodeAssert.equal(wordDeleteAfter('', 0).text, '');
});
check('alt+d on pure whitespace deletes all of it', () => {
  nodeAssert.equal(wordDeleteAfter('   ', 0).text, '');
});

header('prompt editor — composer undo stack (SER-044)');
check('the cap is the specified 16', () => nodeAssert.equal(UNDO_CAP, 16));
check('destroy-then-undo restores text and cursor exactly for every covered chord', () => {
  const columns = 40;
  const chords: readonly ((value: EditorValue) => EditorDeletion)[] = [
    (value) => killToRowEdge(value, layoutEditor(value.text, columns, value.cursor), 'end'),
    (value) => killToRowEdge(value, layoutEditor(value.text, columns, value.cursor), 'start'),
    deleteWordBefore,
    deleteWordAfter,
  ];
  for (const chord of chords) {
    const before: EditorValue = { text: 'alpha beta\ngamma', cursor: { offset: 8, affinity: 'downstream' } };
    const after = chord(before);
    nodeAssert.notEqual(after.value.text, before.text);
    const stack = pushUndo([], before);
    const popped = popUndo(stack);
    nodeAssert.ok(popped !== undefined);
    nodeAssert.deepEqual(popped.value, before);
    nodeAssert.deepEqual(popped.stack, []);
  }
});
check('repeated undo walks further back, newest first', () => {
  const first = atEnd('one');
  const second = atEnd('one two');
  let stack = pushUndo(pushUndo([], first), second);
  let popped = popUndo(stack);
  nodeAssert.ok(popped !== undefined);
  nodeAssert.deepEqual(popped.value, second);
  stack = popped.stack;
  popped = popUndo(stack);
  nodeAssert.ok(popped !== undefined);
  nodeAssert.deepEqual(popped.value, first);
  nodeAssert.equal(popUndo(popped.stack), undefined);
});
check('pushing past the cap drops the oldest snapshot, never the newest', () => {
  let stack: readonly EditorValue[] = [];
  for (let i = 0; i <= UNDO_CAP; i += 1) stack = pushUndo(stack, atEnd(`draft ${i}`));
  nodeAssert.equal(stack.length, UNDO_CAP);
  nodeAssert.equal(stack[0]?.text, 'draft 1');
  nodeAssert.equal(stack[UNDO_CAP - 1]?.text, `draft ${UNDO_CAP}`);
});
check('undo on an empty stack is a harmless no-op', () => {
  nodeAssert.equal(popUndo([]), undefined);
});

header('prompt editor — last cut and yank (SER-084)');
const cutCases: readonly [string, number, (v: EditorValue) => EditorDeletion, string][] = [
  ['abcabcabc', 3, (v) => killToRowEdge(v, layoutEditor(v.text, 40, v.cursor), 'end'), 'abcabc'],
  ['abcabcabc', 6, (v) => killToRowEdge(v, layoutEditor(v.text, 40, v.cursor), 'start'), 'abcabc'],
  ['same same same', 7, deleteWordBefore, 'sa'],
  ['same same same', 7, deleteWordAfter, 'me'],
  ['alpha\nbeta\n', 11, deleteWordBefore, 'beta\n'],
  ['alpha\nbeta', 5, deleteWordAfter, '\nbeta'],
  [`ok ${family}e\u0301`, 3, deleteWordAfter, `${family}e\u0301`],
  [`ok ${family}e\u0301`, 3 + family.length + 2, deleteWordBefore, `${family}e\u0301`],
  ['abcdef', 5, (v) => killToRowEdge(v, layoutEditor(v.text, 10, v.cursor), 'start'), 'e'],
  ['abcdef', 5, (v) => killToRowEdge(v, layoutEditor(v.text, 10, v.cursor), 'end'), 'f'],
];
for (const [text, offset, edit, expected] of cutCases) {
  check(`exact cut and round trip: ${JSON.stringify(text)} at ${offset}, ${JSON.stringify(expected)}`, () => {
    const before = { text, cursor: { offset, affinity: 'downstream' as const } };
    const after = edit(before);
    const cut = updateLastCut('old', before, after);
    nodeAssert.deepEqual(cut, { text: expected, overflow: false });
    nodeAssert.equal(insertAtCursor(after.value, cut.text).text, before.text);
  });
}
check('movement and typing survive repeated yank; undo still restores the destroyed snapshot', () => {
  const before = atEnd('alpha beta');
  const after = deleteWordBefore(before);
  const cut = updateLastCut('', before, after).text;
  let moved = insertAtCursor({ ...after.value, cursor: { offset: 0, affinity: 'downstream' } }, 'X');
  moved = insertAtCursor(insertAtCursor(moved, cut), cut);
  nodeAssert.equal(moved.text, 'Xbetabetaalpha ');
  nodeAssert.deepEqual(popUndo(pushUndo([], before))?.value, before);
});
check('yank snaps an interior ZWJ cursor and advances past a newly merged combining grapheme', () => {
  const snapped = insertAtCursor({ text: `${family}x`, cursor: { offset: 2, affinity: 'downstream' } }, 'cut');
  nodeAssert.equal(snapped.text, `cut${family}x`);
  const merged = insertAtCursor({ text: '\u0301x', cursor: { offset: 0, affinity: 'downstream' } }, 'e');
  nodeAssert.deepEqual(merged, { text: 'e\u0301x', cursor: { offset: 2, affinity: 'upstream' } });
});
check('all no-op cuts retain the old register; nonempty cuts replace without coalescing', () => {
  for (const edit of [deleteWordBefore, deleteWordAfter,
    (v: EditorValue) => killToRowEdge(v, layoutEditor(v.text, 10, v.cursor), 'start'),
    (v: EditorValue) => killToRowEdge(v, layoutEditor(v.text, 10, v.cursor), 'end')]) {
    const empty = atEnd('');
    nodeAssert.deepEqual(updateLastCut('old', empty, edit(empty)), { text: 'old', overflow: false });
  }
  const before = atEnd('one two');
  const after = deleteWordBefore(before);
  const first = updateLastCut('old', before, after).text;
  nodeAssert.equal(updateLastCut(first, after.value, deleteWordBefore(after.value)).text, 'one ');
});
check('cap is code points: exact-cap astral cut survives; over-cap clears without truncating or losing undo', () => {
  nodeAssert.equal(LAST_CUT_CAP, 65_536);
  for (const count of [LAST_CUT_CAP, LAST_CUT_CAP + 1]) {
    const before = atEnd('🙂'.repeat(count));
    const after = deleteWordBefore(before);
    const forward = { ...before, cursor: { offset: 0, affinity: 'downstream' as const } };
    nodeAssert.deepEqual(deleteWordAfter(forward), after);
    nodeAssert.equal(after.value.text, '');
    const cut = updateLastCut('stale', before, after);
    nodeAssert.deepEqual(cut, count === LAST_CUT_CAP
      ? { text: before.text, overflow: false }
      : { text: '', overflow: true });
    nodeAssert.deepEqual(popUndo(pushUndo([], before))?.value, before);
  }
  nodeAssert.ok([...LAST_CUT_OVERFLOW_NOTICE].length < 160);
});

header('SER-118 — deletion merges: legal caret before rendering or the next edit');
// SER-118 pure checklist: M1 raw merges and following edits; M2 every deletion
// primitive/affinity; M3 exact span, cut/yank and original undo; M4 cap/no-op.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const boundariesOf = (text: string) => [0, ...[...segmenter.segment(text)].map((p) => p.index + p.segment.length)];
function mergedResult(before: EditorValue, after: EditorValue, start: number, end: number, offset: number, affinity: 'upstream' | 'downstream'): void {
  const text = before.text.slice(0, start) + before.text.slice(end);
  nodeAssert.deepEqual(after, { text, cursor: { offset, affinity } });
  nodeAssert.ok(boundariesOf(text).includes(after.cursor.offset), 'returned caret is legal without layout/snap');
  nodeAssert.equal(insertAtCursor(after, 'Z').text, text.slice(0, offset) + 'Z' + text.slice(offset));
  const boundaries = boundariesOf(text);
  const index = boundaries.indexOf(offset);
  const left = boundaries[Math.max(0, index - 1)]!;
  const right = boundaries[Math.min(boundaries.length - 1, index + 1)]!;
  const layout = layoutEditor(text, 100, after.cursor);
  nodeAssert.equal(moveHorizontal(text, after.cursor, -1, layout).offset, left);
  nodeAssert.equal(moveHorizontal(text, after.cursor, 1, layout).offset, right);
  nodeAssert.equal(backspaceAtCursor(after).text, text.slice(0, left) + text.slice(offset));
  nodeAssert.equal(deleteAtCursor(after).text, text.slice(0, offset) + text.slice(right));
  const moved = { text, cursor: moveHorizontal(text, after.cursor, -1, layout) };
  nodeAssert.equal(insertAtCursor(moved, 'Z').text, text.slice(0, left) + 'Z' + text.slice(left));
}
const merges: readonly [string, number, number, number][] = [
  ['e\n\u0301x', 1, 2, 2],
  ['e\r\n\u0301x', 1, 3, 2],
  ['e\n\u0301\u0308x', 1, 2, 3],
  ['🇦X🇧x', 2, 3, 4],
  ['🇦\r\n🇧x', 2, 4, 4],
  ['👩\n\u200d💻x', 2, 3, 5],
  ['👩\r\n\u200d💻x', 2, 4, 5],
  ['👩‍X💻x', 3, 4, 5],
  ['\rX\nx', 1, 2, 2],
];
for (const [text, start, end, offset] of merges) {
  check(`M1 exact raw merge and next edits: ${JSON.stringify(text)}`, () => {
    for (const affinity of ['upstream', 'downstream'] as const) {
      const backward = { text, cursor: { offset: end, affinity } };
      mergedResult(backward, backspaceAtCursor(backward), start, end, offset, 'downstream');
      const forward = { text, cursor: { offset: start, affinity } };
      mergedResult(forward, deleteAtCursor(forward), start, end, offset, 'downstream');
    }
  });
}

const destructiveMerges: readonly [string, number, (v: EditorValue) => EditorDeletion, number, number, number, 'upstream' | 'downstream'][] = [
  ['🇦X🇧x', 3, (v) => killToRowEdge(v, layoutEditor(v.text, 7, v.cursor), 'start'), 2, 3, 4, 'downstream'],
  ['🇦X🇧x', 2, (v) => killToRowEdge(v, layoutEditor(v.text, 7, v.cursor), 'end'), 2, 3, 4, 'upstream'],
  ['👩‍X💻x', 4, (v) => killToRowEdge(v, layoutEditor(v.text, 7, v.cursor), 'start'), 3, 4, 5, 'downstream'],
  ['👩‍X💻x', 3, (v) => killToRowEdge(v, layoutEditor(v.text, 7, v.cursor), 'end'), 3, 4, 5, 'upstream'],
  ['\rX\nx', 2, deleteWordBefore, 1, 2, 2, 'downstream'],
  ['\rX\nx', 1, deleteWordAfter, 1, 2, 2, 'downstream'],
];
for (const [text, offset, edit, start, end, repaired, affinity] of destructiveMerges) {
  check(`M2/M3 exact destructive span and legal caret: ${JSON.stringify(text)} at ${offset}`, () => {
    // Row start at its soft-wrapped end belongs upstream; row end at its
    // soft-wrapped start belongs downstream. Word deletes exercise both sides.
    const sides = text.startsWith('\r') ? ['upstream', 'downstream'] as const :
      [affinity === 'downstream' ? 'upstream' : 'downstream'] as const;
    for (const side of sides) {
      const before = { text, cursor: { offset, affinity: side } };
      const deletion = edit(before);
      nodeAssert.deepEqual(deletion.span, { start, end });
      mergedResult(before, deletion.value, start, end, repaired, affinity);
      const cut = updateLastCut('stale', before, deletion);
      nodeAssert.deepEqual(cut, { text: 'X', overflow: false });
      const once = insertAtCursor(deletion.value, cut.text);
      const twice = insertAtCursor(once, cut.text);
      const merged = deletion.value.text;
      nodeAssert.equal(once.text, merged.slice(0, repaired) + 'X' + merged.slice(repaired));
      nodeAssert.equal(twice.text, merged.slice(0, repaired) + 'XX' + merged.slice(repaired));
      // Yank inserts at the repaired caret, not the old splice; undo alone
      // restores the original destroyed draft, including its old affinity.
      nodeAssert.deepEqual(popUndo(pushUndo([], before))?.value, before);
      nodeAssert.deepEqual(before, { text, cursor: { offset, affinity: side } });
    }
  });
}
check('M3 repeated text pins exact pre-edit span rather than a prefix/suffix guess', () => {
  const before = { text: 'abcabcabc', cursor: { offset: 6, affinity: 'upstream' as const } };
  const deletion = killToRowEdge(before, layoutEditor(before.text, 9, before.cursor), 'start');
  nodeAssert.deepEqual(deletion.span, { start: 3, end: 6 });
  nodeAssert.deepEqual(deletion.value, { text: 'abcabc', cursor: { offset: 3, affinity: 'downstream' } });
  nodeAssert.deepEqual(updateLastCut('old', before, deletion), { text: 'abc', overflow: false });
});

check('M4 all ordinary deletions preserve their prior offsets and affinities', () => {
  for (const affinity of ['upstream', 'downstream'] as const) {
    const before = { text: 'abc def', cursor: { offset: 5, affinity } };
    nodeAssert.deepEqual(backspaceAtCursor(before), { text: 'abc ef', cursor: { offset: 4, affinity: 'downstream' } });
    nodeAssert.deepEqual(deleteAtCursor(before), { text: 'abc df', cursor: { offset: 5, affinity: 'downstream' } });
    const cases: readonly [EditorDeletion, string, number, string, number, number][] = [
      [deleteWordBefore(before), 'abc ef', 4, 'downstream', 4, 5],
      [deleteWordAfter(before), 'abc d', 5, 'downstream', 5, 7],
      [killToRowEdge(before, layoutEditor(before.text, 40, before.cursor), 'start'), 'ef', 0, 'downstream', 0, 5],
      [killToRowEdge(before, layoutEditor(before.text, 40, before.cursor), 'end'), 'abc d', 5, 'upstream', 5, 7],
    ];
    for (const [deletion, text, offset, side, start, end] of cases) {
      nodeAssert.deepEqual(deletion.value, { text, cursor: { offset, affinity: side } });
      nodeAssert.deepEqual(deletion.span, { start, end });
    }
  }
});
check('M4 no-op deletes preserve both affinities, exact empty spans, cut and undo', () => {
  for (const text of ['', 'e\u0301', 'abc\r\nx']) {
    for (const affinity of ['upstream', 'downstream'] as const) {
      const start = { text, cursor: { offset: 0, affinity } };
      const end = { text, cursor: { offset: text.length, affinity } };
      nodeAssert.deepEqual(backspaceAtCursor(start), start);
      nodeAssert.deepEqual(deleteAtCursor(end), end);
      for (const [before, deletion] of [
        [start, deleteWordBefore(start)], [end, deleteWordAfter(end)],
        [start, killToRowEdge(start, layoutEditor(text, 40, start.cursor), 'start')],
        [end, killToRowEdge(end, layoutEditor(text, 40, end.cursor), 'end')],
      ] as const) {
        nodeAssert.deepEqual(deletion.value, before);
        nodeAssert.deepEqual(deletion.span, { start: before.cursor.offset, end: before.cursor.offset });
        nodeAssert.deepEqual(updateLastCut('old', before, deletion), { text: 'old', overflow: false });
        // Exactly App's destructive-only snapshot predicate: no-op uses no slot.
        nodeAssert.equal(deletion.value.text !== before.text, false);
      }
    }
  }
});
check('M4 no-op row kills preserve the visual side at shared soft-wrap offsets', () => {
  for (const [affinity, edge] of [['upstream', 'end'], ['downstream', 'start']] as const) {
    const before = { text: 'abcdef', cursor: { offset: 4, affinity } };
    const deletion = killToRowEdge(before, layoutEditor(before.text, 10, before.cursor), edge);
    nodeAssert.deepEqual(deletion.value, before);
    nodeAssert.deepEqual(deletion.span, { start: 4, end: 4 });
    nodeAssert.deepEqual(updateLastCut('old', before, deletion), { text: 'old', overflow: false });
  }
});
check('M4 repaired-caret cuts obey code-point cap, clearing overflow without losing the original snapshot', () => {
  for (const count of [LAST_CUT_CAP, LAST_CUT_CAP + 1]) {
    const text = '\r' + 'X'.repeat(count) + '\nx';
    for (const before of [
      { text, cursor: { offset: count + 1, affinity: 'upstream' as const } },
      { text, cursor: { offset: 1, affinity: 'downstream' as const } },
    ]) {
      const deletion = before.cursor.offset === 1 ? deleteWordAfter(before) : deleteWordBefore(before);
      nodeAssert.deepEqual(deletion.span, { start: 1, end: count + 1 });
      nodeAssert.deepEqual(deletion.value, { text: '\r\nx', cursor: { offset: 2, affinity: 'downstream' } });
      nodeAssert.deepEqual(updateLastCut('stale', before, deletion), count === LAST_CUT_CAP
        ? { text: 'X'.repeat(count), overflow: false } : { text: '', overflow: true });
      nodeAssert.deepEqual(popUndo(pushUndo([], before))?.value, before);
    }
  }
});

report();
