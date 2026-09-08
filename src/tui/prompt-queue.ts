/**
 * The prompt queue: what a submission during a busy session becomes (SER-027).
 *
 * This deliberately supersedes SER-010's "retained, never queued" busy-submit
 * contract, by explicit user product decision (2026-08-19). A prompt or `!`
 * command submitted while a turn streams or a `!` command runs leaves the editor
 * and joins this FIFO queue; when the session returns to idle the queue drains
 * one entry at a time through the ordinary submit path, so every entry keeps its
 * own meaning (its own turn, its own `!` run, its own trajectory `userInput` line
 * written exactly at send time). Nothing here is I/O and nothing here decides
 * *when* to send — the App owns the state machine; this module owns the pure
 * projections it shares with the frame budget and the tests:
 *
 * - the one-row projection of an entry (`queueRowText`),
 * - the draft a take-back composes (`takeBackDraft`),
 * - the hint segment that states the count (`queuedCountHint`) — nothing
 *   invisible may accumulate.
 *
 * The queue is live-session state only: `/clear` drops it with the conversation,
 * a cancelled or failed turn returns it to the editor unsent, and nothing about
 * an entry is recorded until the moment it is actually sent.
 *
 * Two entry kinds share the FIFO (SER-069): what the user typed, and a
 * background-task wake — the session-originated prompt a finished `bash start`
 * job leaves behind so the model learns of the completion without polling. Both
 * drain the same way; only the wake is not the user's to edit (take-back and
 * cancel-return leave it queued) and is recorded as `taskNotification`, never as
 * a `userInput` line, so prompt recall never offers it.
 */

import type { ImageBlock } from '@strands-agents/sdk';

import type { BackgroundDelegationStatus } from '../agent/background-delegation.js';
import type { TaskNotificationFields } from '../trajectory/record.js';
import { delegationWakeLabel } from './subagent-format.js';
import { delegationNotificationFields, formatDelegationNotification, taskWakeQueueTag } from './task-wake.js';

/** One live-only queued user submission; image bytes never enter any durable record. */
export interface QueuedUserPrompt {
  /** Absent or `'user'`: what the user typed. */
  readonly kind?: 'user';
  readonly text: string;
  readonly image?: ImageBlock;
}

/**
 * A background-task wake (SER-069): the session-originated prompt a finished
 * `bash start` job leaves in the queue. Drained through the same `submit()` as a
 * user entry, but it has nothing to edit — take-back and cancel-return leave it in
 * the queue — and it is recorded as `taskNotification`, never `userInput`.
 */
export interface QueuedTaskWake extends TaskNotificationFields {
  readonly kind: 'taskNotification';
  /** The model-facing `<task-notification>` block, already bounded. */
  readonly text: string;
  readonly image?: undefined;
}

export type QueuedPrompt = QueuedUserPrompt | QueuedTaskWake;

export function isTaskWake(entry: QueuedPrompt): entry is QueuedTaskWake {
  return entry.kind === 'taskNotification';
}

/**
 * The delegation wakes (SER-070) an idle session owes right now: one entry per
 * background delegation the SDK still tracks whose run has settled and which has
 * not been queued before. Pure — the App calls it at settlement (when idle) and
 * whenever the session returns to idle, adds the returned ids to `alreadySent`, and
 * appends the entries to the queue. A running delegation is never a wake; a settled
 * one the SDK already delivered is no longer tracked and so never appears.
 */
export function delegationWakeEntries(
  tracked: readonly BackgroundDelegationStatus[],
  alreadySent: ReadonlySet<string>,
  nowMs = Date.now(),
): QueuedTaskWake[] {
  const entries: QueuedTaskWake[] = [];
  for (const delegation of tracked) {
    if (delegation.state === 'running' || alreadySent.has(delegation.taskId)) continue;
    const label = delegationWakeLabel(delegation);
    const fields = delegationNotificationFields(delegation, label);
    if (fields === undefined) continue;
    entries.push({ kind: 'taskNotification', ...fields, text: formatDelegationNotification(delegation, label, nowMs) });
  }
  return entries;
}

