/**
 * SER-064 / SER-070 — background delegation through the SDK's own `backgroundTasks`
 * plugin, non-blocking for a waking runtime.
 *
 * Everything here runs against real `AgentRuntime`s with one scripted offline model
 * that plays both the parent and every child (it tells them apart by whether the
 * delegation tools are in its `toolSpecs`). No model call, no network.
 *
 * What is proven, in order:
 *   (a)   option shape: a waking runtime (`backgroundCompletionWakes: true`) gets
 *         `waitForCompletion: false`, every other runtime `true`; the delegation
 *         description says "next turn" or the pre-SER-070 same-turn sentence byte for
 *         byte; the manage tool classification and plan-mode denial are unchanged;
 *   (b)   **waking runtime**: one `send()` dispatches a background `subagent`, makes
 *         another tool call, and ends with the child still running — its stream has one
 *         `agentResultEvent`, the dispatch is `running`, `listBackgroundDelegations()`
 *         names the task, the live row survives `turnEnded`; a user prompt sent meanwhile
 *         is answered by an ordinary turn with no pair in its request; the child's
 *         settlement while idle publishes exactly one snapshot and `delegationWakeEntries`
 *         yields exactly one wake (and none a second time); the wake turn's first model
 *         request carries the SDK's `strands_background_task_result` pair and the
 *         `<task-notification>` text; its stream opens with the forwarded after-event,
 *         exactly once across all turns; the live row closes as `· background result`;
 *         the trajectory holds the before-event in the dispatching turn, the after-event in
 *         the wake turn, a `taskNotification` record with `source: 'delegation'` and no
 *         `userInput` for it, and `formatReplay` prints the wake notice and the result row;
 *   (c)   a child settling *during* a later user turn is delivered in that turn (the SDK's
 *         end-of-invocation delivery), the after-event is forwarded inside that stream,
 *         and nothing is left tracked, so no wake is owed;
 *   (d)   `/rewind` and `/clear` while a delegation is tracked are local refusals naming
 *         the task and the two exits (`/agents cancel <id>`, wait for the wake); the child
 *         keeps running; `/agents cancel` settles it, the wake delivers it, and `/clear`
 *         then succeeds;
 *   (e)   `shutdown()` still cancels a tracked child;
 *   (f)   **no-wake runtime** (headless-shaped: the option unset): the same script keeps
 *         the SDK waiting inside the invocation — four model calls in one `send()`, the
 *         pair before the fourth, the forwarded after-event inside the turn — SER-064's
 *         same-turn contract, now the headless decision's pin;
 *   (g)   unchanged from SER-064: a hook `cancel` precedes dispatch (no ack, no task),
 *         plan mode denies the manage tool's `cancel`, a foreground report is
 *         byte-identical, Ctrl+C mid-background leaves no running dispatch and the next
 *         `send()` receives the pair, children see neither the flag nor the manage tool.
 *
 * Trajectory assertions await the wake turn's closing record, not send() alone:
 * later events append asynchronously, and wake turns do not await rewind capture.
 * The wait is bounded and checks presence only (never a clean outcome). The exact
 * read is retained in the fixture root, outside the auto-cleaned test HOME.
 *
 * Run: pnpm tsx spike/verify-background-delegation.ts
 */
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BeforeToolCallEvent,
  Model,
  type Agent,
  type AgentStreamEvent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
  type ToolSpec,
} from '@strands-agents/sdk';

import {
  BACKGROUND_EXECUTION_FLAG,
  BACKGROUND_TASK_RESULT_TOOL_NAME,
  MANAGE_BACKGROUND_TASK_TOOL_NAME,
  backgroundAckTaskId,
  backgroundDelegationConfig,
  backgroundDelegationDescriptionClause,
  backgroundExecutionRequested,
  liveBackgroundDelegationRefusal,
  type BackgroundDelegationStatus,
} from '../src/agent/background-delegation.js';
import { shortDispatchId } from '../src/agents/dispatch-registry.js';
import { allowAllBridge, classify, PermissionGate } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest, type RuntimeOptions } from '../src/agent/runtime.js';
import { trajectoryPath } from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { turnOutcome, type TaskNotificationFields, type TaskNotificationRecord, type TurnEndedRecord } from '../src/trajectory/record.js';
import { formatReplay, replayRecords } from '../src/trajectory/replay.js';
import { delegationWakeEntries, queueRowText } from '../src/tui/prompt-queue.js';
import { initialTurnState, turnReducer, type HistoryItem, type TurnState } from '../src/tui/turn-state.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('background-delegation');

const CHILD_REPORT = 'child report: three files counted';
const MAX_CONCURRENT = 3;
/** The delegation description sentence every runtime carried before SER-070; the no-wake runtime keeps it byte for byte. */
const SAME_TURN_CLAUSE =
  'Set _background_execution: true to run this call in the background when you do not need its result ' +
  'immediately (reads only): you get an acknowledgement at once and the final report is delivered before ' +
  'your next model call in this same turn.';

type Scenario =
  | 'background'
  | 'background-only'
  | 'slow-plain'
  | 'foreground'
  | 'cancel'
  | 'plain'
  | 'manage-cancel'
  | 'denied';

interface RecordedCall {
  readonly role: 'parent' | 'child';
  readonly toolSpecs: readonly ToolSpec[];
  readonly messages: readonly Message[];
  readonly at: number;
}

