/**
 * The `!` prefix (SER-024): parsing, execution, bounding, the record, and replay.
 *
 * No terminal and no model. What only a pty can show — the live panel row, the
 * busy-state draft retention, the record a real TUI session writes — is
 * `spike/verify-tui.ts shellCommand` (free). This suite proves the pieces:
 *
 * - **Prefix detection is a start-of-draft fact.** `!` inside text is text.
 * - **Execution is bounded and honest.** Output head kept, totals counted, the
 *   SER-009 marker states every dropped code point — including the ones the
 *   memory cap dropped before `boundText` ever saw them. Non-zero exits, signals
 *   and timeouts are reported, never smoothed into success.
 * - **A hung command cannot wedge anything.** Timeout and `kill()` both settle
 *   the result promise via TERM→KILL on the process group.
 * - **One projection, three surfaces.** The finished row's preview, the held
 *   report and the trajectory record carry the same bounded text.
 * - **The record is an append, and replay prints it.** Prior bytes unchanged,
 *   `formatReplay` shows the same user row + tool row the live reducer produced.
 * - **Prompt recall never offers a `!` command.** It is a `shellCommand` record,
 *   not a `userInput` line, and recall reads only the latter.
 *
 * Run: pnpm tsx spike/verify-shell-command.ts
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('shell-command');

const { trajectoryPath } = await import('../src/agent/session.js');
const { readPromptHistory } = await import('../src/trajectory/prompt-history.js');
const { readTrajectory } = await import('../src/trajectory/reader.js');
const { MAX_FIELD_CHARS, parseRecordLine } = await import('../src/trajectory/record.js');
const { formatReplay, historyWithoutIds, replayRecords } = await import('../src/trajectory/replay.js');
const { TrajectoryRecorder } = await import('../src/trajectory/writer.js');
const { initialTurnState, turnReducer } = await import('../src/tui/turn-state.js');
const {
  SHELL_LIVE_TAIL_LINES,
  SHELL_REPORT_CODE_POINTS,
  SHELL_REPORT_LINES,
  SHELL_STORE_CODE_POINTS,
  SHELL_TOOL_NAME,
  composeShellReport,
  liveShellTail,
  parseShellCommand,
  projectShellOutput,
  runShellCommand,
} = await import('../src/tui/shell-command.js');

const WORK_DIR = path.join(HOME, 'work');
await mkdir(WORK_DIR, { recursive: true });

function prefixDetection(): void {
  header('! — prefix detection only at the start of the draft');

  assert('a leading ! yields the command', parseShellCommand('!echo hi') === 'echo hi');
  assert('whitespace after ! is trimmed', parseShellCommand('!  git status ') === 'git status');
  assert('a draft that trims to a leading ! still counts', parseShellCommand('  !ls') === 'ls');
  assert('a bare ! yields the empty command (a notice, not an error)', parseShellCommand('!') === '');
  assert('! inside text is text', parseShellCommand('echo hi!') === undefined);
  assert('! after a word is text', parseShellCommand('important! read this') === undefined);
  assert('! on a later line is text', parseShellCommand('first line\n!ls') === undefined);
  assert('an ordinary prompt is not a command', parseShellCommand('fix the bug') === undefined);
}

async function executionAndBounding(): Promise<void> {
  header('! — execution, merged output, exit codes, bounding');

  const ok = await runShellCommand('echo SHELL_OK_LINE', { cwd: WORK_DIR }).done;
  assert('a command runs and exits 0', ok.exitCode === 0 && ok.signal === null && !ok.timedOut);
  assert('stdout is captured', ok.output.text === 'SHELL_OK_LINE\n');
  assert('nothing was dropped', ok.output.droppedPoints === 0 && ok.output.droppedLines === 0);

  const failing = await runShellCommand('echo BEFORE_FAIL; exit 3', { cwd: WORK_DIR }).done;
  assert('a non-zero exit is reported as its real code', failing.exitCode === 3);
  assert('output before the failure is kept', failing.output.text.includes('BEFORE_FAIL'));

  const merged = await runShellCommand('echo OUT_LINE; echo ERR_LINE 1>&2', { cwd: WORK_DIR }).done;
  assert('stderr is merged with stdout',
    merged.output.text.includes('OUT_LINE') && merged.output.text.includes('ERR_LINE'));

  const cwd = await runShellCommand('pwd', { cwd: WORK_DIR }).done;
  assert('the command runs in the project root', cwd.output.text.trim().endsWith(path.basename(WORK_DIR)));

  const spawnFail = await runShellCommand('echo x', { cwd: path.join(WORK_DIR, 'no-such-dir') }).done;
  assert('a spawn failure is reported, not thrown',
    spawnFail.spawnError !== undefined && spawnFail.exitCode === null &&
    spawnFail.output.text.startsWith('spawn failed:'));

  // Bounding: more lines than the projection keeps, all counted.
  const many = await runShellCommand(`seq 1 ${SHELL_REPORT_LINES + 20}`, { cwd: WORK_DIR }).done;
  const projected = projectShellOutput(many.output);
  const projectedLines = projected.split('\n');
  assert('the projection keeps at most the line cap plus its marker',
    projectedLines.length <= SHELL_REPORT_LINES + 1);
  assert('the last line is the truncation marker',
    /^… truncated \d+ code points? and \d+ lines?$/.test(projectedLines[projectedLines.length - 1] ?? ''));
  assert('the head is what was kept', projectedLines[0] === '1');
  assert('the projection fits the code-point cap (marker riding on top)',
    [...projectedLines.slice(0, -1).join('\n')].length <= SHELL_REPORT_CODE_POINTS);

  // A firehose beyond the memory cap: the store stops, the counting does not,
  // and the marker states the true total.
  const firehosePoints = SHELL_STORE_CODE_POINTS * 2;
  const firehose = await runShellCommand(
    `for i in $(seq 1 ${Math.ceil(firehosePoints / 80)}); do printf '%079d\\n' "$i"; done`,
    { cwd: WORK_DIR },
  ).done;
  assert('collection stops at the store cap', [...firehose.output.text].length === SHELL_STORE_CODE_POINTS);
  assert('dropped output is counted, not stored', firehose.output.droppedPoints > 0);
  const firehoseProjected = projectShellOutput(firehose.output);
  const firehoseMarker = firehoseProjected.split('\n').pop() ?? '';
  const stated = firehoseMarker.match(/^… truncated (\d+) code points and (\d+) lines$/);
  const keptPoints = [...firehoseProjected.split('\n').slice(0, -1).join('\n')].length;
  assert('the marker folds the memory-cap drop into its totals',
    stated !== null && Number(stated[1]) === firehosePoints - keptPoints);

  assert('the projection cap sits under the record field cap, so the writer never re-truncates it',
    SHELL_REPORT_CODE_POINTS < MAX_FIELD_CHARS);

  const empty = await runShellCommand('true', { cwd: WORK_DIR }).done;
  assert('no output projects to the empty string, never a marker', projectShellOutput(empty.output) === '');
}

async function cancellationAndTimeout(): Promise<void> {
  header('! — a hung command settles: timeout and kill, TERM→KILL on the group');

  const started = Date.now();
  const timedOut = await runShellCommand('echo T_BEFORE; sleep 30', { cwd: WORK_DIR, timeoutMs: 400 }).done;
  assert('the timeout ends the command', Date.now() - started < 10_000);
  assert('a timeout is reported as such', timedOut.timedOut && timedOut.signal === 'SIGTERM');
  assert('output before the timeout is kept', timedOut.output.text.includes('T_BEFORE'));

  const run = runShellCommand('sleep 30', { cwd: WORK_DIR });
  setTimeout(() => run.kill(), 150);
  const killStarted = Date.now();
  const killed = await run.done;
  assert('kill() settles the result quickly', Date.now() - killStarted < 10_000);
  assert('a killed command reports its signal, not success',
    killed.signal === 'SIGTERM' && !killed.timedOut && killed.exitCode === null);

  // The group, not just the leader: a child spawned by the command dies too.
  const group = runShellCommand('sleep 30 & echo CHILD_PID $!; wait', { cwd: WORK_DIR });
  await new Promise((resolve) => setTimeout(resolve, 200));
  group.kill();
  const groupResult = await group.done;
  const childPid = Number(groupResult.output.text.match(/CHILD_PID (\d+)/)?.[1]);
  let childAlive = true;
  // TERM delivery is asynchronous; poll briefly rather than asserting an instant.
  for (let i = 0; i < 20 && childAlive; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(childPid, 0);
    } catch {
      childAlive = false;
    }
  }
  assert('killing reaps the whole process group', Number.isFinite(childPid) && !childAlive);
}

async function liveTailAndReducer(): Promise<void> {
  header('! — live tail projection and the reducer actions');

  assert('a short output is its own tail', liveShellTail('a\nb') === 'a\nb');
  assert('a trailing newline does not cost a blank tail row', liveShellTail('a\nb\n') === 'a\nb');
  const tall = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
  assert('the tail keeps only the last lines',
    liveShellTail(tall).split('\n').length === SHELL_LIVE_TAIL_LINES &&
    liveShellTail(tall).endsWith('line-29'));

  let state = initialTurnState;
  state = turnReducer(state, { type: 'shellStarted', id: 'shell-1', command: 'seq 1 3' });
  assert('shellStarted adds one active pseudo-tool row',
    state.activeTools.length === 1 && state.activeTools[0]?.name === SHELL_TOOL_NAME &&
    state.activeTools[0]?.summary === '$ seq 1 3');
  state = turnReducer(state, { type: 'shellOutput', id: 'shell-1', tail: '1\n2' });
  assert('shellOutput updates the row in place, adds nothing',
    state.activeTools.length === 1 && state.activeTools[0]?.input === '1\n2');
  state = turnReducer(state, {
    type: 'shellCommand',
    command: 'seq 1 3',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 12,
    output: '1\n2\n3',
  });
  assert('shellCommand clears the panel row', state.activeTools.length === 0);
  const item = state.history[state.history.length - 1];
  assert('and appends a finished tool row with the outcome in its summary',
    item?.kind === 'tool' && item.name === SHELL_TOOL_NAME && item.status === 'ok' &&
    item.summary === '$ seq 1 3 (exit 0 in 12ms)' && item.preview === '1\n2\n3');

  const failed = turnReducer(initialTurnState, {
    type: 'shellCommand',
    command: 'false',
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 2000,
    output: '',
  });
  const failedItem = failed.history[0];
  assert('a non-zero exit renders as an error row, code stated',
    failedItem?.kind === 'tool' && failedItem.status === 'error' &&
    failedItem.summary === '$ false (exit 1 in 2s)');

  const killed = turnReducer(initialTurnState, {
    type: 'shellCommand',
    command: 'sleep 99',
    exitCode: null,
    signal: 'SIGTERM',
    timedOut: true,
    durationMs: 120_000,
    output: '',
  });
  const killedItem = killed.history[0];
  assert('a timeout says so instead of pretending an exit code',
    killedItem?.kind === 'tool' && killedItem.status === 'error' &&
    killedItem.summary === '$ sleep 99 (timed out after 2m 0s)');
}

function reportShape(): void {
  header('! — the report the next prompt carries');

  const outcome = { command: 'git status', exitCode: 0, signal: null, timedOut: false, durationMs: 80 };
  const shellReport = composeShellReport(outcome, 'On branch main');
  assert('the report is a tagged block',
    shellReport.startsWith('<user-shell-command>\n') && shellReport.endsWith('\n</user-shell-command>'));
  assert('it states the command and the outcome',
    shellReport.includes('$ git status') && shellReport.includes('(exit 0 in 80ms)'));
  assert('it carries the bounded output verbatim', shellReport.includes('On branch main'));
  assert('an empty output is stated, not omitted',
    composeShellReport(outcome, '').includes('(no output)'));
}

async function recordAndReplay(): Promise<void> {
  header('! — the shellCommand record: an append, replayed as what was shown');

  const file = path.join(HOME, 'records', 'trajectory.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  // Prior content from an earlier run: the shell record must append after it,
  // byte for byte untouched.
  const prior = `${JSON.stringify({ v: 1, seq: 0, t: '2026-08-19T00:00:00.000Z', turn: 1, type: 'userInput', text: 'earlier prompt' })}\n`;
  await writeFile(file, prior, 'utf8');

  const recorder = new TrajectoryRecorder({
    file,
    run: {
      session: 'shell-spike',
      agentId: 'agent',
      darwinVersion: 'test',
      provider: 'bedrock',
      model: 'test-model',
      permissionMode: 'default',
      thinkingEffort: undefined,
      resumed: false,
      restoredMessages: 0,
    },
  });
  const entry = {
    command: 'seq 1 3',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 12,
    output: '1\n2\n3',
  };
  recorder.recordShellCommand(entry);
  await recorder.close();
  assert('recording a shell command reports no problem', recorder.status.problem === undefined);

  const raw = await readFile(file, 'utf8');
  assert('prior bytes are untouched — the record only appended', raw.startsWith(prior));

  const read = await readTrajectory(file);
  const record = read.records.find((candidate) => candidate.type === 'shellCommand');
  assert('the record reads back with its fields',
    record !== undefined && record.command === 'seq 1 3' && record.exitCode === 0 &&
    record.signal === null && record.timedOut === false && record.durationMs === 12 &&
    record.output === '1\n2\n3');
  const line = raw.split('\n').find((candidate) => candidate.includes('"shellCommand"'));
  assert('the line parses through the envelope validator',
    line !== undefined && parseRecordLine(line)?.type === 'shellCommand');

  // Replay parity: the record replays into the exact history the live reducer
  // produced from the same run.
  let live = initialTurnState;
  live = turnReducer(live, { type: 'userInput', text: `!${entry.command}` });
  live = turnReducer(live, { type: 'shellCommand', ...entry });
  const replayed = replayRecords(read.records.filter((candidate) => candidate.type === 'shellCommand'));
  assert('replay reproduces the live rows byte for byte (ids aside)',
    JSON.stringify(historyWithoutIds(replayed.history)) === JSON.stringify(historyWithoutIds(live.history)));

  const transcript = formatReplay({ ...replayRecords(read.records), damage: undefined });
  assert('formatReplay prints the user row', transcript.includes('you> !seq 1 3'));
  assert('formatReplay prints the finished row and its outcome',
    transcript.includes(`tool ${SHELL_TOOL_NAME} [ok] $ seq 1 3 (exit 0 in 12ms)`));
  assert('formatReplay prints the bounded output',
    transcript.includes('    1\n    2\n    3'));

  // Honesty backstop: a command far over the field cap is truncated *and stated*.
  const recorder2 = new TrajectoryRecorder({
    file,
    run: {
      session: 'shell-spike-2',
      agentId: 'agent',
      darwinVersion: 'test',
      provider: 'bedrock',
      model: 'test-model',
      permissionMode: 'default',
      thinkingEffort: undefined,
      resumed: false,
      restoredMessages: 0,
    },
  });
  recorder2.recordShellCommand({ ...entry, command: `echo ${'x'.repeat(MAX_FIELD_CHARS + 100)}` });
  await recorder2.close();
  const reread = await readTrajectory(file);
  const capped = reread.records.filter((candidate) => candidate.type === 'shellCommand')[1];
  assert('an oversized command is capped with the truncation stated on the record',
    capped !== undefined && [...capped.command].length === MAX_FIELD_CHARS &&
    (capped.trunc ?? []).some((truncation) => truncation.path === 'command'));
}

async function recallInterplay(): Promise<void> {
  header('! — prompt recall never offers a shell command back');

  const projectDir = path.join(HOME, 'recall-project');
  await mkdir(projectDir, { recursive: true });
  const file = trajectoryPath(projectDir, 'session-20260819-000001');
  await mkdir(path.dirname(file), { recursive: true });
  const lines = [
    { v: 1, seq: 0, t: '2026-08-19T00:00:01.000Z', turn: 1, type: 'userInput', text: 'a real prompt' },
    {
      v: 1, seq: 1, t: '2026-08-19T00:00:02.000Z', turn: 1, type: 'shellCommand',
      command: 'echo NEVER_RECALLED', exitCode: 0, signal: null, timedOut: false,
      durationMs: 5, output: 'NEVER_RECALLED',
    },
    { v: 1, seq: 2, t: '2026-08-19T00:00:03.000Z', turn: 2, type: 'userInput', text: 'another prompt' },
  ];
  await writeFile(file, lines.map((record) => `${JSON.stringify(record)}\n`).join(''), 'utf8');

  const history = await readPromptHistory(projectDir);
  assert('both real prompts are offered',
    history.entries.includes('a real prompt') && history.entries.includes('another prompt'));
  assert('the shell command is not an entry',
    !history.entries.some((candidate) => candidate.includes('NEVER_RECALLED')));
  assert('and it is not counted as skipped either — it was never a prompt',
    history.available === 2);
}

prefixDetection();
await executionAndBounding();
await cancellationAndTimeout();
await liveTailAndReducer();
reportShape();
await recordAndReplay();
await recallInterplay();
report();
