import type { BackgroundTaskStatus } from '../tools/background-bash.js';

const COMMAND_SUMMARY_LIMIT = 72;

/** Keeps task ids recognizable without printing an entire UUID in every notice. */
export function formatTaskId(taskId: string): string {
  const match = /^bg-([0-9a-f]{8})[0-9a-f-]*$/i.exec(taskId);
  return match === null ? taskId : `bg-${match[1]}`;
}

/** Makes arbitrary shell source a bounded, single-line terminal label. */
export function summarizeTaskCommand(command: string, limit = COMMAND_SUMMARY_LIMIT): string {
  const normalized = command.replace(/\s+/g, ' ').trim();
  if (limit <= 0) return '';
  const codePoints = [...normalized];
  if (codePoints.length <= limit) return normalized;
  if (limit === 1) return '…';
  return `${codePoints.slice(0, limit - 1).join('')}…`;
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

export function formatTasksReport(
  tasks: readonly BackgroundTaskStatus[],
  nowMs = Date.now(),
): string {
  if (tasks.length === 0) return 'background tasks — none in this run';
  return [
    `background tasks — this run (${tasks.length})`,
    ...tasks.map((task) =>
      `  ${formatTaskId(task.taskId)}  ${task.state.padEnd(9)}  ${formatTaskDuration(taskElapsedMs(task, nowMs)).padStart(7)}  ${summarizeTaskCommand(task.command)}`,
    ),
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
