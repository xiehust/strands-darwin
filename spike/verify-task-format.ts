/** Focused, network-free checks for background task transcript formatting. */
import type { BackgroundTaskStatus } from '../src/tools/background-bash.js';
import {
  formatTaskCompletion,
  formatTaskDuration,
  formatTasksReport,
  summarizeTaskCommand,
  taskElapsedMs,
} from '../src/tui/task-format.js';
import { assert, header, report } from './shared.js';

function task(overrides: Partial<BackgroundTaskStatus> = {}): BackgroundTaskStatus {
  return {
    taskId: 'bg-12345678-1234-1234-1234-123456789abc',
    state: 'running',
    command: '  pnpm   test\n --filter   long-name  ',
    pid: 123,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    exitCode: null,
    signal: null,
    outputPath: '/tmp/task.log',
    outputBytes: 0,
    ...overrides,
  };
}

header('background task formatting');
assert('command summaries normalize whitespace', summarizeTaskCommand(task().command) === 'pnpm test --filter long-name');
assert('command summaries are bounded with an ellipsis', summarizeTaskCommand('x'.repeat(100), 10) === 'xxxxxxxxx…');
assert('command truncation preserves complete Unicode code points', summarizeTaskCommand(`${'x'.repeat(8)}😀tail`, 10) === 'xxxxxxxx😀…');

assert('invalid and negative elapsed time clamp to zero', taskElapsedMs(task({ startedAt: 'bad' }), 1) === 0 && taskElapsedMs(task(), Date.parse('2025-01-01')) === 0);
assert('running duration ends at report time', taskElapsedMs(task(), Date.parse('2026-01-01T00:00:05Z')) === 5_000);
assert('terminal duration ends at finishedAt', taskElapsedMs(task({ finishedAt: '2026-01-01T00:01:05Z' }), Date.parse('2030-01-01')) === 65_000);
assert('durations use compact stable units', formatTaskDuration(5_900) === '5s' && formatTaskDuration(65_000) === '1m 5s');
assert('empty report states current-run scope', formatTasksReport([]).includes('none in this run'));
const reportText = formatTasksReport([
  task(),
  task({ state: 'succeeded', finishedAt: '2026-01-01T00:00:02Z' }),
], Date.parse('2026-01-01T00:00:05Z'));
assert('task reports include short id, states, elapsed time, and normalized command', reportText.includes('bg-12345678') && reportText.includes('running') && reportText.includes('5s') && reportText.includes('succeeded') && reportText.includes('pnpm test --filter long-name'));
const failure = formatTaskCompletion(task({ state: 'failed', finishedAt: '2026-01-01T00:00:02Z', exitCode: 7, signal: 'SIGTERM' }));
assert('failure notices include state, elapsed time, and all available exit metadata', failure.includes('failed') && failure.includes('2s') && failure.includes('exit 7') && failure.includes('signal SIGTERM'));
report();
