/** The editable multiline prompt, with slash-command completion. */
import { Box, Text, useBoxMetrics, useCursor, type DOMElement } from 'ink';
import React, { useRef } from 'react';

import { builtinCommandDescription } from '../commands/custom-commands.js';
import type { EditorLayout } from './prompt-editor.js';

/**
 * Completion rows shown at once; sized so all nine built-ins fit on one screen.
 *
 * Adding a built-in means growing this number, or the last one silently falls off
 * behind the "… n more" line — a command nobody can see is a command nobody uses.
 * The list only ever renders in place of the permission box (`App.tsx` shows one or
 * the other), so this number does not compete with it for frame height.
 */
const MAX_COMPLETIONS = 9;

export function InputBox({
  layout,
  completions,
  selectedCompletion,
  editable,
  hint,
  offset,
}: {
  readonly layout: EditorLayout;
  readonly completions: readonly string[];
  readonly selectedCompletion: number;
  readonly editable: boolean;
  readonly hint: string | undefined;
  /** Position of this box's parent within the live frame; see below. */
  readonly offset: { readonly top: number; readonly left: number };
}): React.JSX.Element {
  const visible = completions.slice(0, MAX_COMPLETIONS);
  const inputRef = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(inputRef);
  const { setCursorPosition } = useCursor();

  // Ink's cursor coordinates are relative to the whole live frame, while
  // `useBoxMetrics` reports a box's position within its *parent* and the editor
  // layout is local to this box — hence three terms, not two. Hide the cursor
  // until layout has been measured.
  setCursorPosition(
    editable && metrics.hasMeasured
      ? {
          x: offset.left + metrics.left + layout.cursor.column,
          y: offset.top + metrics.top + layout.cursor.row,
        }
      : undefined,
  );

  return (
    <Box ref={inputRef} flexDirection="column" aria-role="textbox" aria-state={{ multiline: true, disabled: !editable }}>
      {layout.rows.map((row, index) => (
        <Box key={`${row.start}:${index}`}>
          <Text color={!editable ? 'gray' : row.prefix === 'you> ' ? 'cyan' : 'gray'} bold={row.prefix === 'you> '}>
            {row.prefix}
          </Text>
          <Text dimColor={!editable} wrap="truncate-end">{row.text}</Text>
        </Box>
      ))}

      {visible.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>commands (↑/↓ to select, tab to complete):</Text>
          {visible.map((name, index) => {
            const selected = index === selectedCompletion;
            const description = builtinCommandDescription(name);
            return (
              <Box key={name}>
                <Text color={selected ? 'cyan' : 'gray'}>{selected ? '❯ ' : '  '}</Text>
                <Text color={selected ? 'cyan' : 'gray'}>/{name}</Text>
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
          {completions.length > visible.length && (
            <Text dimColor>{`  … ${completions.length - visible.length} more`}</Text>
          )}
        </Box>
      )}

      {hint !== undefined && (
        <Box marginTop={1}>
          <Text dimColor>{hint}</Text>
        </Box>
      )}
    </Box>
  );
}
