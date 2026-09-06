/**
 * Background-task wakes (SER-069): the pure projections behind "a finished
 * `bash start` job wakes the agent".
 *
 * When a background job reaches a terminal state, the manager publishes exactly
 * one immutable snapshot. Today's transcript notice tells the *user*; this module
 * composes the one bounded, session-originated prompt that tells the *model* —
 * delivered through the ordinary prompt queue as a distinct entry kind, drained at
 * idle through `submit()`, so it is one ordinary turn (hooks, permission gate,
 * trajectory barrier, `TurnComplete`) and never a mid-stream injection.
 *
 * Nothing here is I/O and nothing here decides *when* a wake is sent — the App
 * owns the queue state machine and the runtime owns the "already delivered via
 * `wait`/`status`" ledger. This module owns:
 *
 * - the model-facing text (`formatTaskNotification`): task id, command, state,
 *   exit code/signal, elapsed time and an output tail, bounded well under the
 *   trajectory record's field cap, in a vocabulary the model can act on;
 * - the structured fields the record, the transcript row and the queue row are
 *   composed from (`taskNotificationFields`);
 * - the one-row projections (`taskWakeQueueTag`, `formatTaskWakeNotice`) the
 *   queue listing and the `<Static>` transcript print, distinct from user text.
 */

import type { BackgroundTaskStatus } from '../tools/background-bash.js';
import type { BackgroundTail } from '../tools/background-tail.js';
import type { TaskNotificationFields } from '../trajectory/record.js';
import { formatTaskDuration, formatTaskId, summarizeTaskCommand, taskElapsedMs } from './task-format.js';

/** Element name of the model-facing block; also the queue-entry `kind`'s vocabulary. */
export const TASK_NOTIFICATION_TAG = 'task-notification';
/** Output lines read from the end of the job's log for the wake; the model can read more with `bash output`. */
export const TASK_WAKE_TAIL_LINES = 20;
/** Per-line cap inside the wake body, by code point. */
export const TASK_WAKE_TAIL_LINE_CODE_POINTS = 400;
/** Whole-tail cap inside the wake body, by code point. */
export const TASK_WAKE_TAIL_CODE_POINTS = 2_000;
/** The command as the model sees it in the body, by code point (the notice row uses the shorter label). */
export const TASK_WAKE_COMMAND_CODE_POINTS = 400;

/** The identifying fields of one terminal snapshot; `running` is never a wake. */
export function taskNotificationFields(task: BackgroundTaskStatus): TaskNotificationFields | undefined {
  if (task.state === 'running') return undefined;
  return {
    taskId: task.taskId,
    command: task.command,
    state: task.state,
    exitCode: task.exitCode,
    signal: task.signal,
  };
}

