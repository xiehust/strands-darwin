import type { BackgroundTaskStatus } from '../tools/background-bash.js';
import { TASK_TAIL_LINES, type BackgroundTail } from '../tools/background-tail.js';

const COMMAND_SUMMARY_LIMIT = 72;
/** Width of one tail row's text; with its indent and marker it matches the widest job row. */
export const TASK_TAIL_LINE_LIMIT = 100;
/** Indent plus a marker no job row starts with, so tail rows cannot read as jobs. */
export const TASK_TAIL_PREFIX = '    │ ';
export const TASK_TAIL_EMPTY_NOTICE = '(no output yet)';
export const TASK_TAIL_UNAVAILABLE_NOTICE = '(output unavailable)';

/** Keeps task ids recognizable without printing an entire UUID in every notice. */
export function formatTaskId(taskId: string): string {
  const match = /^bg-([0-9a-f]{8})[0-9a-f-]*$/i.exec(taskId);
  return match === null ? taskId : `bg-${match[1]}`;
}

/** End-first truncation by code point with a one-character ellipsis; never splits a code point. */
function truncateEnd(text: string, limit: number): string {
  if (limit <= 0) return '';
  const codePoints = [...text];
  if (codePoints.length <= limit) return text;
  if (limit === 1) return '…';
  return `${codePoints.slice(0, limit - 1).join('')}…`;
}

/** Makes arbitrary shell source a bounded, single-line terminal label. */
export function summarizeTaskCommand(command: string, limit = COMMAND_SUMMARY_LIMIT): string {
  return truncateEnd(command.replace(/\s+/g, ' ').trim(), limit);
}

/**
 * The rows under one job: its recent output lines, or one stated reason there are none.
 * Lines arrive already ANSI-stripped and tab-expanded from the reader; only the width is
 * applied here, so replay/export see exactly what the transcript showed.
 */
export function formatTaskTail(tail: BackgroundTail | undefined, limit = TASK_TAIL_LINE_LIMIT): string[] {
  if (tail === undefined || tail.kind === 'unavailable') return [`${TASK_TAIL_PREFIX}${TASK_TAIL_UNAVAILABLE_NOTICE}`];
  if (tail.kind === 'empty') return [`${TASK_TAIL_PREFIX}${TASK_TAIL_EMPTY_NOTICE}`];
  return tail.lines
    .slice(Math.max(0, tail.lines.length - TASK_TAIL_LINES))
    .map((line) => `${TASK_TAIL_PREFIX}${truncateEnd(line, limit)}`);
}

/** Defensive elapsed time calculation over the manager's ISO timestamp contract. */
export function taskElapsedMs(task: BackgroundTaskStatus, nowMs = Date.now()): number {
  const started = Date.parse(task.startedAt);
  const finished = task.finishedAt === null ? nowMs : Date.parse(task.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

/** Compact duration for transcript rows; terminal tasks use their fixed finish time. */
export function formatTaskDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The `/tasks` notice. With `tails` (keyed by task id) every job row is followed by its
 * tail rows — a task the reader did not cover reads as unavailable; without `tails` the
 * report keeps its original one-row-per-job shape.
 */
export function formatTasksReport(
  tasks: readonly BackgroundTaskStatus[],
  nowMs = Date.now(),
  tails?: ReadonlyMap<string, BackgroundTail>,
): string {
  if (tasks.length === 0) return 'background tasks — none in this run';
  return [
    `background tasks — this run (${tasks.length})`,
    ...tasks.flatMap((task) => [
      `  ${formatTaskId(task.taskId)}  ${task.state.padEnd(9)}  ${formatTaskDuration(taskElapsedMs(task, nowMs)).padStart(7)}  ${summarizeTaskCommand(task.command)}`,
      ...(tails === undefined ? [] : formatTaskTail(tails.get(task.taskId))),
    ]),
  ].join('\n');
}

export function formatTaskCompletion(task: BackgroundTaskStatus): string {
  const exitMetadata = [
    task.exitCode === null ? undefined : `exit ${task.exitCode}`,
    task.signal === null ? undefined : `signal ${task.signal}`,
  ].filter((value): value is string => value !== undefined).join(', ');
  const metadata = task.state === 'failed' && exitMetadata !== '' ? ` (${exitMetadata})` : '';
  return `background task ${formatTaskId(task.taskId)} ${task.state}${metadata} in ${formatTaskDuration(taskElapsedMs(task))} — ${summarizeTaskCommand(task.command)}`;
}