/** The queue split by ownership: what the user may take back, and what only drains. */
export function partitionQueue(entries: readonly QueuedPrompt[]): {
  readonly user: QueuedUserPrompt[];
  readonly wakes: QueuedTaskWake[];
} {
  const user: QueuedUserPrompt[] = [];
  const wakes: QueuedTaskWake[] = [];
  for (const entry of entries) {
    if (isTaskWake(entry)) wakes.push(entry);
    else user.push(entry);
  }
  return { user, wakes };
}

/** One clipboard image may be pending or queued at a time, bounding live memory. */
export function hasQueuedImage(entries: readonly QueuedPrompt[]): boolean {
  return entries.some((entry) => entry.image !== undefined);
}


/**
 * Marker every queued row carries. Like `tool ·`, it survives ANSI stripping,
 * monochrome terminals and pty captures, so tests and logs can name the row.
 */
export const QUEUED_MARKER = 'queued ·';

/**
 * Commands that refuse to queue and keep the SER-010 refusal shape instead:
 * each replaces the session or the process, and running one minutes later,
 * unprompted, is worse than asking for a second Enter. Matched against the
 * trimmed submission's first word. `/tangent` (SER-083) rides the `/rewind`
 * rule: its return is the rewind path, and its arming is a statement about
 * "the next prompt", which a queued command could not truthfully make.
 */
const BUSY_REFUSED_COMMANDS = new Set(['/clear', '/compact', '/model', '/rewind', '/tangent', '/exit', '/quit']);

/** True when a busy submission must be refused (draft retained) rather than queued. */
export function refusesToQueue(text: string): boolean {
  const firstWord = text.split(/\s/, 1)[0] ?? '';
  return BUSY_REFUSED_COMMANDS.has(firstWord);
}

/**
 * One queued entry as one counted terminal row: marker, then the entry with its
 * newlines shown as `⏎` so a multi-line entry stays one row — the row is drawn
 * as a single `<Text wrap="truncate-end">`, so width overflow truncates and can
 * never grow a row the budget did not count. A background-task wake shows its
 * bracketed task tag and command label instead of its model-facing text, so the
 * row says what it is rather than imitating a typed prompt.
 */
export function queueRowText(value: QueuedPrompt | string): string {
  const entry = typeof value === 'string' ? { text: value } : value;
  if (isTaskWake(entry)) {
    return `${QUEUED_MARKER} ${taskWakeQueueTag(entry)} ${entry.command.replace(/\s*\n\s*/g, ' ')}`;
  }
  const attachment = entry.image === undefined ? '' : '[image] ';
  return `${QUEUED_MARKER} ${attachment}${entry.text.replace(/\n/g, ' ⏎ ')}`;
}

/**
 * The draft a take-back (or a cancel-return) composes: queued **user** entries one
 * per line, oldest first, **ahead of any typed text** — the Claude Code shape. The
 * entries were going to be sent before anything typed later, so they read in
 * that order too. A wake has nothing to edit and is skipped here: the App keeps
 * it in the queue.
 */
export function takeBackDraft(entries: readonly (QueuedPrompt | string)[], draft: string): string {
  const queued = entries
    .filter((entry) => typeof entry === 'string' || !isTaskWake(entry))
    .map((entry) => typeof entry === 'string' ? entry : entry.text)
    .join('\n');
  if (queued === '') return draft;
  return draft === '' ? queued : `${queued}\n${draft}`;
}

/**
 * The busy hint's queue segment, or an empty string while nothing is queued.
 * It rides behind the live elapsed/spend readout and ahead of the static
 * command hints, on the same one truncated `<Text>` row — the count is how the
 * queue stays visible even when the listing's rows were all cut. Wakes are
 * counted apart from typed entries (` · 1 task wake`), so the hint says what
 * kind of work is waiting.
 */
export function queuedCountHint(count: number, wakeCount = 0): string {
  const typed = count > 0 ? ` · ${count} queued` : '';
  const wakes = wakeCount > 0 ? ` · ${wakeCount} task wake${wakeCount === 1 ? '' : 's'}` : '';
  return `${typed}${wakes}`;
}