/** Resolves when released; a child waits on it so the test decides when it settles. */
class Gate {
  private release!: () => void;
  readonly promise: Promise<void>;
  constructor() {
    this.promise = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  open(): void {
    this.release();
  }
}

/**
 * One model for parent and children. A parent call is one whose spec list carries
 * `subagent` (children never get the delegation tools); the parent follows the
 * scenario, the child yields a fixed report once its gate opens or cancellation
 * lands, whichever comes first.
 */
class RouterModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.background', contextWindowLimit: 200_000 };
  readonly calls: RecordedCall[] = [];
  scenario: Scenario = 'plain';
  childGate = new Gate();
  /** The tool-use id the next `background`/`background-only` run issues; per run, so history cannot confuse runs. */
  bgId = 'bg-1';
  /** `slow-plain` runs this when its model call starts and holds the answer until it resolves — the test settles the child inside the call. */
  hold: () => Promise<void> = async () => undefined;
  /** Called when the parent ends the model call that leaves the child still running. */
  onParentWaiting: (() => void) | undefined;
  /** Delivered pairs already answered with `done:` — each pair is acknowledged exactly once. */
  private readonly acknowledged = new Set<string>();

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return { ...this.config };
  }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const toolSpecs = options?.toolSpecs ?? [];
    const isParent = toolSpecs.some((spec) => spec.name === 'subagent');
    this.calls.push({ role: isParent ? 'parent' : 'child', toolSpecs, messages: [...messages], at: Date.now() });
    if (!isParent) {
      yield* this.childTurn(options?.cancelSignal);
      return;
    }
    yield* this.parentTurn(messages);
  }

  private async *childTurn(cancelSignal: AbortSignal | undefined): AsyncIterable<ModelStreamEvent> {
    await Promise.race([
      this.childGate.promise,
      new Promise<void>((resolve) => {
        if (cancelSignal === undefined) return;
        if (cancelSignal.aborted) resolve();
        else cancelSignal.addEventListener('abort', () => resolve(), { once: true });
      }),
    ]);
    yield* text(CHILD_REPORT);
  }

  private async *parentTurn(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    // A delivered pair the model has not answered yet takes precedence over every
    // scenario: whichever turn it lands in, the answer quotes it exactly once.
    const fresh = deliveredPairIds(messages).filter((taskId) => !this.acknowledged.has(taskId));
    if (fresh.length > 0) {
      for (const taskId of fresh) this.acknowledged.add(taskId);
      yield* text(`done: ${resultTextFor(messages, fresh[0]!) ?? '(no delivered result)'}`);
      return;
    }
    switch (this.scenario) {
      case 'plain':
        yield* text('plain answer');
        return;
      case 'slow-plain':
        await this.hold();
        yield* text('slow answer');
        return;
      case 'manage-cancel':
        if (hasResultFor(messages, 'manage-1')) {
          yield* text('manage done');
          return;
        }
        yield* toolUse('manage-1', MANAGE_BACKGROUND_TASK_TOOL_NAME, { mode: 'cancel', taskId: 'no-such-task' });
        return;
      case 'foreground':
        if (hasResultFor(messages, 'fg-1')) {
          yield* text('foreground done');
          return;
        }
        yield* toolUse('fg-1', 'subagent', { task: 'count things' });
        return;
      case 'cancel':
        if (hasResultFor(messages, 'bg-cancel')) {
          yield* text('should not be reached: the turn is cancelled before this call');
          return;
        }
        yield* toolUse('bg-cancel', 'subagent', { task: 'count things', [BACKGROUND_EXECUTION_FLAG]: true });
        return;
      case 'denied':
        if (hasResultFor(messages, 'bg-deny')) {
          yield* text('denied handled');
          return;
        }
        yield* toolUse('bg-deny', 'subagent', { task: 'denied task', [BACKGROUND_EXECUTION_FLAG]: true });
        return;
      case 'background-only':
        if (hasResultFor(messages, this.bgId)) {
          yield* text('dispatched');
          return;
        }
        yield* toolUse(this.bgId, 'subagent', { task: 'count things', [BACKGROUND_EXECUTION_FLAG]: true });
        return;
      case 'background':
        if (hasResultFor(messages, `${this.bgId}-plan`)) {
          // Third call: the child is still gated. End the turn. A waking runtime lets
          // the turn end here; a no-wake runtime waits for the task and continues this
          // same invocation with the result pair.
          this.onParentWaiting?.();
          yield* text('dispatched; continuing without the report');
          return;
        }
        if (hasResultFor(messages, this.bgId)) {
          yield* toolUse(`${this.bgId}-plan`, 'update_plan', {
            plan: [{ item: 'read while the child runs', status: 'in_progress' }],
          });
          return;
        }
        yield* toolUse(this.bgId, 'subagent', { task: 'count things', [BACKGROUND_EXECUTION_FLAG]: true });
        return;
    }
  }
}

function hasResultFor(messages: readonly Message[], toolUseId: string): boolean {
  return messages.some((message) =>
    message.content.some((block) => block.type === 'toolResultBlock' && block.toolUseId === toolUseId),
  );
}

function resultTextFor(messages: readonly Message[], toolUseId: string): string | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolResultBlock' && block.toolUseId === toolUseId) return blockText(block.content);
    }
  }
  return undefined;
}

/** Task ids of every SDK-delivered `strands_background_task_result` pair in the request, in order. */
function deliveredPairIds(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME) ids.push(block.toolUseId);
    }
  }
  return ids;
}

/** The text of the SDK's delivered `strands_background_task_result` tool result (the first pair). */
function backgroundResultText(messages: readonly Message[]): string | undefined {
  const [taskId] = deliveredPairIds(messages);
  return taskId === undefined ? undefined : resultTextFor(messages, taskId);
}

function blockText(content: readonly unknown[]): string {
  return content
    .flatMap((block) => {
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === 'textBlock' && typeof typed.text === 'string' ? [typed.text] : [];
    })
    .join('\n');
}

function* text(value: string): Iterable<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' };
  yield { type: 'modelContentBlockStartEvent' };
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: value } };
  yield { type: 'modelContentBlockStopEvent' };
  yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
}

function* toolUse(toolUseId: string, name: string, input: unknown): Iterable<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' };
  yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId } };
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
  yield { type: 'modelContentBlockStopEvent' };
  yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
}

/** Same private-field reach the `/clear` and `/model` suites use. */
function runtimeAgent(runtime: AgentRuntime): Agent {
  return (runtime as unknown as { agent: Agent }).agent;
}

interface Drained {
  readonly events: AgentStreamEvent[];
  readonly history: readonly HistoryItem[];
  readonly state: TurnState;
}

interface DrainOptions {
  readonly onEvent?: (event: AgentStreamEvent) => void;
  /** Carry the previous turn's reducer state, as the live frame does across turns. */
  readonly state?: TurnState;
  /** Send as a wake turn (the App's drained `taskNotification` entry) instead of a prompt. */
  readonly wake?: TaskNotificationFields;
}

