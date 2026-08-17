/** Offline real-Agent contracts for Darwin's official AgentSkills adapter. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  BeforeInvocationEvent,
  CachePointBlock,
  Message,
  Model,
  SessionManager,
  TextBlock,
  type BaseModelConfig,
  type ModelStreamEvent,
  type StreamOptions,
  type SystemPrompt,
} from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { Skill } from '@strands-agents/sdk/vended-plugins/skills';

import { applySystemPromptCachePoint, type PromptCachePlan } from '../src/agent/prompt-cache.js';
import { applyWorkingContext } from '../src/agent/working-context.js';
import { orderOfficialSkillsPrompt } from '../src/skills/prompt.js';
import { MAX_SKILL_RESOURCE_FILES, SkillsPlugin } from '../src/skills/plugin.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('agent-skills');

const CACHE_PLAN: PromptCachePlan = {
  enabled: true,
  parts: ['system prompt'],
  ttl: '5m',
  problem: undefined,
};

class CaptureModel extends Model<BaseModelConfig> {
  readonly calls: { prompt: SystemPrompt | undefined; tools: string[] }[] = [];
  private config: BaseModelConfig = { modelId: 'fake.skills', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(_messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls.push({ prompt: options?.systemPrompt, tools: options?.toolSpecs?.map((tool) => tool.name) ?? [] });
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function installOrdering(agent: Agent): void {
  agent.addHook(BeforeInvocationEvent, ({ agent: invokingAgent }) => {
    orderOfficialSkillsPrompt(invokingAgent);
  });
}

function promptText(prompt: SystemPrompt | undefined): string {
  if (typeof prompt === 'string') return prompt;
  return (prompt ?? [])
    .map((block) => (block instanceof TextBlock ? block.text : ''))
    .join('\n');
}

function assertRequestOrder(label: string, prompt: SystemPrompt | undefined, current: string): void {
  const blocks = Array.isArray(prompt) ? prompt : [];
  const text = promptText(prompt);
  const base = text.indexOf('BASE');
  const project = text.indexOf('<project-instructions>');
  const skills = blocks[1] instanceof TextBlock ? text.indexOf(blocks[1].text) : -1;
  const working = text.indexOf(current);
  assert(`${label}: prompt uses explicit blocks`, blocks.length === 4);
  assert(`${label}: base -> project -> skills -> working`, [base, project, skills, working].every((at, index, all) => at >= 0 && (index === 0 || at > (all[index - 1] ?? -1))));
  assert(`${label}: catalogue appears exactly once`, blocks.filter((block) => block instanceof TextBlock && block.text.trim().startsWith('<available_skills>')).length === 1);
  assert(`${label}: working context appears exactly once`, blocks.filter((block) => block instanceof TextBlock && block.text.trim().startsWith('<working-context>')).length === 1);
  assert(`${label}: final block is the cache point`, blocks.at(-1) instanceof CachePointBlock);
  assert(`${label}: official catalogue is its own block`, blocks[1] instanceof TextBlock && (blocks[1] as TextBlock).text.startsWith('<available_skills>'));
}

async function promptAndResume(): Promise<void> {
  header('official AgentSkills — first, repeated, resumed model-request order');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-agent-skills-order-'));
  const storage = new LocalFileStorage(root);
  const skill = new Skill({ name: 'probe-skill', description: 'Probe.', instructions: 'PROBE' });
  const firstPlugin = await pluginFrom([skill]);
  const firstModel = new CaptureModel();
  const first = new Agent({
    id: 'darwin-skills-probe',
    model: firstModel,
    plugins: [firstPlugin],
    sessionManager: new SessionManager({ sessionId: 'skills-resume', storage, saveLatestOn: 'invocation' }),
    systemPrompt:
      'BASE\n\n<project-instructions>RULES mention <available_skills> and <working-context> literally</project-instructions>',
    printer: false,
  });

  try {
    await first.initialize();
    installOrdering(first);
    assert('only load_skill is registered after initialization', first.tools.map((tool) => tool.name).join(',') === 'load_skill');
    const spec = first.tools[0]?.toolSpec.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert('load_skill schema exposes required name', spec.properties?.['name'] !== undefined && spec.required?.includes('name') === true);

    const currentOne = '<working-context>current-one</working-context>';
    assert('fresh working context is applied to explicit blocks', applyWorkingContext(first, currentOne));
    assert('fresh cache point is placed', applySystemPromptCachePoint(first, CACHE_PLAN));
    await first.invoke('first');
    assertRequestOrder('first request', firstModel.calls[0]?.prompt, 'current-one');
    assert('model sees no native skills tool', firstModel.calls[0]?.tools.join(',') === 'load_skill');

    await first.invoke('second');
    assertRequestOrder('repeated request', firstModel.calls[1]?.prompt, 'current-one');

    const resumedPlugin = await pluginFrom([skill]);
    const resumedModel = new CaptureModel();
    const resumed = new Agent({
      id: 'darwin-skills-probe',
      model: resumedModel,
      plugins: [resumedPlugin],
      sessionManager: new SessionManager({ sessionId: 'skills-resume', storage, saveLatestOn: 'invocation' }),
      systemPrompt: 'FRESH MUST BE REPLACED',
      printer: false,
    });
    await resumed.initialize();
    installOrdering(resumed);
    const currentTwo = '<working-context>current-two</working-context>';
    assert('resumed known block shape accepts current context', applyWorkingContext(resumed, currentTwo));
    assert('resumed cache point is re-placed', applySystemPromptCachePoint(resumed, CACHE_PLAN));
    await resumed.invoke('resumed');
    assertRequestOrder('resumed request', resumedModel.calls[0]?.prompt, 'current-two');
    const resumedText = promptText(resumedModel.calls[0]?.prompt);
    assert('resumed request removed stale working context', !resumedText.includes('current-one'));
    assert('resume restored official plugin state', resumed.appState.get('darwin_agent_skills') !== undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function activationAndBounds(): Promise<void> {
  header('official AgentSkills — compatibility activation and bounded resources');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-agent-skills-resources-'));
  const skillDir = path.join(root, 'bounded-skill');
  await mkdir(path.join(skillDir, 'references'), { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: bounded-skill\ndescription: Bound it.\n---\nOFFICIAL BODY\n');

  for (let index = 0; index < 5; index += 1) {
    await writeFile(path.join(skillDir, 'references', `${index}.md`), `${index}\n`);
  }

  const project = path.join(root, 'project');
  await mkdir(path.join(project, '.darwin', 'skills', 'bounded-skill'), { recursive: true });
  await writeFile(path.join(project, '.darwin', 'skills', 'bounded-skill', 'SKILL.md'), await readFile(path.join(skillDir, 'SKILL.md')));
  await mkdir(path.join(project, '.darwin', 'skills', 'bounded-skill', 'references'), { recursive: true });
  for (let index = 0; index < 5; index += 1) {
    await writeFile(path.join(project, '.darwin', 'skills', 'bounded-skill', 'references', `${index}.md`), `${index}\n`);
  }

  try {
    const plugin = await SkillsPlugin.load(project, { maxResourceFiles: 2 });
    const agent = new Agent({ model: new CaptureModel(), plugins: [plugin], printer: false });
    await agent.initialize();
    const compatibility = agent.tools.find((tool) => tool.name === 'load_skill') as { invoke(input: { name: string }, context: unknown): Promise<unknown> } | undefined;
    assert('native skills tool is not exposed', !agent.tools.some((tool) => tool.name === 'skills'));
    const context = {
      agent,
      invocationState: {},
      toolUse: { name: 'load_skill', toolUseId: 'compat-1', input: { name: 'BOUNDED-SKILL' } },
      interrupt: () => { throw new Error('unused'); },
    };
    const loaded = await compatibility?.invoke({ name: 'BOUNDED-SKILL' }, context) as { instructions?: string };
    assert('compatibility tool returns official instructions field', loaded.instructions?.includes('OFFICIAL BODY') === true);
    assert('official resource listing is capped', loaded.instructions?.includes('references/0.md') === true && loaded.instructions?.includes('references/1.md') === true && loaded.instructions?.includes('references/2.md') === false);
    assert('official resource truncation is explicit', loaded.instructions?.includes('... (truncated at 2 files)') === true);
    assert('official appState tracks canonical activation', plugin.getActivatedSkills(agent).join(',') === 'bounded-skill');
    const unknown = await compatibility?.invoke({ name: 'nope' }, { ...context, toolUse: { name: 'load_skill', toolUseId: 'compat-2', input: { name: 'nope' } } }) as { error?: string; availableSkills?: string[] };
    assert('unknown skill remains recoverable and lists names', unknown.error?.includes('nope') === true && unknown.availableSkills?.includes('bounded-skill') === true);
    assert('production resource cap is explicit and finite', MAX_SKILL_RESOURCE_FILES === 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function pluginFrom(skills: Skill[]): Promise<SkillsPlugin> {
  // Build through the production catalogue by writing ordinary project skills.
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-agent-skills-plugin-'));
  for (const skill of skills) {
    const directory = path.join(root, '.darwin', 'skills', skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.instructions}\n`);
  }
  return SkillsPlugin.load(root);
}

await promptAndResume();
await activationAndBounds();
report();
