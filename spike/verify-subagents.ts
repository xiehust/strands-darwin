/** Offline contracts for custom agent loading, isolation, permissions, and lifecycle. */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  Agent,
  Model,
  tool,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import { bash } from '@strands-agents/sdk/vended-tools/bash';
import { z } from 'zod';

import {
  AGENTS_DIRNAME,
  loadAgentDefinitions,
  type AgentDefinitionRegistry,
} from '../src/agents/loader.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import { PermissionGate, type AssessedPermissionRequest } from '../src/agent/permission.js';
import { ToolHookGate } from '../src/hooks/tool-hooks.js';

import { darwinDir } from '../src/paths.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-subagents-test';
const AGENTS_ROOT = path.join(darwinDir(ROOT), AGENTS_DIRNAME);

class ScriptedChildModel extends Model<BaseModelConfig> {
  readonly calls: { messages: number; tools: string[]; systemPrompt: unknown }[] = [];
  private config: BaseModelConfig = { modelId: 'fake.subagent', contextWindowLimit: 200_000 };

  constructor(
    private readonly useProbe = false,
    private readonly delayMs = 0,
  ) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const tools = options?.toolSpecs?.map((spec) => spec.name) ?? [];
    this.calls.push({ messages: messages.length, tools, systemPrompt: options?.systemPrompt });

    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

    const hasProbeResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    if (this.useProbe && tools.includes('dangerousProbe') && !hasProbeResult) {
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'dangerousProbe', toolUseId: 'probe-1' },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{"value":"marker"}' },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    const text = `report messages=${messages.length} tools=${tools.join(',')}`;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

class DelegatingParentModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.parent', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasSubagentResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasSubagentResult) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'subagent', toolUseId: 'subagent-1' },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{"task":"delayed work"}' },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'continued' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }

}

class BashChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.bash-child', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'bash', toolUseId: 'bash-1' },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{"mode":"execute","command":"printf child-bash-ok"}' },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'bash done' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

async function buildFixture(): Promise<string> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(AGENTS_ROOT, { recursive: true });
  await writeFile(
    path.join(AGENTS_ROOT, 'explorer.md'),
    '---\nname: explorer\ndescription: Explore code.\ntools: [fileEditor]\n---\n\nExplore carefully.\n',
  );
  await writeFile(
    path.join(AGENTS_ROOT, 'no-tools.MD'),
    '---\nname: no-tools\ndescription: Think without tools.\ntools: []\n---\n\nThink independently.\n',
  );
  await writeFile(path.join(AGENTS_ROOT, 'general.md'), '---\nname: general\ndescription: shadow\n---\nbody\n');
  await writeFile(path.join(AGENTS_ROOT, 'z-duplicate.md'), '---\nname: EXPLORER\ndescription: duplicate\n---\nbody\n');
  await writeFile(path.join(AGENTS_ROOT, 'unknown.md'), '---\nname: unknown\ndescription: bad tool\ntools: [missing]\n---\nbody\n');
  await writeFile(path.join(AGENTS_ROOT, 'empty.md'), '---\nname: empty\ndescription: empty body\n---\n');
  await writeFile(path.join(AGENTS_ROOT, 'bad.md'), '---\nname: [oops\n---\nbody\n');
  await writeFile(path.join(AGENTS_ROOT, 'notes.txt'), 'ignored\n');
  const unreadable = path.join(AGENTS_ROOT, 'unreadable.md');
  await writeFile(unreadable, '---\nname: unreadable\ndescription: nope\n---\nbody\n');
  await chmod(unreadable, 0o000);
  return unreadable;
}

