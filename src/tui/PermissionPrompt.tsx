/**
 * Confirmation prompt for a gated tool call.
 *
 * Renders the structured {@link PermissionRequest} the gate produced: a one-line
 * summary plus each labelled detail block, so a bash command and a file edit each
 * show what actually matters about them. The last line carries the answer keys,
 * including the "always allow" offers the gate derived from this call.
 */
import { Box, Text } from 'ink';
import React from 'react';

import type { AssessedPermissionRequest } from '../agent/permission.js';

/** Lines shown per detail block before truncating. */
const DETAIL_LINES = 14;

export function PermissionPrompt({
  request,
  waiting,
}: {
  readonly request: AssessedPermissionRequest;
  readonly waiting: number;
}): React.JSX.Element {
  const options = ruleOptions(request);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box>
        <Text color="yellow" bold>
          permission required
        </Text>
        <Text dimColor>
          {' '}
          ({request.kind} — {request.riskReason})
        </Text>
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
        <Text dimColor> </Text>
        <Text color="red">n</Text>
        {options.length > 0 && <Text dimColor> always:</Text>}
        {options.map((option) => (
          <React.Fragment key={option.key}>
            <Text dimColor> </Text>
            <Text color="cyan">{option.key}</Text>
            <Text dimColor>={option.label}</Text>
          </React.Fragment>
        ))}
        <Text dimColor> esc=deny</Text>
      </Box>
    </Box>
  );
}

/**
 * The `a` / `A` offers, or none when no rule could cover this call.
 *
 * One line, always: this box shares the live frame with the header, and a second
 * row of options is a row of the box Ink drops off a short terminal. `A` is
 * omitted when both offers would be the same rule (unknown tools, which only get
 * the whole-tool form).
 */
function ruleOptions(request: AssessedPermissionRequest): { key: string; label: string }[] {
  const [specific] = request.suggestions;
  const wholeTool = request.suggestions[request.suggestions.length - 1];
  if (specific === undefined || wholeTool === undefined) return [];
  if (specific.rule === wholeTool.rule) return [{ key: 'a', label: specific.label }];
  return [
    { key: 'a', label: specific.label },
    { key: 'A', label: wholeTool.label },
  ];
}

function clip(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length <= DETAIL_LINES) return lines;
  return [...lines.slice(0, DETAIL_LINES), `… ${lines.length - DETAIL_LINES} more line(s)`];
}
