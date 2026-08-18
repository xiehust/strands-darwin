/**
 * Confirmation prompt for a gated tool call.
 *
 * Renders the structured {@link PermissionRequest} the gate produced: a one-line
 * summary plus each labelled detail block, so a bash command and a file edit each
 * show what actually matters about them. The last line carries the answer keys,
 * including the "always allow" offers the gate derived from this call.
 *
 * The summary line is prefixed with the request's source — `[parent]`, or
 * `[<agent>#<dispatch>]` for a child. Always, not only for children: children run
 * concurrently and can queue prompts behind one another, so a label that appears
 * sometimes leaves the user guessing on exactly the prompts that matter. It rides
 * the existing summary line because this box shares the live frame with the header,
 * where one extra row is a row Ink drops off a short terminal.
 */
import { Box, Text } from 'ink';
import React from 'react';

import type { AssessedPermissionRequest } from '../agent/permission.js';
import { emphasisSpans, permissionDisplayDetails } from './edit-diff.js';
import {
  PERMISSION_BOX_CHROME_COLUMNS,
  PERMISSION_DETAIL_INDENT,
  hiddenPermissionNotice,
  permissionBoxWanted,
  permissionDetailRows,
  planPermissionBox,
  type BoundedContentRow,
} from './frame-budget.js';
import { wrapToRows } from './live-text.js';
import { permissionSummary } from './tool-detail-presentation.js';
import { diffToneColor, visualColor, visualMarker } from './visual-language.js';

