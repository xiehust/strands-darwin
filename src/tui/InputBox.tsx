/**
 * The prompt line, with skill slash-command completion.
 *
 * Single-line by design. Ink delivers Enter as a keypress rather than a newline,
 * so multi-line editing would need a separate submit binding plus wrapping and
 * cursor bookkeeping. For an MVP whose input is mostly one or two sentences that
 * is not worth the complexity — recorded as a known limitation.
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

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={disabled ? 'gray' : 'cyan'} bold>
          you{'> '}
        </Text>
        <Text dimColor={disabled}>{value}</Text>
        {!disabled && <Text inverse> </Text>}
      </Box>

      {visible.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>skills (↑/↓ to select, tab to complete):</Text>
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
