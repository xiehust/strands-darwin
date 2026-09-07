/**
 * Offline SER-075 contracts: a settled `subagent` dispatch stays continuable.
 *
 * `SubagentTool` keeps the last `MAX_RETAINED_CHILDREN` (4) settled children's
 * *conversations* (a copy of the SDK `Agent.messages`, never the Agent or its bash
 * session) and `subagent continue=<dispatch id>` sends a follow-up task into one
 * of them as a **new** dispatch record (`continuedFrom`) through the ordinary
 * path. Proved here with scripted models and no network:
 *
 *   (a) a continuation's first model request is the retained conversation followed
 *       by the follow-up; the new record carries `continuedFrom` and a new id, the
 *       original record is unchanged, the `/agents` row names the continuation and
 *       an ordinary row is byte-identical; a chain of follow-ups works;
 *   (b) refusals before any model construction: unknown id, running id, cancelled
 *       dispatch, mismatched `agent`, evicted id (named as evicted), a failed
 *       dispatch whose conversation is not whole, a `workflow` node;
 *   (c) eviction at the fifth settlement, store never above 4; a failed dispatch
 *       ending in a complete assistant message (refusal stop) *is* retained;
 *   (d) the concurrency cap applies to a continuation; `shutdown()` empties the store;
 *   (e) records never carry transcript — a snapshot has only the known keys;
 *   (f) at runtime level, `startNewSession()` and `startRewind()` successors know
 *       nothing continuable (a fresh `SubagentTool` per runtime, proved, not assumed).
 *
 * Run: pnpm tsx spike/verify-continuable-children.ts
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Agent, Message, Model, TextBlock, ToolUseBlock, tool } from '@strands-agents/sdk';
import type { BaseModelConfig, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { z } from 'zod';

import { allowAllBridge, PermissionGate } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest, type RuntimeOptions } from '../src/agent/runtime.js';
import { concurrencyLimitMessage } from '../src/agents/concurrency-limit.js';
import { SubagentDispatchRegistry, shortDispatchId, type SubagentDispatchStatus } from '../src/agents/dispatch-registry.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import {
  BROKEN_PAIR_REASON,
  CANCELLED_REASON,
  MAX_RETAINED_CHILDREN,
  RetainedChildStore,
  isContinuableConversation,
} from '../src/agents/retained-children.js';
import { CONTINUE_DESCRIPTION_CLAUSE, SubagentTool, SUBAGENT_TOOL_NAME } from '../src/agents/subagent-tool.js';
import { WorkflowTool, WORKFLOW_TOOL_NAME } from '../src/agents/workflow-tool.js';
import { configPath } from '../src/config.js';
import { formatDispatchesReport } from '../src/tui/subagent-format.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('continuable-children');

const registry: AgentDefinitionRegistry = {
  definitions: [
    { name: 'general', description: 'offline child', systemPrompt: 'offline SECRET-SYSTEM-PROMPT', tools: undefined, file: '/tmp/general.md' },
    { name: 'other', description: 'another offline child', systemPrompt: 'offline OTHER', tools: undefined, file: '/tmp/other.md' },
  ],
  problems: [],
};

/** What one child model call received: roles and text blocks, in order. */
interface SeenMessage {
  readonly role: string;
  readonly texts: readonly string[];
}

type Step =
  | { kind: 'text'; text: string; stop?: 'endTurn' | 'refusal'; gate?: Promise<void> }
  | { kind: 'text-then-tool'; text: string }
  | { kind: 'throw' };

/** One model per dispatch: follows its script, records every request it receives. */
class ScriptedChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline.scripted', contextWindowLimit: 100_000 };
  readonly seen: SeenMessage[][] = [];
  constructor(private readonly steps: Step[]) {
    super();
  }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.seen.push(messages.map((message) => ({
      role: message.role,
      texts: message.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])),
    })));
    const step = this.steps.shift();
    if (step === undefined) throw new Error('script exhausted');
    if (step.kind === 'throw') throw new Error('scripted child failure');
    if (step.kind === 'text-then-tool') {
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'probe', toolUseId: 'probe-1' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{}' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    if (step.gate !== undefined) {
      await Promise.race([step.gate, new Promise<void>((resolve) => {
        const signal = options?.cancelSignal;
        if (signal === undefined) return;
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      })]);
    }
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: step.stop ?? 'endTurn' };
  }
}

