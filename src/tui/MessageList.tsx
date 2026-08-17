/**
 * Conversation history and the in-flight assistant text.
 *
 * Finished entries go through Ink's `<Static>`, which writes them once above the
 * live region and never redraws them. That keeps long transcripts cheap and lets
 * the terminal's own scrollback hold the history.
 *
 * The in-flight text is the one thing here that is redrawn, so it is the one
 * thing that must fit: `maxLiveRows` rows of it are shown, newest last. See
 * `live-text.ts` for why an over-tall live region costs a whole-screen repaint
 * per text delta.
 */
import { Box, Static, Text } from 'ink';
import React from 'react';

import { hiddenRowsNotice, liveTextView } from './live-text.js';
import { ToolCallResult } from './ToolCallPanel.js';
import type { HistoryItem } from './turn-state.js';

export function MessageList({
  history,
  liveText,
  columns,
  maxLiveRows,
}: {
  readonly history: readonly HistoryItem[];
  readonly liveText: string;
  readonly columns: number;
  /** Rows the live answer may occupy, label and margin included. */
  readonly maxLiveRows: number;
}): React.JSX.Element {
  const live = liveTextView(liveText, columns, maxLiveRows);

  return (
    <Box flexDirection="column">
      <Static items={[...history]}>{(item) => <HistoryEntry key={item.id} item={item} />}</Static>
      {live.rows.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green">agent</Text>
          {live.hiddenRows > 0 && <Text dimColor>{hiddenRowsNotice(live.hiddenRows)}</Text>}
          {/* One Text per pre-wrapped row, truncated: the block's height is then
              exactly what `liveTextView` counted, whatever Ink's own word wrap
              would have done with the same string. */}
          {live.rows.map((row, index) => (
            <Text key={index} wrap="truncate-end">
              {row}
            </Text>
          ))}
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

    case 'assistant': {
      // An answer arrives in pieces (`turn-state.ts`), and `<Static>` never redraws
      // what it wrote — so the label belongs to the piece that opened the answer and
      // the blank row to the piece that closed it. A closing piece may be empty:
      // that is the blank row on its own, owed to an answer that committed every
      // line it had.
      const labelled = item.part === 'whole' || item.part === 'first';
      const closing = item.part === 'whole' || item.part === 'last';
      return (
        <Box flexDirection="column" marginBottom={closing ? 1 : 0}>
          {labelled && <Text color="green">agent</Text>}
          {item.text !== '' && <Text>{item.text}</Text>}
        </Box>
      );
    }

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
