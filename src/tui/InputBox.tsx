/** The editable multiline prompt, with slash-command completion. */
import { Box, Text, useBoxMetrics, useCursor, type DOMElement } from 'ink';
import React, { useRef } from 'react';

import { builtinCommandDescription } from '../commands/custom-commands.js';
import { draftWindow, hiddenDraftNotice, planPromptBox } from './frame-budget.js';
import type { EditorLayout } from './prompt-editor.js';

/**
 * Completion rows shown at once; sized so all ten built-ins fit on one screen.
 *
 * Adding a built-in means growing this number, or the last one silently falls off
 * behind the "… n more" line — a command nobody can see is a command nobody uses.
 * The list only ever renders in place of the permission box (`App.tsx` shows one or
 * the other), so this number does not compete with it for frame height. It is a cap
 * on what is *offered*; how much of it survives a short terminal is
 * `planPromptBox`'s decision.
 */
export const MAX_COMPLETIONS = 10;

export function InputBox({
  layout,
  completions,
  selectedCompletion,
  editable,
  hint,
  offset,
  maxRows,
}: {
  readonly layout: EditorLayout;
  readonly completions: readonly string[];
  readonly selectedCompletion: number;
  readonly editable: boolean;
  readonly hint: string | undefined;
  /** Position of this box's parent within the live frame; see below. */
  readonly offset: { readonly top: number; readonly left: number };
  /**
   * Rows this whole region may draw — draft window, notice, menu and hint.
   *
   * A draft is as tall as it is pasted, so this is not a formality: measured at
   * 80x24, a 13-row draft was enough to put Ink into its whole-screen-clear branch
   * and take the scrollback with it (`frame-budget.ts`).
   */
  readonly maxRows: number;
}): React.JSX.Element {
  const offered = Math.min(completions.length, MAX_COMPLETIONS);
  const plan = planPromptBox({
    maxRows,
    draftRows: layout.rows.length,
    completions: offered,
    moreCompletions: completions.length > offered,
    hasHint: hint !== undefined,
  });
  const view = draftWindow(layout.rows.length, layout.cursor.row, plan.draftRows);
  const rows = layout.rows.slice(view.start, view.end);
  const visible = completions.slice(0, plan.completionItems);

  const inputRef = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(inputRef);
  const { setCursorPosition } = useCursor();

  // Ink's cursor coordinates are relative to the whole live frame, while
  // `useBoxMetrics` reports a box's position within its *parent* and the editor
  // layout is local to this box — hence three terms, not two. A windowed draft adds
  // a fourth: the row the cursor is on is no longer its row in the layout, and the
  // notice above the window shifts it by one. Hide the cursor until layout has been
  // measured.
  setCursorPosition(
    editable && metrics.hasMeasured
      ? {
          x: offset.left + metrics.left + layout.cursor.column,
          y: offset.top + metrics.top + (view.notice ? 1 : 0) + (layout.cursor.row - view.start),
        }
      : undefined,
  );

  return (
    <Box ref={inputRef} flexDirection="column" aria-role="textbox" aria-state={{ multiline: true, disabled: !editable }}>
      {/* Above the window, and counting both directions at once: one row, whatever
          is missing, so the height is known before the window is chosen. */}
      {view.notice && (
        <Text dimColor wrap="truncate-end">
          {hiddenDraftNotice(view.hiddenAbove, view.hiddenBelow)}
        </Text>
      )}
      {rows.map((row, index) => (
        <Box key={`${row.start}:${index}`}>
          <Text color={!editable ? 'gray' : row.prefix === 'you> ' ? 'cyan' : 'gray'} bold={row.prefix === 'you> '}>
            {row.prefix}
          </Text>
          <Text dimColor={!editable} wrap="truncate-end">{row.text}</Text>
        </Box>
      ))}

      {visible.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {/* Truncated: on a narrow terminal this title wraps, and a row nobody
              counted is a row Ink turns into a whole-screen repaint. */}
          <Text dimColor wrap="truncate-end">commands (↑/↓ to select, tab to complete):</Text>
          {visible.map((name, index) => {
            const selected = index === selectedCompletion;
            const description = builtinCommandDescription(name);
            return (
              <Box key={name}>
                {/* Marker and name in one truncated Text: two untruncated children
                    can sum past the width and wrap, which the budget did not count. */}
                <Text color={selected ? 'cyan' : 'gray'} wrap="truncate-end">
                  {selected ? '❯ ' : '  '}/{name}
                </Text>
                {/* Appended after the name so pty substring assertions on
                    "  /name" rows keep matching; truncated so a narrow terminal
                    cannot wrap the row and grow the live frame taller. */}
                {description !== undefined && (
                  <Text dimColor wrap="truncate-end">
                    {' '}— {description}
                  </Text>
                )}
              </Box>
            );
          })}
          {plan.completionMore && (
            <Text dimColor>{`  … ${completions.length - visible.length} more`}</Text>
          )}
        </Box>
      )}

      {hint !== undefined && plan.hint && (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">{hint}</Text>
        </Box>
      )}
    </Box>
  );
}