class Gate {
  private release!: () => void;
  readonly promise: Promise<void>;
  constructor() {
    this.promise = new Promise((resolve) => { this.release = resolve; });
  }
  open(): void { this.release(); }
}

const probe = tool({
  name: 'probe',
  description: 'offline probe',
  inputSchema: z.object({}),
  callback: () => 'probed',
});

interface Fixture {
  subagents: SubagentTool;
  workflow: WorkflowTool;
  dispatches: SubagentDispatchRegistry;
  models: ScriptedChildModel[];
  /** Scripts consumed in dispatch order; a missing script means one `report N` text. */
  scripts: Step[][];
  created: () => number;
}

function fixture(cap?: number): Fixture {
  const dispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
  const models: ScriptedChildModel[] = [];
  const scripts: Step[][] = [];
  let created = 0;
  const config = { model: 'offline', provider: 'bedrock', region: 'us-west-2', ...(cap === undefined ? {} : { maxConcurrentSubagents: cap }) } as never;
  const shared = {
    registry,
    tools: [probe],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: '/tmp', ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config,
    createModel: async () => {
      created += 1;
      const model = new ScriptedChildModel(scripts.shift() ?? [{ kind: 'text', text: `report ${created}` }]);
      models.push(model);
      return model;
    },
    dispatches,
  };
  return { subagents: new SubagentTool(shared), workflow: new WorkflowTool(shared), dispatches, models, scripts, created: () => created };
}

type DirectResult = { status?: string; content?: Array<{ text?: string }> };

function resultText(result: unknown): string {
  return ((result as DirectResult).content ?? []).map((block) => block.text ?? '').join('\n');
}

async function host(f: Fixture): Promise<Agent> {
  const agent = new Agent({ model: new ScriptedChildModel([]), tools: [f.subagents.tool, f.workflow.tool], printer: false });
  await agent.initialize();
  return agent;
}

function delegate(agent: Agent, input: { task: string; agent?: string; continue?: string }): Promise<DirectResult> {
  return agent.tool[SUBAGENT_TOOL_NAME]!.invoke(input as never, { recordDirectToolCall: false }) as Promise<DirectResult>;
}

/** Bounded poll: the SDK's tool path has a few awaits before `begin()` runs. */
async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(what, condition());
}

/** The SDK renders a thrown tool error as one `Error: <message>` text block; the message must match exactly. */
function isRefusal(result: DirectResult, expected: string): boolean {
  const text = resultText(result);
  return result.status === 'error' && text === `Error: ${expected}` && text.length < 400;
}

function latest(f: Fixture): SubagentDispatchStatus {
  const list = f.dispatches.list();
  return list[list.length - 1]!;
}

const RECORD_KEYS = new Set(['dispatchId', 'agentName', 'task', 'state', 'phase', 'startedAt', 'finishedAt', 'usage', 'continuedFrom']);

