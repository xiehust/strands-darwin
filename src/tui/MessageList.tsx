/**
 * Conversation history and the in-flight assistant text.
 *
 * Finished entries go through Ink's `<Static>`, which writes them once above the
 * live region and never redraws them. That keeps long transcripts cheap and lets
 * the terminal's own scrollback hold the history.
 */
import { Box, Static, Text } from 'ink';
import React from 'react';

import { ToolCallResult } from './ToolCallPanel.js';
import type { HistoryItem } from './turn-state.js';

export function MessageList({
  history,
  liveText,
}: {
  readonly history: readonly HistoryItem[];
  readonly liveText: string;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Static items={[...history]}>{(item) => <HistoryEntry key={item.id} item={item} />}</Static>
      {liveText !== '' && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green">agent</Text>
          <Text>{liveText}</Text>
        </Box>
      )}
    </Box>
  );
}

function HistoryEntry({ item }: { readonly item: HistoryItem }): React.JSX.Element {
  switch (item.kind) {
    case 'user':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="cyan" bold>
            you
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );

    case 'assistant':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green">agent</Text>
          <Text>{item.text}</Text>
        </Box>
      );

    case 'tool':
      return <ToolCallResult item={item} />;

    case 'notice':
      return (
        <Box marginBottom={1}>
          {/* Severity picks the color only; the words already carry the details. */}
          {item.severity === 'info' ? (
            <Text dimColor>{item.text}</Text>
          ) : (
            <Text color={item.severity === 'error' ? 'red' : 'yellow'}>{item.text}</Text>
          )}
        </Box>
      );
  }
}
