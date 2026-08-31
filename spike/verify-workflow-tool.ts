/**
 * Offline SER-045 contracts: the parent-only `workflow` tool — bounded DAG
 * validation before any construction, SDK-Graph dependency merge and ordering,
 * per-node dispatch registration with provenance, terminus-only results, and
 * cancellation reaching unstarted nodes. Stub models, no network, no model call.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Agent, Model, tool as sdkTool } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';
import { z } from 'zod';

import { PermissionGate } from '../src/agent/permission.js';
import { SubagentDispatchRegistry, type SubagentDispatchProgress } from '../src/agents/dispatch-registry.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import { WorkflowTool, WORKFLOW_TOOL_NAME, MAX_WORKFLOW_NODES } from '../src/agents/workflow-tool.js';
import { assert, header, report } from './shared.js';

const registry: AgentDefinitionRegistry = {
  definitions: [
    {
      name: 'general',
      description: 'offline child',
      systemPrompt: 'offline SECRET-SYSTEM-PROMPT',
      tools: undefined,
      file: '/tmp/general.md',
    },
    {
      name: 'writer',
      description: 'offline writer',
      systemPrompt: 'offline writer SECRET-SYSTEM-PROMPT',
      tools: ['dummy'],
      file: '/tmp/writer.md',
    },
  ],
  problems: [],
};

const dummyTool = sdkTool({
  name: 'dummy',
  description: 'inert child catalogue entry',
  inputSchema: z.object({}),
  callback: () => 'dummy',
});

const events: string[] = [];

/** Emits one fixed report after a delay; records its inputs and start/end order. */
class EchoChildModel extends Model<BaseModelConfig> {
  calls = 0;
  received: string[] = [];
  private config: BaseModelConfig = { modelId: 'offline.child', contextWindowLimit: 100_000 };
  constructor(
    private readonly label: string,
    private readonly reportText: string,
    private readonly delayMs = 5,
    /** Emitted as provider usage metadata after the message, exactly like Bedrock. */
    private readonly usage?: { inputTokens: number; outputTokens: number },
  ) {
    super();
  }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    events.push(`start:${this.label}`);
    this.received.push(
      messages
        .map((message) => message.content.map((block) => (block.type === 'textBlock' ? block.text : '')).join('\n'))
        .join('\n'),
    );
    await wait(this.delayMs);
    events.push(`end:${this.label}`);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.reportText } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    if (this.usage !== undefined) {
      yield {
        type: 'modelMetadataEvent',
        usage: { ...this.usage, totalTokens: this.usage.inputTokens + this.usage.outputTokens },
      };
    }
  }
}

class FailingChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline.failing', contextWindowLimit: 100_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    await wait(10);
    throw new Error('node model exploded');
  }
}

/** Host-parent model: first turn issues one `workflow` tool call, then reports. */
class ParentModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline.parent', contextWindowLimit: 100_000 };
  private sent = false;
  constructor(private readonly workflowInput: unknown) { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!this.sent) {
      this.sent = true;
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: WORKFLOW_TOOL_NAME, toolUseId: 'wf001' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.workflowInput) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'parent done' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function gate(): PermissionGate {
  return new PermissionGate({ mode: 'yolo', projectRoot: '/tmp', ask: async () => ({ allowed: true }) });
}

interface WorkflowFixture {
  workflow: WorkflowTool;
  dispatches: SubagentDispatchRegistry;
  children: Agent[];
  created: () => number;
}

function fixture(models: Model<BaseModelConfig>[]): WorkflowFixture {
  const dispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
  const children: Agent[] = [];
  let created = 0;
  const workflow = new WorkflowTool({
    registry,
    tools: [dummyTool],
    intervention: gate(),
    projectInstructions: undefined,
    config: { model: 'offline', provider: 'bedrock', region: 'us-west-2' } as never,
    createModel: async () => {
      created += 1;
      return models.shift()!;
    },
    dispatches,
    onChildInitialized: (agent) => children.push(agent),
  });
  return { workflow, dispatches, children, created: () => created };
}

async function directHost(workflow: WorkflowTool): Promise<Agent> {
  const host = new Agent({ model: new EchoChildModel('unused', 'unused'), tools: [workflow.tool], printer: false });
  await host.initialize();
  return host;
}

type DirectResult = { status?: string; content?: Array<{ text?: string }> };