async function toolLevel(): Promise<void> {
  header('continuable children — (a) a continuation re-enters the retained conversation as a new record');
  const f = fixture();
  const agent = await host(f);
  assert('the description spends one sentence on continue and the schema carries the parameter',
    f.subagents.tool.description.includes(CONTINUE_DESCRIPTION_CLAUSE)
    && 'continue' in ((f.subagents.tool.toolSpec.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}));

  f.scripts.push([{ kind: 'text', text: 'report one' }]);
  const first = await delegate(agent, { task: 'first task' });
  assert('the first dispatch reports as before', first.status !== 'error' && resultText(first) === 'report one');
  const original = latest(f);
  const originalSnapshot = JSON.stringify(original);
  assert('the settled dispatch is retained under its dispatch id',
    JSON.stringify(f.subagents.retainedDispatchIds()) === JSON.stringify([original.dispatchId]));
  assert('an ordinary record has no continuedFrom key and only the known keys',
    !('continuedFrom' in original) && Object.keys(original).every((key) => RECORD_KEYS.has(key)));

  f.scripts.push([{ kind: 'text', text: 'report two' }]);
  const second = await delegate(agent, { task: 'follow up', continue: original.dispatchId });
  assert('the continuation returns the child report through the ordinary path', second.status !== 'error' && resultText(second) === 'report two');
  const continuationModel = f.models[1]!;
  const request = continuationModel.seen[0] ?? [];
  assert('the continuation\'s first model request is the retained conversation followed by the follow-up task',
    JSON.stringify(request) === JSON.stringify([
      { role: 'user', texts: ['first task'] },
      { role: 'assistant', texts: ['report one'] },
      { role: 'user', texts: ['follow up'] },
    ]));
  const continued = latest(f);
  assert('the continuation is a new record with a new id carrying continuedFrom',
    continued.dispatchId !== original.dispatchId && continued.continuedFrom === original.dispatchId
    && continued.agentName === 'general' && continued.task === 'follow up' && continued.state === 'succeeded');
  assert('the original record is unchanged', JSON.stringify(f.dispatches.list()[0]) === originalSnapshot);
  assert('records carry only the known keys — never the retained messages',
    f.dispatches.list().every((status) => Object.keys(status).every((key) => RECORD_KEYS.has(key))));
  const rows = formatDispatchesReport(f.dispatches.list(), Date.now()).split('\n');
  assert('the /agents row of the continuation names what it continues; the ordinary row is untouched',
    rows[2]!.includes(` — continues #${original.dispatchId}`) && !rows[1]!.includes('continues')
    && rows[1] === formatDispatchesReport([original], Date.now()).split('\n')[1]);
  assert('both settled children are retained now', f.subagents.retainedDispatchIds().length === 2);

  header('continuable children — (a) a chain of follow-ups works and each link is retained');
  f.scripts.push([{ kind: 'text', text: 'report three' }]);
  const third = await delegate(agent, { task: 'and then', continue: continued.dispatchId });
  assert('the second continuation succeeds', third.status !== 'error' && resultText(third) === 'report three');
  const chainRequest = f.models[2]!.seen[0] ?? [];
  assert('its first request carries the whole chain (5 messages) ending in the newest follow-up',
    chainRequest.length === 5 && chainRequest[3]!.texts[0] === 'report two' && chainRequest[4]!.texts[0] === 'and then');
  assert('the chained record continues the middle one', latest(f).continuedFrom === continued.dispatchId);
  assert('agent naming the same definition (any case) is accepted with continue', await (async () => {
    f.scripts.push([{ kind: 'text', text: 'report four' }]);
    const result = await delegate(agent, { task: 'same agent', agent: 'General', continue: original.dispatchId });
    return result.status !== 'error' && resultText(result) === 'report four';
  })());
  assert('the store holds four after four settlements', f.subagents.retainedDispatchIds().length === MAX_RETAINED_CHILDREN);

  header('continuable children — (c) the fifth settlement evicts the oldest and the store never exceeds 4');
  const fifth = await delegate(agent, { task: 'fifth' });
  assert('the fifth dispatch succeeds', fifth.status !== 'error');
  const ids = f.subagents.retainedDispatchIds();
  assert('the store still holds exactly 4 and the oldest is gone',
    ids.length === MAX_RETAINED_CHILDREN && !ids.includes(original.dispatchId) && ids.includes(latest(f).dispatchId));
  const createdBefore = f.created();
  const recordsBefore = f.dispatches.list().length;
  const evicted = await delegate(agent, { task: 'too late', continue: original.dispatchId });
  assert('continuing the evicted id is one bounded error naming eviction and the bound', isRefusal(evicted,
    `Subagent dispatch ${original.dispatchId} was evicted from the retained children (only the last ${MAX_RETAINED_CHILDREN} settled dispatches are kept); brief a fresh child instead.`));
  assert('the refusal built no model and began no dispatch', f.created() === createdBefore && f.dispatches.list().length === recordsBefore);

  header('continuable children — (b) refusals before any model construction');
  const unknown = await delegate(agent, { task: 'x', continue: 'nope1234' });
  assert('an unknown id is refused', isRefusal(unknown, 'No subagent dispatch nope1234 to continue in this session.'));
  const gate = new Gate();
  f.scripts.push([{ kind: 'text', text: 'held', gate: gate.promise }]);
  const held = delegate(agent, { task: 'hold' });
  await until('the held dispatch is running', () => f.dispatches.runningCount() === 1);
  const runningId = latest(f).dispatchId;
  const running = await delegate(agent, { task: 'x', continue: runningId });
  assert('a running id is refused', isRefusal(running, `Subagent dispatch ${runningId} is still running; wait for its result before continuing it.`));
  const mismatched = await delegate(agent, { task: 'x', agent: 'other', continue: ids[0]! });
  assert('a different agent name is refused', isRefusal(mismatched, `Subagent dispatch ${ids[0]} ran agent general; continue it without agent or with agent=general.`));
  assert('none of the refusals built a model or began a dispatch', f.created() === createdBefore + 1 && f.dispatches.list().length === recordsBefore + 1);

  header('continuable children — (b) a cancelled dispatch is never retained');
  const cancel = f.dispatches.cancel(runningId);
  assert('the running child is cancelled by id', cancel.outcome === 'cancelled');
  const heldResult = await held;
  await until('the cancelled dispatch settled', () => f.dispatches.list().find((status) => status.dispatchId === runningId)?.state === 'cancelled');
  assert('the cancelled result is the fixed sentence or an error, never a report', resultText(heldResult) !== 'held');
  assert('the cancelled id is not retained', !f.subagents.retainedDispatchIds().includes(runningId));
  const cancelled = await delegate(agent, { task: 'x', continue: runningId });
  assert('continuing a cancelled id is refused with the cancelled clause',
    isRefusal(cancelled, `Subagent dispatch ${runningId} was not retained for continuation: ${CANCELLED_REASON}.`));

  header('continuable children — (b)(c) failed dispatches: whole conversation retained, broken one skipped');
  f.scripts.push([{ kind: 'text-then-tool', text: 'partial' }, { kind: 'throw' }]);
  const broken = await delegate(agent, { task: 'will break' });
  const brokenId = latest(f).dispatchId;
  assert('the broken child is a failed dispatch', broken.status === 'error' && latest(f).state === 'failed');
  assert('its conversation is not retained', !f.subagents.retainedDispatchIds().includes(brokenId));
  const brokenRefusal = await delegate(agent, { task: 'x', continue: brokenId });
  assert('continuing it says why it was skipped',
    isRefusal(brokenRefusal, `Subagent dispatch ${brokenId} was not retained for continuation: ${BROKEN_PAIR_REASON}.`));
  f.scripts.push([{ kind: 'text', text: 'declined', stop: 'refusal' }]);
  const refused = await delegate(agent, { task: 'will be declined' });
  const refusedId = latest(f).dispatchId;
  assert('a refusal stop is a failed dispatch ending in a complete assistant message', refused.status === 'error' && latest(f).state === 'failed');
  assert('that failed dispatch is retained', f.subagents.retainedDispatchIds().includes(refusedId));
  f.scripts.push([{ kind: 'text', text: 'second try' }]);
  const retried = await delegate(agent, { task: 'try again', continue: refusedId });
  assert('and can be continued, from the declined conversation',
    retried.status !== 'error' && resultText(retried) === 'second try'
    && JSON.stringify(f.models[f.models.length - 1]!.seen[0]) === JSON.stringify([
      { role: 'user', texts: ['will be declined'] }, { role: 'assistant', texts: ['declined'] }, { role: 'user', texts: ['try again'] },
    ]));
  assert('the store never exceeded 4 across every settlement', f.subagents.retainedDispatchIds().length <= MAX_RETAINED_CHILDREN);

  header('continuable children — (b) workflow nodes are never retained');
  const workflowResult = await agent.tool[WORKFLOW_TOOL_NAME]!.invoke(
    { nodes: [{ id: 'a', task: 'node task' }] } as never, { recordDirectToolCall: false },
  ) as DirectResult;
  assert('the one-node workflow succeeds', workflowResult.status !== 'error');
  const nodeId = latest(f).dispatchId;
  assert('the node settled succeeded through the shared registry but is not retained',
    latest(f).state === 'succeeded' && !f.subagents.retainedDispatchIds().includes(nodeId));
  const nodeRefusal = await delegate(agent, { task: 'x', continue: nodeId });
  assert('continuing a workflow node is refused', isRefusal(nodeRefusal,
    `Subagent dispatch ${nodeId} was not retained for continuation: only settled subagent dispatches are; workflow nodes never are.`));

  header('continuable children — (d) the concurrency cap applies to a continuation; shutdown empties the store');
  const capped = fixture(1);
  const cappedAgent = await host(capped);
  capped.scripts.push([{ kind: 'text', text: 'seed' }]);
  await delegate(cappedAgent, { task: 'seed' });
  const seedId = latest(capped).dispatchId;
  const holdGate = new Gate();
  capped.scripts.push([{ kind: 'text', text: 'held', gate: holdGate.promise }]);
  const holding = delegate(cappedAgent, { task: 'occupy the slot' });
  await until('one dispatch occupies the only slot', () => capped.dispatches.runningCount() === 1);
  const overCap = await delegate(cappedAgent, { task: 'x', continue: seedId });
  assert('a continuation over the cap is refused with the fixed limit message', isRefusal(overCap, concurrencyLimitMessage(1, 1)));
  assert('the refused continuation began no dispatch', capped.dispatches.list().length === 2);
  holdGate.open();
  await holding;
  assert('the retained store is populated before shutdown', capped.subagents.retainedDispatchIds().length === 2);
  await capped.subagents.shutdown();
  assert('shutdown() leaves nothing continuable', capped.subagents.retainedDispatchIds().length === 0);

  header('continuable children — (e) the store unit: whole conversations only, bounded, ids remembered');
  const store = new RetainedChildStore();
  const whole = [
    new Message({ role: 'user', content: [new TextBlock('q')] }),
    new Message({ role: 'assistant', content: [new TextBlock('a')] }),
  ];
  const dangling = [
    new Message({ role: 'user', content: [new TextBlock('q')] }),
    new Message({ role: 'assistant', content: [new ToolUseBlock({ toolUseId: 't-1', name: 'probe', input: {} })] }),
  ];
  assert('a conversation ending in an unanswered tool use is not continuable',
    isContinuableConversation(whole) && !isContinuableConversation(dangling) && !isContinuableConversation([]));
  const skipped = store.retain({ dispatchId: 'd1', agentName: 'general', state: 'failed', messages: dangling });
  assert('retain() skips it with the broken-pair reason and remembers the id',
    !skipped.retained && skipped.reason === BROKEN_PAIR_REASON && store.lookup('d1').kind === 'skipped' && store.size() === 0);
  const cancelledOutcome = store.retain({ dispatchId: 'd2', agentName: 'general', state: 'cancelled', messages: whole });
  assert('retain() never keeps a cancelled child', !cancelledOutcome.retained && store.lookup('d2').kind === 'skipped');
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) store.retain({ dispatchId: id, agentName: 'general', state: 'succeeded', messages: whole });
  assert('the fifth retention evicts the oldest, which is remembered as evicted',
    JSON.stringify(store.ids()) === JSON.stringify(['e2', 'e3', 'e4', 'e5']) && store.lookup('e1').kind === 'evicted');
  const retainedEntry = store.lookup('e5');
  assert('a retained entry holds deep copies, not the caller\'s Message objects',
    retainedEntry.kind === 'retained' && retainedEntry.entry.messages[0] !== whole[0]
    && retainedEntry.entry.messages.length === 2 && retainedEntry.entry.state === 'succeeded');
  store.clear();
  assert('clear() forgets entries and remembered outcomes alike', store.size() === 0 && store.lookup('e1').kind === 'unknown');
}

