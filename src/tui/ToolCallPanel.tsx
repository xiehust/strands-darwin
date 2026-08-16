/**
 * Tool call rendering, in-flight and finished.
 *
 * Summaries come from `classify()` in the permission gate rather than being
 * rebuilt here, so a tool call is described the same way whether it is being
 * confirmed, running, or done.
 */
import { Box, Text } from 'ink';
import React from 'react';

import { activeToolCallSummary } from './background-tool-presentation.js';
import { formatTaskDuration } from './task-format.js';
import { expandedToolInput, toolResultPreview } from './tool-detail-presentation.js';
import type { ActiveTool, HistoryItem, ToolStatus } from './turn-state.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Running tool calls, with a spinner driven by the parent's tick. */
export function ActiveToolCalls({
  tools,
  frame,
  toolDetailsExpanded,
}: {
  readonly tools: readonly ActiveTool[];
  readonly frame: number;
  readonly toolDetailsExpanded: boolean;
}): React.JSX.Element | null {
  if (tools.length === 0) return null;

  return (
    <Box flexDirection="column">
      {tools.map((tool) => {
        const input = toolDetailsExpanded ? expandedToolInput(tool.input) : [];
        return (
          <Box key={tool.id} flexDirection="column">
            <Box>
              <Text color="yellow">{FRAMES[frame % FRAMES.length]} </Text>
              <Text dimColor>{activeToolCallSummary(tool.summary, tool.compactSummary, toolDetailsExpanded)}</Text>
              {/* Elapsed suffix, never prefix: pty assertions match the summary as a
                  substring, and the existing spinner tick already redraws each frame. */}
              <Text dimColor> ({formatTaskDuration(Date.now() - tool.startedAt)})</Text>
            </Box>
            {input.map((line, index) => (
              <Text key={index} dimColor>
                {index === 0 ? `    Input: ${line}` : `           ${line}`}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}

export function ToolCallResult({
  item,
}: {
  readonly item: Extract<HistoryItem, { kind: 'tool' }>;
}): React.JSX.Element {
  const { icon, color } = statusStyle(item.status);
  const input = item.expanded && item.inputPreview !== '' ? item.inputPreview.split('\n') : [];
  const preview = item.preview === '' ? [] : item.preview.split('\n');

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={color}>{icon} </Text>
        <Text dimColor>{item.summary}</Text>
      </Box>
      {input.map((line, index) => (
        <Text key={`input-${index}`} dimColor>
          {index === 0 ? `    Input: ${line}` : `           ${line}`}
        </Text>
      ))}

      {preview.map((line, index) => (
        // Preview lines are static text with no identity of their own.
        <Text key={index} dimColor>
          {item.expanded
            ? index === 0 ? `    Result: ${line}` : `            ${line}`
            : `    ${line}`}
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

/**
 * Trims tool output to a few lines by status, noting how much was hidden.
 *
 * Success reads from the top, the way pagers do. A failure's diagnostic is
 * almost always at the *end* of its output, so errors keep the tail instead.
 * Denied results keep their `DENIED:` first line — the reason itself, and what
 * the deny flow greps for — plus the tail, within the same row budget.
 */
export function collapsePreview(preview: string, status: ToolStatus, expanded = false): string[] {
  return toolResultPreview(preview, status, expanded);
}