async function loader(): Promise<AgentDefinitionRegistry> {
  header('subagents — definition discovery');
  const unreadable = await buildFixture();
  const registry = await loadAgentDefinitions(ROOT, ['bash', 'fileEditor', 'dangerousProbe']);
  await chmod(unreadable, 0o600);

  const names = registry.definitions.map((definition) => definition.name);
  const reasons = registry.problems.map((problem) => problem.reason);
  console.log(`  agents   : ${JSON.stringify(names)}`);
  console.log(`  problems : ${JSON.stringify(reasons)}`);

  assert('the built-in general agent is always first', names[0] === 'general');
  assert('valid direct Markdown files load', names.includes('explorer') && names.includes('no-tools'));
  assert('a case-insensitive .md extension works', names.includes('no-tools'));
  assert('non-Markdown files are ignored', !names.includes('notes'));
  assert('the built-in name is reserved', reasons.some((reason) => reason.includes('built-in general')));
  assert('duplicates are case-insensitive', reasons.some((reason) => reason.includes('EXPLORER')));
  assert('unknown tools reject one definition', reasons.some((reason) => reason.includes('unknown tool')));
  assert('empty prompts reject one definition', reasons.some((reason) => reason.includes('system prompt is empty')));
  assert('bad YAML is isolated', reasons.some((reason) => reason.includes('invalid YAML')));
  assert('unreadable files are isolated', reasons.some((reason) => reason.includes('could not read file')));
  assert('an explicit empty tool list survives', registry.definitions.find((d) => d.name === 'no-tools')?.tools?.length === 0);
  assert('a tool allowlist is preserved exactly', registry.definitions.find((d) => d.name === 'explorer')?.tools?.join(',') === 'fileEditor');
  return registry;
}

async function missingDirectory(): Promise<void> {
  header('subagents — absent directory');
  const registry = await loadAgentDefinitions('/tmp/darwin-subagents-missing', []);
  assert('absence is silent and general remains', registry.definitions.length === 1 && registry.problems.length === 0);
}

function runtimeTool(
  registry: AgentDefinitionRegistry,
  models: ScriptedChildModel[],
  asked: AssessedPermissionRequest[],
  probeRan: string[],
  answer = true,
): SubagentTool {
  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return { allowed: answer };
    },
  });
  const dangerousProbe = tool({
    name: 'dangerousProbe',
    description: 'Mutation-like probe for permission tests.',
    inputSchema: z.object({ value: z.string() }),
    callback: ({ value }) => {
      probeRan.push(value);
      return `ran ${value}`;
    },
  });
  const harmlessEditor = tool({
    name: 'fileEditor',
    description: 'Tool-list marker.',
    inputSchema: z.object({}),
    callback: () => 'unused',
  });

  return new SubagentTool({
    registry,
    tools: [harmlessEditor, dangerousProbe],
    intervention: gate,
    projectInstructions: undefined,
    config: fakeConfig('first'),
    createModel: async (config) => {
      const model = new ScriptedChildModel(config.model === 'probe');
      models.push(model);
      return model;
    },
  });
}

async function dispatchContracts(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — fresh context, restrictions, and parent isolation');
  const models: ScriptedChildModel[] = [];
  const asked: AssessedPermissionRequest[] = [];
  const probeRan: string[] = [];
  const subagents = runtimeTool(registry, models, asked, probeRan);
  const parent = new Agent({ tools: [subagents.tool], model: new ScriptedChildModel(), printer: false });
  await parent.initialize();

  const first = await parent.tool.subagent?.invoke({ task: 'one' });
  const second = await parent.tool.subagent?.invoke({ task: 'two' });
  const restricted = await parent.tool.subagent?.invoke({ task: 'inspect', agent: 'explorer' });
  const noTools = await parent.tool.subagent?.invoke({ task: 'think', agent: 'no-tools' });
  const unknown = await parent.tool.subagent?.invoke({ task: 'x', agent: 'missing' });

  const firstText = JSON.stringify(first);
  const secondText = JSON.stringify(second);
  assert('each dispatch constructs a fresh model', models.length === 4);
  assert('each child starts from one delegated user message', models.every((model) => model.calls[0]?.messages === 1));
  assert('general receives every eligible tool', firstText.includes('fileEditor,dangerousProbe'));
  assert('repeated dispatch has no prior child history', secondText.includes('messages=1'));
  assert('a restricted definition receives only its allowlist', JSON.stringify(restricted).includes('tools=fileEditor'));
  assert('an empty allowlist receives no tools', JSON.stringify(noTools).includes('tools='));
  assert('an unknown name returns the accepted names', JSON.stringify(unknown).includes('Available agents'));

  const transcript = JSON.stringify(parent.messages.map((message) => message.toJSON()));
  assert('the parent records subagent tool use/results', transcript.includes('subagent'));
  assert('child tool transcripts never enter parent history', !transcript.includes('probe-1'));
  assert('only the child final report enters the parent result', transcript.includes('report messages=1'));
  await subagents.shutdown();
}

