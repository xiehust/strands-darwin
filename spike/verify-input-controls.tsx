/** SER-100: real filenames, real Ink, raw source/cell mapping. No model or mocks.
 * C1 scan/identity/matching; C2 row grants/windows; C3 accepted editor mapping.
 * The companion verify-input-controls-pty.ts covers C4 real CLI acceptance/editing.
 */
import { strict as check } from 'node:assert';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToString, Text } from 'ink';
import { InputBox, MAX_COMPLETIONS, completionWindow, hiddenCompletionNotice } from '../src/tui/InputBox.js';
import { planPromptBox } from '../src/tui/frame-budget.js';
import { applyPathCompletion, matchWorkspacePaths, pathCompletionQuery, scanWorkspacePaths, MAX_SCAN_DEPTH } from '../src/tui/path-completion.js';
import { layoutEditor, cellWidth, moveHorizontal, moveVertical, moveToRowEdge, backspaceAtCursor, deleteAtCursor, insertAtCursor, killToRowEdge, pushUndo, popUndo, type EditorValue } from '../src/tui/prompt-editor.js';
import { searchPreview } from '../src/tui/search-preview.js';
import { SEARCH_PREVIEW_CASES } from './search-preview-checks.js';
import { assert, header, report } from './shared.js';

const plain = (text: string) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
const rowCount = (text: string) => text === '' ? 0 : text.split('\n').length;
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const atEnd = (text: string): EditorValue => ({ text, cursor: { offset: text.length, affinity: 'upstream' } });
const single = (text: string, columns: number) => plain(renderToString(<Text wrap="truncate-end">{text}</Text>, { columns }));
function input(text: string, columns: number, maxRows: number, completions: readonly string[] = [], selected = 0, kind: 'path' | 'command' = 'path'): string {
  return plain(renderToString(<InputBox layout={layoutEditor(text, columns, atEnd(text).cursor)}
    completions={completions} completionKind={kind} completionNote={undefined} selectedCompletion={selected}
    editable hint={undefined} recallIndicator={undefined} offset={{ top: 0, left: 0 }} maxRows={maxRows} />, { columns }));
}

header('SER-100 C1 — real hostile filenames remain raw through the bounded scan');
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-input-controls-'));
const names = SEARCH_PREVIEW_CASES.filter(({ name }) => name !== 'all C0 DEL C1')
  .map(({ raw }, index) => `case${index}-${Buffer.byteLength(raw) > 220 ? raw.replace('中文🧬'.repeat(25), '中文🧬'.repeat(10)) : raw}.txt`);
names.push('line\n'.repeat(12) + 'file.txt');
// NUL and / cannot be filename bytes on POSIX; every other C0, DEL and C1 can.
for (let code = 1; code <= 159; code += 1) {
  if (code >= 32 && code < 127) continue;
  names.push(`control${code}-${String.fromCharCode(code)}.txt`);
}
try {
  await Promise.all(names.map((name) => writeFile(path.join(root, name), 'NOT_FILE_CONTENT', { mode: 0o000 })));
  const directory = 'dir\u001b[31m\n/';
  await mkdir(path.join(root, directory));
  await mkdir(path.join(root, ...Array.from({ length: MAX_SCAN_DEPTH + 2 }, () => 'deep')), { recursive: true });
  const scan = await scanWorkspacePaths(root);
  check.equal(scan.truncated, true);
  check.deepEqual(scan.paths.filter((candidate) => names.includes(candidate)), [...names].sort((a, b) => a.localeCompare(b)));
  check.ok(scan.paths.includes(directory));
  check.deepEqual(matchWorkspacePaths(scan.paths, ''), scan.paths);
  for (const name of [...names, directory]) {
    check.ok(matchWorkspacePaths(scan.paths, name.split(/\s/)[0]!).includes(name));
    const value = { text: 'before @case suffix', cursor: { offset: 12, affinity: 'upstream' as const } };
    const inserted = name.endsWith('/') ? `@${name}` : `${name} `;
    const result = applyPathCompletion(value, pathCompletionQuery(value.text, value.cursor.offset)!, name);
    check.equal(result.text, `before ${inserted} suffix`);
    check.equal(result.cursor.offset, 7 + inserted.length);
  }
  check.ok(!scan.paths.join('').includes('NOT_FILE_CONTENT'));
  assert('all legal hostile names, raw ordering/matching and exact file/directory insertion survive a bounded scan', true);
} finally {
  await rm(root, { recursive: true, force: true });
}

