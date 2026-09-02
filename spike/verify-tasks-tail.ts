/**
 * SER-060: `/tasks` shows the last three non-empty output lines of each background job,
 * read as a bounded tail of the job's log — never through the manager's cursor.
 *
 * Network-free, model-free; real jobs through the real `BackgroundBashManager`.
 * Runs against a private HOME because the manager keeps logs under `~/.darwin/sessions`.
 */
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('tasks-tail');

const { BackgroundBashManager } = await import('../src/tools/background-bash.js');
const {
  TASK_TAIL_LINES,
  TASK_TAIL_WINDOW_BYTES,
  readBackgroundTail,
  readBackgroundTails,
  sanitizeTailLine,
} = await import('../src/tools/background-tail.js');
const {
  TASK_TAIL_EMPTY_NOTICE,
  TASK_TAIL_LINE_LIMIT,
  TASK_TAIL_PREFIX,
  TASK_TAIL_UNAVAILABLE_NOTICE,
  formatTasksReport,
} = await import('../src/tui/task-format.js');
type BackgroundTaskStatus = import('../src/tools/background-bash.js').BackgroundTaskStatus;
type BackgroundOutputResult = import('../src/tools/background-bash.js').BackgroundOutputResult;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 5_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await delay(20);
    value = await read();
  }
  return value;
}

function sameOutput(a: BackgroundOutputResult, b: BackgroundOutputResult): boolean {
  return a.output === b.output && a.startOffset === b.startOffset && a.endOffset === b.endOffset && a.hasMore === b.hasMore;
}

/** The report rows that sit under one job row, in order. */
function rowsUnder(reportText: string, taskId: string): string[] {
  const rows = reportText.split('\n');
  const start = rows.findIndex((row) => row.startsWith(`  bg-${taskId.slice(3, 11)}`));
  if (start === -1) return [];
  const under: string[] = [];
  for (const row of rows.slice(start + 1)) {
    if (!row.startsWith(TASK_TAIL_PREFIX)) break;
    under.push(row);
  }
  return under;
}

// Six lines, two of them blank, one whitespace-only, one ANSI-coloured, one with a tab.
const SIX_LINES = "printf 'one\\n\\ntwo\\n   \\n\\033[31mthree red\\033[0m\\nfour\\tfive\\nsix\\n'";

header('tasks tail — sanitizer');
assert('CSI colour sequences are stripped', sanitizeTailLine('\x1b[1;32mok\x1b[0m done') === 'ok done');
assert('OSC hyperlinks are stripped', sanitizeTailLine('\x1b]8;;https://x\x07link\x1b]8;;\x07') === 'link');
assert('tabs become spaces and trailing blanks go', sanitizeTailLine('a\tb  \t') === 'a    b');
assert('other control characters are removed', sanitizeTailLine('a\x07b\x08c') === 'abc');
assert('leading indentation survives', sanitizeTailLine('  nested') === '  nested');