async function permissionContracts(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — shared permission gate');

  for (const allowed of [false, true]) {
    const models: ScriptedChildModel[] = [];
    const asked: AssessedPermissionRequest[] = [];
    const probeRan: string[] = [];
    const subagents = runtimeTool(registry, models, asked, probeRan, allowed);
    subagents.updateConfig(fakeConfig('probe'));
    const parent = new Agent({ tools: [subagents.tool], model: new ScriptedChildModel(), printer: false });
    await parent.initialize();
    await parent.tool.subagent?.invoke({ task: 'run the probe' });

    assert(`child dangerous tool asks when ${allowed ? 'approved' : 'denied'}`, asked[0]?.toolName === 'dangerousProbe');
    assert(
      `child dangerous tool ${allowed ? 'runs after approval' : 'does not run after denial'}`,
      allowed ? probeRan.length === 1 : probeRan.length === 0,
    );
    await subagents.shutdown();
  }
}

async function hookContracts(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — shared tool hook intervention');
  const log = path.join(ROOT, 'child-hooks');
  const probeRan: string[] = [];
  const asked: AssessedPermissionRequest[] = [];
  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return { allowed: true };
    },
  });
  const intervention = new ToolHookGate(ROOT, {
    PreToolUse: [{ matcher: 'dangerousProbe', hooks: [{ type: 'command', command: `printf pre >> ${log}` }] }],
    PostToolUse: [{ matcher: 'dangerousProbe', hooks: [{ type: 'command', command: `printf post >> ${log}` }] }],
  }, gate);
  const dangerousProbe = tool({
    name: 'dangerousProbe',
    description: 'Hook-sharing probe.',
    inputSchema: z.object({ value: z.string() }),
    callback: ({ value }) => {
      probeRan.push(value);
      return 'ok';
    },
  });
  const subagents = new SubagentTool({
    registry,
    tools: [dangerousProbe],
    intervention,
    projectInstructions: undefined,
    config: fakeConfig('probe'),
    createModel: async () => new ScriptedChildModel(true),
  });
  const parent = new Agent({ tools: [subagents.tool], model: new ScriptedChildModel(), printer: false });
  await parent.initialize();
  await parent.tool.subagent?.invoke({ task: 'run the child hook probe' });
  assert('child call reaches the same composed permission gate', asked[0]?.toolName === 'dangerousProbe');
  assert('child tool still executes after approval', probeRan.join() === 'marker');
  assert('child Pre and Post hooks both run in order', (await readFile(log, 'utf8')) === 'prepost');
  await subagents.shutdown();
}

async function planPermissionContract(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — shared plan guard');
  const asked: AssessedPermissionRequest[] = [];
  const probeRan: string[] = [];
  const dangerousProbe = tool({
    name: 'dangerousProbe',
    description: 'Plan enforcement probe.',
    inputSchema: z.object({ value: z.string() }),
    callback: ({ value }) => {
      probeRan.push(value);
      return `ran ${value}`;
    },
  });
  const subagents = new SubagentTool({
    registry,
    tools: [dangerousProbe],
    intervention: new PermissionGate({
      mode: 'plan',
      projectRoot: ROOT,
      allowRules: ['dangerousProbe'],
      ask: async (request) => {
        asked.push(request);
        return { allowed: true };
      },
    }),
    projectInstructions: undefined,
    config: fakeConfig('probe'),
    createModel: async () => new ScriptedChildModel(true),
  });
  const parent = new Agent({ tools: [subagents.tool], model: new ScriptedChildModel(), printer: false });
  await parent.initialize();
  await parent.tool.subagent?.invoke({ task: 'run the probe' });
  assert('child execute is denied without reaching the bridge', asked.length === 0);
  assert('child execute cannot use a broad allow rule', probeRan.length === 0);
  await subagents.shutdown();
}

