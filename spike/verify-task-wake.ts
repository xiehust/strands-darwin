/**
 * Background-task wake (SER-069) — a finished `bash start` job wakes the agent as one
 * ordinary queued turn. Free: a real pty, the real TUI, a local fixture model
 * (`spike/fixtures/task-wake-cli.ts`), no provider and no network.
 *
 * What only the full state machine can show, and what this suite pins:
 *
 * 1. **idle**       — a job finishing while idle yields exactly one queued wake, one
 *                     drained turn whose model request carries the `<task-notification>`
 *                     text, one `taskNotification` record and no `userInput` for it.
 * 2. **suppressed** — a job whose terminal state a completed turn already returned
 *                     through `bash wait` yields no wake and no extra model call.
 * 3. **mid-turn**   — a job finishing while the model stream is open is listed as a
 *                     queued wake (own busy-hint word) and drained only after the turn ends.
 * 4. **clear**      — a wake queued while `/clear` assembles its successor is dropped
 *                     with the queue; the successor never receives it.
 * 5. **permission** — (second session, `default` mode) a wake enqueued while a
 *                     permission prompt is open is delivered after the prompt resolves
 *                     and the turn ends — the drain-race pin.
 * 6. **config off** — (third session, `backgroundTaskWake: false`) the completion notice
 *                     appears and nothing else: no queue row, no wake turn, no record.
 * 7. **delegation** — (fourth session, SER-070) a background `subagent` outlives its
 *                     dispatching turn; `/clear` is refused locally while it is tracked; its
 *                     settlement while idle yields exactly one `delegation wake ·` turn whose
 *                     request carries the SDK's `strands_background_task_result` pair (the
 *                     notification never repeats the report); one `taskNotification` record
 *                     with `source: 'delegation'`; `/clear` succeeds once nothing is tracked.
 *
 * Every model request also carries the `bash` tool spec, so the log doubles as proof of
 * the per-runtime wording: the wake variant of the still-running-timeout sentence in the
 * sessions above, the no-wake variant (byte-identical to the pre-wake text) with the key off.
 *
 * Waits are anchored with `mark()` (see `spike/verify-tui.ts`): Ink redraws the whole
 * frame constantly, so an unanchored wait matches an older frame. Idle is detected as
 * the newest `you>` after the newest `working…`, settled for 400 ms. The model-call log
 * the fixture appends (`wake-model-calls.jsonl`) is the proof of what the model was
 * asked; the session's `trajectory.jsonl` is the proof of what was recorded.
 *
 * Run: pnpm tsx spike/verify-task-wake.ts
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sessionPaths, trajectoryPath } from '../src/agent/session.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { formatReplay, replayRead } from '../src/trajectory/replay.js';
import type { TaskNotificationRecord, TrajectoryRecord } from '../src/trajectory/record.js';
import { QUEUED_MARKER } from '../src/tui/prompt-queue.js';
import { backgroundCompletionSentence } from '../src/tools/background-wait-contract.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';

const HOME = ownPrivateHome('task-wake');
const ROOT = path.join(HOME, 'project');
const ENTRY = path.join(REPO_ROOT, 'spike/fixtures/task-wake-cli.ts');
const CALLS = path.join(ROOT, 'wake-model-calls.jsonl');
const BLOCK_CHECKPOINT = path.join(ROOT, 'wake-block-checkpoint');
const BLOCK_RELEASE = path.join(ROOT, 'wake-block-release');
const CLEAR_RELEASE = path.join(ROOT, 'wake-clear-release');
const CLEAR_ARM = path.join(ROOT, 'wake-clear-arm');
const EXIT_TIMEOUT_MS = 30_000;
const WAKE_ROW = `${QUEUED_MARKER} [task bg-`;
const WAKE_NOTICE = 'task wake · bg-';
const DELEGATION_WAKE_NOTICE = 'delegation wake · ';

async function writeConfig(extra: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(HOME, '.darwin'), { recursive: true });
  await writeFile(path.join(HOME, '.darwin/config.json'), JSON.stringify({
    provider: 'bedrock',
    model: 'us.anthropic.invalid-task-wake-fixture',
    permissionMode: 'yolo',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    trajectory: true,
    memory: false,
    ...extra,
  }));
}

async function resetProject(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await rm(sessionPaths(ROOT).sessionsDir, { recursive: true, force: true });
}

interface ModelCall {
  call: number;
  userText: string;
  bashDescription?: string;
  /** `parent` sees the delegation tools; a background child (SER-070) does not. */
  role: 'parent' | 'child';
  /** Task ids of the SDK's delivered `strands_background_task_result` pairs in the request. */
  pairTaskIds: string[];
}

