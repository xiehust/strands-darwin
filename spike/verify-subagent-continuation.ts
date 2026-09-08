/**
 * Offline SRF-026 contracts: a `subagent` child whose first `invoke` dies with the
 * exact stream-interruption `ModelError` gets exactly one continuation on the same
 * live child (`STREAM_CONTINUATION_PROMPT`, an ordinary user-role message), at the
 * tool's invoke call site — never inside the SDK loop. A second failure is the
 * interruption rethrown (`cause`/`name` preserved) through `withFailedChildText`;
 * cancellation, other error classes and `workflow` nodes are never continued.
 *
 * The fake model reproduces the interruption the way production does: its stream
 * ends without a `modelMessageStopEvent`, so the SDK's own aggregator throws the
 * exact `ModelError('Stream ended without completing a message')`. No network.
 */
import { Agent, Message, Model, ModelError, tool as sdkTool } from '@strands-agents/sdk';
import type { BaseModelConfig, ModelStreamEvent } from '@strands-agents/sdk';
import { z } from 'zod';

import { PermissionGate } from '../src/agent/permission.js';
import { isRetryableStreamInterruption, STREAM_CONTINUATION_PROMPT } from '../src/agent/stream-resumption.js';
import { SubagentDispatchRegistry } from '../src/agents/dispatch-registry.js';
import type { SubagentDispatchPhase } from '../src/agents/dispatch-registry.js';
import { FAILED_CHILD_NOTE } from '../src/agents/failed-child-text.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import {
  CONTINUATION_FAILED_NOTE,
  continuationFailure,
  STREAM_CONTINUATION_DESCRIPTION_CLAUSE,
  SubagentTool,
  SUBAGENT_TOOL_NAME,
} from '../src/agents/subagent-tool.js';
import { WorkflowTool, WORKFLOW_TOOL_NAME } from '../src/agents/workflow-tool.js';
import { formatDispatchPhase } from '../src/tui/subagent-format.js';
import { assert, header, report } from './shared.js';

const INTERRUPTION = 'Stream ended without completing a message';
const CONTINUING: SubagentDispatchPhase['kind'] = 'continuing-after-stream-interruption';

const registry: AgentDefinitionRegistry = {
  definitions: [
    { name: 'general', description: 'offline child', systemPrompt: 'offline SECRET-SYSTEM-PROMPT', tools: undefined, file: '/tmp/general.md' },
  ],
  problems: [],
};

const dummyTool = sdkTool({
  name: 'dummy',
  description: 'inert child tool',
  inputSchema: z.object({}),
  callback: () => 'DUMMY-TOOL-RESULT',
});

type Step =
  | { kind: 'tool'; text?: string }
  | { kind: 'text'; text: string }
  /** Ends the stream without a stop event: the SDK throws the exact interruption. */
  | { kind: 'interrupt'; delayMs?: number }
  | { kind: 'throw'; message: string };

