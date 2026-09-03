/**
 * SER-064 — background delegation through the SDK's own `backgroundTasks` plugin.
 *
 * Everything here runs against a real `AgentRuntime` with one scripted offline
 * model that plays both the parent and every child (it tells them apart by whether
 * the delegation tools are in its `toolSpecs`). No model call, no network.
 *
 * What is proven, in order:
 *   (i)   the parent's `subagent`/`workflow` specs carry `_background_execution` and
 *         nothing else does; children see neither the flag nor
 *         `strands_manage_background_task`;
 *   (ii)  one `send()`: background `subagent` → ack in the same tool round → another
 *         tool call while the child is still running → the SDK's synthetic
 *         `strands_background_task_result` pair before the following model call →
 *         the forwarded `afterToolCallEvent` with the same report a foreground call
 *         returns;
 *   (iii) a hook `cancel` on a background-marked call is honoured before dispatch
 *         (no registry record, no ack), and plan mode denies the manage tool's
 *         `cancel` — `subagent` itself is classified `read`, so plan mode lets it
 *         run, background or not (unchanged by SER-064);
 *   (iv)  `strands_manage_background_task` classification;
 *   (v)   Ctrl+C mid-background leaves no `running` dispatch and the next `send()`
 *         works;
 *   (vi)  `/clear` successor and `/model` keep the option;
 *   (vii) the trajectory replays the result row through `formatReplay` and
 *         `turnOutcome()` reads `clean`;
 *   (viii) `/rewind` after the background turn succeeds.
 *
 * Run: pnpm tsx spike/verify-background-delegation.ts
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  backgroundExecutionRequested,
} from '../src/agent/background-delegation.js';
import { allowAllBridge, classify, PermissionGate } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { trajectoryPath } from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { turnOutcome, type TurnEndedRecord } from '../src/trajectory/record.js';
import { formatReplay, replayRecords } from '../src/trajectory/replay.js';
import { initialTurnState, turnReducer, type HistoryItem, type TurnState } from '../src/tui/turn-state.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('background-delegation');

const CHILD_REPORT = 'child report: three files counted';
const MAX_CONCURRENT = 3;

type Scenario = 'background' | 'foreground' | 'cancel' | 'plain' | 'manage-cancel' | 'denied';

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
  /** Called when the parent ends the model call that leaves the child still running. */
  onParentWaiting: (() => void) | undefined;

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

  private *parentTurn(messages: Message[]): Iterable<ModelStreamEvent> {
    const delivered = messages.some((message) =>
      message.content.some((block) => block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME),
    );
    switch (this.scenario) {
      case 'plain':
        yield* text('plain answer');
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
      case 'background':
        if (delivered) {
          const pair = backgroundResultText(messages);
          yield* text(`done: ${pair ?? '(no delivered result)'}`);
          return;
        }
        if (hasResultFor(messages, 'plan-1')) {
          // Third call: the child is still gated. End the turn; the SDK now waits
          // for the task and continues this same invocation with the result pair.
          this.onParentWaiting?.();
          yield* text('waiting for the background child');
          return;
        }
        if (hasResultFor(messages, 'bg-1')) {
          yield* toolUse('plan-1', 'update_plan', {
            plan: [{ item: 'read while the child runs', status: 'in_progress' }],
          });
          return;
        }
        yield* toolUse('bg-1', 'subagent', { task: 'count things', [BACKGROUND_EXECUTION_FLAG]: true });
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

/** The text of the SDK's delivered `strands_background_task_result` tool result. */
function backgroundResultText(messages: readonly Message[]): string | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME) {
        return resultTextFor(messages, block.toolUseId);
      }
    }
  }
  return undefined;
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