async function modelSnapshot(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — later dispatches use updated config');
  const seen: string[] = [];
  const subagents = new SubagentTool({
    registry,
    tools: [],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: ROOT, ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: fakeConfig('first'),
    createModel: async (config) => {
      seen.push(config.model);
      return new ScriptedChildModel();
    },
  });
  const parent = new Agent({ tools: [subagents.tool], model: new ScriptedChildModel(), printer: false });
  await parent.initialize();
  await parent.tool.subagent?.invoke({ task: 'one' });
  subagents.updateConfig(fakeConfig('second'));
  await parent.tool.subagent?.invoke({ task: 'two' });
  assert('config changes apply only to later model construction', seen.join(',') === 'first,second');
  await subagents.shutdown();
}

function fakeConfig(model: string) {
  return {
    provider: 'bedrock',
    model,
    region: 'us-west-2',
    maxTokens: 1000,
    permissionMode: 'default',
    promptCache: false,
    thinkingEffort: 'high',
    summaryRatio: 0.8, contextWarnRatio: 0.8,
    preserveRecentMessages: 4,
    modelChoices: [],
  } as const;
}

const registry = await loader();
await missingDirectory();
await dispatchContracts(registry);

async function cancellation(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — parent cancellation reaches an active child');
  const childModels: ScriptedChildModel[] = [];
  const subagents = new SubagentTool({
    registry,
    tools: [],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: ROOT, ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: fakeConfig('slow'),
    createModel: async () => {
      const model = new ScriptedChildModel(false, 250);
      childModels.push(model);
      return model;
    },
  });
  const parent = new Agent({ tools: [subagents.tool], model: new DelegatingParentModel(), printer: false });
  await parent.initialize();
  const invocation = parent.invoke('delegate now');
  await new Promise((resolve) => setTimeout(resolve, 30));
  subagents.cancelActive();
  parent.cancel();
  const result = await invocation;
  assert('the parent invocation finishes as cancelled', result.stopReason === 'cancelled');
  assert('the child had begun its independent model call', childModels[0]?.calls.length === 1);
  const followUp = await parent.invoke('continue after cancellation');
  assert('the parent remains usable after child cancellation', followUp.stopReason === 'endTurn');
  await subagents.shutdown();
}

await permissionContracts(registry);
await hookContracts(registry);
await planPermissionContract(registry);

async function bashLifecycle(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — child bash session is reaped after dispatch');
  const childModel = new BashChildModel();
  const bashDefinition = {
    definitions: registry.definitions.map((definition) =>
      definition.name === 'general' ? { ...definition, tools: ['bash'] } : definition,
    ),
    problems: registry.problems,
  };
  const subagents = new SubagentTool({
    registry: bashDefinition,
    tools: [bash],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: ROOT, ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: fakeConfig('bash'),
    createModel: async () => childModel,
  });
  const parent = new Agent({ tools: [subagents.tool], model: new ScriptedChildModel(), printer: false });
  await parent.initialize();
  await parent.tool.subagent?.invoke({ task: 'run probe' });
  await subagents.shutdown();
  const active = process.getActiveResourcesInfo();
  assert('dispatch and shutdown complete without a live bash child process', !active.includes('ChildProcess'));
}

await cancellation(registry);
await bashLifecycle(registry);

await modelSnapshot(registry);
await rm(ROOT, { recursive: true, force: true });
report();
