/** Offline real-Agent contracts for Darwin's official AgentSkills adapter. */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  BeforeInvocationEvent,
  CachePointBlock,
  SessionManager,
  TextBlock,
  type SystemPrompt,
} from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { Skill } from '@strands-agents/sdk/vended-plugins/skills';

import { applySystemPromptCachePoint, type PromptCachePlan } from '../src/agent/prompt-cache.js';
import { applyWorkingContext } from '../src/agent/working-context.js';
import { orderOfficialSkillsPrompt } from '../src/skills/prompt.js';
import { MAX_SKILL_RESOURCE_FILES, SkillsPlugin } from '../src/skills/plugin.js';
import {
  MAX_SKILL_RESOURCE_PREFLIGHT_ENTRIES,
  setResourceSafetyCheckpointForTest,
} from '../src/skills/resource-safety.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('agent-skills');

const CACHE_PLAN: PromptCachePlan = {
  enabled: true,
  parts: ['system prompt'],
  ttl: '5m',
  problem: undefined,
};

function installOrdering(agent: Agent): void {
  agent.addHook(BeforeInvocationEvent, ({ agent: invokingAgent }) => {
    if (!orderOfficialSkillsPrompt(invokingAgent)) {
      throw new Error('Could not place the official skills catalogue before working context and cache.');
    }
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
    await firstPlugin.activate(firstPlugin.find('probe-skill')!);
    assert('activation is recorded before the session snapshot', firstPlugin.getActivatedSkills(first).join(',') === 'probe-skill');

    assertRequestOrder('first request', firstModel.calls[0]?.systemPrompt, 'current-one');
    assert('model sees no native skills tool', firstModel.calls[0]?.tools.join(',') === 'load_skill');

    await first.invoke('second');
    assertRequestOrder('repeated request', firstModel.calls[1]?.systemPrompt, 'current-one');

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
    const activated = resumed.appState.get('darwin_agent_skills') as { activatedSkills?: unknown } | undefined;
    assert('resume restores the canonical activated skill name', activated?.activatedSkills instanceof Array && activated.activatedSkills.join(',') === 'probe-skill');

    assert('resumed known block shape accepts current context', applyWorkingContext(resumed, currentTwo));
    assert('resumed cache point is re-placed', applySystemPromptCachePoint(resumed, CACHE_PLAN));
    await resumed.invoke('resumed');
    assertRequestOrder('resumed request', resumedModel.calls[0]?.systemPrompt, 'current-two');
    const resumedText = promptText(resumedModel.calls[0]?.systemPrompt);
    assert('resumed request removed stale working context', !resumedText.includes('current-one'));
    assert('resume restored official plugin state', resumed.appState.get('darwin_agent_skills') !== undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}


const LEGACY_PROJECT_RULES = [
  '<project-instructions source="AGENTS.md">',
  'Keep this entire rule block byte-identical.',
  'The old architecture documented the literal <available-skills> tag here.',
  'Keep this rule after the literal tag too.',
  '</project-instructions>',
].join('\n');

async function legacyResume(cached: boolean): Promise<void> {
  const shape = cached ? 'cached' : 'uncached';
  header(`official AgentSkills — legacy ${shape} resume migration`);
  const root = await mkdtemp(path.join(os.tmpdir(), `darwin-agent-skills-legacy-${shape}-`));
  const storage = new LocalFileStorage(root);
  const sessionId = `legacy-${shape}`;
  const agentId = `darwin-skills-legacy-${shape}`;
  const legacyCatalogue = [
    '<available-skills>',
    'Skills are instruction sets for specific tasks. When a request matches one,',
    'call the load_skill tool with its name to read the full instructions before',
    'you begin. Only the name and description are shown here.',
    '  <skill name="stale">description includes literal <available-skills> text</skill>',
    '</available-skills>',
  ].join('\n');
  const legacyWorkingContext = [
    '<working-context>',
    'Where this session started. The directory listing and the date are a snapshot taken at',
    'startup, not live state: re-check anything that may have changed since, including your own',
    'edits. Paths are absolute unless stated otherwise.',
    '- working directory: /tmp/literal-<working-context>-name',
    '- contents (0 directories, 1 file):',
    '    literal-<working-context>-file',
    '</working-context>',
  ].join('\n');
  const legacyPrompt = ['BASE', LEGACY_PROJECT_RULES, legacyCatalogue, legacyWorkingContext].join('\n\n');
  const legacy = new Agent({
    id: agentId,
    model: new CaptureModel(),
    sessionManager: new SessionManager({ sessionId, storage, saveLatestOn: 'invocation' }),
    systemPrompt: cached
      ? [new TextBlock(legacyPrompt), new CachePointBlock({ cacheType: 'default' })]
      : legacyPrompt,
    printer: false,
  });

  try {
    await legacy.initialize();
    await legacy.invoke(`save legacy ${shape}`);

    const pluginRoot = await mkdtemp(path.join(os.tmpdir(), 'darwin-agent-skills-current-'));
    const plugin = await pluginFrom(
      [new Skill({ name: 'current-skill', description: 'Current.', instructions: 'CURRENT' })],
      pluginRoot,
    );
    try {
      const model = new CaptureModel();
      const resumed = new Agent({
        id: agentId,
        model,
        plugins: [plugin],
        sessionManager: new SessionManager({ sessionId, storage, saveLatestOn: 'invocation' }),
        systemPrompt: 'FRESH',
        printer: false,
      });
      await resumed.initialize();
      installOrdering(resumed);
      assert(`${shape}: legacy prompt accepts current working context`, applyWorkingContext(resumed, '<working-context>current-context</working-context>'));
      if (cached) assert(`${shape}: final cache point is re-placed`, applySystemPromptCachePoint(resumed, CACHE_PLAN));
      await resumed.invoke(`resume legacy ${shape}`);
      const prompt = model.calls[0]?.systemPrompt;
      const blocks = Array.isArray(prompt) ? prompt : [];
      const text = promptText(prompt);
      assert(`${shape}: full base/project bytes survive exactly`, blocks[0] instanceof TextBlock && blocks[0].text === `BASE\n\n${LEGACY_PROJECT_RULES}`);
      assert(`${shape}: stale Darwin catalogue is removed`, !text.includes('name="stale"') && !text.includes('<skill name="stale">'));
      assert(`${shape}: literal tag mention inside project rules survives`, text.includes('literal <available-skills> tag here'));
      assert(`${shape}: literal opener in stale catalogue body is removed with that catalogue`, !text.includes('description includes literal <available-skills> text'));
      assert(`${shape}: literal opener in stale working-context body is removed with stale context`, !text.includes('literal-<working-context>-file'));
      assert(`${shape}: exactly one current working context remains`, blocks.filter((block) => block instanceof TextBlock && block.text.trim().startsWith('<working-context>')).length === 1 && text.includes('current-context'));

      assert(`${shape}: one current official catalogue remains`, blocks.filter((block) => block instanceof TextBlock && block.text.trim().startsWith('<available_skills>')).length === 1);
      assert(`${shape}: current official catalogue names the current skill`, text.includes('<name>current-skill</name>'));
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function ambiguousLegacySuffixRefused(): Promise<void> {
  header('official AgentSkills — ambiguous legacy suffix is refused unchanged');
  const ambiguous = [
    `BASE\n\n${LEGACY_PROJECT_RULES}`,
    [
      '<available-skills>',
      'Skills are instruction sets for specific tasks. When a request matches one,',
      'call the load_skill tool with its name to read the full instructions before',
      'you begin. Only the name and description are shown here.',
      'body without a proven adjacent working-context suffix',
      '</available-skills>',
    ].join('\n'),
  ].join('\n\n');
  const agent = new Agent({ model: new CaptureModel(), systemPrompt: ambiguous, printer: false });
  const before = agent.systemPrompt;
  assert('ambiguous historical shape is refused', !applyWorkingContext(agent, '<working-context>current</working-context>'));
  assert('refusal leaves ambiguous prompt unchanged', agent.systemPrompt === before);
}

async function activationAndBounds(): Promise<void> {
  header('official AgentSkills — compatibility activation and bounded resources');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-agent-skills-resources-'));
  const skillDir = path.join(root, 'bounded-skill');
  await mkdir(path.join(skillDir, 'references'), { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: bounded-skill\ndescription: Bound it.\n---\nOFFICIAL BODY\n');

  for (let index = 0; index < 25; index += 1) {
    await writeFile(path.join(skillDir, 'references', `${index}.md`), `${index}\n`);
  }

  const project = path.join(root, 'project');
  await mkdir(path.join(project, '.darwin', 'skills', 'bounded-skill'), { recursive: true });
  await writeFile(path.join(project, '.darwin', 'skills', 'bounded-skill', 'SKILL.md'), await readFile(path.join(skillDir, 'SKILL.md')));
  await mkdir(path.join(project, '.darwin', 'skills', 'bounded-skill', 'references'), { recursive: true });
  for (let index = 0; index < 25; index += 1) {
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
    // With Skill instances, official activation falls back from its per-Agent
    // WeakMap to the same base catalogue. Activated state is still written via
    // forwarded appState onto the original Agent, but this is not an identity proof.
    assert('guarded activation records canonical appState on the original Agent', plugin.getActivatedSkills(agent).join(',') === 'bounded-skill');

    assert('unknown skill remains recoverable and lists names', unknown.error?.includes('nope') === true && unknown.availableSkills?.includes('bounded-skill') === true);
    const defaultPlugin = await SkillsPlugin.load(project);
    const defaultAgent = new Agent({ model: new CaptureModel(), plugins: [defaultPlugin], printer: false });
    await defaultAgent.initialize();
    const defaultInstructions = await defaultPlugin.activate(defaultPlugin.find('bounded-skill')!);
    assert('the production default lists no more than 20 resource files', (defaultInstructions.match(/^  references\//gm) ?? []).length === 20);
    assert('the production default emits the official 20-file truncation marker', defaultInstructions.includes('... (truncated at 20 files)'));

    assert('production resource cap is explicit and finite', MAX_SKILL_RESOURCE_FILES === 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function resourceSafety(): Promise<void> {
  header('official AgentSkills — resource symlink and preflight safety');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-agent-skills-safety-'));
  const project = path.join(root, 'project');
  const directory = path.join(project, '.darwin', 'skills', 'safe-skill');
  const outside = path.join(root, 'outside');
  await mkdir(directory, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: safe-skill\ndescription: Safe.\n---\nSAFE BODY\n');
  await writeFile(path.join(outside, 'secret-name.txt'), 'secret\n');

  try {
    await symlink(outside, path.join(directory, 'references'));
    const plugin = await SkillsPlugin.load(project);
    const agent = new Agent({ model: new CaptureModel(), plugins: [plugin], printer: false });
    await agent.initialize();
    let symlinkError = '';
    try {
      await plugin.activate(plugin.find('safe-skill')!);
    } catch (error) {
      symlinkError = error instanceof Error ? error.message : String(error);
    }
    assert('resource symlink is refused before official traversal', symlinkError.includes('must not contain symbolic links'));
    assert('outside filenames are never returned', !symlinkError.includes('secret-name.txt'));

    await rm(path.join(directory, 'references'));
    await mkdir(path.join(directory, 'references'), { recursive: true });
    await Promise.all(Array.from({ length: MAX_SKILL_RESOURCE_PREFLIGHT_ENTRIES + 1 }, (_, index) =>
      writeFile(path.join(directory, 'references', `file-${index}.md`), 'x'),
    ));
    let broadError = '';
    try {
      await plugin.activate(plugin.find('safe-skill')!);
    } catch (error) {
      broadError = error instanceof Error ? error.message : String(error);
    }
    assert('broad resource tree stops at the preflight entry bound', broadError.includes(`${MAX_SKILL_RESOURCE_PREFLIGHT_ENTRIES}-entry safety preflight`));

    await rm(path.join(directory, 'references'), { recursive: true, force: true });
    await mkdir(path.join(directory, 'references'), { recursive: true });
    await writeFile(path.join(directory, 'references', 'inside.txt'), 'inside\n');
    let swapped = false;
    setResourceSafetyCheckpointForTest(async () => {
      swapped = true;
      await rm(path.join(directory, 'references'), { recursive: true, force: true });
      await symlink(outside, path.join(directory, 'references'));
    });
    let swappedResult = '';
    try {
      swappedResult = await plugin.activate(plugin.find('safe-skill')!);
    } finally {
      setResourceSafetyCheckpointForTest(undefined);
    }
    assert('the deterministic TOCTOU swap happened after preflight', swapped);
    assert('use-time guard suppresses a directory swapped to a symlink', !swappedResult.includes('Available resources:'));
    assert('TOCTOU swap returns no outside filename', !swappedResult.includes('secret-name.txt'));
  } finally {
    setResourceSafetyCheckpointForTest(undefined);
    await rm(root, { recursive: true, force: true });
  }
}

const pluginRoots = new Set<string>();

async function pluginFrom(skills: Skill[], requestedRoot?: string): Promise<SkillsPlugin> {
  // Build through the production catalogue by writing ordinary project skills.
  const root = requestedRoot ?? await mkdtemp(path.join(os.tmpdir(), 'darwin-agent-skills-plugin-'));
  pluginRoots.add(root);
  for (const skill of skills) {
    const directory = path.join(root, '.darwin', 'skills', skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.instructions}\n`);
  }
  return SkillsPlugin.load(root);
}

try {
  await promptAndResume();
  await legacyResume(false);
  await legacyResume(true);
  await ambiguousLegacySuffixRefused();
  await activationAndBounds();
  await resourceSafety();
} finally {
  await Promise.all([...pluginRoots].map((root) => rm(root, { recursive: true, force: true })));
}
report();