/** One model for parent and children at runtime level: the parent is the call whose specs carry `subagent`. */
class RouterModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.continuable', contextWindowLimit: 200_000 };
  scenario: 'delegate' | 'continue' | 'plain' = 'plain';
  continueId = '';
  toolUseId = 'd-1';
  /** The parent's tool result text for the last `continue` scenario, once seen. */
  lastContinueResult: string | undefined;
  readonly childRequests: SeenMessage[][] = [];
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return { ...this.config }; }
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const isParent = (options?.toolSpecs ?? []).some((spec) => spec.name === 'subagent');
    if (!isParent) {
      this.childRequests.push(messages.map((message) => ({
        role: message.role,
        texts: message.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])),
      })));
      yield* text(`child report ${this.childRequests.length}`);
      return;
    }
    const answered = messages.flatMap((message) => message.content.flatMap((block) =>
      block.type === 'toolResultBlock' && block.toolUseId === this.toolUseId ? [block] : []));
    const last = answered[answered.length - 1];
    if (this.scenario === 'plain' || last !== undefined) {
      if (last !== undefined && this.scenario === 'continue') {
        this.lastContinueResult = last.content.flatMap((block) => (block.type === 'textBlock' ? [block.text] : [])).join('\n');
      }
      yield* text('parent done');
      return;
    }
    const input = this.scenario === 'delegate'
      ? { task: 'first child task' }
      : { task: 'follow-up task', continue: this.continueId };
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'subagent', toolUseId: this.toolUseId } };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  }
}

