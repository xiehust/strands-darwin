/** Offline contracts for custom agent loading, isolation, permissions, and lifecycle. */
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import {
  SubagentDispatchRegistry,
  shortDispatchId,
  type SubagentDispatchStatus,
} from '../src/agents/dispatch-registry.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import { PermissionGate, type AssessedPermissionRequest } from '../src/agent/permission.js';
import { ToolHookGate } from '../src/hooks/tool-hooks.js';

import { darwinDir } from '../src/paths.js';
import { SkillsPlugin } from '../src/skills/plugin.js';
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

/**
 * Two delegations in one assistant message, optionally preceded by a gated call
 * the parent makes itself — the shape that distinguishes parent provenance from
 * child provenance without any model access.
 */
class MultiDispatchParentModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.multi-parent', contextWindowLimit: 200_000 };

  constructor(
    private readonly dispatches: readonly { toolUseId: string; task: string; agent?: string }[],
    private readonly parentProbeFirst = false,
  ) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const results = messages.filter((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    ).length;
    const step = this.parentProbeFirst ? results : results + 1;

    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    if (step === 0) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'dangerousProbe', toolUseId: 'parent-probe' },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: '{"value":"parent"}' },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    if (step === 1) {
      // Both blocks in one message: this is what the concurrent tool executor races.
      for (const dispatch of this.dispatches) {
        yield {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'subagent', toolUseId: dispatch.toolUseId },
        };
        yield {
          type: 'modelContentBlockDeltaEvent',
          delta: {
            type: 'toolUseInputDelta',
            input: JSON.stringify({
              task: dispatch.task,
              ...(dispatch.agent === undefined ? {} : { agent: dispatch.agent }),
            }),
          },
        };
        yield { type: 'modelContentBlockStopEvent' };
      }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'dispatches back' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

/** Records when its one model call started and ended, so overlap is measurable. */
class TimedChildModel extends Model<BaseModelConfig> {
  startedAt: number | undefined;
  endedAt: number | undefined;
  private config: BaseModelConfig = { modelId: 'fake.timed-child', contextWindowLimit: 200_000 };

  constructor(
    readonly tag: string,
    private readonly delayMs: number,
    private readonly useProbe = false,
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
    const hasResult = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );

    if (this.useProbe && !hasResult && (options?.toolSpecs ?? []).some((spec) => spec.name === 'dangerousProbe')) {
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'dangerousProbe', toolUseId: `probe-${this.tag}` },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: `{"value":"${this.tag}"}` },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    this.startedAt ??= Date.now();
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.endedAt = Date.now();

    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: `${this.tag} report` } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

/** A child whose model fails, so a dispatch can be observed as `failed`. */
class FailingChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.failing-child', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(): AsyncIterable<ModelStreamEvent> {
    await Promise.resolve();
    throw new Error('child provider exploded');
  }
}


async function buildFixture(): Promise<string> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(AGENTS_ROOT, { recursive: true });
  await writeFile(
    path.join(AGENTS_ROOT, 'explorer.md'),
    '---\nname: explorer\ndescription: Explore code.\ntools: [fileEditor, search_memory]\n---\n\nExplore carefully.\n',
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
  const linkedTarget = path.join(ROOT, 'linked-agent.md');
  await writeFile(linkedTarget, '---\nname: linked\ndescription: Linked agent.\ntools: []\n---\nlinked body\n');
  await symlink(linkedTarget, path.join(AGENTS_ROOT, 'linked.md'));

  return unreadable;
}

