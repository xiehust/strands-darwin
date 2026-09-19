/** Exact, reversible rule review in the permission modal's existing row grant. */
import { Box, Text } from 'ink';
import React from 'react';

import type { AssessedPermissionRequest } from '../agent/permission.js';

export interface RuleReview {
  readonly request: AssessedPermissionRequest;
  readonly rule: string;
  readonly offset: number;
  readonly columns: number;
  readonly maxRows: number;
}

/** JSON string, ASCII only: controls, bidi, combining marks and surrogates stay visible. */
export function exactRuleText(rule: string): string {
  // Ink trims row-edge spaces: escaping them also makes whitespace-only path
  // segments reviewable and keeps page concatenation lossless at every width.
  return JSON.stringify(rule).replace(/[ \u007f-\uffff]/g, (unit) =>
    `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export const RULE_REVIEW_KEYS = 'enter=next/save b=back y=once n/esc=deny';
const MIN_REVIEW_COLUMNS = RULE_REVIEW_KEYS.length;

/** Same geometry drives the claim, render and confirmation guard. No content cap. */
export function ruleReviewLayout(rule: string, columns: number, maxRows: number, offset = 0): {
  readonly rows: readonly string[];
  readonly end: number;
  readonly total: number;
  readonly ready: boolean;
} {
  const text = exactRuleText(rule);
  const width = Math.max(1, columns);
  const ready = columns >= MIN_REVIEW_COLUMNS && maxRows >= 3;
  const end = ready ? Math.min(text.length, offset + width * (maxRows - 2)) : offset;
  const rows: string[] = [];
  for (let at = offset; at < end; at += width) rows.push(text.slice(at, Math.min(end, at + width)));
  return { rows, end, total: text.length, ready };
}

export function ruleReviewClaim(rule: string, columns: number): number {
  return 2 + Math.ceil(exactRuleText(rule).length / Math.max(1, columns));
}

export function PermissionRulePreview({ review }: { readonly review: RuleReview }): React.JSX.Element {
  const { rows, end, total, ready } = ruleReviewLayout(review.rule, review.columns, review.maxRows, review.offset);
  if (!ready) {
    // Confirmation is impossible here. Never truncate a rule and silently save it.
    const fallback = [review.columns >= 26 ? 'b=back n/esc=deny; resize' : 'b back n no', 'save disabled; resize to review'];
    return <Box flexDirection="column">{fallback.slice(0, Math.max(0, review.maxRows)).map((row) =>
      <Text key={row} wrap="truncate-end">{row}</Text>)}</Box>;
  }
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{`allow rule (JSON) ${review.offset + 1}-${end}/${total}`}</Text>
      {rows.map((row, index) => <Text key={index} wrap="truncate-end">{row}</Text>)}
      <Text bold wrap="truncate-end">{end < total
        ? 'enter=next b=back y=once n/esc=deny'
        : 'enter=save b=back y=once n/esc=deny'}</Text>
    </Box>
  );
}