function* text(value: string): Iterable<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' };
  yield { type: 'modelContentBlockStartEvent' };
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: value } };
  yield { type: 'modelContentBlockStopEvent' };
  yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
}

async function drain(runtime: AgentRuntime, prompt: string): Promise<void> {
  for await (const _event of runtime.send(prompt)) { /* consume */ }
}

async function runtimeLevel(): Promise<void> {
  header('continuable children — (f) /clear and /rewind successors know nothing continuable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-continuable-children-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(configPath(), JSON.stringify({
    permissionMode: 'yolo',
    memory: false,
    models: [{ enable: true, name: 'first', provider: 'bedrock', model: 'fake.first', region: 'us-west-2' }],
  }));
  const model = new RouterModel();
  setRuntimeModelFactoryForTest(async () => model);
  const options: RuntimeOptions = { projectRoot: root, session: { kind: 'new' }, permissionBridge: allowAllBridge };
  let runtime: AgentRuntime | undefined;
  try {
    runtime = await AgentRuntime.create(options);
    model.scenario = 'delegate';
    model.toolUseId = 'd-1';
    await drain(runtime, 'delegate once');
    const firstId = shortDispatchId('d-1');
    const settled = runtime.listSubagentDispatches();
    assert('the runtime records one succeeded dispatch under the expected id',
      settled.length === 1 && settled[0]!.dispatchId === firstId && settled[0]!.state === 'succeeded');

    model.scenario = 'continue';
    model.continueId = firstId;
    model.toolUseId = 'c-1';
    await drain(runtime, 'continue it');
    assert('inside one runtime the continuation reaches the retained conversation',
      model.lastContinueResult === 'child report 2'
      && JSON.stringify(model.childRequests[1]) === JSON.stringify([
        { role: 'user', texts: ['first child task'] }, { role: 'assistant', texts: ['child report 1'] }, { role: 'user', texts: ['follow-up task'] },
      ])
      && runtime.listSubagentDispatches()[1]?.continuedFrom === firstId);

    const successor = await runtime.startNewSession();
    runtime = successor;
    model.toolUseId = 'c-2';
    model.lastContinueResult = undefined;
    await drain(runtime, 'continue after clear');
    assert('the /clear successor refuses the predecessor\'s id — its SubagentTool is new and empty',
      model.lastContinueResult === `Error: No subagent dispatch ${firstId} to continue in this session.`
      && model.childRequests.length === 2 && runtime.listSubagentDispatches().length === 0);

    model.scenario = 'delegate';
    model.toolUseId = 'd-2';
    await drain(runtime, 'delegate again');
    const secondId = shortDispatchId('d-2');
    model.scenario = 'plain';
    await drain(runtime, 'a boundary to rewind to');
    const catalogue = await runtime.listRewindCheckpoints();
    const checkpoint = catalogue.checkpoints.find((entry) => entry.prompt === 'a boundary to rewind to');
    assert('a rewind checkpoint exists after the delegation turn', checkpoint !== undefined);
    if (checkpoint !== undefined) {
      const branched = await runtime.startRewind(checkpoint);
      runtime = branched;
      model.scenario = 'continue';
      model.continueId = secondId;
      model.toolUseId = 'c-3';
      model.lastContinueResult = undefined;
      await drain(runtime, 'continue after rewind');
      assert('the /rewind successor refuses the predecessor\'s id as well',
        model.lastContinueResult === `Error: No subagent dispatch ${secondId} to continue in this session.`
        && model.childRequests.length === 3);
    }
  } finally {
    await runtime?.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
}

await toolLevel();
await runtimeLevel();
report();