/** Drains one turn, feeding every event through the TUI reducer as the live frame would. */
async function drain(runtime: AgentRuntime, prompt: string, options: DrainOptions = {}): Promise<Drained> {
  const events: AgentStreamEvent[] = [];
  let state = options.wake === undefined
    ? turnReducer(options.state ?? initialTurnState, { type: 'userInput', text: prompt })
    : turnReducer(options.state ?? initialTurnState, { type: 'taskNotification', ...options.wake });
  for await (const event of runtime.send(prompt, prompt, undefined, options.wake)) {
    events.push(event);
    state = turnReducer(state, { type: 'streamEvent', event });
    options.onEvent?.(event);
  }
  state = turnReducer(state, { type: 'turnEnded' });
  return { events, history: state.history, state };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

/** Test-only observer barrier: do not change runtime streaming or require success. */
async function readThroughTurnEnd(file: string, turn: number, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let read = await readTrajectory(file);
  while (!read.records.some((record) => record.type === 'turnEnded' && record.turn === turn)
    && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    read = await readTrajectory(file);
  }
  return read;
}

/** Real delayed file append: a live input prefix is not a completed trajectory. */
async function trajectoryReadBarrier(root: string): Promise<void> {
  header('background delegation — bounded trajectory read barrier');
  const file = path.join(root, 'delayed-trajectory.jsonl');
  await writeFile(file, `${JSON.stringify({ type: 'taskNotification', seq: 1, turn: 3 })}\n`);
  let returned = false;
  const reading = readThroughTurnEnd(file, 3).then((read) => { returned = true; return read; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert('a durable wake input alone does not satisfy the read barrier', !returned);
  await appendFile(file, `${JSON.stringify({ type: 'turnEnded', seq: 2, turn: 3, failure: { name: 'Error', message: 'fixture failure' } })}\n`);
  const closed = await reading;
  const end = closed.records.find((record): record is TurnEndedRecord => record.type === 'turnEnded');
  assert('the barrier returns a failed closing record unchanged, never waits for success',
    end !== undefined && turnOutcome(end) === 'failed');
  const timedOut = await readThroughTurnEnd(file, 4, 20);
  assert('a missing closing record stays missing after the bounded wait',
    !timedOut.records.some((record) => record.type === 'turnEnded' && record.turn === 4));
}

function specNames(specs: readonly ToolSpec[]): string[] {
  return specs.map((spec) => spec.name);
}

function carriesFlag(spec: ToolSpec): boolean {
  const properties = (spec.inputSchema as { properties?: Record<string, unknown> }).properties;
  return properties !== undefined && BACKGROUND_EXECUTION_FLAG in properties;
}

function afterEvents(events: readonly AgentStreamEvent[], name: string) {
  return events.filter(
    (event): event is Extract<AgentStreamEvent, { type: 'afterToolCallEvent' }> =>
      event.type === 'afterToolCallEvent' && event.toolUse.name === name,
  );
}

function toolRows(history: readonly HistoryItem[], name: string) {
  return history.filter((item): item is Extract<HistoryItem, { kind: 'tool' }> => item.kind === 'tool' && item.name === name);
}

async function main(): Promise<void> {
  header('background delegation — (a) option shape and pure helpers');
  const option = backgroundDelegationConfig({
    delegationTools: ['subagent', 'workflow'],
    ordinaryToolNames: ['bash', 'fileEditor', 'subagent'],
    maxConcurrency: MAX_CONCURRENT,
    completionWakes: true,
  });
  assert('agentic names exactly the delegation tools', JSON.stringify(option.agentic) === '["subagent","workflow"]');
  assert(
    'never names every ordinary tool, drops a delegation tool listed twice, and closes with the wildcard',
    JSON.stringify(option.never) === '["bash","fileEditor","*"]',
  );
  assert('a waking runtime passes waitForCompletion: false — the dispatching turn ends after the ack',
    option.waitForCompletion === false);
  assert('a non-waking runtime keeps waitForCompletion: true — the report stays inside the one invocation',
    backgroundDelegationConfig({ delegationTools: ['subagent'], ordinaryToolNames: [], maxConcurrency: 1, completionWakes: false })
      .waitForCompletion === true);
  assert('maxConcurrency is the SER-061 cap', option.maxConcurrency === MAX_CONCURRENT);
  assert('the no-wake description clause is byte-identical to the pre-SER-070 sentence',
    backgroundDelegationDescriptionClause() === SAME_TURN_CLAUSE && backgroundDelegationDescriptionClause(false) === SAME_TURN_CLAUSE);
  const wakeClause = backgroundDelegationDescriptionClause(true);
  assert('the waking description clause says next turn, names the pair and the wake, and stays bounded',
    wakeClause !== SAME_TURN_CLAUSE && wakeClause.includes('next turn') && wakeClause.includes(BACKGROUND_TASK_RESULT_TOOL_NAME)
    && wakeClause.includes('<task-notification>') && wakeClause.includes('you may end this turn') && [...wakeClause].length < 400);
  assert('the flag helper reads only a literal true', backgroundExecutionRequested({ [BACKGROUND_EXECUTION_FLAG]: true })
    && !backgroundExecutionRequested({ [BACKGROUND_EXECUTION_FLAG]: 'true' }) && !backgroundExecutionRequested(null));
  assert('the ack parser reads the SDK ack shape only',
    backgroundAckTaskId([{ type: 'textBlock', text: 'Background task dispatched.\n\nTask ID: abc-1\nTool: subagent' }]) === 'abc-1'
    && backgroundAckTaskId([{ type: 'textBlock', text: 'Task ID: abc-1' }]) === undefined);
  const refusal = liveBackgroundDelegationRefusal('/clear', [{
    taskId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', toolUseId: 'toolu_01abc', toolName: 'subagent',
    input: { task: 'count' }, startedAt: '2026-01-01T00:00:00.000Z', settledAt: null, state: 'running',
  }]);
  assert('the refusal names the command, the task id with its dispatch id, and both exits',
    refusal.startsWith('/clear refused') && refusal.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    && refusal.includes(`#${shortDispatchId('toolu_01abc')}`) && refusal.includes('/agents cancel <id>')
    && refusal.includes('wait for the completion wake'));
  const noWakeForRunning = delegationWakeEntries([{
    taskId: 't-run', toolUseId: 'toolu_run', toolName: 'subagent', input: { task: 'x' },
    startedAt: '2026-01-01T00:00:00.000Z', settledAt: null, state: 'running',
  }], new Set());
  assert('a running delegation is never a wake', noWakeForRunning.length === 0);

  header('background delegation — (a) manage tool classification');
  const list = classify(MANAGE_BACKGROUND_TASK_TOOL_NAME, { mode: 'list' });
  const get = classify(MANAGE_BACKGROUND_TASK_TOOL_NAME, { mode: 'get', taskId: 't-1' });
  const cancel = classify(MANAGE_BACKGROUND_TASK_TOOL_NAME, { mode: 'cancel', taskId: 't-1' });
  assert('list classifies read', list.kind === 'read' && list.summary === 'background tasks: list');
  assert('get classifies read', get.kind === 'read' && get.summary === 'background task: get t-1');
  assert('cancel keeps the fail-closed execute kind with a clear summary',
    cancel.kind === 'execute' && cancel.summary === 'background task: cancel t-1');
  assert('a missing mode is also fail-closed', classify(MANAGE_BACKGROUND_TASK_TOOL_NAME, {}).kind === 'execute');
  assert('subagent classification ignores the flag', classify('subagent', { task: 'x', [BACKGROUND_EXECUTION_FLAG]: true }).kind === 'read');
  const planGate = new PermissionGate({ mode: 'plan', projectRoot: '/tmp', ask: allowAllBridge });
  assert('plan mode denies a model-driven cancel', planGate.planGuard(MANAGE_BACKGROUND_TASK_TOOL_NAME, { mode: 'cancel', taskId: 't' })?.type === 'deny');
  assert('plan mode lets list through', planGate.planGuard(MANAGE_BACKGROUND_TASK_TOOL_NAME, { mode: 'list' }) === undefined);

  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-background-delegation-'));
  console.log(`  (retained trajectory evidence: ${root})`);
  await trajectoryReadBarrier(root);
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(configPath(), JSON.stringify({
    permissionMode: 'yolo',
    memory: false,
    maxConcurrentSubagents: MAX_CONCURRENT,
    models: [
      { enable: true, name: 'first', provider: 'bedrock', model: 'fake.first', region: 'us-west-2' },
      { enable: false, name: 'second', provider: 'bedrock', model: 'fake.second', region: 'us-west-2' },
    ],
  }));

  const model = new RouterModel();
  setRuntimeModelFactoryForTest(async () => model);
  const baseOptions: RuntimeOptions = { projectRoot: root, session: { kind: 'new' }, permissionBridge: allowAllBridge };
  let runtime: AgentRuntime | undefined;
  try {
    runtime = await AgentRuntime.create({ ...baseOptions, backgroundCompletionWakes: true });
    const sessionId = runtime.info.sessionId;
    const settlements: BackgroundDelegationStatus[] = [];
    const unsubscribeSettlements = runtime.subscribeToBackgroundDelegations((status) => settlements.push(status));

    header('background delegation — (b) waking runtime: the dispatching turn ends with the child running');
    model.scenario = 'background';
    model.bgId = 'bg-1';
    model.childGate = new Gate();
    let runningAtWait: number | undefined;
    model.onParentWaiting = () => {
      runningAtWait = runtime!.listSubagentDispatches().filter((dispatch) => dispatch.state === 'running').length;
    };
    const bg = await drain(runtime, 'delegate in the background');
    const parentCalls = model.calls.filter((call) => call.role === 'parent');
    assert('the parent made three model calls and the turn ended', parentCalls.length === 3
      && bg.events.filter((event) => event.type === 'agentResultEvent').length === 1
      && bg.events.some((event) => event.type === 'agentResultEvent' && event.result.stopReason === 'endTurn'
        && event.result.toString() === 'dispatched; continuing without the report'));
    const ackText = resultTextFor(parentCalls[1]?.messages ?? [], 'bg-1') ?? '';
    const taskId = backgroundAckTaskId([{ type: 'textBlock', text: ackText }]) ?? '';
    assert('the second model call already holds the ack with a task id', ackText.startsWith('Background task dispatched.') && taskId !== '');
    assert('the parent issued update_plan while the child ran', hasResultFor(parentCalls[2]?.messages ?? [], 'bg-1-plan') && runningAtWait === 1);
    assert('no request of this turn carried the result pair', parentCalls.every((call) => deliveredPairIds(call.messages).length === 0));
    assert('the child is still running when the turn is over',
      runtime.listSubagentDispatches().filter((dispatch) => dispatch.state === 'running').length === 1 && settlements.length === 0);
    const trackedRunning = runtime.listBackgroundDelegations();
    assert('listBackgroundDelegations() names the running task from the ack',
      trackedRunning.length === 1 && trackedRunning[0]?.taskId === taskId && trackedRunning[0].toolUseId === 'bg-1'
      && trackedRunning[0].toolName === 'subagent' && trackedRunning[0].state === 'running' && trackedRunning[0].settledAt === null);
    assert('no after-event for the delegation was forwarded yet', afterEvents(bg.events, 'subagent').length === 0);
    const ackRows = toolRows(bg.history, 'subagent');
    assert('the transcript shows the ack row and nothing else for the delegation yet',
      ackRows.length === 1 && ackRows[0]?.summary === `subagent general#bg1: count things · delegated in background (task ${taskId})`);
    assert('the live delegation row survives turnEnded (every other row leaves)',
      bg.state.activeTools.length === 1 && bg.state.activeTools[0]?.id === 'bg-1'
      && bg.state.activeTools[0].backgroundDelegation?.taskId === taskId);
    const idleSweepWhileRunning = delegationWakeEntries(runtime.listBackgroundDelegations(), new Set());
    assert('an idle sweep while the child runs owes no wake', idleSweepWhileRunning.length === 0);

    header('background delegation — (b) a user prompt meanwhile is an ordinary turn');
    model.scenario = 'plain';
    const meanwhile = await drain(runtime, 'a question while the child runs', { state: bg.state });
    const meanwhileCall = model.calls.filter((call) => call.role === 'parent').at(-1);
    assert('the prompt is answered by one ordinary turn with no pair in its request',
      meanwhile.events.some((event) => event.type === 'agentResultEvent' && event.result.toString() === 'plain answer')
      && meanwhileCall !== undefined && deliveredPairIds(meanwhileCall.messages).length === 0);
    assert('the delegation row is still live after the ordinary turn, and the child still runs',
      meanwhile.state.activeTools.some((tool) => tool.id === 'bg-1')
      && runtime.listSubagentDispatches().some((dispatch) => dispatch.state === 'running')
      && runtime.listBackgroundDelegations().length === 1);

    header('background delegation — (b) settlement while idle: exactly one wake, the SDK attaches the pair');
    model.childGate.open();
    assert('the settlement snapshot is published once, by the hook, with the task id and outcome',
      await waitFor(() => settlements.length === 1) && settlements[0]?.taskId === taskId && settlements[0].state === 'succeeded'
      && settlements[0].toolUseId === 'bg-1' && settlements[0].settledAt !== null);
    await waitFor(() => runtime!.listSubagentDispatches().every((dispatch) => dispatch.state !== 'running'));
    const settledTracked = runtime.listBackgroundDelegations();
    assert('the settled task stays tracked until the SDK delivers it',
      settledTracked.length === 1 && settledTracked[0]?.state === 'succeeded' && settledTracked[0].taskId === taskId);
    const sent = new Set<string>();
    const wakes = delegationWakeEntries(settledTracked, sent);
    for (const entry of wakes) sent.add(entry.taskId);
    assert('the idle sweep yields exactly one wake entry, recorded as a delegation, carrying the label and not the report',
      wakes.length === 1 && wakes[0]?.source === 'delegation' && wakes[0].taskId === taskId && wakes[0].state === 'succeeded'
      && wakes[0].command === 'subagent general#bg1: count things' && !wakes[0].text.includes(CHILD_REPORT)
      && wakes[0].text.startsWith(`<task-notification task="${taskId}" tool="subagent" state="succeeded" elapsed="`)
      && wakes[0].text.includes(BACKGROUND_TASK_RESULT_TOOL_NAME));
    assert('a second sweep owes nothing: one wake per task', delegationWakeEntries(settledTracked, sent).length === 0);
    assert('the queue row names the delegation, not the model-facing text',
      queueRowText(wakes[0]!) === `queued · [delegation ${taskId.slice(0, 8)} succeeded] subagent general#bg1: count things`);
    const { kind: _kind, text: wakeText, image: _image, ...wakeFields } = wakes[0]!;
    const callsBeforeWake = model.calls.length;
    const wakeTurn = await drain(runtime, wakeText, { state: meanwhile.state, wake: wakeFields });
    const wakeCalls = model.calls.slice(callsBeforeWake).filter((call) => call.role === 'parent');
    assert('the wake turn made one model call whose request carries the SDK pair and the notification text',
      wakeCalls.length === 1 && deliveredPairIds(wakeCalls[0]!.messages).length === 1
      && deliveredPairIds(wakeCalls[0]!.messages)[0] === taskId && backgroundResultText(wakeCalls[0]!.messages) === CHILD_REPORT
      && wakeCalls[0]!.messages.some((message) => message.role === 'user'
        && message.content.some((block) => block.type === 'textBlock' && block.text === wakeText)));
    const pairToolUse = wakeCalls[0]!.messages.flatMap((message) => message.content)
      .find((block) => block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME);
    assert('the delivered pair names the original tool and uses the task id',
      pairToolUse !== undefined && pairToolUse.type === 'toolUseBlock' && pairToolUse.toolUseId === taskId
      && JSON.stringify(pairToolUse.input) === JSON.stringify({ toolName: 'subagent' }));
    assert('the wake turn ends with the answer quoting the delivered report',
      wakeTurn.events.some((event) => event.type === 'agentResultEvent' && event.result.stopReason === 'endTurn'
        && event.result.toString() === `done: ${CHILD_REPORT}`));
    const wakeAfter = afterEvents(wakeTurn.events, 'subagent');
    assert('the forwarded after-event opens the wake turn\'s stream, exactly once, carrying the report',
      wakeAfter.length === 1 && wakeTurn.events[0] === wakeAfter[0] && wakeAfter[0]?.toolUse.toolUseId === 'bg-1'
      && wakeAfter[0].result.status === 'success' && blockText(wakeAfter[0].result.content) === CHILD_REPORT
      && afterEvents([...bg.events, ...meanwhile.events], 'subagent').length === 0);
    assert('the synthetic pair reaches the wake stream as messageAddedEvents',
      wakeTurn.events.some((event) => event.type === 'messageAddedEvent' && event.message.content.some(
        (block) => block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME)));
    assert('delivery removes the task from the ledger', runtime.listBackgroundDelegations().length === 0);
    const resultRows = toolRows(wakeTurn.history, 'subagent');
    assert('the live row closes as the background result row with the report, and no row is left live',
      resultRows.length === 2 && resultRows[1]?.summary === 'subagent general#bg1: count things · background result'
      && resultRows[1].status === 'ok' && resultRows[1].preview === CHILD_REPORT && wakeTurn.state.activeTools.length === 0);
    assert('the wake notice row precedes the result row and names the delegation',
      wakeTurn.history.findIndex((item) => item.kind === 'notice' && item.text.startsWith(`delegation wake · ${taskId.slice(0, 8)} succeeded — subagent general#bg1: count things`))
        < wakeTurn.history.findIndex((item) => item === resultRows[1]));
    assert('no dispatch is left running', runtime.listSubagentDispatches().every((dispatch) => dispatch.state === 'succeeded'));

    header('background delegation — (b) tool specs as the model sees them');
    const parentSpecs = parentCalls[0]?.toolSpecs ?? [];
    const flagged = parentSpecs.filter(carriesFlag).map((spec) => spec.name).sort();
    assert('only subagent and workflow carry _background_execution', JSON.stringify(flagged) === '["subagent","workflow"]');
    assert('the parent sees the SDK manage tool', specNames(parentSpecs).includes(MANAGE_BACKGROUND_TASK_TOOL_NAME));
    assert('the waking runtime\'s delegation descriptions say the report arrives in the next turn',
      parentSpecs.filter((spec) => spec.name === 'subagent' || spec.name === 'workflow')
        .every((spec) => spec.description.includes(wakeClause) && !spec.description.includes(SAME_TURN_CLAUSE)));
    const childSpecs = model.calls.find((call) => call.role === 'child')?.toolSpecs ?? [];
    assert('no child spec carries the flag', childSpecs.length > 0 && childSpecs.every((spec) => !carriesFlag(spec)));
    assert('children lack the manage tool and both delegation tools',
      !specNames(childSpecs).some((name) => [MANAGE_BACKGROUND_TASK_TOOL_NAME, 'subagent', 'workflow'].includes(name)));

    header('background delegation — (b) the trajectory: before in the dispatching turn, after in the wake turn');
    const trajectoryFile = trajectoryPath(root, sessionId);
    const initialRead = await readTrajectory(trajectoryFile);
    const read = await readThroughTurnEnd(trajectoryFile, 3);
    // ownPrivateHome cleans even failed runs. Retain these observations before
    // assertions, without changing the trajectory or the production write chain.
    await writeFile(path.join(root, 'wake-trajectory-evidence.json'), JSON.stringify({
      initialRead, read, status: runtime.trajectoryStatus,
      wakeStreamTypes: wakeTurn.events.map((event) => event.type),
    }, null, 2));
    const turn1Records = read.records.filter((record) => record.turn === 1);
    assert('turn 1 records the before-event and no after-event for the delegation',
      turn1Records.some((record) => record.type === 'beforeToolCallEvent'
        && (record as { data?: { toolUse?: { toolUseId?: string } } }).data?.toolUse?.toolUseId === 'bg-1')
      && !turn1Records.some((record) => record.type === 'afterToolCallEvent'
        && (record as { data?: { toolUse?: { toolUseId?: string } } }).data?.toolUse?.toolUseId === 'bg-1'));
    const wakeRecords = read.records.filter((record) => record.turn === 3);
    assert('the wake turn records the after-event exactly once as an ordinary afterToolCallEvent',
      read.records.filter((record) => record.type === 'afterToolCallEvent'
        && (record as { data?: { toolUse?: { toolUseId?: string } } }).data?.toolUse?.toolUseId === 'bg-1').length === 1
      && wakeRecords.some((record) => record.type === 'afterToolCallEvent'));
    const wakeRecord = wakeRecords.find((record): record is TaskNotificationRecord => record.type === 'taskNotification');
    assert('the wake turn opens with a taskNotification record carrying source: delegation, and no userInput',
      wakeRecord !== undefined && wakeRecord.source === 'delegation' && wakeRecord.taskId === taskId
      && wakeRecord.command === 'subagent general#bg1: count things' && wakeRecord.text === wakeText
      && !wakeRecords.some((record) => record.type === 'userInput'));
    assert('bash-style wakes are unaffected: the discriminator is absent from every non-delegation record',
      read.records.every((record) => record.type !== 'userInput' || !('source' in record)));
    const replayed = replayRecords(read.records, {});
    const replayRows = toolRows(replayed.history, 'subagent');
    // `toolResultEvent` is not recorded, so replay has no ack row; the result row must
    // still read as the background result — the live row it finishes crossed the turn.
    assert('replay shows the background result row with the same summary and preview as live',
      replayRows.length === 1 && replayRows[0]?.summary === resultRows[1]?.summary && replayRows[0]?.preview === CHILD_REPORT);
    const transcript = formatReplay({ ...replayed, damage: undefined });
    assert('formatReplay prints the delegation wake notice, the result row and the report',
      transcript.includes(`delegation wake · ${taskId.slice(0, 8)} succeeded — subagent general#bg1: count things`)
      && transcript.includes('  tool subagent [ok] subagent general#bg1: count things · background result')
      && transcript.includes(`    ${CHILD_REPORT}`) && !transcript.includes(`you> ${wakeText.slice(0, 20)}`));
    for (const turn of [1, 2, 3]) {
      const turnEnded = read.records.find((record): record is TurnEndedRecord => record.type === 'turnEnded' && record.turn === turn);
      assert(`turnOutcome() of turn ${turn} is clean`, turnEnded !== undefined && turnOutcome(turnEnded) === 'clean');
    }

    header('background delegation — (c) a child settling during a user turn is delivered in that turn, no wake');
    model.scenario = 'background-only';
    model.bgId = 'bg-mid';
    model.childGate = new Gate();
    settlements.length = 0;
    const midDispatch = await drain(runtime, 'dispatch, then ask something slow', { state: wakeTurn.state });
    assert('the dispatching turn ended with the child running',
      midDispatch.events.some((event) => event.type === 'agentResultEvent' && event.result.toString() === 'dispatched')
      && runtime.listBackgroundDelegations().length === 1);
    const midTaskId = runtime.listBackgroundDelegations()[0]!.taskId;
    model.scenario = 'slow-plain';
    model.hold = async () => {
      // The user turn's model call is open; settle the child now, inside the turn, and
      // give the engine a beat to mark the task terminal before the answer ends.
      model.childGate.open();
      await waitFor(() => settlements.length === 1);
      await waitFor(() => runtime!.listSubagentDispatches().every((dispatch) => dispatch.state !== 'running'));
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const callsBeforeSlow = model.calls.length;
    const slow = await drain(runtime, 'a slow question', { state: midDispatch.state });
    const slowCalls = model.calls.slice(callsBeforeSlow).filter((call) => call.role === 'parent');
    assert('the user turn made two model calls: the slow answer, then the SDK\'s end-of-invocation delivery of the pair',
      slowCalls.length === 2 && !deliveredPairIds(slowCalls[0]!.messages).includes(midTaskId)
      && deliveredPairIds(slowCalls[1]!.messages).includes(midTaskId) && resultTextFor(slowCalls[1]!.messages, midTaskId) === CHILD_REPORT);
    assert('one turn, one agentResultEvent, quoting the report',
      slow.events.filter((event) => event.type === 'agentResultEvent').length === 1
      && slow.events.some((event) => event.type === 'agentResultEvent' && event.result.toString() === `done: ${CHILD_REPORT}`));
    assert('the forwarded after-event lands inside that turn, exactly once',
      afterEvents(slow.events, 'subagent').length === 1 && afterEvents(slow.events, 'subagent')[0]?.toolUse.toolUseId === 'bg-mid'
      && afterEvents(midDispatch.events, 'subagent').length === 0);
    assert('nothing is tracked afterwards, so an idle sweep owes no wake',
      runtime.listBackgroundDelegations().length === 0 && delegationWakeEntries(runtime.listBackgroundDelegations(), new Set()).length === 0
      && slow.state.activeTools.length === 0);

    header('background delegation — (d) /rewind and /clear refuse while a delegation is tracked');
    model.scenario = 'background-only';
    model.bgId = 'bg-live';
    model.childGate = new Gate();
    settlements.length = 0;
    await drain(runtime, 'one more background delegation', { state: slow.state });
    const live = runtime.listBackgroundDelegations();
    assert('one delegation is tracked and running', live.length === 1 && live[0]?.state === 'running');
    const liveTaskId = live[0]!.taskId;
    const catalogue = await runtime.listRewindCheckpoints();
    const checkpoint = catalogue.checkpoints.at(-1);
    assert('a catalogued checkpoint exists to attempt', checkpoint !== undefined);
    let rewindError = '';
    try {
      await runtime.startRewind(checkpoint!);
    } catch (error) {
      rewindError = error instanceof Error ? error.message : String(error);
    }
    assert('/rewind is refused locally, naming the task and the two exits',
      rewindError === liveBackgroundDelegationRefusal('/rewind', live) && rewindError.startsWith('/rewind refused')
      && rewindError.includes(liveTaskId) && rewindError.includes('/agents cancel <id>') && rewindError.includes('completion wake'));
    let clearError = '';
    try {
      await runtime.startNewSession();
    } catch (error) {
      clearError = error instanceof Error ? error.message : String(error);
    }
    assert('/clear is refused locally with the same sentence for /clear',
      clearError === liveBackgroundDelegationRefusal('/clear', live) && clearError.startsWith('/clear refused') && clearError.includes(liveTaskId));
    assert('the refusals released nothing: the child still runs and the runtime still answers',
      runtime.listSubagentDispatches().some((dispatch) => dispatch.state === 'running') && settlements.length === 0
      && (model.scenario = 'plain', (await drain(runtime, 'still here?')).events.some((event) => event.type === 'agentResultEvent')));
    const liveDispatch = runtime.listSubagentDispatches().find((dispatch) => dispatch.state === 'running');
    const cancelled = runtime.cancelSubagentDispatch(liveDispatch!.dispatchId);
    assert('/agents cancel <id> cancels the one child', cancelled.outcome === 'cancelled');
    assert('the cancelled run settles and publishes once', await waitFor(() => settlements.length === 1) && settlements[0]?.taskId === liveTaskId);
    const cancelledWakes = delegationWakeEntries(runtime.listBackgroundDelegations(), new Set());
    assert('the settlement owes one wake', cancelledWakes.length === 1);
    const { kind: _k2, text: cancelledWakeText, image: _i2, ...cancelledFields } = cancelledWakes[0]!;
    const cancelledWakeTurn = await drain(runtime, cancelledWakeText, { wake: cancelledFields });
    assert('the wake delivers the cancelled child\'s pair and empties the ledger',
      cancelledWakeTurn.events.some((event) => event.type === 'messageAddedEvent' && event.message.content.some(
        (block) => block.type === 'toolResultBlock' && block.toolUseId === liveTaskId))
      && runtime.listBackgroundDelegations().length === 0);

    header('background delegation — (g) a hook cancel precedes dispatch');
    const agent = runtimeAgent(runtime);
    const dispatchesBefore = runtime.listSubagentDispatches().length;
    agent.addHook(BeforeToolCallEvent, (event) => {
      if (event.toolUse.name === 'subagent' && (event.toolUse.input as { task?: string }).task === 'denied task') {
        event.cancel = 'DENIED: test hook';
      }
    });
    model.scenario = 'denied';
    model.calls.length = 0;
    const denied = await drain(runtime, 'hook denies the background call');
    const deniedAfter = afterEvents(denied.events, 'subagent');
    assert('the denial arrives as an ordinary DENIED after-event through the stream',
      deniedAfter.length === 1 && deniedAfter[0]?.result.status === 'error' && blockText(deniedAfter[0].result.content).startsWith('DENIED:'));
    assert('no ack and no background task: the executor cancelled before routeToolCall',
      !denied.events.some((event) => event.type === 'toolResultEvent' && blockText(event.result.content).startsWith('Background task dispatched.'))
      && runtime.listBackgroundDelegations().length === 0);
    assert('no dispatch record and no child model call', runtime.listSubagentDispatches().length === dispatchesBefore
      && model.calls.every((call) => call.role === 'parent'));
    assert('the denied row is a single denied transcript row',
      toolRows(denied.history, 'subagent').length === 1 && toolRows(denied.history, 'subagent')[0]?.status === 'denied');

    header('background delegation — (g) plan mode denies the manage tool cancel');
    runtime.changePermissionMode('plan');
    model.scenario = 'manage-cancel';
    const manage = await drain(runtime, 'cancel a task in plan mode');
    const manageAfter = afterEvents(manage.events, MANAGE_BACKGROUND_TASK_TOOL_NAME);
    assert('plan mode denied the model-driven cancel',
      manageAfter.length === 1 && blockText(manageAfter[0]!.result.content).startsWith('DENIED: Plan mode blocked this execute call'));
    runtime.changePermissionMode('yolo');

    header('background delegation — (g) foreground report is byte-identical');
    model.scenario = 'foreground';
    model.childGate = new Gate();
    model.childGate.open();
    const fg = await drain(runtime, 'delegate in the foreground');
    const fgAfter = afterEvents(fg.events, 'subagent');
    assert('the foreground call returns the same report text',
      fgAfter.length === 1 && blockText(fgAfter[0]!.result.content) === blockText(wakeAfter[0]!.result.content));
    const fgRows = toolRows(fg.history, 'subagent');
    assert('the foreground row is the plain delegation row, unchanged',
      fgRows.length === 1 && fgRows[0]?.summary === 'subagent general#fg1: count things' && fgRows[0].preview === CHILD_REPORT);

    header('background delegation — (g) Ctrl+C mid-background');
    model.scenario = 'cancel';
    model.childGate = new Gate();
    model.calls.length = 0;
    settlements.length = 0;
    let cancelledOnce = false;
    const cancelledTurn = await drain(runtime, 'cancel while the child runs', {
      onEvent: (event) => {
        if (event.type === 'toolResultEvent' && event.result.toolUseId === 'bg-cancel' && !cancelledOnce) {
          cancelledOnce = true;
          runtime!.cancel();
        }
      },
    });
    const cancelResult = cancelledTurn.events.find((event) => event.type === 'agentResultEvent');
    assert('the turn ends cancelled', cancelResult?.type === 'agentResultEvent' && cancelResult.result.stopReason === 'cancelled');
    assert('no dispatch is left running after the cancel',
      await waitFor(() => runtime!.listSubagentDispatches().every((dispatch) => dispatch.state !== 'running')));
    assert('the cancelled child reads cancelled, not failed',
      runtime.listSubagentDispatches().some((dispatch) => dispatch.state === 'cancelled'));
    await waitFor(() => settlements.length === 1);
    model.scenario = 'plain';
    model.calls.length = 0;
    const afterCancel = await drain(runtime, 'next turn after cancel');
    assert('the next send() completes normally and the SDK delivers the cancelled task\'s pair before its model call',
      afterCancel.events.some((event) => event.type === 'agentResultEvent' && event.result.stopReason === 'endTurn')
      && deliveredPairIds(model.calls.at(-1)?.messages ?? []).includes(settlements[0]?.taskId ?? '')
      && runtime.listBackgroundDelegations().length === 0);
    assert('the cancelled run\'s after-event was forwarded exactly once, in the cancelled turn or at the next stream\'s start',
      afterEvents([...cancelledTurn.events, ...afterCancel.events], 'subagent').length === 1);

    header('background delegation — (d) /clear succeeds once nothing is tracked, and the successor keeps the option');
    unsubscribeSettlements();
    const successor = await runtime.startNewSession();
    runtime = successor;
    model.scenario = 'plain';
    model.calls.length = 0;
    await drain(runtime, 'after clear');
    const clearSpecs = model.calls.at(-1)?.toolSpecs ?? [];
    assert('the /clear successor advertises the flag on both delegation tools',
      JSON.stringify(clearSpecs.filter(carriesFlag).map((spec) => spec.name).sort()) === '["subagent","workflow"]');
    const target = runtime.modelChoices.find((choice) => choice.name === 'second');
    if (target === undefined) throw new Error('fixture: second model missing');
    const switched = await runtime.changeModel(target);
    await switched.saved.catch(() => undefined);
    const beforeSwitch = runtimeAgent(runtime);
    model.calls.length = 0;
    await drain(runtime, 'after model switch');
    assert('/model keeps the same Agent, so the plugin and its option survive', runtimeAgent(runtime) === beforeSwitch);
    const switchedSpecs = model.calls.at(-1)?.toolSpecs ?? [];
    assert('after /model the delegation tools still carry the flag and the waking clause',
      JSON.stringify(switchedSpecs.filter(carriesFlag).map((spec) => spec.name).sort()) === '["subagent","workflow"]'
      && switchedSpecs.find((spec) => spec.name === 'subagent')?.description.includes(wakeClause) === true);

    header('background delegation — (e) shutdown() cancels a tracked child');
    model.scenario = 'background-only';
    model.bgId = 'bg-exit';
    model.childGate = new Gate();
    await drain(runtime, 'dispatch, then exit');
    assert('the child runs when shutdown begins', runtime.listSubagentDispatches().some((dispatch) => dispatch.state === 'running'));
    await runtime.shutdown();
    assert('shutdown left no running dispatch', runtime.listSubagentDispatches().every((dispatch) => dispatch.state !== 'running'));
    runtime = undefined;

    header('background delegation — (f) no-wake runtime (headless-shaped): same-turn delivery, unchanged');
    runtime = await AgentRuntime.create(baseOptions);
    model.scenario = 'background';
    model.bgId = 'bg-1';
    model.childGate = new Gate();
    model.calls.length = 0;
    let noWakeRunningAtWait: number | undefined;
    model.onParentWaiting = () => {
      noWakeRunningAtWait = runtime!.listSubagentDispatches().filter((dispatch) => dispatch.state === 'running').length;
      // Release the child only now: the parent has already made two model calls after the ack.
      model.childGate.open();
    };
    const sameTurn = await drain(runtime, 'delegate in the background');
    const noWakeCalls = model.calls.filter((call) => call.role === 'parent');
    assert('the parent made four model calls in one send(): the SDK waited for the task inside the invocation',
      noWakeCalls.length === 4 && noWakeRunningAtWait === 1
      && sameTurn.events.filter((event) => event.type === 'agentResultEvent').length === 1);
    assert('the fourth model call holds the synthetic result pair with the child report',
      noWakeCalls[3] !== undefined && backgroundResultText(noWakeCalls[3].messages) === CHILD_REPORT
      && noWakeCalls.slice(0, 3).every((call) => deliveredPairIds(call.messages).length === 0));
    assert('the turn ends once with the answer quoting the report',
      sameTurn.events.some((event) => event.type === 'agentResultEvent' && event.result.stopReason === 'endTurn'
        && event.result.toString() === `done: ${CHILD_REPORT}`));
    const types = sameTurn.events.map((event) => event.type === 'beforeToolCallEvent' || event.type === 'afterToolCallEvent'
      ? `${event.type}:${event.toolUse.name}`
      : event.type === 'toolResultEvent' ? `toolResultEvent:${event.result.toolUseId}` : event.type);
    const indexOf = (label: string) => types.indexOf(label);
    assert('the stream shows before(subagent) → ack → before/after(update_plan) → after(subagent) → result, all in one turn',
      indexOf('beforeToolCallEvent:subagent') !== -1
      && indexOf('beforeToolCallEvent:subagent') < indexOf('toolResultEvent:bg-1')
      && indexOf('toolResultEvent:bg-1') < indexOf('beforeToolCallEvent:update_plan')
      && indexOf('afterToolCallEvent:update_plan') < indexOf('afterToolCallEvent:subagent')
      && indexOf('afterToolCallEvent:subagent') < indexOf('agentResultEvent')
      && afterEvents(sameTurn.events, 'subagent').length === 1);
    assert('nothing is tracked after the turn and no live row is left',
      runtime.listBackgroundDelegations().length === 0 && sameTurn.state.activeTools.length === 0);
    const sameTurnRows = toolRows(sameTurn.history, 'subagent');
    assert('the transcript shows the ack row then the result row inside the turn',
      sameTurnRows.length === 2 && sameTurnRows[1]?.summary === 'subagent general#bg1: count things · background result'
      && sameTurnRows[1].preview === CHILD_REPORT);
    assert('the no-wake runtime\'s delegation descriptions keep the same-turn sentence byte for byte',
      (noWakeCalls[0]?.toolSpecs ?? []).filter((spec) => spec.name === 'subagent' || spec.name === 'workflow')
        .every((spec) => spec.description.includes(SAME_TURN_CLAUSE)));

    header('background delegation — (d) /rewind succeeds once nothing is tracked');
    model.scenario = 'plain';
    await drain(runtime, 'one more turn');
    const rewindCatalogue = await runtime.listRewindCheckpoints();
    const rewindCheckpoint = rewindCatalogue.checkpoints.find((entry) => entry.prompt === 'one more turn');
    assert('the background turn left a catalogued boundary behind it', rewindCheckpoint !== undefined);
    if (rewindCheckpoint !== undefined) {
      const branched = await runtime.startRewind(rewindCheckpoint);
      runtime = branched;
      const after = await drain(runtime, 'after rewind');
      assert('the rewind successor completes a turn: assertCanLoadSnapshot never fired',
        after.events.some((event) => event.type === 'agentResultEvent' && event.result.stopReason === 'endTurn'));
      assert('the restored history still holds the delivered background result pair',
        runtimeAgent(runtime).messages.some((message) => message.content.some(
          (block) => block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME)));
    }
  } finally {
    await runtime?.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