async function modelCalls(): Promise<ModelCall[]> {
  try {
    return (await readFile(CALLS, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ModelCall);
  } catch {
    return [];
  }
}

/** True when every request's `bash` spec carries exactly the per-runtime completion sentence. */
function bashSpecsSay(calls: readonly ModelCall[], completionWakes: boolean): boolean {
  const expected = backgroundCompletionSentence(completionWakes);
  const other = backgroundCompletionSentence(!completionWakes);
  return calls.length > 0 && calls.every((call) =>
    call.bashDescription !== undefined && call.bashDescription.includes(expected) && !call.bashDescription.includes(other));
}

/** The wake calls (model requests whose newest user text is a `<task-notification>`) naming `marker`'s job. */
function wakeCallsFor(calls: readonly ModelCall[], marker: string): ModelCall[] {
  return calls.filter((call) => call.userText.includes('<task-notification') && call.userText.includes(marker));
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

function waitForIdle(tui: TuiSession, from: number, timeoutMs = 30_000): Promise<void> {
  return tui.waitUntil((screen) => {
    const tail = screen.slice(from);
    return tail.lastIndexOf('you>') > tail.lastIndexOf('working…') && tail.includes('you>');
  }, { timeoutMs, label: 'an idle prompt', settleMs: 400 });
}

/** Submits one prompt and waits for its turn to start and end; returns the mark taken before it. */
async function runPrompt(tui: TuiSession, text: string): Promise<number> {
  const mark = tui.mark();
  tui.submit(text);
  await tui.waitFor('working…', { timeoutMs: 30_000, from: mark });
  await waitForIdle(tui, mark);
  return mark;
}

/** True when the newest frame is the permission box rather than the input box. */
function awaitsPermission(frame: string): boolean {
  const tail = frame.trimEnd().slice(-600);
  return tail.includes('allow?') && !/you>\s*$/.test(tail);
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function sessionRecords(): Promise<{ id: string; records: TrajectoryRecord[] }[]> {
  const dir = sessionPaths(ROOT).sessionsDir;
  const entries = (await readdir(dir)).filter((name) => name.startsWith('session-')).sort();
  const out: { id: string; records: TrajectoryRecord[] }[] = [];
  for (const id of entries) {
    try {
      out.push({ id, records: (await readTrajectory(trajectoryPath(ROOT, id))).records });
    } catch {
      // a session directory without a record (none expected here)
    }
  }
  return out;
}

async function mainSession(): Promise<void> {
  header('task wake — idle, suppressed, mid-turn and /clear in one session (yolo)');
  await resetProject();
  await writeConfig({});
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });

    // --- 1. idle: the job ends after the turn; exactly one wake, one turn. ---
    const idleMark = await runPrompt(tui, 'start-idle idle-marker-alpha');
    const idleCallsBefore = (await modelCalls()).length;
    assert('the starting turn is over before the idle job ends (2 model calls: start, text)', idleCallsBefore === 2);
    await tui.waitFor('background task bg-', { timeoutMs: 20_000, from: idleMark });
    await tui.waitFor(WAKE_NOTICE, { timeoutMs: 20_000, from: idleMark, settleMs: 200 });
    await tui.waitFor('acknowledged wake for bg-', { timeoutMs: 20_000, from: idleMark });
    await waitForIdle(tui, idleMark);
    await settle(1_500);
    let calls = await modelCalls();
    const idleWakes = wakeCallsFor(calls, 'idle-marker-alpha');
    assert('exactly one model request carried the notification for the idle job', idleWakes.length === 1);
    assert('the wake turn was one turn: exactly one model call after the start turn', calls.length === 3);
    const idleText = idleWakes[0]?.userText ?? '';
    assert('the notification names the task, its state and exit code in an actionable vocabulary',
      /<task-notification task="bg-[0-9a-f-]{36}" state="succeeded" exitCode="0" signal="" elapsed="\d+s">/.test(idleText) &&
        idleText.includes('command: sleep 2; echo idle-marker-alpha') &&
        idleText.includes('bash output') && idleText.endsWith('</task-notification>'));
    assert('the notification carries the output tail', idleText.includes('\nidle-marker-alpha\n'));
    const idleScreen = tui.screen.slice(idleMark);
    assert('exactly one wake notice row was written for the idle job',
      idleScreen.split(WAKE_NOTICE).length - 1 === 1);
    assert('the wake notice names the job as sent to the model',
      /task wake · bg-[0-9a-f]{8} succeeded — sleep 2; echo idle-marker-alpha → sent to the model as this turn/.test(idleScreen));
    assert('the wake never appeared as a typed `you>` row', !idleScreen.includes('you> <task-notification'));
    assert('every request so far carried the wake variant of the bash completion sentence, never the no-wake one',
      bashSpecsSay(calls, true));

    // --- 2. suppressed: the model already consumed the terminal state via `wait`. ---
    const waitMark = tui.mark();
    tui.submit('start-and-wait wait-marker-beta');
    await tui.waitFor('waited job wait-marker-beta to its end', { timeoutMs: 30_000, from: waitMark });
    await waitForIdle(tui, waitMark);
    await settle(2_000);
    calls = await modelCalls();
    assert('the wait turn made three calls (start, wait, text) and nothing followed it', calls.length === 6);
    assert('no model request carried a notification for the waited job', wakeCallsFor(calls, 'wait-marker-beta').length === 0);
    const waitScreen = tui.screen.slice(waitMark);
    assert('the completion notice still appeared for the waited job', waitScreen.includes('background task bg-'));
    // The job ends while the `wait` turn is open, so its wake is listed for the rest
    // of that turn; the drain then finds the turn completed with the terminal state
    // delivered and drops it — nothing sent, no wake notice, no row left behind.
    assert('no wake notice was written for the waited job', !waitScreen.includes(WAKE_NOTICE));
    assert('the suppressed wake left the listing at idle', !tui.frame.includes(WAKE_ROW));

    // --- 3. mid-turn: the job ends while the model stream is open. ---
    const blockMark = tui.mark();
    tui.submit('start-then-block block-marker-gamma');
    await waitForFile(BLOCK_CHECKPOINT);
    await tui.waitFor(WAKE_ROW, { timeoutMs: 20_000, from: blockMark, settleMs: 300 });
    const busyFrame = tui.frame;
    assert('the wake is listed as a queued row while the turn is still streaming',
      busyFrame.includes(WAKE_ROW) && busyFrame.includes('working…'));
    assert('the busy hint counts it under its own word', busyFrame.includes('· 1 task wake'));
    assert('the wake row names the job, not its model-facing text',
      /queued · \[task bg-[0-9a-f]{8} succeeded\] sleep 0\.5; echo block-marker-gamma/.test(busyFrame) &&
        !busyFrame.includes('<task-notification'));
    calls = await modelCalls();
    assert('nothing was injected mid-stream: no wake request while the turn is open',
      wakeCallsFor(calls, 'block-marker-gamma').length === 0 && calls.length === 8);
    await writeFile(BLOCK_RELEASE, 'go\n');
    await tui.waitFor('acknowledged wake for bg-', { timeoutMs: 30_000, from: blockMark });
    await waitForIdle(tui, blockMark);
    await settle(1_000);
    calls = await modelCalls();
    assert('after the turn ended the wake drained as exactly one more model call',
      wakeCallsFor(calls, 'block-marker-gamma').length === 1 && calls.length === 9);
    assert('the drained wake row left the listing', !tui.frame.includes(WAKE_ROW));

    // --- 4. /clear: a wake queued during successor assembly is dropped. ---
    await runPrompt(tui, 'start-clear-window clear-marker-delta');
    await writeFile(CLEAR_ARM, 'arm\n');
    const clearSubmit = tui.mark();
    tui.submit('/clear');
    await tui.waitFor(WAKE_ROW, { timeoutMs: 20_000, from: clearSubmit, settleMs: 300 });
    assert('a wake queued while /clear assembles its successor is visible, not lost silently',
      tui.frame.includes(WAKE_ROW));
    await writeFile(CLEAR_RELEASE, 'go\n');
    await tui.waitFor('cleared — new session', { timeoutMs: 30_000, from: clearSubmit, settleMs: 300 });
    await settle(2_000);
    assert('/clear dropped the pending wake with the queue', !tui.frame.includes(WAKE_ROW));
    calls = await modelCalls();
    assert('the successor never received the dropped wake',
      wakeCallsFor(calls, 'clear-marker-delta').length === 0);
    assert('no wake notice was written after /clear', !tui.screen.slice(clearSubmit).includes(WAKE_NOTICE));

    tui.submit('/exit');
    assert('the session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }

  header('task wake — the trajectory: taskNotification records, never userInput');
  const sessions = await sessionRecords();
  const first = sessions[0];
  assert('the original session was recorded (the /clear successor may or may not have written a file yet)',
    first !== undefined && sessions.length <= 2);
  const records = first?.records ?? [];
  const wakes = records.filter((record): record is TaskNotificationRecord => record.type === 'taskNotification');
  const userInputs = records.filter((record) => record.type === 'userInput');
  assert('exactly two taskNotification records: the idle job and the mid-turn job', wakes.length === 2);
  assert('the records carry the job fields and the exact model-facing text',
    wakes.every((wake) => /^bg-[0-9a-f-]{36}$/.test(wake.taskId) && wake.state === 'succeeded' && wake.exitCode === 0 &&
      wake.signal === null && wake.text.startsWith('<task-notification ') && wake.text.includes(wake.taskId)));
  assert('their commands are the two jobs, in order',
    wakes[0]?.command === 'sleep 2; echo idle-marker-alpha' && wakes[1]?.command === 'sleep 0.5; echo block-marker-gamma');
  assert('no userInput line carries the wake text',
    !userInputs.some((record) => record.type === 'userInput' && record.text.includes('task-notification')));
  assert('a wake turn has no userInput of its own',
    wakes.every((wake) => !userInputs.some((record) => record.turn === wake.turn)));
  assert('the typed prompts are the four userInput lines (/clear is local and never sent)',
    userInputs.length === 4 && userInputs.every((record) => record.type === 'userInput' && record.text.startsWith('start-')));
  const closed = records.filter((record) => record.type === 'turnEnded');
  assert('each wake turn closed like any other turn', wakes.every((wake) => closed.some((record) => record.turn === wake.turn)));
  assert('the successor holds no taskNotification',
    sessions.slice(1).every((session) => session.records.every((record) => record.type !== 'taskNotification')));

  const replay = formatReplay(replayRead(await readTrajectory(trajectoryPath(ROOT, first?.id ?? ''))));
  assert('replay prints the wake through the same reducer row the live session showed',
    replay.split('\n').filter((line) => line.startsWith('  note task wake · bg-')).length === 2 &&
      replay.includes('succeeded — sleep 2; echo idle-marker-alpha → sent to the model as this turn'));
  assert('replay never prints the wake as a you> row', !replay.includes('you> <task-notification'));
}

async function permissionSession(): Promise<void> {
  header('task wake — a wake enqueued under an open permission prompt is delivered after it resolves (default mode)');
  await resetProject();
  await writeConfig({ permissionMode: 'default' });
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
    const mark = tui.mark();
    tui.submit('start-then-permission perm-marker-epsilon');
    await tui.waitFor('working…', { timeoutMs: 30_000, from: mark });
    // `default` mode asks for the `bash start` itself (`sleep` is not on the static
    // safe list): approve it, then the gated foreground command's prompt is the one
    // that stays open while the job finishes.
    await tui.waitUntil(() => awaitsPermission(tui.frame) && tui.frame.includes('bash: sleep 1.5; echo perm-marker-epsilon'), {
      timeoutMs: 30_000, label: 'the bash start permission prompt', settleMs: 300,
    });
    tui.send('y');
    await tui.waitUntil(() => awaitsPermission(tui.frame) && tui.frame.includes('gated-perm-marker-epsilon'), {
      timeoutMs: 30_000, label: 'the gated command permission prompt', settleMs: 300,
    });
    assert('the gated command\'s permission prompt is open while the job runs',
      tui.frame.includes('gated-perm-marker-epsilon') && tui.frame.includes('allow?'));
    await tui.waitFor(WAKE_ROW, { timeoutMs: 20_000, from: mark, settleMs: 300 });
    const promptFrame = tui.frame;
    assert('the wake is queued while the permission prompt is still open — held, not sent',
      promptFrame.includes(WAKE_ROW) && promptFrame.includes('allow?'));
    const callsBefore = await modelCalls();
    assert('no model request carried the notification while the prompt was open',
      wakeCallsFor(callsBefore, 'perm-marker-epsilon').length === 0);
    tui.send('y');
    await tui.waitFor('gated command done for perm-marker-epsilon', { timeoutMs: 30_000, from: mark });
    await tui.waitFor('acknowledged wake for bg-', { timeoutMs: 30_000, from: mark });
    await waitForIdle(tui, mark);
    await settle(1_000);
    const calls = await modelCalls();
    const wakeCalls = wakeCallsFor(calls, 'perm-marker-epsilon');
    assert('after the prompt resolved and the turn ended, the wake drained as exactly one model call',
      wakeCalls.length === 1 && wakeCalls[0]!.call === calls.length);
    assert('the wake turn came after the approved edit turn', (wakeCalls[0]?.call ?? 0) > callsBefore.length);
    assert('the wake left the listing once sent', !tui.frame.includes(WAKE_ROW));
    tui.submit('/exit');
    assert('the permission session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}

async function configOffSession(): Promise<void> {
  header('task wake — backgroundTaskWake: false keeps the notice-only behaviour');
  await resetProject();
  await writeConfig({ backgroundTaskWake: false });
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
    const mark = await runPrompt(tui, 'start-idle off-marker-zeta');
    await tui.waitFor('background task bg-', { timeoutMs: 20_000, from: mark, settleMs: 300 });
    await settle(2_500);
    const screen = tui.screen.slice(mark);
    assert('the completion notice appears as before the feature',
      /background task bg-[0-9a-f]{8} succeeded in \d+s — sleep 2; echo off-marker-zeta/.test(screen));
    assert('no wake row and no wake notice', !screen.includes(WAKE_ROW) && !screen.includes(WAKE_NOTICE));
    const calls = await modelCalls();
    assert('the model was called for the start turn only', calls.length === 2 && wakeCallsFor(calls, 'off-marker-zeta').length === 0);
    assert('with the key off every request carried the no-wake bash completion sentence, never the wake one',
      bashSpecsSay(calls, false));
    tui.submit('/exit');
    assert('the config-off session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
  const sessions = await sessionRecords();
  assert('the config-off record holds no taskNotification',
    sessions.length === 1 && sessions[0]!.records.every((record) => record.type !== 'taskNotification'));
}

async function delegationSession(): Promise<void> {
  header('task wake — a background delegation settles while idle: one wake, the SDK attaches the report (SER-070)');
  await resetProject();
  await writeConfig({});
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
    const mark = await runPrompt(tui, 'delegate-idle deleg-marker-eta');
    let calls = await modelCalls();
    const parentCalls = calls.filter((call) => call.role === 'parent');
    assert('the dispatching turn ended after the ack: two parent calls (subagent, text), the child still running',
      parentCalls.length === 2 && parentCalls[1]?.pairTaskIds.length === 0 && tui.screen.slice(mark).includes('dispatched deleg-marker-eta'));
    assert('the ack row names the task and the live delegation row survives the turn',
      /delegated in background \(task [0-9a-f-]{8,}/.test(tui.screen.slice(mark))
      && /count deleg-marker-eta · background \(\d+s/.test(tui.frame));

    // `/clear` while the delegation is tracked is a local refusal, not a new session.
    const clearMark = tui.mark();
    tui.submit('/clear');
    await tui.waitFor('/clear refused', { timeoutMs: 10_000, from: clearMark, settleMs: 200 });
    // Word-wrapped at 120 columns: rejoin the wrapped lines before matching the sentence.
    const refusal = tui.screen.slice(clearMark).replace(/\s*\r?\n\s*/g, ' ');
    assert('/clear is refused locally, naming the task, the dispatch id and both exits',
      /\/clear refused — a background delegation is still tracked: subagent #deleg\d+ \(task [0-9a-f-]{36}, running\)/.test(refusal)
      && refusal.includes('/agents cancel <id>') && refusal.includes('wait for the completion wake'));
    await settle(300);
    assert('the session is unchanged: no "cleared — new session", the same child still runs',
      !refusal.includes('cleared — new session') && (await modelCalls()).length === calls.length);

    // The child settles while idle → exactly one delegation wake → one turn carrying the pair.
    await tui.waitFor(DELEGATION_WAKE_NOTICE, { timeoutMs: 20_000, from: mark, settleMs: 200 });
    await tui.waitFor('acknowledged wake for ', { timeoutMs: 20_000, from: mark });
    await waitForIdle(tui, mark);
    await settle(1_500);
    calls = await modelCalls();
    const wakeCalls = calls.filter((call) => call.role === 'parent' && call.userText.includes('<task-notification'));
    const childCalls = calls.filter((call) => call.role === 'child');
    assert('exactly one child ran and exactly one wake request was made', childCalls.length === 1 && wakeCalls.length === 1);
    assert('no further model call followed the wake turn', calls.length === 4);
    const wakeText = wakeCalls[0]?.userText ?? '';
    const taskId = /task="([0-9a-f-]{36})"/.exec(wakeText)?.[1];
    assert('the notification names the delegation, its state and elapsed time, and points at the SDK pair — never the report',
      taskId !== undefined && /<task-notification task="[0-9a-f-]{36}" tool="subagent" state="succeeded" elapsed="\d+s">/.test(wakeText)
      && wakeText.includes('delegation: subagent general#deleg') && wakeText.includes('strands_background_task_result')
      && !wakeText.includes('child counted') && wakeText.endsWith('</task-notification>'));
    assert('the wake turn\'s request carried the SDK\'s result pair for that task — attached by the SDK, not copied by darwin',
      taskId !== undefined && wakeCalls[0]?.pairTaskIds.length === 1 && wakeCalls[0].pairTaskIds[0] === taskId);
    const screen = tui.screen.slice(mark);
    assert('exactly one delegation wake notice row was written', screen.split(DELEGATION_WAKE_NOTICE).length - 1 === 1);
    assert('the wake notice names the delegation as sent to the model',
      /delegation wake · [0-9a-f]{8} succeeded — subagent general#deleg\d+: count deleg-marker-eta → sent to the model as this turn/
        .test(screen.replace(/\s*\r?\n\s*/g, ' ')));
    assert('the delegation row closed as the background result row with the child\'s report',
      screen.includes('· background result') && screen.includes('child counted deleg-marker-eta'));
    assert('the wake never appeared as a typed `you>` row', !screen.includes('you> <task-notification'));
    assert('no live delegation row is left', !/count deleg-marker-eta · background \(\d+s/.test(tui.frame));

    // Nothing tracked any more: `/clear` now succeeds (the window is not armed here).
    const clearAgain = tui.mark();
    tui.submit('/clear');
    await tui.waitFor('cleared — new session', { timeoutMs: 30_000, from: clearAgain, settleMs: 300 });
    tui.submit('/exit');
    assert('the delegation session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
  const sessions = await sessionRecords();
  const records = sessions[0]?.records ?? [];
  const wakes = records.filter((record): record is TaskNotificationRecord => record.type === 'taskNotification');
  assert('one taskNotification record with source: delegation, the label as command, null exit metadata',
    wakes.length === 1 && wakes[0]?.source === 'delegation' && /^[0-9a-f-]{36}$/.test(wakes[0].taskId)
    && wakes[0].command.startsWith('subagent general#deleg') && wakes[0].state === 'succeeded'
    && wakes[0].exitCode === null && wakes[0].signal === null && wakes[0].text.startsWith('<task-notification '));
  assert('the wake turn has no userInput of its own', !records.some((record) => record.type === 'userInput' && record.turn === wakes[0]?.turn));
  const replay = formatReplay(replayRead(await readTrajectory(trajectoryPath(ROOT, sessions[0]?.id ?? ''))));
  assert('replay prints the delegation wake notice and the background result row through the same reducer',
    replay.split('\n').filter((line) => line.startsWith(`  note ${DELEGATION_WAKE_NOTICE}`)).length === 1
    && replay.includes('· background result') && replay.includes('child counted deleg-marker-eta'));
}

async function main(): Promise<void> {
  try {
    await mainSession();
    await permissionSession();
    await configOffSession();
    await delegationSession();
  } finally {
    await rm(HOME, { recursive: true, force: true });
  }
  report();
}

await main();
