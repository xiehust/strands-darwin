/**
 * The multiline prompt, with slash-command completion (built-ins and skills).
 *
 * Editing is deliberately append/backspace-only: each logical line gets its own
 * prefix, while Ink owns visual wrapping and the cursor stays after the last line.
 */
import { Box, Text } from 'ink';
import React from 'react';

/** Completion rows shown at once. */
const MAX_COMPLETIONS = 6;

export function InputBox({
  value,
  completions,
  selectedCompletion,
  disabled,
  hint,
}: {
  readonly value: string;
  readonly completions: readonly string[];
  readonly selectedCompletion: number;
  readonly disabled: boolean;
  readonly hint: string | undefined;
}): React.JSX.Element {
  const visible = completions.slice(0, MAX_COMPLETIONS);
  const lines = value.split('\n');

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const last = index === lines.length - 1;
        return (
          <Box key={index}>
            <Text color={disabled ? 'gray' : index === 0 ? 'cyan' : 'gray'} bold={index === 0}>
              {index === 0 ? 'you> ' : '...> '}
            </Text>
            <Text dimColor={disabled}>{line}</Text>
            {last && !disabled && <Text inverse> </Text>}
          </Box>
        );
      })}

      {visible.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>commands (↑/↓ to select, tab to complete):</Text>
          {visible.map((name, index) => {
            const selected = index === selectedCompletion;
            return (
              <Box key={name}>
                <Text color={selected ? 'cyan' : 'gray'}>{selected ? '❯ ' : '  '}</Text>
                <Text color={selected ? 'cyan' : 'gray'}>/{name}</Text>
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