function resultText(result: unknown): string {
  const typed = result as DirectResult;
  return (typed.content ?? []).map((block) => block.text ?? '').join('\n');
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

header('workflow — invalid DAGs refuse with bounded errors before any construction');
{
  const f = fixture([]);
  const host = await directHost(f.workflow);
  const invoke = (input: unknown) =>
    host.tool[WORKFLOW_TOOL_NAME]!.invoke(input as never, { recordDirectToolCall: false });

  const node = (id: string, task = 'do work', agent?: string) => ({ id, task, ...(agent === undefined ? {} : { agent }) });
  const refusals: Array<[string, unknown, RegExp]> = [
    ['a cycle', { nodes: [node('a'), node('b')], edges: [['a', 'b'], ['b', 'a']] }, /cycle involving node\(s\)/],
    ['a self-edge', { nodes: [node('a')], edges: [['a', 'a']] }, /cycle involving node\(s\): "?a/],
    ['an unknown agent name', { nodes: [node('a', 'do work', 'nope')] }, /unknown agent "nope".*Available agents: general, writer/],
    ['a duplicate node id', { nodes: [node('a'), node('a')] }, /Duplicate node id "a"/],
    ['an unknown edge endpoint', { nodes: [node('a')], edges: [['a', 'ghost']] }, /unknown node id "ghost"/],
    ['a duplicate edge', { nodes: [node('a'), node('b')], edges: [['a', 'b'], ['a', 'b']] }, /Duplicate edge/],
    ['an over-cap node count', { nodes: Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, i) => node(`n${i}`)) }, new RegExp(`at most ${MAX_WORKFLOW_NODES} nodes`)],
    ['a blank task', { nodes: [{ id: 'a', task: '   ' }] }, /empty task/],
    ['an empty task', { nodes: [{ id: 'a', task: '' }] }, /./],
  ];
  for (const [what, input, pattern] of refusals) {
    const result = (await invoke(input)) as DirectResult;
    const text = resultText(result);
    assert(
      `${what} is a bounded tool error (${JSON.stringify(text.slice(0, 60))}…)`,
      result.status === 'error' && pattern.test(text) && text.length < 400 && !text.includes('\n    at '),
    );
  }
  assert('refusals construct zero models, children, and dispatches',
    f.created() === 0 && f.children.length === 0 && f.dispatches.list().length === 0);
}

header('workflow — diamond DAG: SDK dependency order, merge, dispatches, terminus-only result');
{
  events.length = 0;
  const modelA = new EchoChildModel('a', 'a-report UPSTREAM-A', 20, { inputTokens: 100, outputTokens: 10 });
  const modelB = new EchoChildModel('b', 'b-report BRANCH-B', 20, { inputTokens: 200, outputTokens: 20 });
  const modelC = new EchoChildModel('c', 'c-report BRANCH-C', 20);
  const modelD = new EchoChildModel('d', 'd-report TERMINUS-D', 5, { inputTokens: 400, outputTokens: 40 });
  const f = fixture([modelA, modelB, modelC, modelD]);
  const progress: SubagentDispatchProgress[] = [];
  f.dispatches.subscribeProgress((event) => progress.push(event));
  const host = await directHost(f.workflow);
  const result = (await host.tool[WORKFLOW_TOOL_NAME]!.invoke(
    {
      nodes: [
        { id: 'a', task: 'seed the diamond' },
        { id: 'b', task: 'expand branch b', agent: 'writer' },
        { id: 'c', task: 'expand branch c' },
        { id: 'd', task: 'join the branches' },
      ],
      edges: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']],
    } as never,
    { recordDirectToolCall: false },
  )) as DirectResult;

  const order = (label: string) => events.indexOf(label);
  assert('source a runs before its branches, both branches before the join',
    order('end:a') < order('start:b') && order('end:a') < order('start:c')
    && order('end:b') < order('start:d') && order('end:c') < order('start:d'));
  assert('branches b and c overlap (parallel reads, SDK scheduling)',
    order('start:c') < order('end:b') || order('start:b') < order('end:c'));

  const dInput = modelD.received[0] ?? '';
  assert("d's input carries its own task plus the SDK dependency merge of b and c",
    dInput.includes('join the branches') && dInput.includes('[node: b]') && dInput.includes('[node: c]')
    && dInput.includes('b-report BRANCH-B') && dInput.includes('c-report BRANCH-C'));
  assert("d's input contains only direct dependencies, not a's report", !dInput.includes('a-report UPSTREAM-A'));
  const bInput = modelB.received[0] ?? '';
  assert("b's input carries its own task plus a's report", bInput.includes('expand branch b') && bInput.includes('[node: a]') && bInput.includes('a-report UPSTREAM-A'));

  const text = resultText(result);
  assert('the tool result is the terminus report only', result.status !== 'error' && text.includes('d-report TERMINUS-D'));
  assert('intermediate reports and child transcripts stay private',
    !text.includes('a-report') && !text.includes('b-report') && !text.includes('c-report')
    && !text.includes('SECRET-SYSTEM-PROMPT') && !text.includes('[node:'));

  const list = f.dispatches.list();
  assert('every node registered one dispatch that succeeded',
    list.length === 4 && list.every((entry) => entry.state === 'succeeded'));
  assert('dispatch ids are distinct so targeted /agents cancel stays exact',
    new Set(list.map((entry) => entry.dispatchId)).size === 4);
  assert('dispatches carry the resolved agent names', list.filter((entry) => entry.agentName === 'writer').length === 1);
  assert('every node dispatch freezes its child meter through the shared recipe',
    list.find((entry) => entry.task === 'seed the diamond')?.usage?.inputTokens === 100 &&
    list.find((entry) => entry.task === 'expand branch b')?.usage?.outputTokens === 20 &&
    list.find((entry) => entry.task === 'join the branches')?.usage?.inputTokens === 400);
  const workflowTotal = f.dispatches.totalUsage();
  assert('the registry total sums every node, including the usage-silent one as its measured zero',
    workflowTotal?.dispatches === 4 && workflowTotal.usage.inputTokens === 700 && workflowTotal.usage.outputTokens === 70);
  assert('nodes heartbeat on the existing progress surface',
    progress.some((event) => event.heartbeat) && progress.every((event) => !JSON.stringify(event).includes('report')));
  assert('permission provenance resolves every child to its dispatch label',
    f.children.length === 4 && f.children.every((child) => f.dispatches.sourceFor(child.id)?.label.includes('#') === true));
  assert('children are recipe children: unique workflow ids, filtered catalogues, never a delegation tool',
    f.children.every((child) => child.id.startsWith('darwin-workflow-'))
    && f.children.every((child) => !child.tools.some((entry) => entry.name === WORKFLOW_TOOL_NAME || entry.name === 'subagent'))
    && f.children.some((child) => child.tools.some((entry) => entry.name === 'dummy')));
}

