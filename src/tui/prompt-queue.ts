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
 */

import type { ImageBlock } from '@strands-agents/sdk';

/** One live-only queued submission; image bytes never enter any durable record. */
export interface QueuedPrompt {
  readonly text: string;
  readonly image?: ImageBlock;
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
 * trimmed submission's first word.
 */
const BUSY_REFUSED_COMMANDS = new Set(['/clear', '/compact', '/model', '/rewind', '/exit', '/quit']);

/** True when a busy submission must be refused (draft retained) rather than queued. */
export function refusesToQueue(text: string): boolean {
  const firstWord = text.split(/\s/, 1)[0] ?? '';
  return BUSY_REFUSED_COMMANDS.has(firstWord);
}

/**
 * One queued entry as one counted terminal row: marker, then the entry with its
 * newlines shown as `⏎` so a multi-line entry stays one row — the row is drawn
 * as a single `<Text wrap="truncate-end">`, so width overflow truncates and can
 * never grow a row the budget did not count.
 */
export function queueRowText(value: QueuedPrompt | string): string {
  const entry = typeof value === 'string' ? { text: value } : value;
  const attachment = entry.image === undefined ? '' : '[image] ';
  return `${QUEUED_MARKER} ${attachment}${entry.text.replace(/\n/g, ' ⏎ ')}`;
}

/**
 * The draft a take-back (or a cancel-return) composes: queued entries one per
 * line, oldest first, **ahead of any typed text** — the Claude Code shape. The
 * entries were going to be sent before anything typed later, so they read in
 * that order too.
 */
export function takeBackDraft(entries: readonly (QueuedPrompt | string)[], draft: string): string {
  const queued = entries.map((entry) => typeof entry === 'string' ? entry : entry.text).join('\n');
  return draft === '' ? queued : `${queued}\n${draft}`;
}

/**
 * The busy hint's queue segment, or an empty string while nothing is queued.
 * It rides behind the live elapsed/spend readout and ahead of the static
 * command hints, on the same one truncated `<Text>` row — the count is how the
 * queue stays visible even when the listing's rows were all cut.
 */
export function queuedCountHint(count: number): string {
  return count > 0 ? ` · ${count} queued` : '';
}
