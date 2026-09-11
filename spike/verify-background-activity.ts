/**
 * Background activity: real manager jobs and the production CLI/App in a pty.
 * Local scripted transport (task-wake-cli), private HOME, no provider/network.
 * Jobs are released by files, never timing assumptions. Current-frame assertions
 * exclude historical repaints; idle silence proves there is no background tick.
 * Run: pnpm tsx spike/verify-background-activity.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BackgroundBashManager } from '../src/tools/background-bash.js';
import { runningTasksHeader } from '../src/tui/task-format.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

const HOME = ownPrivateHome('background-activity');
const ROOT = path.join(HOME, 'project');
await mkdir(ROOT);

header('background activity — real manager transitions');
const manager = new BackgroundBashManager(ROOT, 'activity');
const counts: number[] = [];
const terminal: string[] = [];
manager.subscribeActivity(() => { throw new Error('isolated display failure'); });
manager.subscribeActivity(async () => { throw new Error('isolated async display failure'); });
const unsubscribe = manager.subscribeActivity(() => { counts.push(manager.runningCount); });
manager.subscribe((task) => { terminal.push(task.taskId); });
async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  if (!predicate()) throw new Error('activity transition timed out');
}
try {
  assert('empty snapshot is zero and subscribing does not publish', manager.runningCount === 0 && counts.length === 0);
  const first = await manager.start('echo untouched; while [ ! -f release-manager ]; do sleep .05; done');
  const second = await manager.start('while [ ! -f release-manager ]; do sleep .05; done; exit 7');
  assert('starts publish immediately without a completion event', counts.join(',') === '1,2' && terminal.length === 0);
  const lateCounts: number[] = [];
  const unsubscribeLate = manager.subscribeActivity(() => { lateCounts.push(manager.runningCount); });
  assert('a late subscriber can read the current count without replay', manager.runningCount === 2 && lateCounts.length === 0);
  await delay(150);
  for (let i = 0; i < 10; i += 1) assert('snapshot reads remain stable', manager.runningCount === 2);
  assert('output and idle time never publish activity', counts.join(',') === '1,2');
  await writeFile(path.join(ROOT, 'release-manager'), 'release');
  await eventually(() => terminal.length === 2);
  assert('success and failure remove only running jobs', manager.runningCount === 0 && counts.join(',') === '1,2,1,0');
  assert('late subscribers see only subsequent transitions', lateCounts.join(',') === '1,0');
  const output = await manager.output(first.taskId);
  assert('display reads never consume the output cursor', output.startOffset === 0 && output.output === 'untouched\n');
  assert('completed history is retained but not counted', (await manager.list()).length === 2 && (await manager.status(second.taskId)).state === 'failed');
  const stopped = await manager.start('sleep 1000');
  await manager.stop(stopped.taskId);
  assert('stop publishes one terminal activity transition', counts.slice(-2).join(',') === '1,0');
  const beforeRepeatStop = counts.length;
  await manager.stop(stopped.taskId);
  assert('repeat stop cannot publish twice', counts.length === beforeRepeatStop);
  unsubscribe();
  unsubscribeLate();
  await manager.start('sleep 1000');
  await manager.shutdown();
  assert('shutdown clears the count; unsubscribed observers stay silent', manager.runningCount === 0 && counts.length === beforeRepeatStop);
  let refused = false;
  try { await manager.start('true'); } catch { refused = true; }
  assert('refused launches add no activity', refused && manager.runningCount === 0);
} finally {
  await manager.shutdown();
}

header('background activity — responsive label');
assert('zero is silent', runningTasksHeader(0, 80).label === '' && runningTasksHeader(0, 80).hint === '');
assert('wide view offers details', runningTasksHeader(1, 80).label === ' · ● 1 task running' && runningTasksHeader(1, 80).hint === ' · /tasks');
assert('multiple jobs use plural', runningTasksHeader(2, 80).label === ' · ● 2 tasks running');
assert('hint yields before the full label', runningTasksHeader(1, 20).label === ' · ● 1 task running' && runningTasksHeader(1, 20).hint === '');
assert('narrow view keeps activity and count', runningTasksHeader(1, 15).label === ' · ● 1 running');
assert('tight view keeps a count', runningTasksHeader(12, 8).label === ' · ● 12');

header('background activity — idle, busy, resize and clear in a real pty');
await mkdir(path.join(HOME, '.darwin'), { recursive: true });
await writeFile(path.join(HOME, '.darwin/config.json'), JSON.stringify({
  permissionMode: 'yolo', backgroundTaskWake: false, memory: false, trajectory: false,
}));
const tui = startTui({
  cwd: ROOT, cols: 80, rows: 32,
  entry: path.join(REPO_ROOT, 'spike/fixtures/task-wake-cli.ts'),
  env: { HOME, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' },
});
// A pty emits CRLF: the carriage return is not a visible terminal cell.
const title = () => (tui.frame.split('\n').find((line) => line.includes('◆ DARWIN')) ?? '').replace(/\r/g, '');
const settled = (predicate: () => boolean, label: string) => tui.waitUntil(predicate, { timeoutMs: 30_000, settleMs: 250, label });
const release = (marker: string) => writeFile(path.join(ROOT, `activity-release-${marker}`), 'release');
try {
  await tui.waitFor('you>');
  assert('empty session has no background indicator', !title().includes('●'));
  tui.submit('start-activity success');
  await settled(() => title().includes('ready · ● 1 task running · /tasks'), 'one job while ready');
  assert('running job is visible after the dispatching turn ends', title().includes('ready · ● 1 task running'));
  tui.send('unsent draft');
  await settled(() => tui.frame.includes('you> unsent draft'), 'draft remains editable');
  const idleBytes = tui.raw.length;
  await delay(350);
  assert('background-only activity adds no animation or output tick', tui.raw.length === idleBytes);

  tui.resize(40, 32);
  await settled(() => title().includes('ready · ● 1 task running') && !title().includes('/tasks'), 'hint yields first');
  assert('medium width keeps the full task label without the hint', title().length <= 40);
  tui.resize(24, 32);
  await settled(() => title().includes('ready · ● 1') && !title().includes('running'), 'count-only title');
  assert('tight width retains the task count', title().length <= 24);
  tui.resize(30, 32);
  await settled(() => title().includes('ready · ● 1 running'), 'compact running label');
  assert('narrow title keeps count and drops hint', !title().includes('/tasks') && title().length <= 30);
  tui.resize(80, 32);
  await settled(() => title().includes('1 task running · /tasks'), 'wide label restored');
  await release('success');
  await settled(() => title().includes('ready') && !title().includes('●'), 'completion clears activity');
  assert('idle completion preserves the unsent draft', tui.frame.includes('you> unsent draft'));
  assert('completion still appears in the transcript', tui.screen.includes('succeeded in'));
  tui.send('\u0015');
  await settled(() => !tui.frame.includes('unsent draft'), 'draft cleared');

  tui.submit('start-activity failure');
  await settled(() => title().includes('ready · ● 1 task running'), 'second job');
  tui.submit('start-activity-block busy');
  await settled(() => title().includes('working · ● 2 tasks running'), 'foreground and background coexist');
  await release('failure');
  await settled(() => title().includes('working · ● 1 task running'), 'failure reduces count mid-turn');
  assert('failure keeps the existing notification', tui.screen.includes('failed (exit 7)'));
  await writeFile(path.join(ROOT, 'wake-block-release'), 'release');
  await settled(() => title().includes('ready · ● 1 task running'), 'model turn finished');

  const beforeClear = tui.mark();
  tui.submit('/clear');
  await tui.waitFor('new session', { from: beforeClear, timeoutMs: 30_000 });
  await settled(() => title().includes('ready · ● 1 task running'), 'inherited manager after clear');
  assert('clear preserves process-owned running jobs', title().includes('1 task running'));
  await release('busy');
  await settled(() => title().includes('ready') && !title().includes('●'), 'successor observes completion');
  const calls = (await readFile(path.join(ROOT, 'wake-model-calls.jsonl'), 'utf8')).trim().split('\n');
  assert('display transitions and clear make no extra model calls', calls.length === 6);
  tui.submit('/exit');
  assert('exit cleans up successfully', await tui.exitedWithin(30_000) === 0);
} finally {
  tui.kill();
}

report();