/** Drains one turn, feeding every event through the TUI reducer as the live frame would. */
async function drain(
  runtime: AgentRuntime,
  prompt: string,
  onEvent?: (event: AgentStreamEvent) => void,
): Promise<Drained> {
  const events: AgentStreamEvent[] = [];
  let state = turnReducer(initialTurnState, { type: 'userInput', text: prompt });
  for await (const event of runtime.send(prompt)) {
    events.push(event);
    state = turnReducer(state, { type: 'streamEvent', event });
    onEvent?.(event);
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
  header('background delegation — option shape and pure helpers');
  const option = backgroundDelegationConfig({
    delegationTools: ['subagent', 'workflow'],
    ordinaryToolNames: ['bash', 'fileEditor', 'subagent'],
    maxConcurrency: MAX_CONCURRENT,
  });
  assert('agentic names exactly the delegation tools', JSON.stringify(option.agentic) === '["subagent","workflow"]');
  assert(
    'never names every ordinary tool, drops a delegation tool listed twice, and closes with the wildcard',
    JSON.stringify(option.never) === '["bash","fileEditor","*"]',
  );
  assert('waitForCompletion is true so results land in the same turn', option.waitForCompletion === true);
  assert('maxConcurrency is the SER-061 cap', option.maxConcurrency === MAX_CONCURRENT);
  assert('the flag helper reads only a literal true', backgroundExecutionRequested({ [BACKGROUND_EXECUTION_FLAG]: true })
    && !backgroundExecutionRequested({ [BACKGROUND_EXECUTION_FLAG]: 'true' }) && !backgroundExecutionRequested(null));
  assert('the ack parser reads the SDK ack shape only',
    backgroundAckTaskId([{ type: 'textBlock', text: 'Background task dispatched.\n\nTask ID: abc-1\nTool: subagent' }]) === 'abc-1'
    && backgroundAckTaskId([{ type: 'textBlock', text: 'Task ID: abc-1' }]) === undefined);

  header('background delegation — (iv) manage tool classification');
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
  let runtime: AgentRuntime | undefined;
  try {
    runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: allowAllBridge });
    const sessionId = runtime.info.sessionId;

    header('background delegation — (ii) one send(): ack, parallel tool call, same-turn delivery');
    model.scenario = 'background';
    model.childGate = new Gate();
    let runningAtWait: number | undefined;
    let ackSeenAt: number | undefined;
    let childSettledAt: number | undefined;
    model.onParentWaiting = () => {
      runningAtWait = runtime!.listSubagentDispatches().filter((dispatch) => dispatch.state === 'running').length;
      // Release the child only now: the parent has already made two model calls after the ack.
      model.childGate.open();
    };
    const unsubscribe = runtime.subscribeToSubagentDispatches((dispatch) => {
      if (dispatch.state !== 'running') childSettledAt = Date.now();
    });
    const bg = await drain(runtime, 'delegate in the background', (event) => {
      if (event.type === 'toolResultEvent' && event.result.toolUseId === 'bg-1' && ackSeenAt === undefined) ackSeenAt = Date.now();
    });
    unsubscribe();

    const parentCalls = model.calls.filter((call) => call.role === 'parent');
    const childCalls = model.calls.filter((call) => call.role === 'child');
    assert('the parent made four model calls in one send()', parentCalls.length === 4);
    assert('exactly one child ran', childCalls.length === 1);
    const ackText = resultTextFor(parentCalls[1]?.messages ?? [], 'bg-1') ?? '';
    assert('the second model call already holds the ack for the background call', ackText.startsWith('Background task dispatched.'));
    const taskId = backgroundAckTaskId([{ type: 'textBlock', text: ackText }]);
    assert('the ack carries a task id', typeof taskId === 'string' && taskId.length > 0);
    assert('the parent issued another tool call (update_plan) before the child settled',
      parentCalls[2] !== undefined && hasResultFor(parentCalls[2].messages, 'plan-1') && runningAtWait === 1
      && childSettledAt !== undefined && parentCalls[2].at <= childSettledAt);
    assert('the fourth model call holds the synthetic result pair with the child report',
      parentCalls[3] !== undefined && backgroundResultText(parentCalls[3].messages) === CHILD_REPORT);
    const pairToolUse = parentCalls[3]?.messages.flatMap((message) => message.content)
      .find((block) => block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME);
    assert('the delivered pair names the original tool and uses the task id',
      pairToolUse !== undefined && pairToolUse.type === 'toolUseBlock' && pairToolUse.toolUseId === taskId
      && JSON.stringify(pairToolUse.input) === JSON.stringify({ toolName: 'subagent' }));
    const result = bg.events.find((event) => event.type === 'agentResultEvent');
    assert('the turn ends once, with endTurn and the final answer quoting the report',
      bg.events.filter((event) => event.type === 'agentResultEvent').length === 1
      && result?.type === 'agentResultEvent' && result.result.stopReason === 'endTurn'
      && result.result.toString() === `done: ${CHILD_REPORT}`);

    // Stream order as the drivers see it.
    const types = bg.events.map((event) => event.type === 'beforeToolCallEvent' || event.type === 'afterToolCallEvent'
      ? `${event.type}:${event.toolUse.name}`
      : event.type === 'toolResultEvent' ? `toolResultEvent:${event.result.toolUseId}` : event.type);
    const indexOf = (label: string) => types.indexOf(label);
    assert('the stream shows before(subagent) → ack → before/after(update_plan) → after(subagent) → result',
      indexOf('beforeToolCallEvent:subagent') !== -1
      && indexOf('beforeToolCallEvent:subagent') < indexOf('toolResultEvent:bg-1')
      && indexOf('toolResultEvent:bg-1') < indexOf('beforeToolCallEvent:update_plan')
      && indexOf('afterToolCallEvent:update_plan') < indexOf('afterToolCallEvent:subagent')
      && indexOf('afterToolCallEvent:subagent') < indexOf('agentResultEvent'));
    const subagentAfter = afterEvents(bg.events, 'subagent');
    assert('exactly one forwarded afterToolCallEvent for the background subagent, carrying the report',
      subagentAfter.length === 1 && subagentAfter[0]?.toolUse.toolUseId === 'bg-1'
      && subagentAfter[0].result.status === 'success' && blockText(subagentAfter[0].result.content) === CHILD_REPORT
      && !(BACKGROUND_EXECUTION_FLAG in (subagentAfter[0].toolUse.input as Record<string, unknown>)));
    assert('the synthetic pair reaches the stream as messageAddedEvents without breaking anything',
      bg.events.some((event) => event.type === 'messageAddedEvent' && event.message.content.some(
        (block) => block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME)));
    assert('no dispatch is left running', runtime.listSubagentDispatches().every((dispatch) => dispatch.state === 'succeeded'));

    // The live transcript, through the same reducer the TUI uses.
    const liveRows = toolRows(bg.history, 'subagent');
    assert('the transcript shows the ack row then the result row for the delegation',
      liveRows.length === 2
      && liveRows[0]?.summary === `subagent general#bg1: count things · delegated in background (task ${taskId})`
      && liveRows[0].status === 'ok' && liveRows[0].preview === ''
      && liveRows[1]?.summary === 'subagent general#bg1: count things · background result'
      && liveRows[1].status === 'ok' && liveRows[1].preview === CHILD_REPORT);
    assert('the ack row lands before the update_plan row, the result row after it',
      bg.history.findIndex((item) => item === liveRows[0]) < bg.history.findIndex((item) => item.kind === 'tool' && item.name === 'update_plan')
      && bg.history.findIndex((item) => item.kind === 'tool' && item.name === 'update_plan') < bg.history.findIndex((item) => item === liveRows[1]));
    assert('the turn leaves no live row behind', bg.state.activeTools.length === 0);

    header('background delegation — (i) tool specs as the model sees them');
    const parentSpecs = parentCalls[0]?.toolSpecs ?? [];
    const flagged = parentSpecs.filter(carriesFlag).map((spec) => spec.name).sort();
    assert('only subagent and workflow carry _background_execution', JSON.stringify(flagged) === '["subagent","workflow"]');
    assert('the parent sees the SDK manage tool', specNames(parentSpecs).includes(MANAGE_BACKGROUND_TASK_TOOL_NAME));
    assert('the delegation descriptions state the background option',
      parentSpecs.filter((spec) => spec.name === 'subagent' || spec.name === 'workflow')
        .every((spec) => spec.description.includes(`${BACKGROUND_EXECUTION_FLAG}: true`)));
    const childSpecs = childCalls[0]?.toolSpecs ?? [];
    assert('no child spec carries the flag', childSpecs.length > 0 && childSpecs.every((spec) => !carriesFlag(spec)));
    assert('children lack the manage tool and both delegation tools',
      !specNames(childSpecs).some((name) => [MANAGE_BACKGROUND_TASK_TOOL_NAME, 'subagent', 'workflow'].includes(name)));

    header('background delegation — foreground report is byte-identical');
    model.scenario = 'foreground';
    model.childGate = new Gate();
    model.childGate.open();
    const fg = await drain(runtime, 'delegate in the foreground');
    const fgAfter = afterEvents(fg.events, 'subagent');
    assert('the foreground call returns the same report text',
      fgAfter.length === 1 && blockText(fgAfter[0]!.result.content) === blockText(subagentAfter[0]!.result.content));
    const fgRows = toolRows(fg.history, 'subagent');
    assert('the foreground row is the plain delegation row, unchanged',
      fgRows.length === 1 && fgRows[0]?.summary === 'subagent general#fg1: count things' && fgRows[0].preview === CHILD_REPORT);
    assert('no toolResultEvent row is drawn for a foreground call', fg.history.filter((item) => item.kind === 'tool').length === 1);

    header('background delegation — (vii) trajectory replay');
    const read = await readTrajectory(trajectoryPath(root, sessionId));
    const replayed = replayRecords(read.records, { turn: 1 });
    const replayRows = toolRows(replayed.history, 'subagent');
    assert('replay shows the background result row with the same summary and preview as live',
      replayRows.length === 1 && replayRows[0]?.summary === liveRows[1]?.summary && replayRows[0]?.preview === CHILD_REPORT);
    assert('replay orders the result row after the tool call the parent made meanwhile',
      replayed.history.findIndex((item) => item.kind === 'tool' && item.name === 'update_plan')
        < replayed.history.findIndex((item) => item === replayRows[0]));
    const transcript = formatReplay({ ...replayed, damage: undefined });
    assert('formatReplay prints the row and the report',
      transcript.includes('  tool subagent [ok] subagent general#bg1: count things · background result')
      && transcript.includes(`    ${CHILD_REPORT}`));
    const turnEnded = read.records.find((record): record is TurnEndedRecord => record.type === 'turnEnded' && record.turn === 1);
    assert('turnOutcome() is unchanged: clean', turnEnded !== undefined && turnOutcome(turnEnded) === 'clean');
    assert('the background after-event is recorded once as an ordinary afterToolCallEvent',
      read.records.filter((record) => record.turn === 1 && record.type === 'afterToolCallEvent'
        && (record as { data?: { toolUse?: { toolUseId?: string } } }).data?.toolUse?.toolUseId === 'bg-1').length === 1);
    assert('no new record type: the synthetic pair is counted as dropped messageAddedEvents, not stored',
      read.records.every((record) => !JSON.stringify(record).includes(`"type":"${'messageAddedEvent'}"`)));

    header('background delegation — (iii) a hook cancel precedes dispatch');
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
      && !denied.events.some((event) => event.type === 'messageAddedEvent' && event.message.content.some(
        (block) => block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME)));
    assert('no dispatch record and no child model call', runtime.listSubagentDispatches().length === dispatchesBefore
      && model.calls.every((call) => call.role === 'parent'));
    assert('the denied row is a single denied transcript row',
      toolRows(denied.history, 'subagent').length === 1 && toolRows(denied.history, 'subagent')[0]?.status === 'denied');

    header('background delegation — (iii) plan mode denies the manage tool cancel');
    runtime.changePermissionMode('plan');
    model.scenario = 'manage-cancel';
    const manage = await drain(runtime, 'cancel a task in plan mode');
    const manageAfter = afterEvents(manage.events, MANAGE_BACKGROUND_TASK_TOOL_NAME);
    assert('plan mode denied the model-driven cancel',
      manageAfter.length === 1 && blockText(manageAfter[0]!.result.content).startsWith('DENIED: Plan mode blocked this execute call'));
    runtime.changePermissionMode('yolo');

    header('background delegation — (v) cancel mid-background');
    model.scenario = 'cancel';
    model.childGate = new Gate();
    model.calls.length = 0;
    let cancelled = false;
    const cancelledTurn = await drain(runtime, 'cancel while the child runs', (event) => {
      if (event.type === 'toolResultEvent' && event.result.toolUseId === 'bg-cancel' && !cancelled) {
        cancelled = true;
        runtime!.cancel();
      }
    });
    const cancelResult = cancelledTurn.events.find((event) => event.type === 'agentResultEvent');
    assert('the turn ends cancelled', cancelResult?.type === 'agentResultEvent' && cancelResult.result.stopReason === 'cancelled');
    const settled = await waitFor(() => runtime!.listSubagentDispatches().every((dispatch) => dispatch.state !== 'running'));
    assert('no dispatch is left running after the cancel', settled);
    assert('the cancelled child reads cancelled, not failed',
      runtime.listSubagentDispatches().some((dispatch) => dispatch.state === 'cancelled'));
    assert('the cancelled turn leaves no live row', cancelledTurn.state.activeTools.length === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    model.scenario = 'plain';
    model.calls.length = 0;
    const afterCancel = await drain(runtime, 'next turn after cancel');
    const afterCancelResult = afterCancel.events.find((event) => event.type === 'agentResultEvent');
    assert('the next send() completes normally', afterCancelResult?.type === 'agentResultEvent' && afterCancelResult.result.stopReason === 'endTurn');
    assert('the SDK delivers the cancelled task\'s pair before the next model call (documented: never mid-turn, never lost)',
      model.calls.at(-1)?.messages.some((message) => message.content.some(
        (block) => block.type === 'toolUseBlock' && block.name === BACKGROUND_TASK_RESULT_TOOL_NAME)) === true);

    header('background delegation — (vi) /clear successor and /model keep the option');
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
    assert('after /model the delegation tools still carry the flag',
      JSON.stringify(switchedSpecs.filter(carriesFlag).map((spec) => spec.name).sort()) === '["subagent","workflow"]');

    header('background delegation — (viii) /rewind after a background-delegated turn');
    model.scenario = 'background';
    model.childGate = new Gate();
    model.onParentWaiting = () => model.childGate.open();
    const rewindTurn = await drain(runtime, 'background before rewind');
    assert('the successor ran the background scenario cleanly',
      afterEvents(rewindTurn.events, 'subagent').length === 1 && rewindTurn.state.activeTools.length === 0);
    model.scenario = 'plain';
    await drain(runtime, 'one more turn');
    const catalogue = await runtime.listRewindCheckpoints();
    const checkpoint = catalogue.checkpoints.find((entry) => entry.prompt === 'one more turn');
    assert('the background turn left a catalogued boundary behind it', checkpoint !== undefined);
    if (checkpoint !== undefined) {
      const branched = await runtime.startRewind(checkpoint);
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
