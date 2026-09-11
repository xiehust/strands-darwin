/** Offline setup contracts: real loaders/runtime/pty, private files, no AWS or provider calls.
 * Run: pnpm tsx spike/verify-setup-agentcore-memory.ts [--dist]
 * --dist runs only relocated built-skill activation and npm's dry-run package manifest.
 * Scripted branch replies prove delivery/streaming, not arbitrary model compliance.
 * Preflight uses real config/doctor/readonly CLI and loopback SDK, never AWS.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent, type InvokableTool } from '@strands-agents/sdk';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath, loadConfig } from '../src/config.js';
import { parseAgentCoreConfig, scopeFor } from '../src/agentcore/config.js';
import { BUILTIN_COMMAND_NAMES, builtinCommandDescription, loadCustomCommands } from '../src/commands/custom-commands.js';
import { BUILTIN_SKILLS_DIR, REQUIRED_BUILTIN_SKILLS, scanSkills } from '../src/skills/loader.js';
import { SkillsPlugin, expandSkillCommand } from '../src/skills/plugin.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { formatHelpReport } from '../src/tui/help-format.js';
import { runHeadlessTurn } from '../src/headless.js';
import { runStructuredHeadlessTurn, StructuredHeadlessWriter } from '../src/headless-protocol.js';
import { CaptureModel } from './offline-model.js';
import { ownPrivateHome } from './shared.js';
import { startTui } from './tui-driver.js';
import { verifySetupPreflight } from './setup-memory-preflight.js';

const home = ownPrivateHome('setup-agentcore-memory');
const repo = path.resolve(import.meta.dirname, '..');
const root = path.join(home, 'unrelated-project');
const name = 'setup-agentcore-memory';
await mkdir(root);
await mkdir(path.dirname(configPath()), { recursive: true });
const raw = await readFile(path.join(BUILTIN_SKILLS_DIR, name, 'SKILL.md'), 'utf8');
const scan = await scanSkills(root);
const guide = scan.skills.find(skill => skill.name === name)!;
assert(guide);

if (!process.argv.includes('--dist')) {
// Pin safety-critical instructions as workflow content, separately from executable checks.
for (const terms of [
  ['entire guide', "user's language", 'never continue without it'],
  ['FIRST inspect `~/.darwin/config.json`', 'before asking actor/default questions', 'sensitive read even in plan mode', 'do not bypass denial'],
  ['missing config file', 'absent `agentCoreMemory` field', 'intentionally disabled `agentCoreMemory: false`', 'BLOCKED/NEEDS-REPAIR', 'NOT absent'],
  ['saved region, resource, actor and strategy IDs', 'never suggested argument overrides', 'darwin doctor', 'no network or files written'],
  ['Empty records are success', 'check-only', 'neither enables preferences nor applies/adopts', 'explicit `projectId`', 'legacy `cliPath`', 'no cleanup write'],
  ['Avoid displaying preference content', 'records.length', 'Preserve failure/nonzero status', 'unparseable output', 'not a new doctor subcommand'],
  ['Neither status alone nor doctor exit zero', 'strategy topology', 'No AWS CLI installation, STS/control-plane discovery', 'confirmation of the unchanged actor'],
  ['unrelated doctor MCP/skill warnings separately', 'command is not runnable', 'pending**, not success', 'do not reinstall'],
  ['无需重复设置', '**STOP** the bare setup workflow', 'no actor question, default confirmation', 'no config/resource edits or restart needed', 'extraction/write not tested'],
  ['explicit user request to reconfigure', 'original healthy result first', 'requested changes only'],
  ['SDK failure, no credentials, timeout, AccessDenied or wrong scope', 'generic SDK failure when diagnostics are redacted', 'never guess the hidden cause', 'TARGETED repair confirmation', 'no endless polling'],
  ['For missing/disabled setup, ask', 'For targeted repair/reconfiguration, ask only', 'both text and structured headless'],
  ['username / `actorId`', 'ask and STOP the current turn', 'explicit confirmation of reuse', 'never silently switch'],
  ['OS username, git, AWS ARN, email', 'never hardcode an actor', 'Group related missing decisions'],
  ['supplied arguments', '`yolo`', 'NOT consent', 'Arguments are proposed preferences', 'force-install'],
  ['headless', 'without reading stdin or guessing', 'pending status'],
  ['explicit confirmation BEFORE any mutation', '**current**', '**user-provided**', '**fallback**'],
  ['`us-west-2`', 'user-owned existing Memory', '`DarwinMemory`', 'one bounded startup cloud read', 'Service default'],
  ['`trajectory: false`', 'never override it', 'separate authorization'],
  ['@aws-sdk/client-bedrock-agentcore', 'do not npm-install', 'private global package', 'OS/architecture', 'sudo', '/dev/stdin'],
  ['sensitive', 'Preserve ALL unrelated', 'mode `0600`', 'Store no credentials', 'remove only legacy'],
  ['Omit `projectId`', 'lowercase, 1–64', 'current session\'s tool catalogue does not magically refresh'],
  ['Honor pagination', '10 pages/100 resources', 'full resource details', 'do not mutate another application'],
  ['one stable `clientToken`', 'After timeout, check resource state', 'both strategies are `ACTIVE`', '5 minutes/10 checks', 'background bash start/wait'],
  ['freshly verify lossless support', 'Defaults cannot bypass', 'without import/redeploy'],
  ['template shows defaults, not overrides', 'confirmed resource `name` and `eventExpiryDuration`', 'optional `encryptionKeyArn`', 'Never reset confirmed nondefault retention', 'namespace templates strictly unchanged'],
  ['Before issuing create-memory, validate the exact adapted request', '3 to 365 days', 'stop and explain rather than reverting'],
  ['Confirmed choices override all example defaults', '`upload` (including `off`)', '`preferences` (including `false`)', 'validate the exact merged config'],
  ['GetMemoryRecord', 'RetrieveMemoryRecords', 'CreateEvent', 'DeleteMemoryRecord', 'Do not add administrator', 'pricing', 'TTL is NOT long-term'],
  ['No test writes, history backfill', 'disposable scope', 'acceptance, not full extraction'],
  ['darwin cloud-memory status', '**local-only**', 'darwin cloud-memory preferences', 'SDK read-only connectivity'],
  ['`episodic_recall` with `intent`', '`reflection_recall` with `useCase`', 'never raw logs', 'NOT proof of ingestion'],
  ['without raw API errors or secrets', 'after three stop/report'],
  ['/cloud-memory inspect <record-id>', '/cloud-memory confirm <record-id> <hash> global', '/cloud-memory preview <token>', '/cloud-memory send <token> <preview-hash>', '/cloud-memory discard <token>'],
  ['Never seed preferences automatically', 'Hashes prove data integrity, not human consent', 'standalone CLI is read-only', 'Never fake human confirmation via bash, SDK calls, pty'],
  ['**USER goals**', '**TOOL evidence**', '**OTHER source/outcome/omissions**', 'excludes all assistant prose', 'not a confidentiality guarantee'],
  ['resource reused/created', 'confirmed actor and region', 'config fields changed', 'upload mode', '**unverified extraction**', '**pending**, not complete'],
]) for (const term of terms) assert(guide.instructions.includes(term), `guide missing: ${term}`);
const orderedSteps = ['Read and use this entire guide', 'FIRST inspect `~/.darwin/config.json`', '1. `darwin doctor`', '2. `darwin cloud-memory status`', '3. `darwin cloud-memory preferences`', '### Healthy stop', '**STOP** the bare setup workflow', '## 2. Only for setup', "ask for the user's chosen username", 'Present a proposed defaults table'];
let previousStep = -1;
for (const step of orderedSteps) {
  const index = guide.instructions.indexOf(step);
  assert(index > previousStep, `preflight order: ${step}`);
  previousStep = index;
}
const preflight = guide.instructions.split('## 2. Only for setup')[0]!;
assert(!/^(?:Ask for|Present a proposed defaults table)/m.test(preflight), 'no unconditional actor/default request before health check');
assert(Buffer.byteLength(raw) < 24_000, 'full guide stays reasonably bounded');
assert(!raw.includes('river-xie') && !raw.includes('arn:aws:'));
assert(!raw.includes('docs/') && !raw.includes('process.cwd'), 'guide has no repository dependency');
const examples = [...guide.instructions.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!));
assert.equal(examples.length, 2);
const [request, example] = examples;
assert.deepEqual(Object.keys(request).sort(), ['clientToken', 'eventExpiryDuration', 'memoryStrategies', 'name', 'namespaceKeys']);
assert.equal(request.eventExpiryDuration, 30);
assert.equal(request.name, 'DarwinMemory');
assert.deepEqual(request.namespaceKeys, [{ key: 'projectid' }]);
assert.equal(request.memoryStrategies.length, 2);
const episode = '/users/{actorId}/projects/{projectid}/strategy/{memoryStrategyId}/sessions/{sessionId}/';
const reflection = '/users/{actorId}/projects/{projectid}/strategy/{memoryStrategyId}/';
const preference = '/users/{actorId}/strategy/{memoryStrategyId}/preferences/';
assert.deepEqual(request.memoryStrategies, [
  { episodicMemoryStrategy: { name: 'DarwinEpisodes', namespaceTemplates: [episode], reflectionConfiguration: { namespaceTemplates: [reflection] } } },
  { userPreferenceMemoryStrategy: { name: 'DarwinPreferences', namespaceTemplates: [preference] } },
]);
assert.deepEqual(Object.keys(example), ['agentCoreMemory']);
assert.deepEqual(Object.keys(example.agentCoreMemory).sort(), ['actorId', 'enabled', 'episodicStrategyId', 'memoryId', 'preferenceStrategyId', 'preferences', 'region', 'timeoutMs', 'upload']);
assert.equal(example.agentCoreMemory.upload, 'manual');
assert.equal(example.agentCoreMemory.timeoutMs, 5000);
assert.equal(example.agentCoreMemory.preferences, true);
const config = parseAgentCoreConfig({ ...example.agentCoreMemory, memoryId: 'FixtureMemory-0123456789', episodicStrategyId: 'Episodes', preferenceStrategyId: 'Preferences', actorId: 'chosen-test-user' })!;
const scope = scopeFor(config, root);
const materialize = (template: string, strategy: string) => template.replace('{actorId}', config.actorId).replace('{projectid}', scope.projectId).replace('{memoryStrategyId}', strategy);
assert.equal(materialize(reflection, config.episodicStrategyId), scope.project);
assert.equal(materialize(episode, config.episodicStrategyId).replace('{sessionId}/', ''), scope.episodes);
assert.equal(materialize(preference, config.preferenceStrategyId), scope.preferences);
const baseConfig = { provider: 'bedrock', model: 'fake.offline-setup', region: 'us-west-2', promptCache: false, memory: false, contextOffload: false, trajectory: true };
await writeFile(configPath(), JSON.stringify({ ...baseConfig, agentCoreMemory: config }), { mode: 0o600 });
assert.deepEqual((await loadConfig(root)).agentCoreMemory, config, 'actual config loader accepts substituted guide schema');
// Confirmed deviations are data fixtures, not a provisioning implementation.
const chosenResource = { ...request, name: 'ChosenMemory', eventExpiryDuration: 60, encryptionKeyArn: 'arn:aws:kms:us-west-2:000000000000:key/synthetic-test-key' };
assert.equal(chosenResource.eventExpiryDuration, 60);
assert.equal(chosenResource.encryptionKeyArn.split(':')[2], 'kms');
assert.deepEqual(chosenResource.namespaceKeys, [{ key: 'projectid' }]);
assert.deepEqual(chosenResource.memoryStrategies, request.memoryStrategies, 'confirmed retention/encryption never widen namespaces');
const choices = { ...config, region: 'us-east-1', upload: 'off', preferences: false, timeoutMs: 8000 };
await writeFile(configPath(), JSON.stringify({ ...baseConfig, trajectory: false, agentCoreMemory: choices }));
assert.deepEqual((await loadConfig(root)).agentCoreMemory, choices, 'real loader retains off/false/nondefault timeout and region');
await writeFile(configPath(), JSON.stringify({ ...baseConfig, trajectory: false, agentCoreMemory: config }));
await assert.rejects(loadConfig(root), /trajectory/);
await writeFile(configPath(), JSON.stringify(baseConfig));
assert.equal((await stat(configPath())).mode & 0o777, 0o600);
await verifySetupPreflight({ home, root, repo, baseConfig, config, instructions: guide.instructions });
assert(REQUIRED_BUILTIN_SKILLS.includes(name));
assert.equal(BUILTIN_COMMAND_NAMES.filter(item => item === name).length, 1);
assert(MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length);
assert(formatHelpReport().includes(`/${name} — ${builtinCommandDescription(name)}`));

for (const base of [root, home]) for (const layer of ['.darwin', '.agents']) {
  const dir = path.join(base, layer, 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), `---\nname: SETUP-AGENTCORE-MEMORY\ndescription: shadow\n---\nSHADOW\n`);
  const commands = path.join(base, layer, 'commands');
  await mkdir(commands, { recursive: true });
  await writeFile(path.join(commands, `${name.toUpperCase()}.md`), 'SHADOW');
}
const layered = await scanSkills(root);
assert.equal(layered.skills.filter(skill => skill.name.toLowerCase() === name).length, 1);
assert.equal(layered.skills.find(skill => skill.name === name)?.path, guide.path);
assert.equal(layered.problems.filter(problem => problem.reason.includes(`reserved by built-in skill ${name}`)).length, 4);
const commands = await loadCustomCommands(root, layered.skills.map(skill => skill.name));
assert(!commands.commands.some(command => command.name.toLowerCase() === name));
assert.equal(commands.problems.filter(problem => problem.reason.includes(`built-in command /${name}`)).length, 4);
const broken = path.join(home, 'broken-bundle');
await cp(BUILTIN_SKILLS_DIR, broken, { recursive: true });
await rm(path.join(broken, name), { recursive: true });
await assert.rejects(scanSkills(root, { builtinSkillsDir: broken }), /Required built-in setup-agentcore-memory/);
await mkdir(path.join(broken, name));
for (const bad of ['---\nname: setup-agentcore-memory\n---\nbody', '---\nname: setup-agentcore-memory\ndescription: setup\n---\n']) {
  await writeFile(path.join(broken, name, 'SKILL.md'), bad);
  await assert.rejects(scanSkills(root, { builtinSkillsDir: broken }), /Invalid built-in skill.*setup-agentcore-memory/);
}
const plugin = await SkillsPlugin.load(root);
const skillAgent = new Agent({ model: new CaptureModel(), plugins: [plugin], printer: false });
await skillAgent.initialize();
const activation = await expandSkillCommand(plugin, `/${name}`);
assert(activation?.message.includes(guide.instructions));
assert(plugin.getActivatedSkills(skillAgent).includes(name));
const loadTool = skillAgent.tools.find(tool => tool.name === 'load_skill')!;
assert('invoke' in loadTool);
const loaded = await (loadTool as InvokableTool<{ name: string }, unknown>).invoke({ name }, { agent: skillAgent, invocationState: {}, toolUse: { name: 'load_skill', toolUseId: 'setup-load', input: { name } }, cancelSignal: new AbortController().signal, interrupt: () => { throw new Error('unexpected interrupt'); } });
assert(JSON.stringify(loaded).includes('ask and STOP the current turn'));
// A discovered optional skill whose root disappears exercises the real activation guard.
const vanishing = path.join(root, '.darwin', 'skills', 'vanishing');
await mkdir(vanishing);
await writeFile(path.join(vanishing, 'SKILL.md'), '---\nname: vanishing\ndescription: fixture\n---\nbody');
const guarded = await SkillsPlugin.load(root);
const guardedAgent = new Agent({ model: new CaptureModel(), plugins: [guarded], printer: false });
await guardedAgent.initialize();
await rm(vanishing, { recursive: true });
await assert.rejects(expandSkillCommand(guarded, '/vanishing'));

async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(target));
    else if (entry.isFile()) files[target] = (await readFile(target)).toString('base64');
  }
  return files;
}
const question = 'Guided setup is pending. What username / actorId should I use? Please confirm the proposed defaults before any changes.';
const model = new CaptureModel(question);
setRuntimeModelFactoryForTest(async () => model);
let gateCalls = 0;
const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => { gateCalls++; return { allowed: false }; } });
let trajectoryFile: string | undefined;
try {
  const before = await snapshot(home);
  const bare = await runtime.expandSlashCommand(`/${name}`);
  assert(bare?.kind === 'skill');
  assert(bare.message.includes(guide.instructions));
  const args = 'actorId=chosen-test-user  region=us-east-1\nforce-install';
  const withArgs = await runtime.expandSlashCommand(` /SETUP-AGENTCORE-MEMORY\t${args} `);
  assert(withArgs?.kind === 'skill' && withArgs.message.endsWith(args));
  assert(withArgs.message.includes('Arguments are proposed preferences, not authorization'));
  for (const input of [`/${name}-other`, `/${name}x`, `please /${name}`, 'setup-agentcore-memory']) assert.equal(await runtime.expandSlashCommand(input), null);
  assert.equal((await runtime.expandSlashCommand('/init'))?.kind, 'init');
  assert.equal((await runtime.expandSlashCommand('/workflow inspect files'))?.kind, 'workflow');
  assert.deepEqual(await snapshot(home), before, 'expansion writes no files/config/session data');
  assert.equal(model.calls.length, 0);
  assert.equal(gateCalls, 0);
  const events = [];
  for await (const event of runtime.send(bare.message, `/${name}`)) events.push(event);
  assert.equal(model.calls.length, 1);
  const call = model.calls[0]!;
  const prompt = call.messages.at(-1)?.content.map(block => block.type === 'textBlock' ? block.text : '').join('');
  assert.equal(prompt, bare.message);
  const system = JSON.stringify(call.systemPrompt);
  assert.equal((system.match(/<name>setup-agentcore-memory<\/name>/g) ?? []).length, 1);
  assert(!system.includes(guide.instructions), 'ambient catalogue does not inline the guide');
  assert(!events.some(event => event.type === 'beforeToolCallEvent'));
  assert(JSON.stringify(events).includes(question));
  assert.equal(gateCalls, 0);
  assert.equal(await runHeadlessTurn(runtime, `/${name}`, () => {}), question);
  const structured = await runStructuredHeadlessTurn(runtime, `/${name} use defaults`, new StructuredHeadlessWriter('json', () => {}), () => 'unexpected tool');
  assert.equal(structured.reply, question);
  assert.equal(model.calls.length, 3, 'ordinary text/structured headless each makes one question turn');
  for (const request of model.calls.slice(1)) {
    const text = request.messages.at(-1)?.content.map(block => block.type === 'textBlock' ? block.text : '').join('') ?? '';
    assert(text.includes(guide.instructions), 'both headless drivers deliver the full guide');
  }
  trajectoryFile = runtime.info.trajectoryFile;
} finally {
  await runtime.shutdown();
  setRuntimeModelFactoryForTest(undefined);
}
assert(trajectoryFile);
const trajectory = await readFile(trajectoryFile, 'utf8');
const inputs = trajectory.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.type === 'userInput');
assert.deepEqual(inputs.map(record => record.text), [`/${name}`, `/${name}`, `/${name} use defaults`]);
assert(!trajectory.includes('# Set up AgentCore Memory'), 'expanded guide is not literal trajectory input');
assert.equal(await readFile(configPath(), 'utf8'), JSON.stringify(baseConfig));

await mkdir(vanishing);
await writeFile(path.join(vanishing, 'SKILL.md'), '---\nname: vanishing\ndescription: fixture\n---\nbody');
const tui = startTui({ cwd: root, entry: path.join(repo, 'spike/setup-memory-tui-fixture.ts'), cols: 140, rows: 60 });
try {
  await tui.waitFor('you>', { timeoutMs: 30_000, settleMs: 200 });
  tui.send('/setup-agentcore');
  await tui.waitFor(`❯ /${name} — ${builtinCommandDescription(name)}`, { timeoutMs: 10_000, settleMs: 200 });
  const menu = tui.frame.slice(tui.frame.lastIndexOf('commands ('));
  assert.equal((menu.match(/\/setup-agentcore-memory —/g) ?? []).length, 1, 'no duplicate built-in/skill row');
  const clearedAt = tui.mark();
  tui.send('\u0015'); // clear draft; wait so this key cannot batch with the next text
  await tui.waitUntil(() => !tui.frame.includes('commands (') && !tui.frame.includes('you> /setup-agentcore'), { timeoutMs: 10_000, from: clearedAt, settleMs: 200 });
  tui.submit('/vanishing');
  await tui.waitFor('prompt not sent', { timeoutMs: 10_000, settleMs: 200 });
  assert(!tui.screen.includes('Setup pending:'), 'failed activation never reaches the model');
  assert(tui.frame.includes('you> /vanishing'), 'failed immediate prompt remains editable');
  tui.send('\u0015');
  await tui.waitUntil(() => !tui.frame.includes('you> /vanishing'), { timeoutMs: 10_000, settleMs: 200 });
  tui.submit('!sleep 2');
  await tui.waitFor('running ! command…', { timeoutMs: 10_000, settleMs: 100 });
  const queuedAt = tui.mark();
  tui.submit(`/${name}`);
  await tui.waitFor('queued', { timeoutMs: 10_000, from: queuedAt, settleMs: 100 });
  assert(!tui.screen.slice(queuedAt).includes(`loaded skill "${name}"`), 'busy setup not expanded mid-turn');
  await tui.waitFor(`loaded skill "${name}"`, { timeoutMs: 15_000, from: queuedAt });
  await tui.waitFor('Setup pending:', { timeoutMs: 15_000, from: queuedAt, settleMs: 300 });
  tui.submit('/exit');
  assert.equal(await tui.exitedWithin(10_000), 0);
  const calls = JSON.parse(await readFile(path.join(root, 'captured-model.json'), 'utf8'));
  assert.equal(calls.length, 1, 'only queued setup reached the offline model');
  assert(JSON.stringify(calls).includes('ask and STOP the current turn'));
  assert.equal(await readFile(configPath(), 'utf8'), JSON.stringify(baseConfig));
} finally { tui.kill(); }
for (const file of ['README.md', 'README.zh-CN.md', 'docs/user-guide/agentcore-memory.md', 'docs/user-guide/agentcore-memory.zh-CN.md', 'docs/user-guide/reference.md', 'docs/user-guide/reference.zh-CN.md']) {
  const doc = await readFile(path.join(repo, file), 'utf8');
  for (const term of ['/setup-agentcore-memory', '~/.darwin/config.json', 'darwin doctor', 'darwin cloud-memory status', 'darwin cloud-memory preferences']) assert(doc.includes(term), `${file} existing-first discovery: ${term}`);
}
assert((await stat(path.join(repo, 'AGENTS.md'))).size <= 32768);
}

if (process.argv.includes('--dist')) {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
  assert.equal(packed.status, 0, packed.stderr);
  const entries = JSON.parse(packed.stdout)[0].files.map((file: { path: string }) => file.path) as string[];
  assert(entries.includes(`dist/src/skills/builtin/${name}/SKILL.md`));
  assert(!entries.some(file => file.startsWith('docs/')));
  assert.equal(await readFile(path.join(repo, 'dist/src/skills/builtin', name, 'SKILL.md'), 'utf8'), raw);
  const relocated = path.join(home, 'relocated-package');
  await mkdir(relocated);
  await cp(path.join(repo, 'dist/src'), path.join(relocated, 'src'), { recursive: true });
  await writeFile(path.join(relocated, 'package.json'), '{"type":"module"}');
  await symlink(path.join(repo, 'node_modules'), path.join(relocated, 'node_modules'), 'dir');
  const builtLoader = await import(pathToFileURL(path.join(relocated, 'src/skills/loader.js')).href) as typeof import('../src/skills/loader.js');
  const builtPlugin = await import(pathToFileURL(path.join(relocated, 'src/skills/plugin.js')).href) as typeof import('../src/skills/plugin.js');
  const builtScan = await builtLoader.scanSkills(root);
  assert.equal(builtScan.skills.find(skill => skill.name === name)?.instructions, guide.instructions);
  const installed = await builtPlugin.SkillsPlugin.load(root);
  const agent = new Agent({ model: new CaptureModel(), plugins: [installed], printer: false });
  await agent.initialize();
  const expanded = await builtPlugin.expandSkillCommand(installed, `/${name}`);
  assert(expanded && expanded.message.includes(guide.instructions));
  assert(expanded.skill.path?.startsWith(relocated));
  console.log('relocated dist activation and npm dry-run footprint passed');
} else {
  console.log('setup-agentcore-memory: all offline contracts passed');
}
