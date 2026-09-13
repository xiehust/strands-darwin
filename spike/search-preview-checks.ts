/** SER-088: shared real Ink row checks for the two counted search projections. */
import { renderToString, Text } from 'ink';
import React from 'react';

import { completionWindow, InputBox } from '../src/tui/InputBox.js';
import { planPromptBox } from '../src/tui/frame-budget.js';
import { layoutEditor } from '../src/tui/prompt-editor.js';
import type { PromptHistorySearchView } from '../src/tui/prompt-history-search.js';
import { assert } from './shared.js';

export const SEARCH_PREVIEW_CASES = [
  { name: 'ordinary', raw: '  FiX login  ', preview: '  FiX login  ' },
  { name: 'LF', raw: 'FiX\nnext', preview: 'FiX ⏎ next' },
  { name: 'CR', raw: 'FiX\rnext', preview: 'FiX ⏎ next' },
  { name: 'CRLF', raw: 'FiX\r\nnext', preview: 'FiX ⏎ next' },
  { name: 'blank lines', raw: '\r\nFiX\n\nnext\r', preview: ' ⏎ FiX ⏎  ⏎ next ⏎ ' },
  { name: 'Unicode separators', raw: 'FiX\u2028next\u2029end\u0085tail', preview: 'FiX ⏎ next ⏎ end ⏎ tail' },
  { name: 'vertical controls', raw: 'FiX\vnext\fend', preview: 'FiX ⏎ next ⏎ end' },
  { name: 'tabs and backspace', raw: 'FiX\t\bnext', preview: 'FiX\\u0009\\u0008next' },
  { name: 'ANSI and OSC', raw: 'FiX\u001b[2J\u001b]2;title\u0007\u009b2K\u009c',
    preview: 'FiX\\u001b[2J\\u001b]2;title\\u0007\\u009b2K\\u009c' },
  { name: 'Unicode graphemes', raw: 'FiX 中文 e\u0301 🧬 👩‍💻 العربية', preview: 'FiX 中文 e\u0301 🧬 👩‍💻 العربية' },
  { name: 'wide Unicode multiline', raw: '中文🧬'.repeat(25) + '\r\n👩‍💻e\u0301',
    preview: '中文🧬'.repeat(25) + ' ⏎ 👩‍💻e\u0301' },
  { name: 'all C0 DEL C1', raw: Array.from({ length: 65 }, (_, i) => String.fromCharCode(i < 32 ? i : i + 95)).join(''),
    preview: Array.from({ length: 65 }, (_, i) => {
      const code = i < 32 ? i : i + 95;
      return [10, 11, 12, 13, 133].includes(code) ? ' ⏎ ' : `\\u${code.toString(16).padStart(4, '0')}`;
    }).join('') },
] as const;

const plain = (text: string): string => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
const rowCount = (text: string): number => text === '' ? 0 : text.split('\n').length;
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** InputBox itself, not a second layout: widths cross wide/combining grapheme boundaries. */
export function checkSearchRender(name: string, view: PromptHistorySearchView, rewind = false): void {
  assert(`${name}: title and previews contain no row/terminal controls`,
    [view.title, ...view.matches].every((text) => !unsafe.test(text)));
  for (const columns of [24, 100]) {
    const rows = [view.title, ...view.matches].map((text) =>
      plain(renderToString(React.createElement(Text, { wrap: 'truncate-end' }, text), { columns })));
    assert(`${name}: each Text is exactly one Ink row at ${columns} columns`,
      rows.every((text) => rowCount(text) === 1));
    const layout = layoutEditor('', columns, { offset: 0, affinity: 'downstream' });
    const failures: string[] = [];
    for (const maxRows of [0, 1, 2, 3, 4, 5, 8, 12]) {
      const plan = planPromptBox({
        maxRows, draftRows: 1, completions: 0, moreCompletions: false, hasHint: false,
        searchMatches: view.matches.length, moreSearchMatches: view.hiddenAbove + view.hiddenBelow > 0,
      });
      const rendered = plain(renderToString(React.createElement(InputBox, {
        layout, completions: [], completionKind: 'command', completionNote: undefined,
        selectedCompletion: 0, editable: true, hint: undefined, recallIndicator: undefined,
        ...(rewind ? { rewindSearch: view } : { historySearch: view }),
        offset: { top: 0, left: 0 }, maxRows,
      }), { columns }));
      const expectedRows = Math.min(1, plan.draftRows) + Number(plan.search) + plan.searchItems + Number(plan.searchMore);
      if (rowCount(rendered) !== expectedRows || rowCount(rendered) > maxRows) failures.push(`height grant ${maxRows}`);
      const window = completionWindow(view.matches.length, view.selected, plan.searchItems);
      if (plan.searchItems > 0 && !rendered.split('\n')[2 + window.selected - window.start]?.startsWith('❯ ')) {
        failures.push(`selected grant ${maxRows}`);
      }
      if (plan.searchMore) {
        const above = view.hiddenAbove + window.hiddenAbove;
        const below = view.hiddenBelow + window.hiddenBelow;
        const parts = [above > 0 ? `${above} newer` : '', below > 0 ? `${below} older` : ''].filter(Boolean);
        const notice = `  … ${above + below} matches not shown (${parts.join(', ')})`;
        const expectedNotice = plain(renderToString(React.createElement(Text, { wrap: 'truncate-end' }, notice), { columns }));
        if (rendered.split('\n').at(-1) !== expectedNotice) failures.push(`omissions grant ${maxRows}`);
      }
    }
    assert(`${name}: InputBox height, selection and omissions match every grant at ${columns} columns (${failures.join(', ') || 'all bounded'})`,
      failures.length === 0);
  }
}
