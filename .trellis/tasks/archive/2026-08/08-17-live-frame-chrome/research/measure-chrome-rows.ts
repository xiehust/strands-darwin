/**
 * RESEARCH MEASUREMENT (task 08-17-live-frame-chrome) — not part of spike/.
 *
 * The pty probe next door proves *that* an over-tall live frame clears the screen,
 * and at which draft height. This one answers the other half: how many terminal
 * rows each redrawn participant can actually claim, which is what decides whether
 * the fix has to bound one box or share a budget between all of them.
 *
 * Pure calls into the real presentation modules — no Ink, no pty, no model.
 *
 * The number that matters is **visual rows at the current width**, not logical
 * lines: `ToolCallPanel` and `PermissionPrompt` draw their detail lines as plain
 * `<Text>`, so Ink word-wraps them, and the existing caps count lines and code
 * points instead. `wrapToRows` is borrowed from `live-text.ts` to count the rows
 * Ink would produce.
 *
 * Run: pnpm tsx .trellis/tasks/08-17-live-frame-chrome/research/measure-chrome-rows.ts [columns]
 */
import process from 'node:process';

import { wrapToRows } from '../../../../src/tui/live-text.js';
import { layoutEditor } from '../../../../src/tui/prompt-editor.js';
import {
  EXPANDED_INPUT_CODE_POINTS,
  EXPANDED_INPUT_LINES,
  PERMISSION_DETAIL_CODE_POINTS,
  PERMISSION_DETAIL_LINES,
  expandedToolInput,
  permissionDetail,
} from '../../../../src/tui/tool-detail-presentation.js';

const columns = Number(process.argv[2] ?? 80);
const cursor = { offset: 0, affinity: 'downstream' } as const;

/** Rows Ink produces for a plain `<Text>` line, as the panels draw them. */
function visualRows(lines: readonly string[], indent: string): number {
  return lines.reduce((total, line) => total + wrapToRows(indent + line, columns).length, 0);
}

console.log(`=== visual rows at ${columns} columns ===`);

// 1. The draft. `layoutEditor` emits one visual row per row of the whole draft,
//    with no cap at all: the paste is the height.
for (const [label, text] of [
  ['a 200-line paste', Array.from({ length: 200 }, (_, i) => `pasted line ${i + 1}`).join('\n')],
  ['one 5000-character line', 'x'.repeat(5000)],
] as const) {
  console.log(`draft — ${label}: ${layoutEditor(text, columns, cursor).rows.length} rows`);
}

// 2. An in-flight tool call with details expanded (ctrl+b). The caps are on
//    logical lines and code points; the height is neither.
const write = {
  path: '/repo/src/x.ts',
  content: Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'),
};
const input = expandedToolInput(write);
console.log(
  `tool details — a 300-line file write: ${input.length} logical lines, ` +
    `${[...input.join('\n')].length} code points → ${visualRows(input, '    Input: ')} rows`,
);
console.log(
  `tool details — worst case allowed by the caps ` +
    `(${EXPANDED_INPUT_LINES} lines / ${EXPANDED_INPUT_CODE_POINTS} code points): ` +
    `up to ${Math.ceil(EXPANDED_INPUT_CODE_POINTS / (columns - 1))} rows, per active tool ` +
    `(activeTools.length is itself uncapped)`,
);

// 3. The permission box. Each detail block is bounded; the number of blocks is not,
//    and every block also costs a label row and a blank row.
const detail = permissionDetail(write.content);
console.log(
  `permission box — one detail block: ${visualRows(detail, '  ') + 1} rows incl. its label; ` +
    `caps are ${PERMISSION_DETAIL_LINES} lines / ${PERMISSION_DETAIL_CODE_POINTS} code points ` +
    `*per block*, plus 2 border rows for the box`,
);
