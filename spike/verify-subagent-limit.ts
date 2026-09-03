/**
 * Offline SER-061 contracts: the configurable `maxConcurrentSubagents` ceiling
 * on running dispatches. With cap N, the (N+1)th `subagent` call and a `workflow`
 * whose effective parallelism exceeds the free slots are refused as one bounded
 * tool error *before* any model, dispatch record or child exists; settlement on
 * the registry's terminal transition re-admits. Scripted models, no network.
 */
import { Agent, Model } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';

import { PermissionGate } from '../src/agent/permission.js';
import { concurrencyLimitMessage } from '../src/agents/concurrency-limit.js';
import { SubagentDispatchRegistry } from '../src/agents/dispatch-registry.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import { SubagentTool, SUBAGENT_TOOL_NAME } from '../src/agents/subagent-tool.js';
import { WorkflowTool, WORKFLOW_TOOL_NAME } from '../src/agents/workflow-tool.js';
import { DEFAULT_MAX_CONCURRENT_SUBAGENTS } from '../src/config.js';
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
  ],
  problems: [],
};

/** Holds its one model call open until `release()`, then reports. */
class GatedChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline.gated', contextWindowLimit: 100_000 };
  private readonly gate: Promise<void>;
  readonly release: () => void;
  constructor(private readonly label: string) {
    super();
    let open: () => void = () => undefined;
    this.gate = new Promise<void>((resolve) => { open = resolve; });
    this.release = open;
  }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    await this.gate;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `${this.label} report` } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

interface Fixture {
  subagents: SubagentTool;
  workflow: WorkflowTool;
  dispatches: SubagentDispatchRegistry;
  children: Agent[];
  models: GatedChildModel[];
  created: () => number;
}

function fixture(cap: number | undefined): Fixture {
  const dispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
  const children: Agent[] = [];
  const models: GatedChildModel[] = [];
  let created = 0;
  const config = {
    model: 'offline',
    provider: 'bedrock',
    region: 'us-west-2',
    ...(cap === undefined ? {} : { maxConcurrentSubagents: cap }),
  } as never;
  const shared = {
    registry,
    tools: [],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: '/tmp', ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config,
    createModel: async () => {
      created += 1;
      const model = new GatedChildModel(`child-${created}`);
      models.push(model);
      return model;
    },
    dispatches,
    onChildInitialized: (agent: Agent) => { children.push(agent); },
  };
  return {
    subagents: new SubagentTool(shared),
    workflow: new WorkflowTool(shared),
    dispatches,
    children,
    models,
    created: () => created,
  };
}

type DirectResult = { status?: string; content?: Array<{ text?: string }> };

function resultText(result: unknown): string {
  return ((result as DirectResult).content ?? []).map((block) => block.text ?? '').join('\n');
}

async function host(f: Fixture): Promise<Agent> {
  const agent = new Agent({ model: new GatedChildModel('unused'), tools: [f.subagents.tool, f.workflow.tool], printer: false });
  await agent.initialize();
  return agent;
}

function delegate(agent: Agent, task: string): Promise<DirectResult> {
  return agent.tool[SUBAGENT_TOOL_NAME]!.invoke({ task } as never, { recordDirectToolCall: false }) as Promise<DirectResult>;
}

function orchestrate(agent: Agent, input: unknown): Promise<DirectResult> {
  return agent.tool[WORKFLOW_TOOL_NAME]!.invoke(input as never, { recordDirectToolCall: false }) as Promise<DirectResult>;
}

/** Bounded poll: the SDK's tool path has a few awaits before `begin()` runs. */
async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(what, condition());
}

function isRefusal(result: DirectResult, expected: string): boolean {
  const text = resultText(result);
  return result.status === 'error' && text.includes(expected) && text.length < 400 && !text.includes('\n    at ');
}