header('workflow — one failing node fails the run boundedly; dependants never start');
{
  const f = fixture([new FailingChildModel(), new EchoChildModel('never', 'never-report')]);
  const host = await directHost(f.workflow);
  const result = (await host.tool[WORKFLOW_TOOL_NAME]!.invoke(
    { nodes: [{ id: 'a', task: 'explode' }, { id: 'b', task: 'never runs' }], edges: [['a', 'b']] } as never,
    { recordDirectToolCall: false },
  )) as DirectResult;
  const text = resultText(result);
  assert('the failure surfaces as a bounded tool error naming the node',
    result.status === 'error' && /Workflow failed.*a: node model exploded/.test(text) && text.length < 400);
  const list = f.dispatches.list();
  assert('the failed node settles failed and the unstarted dependant settles cancelled',
    list[0]?.state === 'failed' && list[1]?.state === 'cancelled');
  assert('the dependant child was never invoked', f.children.length === 1);
}

header('workflow — parent cancellation aborts the run including unstarted nodes');
{
  const slowA = new EchoChildModel('slow-a', 'slow-a-report', 300);
  const f = fixture([slowA, new EchoChildModel('never-b', 'never-b-report')]);
  const parent = new Agent({
    model: new ParentModel({
      nodes: [{ id: 'a', task: 'slow work' }, { id: 'b', task: 'after a' }],
      edges: [['a', 'b']],
    }),
    tools: [f.workflow.tool],
    printer: false,
  });
  await parent.initialize();
  const invocation = parent.invoke('run the workflow');
  await wait(80);
  assert('the running node is live on the dispatch registry', f.dispatches.list()[0]?.state === 'running');
  parent.cancel();
  const result = await invocation;
  assert('the parent turn ends cancelled', result.stopReason === 'cancelled');
  const list = f.dispatches.list();
  assert('both the running node and the never-started node settle cancelled',
    list.length === 2 && list.every((entry) => entry.state === 'cancelled'));
  assert('the unstarted node never reached its model', f.children.length === 1 && (f.created() === 2));
  await f.workflow.shutdown();
}

header('workflow — parent-only registration (never in child catalogues)');
{
  const runtime = await readFile(path.resolve(import.meta.dirname, '../src/agent/runtime.ts'), 'utf8');
  const capture = runtime.indexOf("const childTools = agent.tools.filter");
  const construct = runtime.indexOf('new WorkflowTool(');
  const register = runtime.indexOf('agent.toolRegistry.add(workflows.tool)');
  assert('runtime captures the child catalogue before constructing and registering workflow',
    capture !== -1 && construct !== -1 && register !== -1 && capture < construct && construct < register);
  const source = await readFile(path.resolve(import.meta.dirname, '../src/agents/workflow-tool.ts'), 'utf8');
  assert('the workflow tool never sets toolExecutor and states the reads/writes rule',
    !source.includes('toolExecutor') && source.includes('parallel branches are for READS'));
}

report();
