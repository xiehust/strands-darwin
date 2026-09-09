/**
 * The queued mid-turn submissions (SER-027), listed above the input box.
 *
 * Settled-task notifications share one summary row; user submissions follow in
 * their original order, with one `… n more queued` row for whatever the grant cut.
 * This is only a projection: the FIFO still drains unchanged. Every counted row
 * is one `<Text wrap="truncate-end">`. The block is a sibling of the input box
 * inside the chrome column, so `InputBox`'s parent-relative metrics absorb its height and
 * the frame-absolute cursor stays on the draft row it names. It stays rendered
 * while a permission prompt replaces the input box: the queue is held untouched
 * through a pending decision, and a held queue nobody can see would be the
 * invisible accumulation the busy hint's count exists to prevent.
 */
import { Box, Text } from 'ink';
import React from 'react';

import { hiddenQueuedNotice, planQueueList } from './frame-budget.js';
import { partitionQueue, queueNotificationSummary, queueRowText, type QueuedPrompt } from './prompt-queue.js';

export function QueuedMessages({
  entries,
  maxRows,
}: {
  /** Queue order: index 0 drains next. */
  readonly entries: readonly (QueuedPrompt | string)[];
  /** Rows this block may draw; the budget's `queued` grant. */
  readonly maxRows: number;
}): React.JSX.Element | null {
  if (entries.length === 0 || maxRows <= 0) return null;
  const { user, wakes } = partitionQueue(entries.map((entry) => typeof entry === 'string' ? { text: entry } : entry));
  const summary = queueNotificationSummary(wakes);
  const userRows = Math.max(0, maxRows - (summary === undefined ? 0 : 1));
  const plan = planQueueList(user.length, userRows);
  // With only one row, state both counts rather than silently hiding typed work.
  const hideAllUserRows = userRows === 0 && user.length > 0;

  return (
    <Box flexDirection="column">
      {summary !== undefined && (
        <Text dimColor wrap="truncate-end">{hideAllUserRows ? `${user.length} queued · ${wakes.length} notifications pending` : summary}</Text>
      )}
      {user.slice(0, plan.shown).map((entry, index) => (
        <Text key={`queued-${index}`} dimColor wrap="truncate-end">
          {queueRowText(entry)}
        </Text>
      ))}
      {userRows > 0 && plan.hiddenEntries > 0 && (
        <Text dimColor wrap="truncate-end">{hiddenQueuedNotice(plan.hiddenEntries)}</Text>
      )}
    </Box>
  );
}