async function loader(): Promise<AgentDefinitionRegistry> {
  header('subagents — definition discovery');
  const unreadable = await buildFixture();
  const registry = await loadAgentDefinitions(ROOT, ['bash', 'fileEditor', 'dangerousProbe', 'search_memory']);
  await chmod(unreadable, 0o600);

  const names = registry.definitions.map((definition) => definition.name);
  const reasons = registry.problems.map((problem) => problem.reason);
  console.log(`  agents   : ${JSON.stringify(names)}`);
  console.log(`  problems : ${JSON.stringify(reasons)}`);

  assert('the built-in general agent is always first', names[0] === 'general');
  assert('valid direct Markdown files load', names.includes('explorer') && names.includes('no-tools'));
  assert('direct symlinked agent definitions resolve to regular files', names.includes('linked'));

  assert('a case-insensitive .md extension works', names.includes('no-tools'));
  assert('non-Markdown files are ignored', !names.includes('notes'));
  assert('the built-in name is reserved', reasons.some((reason) => reason.includes('built-in general')));
  assert('duplicates are case-insensitive', reasons.some((reason) => reason.includes('EXPLORER')));
  assert('unknown tools reject one definition', reasons.some((reason) => reason.includes('unknown tool')));
  assert('empty prompts reject one definition', reasons.some((reason) => reason.includes('system prompt is empty')));
  assert('bad YAML is isolated', reasons.some((reason) => reason.includes('invalid YAML')));
  assert('unreadable files are isolated', reasons.some((reason) => reason.includes('could not read file')));
  assert('an explicit empty tool list survives', registry.definitions.find((d) => d.name === 'no-tools')?.tools?.length === 0);
  assert('a tool allowlist is preserved exactly', registry.definitions.find((d) => d.name === 'explorer')?.tools?.join(',') === 'fileEditor,search_memory');
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
  const searchMemory = tool({
    name: 'search_memory',
    description: 'Read-only project memory marker.',
    inputSchema: z.object({ query: z.string() }),
    callback: ({ query }) => query,
  });

  return new SubagentTool({
    registry,
    tools: [harmlessEditor, dangerousProbe, searchMemory],
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
  assert('general receives every eligible tool including search_memory', firstText.includes('fileEditor,dangerousProbe,search_memory'));
  assert('repeated dispatch has no prior child history', secondText.includes('messages=1'));
  assert('a restricted definition receives its explicit allowlist including search_memory',
    JSON.stringify(restricted).includes('tools=fileEditor,search_memory'));
  assert('an empty allowlist receives no tools', JSON.stringify(noTools).includes('tools='));
  assert('an unknown name returns the accepted names', JSON.stringify(unknown).includes('Available agents'));

  const transcript = JSON.stringify(parent.messages.map((message) => message.toJSON()));
  assert('the parent records subagent tool use/results', transcript.includes('subagent'));
  assert('child tool transcripts never enter parent history', !transcript.includes('probe-1'));
  assert('only the child final report enters the parent result', transcript.includes('report messages=1'));
  await subagents.shutdown();
}

async function officialSkillChildCatalogue(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — official skills compatibility reaches real child catalogue');
  const skills = await SkillsPlugin.load(ROOT);
  const parent = new Agent({ model: new ScriptedChildModel(), plugins: [skills], printer: false });
  await parent.initialize();
  const eligible = parent.tools;
  const childTools: string[][] = [];
  const subagents = new SubagentTool({
    registry,
    tools: eligible,
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: ROOT, ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: fakeConfig('skills-child'),
    createModel: async () => new ScriptedChildModel(),
    onChildInitialized: (child) => childTools.push(child.tools.map((tool) => tool.name)),
  });
  try {
    const host = new Agent({ model: new ScriptedChildModel(), tools: [subagents.tool], printer: false });
    await host.initialize();
    await host.tool.subagent?.invoke({ task: 'inspect child skills' });
    const names = childTools[0] ?? [];
    assert('the actual child receives load_skill', names.includes('load_skill'));
    assert('the actual child never receives native skills', !names.includes('skills'));
  } finally {
    await subagents.shutdown();
  }
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

/**
 * Two dispatches in one assistant message must overlap in time.
 *
 * Nothing in darwin makes that happen: SDK 1.12 defaults `toolExecutor` to
 * `ConcurrentToolExecutor`, which races the per-tool generators. This pins that
 * default — set it to `'sequential'` and these numbers double.
 */
async function concurrentDispatch(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — two dispatches in one message run concurrently');

  const delayMs = 300;
  const children: TimedChildModel[] = [];
  const dispatches = new SubagentDispatchRegistry();
  const finished: SubagentDispatchStatus[] = [];
  const unsubscribe = dispatches.subscribe((dispatch) => finished.push(dispatch));

  const subagents = new SubagentTool({
    registry,
    tools: [],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: ROOT, ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: fakeConfig('concurrent'),
    createModel: async () => {
      const model = new TimedChildModel(String.fromCharCode(65 + children.length), delayMs);
      children.push(model);
      return model;
    },
    dispatches,
  });
  const parent = new Agent({
    tools: [subagents.tool],
    model: new MultiDispatchParentModel([
      { toolUseId: 'sub-a', task: 'search for every call site' },
      { toolUseId: 'sub-b', task: 'read the permission gate', agent: 'explorer' },
    ]),
    printer: false,
  });
  await parent.initialize();

  const startedAt = Date.now();
  const result = await parent.invoke('delegate twice');
  const elapsed = Date.now() - startedAt;

  const starts = children.map((child) => child.startedAt ?? 0);
  const ends = children.map((child) => child.endedAt ?? 0);
  console.log(`  two ${delayMs}ms children took ${elapsed}ms; starts ${starts.map((value) => value - startedAt).join(', ')}`);

  assert('both dispatches ran', children.length === 2 && starts.every((value) => value > 0));
  assert(
    'the second child started before the first finished',
    Math.min(...ends) > Math.max(...starts),
  );
  assert('the turn took one delay, not two', elapsed < delayMs * 2 - 50);
  assert('both reports reached the parent', result.stopReason === 'endTurn');

  const listed = dispatches.list();
  console.log(`  dispatches: ${JSON.stringify(listed.map((entry) => [entry.dispatchId, entry.agentName, entry.state]))}`);
  assert('every dispatch is observable from the registry', listed.length === 2);
  assert('dispatch ids come from the parent tool-use ids', listed.map((entry) => entry.dispatchId).join(',') === `${shortDispatchId('sub-a')},${shortDispatchId('sub-b')}`);
  assert('each dispatch records the agent it ran', listed.map((entry) => entry.agentName).join(',') === 'general,explorer');
  assert('each dispatch records the delegated task in full', listed[1]?.task === 'read the permission gate');
  assert('both dispatches settled as succeeded', listed.every((entry) => entry.state === 'succeeded'));
  assert('every dispatch has a finish time', listed.every((entry) => entry.finishedAt !== null));
  assert('one terminal event per dispatch', finished.length === 2);
  assert('terminal events carry terminal states', finished.every((entry) => entry.state === 'succeeded'));

  unsubscribe();
  await subagents.shutdown();
}

/**
 * Which agent asked. Parent and children share one gate instance, so without this
 * a queued prompt cannot say whose work it belongs to — and under concurrency
 * several children really do queue behind one another.
 */
async function dispatchProvenance(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — permission requests carry their originating agent');

  const asked: AssessedPermissionRequest[] = [];
  const dispatches = new SubagentDispatchRegistry();
  const gate = new PermissionGate({
    mode: 'default',
    projectRoot: ROOT,
    ask: async (request) => {
      asked.push(request);
      return { allowed: true };
    },
    dispatchSource: (agentId) => dispatches.sourceFor(agentId),
  });
  const dangerousProbe = tool({
    name: 'dangerousProbe',
    description: 'Provenance probe.',
    inputSchema: z.object({ value: z.string() }),
    callback: ({ value }) => `ran ${value}`,
  });
  // Both dispatched definitions need the probe in their catalogue, or the one with
  // a narrower allowlist would simply never ask and the label would go untested.
  const probeRegistry: AgentDefinitionRegistry = {
    definitions: registry.definitions.map((definition) =>
      definition.name === 'explorer' ? { ...definition, tools: undefined } : definition,
    ),
    problems: registry.problems,
  };
  const subagents = new SubagentTool({
    registry: probeRegistry,
    tools: [dangerousProbe],
    intervention: gate,
    projectInstructions: undefined,
    config: fakeConfig('provenance'),
    createModel: async () => new TimedChildModel(`${asked.length}`, 0, true),
    dispatches,
  });
  const parent = new Agent({
    tools: [subagents.tool, dangerousProbe],
    model: new MultiDispatchParentModel(
      [
        { toolUseId: 'sub-a', task: 'child one' },
        { toolUseId: 'sub-b', task: 'child two', agent: 'explorer' },
      ],
      true,
    ),
    interventions: [gate],
    printer: false,
  });
  await parent.initialize();
  await parent.invoke('probe, then delegate twice');

  console.log(`  sources: ${JSON.stringify(asked.map((request) => request.source))}`);
  const parentRequests = asked.filter((request) => request.source.kind === 'parent');
  const childRequests = asked.filter((request) => request.source.kind === 'child');

  assert('the parent call is labelled as the parent', parentRequests.length === 1 && parentRequests[0]?.source.label === 'parent');
  assert('a parent source carries no dispatch identity', parentRequests[0]?.source.dispatchId === undefined);
  assert('both child calls are labelled as children', childRequests.length === 2);
  assert(
    'a child label names the agent and its dispatch',
    childRequests.every((request) => request.source.label === `${request.source.agentName}#${request.source.dispatchId}`),
  );
  assert(
    'child labels resolve to the dispatch ids the registry recorded',
    childRequests.every((request) =>
      dispatches.list().some((entry) => entry.dispatchId === request.source.dispatchId && entry.agentName === request.source.agentName),
    ),
  );
  assert(
    'concurrent children are told apart',
    new Set(childRequests.map((request) => request.source.label)).size === 2,
  );
  assert(
    'both dispatched definitions appear',
    childRequests.map((request) => request.source.agentName).sort().join(',') === 'explorer,general',
  );
  assert('an untracked agent id is the parent', dispatches.sourceFor('darwin') === undefined);

  const transcript = JSON.stringify(parent.messages.map((message) => message.toJSON()));
  assert('child tool transcripts still never enter parent history', !transcript.includes('probe-'));

  await subagents.shutdown();
}

/** Terminal states other than success, and what is deliberately not recorded. */
async function dispatchStates(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — dispatch states and observer isolation');

  const dispatches = new SubagentDispatchRegistry();
  const subagents = new SubagentTool({
    registry,
    tools: [],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: ROOT, ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: fakeConfig('states'),
    createModel: async () => new FailingChildModel(),
    dispatches,
  });
  const parent = new Agent({ tools: [subagents.tool], model: new ScriptedChildModel(), printer: false });
  await parent.initialize();

  await parent.tool.subagent?.invoke({ task: 'this one breaks' }).catch(() => undefined);
  const afterFailure = dispatches.list();
  assert('a failed child is recorded as failed', afterFailure.length === 1 && afterFailure[0]?.state === 'failed');

  await parent.tool.subagent?.invoke({ task: 'nobody', agent: 'missing' });
  assert('an unknown agent name records no dispatch', dispatches.list().length === 1);
  await subagents.shutdown();

  // Observer semantics, asserted against the registry itself: exactly-once
  // publication and failure isolation belong to the manager, not to the UI.
  const bare = new SubagentDispatchRegistry();
  const seen: string[] = [];
  const stopThrowing = bare.subscribe(() => {
    throw new Error('observer failure');
  });
  const stopRecording = bare.subscribe((dispatch) => seen.push(`${dispatch.dispatchId}:${dispatch.state}`));

  const handle = bare.begin({ agentName: 'general', task: 'observed', toolUseId: 'tooluse_abcdefgh' });
  handle.finish('succeeded');
  handle.finish('failed');
  assert('a throwing observer does not hide the event from the others', seen.length === 1);
  assert('the first terminal state wins', seen[0] === 'abcdefgh:succeeded' && bare.list()[0]?.state === 'succeeded');

  stopRecording();
  stopThrowing();
  bare.begin({ agentName: 'general', task: 'after unsubscribe' }).finish('cancelled');
  assert('unsubscribing stops delivery', seen.length === 1);
  assert('a cancelled dispatch is still listed', bare.list().some((entry) => entry.state === 'cancelled'));
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
await officialSkillChildCatalogue(registry);

async function cancellation(registry: AgentDefinitionRegistry): Promise<void> {
  header('subagents — parent cancellation reaches an active child');
  const childModels: ScriptedChildModel[] = [];
  const dispatches = new SubagentDispatchRegistry();
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
    dispatches,
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
  // A cancelled dispatch settles as itself: an interrupted child must not be
  // reported as a failure, and must not stay `running` forever either.
  const cancelled = dispatches.list();
  console.log(`  dispatch after cancel: ${JSON.stringify(cancelled.map((entry) => entry.state))}`);
  assert('cancellation settles the dispatch as cancelled', cancelled[0]?.state === 'cancelled');
  assert('a cancelled dispatch stops being reported as running', cancelled.every((entry) => entry.state !== 'running'));
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

await concurrentDispatch(registry);
await dispatchProvenance(registry);
await dispatchStates(registry);

await modelSnapshot(registry);
await rm(ROOT, { recursive: true, force: true });
report();
