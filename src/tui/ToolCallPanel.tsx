/**
 * Tool call rendering, in-flight and finished.
 *
 * Summaries come from `classify()` in the permission gate rather than being
 * rebuilt here, so a tool call is described the same way whether it is being
 * confirmed, running, or done.
 */
import { Box, Text } from 'ink';
import React from 'react';

import type { ActiveTool, HistoryItem, ToolStatus } from './turn-state.js';

/** Lines of tool output kept in the collapsed preview. */
const PREVIEW_LINES = 4;

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Running tool calls, with a spinner driven by the parent's tick. */
export function ActiveToolCalls({
  tools,
  frame,
}: {
  readonly tools: readonly ActiveTool[];
  readonly frame: number;
}): React.JSX.Element | null {
  if (tools.length === 0) return null;

  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <Box key={tool.id}>
          <Text color="yellow">{FRAMES[frame % FRAMES.length]} </Text>
          <Text dimColor>{tool.summary}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function ToolCallResult({
  item,
}: {
  readonly item: Extract<HistoryItem, { kind: 'tool' }>;
}): React.JSX.Element {
  const { icon, color } = statusStyle(item.status);
  const preview = collapse(item.preview);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text dimColor>{item.summary}</Text>
      </Box>
      {preview.map((line, index) => (
        // Preview lines are static text with no identity of their own.
        <Text key={index} dimColor>
          {'    '}
          {line}
        </Text>
      ))}
    </Box>
  );
}

function statusStyle(status: ToolStatus): { icon: string; color: string } {
  switch (status) {
    case 'ok':
      return { icon: '✓', color: 'green' };
    case 'denied':
      return { icon: '⊘', color: 'yellow' };
    case 'error':
      return { icon: '✗', color: 'red' };
  }
}

/** Trims tool output to a few lines, noting how much was hidden. */
function collapse(preview: string): string[] {
  if (preview.trim() === '') return [];

  const lines = preview.split('\n');
  if (lines.length <= PREVIEW_LINES) return lines;

  return [...lines.slice(0, PREVIEW_LINES), `… ${lines.length - PREVIEW_LINES} more line(s)`];
}