/** End-first truncation by code point; never splits a code point. */
function capCodePoints(text: string, limit: number): string {
  const points = [...text];
  if (points.length <= limit) return text;
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * Body text may not close the element early: a job whose output prints the closing
 * tag gets one backslash inside it, the same neutralisation the subagent report
 * projection applies to framing imitation, never a removal.
 */
function neutraliseClosingTag(text: string): string {
  return text.replace(new RegExp(`</${TASK_NOTIFICATION_TAG}`, 'gi'), `<\\/${TASK_NOTIFICATION_TAG}`);
}

function tailLines(tail: BackgroundTail | undefined): string[] {
  if (tail === undefined || tail.kind === 'unavailable') return ['(output unavailable)'];
  if (tail.kind === 'empty') return ['(no output)'];
  const lines: string[] = [];
  let spent = 0;
  // Newest lines are the ones that explain a failure; keep from the end.
  for (let index = tail.lines.length - 1; index >= 0; index -= 1) {
    const line = capCodePoints(tail.lines[index] as string, TASK_WAKE_TAIL_LINE_CODE_POINTS);
    const cost = [...line].length + 1;
    if (spent + cost > TASK_WAKE_TAIL_CODE_POINTS) break;
    spent += cost;
    lines.unshift(line);
  }
  const omitted = tail.lines.length - lines.length;
  return omitted > 0 ? [`… ${omitted} earlier line(s) omitted`, ...lines] : lines;
}

/**
 * The model-facing text of one wake. Every attribute value is manager-owned and
 * character-safe (validated id, fixed state names, numbers, signal names); the
 * command and output ride in the body, bounded and unable to close the element.
 */
export function formatTaskNotification(
  task: BackgroundTaskStatus,
  tail: BackgroundTail | undefined,
  nowMs = Date.now(),
): string {
  const fields = taskNotificationFields(task) ?? {
    taskId: task.taskId, command: task.command, state: 'failed' as const, exitCode: task.exitCode, signal: task.signal,
  };
  const attributes = [
    `task="${fields.taskId}"`,
    `state="${fields.state}"`,
    `exitCode="${fields.exitCode === null ? '' : fields.exitCode}"`,
    `signal="${fields.signal ?? ''}"`,
    `elapsed="${formatTaskDuration(taskElapsedMs(task, nowMs))}"`,
  ].join(' ');
  const outcome =
    fields.state === 'succeeded'
      ? 'finished successfully'
      : fields.state === 'stopped'
        ? 'was stopped'
        : `failed${fields.exitCode === null ? '' : ` with exit code ${fields.exitCode}`}${fields.signal === null ? '' : ` (signal ${fields.signal})`}`;
  const lines = tailLines(tail);
  const body = [
    `A background bash job you started with \`bash start\` ${outcome}. This turn was started by that completion, not by the user.`,
    `command: ${capCodePoints(fields.command.replace(/\s*\n\s*/g, ' '), TASK_WAKE_COMMAND_CODE_POINTS)}`,
    `output tail (last ${lines.length} line(s); \`bash output\` with taskId "${fields.taskId}" reads the full log from your cursor):`,
    ...lines,
    'If work you planned depends on this result, continue it now; otherwise reply briefly with what the result means.',
  ].join('\n');
  return `<${TASK_NOTIFICATION_TAG} ${attributes}>\n${neutraliseClosingTag(body)}\n</${TASK_NOTIFICATION_TAG}>`;
}

/** Exit metadata as the rows print it: `exit 1`, `signal SIGTERM`, or nothing for a clean success. */
function outcomeDetail(fields: TaskNotificationFields): string {
  const parts = [
    fields.exitCode === null || (fields.state === 'succeeded' && fields.exitCode === 0)
      ? undefined
      : `exit ${fields.exitCode}`,
    fields.signal === null ? undefined : `signal ${fields.signal}`,
  ].filter((value): value is string => value !== undefined);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/**
 * The bracketed tag a queued wake row carries after the `queued ·` marker, in the
 * `[image]` attachment's vocabulary: `[task bg-1a2b3c4d succeeded]`. A user cannot
 * type it into the queue — user rows never start with `[task `.
 */
export function taskWakeQueueTag(fields: TaskNotificationFields): string {
  return `[task ${formatTaskId(fields.taskId)} ${fields.state}]`;
}

/**
 * The transcript row written when a wake is actually sent — composed from the
 * recorded fields only, so a replayed `taskNotification` record prints the same
 * row. Deliberately a notice and not a `you>` row: the user typed nothing.
 */
export function formatTaskWakeNotice(fields: TaskNotificationFields): string {
  return `task wake · ${formatTaskId(fields.taskId)} ${fields.state}${outcomeDetail(fields)} — ${summarizeTaskCommand(fields.command)} → sent to the model as this turn`;
}

/** The notice a wake that could not be delivered leaves behind (its turn was cancelled or failed). */
export function formatTaskWakeUndelivered(fields: TaskNotificationFields): string {
  return `task wake · ${formatTaskId(fields.taskId)} not delivered — its turn was cancelled or failed and is not re-sent; the job's output is still readable via /tasks or bash output`;
}