/** Plays one scripted step per model call and records what each call was asked. */
class ScriptedModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline.scripted', contextWindowLimit: 100_000 };
  /** The text of the last user-role message each call received, in call order. */
  readonly inputs: string[] = [];
  constructor(private readonly steps: Step[]) { super(); }
  get calls(): number { return this.inputs.length; }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.inputs.push(lastUserText(messages));
    const step = this.steps.shift();
    if (step === undefined) throw new Error('script exhausted');
    if (step.kind === 'throw') throw new Error(step.message);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (step.kind === 'interrupt') {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'half a sen' } };
      if (step.delayMs !== undefined) await wait(step.delayMs);
      return;
    }
    if (step.text !== undefined) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    if (step.kind === 'tool') {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'dummy', toolUseId: `dummy-${this.calls}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{}' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function lastUserText(messages: Message[]): string {
  const last = messages[messages.length - 1];
  if (last === undefined || last.role !== 'user') return `<${last?.role ?? 'none'}>`;
  return last.content.map((block) => (block.type === 'textBlock' ? block.text : `<${block.type}>`)).join('');
}

function gate(): PermissionGate {
  return new PermissionGate({ mode: 'yolo', projectRoot: '/tmp', ask: async () => ({ allowed: true }) });
}

const fakeConfig = { model: 'offline', provider: 'bedrock', region: 'us-west-2' } as never;

interface Fixture<T> {
  tool: T;
  dispatches: SubagentDispatchRegistry;
  /** Every phase kind published for any dispatch, in order (immediate updates and heartbeats). */
  phases: string[];
  children: Agent[];
}

function subagentFixture(models: Model<BaseModelConfig>[]): Fixture<SubagentTool> {
  const dispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
  const phases: string[] = [];
  const children: Agent[] = [];
  dispatches.subscribeProgress((progress) => phases.push(progress.phase.kind));
  const tool = new SubagentTool({
    registry,
    tools: [dummyTool],
    intervention: gate(),
    projectInstructions: undefined,
    config: fakeConfig,
    createModel: async () => models.shift()!,
    dispatches,
    onChildInitialized: (child) => children.push(child),
  });
  return { tool, dispatches, phases, children };
}

function workflowFixture(models: Model<BaseModelConfig>[]): Fixture<WorkflowTool> {
  const dispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
  const phases: string[] = [];
  dispatches.subscribeProgress((progress) => phases.push(progress.phase.kind));
  const tool = new WorkflowTool({
    registry,
    tools: [dummyTool],
    intervention: gate(),
    projectInstructions: undefined,
    config: fakeConfig,
    createModel: async () => models.shift()!,
    dispatches,
  });
  return { tool, dispatches, phases, children: [] };
}

type DirectResult = { status?: string; content?: Array<{ text?: string }>; error?: Error };

function resultText(result: unknown): string {
  return ((result as DirectResult).content ?? []).map((block) => block.text ?? '').join('\n');
}

async function host(tool: SubagentTool | WorkflowTool): Promise<Agent> {
  const agent = new Agent({ model: new ScriptedModel([]), tools: [tool.tool], printer: false });
  await agent.initialize();
  return agent;
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function invokeSubagent(parent: Agent, input: Record<string, string>): Promise<DirectResult> {
  return parent.tool[SUBAGENT_TOOL_NAME]!.invoke(input as never, { recordDirectToolCall: false }) as Promise<DirectResult>;
}

header('stream continuation — the fake reproduces the exact interruption the SDK throws');
{
  const probe = new Agent({ model: new ScriptedModel([{ kind: 'interrupt' }]), printer: false });
  let thrown: unknown;
  try { await probe.invoke('x'); } catch (error) { thrown = error; }
  assert('a stream ending without a stop event is the exact ModelError the driver continues on',
    thrown instanceof ModelError && thrown.message === INTERRUPTION && isRetryableStreamInterruption(thrown));
}

header('stream continuation — helper and description contracts');
{
  const interruption = new ModelError(INTERRUPTION);
  const wrapped = continuationFailure(interruption, new Error('second boom'));
  assert('the rethrown error keeps the interruption as cause and its ModelError name',
    wrapped.cause === interruption && wrapped.name === 'ModelError' && wrapped !== interruption);
  assert('its message starts with the original message and names the second failure after the fixed note',
    wrapped.message === `${INTERRUPTION}\n${CONTINUATION_FAILED_NOTE} second boom`);
  assert('a non-Error second failure is stringified, never dropped',
    continuationFailure(interruption, 'plain string').message.endsWith(`${CONTINUATION_FAILED_NOTE} plain string`));
  assert('the phase renders as one readable closed phrase on rows and heartbeats',
    formatDispatchPhase({ kind: CONTINUING }) === 'continuing after stream interruption');
  const f = subagentFixture([]);
  assert('the tool description spends one bounded clause on the continuation',
    f.tool.tool.description.includes(STREAM_CONTINUATION_DESCRIPTION_CLAUSE)
    && STREAM_CONTINUATION_DESCRIPTION_CLAUSE.length < 200);
  await f.tool.shutdown();
}

header('stream continuation — interrupted once, then answers: the report arrives, dispatch succeeded');
{
  const model = new ScriptedModel([{ kind: 'tool' }, { kind: 'interrupt' }, { kind: 'text', text: 'REPORT-ALPHA' }]);
  const f = subagentFixture([model]);
  const parent = await host(f.tool);
  const result = await invokeSubagent(parent, { task: 'investigate alpha' });
  assert('the parent tool result is the child\'s report, not an error',
    result.status !== 'error' && resultText(result) === 'REPORT-ALPHA');
  assert('the dispatch settles succeeded', f.dispatches.list()[0]?.state === 'succeeded');
  assert('the model was called exactly three times: task, interrupted call, continuation',
    model.calls === 3);
  assert('the continuation prompt passed is exactly STREAM_CONTINUATION_PROMPT, the task is not resent',
    model.inputs[2] === STREAM_CONTINUATION_PROMPT && model.inputs[0] === 'investigate alpha');
  assert('the `continuing-after-stream-interruption` phase was published on the record\'s progress channel',
    f.phases.includes(CONTINUING));
  const child = f.children[0]!;
  const roles = child.messages.map((message) => message.role).join(',');
  assert('the child\'s conversation is task, tool use, tool result, continuation, report — one live child',
    f.children.length === 1 && roles === 'user,assistant,user,user,assistant'
    && lastUserText(child.messages.slice(0, 4)) === STREAM_CONTINUATION_PROMPT);
  assert('the phase order is starting → model → tool → … → continuing → model → starting',
    f.phases.indexOf(CONTINUING) > f.phases.indexOf('tool') && f.phases[f.phases.indexOf(CONTINUING) + 1] === 'model');
  assert('a succeeded continuation is retained for continue=<id> like any first-attempt success',
    f.tool.retainedDispatchIds().length === 1);
  await f.tool.shutdown();
}

header('stream continuation — interrupted twice: the original error, its cause, dispatch failed, no third attempt');
{
  const model = new ScriptedModel([{ kind: 'tool' }, { kind: 'interrupt' }, { kind: 'interrupt' }]);
  const f = subagentFixture([model]);
  const parent = await host(f.tool);
  const result = await invokeSubagent(parent, { task: 'investigate' });
  assert('the tool result is an error', result.status === 'error');
  assert('the error carries the original interruption message first',
    result.error?.message.startsWith(`${INTERRUPTION}\n${CONTINUATION_FAILED_NOTE} ${INTERRUPTION}`) === true);
  assert('error.cause is the first ModelError and the name stays ModelError (retry-guard class unchanged)',
    result.error?.cause instanceof ModelError && (result.error.cause as Error).message === INTERRUPTION
    && result.error.name === 'ModelError');
  assert('the child had no assistant text, so withFailedChildText added no cut-off note',
    !result.error!.message.includes(FAILED_CHILD_NOTE));
  assert('the dispatch settles failed', f.dispatches.list()[0]?.state === 'failed');
  assert('exactly one continuation: three model calls, never a fourth', model.calls === 3);
  assert('the continuing phase was published once', f.phases.filter((kind) => kind === CONTINUING).length === 1);
  assert('a conversation ending in a tool result is not retained (broken pair rule unchanged)',
    f.tool.retainedDispatchIds().length === 0);
  await f.tool.shutdown();
}

header('stream continuation — a second failure of another class, with child text: chain preserved through withFailedChildText');
{
  const model = new ScriptedModel([{ kind: 'tool', text: 'partial finding BETA' }, { kind: 'interrupt' }, { kind: 'throw', message: 'child model exploded' }]);
  const f = subagentFixture([model]);
  const parent = await host(f.tool);
  const result = await invokeSubagent(parent, { task: 'investigate' });
  const text = resultText(result);
  assert('the result is an error naming the interruption, then the second failure, then the cut-off note and text',
    result.status === 'error'
    && text === `Error: ${INTERRUPTION}\n${CONTINUATION_FAILED_NOTE} child model exploded\n${FAILED_CHILD_NOTE}\npartial finding BETA`);
  const chain = result.error?.cause as Error | undefined;
  assert('the failed-child wrapper keeps the continuation failure as cause, whose cause is the first ModelError',
    chain?.name === 'ModelError' && chain?.cause instanceof ModelError && (chain.cause as Error).message === INTERRUPTION
    && result.error?.name === 'ModelError');
  assert('the dispatch settles failed and the model was called exactly three times',
    f.dispatches.list()[0]?.state === 'failed' && model.calls === 3);
  await f.tool.shutdown();
}

header('stream continuation — a child cancelled during the first attempt is never continued');
{
  // `cancelActive()` (the runtime's turn cancel) mid-stream: the SDK settles the
  // child `cancelled` itself, and no continuation is attempted.
  const model = new ScriptedModel([{ kind: 'tool' }, { kind: 'interrupt', delayMs: 300 }, { kind: 'text', text: 'never' }]);
  const f = subagentFixture([model]);
  const parent = await host(f.tool);
  const pending = invokeSubagent(parent, { task: 'x' });
  await wait(80);
  f.tool.cancelActive();
  const result = await pending;
  assert('the dispatch settles cancelled', f.dispatches.list()[0]?.state === 'cancelled');
  assert('the model was not called again after the cancel (two calls: task and the cancelled one)',
    model.calls === 2 && !model.inputs.includes(STREAM_CONTINUATION_PROMPT));
  assert('no continuing phase was published and the result is not the failed-child note',
    !f.phases.includes(CONTINUING) && !resultText(result).includes(FAILED_CHILD_NOTE));
  await f.tool.shutdown();

  // Targeted `/agents cancel <id>` through the registry: same outcome.
  const model2 = new ScriptedModel([{ kind: 'tool' }, { kind: 'interrupt', delayMs: 300 }, { kind: 'text', text: 'never' }]);
  const g = subagentFixture([model2]);
  const parent2 = await host(g.tool);
  const pending2 = invokeSubagent(parent2, { task: 'y' });
  await wait(80);
  const cancelled = g.dispatches.cancel(g.dispatches.list()[0]!.dispatchId);
  await pending2;
  assert('a targeted cancel settles cancelled with no continuation either',
    cancelled.outcome === 'cancelled' && g.dispatches.list()[0]?.state === 'cancelled'
    && model2.calls === 2 && !g.phases.includes(CONTINUING));
  await g.tool.shutdown();
}

header('stream continuation — a cancel during the continuation is a cancellation, never wrapped');
{
  const model = new ScriptedModel([{ kind: 'tool' }, { kind: 'interrupt' }, { kind: 'interrupt', delayMs: 300 }]);
  const f = subagentFixture([model]);
  const parent = await host(f.tool);
  const pending = invokeSubagent(parent, { task: 'x' });
  await wait(120);
  assert('the continuation was under way when the cancel landed', f.phases.includes(CONTINUING) && model.calls === 3);
  f.tool.cancelActive();
  const result = await pending;
  assert('the dispatch settles cancelled, not failed, and no error names the continuation',
    f.dispatches.list()[0]?.state === 'cancelled' && !resultText(result).includes(CONTINUATION_FAILED_NOTE));
  await f.tool.shutdown();
}

header('stream continuation — a non-interruption error is never continued');
{
  const model = new ScriptedModel([{ kind: 'tool' }, { kind: 'throw', message: 'child model exploded' }, { kind: 'text', text: 'never' }]);
  const f = subagentFixture([model]);
  const parent = await host(f.tool);
  const result = await invokeSubagent(parent, { task: 'x' });
  assert('the error is the bare original, byte-identical to today',
    result.status === 'error' && resultText(result) === 'Error: child model exploded' && result.error?.name === 'ModelError');
  assert('the model was called exactly twice (task, failing call) — no continuation, no phase',
    model.calls === 2 && !model.inputs.includes(STREAM_CONTINUATION_PROMPT) && !f.phases.includes(CONTINUING));
  assert('the dispatch settles failed', f.dispatches.list()[0]?.state === 'failed');
  await f.tool.shutdown();
}

header('stream continuation — a continue=<id> follow-up is its own dispatch with its own single attempt');
{
  const first = new ScriptedModel([{ kind: 'tool' }, { kind: 'interrupt' }, { kind: 'text', text: 'REPORT-ONE' }]);
  const second = new ScriptedModel([{ kind: 'interrupt' }, { kind: 'text', text: 'REPORT-TWO' }]);
  const f = subagentFixture([first, second]);
  const parent = await host(f.tool);
  const one = await invokeSubagent(parent, { task: 'first' });
  const id = f.dispatches.list()[0]!.dispatchId;
  const two = await invokeSubagent(parent, { task: 'follow up', continue: id });
  assert('both dispatches deliver their reports after one continuation each',
    resultText(one) === 'REPORT-ONE' && resultText(two) === 'REPORT-TWO');
  assert('the follow-up ran its own continuation on its own child (two calls) under a new record',
    second.calls === 2 && second.inputs[1] === STREAM_CONTINUATION_PROMPT
    && f.dispatches.list().length === 2 && f.dispatches.list()[1]?.continuedFrom === id
    && f.dispatches.list().every((status) => status.state === 'succeeded'));
  assert('the continuing phase was published once per dispatch', f.phases.filter((kind) => kind === CONTINUING).length === 2);
  await f.tool.shutdown();
}

header('stream continuation — workflow nodes are untouched: an interrupted node fails without continuation');
{
  const model = new ScriptedModel([{ kind: 'tool' }, { kind: 'interrupt' }, { kind: 'text', text: 'never' }]);
  const f = workflowFixture([model]);
  const parent = await host(f.tool);
  const result = (await parent.tool[WORKFLOW_TOOL_NAME]!.invoke(
    { nodes: [{ id: 'a', task: 'interrupted node' }] } as never,
    { recordDirectToolCall: false },
  )) as DirectResult;
  assert('the graph result is an error carrying the interruption message',
    result.status === 'error' && resultText(result).includes(INTERRUPTION));
  assert('the node\'s model was called exactly twice — no continuation prompt, no continuing phase',
    model.calls === 2 && !model.inputs.includes(STREAM_CONTINUATION_PROMPT) && !f.phases.includes(CONTINUING));
  assert('the node settles failed', f.dispatches.list()[0]?.state === 'failed');
  await f.tool.shutdown();
}

report();