header('SER-100 C2 — real InputBox completion rows fit their grants');
for (const columns of [24, 100]) {
  check.equal(rowCount(input('@', columns, 6, ['ordinary.txt'])), 4);
  check.equal(rowCount(input('@', columns, 6, ['line\n'.repeat(12) + 'file.txt'])), 4);
  for (const { name, raw, preview } of SEARCH_PREVIEW_CASES) {
    for (const kind of ['path', 'command'] as const) {
      const frame = input('@', columns, 6, [raw], 0, kind);
      check.equal(rowCount(frame), 4, `${name} ${kind} ${columns}`);
      check.ok(frame.includes(single(`❯ ${kind === 'command' ? '/' : ''}${preview}`, columns)));
      check.ok(!unsafe.test(frame.replaceAll('\n', '')));
    }
  }
  const candidates = Array.from({ length: MAX_COMPLETIONS + 9 }, (_, index) =>
    `${String(index).padStart(2, '0')}:${SEARCH_PREVIEW_CASES[index % SEARCH_PREVIEW_CASES.length]!.raw}`);
  for (const selected of [0, 16, candidates.length - 1]) {
    for (const maxRows of [0, 1, 2, 3, 4, 5, 6, 12, 50]) {
      const plan = planPromptBox({ maxRows, draftRows: 1, completions: MAX_COMPLETIONS, moreCompletions: true, hasHint: false });
      const menu = completionWindow(candidates.length, selected, plan.completionItems);
      const frame = input('@', columns, maxRows, candidates, selected);
      const expectedRows = (maxRows > 0 ? 1 : 0) + (plan.completionItems > 0 ? 2 + plan.completionItems + Number(plan.completionMore) : 0);
      check.equal(rowCount(frame), expectedRows, `grant ${maxRows} at ${columns}`);
      check.ok(rowCount(frame) <= maxRows);
      check.equal((frame.match(/❯/g) ?? []).length, plan.completionItems > 0 ? 1 : 0);
      for (let index = menu.start; index < menu.end; index += 1) {
        check.ok(frame.includes(single(`${index === selected ? '❯ ' : '  '}${searchPreview(candidates[index]!)}`, columns)));
      }
      if (plan.completionMore) check.ok(frame.includes(single(`  ${hiddenCompletionNotice(menu.hiddenAbove, menu.hiddenBelow)}`, columns)));
      check.ok(!unsafe.test(frame.replaceAll('\n', '')));
    }
  }
  assert(`one counted row per name, selected windows and exact omissions at ${columns} columns across zero/partial/full grants`, true);
}

