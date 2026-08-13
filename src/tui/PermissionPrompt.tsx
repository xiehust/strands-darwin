/**
 * Confirmation prompt for a gated tool call.
 *
 * Renders the structured {@link PermissionRequest} the gate produced: a one-line
 * summary plus each labelled detail block, so a bash command and a file edit each
 * show what actually matters about them.
 */
import { Box, Text } from 'ink';
import React from 'react';

import type { PermissionRequest } from '../agent/permission.js';

/** Lines shown per detail block before truncating. */
const DETAIL_LINES = 14;

export function PermissionPrompt({
  request,
  waiting,
}: {
  readonly request: PermissionRequest;
  readonly waiting: number;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box>
        <Text color="yellow" bold>
          permission required
        </Text>
        <Text dimColor> ({request.kind})</Text>
        {waiting > 0 && <Text dimColor> — {waiting} more queued</Text>}
      </Box>

      <Text>{request.summary}</Text>

      {request.details.map((detail) => (
        <Box key={detail.label} flexDirection="column" marginTop={1}>
          <Text color="yellow">{detail.label}:</Text>
          {clip(detail.value).map((line, index) => (
            // Detail lines are static text with no identity of their own.
            <Text key={index}>
              {'  '}
              {line}
            </Text>
          ))}
        </Box>
      ))}

      <Box marginTop={1}>
        <Text bold>allow? </Text>
        <Text color="green">y</Text>
        <Text dimColor> / </Text>
        <Text color="red">n</Text>
        <Text dimColor> (esc denies)</Text>
      </Box>
    </Box>
  );
}

function clip(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length <= DETAIL_LINES) return lines;
  return [...lines.slice(0, DETAIL_LINES), `… ${lines.length - DETAIL_LINES} more line(s)`];
}