header('tasks tail — real jobs through the real manager');
const root = await mkdtemp(path.join(tmpdir(), 'darwin-tasks-tail-'));
const manager = new BackgroundBashManager(root, 'session-tail');
try {
  const finished = (id: string) => eventually(() => manager.status(id), (status) => status.state !== 'running');

  // (a) formatter shows exactly the last three non-empty lines, ANSI-stripped, bounded, marked.
  const six = await manager.start(SIX_LINES);
  await finished(six.taskId);
  const sixTail = await readBackgroundTail(six.outputPath);
  assert('the reader returns lines for a job with output', sixTail.kind === 'lines');
  if (sixTail.kind === 'lines') {
    assert('exactly TASK_TAIL_LINES lines are kept', sixTail.lines.length === TASK_TAIL_LINES && TASK_TAIL_LINES === 3);
    assert('blank and whitespace-only lines are dropped, so the tail is the last three non-empty ones', JSON.stringify(sixTail.lines) === JSON.stringify(['three red', 'four    five', 'six']));
    assert('ANSI is stripped before the lines reach the formatter', !sixTail.lines.some((line) => line.includes('\x1b')));
  }
  const tasksA = await manager.list();
  const reportA = formatTasksReport(tasksA, Date.now(), await readBackgroundTails(tasksA));
  const underSix = rowsUnder(reportA, six.taskId);
  assert('the report puts three marked, indented rows under the job row', underSix.length === 3 && underSix.every((row) => row.startsWith(TASK_TAIL_PREFIX)));
  assert('the rows are the sanitized lines in order', underSix.map((row) => row.slice(TASK_TAIL_PREFIX.length)).join('|') === 'three red|four    five|six');
  assert('the report carries no escape bytes', !reportA.includes('\x1b'));
  assert('no tail row can be mistaken for a job row', !underSix.some((row) => /^\s{2}bg-/.test(row)));

  // (b) the cursor: tail then output equals a control run's output; tail after output unchanged.
  const control = await manager.start(SIX_LINES);
  const probe = await manager.start(SIX_LINES);
  await finished(control.taskId);
  await finished(probe.taskId);
  const controlOutput = await manager.output(control.taskId);
  const probeTailBefore = await readBackgroundTail(probe.outputPath);
  await readBackgroundTails(await manager.list());
  const probeOutput = await manager.output(probe.taskId);
  assert('control output consumed the whole log', controlOutput.startOffset === 0 && controlOutput.hasMore === false && controlOutput.output.includes('six'));
  assert('output after a tail read is byte-identical to the control run (startOffset, endOffset, output, hasMore)', sameOutput(probeOutput, controlOutput));
  const probeSecond = await manager.output(probe.taskId);
  const controlSecond = await manager.output(control.taskId);
  assert('a second output call is empty at the same end offset for both', sameOutput(probeSecond, controlSecond) && probeSecond.output === '' && probeSecond.startOffset === controlOutput.endOffset);
  const probeTailAfter = await readBackgroundTail(probe.outputPath);
  assert('the tail after output still shows the last three lines — it is independent of the consumed cursor', JSON.stringify(probeTailAfter) === JSON.stringify(probeTailBefore) && probeTailAfter.kind === 'lines');

  // (b′) a wait in flight is undisturbed by a tail read.
  const slowCommand = "printf 'warming\\n'; sleep .4; printf 'a\\nb\\nc\\n'";
  const waitControl = await manager.start(slowCommand);
  const waitProbe = await manager.start(slowCommand);
  const controlWaitPromise = manager.wait(waitControl.taskId, 5_000, undefined, false);
  const probeWaitPromise = manager.wait(waitProbe.taskId, 5_000, undefined, false);
  await delay(150);
  const midTail = await readBackgroundTail(waitProbe.outputPath);
  await readBackgroundTails(await manager.list());
  const [controlWait, probeWait] = await Promise.all([controlWaitPromise, probeWaitPromise]);
  assert('a tail read mid-wait sees the early line without consuming it', midTail.kind === 'lines' && midTail.lines[0] === 'warming');
  assert('the in-flight wait result equals the control (reason, offsets, output)', controlWait.reason === 'terminal' && probeWait.reason === controlWait.reason && sameOutput(probeWait.output, controlWait.output) && probeWait.output.output.includes('c\n'));

  // (c) a job with no output → the stated placeholder line.
  const silent = await manager.start('true');
  await finished(silent.taskId);
  const silentTail = await readBackgroundTail(silent.outputPath);
  assert('a readable empty log is reported as empty, not unavailable', silentTail.kind === 'empty');
  const silentRows = rowsUnder(formatTasksReport(await manager.list(), Date.now(), await readBackgroundTails(await manager.list())), silent.taskId);
  assert('a zero-output job keeps its single row plus one stated line', silentRows.length === 1 && silentRows[0] === `${TASK_TAIL_PREFIX}${TASK_TAIL_EMPTY_NOTICE}`);
  const blankOnly = await manager.start("printf '\\n   \\n\\t\\n'");
  await finished(blankOnly.taskId);
  assert('a log of only blank lines is also "no output yet"', (await readBackgroundTail(blankOnly.outputPath)).kind === 'empty');

  // (d) a deleted outputPath → (output unavailable), no throw.
  const deleted = await manager.start("printf 'gone\\n'");
  await finished(deleted.taskId);
  await unlink(deleted.outputPath);
  let threw = false;
  let deletedTail: Awaited<ReturnType<typeof readBackgroundTail>> | undefined;
  try { deletedTail = await readBackgroundTail(deleted.outputPath); } catch { threw = true; }
  assert('a missing log is stated, never thrown', !threw && deletedTail?.kind === 'unavailable');
  const listAfterDelete = await manager.list();
  const reportDeleted = formatTasksReport(listAfterDelete, Date.now(), await readBackgroundTails(listAfterDelete));
  assert('the report shows the unavailable placeholder under that job', rowsUnder(reportDeleted, deleted.taskId).join('') === `${TASK_TAIL_PREFIX}${TASK_TAIL_UNAVAILABLE_NOTICE}`);
  assert('a directory path is unavailable rather than an error', (await readBackgroundTail(root)).kind === 'unavailable');

  // (e) a long line is truncated end-first with … at the width constant.
  const longLine = await manager.start(`printf '%0.sx' $(seq 1 ${TASK_TAIL_LINE_LIMIT + 40}); printf '\\n'`);
  await finished(longLine.taskId);
  const longRows = rowsUnder(formatTasksReport(await manager.list(), Date.now(), await readBackgroundTails(await manager.list())), longLine.taskId);
  const longText = longRows[0]?.slice(TASK_TAIL_PREFIX.length) ?? '';
  assert('a long line is cut end-first to TASK_TAIL_LINE_LIMIT code points ending in …', longRows.length === 1 && [...longText].length === TASK_TAIL_LINE_LIMIT && longText.endsWith('…') && longText.startsWith('x'.repeat(TASK_TAIL_LINE_LIMIT - 1)));

  // (f) a log larger than the window: only the tail window is read, markers still appear.
  const bulkLines = Math.ceil((TASK_TAIL_WINDOW_BYTES * 3) / 65);
  const bulk = await manager.start(`for i in $(seq 1 ${bulkLines}); do printf 'filler-%06d-%s\\n' "$i" '${'y'.repeat(48)}'; done; printf 'marker-one\\nmarker-two\\nmarker-three\\n'`);
  const bulkStatus = await finished(bulk.taskId);
  const bulkTail = await readBackgroundTail(bulk.outputPath);
  assert('the bulk log is really larger than the window', (bulkStatus.outputBytes ?? 0) > TASK_TAIL_WINDOW_BYTES);
  assert('the reader reads at most TASK_TAIL_WINDOW_BYTES of a larger file', bulkTail.kind === 'lines' && bulkTail.bytesRead === TASK_TAIL_WINDOW_BYTES && bulkTail.bytesRead < (bulkStatus.outputBytes ?? 0));
  assert('the three markers at the end are what the tail shows', bulkTail.kind === 'lines' && bulkTail.lines.join('|') === 'marker-one|marker-two|marker-three');
  assert('a smaller explicit window is honoured', await readBackgroundTail(bulk.outputPath, { windowBytes: 64 }).then((tail) => tail.kind === 'lines' && tail.bytesRead === 64 && tail.lines.at(-1) === 'marker-three'));
  const bulkControl = await manager.output(bulk.taskId);
  assert('the manager cursor of the bulk job still starts at zero after the tail reads', bulkControl.startOffset === 0 && bulkControl.output.startsWith('filler-000001'));

  // A running job: the tail is live output, the state row stays running.
  const running = await manager.start("printf 'boot\\nready\\n'; sleep 1000");
  await eventually(() => readBackgroundTail(running.outputPath), (tail) => tail.kind === 'lines' && tail.lines.length === 2);
  const runningList = await manager.list();
  const runningReport = formatTasksReport(runningList, Date.now(), await readBackgroundTails(runningList));
  assert('a running job shows its lines so far under a running row', runningReport.includes('running') && rowsUnder(runningReport, running.taskId).join('|') === `${TASK_TAIL_PREFIX}boot|${TASK_TAIL_PREFIX}ready`);
  assert('one report covers every job with at least one row under each', runningList.every((task: BackgroundTaskStatus) => rowsUnder(runningReport, task.taskId).length >= 1));
  await manager.stop(running.taskId);
} finally {
  await manager.shutdown();
  await rm(root, { recursive: true, force: true });
}

report();