header('SER-100 C3 — accepted draft display cells still address raw graphemes');
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const expectedDisplay = (text: string) => text.replace(/\t/g, '    ')
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const displayWidth = (text: string) => [...segments.segment(text)].reduce((sum, part) => sum + cellWidth(part.segment), 0);
for (const { name, raw } of SEARCH_PREVIEW_CASES) {
  const accepted = applyPathCompletion(atEnd('@'), pathCompletionQuery('@', 1)!, raw + '.txt');
  const text = accepted.text;
  const boundaries = [0, ...[...segments.segment(text)].map((part) => part.index + part.segment.length)];
  for (const columns of [24, 100]) {
    const layout = layoutEditor(text, columns, accepted.cursor);
    check.equal(layout.rows.map((row) => row.text).join(''), expectedDisplay(text).replaceAll('\n', ''));
    for (const row of layout.rows) {
      check.ok(!unsafe.test(row.text));
      check.equal(displayWidth(row.text), row.width);
      check.ok(row.width <= columns - 6);
      check.equal(single(row.text, columns), row.text.trimEnd());
      for (const boundary of row.boundaries) check.ok(boundaries.includes(boundary.offset), `${name}: legal source boundary ${boundary.offset}`);
    }
    for (const offset of boundaries) {
      for (const affinity of ['upstream', 'downstream'] as const) {
        const value = { text, cursor: { offset, affinity } };
        const geometry = layoutEditor(text, columns, value.cursor);
        const row = geometry.rows[geometry.cursor.row]!;
        check.ok(row.boundaries.some((b) => b.offset === offset && b.column + 5 === geometry.cursor.column));
        check.ok(geometry.cursor.column < columns);
        const edited = insertAtCursor(value, '|');
        check.equal(edited.text, text.slice(0, offset) + '|' + text.slice(offset));
        const index = boundaries.indexOf(offset);
        if (index > 0) check.equal(backspaceAtCursor(value).text, text.slice(0, boundaries[index - 1]) + text.slice(offset));
        if (index + 1 < boundaries.length) check.equal(deleteAtCursor(value).text, text.slice(0, offset) + text.slice(boundaries[index + 1]));
        const cut = killToRowEdge(value, geometry, 'start');
        check.equal(cut.text, text.slice(0, row.start) + text.slice(offset));
        check.deepEqual(popUndo(pushUndo([], value))?.value, value);
        for (const direction of [-1, 1] as const) {
          check.ok(boundaries.includes(moveVertical(geometry, direction).cursor.offset));
          check.ok(boundaries.includes(moveHorizontal(text, value.cursor, direction, geometry).offset));
        }
        for (const edge of ['start', 'end'] as const) check.ok(boundaries.includes(moveToRowEdge(geometry, edge).offset));
      }
    }
    for (const grant of [0, 1, 2, 6, 50]) {
      const frame = input(text, columns, grant);
      check.ok(rowCount(frame) <= grant);
      check.ok(!unsafe.test(frame.replaceAll('\n', '')));
    }
  }
  assert(`${name}: safe counted draft, exact insertion/delete/undo and legal cursor/row boundaries`, true);
}
for (const padding of [11, 12, 13, 17, 18]) {
  const text = 'x'.repeat(padding) + '\u001bZ';
  const before = { offset: padding, affinity: 'downstream' as const };
  const layout = layoutEditor(text, 24, before);
  check.ok(layout.rows.some((row) => row.text.includes('\\u001b')));
  check.ok(layout.rows.every((row) => row.width <= 18));
  check.equal(layout.cursor.column, padding <= 12 ? 5 + padding : 5);
  const after = moveHorizontal(text, before, 1, layout);
  check.equal(after.offset, padding + 1);
  const afterLayout = layoutEditor(text, 24, after);
  check.equal(afterLayout.cursor.column, (padding <= 12 ? padding : 0) + 11);
}
// CRLF's rendered CR can itself wrap. No row edge, Home/End or vertical
// selection may introduce the otherwise invalid source offset between the pair.
for (const padding of [0, 12, 13, 18]) {
  const text = 'x'.repeat(padding) + '\r\nZ';
  const layout = layoutEditor(text, 24, atEnd(text).cursor);
  for (const row of layout.rows) {
    check.ok(row.start !== padding + 1 && row.end !== padding + 1);
    check.ok(row.boundaries.every((b) => b.offset !== padding + 1));
  }
  const before = { text, cursor: { offset: padding, affinity: 'downstream' as const } };
  check.equal(deleteAtCursor(before).text, 'x'.repeat(padding) + 'Z');
  check.equal(backspaceAtCursor({ text, cursor: { offset: padding + 2, affinity: 'upstream' } }).text, 'x'.repeat(padding) + 'Z');
}
const vertical = layoutEditor('a\u001bZ\n12345', 24, atEnd('a\u001bZ\n12345').cursor);
check.equal(moveVertical(vertical, -1, 2).cursor.offset, 1);
check.equal(moveVertical(vertical, -1, 6).cursor.offset, 2);
assert('escapes wrap atomically before/exactly/after an edge and vertical hit-testing chooses raw endpoints', true);

report();