header('concurrency limit — cap N: the (N+1)th subagent call is refused before model, dispatch or child');
{
  const cap = 2;
  const f = fixture(cap);
  const agent = await host(f);

  const first = delegate(agent, 'hold slot one');
  const second = delegate(agent, 'hold slot two');
  await until('N dispatches are running', () => f.dispatches.runningCount() === cap);
  await until('each running dispatch built exactly one model and child', () => f.created() === cap && f.children.length === cap);

  const third = await delegate(agent, 'one too many');
  const expected = concurrencyLimitMessage(cap, cap);
  assert(`the (N+1)th call is a bounded error result with the fixed shape (${JSON.stringify(expected)})`, isRefusal(third, expected));
  assert('the refusal names the cap and the running count and says not to retry',
    /Concurrent subagent limit reached: 2 of 2 dispatches running\. Do not retry until one settles; wait for its result instead\./.test(resultText(third)));
  assert('createModel was not called for the refused call', f.created() === cap);
  assert('no dispatch record was added for the refused call', f.dispatches.list().length === cap && f.dispatches.runningCount() === cap);
  assert('no child was initialized for the refused call', f.children.length === cap);

  header('concurrency limit — a workflow over the free slots is refused before any node is built');
  const oneNode = await orchestrate(agent, { nodes: [{ id: 'a', task: 'needs one slot' }] });
  assert('a one-node workflow at the cap is refused with the same shape', isRefusal(oneNode, concurrencyLimitMessage(cap, cap, 1)));
  assert('the workflow refusal built no model, dispatch or child (onChildInitialized never fired)',
    f.created() === cap && f.dispatches.list().length === cap && f.children.length === cap);

  header('concurrency limit — settlement frees the slot and re-admits');
  f.models[0]!.release();
  const firstResult = await first;
  assert('the released dispatch settled successfully', firstResult.status !== 'error' && resultText(firstResult).includes('child-1 report'));
  assert('its slot is free on the registry', f.dispatches.runningCount() === cap - 1 && f.dispatches.list().length === cap);

  const fourth = delegate(agent, 'admitted after settlement');
  await until('a new dispatch is admitted once a slot is free', () => f.dispatches.runningCount() === cap && f.created() === cap + 1);
  await until('the admitted dispatch initialized a child', () => f.children.length === cap + 1);

  header('concurrency limit — workflow parallelism is min(nodes, maxConcurrency) against the free slots');
  f.models[1]!.release();
  f.models[2]!.release();
  await Promise.all([second, fourth]);
  assert('every dispatch settled; the registry is idle', f.dispatches.runningCount() === 0 && f.dispatches.list().length === cap + 1);

  const tooWide = await orchestrate(agent, { nodes: [{ id: 'a', task: 'a' }, { id: 'b', task: 'b' }, { id: 'c', task: 'c' }] });
  assert('three unconstrained nodes exceed an idle cap of 2 and are refused naming need vs free',
    isRefusal(tooWide, concurrencyLimitMessage(cap, 0, 3)) && resultText(tooWide).includes('This call needs 3 slots; 2 are free.'));
  assert('the refused workflow built nothing', f.created() === cap + 1 && f.dispatches.list().length === cap + 1 && f.children.length === cap + 1);

  const before = f.created();
  const fits = orchestrate(agent, {
    nodes: [{ id: 'a', task: 'a' }, { id: 'b', task: 'b' }, { id: 'c', task: 'c' }],
    maxConcurrency: 2,
  });
  await until('the same DAG with maxConcurrency 2 is admitted and its nodes are built', () => f.created() === before + 3);
  for (const model of f.models.slice(before)) model.release();
  const fitsResult = await fits;
  assert('the admitted workflow ran to completion', fitsResult.status !== 'error' && resultText(fitsResult).includes('report'));
  assert('all workflow node dispatches settled', f.dispatches.runningCount() === 0);
}

header('concurrency limit — live config: updateConfig lowers the cap for the next call');
{
  const f = fixture(3);
  const agent = await host(f);
  const held = delegate(agent, 'hold one');
  await until('one dispatch running under cap 3', () => f.dispatches.runningCount() === 1);
  f.subagents.updateConfig({ model: 'offline', provider: 'bedrock', region: 'us-west-2', maxConcurrentSubagents: 1 } as never);
  const refused = await delegate(agent, 'now over the lowered cap');
  assert('the lowered cap applies to the next call (1 of 1)', isRefusal(refused, concurrencyLimitMessage(1, 1)));
  f.models[0]!.release();
  await held;
  assert('the held dispatch still settled normally', f.dispatches.runningCount() === 0);
}

header('concurrency limit — default cap and tool descriptions');
{
  const f = fixture(undefined);
  assert(`a partial config falls back to the default cap of ${DEFAULT_MAX_CONCURRENT_SUBAGENTS}`,
    f.subagents.tool.description.includes(`At most ${DEFAULT_MAX_CONCURRENT_SUBAGENTS} child dispatches run at once`));
  assert('the subagent description names the config field', f.subagents.tool.description.includes('maxConcurrentSubagents'));
  assert('the workflow description carries the same clause', f.workflow.tool.description.includes('maxConcurrentSubagents')
    && f.workflow.tool.description.includes(`At most ${DEFAULT_MAX_CONCURRENT_SUBAGENTS} child dispatches`));
  const capped = fixture(3);
  assert('a configured cap is stated in both descriptions',
    capped.subagents.tool.description.includes('At most 3 child dispatches') && capped.workflow.tool.description.includes('At most 3 child dispatches'));
  assert('a fresh registry (what /clear\'s successor runtime builds) has zero running dispatches',
    new SubagentDispatchRegistry().runningCount() === 0);
}

report();
