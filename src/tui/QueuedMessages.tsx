/**
 * The queued mid-turn submissions (SER-027), listed above the input box.
 *
 * One `<Text wrap="truncate-end">` per counted row — the live-frame rule — with
 * the head of the queue (next to send) first and one `… n more queued` row for
 * whatever the grant cut. The block is a sibling of the input box inside the
 * chrome column, so `InputBox`'s parent-relative metrics absorb its height and
 * the frame-absolute cursor stays on the draft row it names. It stays rendered
 * while a permission prompt replaces the input box: the queue is held untouched
 * through a pending decision, and a held queue nobody can see would be the
 * invisible accumulation the busy hint's count exists to prevent.
 */
import { Box, Text } from 'ink';
import React from 'react';

import { hiddenQueuedNotice, planQueueList } from './frame-budget.js';
import { queueRowText, type QueuedPrompt } from './prompt-queue.js';

export function QueuedMessages({
  entries,
  maxRows,
}: {
  /** Queue order: index 0 drains next. */
  readonly entries: readonly (QueuedPrompt | string)[];
  /** Rows this block may draw; the budget's `queued` grant. */
  readonly maxRows: number;
}): React.JSX.Element | null {
  const plan = planQueueList(entries.length, maxRows);
  if (plan.shown === 0 && (entries.length === 0 || maxRows <= 0)) return null;

  return (
    <Box flexDirection="column">
      {entries.slice(0, plan.shown).map((entry, index) => (
        <Text key={`queued-${index}`} dimColor wrap="truncate-end">
          {queueRowText(entry)}
        </Text>
      ))}
      {plan.hiddenEntries > 0 && (
        <Text dimColor wrap="truncate-end">{hiddenQueuedNotice(plan.hiddenEntries)}</Text>
      )}
    </Box>
  );
}
