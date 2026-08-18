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
import { diffLineTone } from './edit-diff.js';
import {
  TOOL_INPUT_INDENT,
  hiddenDetailNotice,
  hiddenToolsNotice,
  planToolPanel,
  toolInputRows,
} from './frame-budget.js';
import { formatTaskDuration } from './task-format.js';
import { expandedToolInput, toolResultPreview } from './tool-detail-presentation.js';
import type { ActiveTool, HistoryItem, ToolStatus } from './turn-state.js';
import { diffToneColor, visualColor, visualMarker } from './visual-language.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Running tool calls, with a spinner driven by the parent's tick. */
export function ActiveToolCalls({
  tools,
  frame,
  toolDetailsExpanded,
  columns,
  maxRows,
}: {
  readonly tools: readonly ActiveTool[];
  readonly frame: number;
  readonly toolDetailsExpanded: boolean;
  /** Terminal width, so the input rows can be counted before they are drawn. */
  readonly columns: number;
  /**
   * Rows this panel may draw.
   *
   * Not a formality either: `expandedToolInput` caps its *content* at 100 logical
   * lines and 8000 code points, which measured 41 terminal rows for one 300-line
   * file write — and the spinner redraws this panel every 90ms whether text is
   * arriving or not, so an over-tall panel clears the screen ~11 times a second.
   */
  readonly maxRows: number;
}): React.JSX.Element | null {
  if (tools.length === 0) return null;

  // Wrapped here, once, and drawn one row per `<Text wrap="truncate-end">` below:
  // the panel's height has to be what was counted, not what Ink's own word wrap
  // makes of the same string.
  const inputs = tools.map((tool) =>
    toolDetailsExpanded ? toolInputRows(tool.input, columns, tool.name) : [],
  );
  const plan = planToolPanel(
    inputs.map((rows) => ({ detailRows: rows.length })),
    maxRows,
  );
  if (plan.entries.length === 0 && plan.hiddenTools === 0) return null;

  return (
    <Box flexDirection="column">
      {plan.entries.map((entry, index) => {
        const tool = tools[index] as ActiveTool;
        const rows = (inputs[index] ?? []).slice(0, entry.detailRows);
        return (
          <Box key={tool.id} flexDirection="column">
            {/* One `<Text>` with a nested span, not two children of a `<Box>`: Ink
                lays those out as flex items and wraps them independently, which is a
                row the budget did not count. */}
            <Text wrap="truncate-end">
              <Text color={visualColor.active} bold>{`${visualMarker.activeTool} ${FRAMES[frame % FRAMES.length]} `}</Text>
              {activeToolCallSummary(tool.summary, tool.compactSummary, toolDetailsExpanded)}
              {/* Elapsed suffix, never prefix: pty assertions match the summary as a
                  substring, and the existing spinner tick already redraws each frame. */}
              {` (${formatTaskDuration(Date.now() - tool.startedAt)})`}
            </Text>
            {rows.map((row, index) => (
              // Diff-toned rows trade the dim input styling for their tone
              // colour; the `+ `/`- ` marker on the text is the durable signal.
              <Text
                key={index}
                {...(row.tone === undefined ? { dimColor: true } : { color: diffToneColor(row.tone) })}
                wrap="truncate-end"
              >
                {index === 0 ? `    Input: ${row.text}` : `${TOOL_INPUT_INDENT}${row.text}`}
              </Text>
            ))}
            {entry.hiddenDetailRows > 0 && (
              <Text dimColor wrap="truncate-end">{`${TOOL_INPUT_INDENT}${hiddenDetailNotice(entry.hiddenDetailRows)}`}</Text>
            )}
          </Box>
        );
      })}
      {plan.hiddenTools > 0 && (
        <Text dimColor wrap="truncate-end">{hiddenToolsNotice(plan.hiddenTools)}</Text>
      )}
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
      <Text wrap="truncate-end">
        <Text color={visualColor.tool} bold>{visualMarker.tool} </Text>
        <Text color={color}>{icon} </Text>
        {item.summary}
      </Text>
      {input.map((line, index) => {
        // The finished projection is the same diff the permission box showed;
        // tone is re-read from the marker the line itself carries, scoped to
        // fileEditor so no other tool's text can turn a row red or green.
        const tone = item.name === 'fileEditor' ? diffLineTone(line) : undefined;
        return (
          <Text
            key={`input-${index}`}
            {...(tone === undefined ? { dimColor: true } : { color: diffToneColor(tone) })}
          >
            {index === 0 ? `    Input: ${line}` : `           ${line}`}
          </Text>
        );
      })}

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
      return { icon: '✓', color: visualColor.success };
    case 'denied':
      return { icon: '⊘', color: visualColor.warning };
    case 'error':
      return { icon: '✗', color: visualColor.danger };
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