export function PermissionPrompt({
  request,
  waiting,
  columns,
  maxRows,
}: {
  readonly request: AssessedPermissionRequest;
  readonly waiting: number;
  /** Terminal width, so the detail rows can be counted before they are drawn. */
  readonly columns: number;
  /**
   * Rows this box may draw.
   *
   * `PERMISSION_DETAIL_LINES` bounds each block's *content*, not the box's height,
   * and the number of blocks is per call — so on a short terminal this box was
   * another way to push the frame past the viewport, which costs the scrollback.
   */
  readonly maxRows: number;
}): React.JSX.Element {
  const { options, blocks, headingText, decisionText, fixedRows } = boxGeometry(request, waiting, columns);
  const plan = planPermissionBox(blocks.map((block) => block.rows.length), maxRows, fixedRows);
  const hiddenRows = plan.blocks.reduce((total, block, index) => {
    const source = blocks[index];
    return total + (source === undefined ? 0 : source.rows.length - block.rows);
  }, 0);

  // Every row here is **one** `<Text>` with nested spans, never several `<Text>`
  // children of a `<Box>`. Ink lays those out as flex items and shrinks or wraps
  // them independently — measured: the summary row rendered as two rows and ate the
  // `] ` after `[parent`. One text node wraps as one string, which is also the
  // string counted above.
  const summaryRow = (
    <Text wrap="truncate-end">
      <Text color={visualColor.identity} bold>[{request.source.label}] </Text>
      {permissionSummary(request.summary)}
    </Text>
  );
  const decisionRow = (
    <Text>
      <Text bold>allow? </Text>
      <Text color={visualColor.success} bold>y</Text>
      <Text dimColor> </Text>
      <Text color={visualColor.danger} bold>n</Text>
      {options.length > 0 && <Text dimColor> always:</Text>}
      {options.map((option) => (
        <React.Fragment key={option.key}>
          <Text dimColor> </Text>
          <Text color={visualColor.active}>{option.key}</Text>
          <Text dimColor>={option.label}</Text>
        </React.Fragment>
      ))}
      <Text dimColor> esc=deny</Text>
    </Text>
  );

  // A terminal too short for the box drops the border and the details, never the
  // question: an unanswerable prompt blocks the agent loop, and a prompt whose
  // details vanished silently would be a security problem, so the notice outlives
  // them both. Here the decision row is one truncated line rather than the coloured
  // one — at two or three rows, fitting is worth more than the colour.
  if (plan.compact) {
    return (
      <Box flexDirection="column">
        {plan.summary && summaryRow}
        {plan.notice && (
          <Text color={visualColor.warning} wrap="truncate-end">
            {hiddenPermissionNotice(hiddenRows, plan.hiddenBlocks)}
          </Text>
        )}
        <Text bold wrap="truncate-end">{decisionText}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={visualColor.warning} paddingX={1}>
      <Text>
        <Text color={visualColor.warning} bold>
          {visualMarker.permission} permission required
        </Text>
        <Text dimColor>
          {' '}
          ({request.kind} — {request.riskReason})
        </Text>
        {waiting > 0 && <Text dimColor> — {waiting} more queued</Text>}
      </Text>

      {summaryRow}

      {plan.blocks.map((granted, index) => {
        const block = blocks[index];
        if (block === undefined || granted.rows === 0) return null;
        return (
          <Box key={block.label} flexDirection="column" marginTop={1}>
            <Text color={visualColor.warning}>{block.label}:</Text>
            {block.rows.slice(0, granted.rows).map((row, rowIndex) => (
              // Detail lines are static text with no identity of their own. Diff
              // rows carry their tone; colour reinforces the `+ `/`- ` marker,
              // which is what survives ANSI stripping, and the bold changed span
              // is the same enhancement layer nested in the same counted row.
              <Text
                key={rowIndex}
                {...(row.tone === undefined ? {} : { color: diffToneColor(row.tone) })}
                wrap="truncate-end"
              >
                {PERMISSION_DETAIL_INDENT}
                {row.emphasis === undefined ? row.text : emphasizedRow(row.text, row.emphasis)}
              </Text>
            ))}
          </Box>
        );
      })}

      {plan.notice && (
        <Text color={visualColor.warning} wrap="truncate-end">
          {hiddenPermissionNotice(hiddenRows, plan.hiddenBlocks)}
        </Text>
      )}

      <Box marginTop={1}>{decisionRow}</Box>
    </Box>
  );
}

/**
 * A detail row's text with its intraline changed span bolded — nested spans in
 * the row's one `<Text>`, so the counted geometry and the ANSI-stripped text are
 * exactly what they were plain.
 */
function emphasizedRow(text: string, emphasis: NonNullable<BoundedContentRow['emphasis']>): React.JSX.Element {
  const { pre, mid, post } = emphasisSpans(text, emphasis);
  return (
    <>
      {pre}
      <Text bold>{mid}</Text>
      {post}
    </>
  );
}

/**
 * Everything about this box's height at this width, in one place.
 *
 * `App` asks for the *claim* built from it and the box renders from it, so the rows
 * the budget hands out and the rows the box draws cannot come from two different
 * calculations — which is exactly how the modal box lost its truncation marker
 * once already.
 */
function boxGeometry(request: AssessedPermissionRequest, waiting: number, columns: number): {
  options: { key: string; label: string }[];
  blocks: { label: string; rows: readonly BoundedContentRow[] }[];
  headingText: string;
  decisionText: string;
  fixedRows: number;
} {
  const options = ruleOptions(request);
  // Text inside the box is laid out in the box's width, not the terminal's: the
  // border and `paddingX` are not available to it.
  const boxColumns = Math.max(1, columns - PERMISSION_BOX_CHROME_COLUMNS);
  // A fileEditor write's content blocks collapse into one diff block here — in the
  // geometry, so the rows the budget counts are the rows the box draws.
  const blocks = permissionDisplayDetails(request).map((detail) => ({
    label: detail.label,
    rows: permissionDetailRows(detail.value, boxColumns, detail.diff),
  }));
  const headingText = `${visualMarker.permission} permission required (${request.kind} — ${request.riskReason})${
    waiting > 0 ? ` — ${waiting} more queued` : ''
  }`;
  const decisionText = `allow? y n${
    options.length > 0 ? ` always: ${options.map((option) => `${option.key}=${option.label}`).join(' ')}` : ''
  } esc=deny`;
  // The heading and the decision row wrap on a narrow terminal, so they are counted
  // rather than assumed to be one row each. Border + heading + summary + the blank
  // row above the decision + decision.
  const fixedRows =
    2 + wrapToRows(headingText, boxColumns).length + 1 + 1 + wrapToRows(decisionText, boxColumns).length;

  return { options, blocks, headingText, decisionText, fixedRows };
}

/** Rows this box wants at this width, for `frameBudget`. */
export function permissionBoxClaim(
  request: AssessedPermissionRequest,
  waiting: number,
  columns: number,
): number {
  const { blocks, fixedRows } = boxGeometry(request, waiting, columns);
  return permissionBoxWanted(blocks.map((block) => block.rows.length), fixedRows);
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
