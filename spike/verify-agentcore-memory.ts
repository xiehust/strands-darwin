/** Offline real-files, SDK constructors, actual runtime/gates and CLI subprocess proofs.
 * No AWS requests. The installed AWS CLI skeleton/service model is checked locally.
 * Isolates HOME; generated events, credential markers and model responses are synthetic.
 */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
import { chmod, mkdir, readFile, writeFile, readdir, symlink, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { watch } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Agent, Model, BeforeToolCallEvent, AfterToolCallEvent, ToolUseBlock, ToolResultBlock, JsonBlock, TextBlock, ContentBlockEvent, AgentResultEvent, AgentResult, Message, ImageBlock, type BaseModelConfig, type ModelStreamEvent } from '@strands-agents/sdk';
import { CLOUD_CLOSE_TIMEOUT_MS, CloudMemory as ReadOnlyCloudMemory } from '../src/agentcore/controller.js';
// Explicit test-side user submission; production defaults remain read-only.
class CloudMemory extends ReadOnlyCloudMemory {
  override command(input: string, authority: 'read' | 'user' = 'user') { return super.command(input, authority); }
}
import { MemoryCli } from '../src/agentcore/transport.js';
import { digest, parseAgentCoreConfig, scopeFor, type AgentCoreConfig } from '../src/agentcore/config.js';
import { parseMemoryXml, validateRecord } from '../src/agentcore/records.js';
import { cloudDirectory, readState, setCloudStateObserverForTest, stateNames, withStateLock, writeState } from '../src/agentcore/state.js';
import { publicProse } from '../src/agentcore/projection.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath, loadConfig, permissionRulesPath } from '../src/config.js';
import { classify } from '../src/agent/permission.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
import { isSensitiveDarwinPath } from '../src/paths.js';
import { applyWorkingContext } from '../src/agent/working-context.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
const home = ownPrivateHome('agentcore'); const root = path.join(home, 'project'); await mkdir(root);
const fixture = fileURLToPath(new URL('./agentcore-cli-fixture.cjs', import.meta.url)); await chmod(fixture, 0o755);
const config = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'opaque-user', episodicStrategyId: 'episodes-0123456789', preferenceStrategyId: 'preferences-0123456789', cliPath: fixture, preferences: false, upload: 'manual', timeoutMs: 1000 })!;
async function control(value: object) { await writeFile(path.join(home, 'fixture-control.json'), JSON.stringify(value)); }
async function calls(): Promise<any[]> { try { return (await readFile(path.join(home, 'fixture-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
async function rejects(label: string, action: () => unknown | Promise<unknown>) { let caught = false; try { await action(); } catch { caught = true; } assert(label, caught); }
const id = 'record-' + 'a'.repeat(40);
const scope = scopeFor(config, root);
function preferenceJson(preference: string, pretty = false) { return JSON.stringify([{ language: 'English', context: 'Communication across projects', preference, categories: ['communication'] }], null, pretty ? 2 : undefined); }
function record(kind: 'preference' | 'episode' | 'reflection', overrides = {}) {
  return { memoryRecordId: id, memoryStrategyId: kind === 'preference' ? config.preferenceStrategyId : config.episodicStrategyId,
    namespaces: [kind === 'preference' ? scope.preferences : kind === 'reflection' ? scope.project : `${scope.episodes}session-test/`], createdAt: '2026-01-01T00:00:00Z',
    content: { text: kind === 'preference' ? preferenceJson('Use concise replies in all projects.') : kind === 'episode' ? '<episode><intent>Fix tests</intent><assessment>No</assessment><justification>Exit 1</justification><turns><turn><action>Run tests</action></turn><turn><action>Fix implementation</action></turn></turns></episode>' : '<reflection><use_cases>Failing tests</use_cases><hints>Check exit evidence</hints><confidence>0.8</confidence></reflection>' }, ...overrides };
}
header('AgentCore config, scope, XML and transport');
assert('disabled omitted and false have no config', parseAgentCoreConfig(undefined) === undefined && parseAgentCoreConfig(false) === undefined);
for (const bad of [{ ...config, actorId: '../other' }, { ...config, projectId: 'UpperCase' }, { ...config, upload: 'auto' }, { ...config, namespace: '/' }, { ...config, episodicStrategyId: config.preferenceStrategyId }]) await rejects('invalid host configuration fails closed', () => parseAgentCoreConfig(bad));
assert('project deterministic and isolated; preferences shared by actor', scopeFor(config, root).project === scope.project && scopeFor(config, root + '-other').project !== scope.project && scopeFor(config, root + '-other').preferences === scope.preferences);
assert('opaque actor not inferred from credentials', !scope.preferences.includes('AWS') && scopeFor({ ...config, actorId: 'other' }, root).preferences !== scope.preferences);
const episode = validateRecord(record('episode'), 'episode', config, root);
assert('XML keeps evidence, failed outcome and action order', JSON.stringify(episode).includes('Exit 1') && JSON.stringify(episode).indexOf('Run tests') < JSON.stringify(episode).indexOf('Fix implementation'));
assert('reflection warning distinguishes confidence', validateRecord(record('reflection'), 'reflection', config, root).warning.includes('not correctness probability'));
for (const xml of ['<!DOCTYPE x><episode/>', '<x a="b"/>', '<x>&unknown;</x>', '<x></y>', '<x>'.repeat(20), '<x>&#0;</x>']) await rejects('unsafe XML refused', () => parseMemoryXml(xml));
for (const bad of [{ namespaces: [scope.project + 'other/'] }, { namespaces: [scope.preferences, '/users/other/'] }, { memoryStrategyId: 'wrong' }, { metadata: { actorId: { stringValue: 'other' } } }, { metadata: { fakeProof: { verified: true } } }]) await rejects('scope and metadata fail closed', () => validateRecord(record('preference', bad), 'preference', config, root));
await control({ records: [record('episode')] }); const memory = new CloudMemory(config, root, 'session-test');
const recalled = await memory.recall('episode', 'Fix failing tests; $(touch injected)', 2);
assert('no shell expansion and bounded structured recall', recalled.records.length === 1 && !(await readdir(root)).includes('injected'));
const queryCall = (await calls()).at(-1);
assert('verified retrieval fields and host strategy/scope', queryCall.input.searchCriteria.searchQuery.includes('Fix failing') && queryCall.input.searchCriteria.memoryStrategyId === config.episodicStrategyId && queryCall.input.namespacePath === scope.episodes && !queryCall.args.join(' ').includes('Fix failing'));
await control({ mode: 'hang' }); await rejects('process timeout', () => new MemoryCli({ ...config, timeoutMs: 100 }).call('get-memory-record', {}));
const abort = new AbortController(); const cancelled = new MemoryCli(config).call('get-memory-record', {}, abort.signal); setTimeout(() => abort.abort(), 50); await rejects('process abort', () => cancelled);
await control({ mode: 'large' }); await rejects('bounded stdout', () => new MemoryCli(config).call('get-memory-record', {}));
await rejects('missing CLI', () => new MemoryCli({ ...config, cliPath: '/nonexistent/agentcore-cli' }).call('get-memory-record', {}));
await control({ legacy: true }); await rejects('CLI lacking namespace variables never uploads', () => new MemoryCli(config).requireExtraction());
assert('approval/outbox paths are sensitive policy', isSensitiveDarwinPath(root, path.join(cloudDirectory(config), `${id}.json`)));
// The installed skeleton is an offline schema capability check; no credentials or resource call.
try { await new MemoryCli({ ...config, cliPath: '/usr/local/bin/aws', timeoutMs: 10000 }).requireExtraction(); console.log('Installed CLI supports extractionConfig'); }
catch (error) { assert('installed CLI absence/old schema has actionable refusal', String(error).includes('extractionConfig') || String(error).includes('unavailable')); }

header('Explicit preference proof and immediate invalidation');
await control({ records: [record('preference')] });
const preferences = new CloudMemory({ ...config, preferences: true }, root, 'session-pref'); await preferences.startup();
assert('generated preference is never automatically trusted', await preferences.context() === '');
const hash = validateRecord(record('preference'), 'preference', config, root).hash;
assert('confirmation without inspection refused', (await preferences.command(`confirm ${id} ${hash} global`)).includes('refused'));
assert('inspection shows complete content and hash', (await preferences.command(`inspect ${id}`)).includes(hash));
assert('user visible adoption succeeds', (await preferences.command(`confirm ${id} ${hash} global`)).includes('explicitly adopted'));
assert('approved context tagged untrusted', (await preferences.context()).includes('Untrusted contextual data'));
const crossProject = new CloudMemory({ ...config, preferences: true }, root + '-other', 'session-other'); await crossProject.startup();
assert('adopted user preference crosses projects', (await crossProject.context()).includes('concise'));
await preferences.command(`forget ${id}`);
assert('forget immediate across live controllers', await preferences.context() === '' && await crossProject.context() === '');
await preferences.command(`inspect ${id}`); await preferences.command(`confirm ${id} ${hash} global`);
await control({ records: [record('preference', { content: { text: preferenceJson('Changed preference') } })] });
await preferences.command('preferences'); assert('cloud content edits invalidate approval on explicit refresh', await preferences.context() === '');
await control({ records: [record('preference', { namespaces: ['/users/wrong/'] })] });
const beforeDelete = (await calls()).length; await preferences.command(`delete ${id} cloud`);
assert('wrong-scope delete never invokes DeleteMemoryRecord', !(await calls()).slice(beforeDelete).some(call => call.args[1] === 'delete-memory-record'));
await control({ records: [record('preference')] }); await preferences.command(`delete ${id} cloud`);
assert('only explicit delete performs cloud delete', (await calls()).at(-1).args[1] === 'delete-memory-record');
header('Durable new-turn outbox and preview authorization');
assert('privacy omissions reject dumps and secrets', publicProse('secret: abc') === undefined && publicProse('read /home/user/file') === undefined && publicProse('x'.repeat(1001)) === undefined);
const file = path.join(home, 'trajectory.jsonl'); const uploader = new CloudMemory(config, root, 'session-upload');
const recorder = new TrajectoryRecorder({ file, run: { session: 'session-upload', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'offline', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => uploader.settle(settlement, file) });
const wireAgent = new Agent({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
const turn = recorder.beginTurn('Use concise replies across projects. Fix the synthetic test failure.'); await turn?.inputDurable();
turn?.record(new ContentBlockEvent({ agent: wireAgent, invocationState: {}, contentBlock: new TextBlock('Public synthetic statement before any tool.') }));
const testUse = new ToolUseBlock({ name: 'bash', toolUseId: 'test', input: { mode: 'execute', command: 'pnpm test' } });
turn?.record(new BeforeToolCallEvent({ agent: wireAgent, invocationState: {}, tool: undefined, toolUse: testUse }));
turn?.record(new AfterToolCallEvent({ agent: wireAgent, invocationState: {}, tool: undefined, toolUse: testUse, result: new ToolResultBlock({ toolUseId: 'test', status: 'error', content: [new JsonBlock({ json: { exitCode: 1, output: 'SECRET LOG DUMP' } })] }) }));
turn?.failed(new Error('synthetic failure')); turn?.end(); await recorder.close();
const pending = await uploader.command('pending'); const token = pending.split(' ')[0]!;
assert('new durable failed turn queued without network', /^[a-f0-9]{64}$/.test(token) && pending.includes('pending; not uploaded'));
const beforeSend = (await calls()).length;
assert('send without preview authorization refused', (await uploader.command(`send ${token} ${'0'.repeat(64)}`)).includes('Preview absent'));
assert('no unauthorized subprocess', (await calls()).length === beforeSend);
const preview = await uploader.command(`preview ${token}`); const previewHash = preview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)?.[1]!;
assert('preview retains failure, command and exit evidence, excludes logs', !preview.includes('Public synthetic statement') && preview.includes('failed') && preview.includes('pnpm test') && preview.includes('exitCode') && !preview.includes('SECRET LOG DUMP'));
await control({});
assert('manual upload acknowledges event not episode', (await uploader.command(`send ${token} ${previewHash}`)).includes('generation is asynchronous and NOT verified'));
const createCall = (await calls()).at(-1);
assert('CreateEvent scope, projectid and token fixed', createCall.input.actorId === config.actorId && createCall.input.sessionId === 'session-upload' && createCall.input.clientToken === token && createCall.input.extractionConfig.namespaceVariables.projectid === scope.projectId);
const restarted = new CloudMemory(config, root, 'different-session'); const count = (await calls()).length;
assert('restart does not duplicate accepted upload', (await restarted.command(`send ${token} ${previewHash}`)).includes('already accepted') && (await calls()).length === count);
const otherActor = new CloudMemory({ ...config, actorId: 'different' }, root, 'session');
assert('actor cannot inspect another outbox', (await otherActor.command(`preview ${token}`)).includes('refused'));
await uploader.close(); await restarted.close(); await preferences.close(); await crossProject.close();
header('Retry tokens, ordered turns, memory exclusion and state corruption');
const retryRoot = path.join(home, 'retry-project'); await mkdir(retryRoot);
const retry = new CloudMemory(config, retryRoot, 'session-retry'); const retryFile = path.join(home, 'retry-trajectory.jsonl');
const retryRecorder = new TrajectoryRecorder({ file: retryFile, run: { session: 'session-retry', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'none', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => retry.settle(settlement, retryFile) });
for (const stopReason of ['cancelled', 'endTurn'] as const) {
  const next = retryRecorder.beginTurn('Synthetic public goal'); await next?.inputDurable();
  const use = new ToolUseBlock({ name: 'memory_recall', toolUseId: 'private', input: { query: 'private' } });
  next?.record(new BeforeToolCallEvent({ agent: wireAgent, invocationState: {}, tool: undefined, toolUse: use }));
  next?.record(new AfterToolCallEvent({ agent: wireAgent, invocationState: {}, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: 'private', status: 'success', content: [new TextBlock('RETRIEVED PRIVATE MEMORY')] }) }));
  next?.record(new ContentBlockEvent({ agent: wireAgent, invocationState: {}, contentBlock: new TextBlock('PARAPHRASED MEMORY') }));
  next?.record(new AgentResultEvent({ agent: wireAgent, invocationState: {}, result: new AgentResult({ invocationState: {}, stopReason, lastMessage: new Message({ role: 'assistant', content: [] }) }) })); next?.end();
}
await retryRecorder.close();
const retryTokens = (await retry.command('pending')).split('\n').map(row => row.split(' ')[0]!);
const previews = await Promise.all(retryTokens.map(token => retry.command(`preview ${token}`)));
const firstIndex = previews.findIndex(text => text.includes('cancelled')); const firstToken = retryTokens[firstIndex]!; const firstPreview = previews[firstIndex]!;
const firstHash = firstPreview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)![1]!;
const laterIndex = 1 - firstIndex; const laterHash = previews[laterIndex]!.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)![1]!;
assert('memory output and paraphrases omitted', !previews.join('').includes('PRIVATE MEMORY') && !previews.join('').includes('PARAPHRASED MEMORY'));
assert('cancel and closed are not task success', firstPreview.includes('cancelled') && previews[laterIndex]!.includes('not inferred'));
assert('session turn order enforced', (await retry.command(`send ${retryTokens[laterIndex]} ${laterHash}`)).includes('earlier pending'));
await control({}); await retry.cli.requireExtraction(); await control({ mode: 'error' });
for (let attempt = 0; attempt < 3; attempt++) assert('finite manual failure is reported', (await retry.command(`send ${firstToken} ${firstHash}`)).includes('CLI failed'));
const beforeCap = (await calls()).length;
assert('fourth attempt refused without subprocess', (await retry.command(`send ${firstToken} ${firstHash}`)).includes('retry cap') && (await calls()).length === beforeCap);
const attempts = (await calls()).filter(call => call.args[1] === 'create-event' && call.input?.clientToken === firstToken);
assert('all retry bodies and tokens are byte-identical', attempts.length === 3 && attempts.every(call => JSON.stringify(call.input) === JSON.stringify(attempts[0].input)));
const symbolic = path.join(home, 'state-link'); await symlink(root, symbolic);
await rejects('symlinked cloud state refused', () => writeState(path.join(symbolic, 'approval.json'), {}));
await retry.close();

header('Actual runtime startup, permission gate, disabled and lifecycle');
class ScriptedModel extends Model<BaseModelConfig> {
  calls = 0; private config: BaseModelConfig = { modelId: 'offline', contextWindowLimit: 32000 };
  constructor(readonly toolName?: string, readonly toolInput: object = { intent: 'Fix tests', limit: 2 }, readonly answer = 'Synthetic public answer.') { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls++;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.toolName && !messages.some(message => message.content.some(block => block.type === 'toolResultBlock'))) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: this.toolName, toolUseId: 'recall-test' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.toolInput) } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }; return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.answer } };
    yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}
await mkdir(path.dirname(configPath(root)), { recursive: true });
async function configure(cloud?: AgentCoreConfig, trajectory = true) { await writeFile(configPath(root), JSON.stringify({ provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', promptCache: false, trajectory, agentCoreMemory: cloud })); }
async function runtime(model: ScriptedModel, mode: 'plan' | 'default' | 'yolo' = 'default', allow = false) {
  setRuntimeModelFactoryForTest(async () => model);
  return AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: mode, permissionBridge: async () => ({ allowed: allow }) });
}
async function drain(runtime: AgentRuntime) { for await (const _event of runtime.send('Fix the synthetic test.')) {} }
await configure(config, false); await rejects('upload requires trajectory', () => loadConfig(root));
await configure(); const disabled = await runtime(new ScriptedModel()); const disabledAgent = (disabled as unknown as { agent: Agent }).agent;
const beforeDisabled = (await calls()).length; await drain(disabled);
assert('disabled has no cloud tools, network or changed local memory contract', !disabledAgent.tools.some(tool => tool.name === 'episodic_recall') && disabledAgent.tools.some(tool => tool.name === 'memory_recall') && (await calls()).length === beforeDisabled);
assert('disabled command is useful', (await disabled.manageCloudMemory('status')).includes('disabled')); await disabled.shutdown();
await configure({ ...config, upload: 'off' }); await control({ records: [record('episode')] });
for (const mode of ['default', 'plan'] as const) {
  const gated = await runtime(new ScriptedModel('episodic_recall'), mode); const before = (await calls()).length;
  await drain(gated); assert(`${mode} gate denies before CLI invocation`, (await calls()).length === before); await gated.shutdown();
}
assert('network recall is not statically safe', classify('episodic_recall', { intent: 'test' }).kind === 'execute');
await mkdir(path.dirname(permissionRulesPath(root)), { recursive: true });
await writeFile(permissionRulesPath(root), JSON.stringify({ deny: ['episodic_recall'] }));
const denied = await runtime(new ScriptedModel('episodic_recall'), 'yolo', true); const beforeDeny = (await calls()).length;
await drain(denied); assert('explicit deny beats yolo before CLI', (await calls()).length === beforeDeny); await denied.shutdown();
await writeFile(permissionRulesPath(root), JSON.stringify({ deny: [] }));
const allowed = await runtime(new ScriptedModel('episodic_recall'), 'default', true); const beforeAllowed = (await calls()).length;
await drain(allowed); assert('ordinary approved recall reaches real subprocess', (await calls()).length === beforeAllowed + 1);
const childTools = (allowed as unknown as { subagents: { options: { tools: { name: string }[] } } }).subagents.options.tools;
assert('both cloud tools excluded from actual child catalogue', !childTools.some(tool => ['episodic_recall', 'reflection_recall'].includes(tool.name)));
const successor = await allowed.startNewSession(); assert('clear rebuilds cloud scope and session', successor.info.sessionId !== allowed.info.sessionId && successor.cloudMemoryStatus.includes('enabled')); await successor.shutdown();
await configure({ ...config, preferences: true, upload: 'off' }); await control({ records: [record('preference')] });
const preflight = await runtime(new ScriptedModel());
await preflight.manageCloudMemory(`inspect ${id}`); await preflight.manageCloudMemory(`confirm ${id} ${hash} global`);
const beforeStartup = (await calls()).length; await drain(preflight);
const liveAgent = (preflight as unknown as { agent: Agent }).agent;
assert('startup preference retrieval happens once before invocation', (await calls()).length === beforeStartup + 1);
assert('real runtime prompt carries bounded adopted context', JSON.stringify(liveAgent.systemPrompt).includes('cloud-preference-data'));
await preflight.manageCloudMemory(`forget ${id}`);
assert('forget removes live prompt context immediately', !JSON.stringify(liveAgent.systemPrompt).includes('cloud-preference-data'));
const checkpoint = (await preflight.listRewindCheckpoints()).checkpoints[0]!;
const rewound = await preflight.startRewind(checkpoint);
assert('rewind has fresh cloud controller and no stale adopted block', rewound.info.sessionId !== preflight.info.sessionId && !JSON.stringify((rewound as unknown as { agent: Agent }).agent.systemPrompt).includes('cloud-preference-data')); await rewound.shutdown();
await control({ mode: 'hang' }); const cancelModel = new ScriptedModel(); const cancelling = await runtime(cancelModel);
const running = drain(cancelling); setTimeout(() => cancelling.cancel(), 50); await rejects('startup cancellation prevents model invocation', () => running);
assert('cancelled startup made no model call', cancelModel.calls === 0); await cancelling.shutdown();
await configure({ ...config, preferences: true, cliPath: '/nonexistent/agentcore-cli', upload: 'off' });
const degradedModel = new ScriptedModel(); const degraded = await runtime(degradedModel); await drain(degraded);
assert('missing preference CLI degrades open without blocking task', degradedModel.calls === 1 && degraded.cloudMemoryStatus.includes('degraded'));
await degraded.shutdown();
const noStateRoot = path.join(home, 'disabled-project'); await mkdir(noStateRoot); await configure();
const noState = await AgentRuntime.create({ projectRoot: noStateRoot, session: { kind: 'new' }, permissionBridge: async () => ({ allowed: false }) }); await drain(noState); await noState.shutdown();
let exists = true; try { await stat(cloudDirectory(config, noStateRoot)); } catch { exists = false; }
assert('disabled creates no project cloud state', !exists);
setRuntimeModelFactoryForTest(undefined);
const cliFile = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cliDisabled = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cliFile, 'cloud-memory', 'status'], { cwd: root, encoding: 'utf8', timeout: 10000 });
assert('headless cloud command is local when disabled', cliDisabled.status === 0 && cliDisabled.stdout.includes('AgentCore: disabled'));
await configure({ ...config, upload: 'off' });
const beforeCli = (await calls()).length;
const cliStatus = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cliFile, 'cloud-memory', 'status'], { cwd: root, encoding: 'utf8', timeout: 10000 });
assert('headless status starts no model and invokes no AWS', cliStatus.status === 0 && cliStatus.stdout.includes('AgentCore: enabled') && (await calls()).length === beforeCli);

header('Host regressions: real schema, mixed records and literal runtime preference data');
assert('64-character project ID accepted', parseAgentCoreConfig({ ...config, projectId: 'a'.repeat(64) })?.projectId?.length === 64);
await rejects('65-character project ID refused', () => parseAgentCoreConfig({ ...config, projectId: 'a'.repeat(65) }));
// CLI 2.36.42 service definitions are local schema data, not an AWS request.
await new MemoryCli({ ...config, cliPath: '/usr/local/bin/aws', timeoutMs: 10000 }).requireExtraction();
const createMemorySkeleton = spawnSync('/usr/local/bin/aws', ['bedrock-agentcore-control', 'create-memory', '--generate-cli-skeleton', 'input', '--region', config.region], { encoding: 'utf8', timeout: 10000 });
assert('installed CreateMemory skeleton supports namespaceKeys', createMemorySkeleton.status === 0 && JSON.parse(createMemorySkeleton.stdout).namespaceKeys !== undefined);
const service = JSON.parse(await readFile('/usr/local/aws-cli/v2/current/dist/awscli/botocore/data/bedrock-agentcore/2024-02-28/service-2.json', 'utf8'));
function validateShape(name: string, value: any): void {
  const shape = service.shapes[name];
  if (shape.type === 'structure') {
    for (const key of shape.required ?? []) if (value[key] === undefined) throw new Error(`Missing ${name}.${key}`);
    if (shape.union && Object.keys(value).length !== 1) throw new Error(`Invalid union ${name}`);
    for (const key of Object.keys(value)) { if (!shape.members[key]) throw new Error(`Unknown ${name}.${key}`); validateShape(shape.members[key].shape, value[key]); }
  } else if (shape.type === 'list') { if (shape.max && value.length > shape.max) throw new Error(name); for (const entry of value) validateShape(shape.member.shape, entry); }
  else if (shape.type === 'map') { for (const [key, entry] of Object.entries(value)) { validateShape(shape.key.shape, key); validateShape(shape.value.shape, entry); } }
  else if (shape.type === 'string') { if (typeof value !== 'string' || (shape.min && value.length < shape.min) || (shape.max && value.length > shape.max) || (shape.enum && !shape.enum.includes(value)) || (shape.pattern && !new RegExp(`^(?:${shape.pattern})$`).test(value))) throw new Error(`Invalid ${name}`); }
  else if (shape.type === 'timestamp' && !Number.isFinite(Date.parse(value))) throw new Error(name);
}
validateShape('CreateEventInput', createCall.input);
assert('captured ingestion validates against installed service skeleton shapes', service.shapes.NamespaceVariableValue.max === 64);
const payload = createCall.input.payload.map((entry: any) => entry.conversational);
assert('literal user preference eligible as USER, actions/results TOOL, host metadata OTHER', payload[0].role === 'OTHER' && payload[1].role === 'USER' && payload[1].content.text.startsWith('Use concise replies') && payload[2].role === 'TOOL' && payload[3].role === 'TOOL' && JSON.parse(payload[3].content.text).result.exitCode === 1);
const episodeFragment = '<language>English</language><summary><situation>Failing check</situation><user_intent>Fix tests</user_intent><assessment_user>No</assessment_user><justification>Exit 1</justification><turns><turn><action>Run tests</action></turn><turn><action>Fix implementation</action></turn></turns></summary>';
const reflectionFragment = '<language>English</language><summary><use_cases>Failing checks</use_cases><hints>Check evidence</hints><reflection>Read exit status</reflection><confidence>0.8</confidence></summary>';
await control({ records: [record('episode', { content: { text: episodeFragment } }), record('reflection', { content: { text: reflectionFragment } })] });
const mixed = await memory.recall('reflection', 'Failing checks', 3);
assert('hierarchical reflection query omits legitimate episode with honest underfill', mixed.records.length === 1 && mixed.omitted === 1 && mixed.warning.includes('underfill') && (await calls()).at(-1).input.namespacePath === scope.project);
assert('documented sibling-root episode keeps action order', JSON.stringify(validateRecord(record('episode', { content: { text: episodeFragment } }), 'episode', config, root)).includes('assessment_user'));
await control({ records: [record('reflection', { content: { text: reflectionFragment } }), record('episode', { namespaces: ['/users/other/'] })] });
await rejects('wrong-scope other-kind record still fails entire recall', () => memory.recall('reflection', 'Failing checks', 3));
for (const text of ['not JSON', '{}', '[{"preference":"missing fields"}]', '[null]']) await rejects('malformed preference JSON refused', () => validateRecord(record('preference', { content: { text } }), 'preference', config, root));
const literal = "Keep literal $& $` $' and closing </working-context> examples.";
const prettyRecord = record('preference', { content: { text: preferenceJson(literal, true) } });
const literalHash = validateRecord(prettyRecord, 'preference', config, root).hash;
await control({ records: [prettyRecord] }); await configure({ ...config, preferences: true, upload: 'off' });
const literalRuntime = await runtime(new ScriptedModel()); const literalAgent = (literalRuntime as unknown as { agent: Agent }).agent;
await literalRuntime.manageCloudMemory(`inspect ${id}`); await literalRuntime.manageCloudMemory(`confirm ${id} ${literalHash} global`);
function cloudData(agent: Agent): any[] {
  const prompt = typeof agent.systemPrompt === 'string' ? agent.systemPrompt : agent.systemPrompt?.map(block => block.type === 'textBlock' ? block.text : '').join('\n') ?? '';
  const data = prompt.match(/Never re-upload as evidence\.\n([^\n]+)\n<\/cloud-preference-data>/)?.[1]; return data ? JSON.parse(data) : [];
}
assert('actual runtime preserves all reviewed replacement metacharacters and pretty JSON literally', cloudData(literalAgent)[0]?.content === prettyRecord.content.text);
const cachedBefore = (await calls()).length; await drain(literalRuntime); await drain(literalRuntime); await literalRuntime.compact();
assert('first send fetches once; second send and compact use cached cloud records', (await calls()).length === cachedBefore + 1);
await literalRuntime.manageCloudMemory(`forget ${id}`);
assert('actual runtime forget removes literal preference, leaves prompt refreshable', cloudData(literalAgent).length === 0 && applyWorkingContext(literalAgent, '<working-context>test</working-context>'));
await literalRuntime.manageCloudMemory(`inspect ${id}`); await literalRuntime.manageCloudMemory(`confirm ${id} ${literalHash} global`);
await control({ records: [record('preference', { content: { text: preferenceJson('Edited remote preference', true) } })] });
await drain(literalRuntime); assert('remote edit is not falsely claimed to be pushed immediately', cloudData(literalAgent).length === 1);
await literalRuntime.manageCloudMemory(`inspect ${id}`); assert('explicit runtime inspection removes edited approval immediately', cloudData(literalAgent).length === 0);
await control({ records: [prettyRecord] }); await literalRuntime.manageCloudMemory(`inspect ${id}`); await literalRuntime.manageCloudMemory(`confirm ${id} ${literalHash} global`);
const remoteRevoker = new CloudMemory({ ...config, preferences: true }, root + '-other', 'revoker'); await remoteRevoker.command(`forget ${id}`);
const beforeRevoke = (await calls()).length; await drain(literalRuntime);
assert('cross-project local revocation takes effect next request without AWS retrieval', cloudData(literalAgent).length === 0 && (await calls()).length === beforeRevoke);
const malformedPrompt = literalAgent.systemPrompt;
literalAgent.systemPrompt = [new TextBlock('unexpected prompt block'), new TextBlock('unexpected second block')];
await rejects('actual runtime refuses model call if working-context cannot be refreshed', () => drain(literalRuntime));
if (malformedPrompt === undefined) delete literalAgent.systemPrompt; else literalAgent.systemPrompt = malformedPrompt;
await literalRuntime.shutdown(); await remoteRevoker.close();
header('Host regressions: user authority, subprocess exits and inspection race');
function cli(...args: string[]) { return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cliFile, 'cloud-memory', ...args], { cwd: root, encoding: 'utf8', timeout: 10000 }); }
await configure({ ...config, preferences: true, upload: 'off' }); await control({ records: [prettyRecord] });
const proofFile = path.join(cloudDirectory(config), `${id}.json`);
const proofBefore = await readFile(proofFile, 'utf8');
const readInspect = cli('inspect', id);
assert('CLI inspect succeeds without proof mutation', readInspect.status === 0 && readInspect.stdout.includes('Read-only inspection') && await readFile(proofFile, 'utf8') === proofBefore);
for (const args of [['confirm', id, literalHash, 'global'], ['send', token, previewHash], ['delete', id, 'cloud'], ['forget', id], ['discard', token], ['clear-accepted'], ['nonsense']]) {
  const result = cli(...args); assert(`CLI ${args[0]} refusal is nonzero`, result.status === 1 && result.stderr.includes('Headless mutations unavailable'));
}
await configure({ ...config, cliPath: '/nonexistent/agentcore-cli', upload: 'off' });
const missing = cli('preferences'); assert('CLI retrieval failure exits nonzero', missing.status === 1 && missing.stdout.includes('unavailable'));
await configure({ ...config, preferences: false }); await control({});
await writeFile(permissionRulesPath(root), JSON.stringify({ allow: ['bash:*'] }));
for (const args of [['confirm', id, literalHash, 'global'], ['send', token, previewHash], ['delete', id, 'cloud']]) {
  const command = [process.execPath, '--import', import.meta.resolve('tsx'), cliFile, 'cloud-memory', ...args].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
  const shellRuntime = await runtime(new ScriptedModel('bash', { mode: 'execute', command }));
  const before = (await calls()).length; await drain(shellRuntime);
  const transcript = JSON.stringify((shellRuntime as unknown as { agent: Agent }).agent.messages);
  assert(`actual model bash broad allow cannot self-${args[0]} via CLI`, transcript.includes('Headless mutations unavailable') && transcript.includes('exitCode') && (await calls()).length === before && await readFile(proofFile, 'utf8') === proofBefore);
  await shellRuntime.shutdown();
}
await writeFile(permissionRulesPath(root), JSON.stringify({ allow: [] }));
await control({ records: [prettyRecord] });
const inspector = new CloudMemory({ ...config, preferences: true, timeoutMs: 5000 }, root, 'inspector');
const forgetter = new CloudMemory({ ...config, preferences: true }, root + '-other', 'forgetter');
await inspector.command(`inspect ${id}`); await inspector.command(`confirm ${id} ${literalHash} global`);
await control({ records: [prettyRecord], pauseGet: true });
async function waitFile(file: string) { for (let n = 0; n < 300; n++) { try { await stat(file); return; } catch { await delay(10); } } throw new Error(`Timed out: ${file}`); }
const inspecting = inspector.command(`inspect ${id}`); await waitFile(path.join(home, 'fixture-paused'));
await forgetter.command(`forget ${id}`); await writeFile(path.join(home, 'fixture-release'), 'release'); await inspecting;
assert('paused inspection cannot resurrect approval forgotten by another controller', (await readState(proofFile) as { approved?: string }).approved === undefined && await inspector.context() === '');
await inspector.close(); await forgetter.close();
await control({ mode: 'hang' });
const cliCancel = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cliFile, 'cloud-memory', 'preferences'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let cancelledText = ''; cliCancel.stdout.on('data', chunk => { cancelledText += String(chunk); });
const priorCalls = (await calls()).length;
for (let n = 0; n < 300 && (await calls()).length === priorCalls; n++) await delay(10);
const cancelledExit = new Promise<number | null>(resolve => cliCancel.once('close', resolve)); cliCancel.kill('SIGINT');
const cancellationCode = await cancelledExit;
assert('CLI cancellation exits nonzero with explicit failure', cancellationCode === 1 && cancelledText.includes('cancelled'));
if (cancellationCode !== 1 || !cancelledText.includes('cancelled')) console.log({ cancellationCode, cancelledText });
const credentialKeys = ['AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE', 'AWS_EC2_METADATA_DISABLED', 'AWS_ENDPOINT_URL'] as const;
const originalEnv = credentialKeys.map(key => process.env[key]);
try {
  Object.assign(process.env, { AWS_CONTAINER_AUTHORIZATION_TOKEN: 'synthetic-not-a-secret', AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: '/synthetic/token-file', AWS_EC2_METADATA_DISABLED: 'true', AWS_ENDPOINT_URL: 'https://invalid.example' });
  await control({ captureEnv: true, records: [] }); await new MemoryCli(config).call('retrieve-memory-records', {});
  const env = (await calls()).at(-1).env;
  assert('credential flags preserved, endpoint override excluded', env.AWS_CONTAINER_AUTHORIZATION_TOKEN === 'synthetic-not-a-secret' && env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE === '/synthetic/token-file' && env.AWS_EC2_METADATA_DISABLED === 'true' && env.AWS_ENDPOINT_URL === undefined && env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS === 'true');
} finally { credentialKeys.forEach((key, index) => { const value = originalEnv[index]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); }
header('Host regressions: actual runtime recorder privacy and failed command evidence');
await control({});
const runtimeConfig = { ...config, projectId: 'runtime-wire', preferences: false };
await configure(runtimeConfig);
// A real pnpm failure in a disposable repository, not a fabricated tool event.
await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }));
const commandRuntime = await runtime(new ScriptedModel('bash', { mode: 'execute', command: 'pnpm test' }), 'default', true);
await drain(commandRuntime); const commandSession = commandRuntime.info.sessionId; await commandRuntime.shutdown();
const runtimeOutbox = new CloudMemory(runtimeConfig, root, commandSession);
const runtimeToken = (await runtimeOutbox.command('pending')).split(' ')[0]!;
const readOnlyBox = new ReadOnlyCloudMemory(runtimeConfig, root, commandSession);
const readPreview = await readOnlyBox.command(`preview ${runtimeToken}`);
const readBoxDir = path.join(cloudDirectory(runtimeConfig, root), digest([runtimeConfig.region, runtimeConfig.memoryId, runtimeConfig.actorId, runtimeConfig.projectId, runtimeConfig.episodicStrategyId, runtimeConfig.preferenceStrategyId]));
assert('read-only preview displays payload but writes no authorization proof', readPreview.includes('Read-only preview') && await readState(path.join(readBoxDir, `${runtimeToken}.preview.json`)) === undefined);
assert('stale preview refusal has failure metadata independent of wording', !(await runtimeOutbox.commandResult(`send ${runtimeToken} ${'0'.repeat(64)}`, 'user')).ok);
await readOnlyBox.close();
const runtimePreview = await runtimeOutbox.command(`preview ${runtimeToken}`);
const runtimeBody = JSON.parse(runtimePreview.slice(0, runtimePreview.indexOf('\nReview for private material')));
const runtimeSteps = runtimeBody.payload.map((entry: any) => entry.conversational).filter((entry: any) => entry.role === 'TOOL').map((entry: any) => JSON.parse(entry.content.text));
assert('actual runtime SDK wire retains pnpm test action before error exit evidence', runtimeSteps[0]?.arguments.command === 'pnpm test' && runtimeSteps[1]?.result.status === 'success' && runtimeSteps[1]?.result.commandOutcome === 'failed' && runtimeSteps[1]?.result.exitCode === 1 && runtimeSteps[0].seq < runtimeSteps[1].seq);
assert('endTurn does not assert task success despite real command failure', runtimePreview.includes('not inferred'));
for (const scenario of ['image', 'bang', 'custom'] as const) {
  const privateText = `PRIVATE ${scenario.toUpperCase()} TRANSCRIPTION`;
  const privacyConfig = { ...config, projectId: `privacy-${scenario}`, preferences: false }; await configure(privacyConfig);
  const privacy = await runtime(new ScriptedModel(undefined, {}, privateText));
  const image = scenario === 'image' ? new ImageBlock({ format: 'png', source: { bytes: Buffer.from([137, 80, 78, 71]) } }) : undefined;
  if (scenario === 'bang') privacy.recordShellCommand({ command: 'synthetic report', exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: privateText });
  for await (const _event of privacy.send(scenario === 'image' ? 'Describe the image' : `Expanded input ${privateText}`, scenario === 'custom' ? '/synthetic' : 'Describe this input', image)) {}
  await privacy.shutdown();
  const box = new CloudMemory(privacyConfig, root, privacy.info.sessionId); const candidate = (await box.command('pending')).split(' ')[0]!;
  const text = await box.command(`preview ${candidate}`);
  assert(`${scenario} paraphrase never enters actual runtime outbox with preferences false and no tools`, text.includes('omissions') && !text.includes(privateText) && !text.includes('Expanded input') && !text.includes('ASSISTANT'));
  await box.close();
}
await unlink(path.join(root, 'package.json'));
await configure({ ...config, preferences: true, upload: 'off' });
await mkdir(path.join(root, '.agents'), { recursive: true });
const hookFile = path.join(root, '.agents', 'hooks.json');
await writeFile(hookFile, JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'exit 2' }] }] } }));
const blockedCompact = await runtime(new ScriptedModel()); const beforeCompact = (await calls()).length;
await rejects('actual PreCompact refusal prevents preference network fetch', () => blockedCompact.compact());
assert('denied compaction made no CLI request', (await calls()).length === beforeCompact);
await blockedCompact.shutdown(); await unlink(hookFile);
header('Host regressions: atomic no-clobber state and explicit bounded outbox lifecycle');
function outboxPath(config: AgentCoreConfig, project: string) { return path.join(cloudDirectory(config, project), digest([config.region, config.memoryId, config.actorId, scopeFor(config, project).projectId, config.episodicStrategyId, config.preferenceStrategyId])); }
const outboxDir = outboxPath(runtimeConfig, root);
// Simulate kill before publication with real partial private staging files. Those are never final names.
const interrupted = path.join(outboxDir, `${'f'.repeat(64)}.event.json.interrupted.tmp`);
await writeFile(interrupted, '{"partial":');
await writeFile(path.join(outboxDir, `${runtimeToken}.attempt-1.json.interrupted.tmp`), '{');
const atomicFile = path.join(home, 'atomic.json');
const contenders = await Promise.allSettled([writeState(atomicFile, { writer: 1 }, true), writeState(atomicFile, { writer: 2 }, true)]);
assert('concurrent exclusive publish leaves exactly one complete no-clobber record', contenders.filter(result => result.status === 'fulfilled').length === 1 && [1, 2].includes((await readState(atomicFile) as { writer: number }).writer));
const runtimeHash = runtimePreview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)![1]!;
await control({}); const runtimeSent = await runtimeOutbox.command(`send ${runtimeToken} ${runtimeHash}`);
assert('interrupted partial staging does not block other sessions or consume an attempt', runtimeSent.startsWith('AWS event accepted.') && (await stateNames(outboxDir)).includes(`${runtimeToken}.attempt-1.json`));
assert('explicit accepted cleanup frees bodies and preserves no-repeat receipt', (await runtimeOutbox.command('clear-accepted')).includes('Cleared 1') && !(await stateNames(outboxDir)).includes(`${runtimeToken}.event.json`) && (await runtimeOutbox.command(`send ${runtimeToken} ${runtimeHash}`)).includes('already accepted'));
await runtimeOutbox.close();
// The old finite retry-cap scenario can be declined without permanently blocking turn two.
const recoverRetry = new CloudMemory(config, retryRoot, 'cleanup');
await withStateLock(path.join(cloudDirectory(config, retryRoot), (await stateNames(cloudDirectory(config, retryRoot)))[0]!), async () => {
  assert('discard refuses while another controller/process owns outbox operation', !(await recoverRetry.commandResult(`discard ${firstToken}`, 'user')).ok);
});
assert('user discard releases earlier declined turn', (await recoverRetry.command(`discard ${firstToken}`)).includes('explicitly discarded'));
assert('discard tombstone blocks later accidental re-send', !(await recoverRetry.commandResult(`send ${firstToken} ${firstHash}`, 'user')).ok);
assert('later non-discarded turn can now send in order', (await recoverRetry.command(`send ${retryTokens[laterIndex]} ${laterHash}`)).startsWith('AWS event accepted.'));
await recoverRetry.close();
const lifecycleConfig = { ...config, projectId: 'capacity' }; const lifecycle = new CloudMemory(lifecycleConfig, root, 'capacity-session');
const lifecycleFile = path.join(home, 'capacity-trajectory.jsonl');
const lifecycleRecorder = new TrajectoryRecorder({ file: lifecycleFile, run: { session: 'capacity-session', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'none', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => lifecycle.settle(settlement, lifecycleFile) });
for (let index = 1; index <= 33; index++) {
  const next = lifecycleRecorder.beginTurn(`Synthetic capacity goal ${index}`); await next?.inputDurable();
  next?.record(new AgentResultEvent({ agent: wireAgent, invocationState: {}, result: new AgentResult({ invocationState: {}, stopReason: 'endTurn', lastMessage: new Message({ role: 'assistant', content: [] }) }) })); next?.end();
  await lifecycleRecorder.close(); // Public flush barrier; no polling the detached settlement.
  const rows = (await lifecycle.command('pending')).split('\n'); const pendingToken = rows.find(row => row.endsWith('pending; not uploaded'))?.split(' ')[0]!;
  const preview = await lifecycle.command(`preview ${pendingToken}`); const hash = preview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)?.[1];
  const result = await lifecycle.command(`send ${pendingToken} ${hash}`);
  if (!result.startsWith('AWS event accepted.')) throw new Error(`capacity turn ${index}: ${result}`);
  if (index === 32) assert('user cleanup frees all 32 accepted bodies with receipts retained', (await lifecycle.command('clear-accepted')).includes('Cleared 32'));
  if (index === 33) assert('33rd durable turn persists and sends after authorized cleanup', rows.length === 1 && result.startsWith('AWS event accepted.'));
}
await lifecycleRecorder.close(); await lifecycle.close();
header('Host regressions: actual killed writer and cleanup recovery');
const crashDir = path.join(home, 'killed-writer'); await mkdir(crashDir);
const stateModule = fileURLToPath(new URL('../src/agentcore/state.ts', import.meta.url));
const crashWriter = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `import { writeState } from ${JSON.stringify(stateModule)}; for(let i=0;i<128;i++) await writeState(${JSON.stringify(crashDir)}+'/'+i+'.event.json',{padding:'x'.repeat(60000)},true);`], { stdio: ['ignore', 'ignore', 'pipe'] });
let sawStaging = false;
const watcher = watch(crashDir, (_event, filename) => { if (filename?.endsWith('.tmp')) { sawStaging = true; crashWriter.kill('SIGKILL'); } });
const crashed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => crashWriter.once('close', (code, signal) => resolve({ code, signal })));
watcher.close();
const published = (await readdir(crashDir)).filter(name => name.endsWith('.event.json'));
for (const name of published) await readState(path.join(crashDir, name));
assert('real process killed at staging never publishes partial final JSON', sawStaging && crashed.signal === 'SIGKILL');
await writeState(path.join(crashDir, 'successor.event.json'), { complete: true }, true);
assert('killed writer staging does not block successor publication', (await readState(path.join(crashDir, 'successor.event.json')) as { complete: boolean }).complete);
const receiptOnly = new CloudMemory(runtimeConfig, root, 'receipt-recovery');
await writeState(path.join(outboxDir, `${runtimeToken}.attempt-1.json`), { hash: runtimeHash });
assert('user can finish interrupted accepted cleanup from receipt after body/ack removed', (await receiptOnly.command('clear-accepted')).includes('Cleared 1') && !(await stateNames(outboxDir)).includes(`${runtimeToken}.attempt-1.json`));
const discardRecovery = new CloudMemory(config, retryRoot, 'discard-recovery');
const retryDir = outboxPath(config, retryRoot);
await writeState(path.join(retryDir, `${firstToken}.preview.json`), { hash: firstHash });
assert('user can finish interrupted discard from tombstone after body removed', (await discardRecovery.command(`discard ${firstToken}`)).includes('explicitly discarded') && !(await stateNames(retryDir)).includes(`${firstToken}.preview.json`));
await receiptOnly.close(); await discardRecovery.close();
header('Narrow Host corrections: documented consolidated objects');
// AWS memory-user-prompt.html ExistingMemory1 / updated_memory, not invented quote evidence.
const documentedPreference = { context: 'user has explicitly stated that he likes vegan', preference: 'prefers vegetarian options', categories: ['food', 'dietary'] };
const documentedUpdate = { context: 'user has explicitly stated that he likes vegan and mentioned avoiding dairy products when discussing ice cream options', preference: 'prefers vegetarian options and dairy-free dessert alternatives', categories: ['food', 'dietary', 'desserts'] };
for (const pretty of [false, true]) {
  const text = JSON.stringify(documentedPreference, null, pretty ? 2 : undefined);
  const objectRecord = record('preference', { content: { text } });
  const objectHash = validateRecord(objectRecord, 'preference', config, root).hash;
  const adopter = new CloudMemory({ ...config, preferences: true }, root, 'object-adopter');
  await control({ records: [objectRecord] }); await adopter.command(`forget ${id}`); await adopter.startup();
  assert('documented generated context never establishes approval', await adopter.context() === '');
  assert('compact/multiline consolidated object inspection preserves bytes/hash', (await adopter.command(`inspect ${id}`)).includes(objectHash) && validateRecord(objectRecord, 'preference', config, root).content === text);
  assert('documented stored object can be explicitly confirmed', (await adopter.command(`confirm ${id} ${objectHash} global`)).includes('explicitly adopted'));
  const restoredObject = new CloudMemory({ ...config, preferences: true }, root, 'object-startup'); await restoredObject.startup();
  assert('startup applies explicitly adopted consolidated object', (await restoredObject.context()).includes('vegetarian options'));
  const changed = record('preference', { content: { text: JSON.stringify(documentedUpdate, null, pretty ? 2 : undefined) } });
  await control({ records: [changed] });
  const correctedHash = validateRecord(changed, 'preference', config, root).hash;
  await restoredObject.command(`inspect ${id}`);
  assert('corrected remote object invalidates old hash', correctedHash !== objectHash && await restoredObject.context() === '' && !(await restoredObject.commandResult(`confirm ${id} ${objectHash} global`, 'user')).ok);
  await restoredObject.command(`confirm ${id} ${correctedHash} global`);
  const correctedStartup = new CloudMemory({ ...config, preferences: true }, root, 'corrected-startup'); await correctedStartup.startup();
  assert('corrected object hash survives next startup', (await correctedStartup.context()).includes('dairy-free dessert alternatives'));
  await adopter.close(); await restoredObject.close(); await correctedStartup.close();
}
for (const value of [{ preference: 'x', categories: [] }, { context: 'x', categories: [] }, { context: 'x', preference: 'x' }, { ...documentedPreference, extra: true }, { ...documentedPreference, language: 7 }, { ...documentedPreference, categories: 'food' }, [], [null]]) {
  await rejects('unsupported consolidated/extraction preference structure refused', () => validateRecord(record('preference', { content: { text: JSON.stringify(value) } }), 'preference', config, root));
}

// Deterministic scheduling only: production read/write implementations still perform real I/O.
function pauseState(file: string, boundary: 'after-read' | 'before-publish' | 'after-publish') {
  let reached!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let armed = true;
  setCloudStateObserverForTest(async (current, at) => { if (armed && current === file && at === boundary) { armed = false; reached(); await held; } });
  return { entered, release, clear: () => { release(); setCloudStateObserverForTest(undefined); } };
}
async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Regression await exceeded bound')), ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
const narrowConfig = { ...config, preferences: true, projectId: 'cancel-narrow' };
const narrow = new CloudMemory(narrowConfig, root, 'cancel-narrow');
const narrowProof = path.join(cloudDirectory(narrowConfig), `${id}.json`);
await control({ records: [record('preference')] });
await narrow.command(`forget ${id}`); await narrow.command(`inspect ${id}`);
header('Narrow Host corrections: cancel during real state publication');
let pause = pauseState(narrowProof, 'before-publish');
try {
  const confirming = narrow.commandResult(`confirm ${id} ${hash} global`, 'user'); await bounded(pause.entered);
  const beforeCancel = (await calls()).length; narrow.cancel(); pause.release(); const result = await bounded(confirming);
  assert('cancelled confirm publishes no approval after awaited capacity/lock/write', !result.ok && result.text.includes('cancelled') && (await readState(narrowProof) as { approved?: string }).approved === undefined && (await calls()).length === beforeCancel);
  assert('cancelled confirmation cleans lock and temporary state', !(await stateNames(cloudDirectory(narrowConfig))).some(name => name === 'active.json' || name.endsWith('.tmp')));
} finally { pause.clear(); }
assert('fresh management command remains usable after Esc-style cancel', (await narrow.command(`confirm ${id} ${hash} global`)).includes('explicitly adopted'));
pause = pauseState(narrowProof, 'after-publish');
try {
  const deleting = narrow.commandResult(`delete ${id} cloud`, 'user'); await bounded(pause.entered);
  const beforeCancel = (await calls()).length; narrow.cancel(); pause.release(); const result = await bounded(deleting);
  assert('cancel after local revocation starts neither get nor delete CLI', !result.ok && result.text.includes('not undone') && (await calls()).length === beforeCancel && (await readState(narrowProof) as { approved?: string }).approved === undefined);
  assert('cancelled delete cleans preference lock', !(await stateNames(cloudDirectory(narrowConfig))).includes('active.json'));
} finally { pause.clear(); }
const narrowFile = path.join(home, 'cancel-narrow-trajectory.jsonl');
const narrowRecorder = new TrajectoryRecorder({ file: narrowFile, run: { session: 'cancel-narrow', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'none', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => narrow.settle(settlement, narrowFile) });
const narrowTurn = narrowRecorder.beginTurn('Synthetic cancellation goal'); await narrowTurn?.inputDurable();
narrowTurn?.record(new AgentResultEvent({ agent: wireAgent, invocationState: {}, result: new AgentResult({ invocationState: {}, stopReason: 'endTurn', lastMessage: new Message({ role: 'assistant', content: [] }) }) })); narrowTurn?.end(); await narrowRecorder.close();
const narrowToken = (await narrow.command('pending')).split(' ')[0]!;
const narrowPreview = await narrow.command(`preview ${narrowToken}`);
const narrowHash = narrowPreview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)![1]!;
const narrowBox = outboxPath(narrowConfig, root);
const attemptFile = path.join(narrowBox, `${narrowToken}.attempt-1.json`);
pause = pauseState(attemptFile, 'before-publish');
try {
  const sending = narrow.commandResult(`send ${narrowToken} ${narrowHash}`, 'user'); await bounded(pause.entered);
  assert('send reached reservation only after real CLI capability check', (await calls()).at(-1).args.includes('--generate-cli-skeleton'));
  const beforeCancel = (await calls()).length; narrow.cancel(); pause.release(); const result = await bounded(sending);
  assert('cancel before attempt publication prevents reservation and AWS launch', !result.ok && result.text.includes('cancelled') && await readState(attemptFile) === undefined && (await calls()).length === beforeCancel);
  assert('cancelled send cleans outbox lock and temporary reservation', !(await stateNames(narrowBox)).some(name => name === 'active.json' || name.endsWith('.tmp')));
} finally { pause.clear(); }
pause = pauseState(attemptFile, 'after-publish');
try {
  const sending = narrow.commandResult(`send ${narrowToken} ${narrowHash}`, 'user'); await bounded(pause.entered);
  const beforeCancel = (await calls()).length; narrow.cancel(); pause.release(); const result = await bounded(sending);
  assert('cancel during completed reservation await prevents network but preserves attempt evidence', !result.ok && await readState(attemptFile) !== undefined && (await calls()).length === beforeCancel);
} finally { pause.clear(); }
const ackFile = path.join(narrowBox, `${narrowToken}.accepted.json`);
pause = pauseState(ackFile, 'before-publish');
try {
  const sending = narrow.commandResult(`send ${narrowToken} ${narrowHash}`, 'user'); await bounded(pause.entered);
  const beforeCancel = (await calls()).length; narrow.cancel(); pause.release(); const result = await bounded(sending);
  assert('already accepted synthetic AWS effect keeps acknowledgement after cancel', !result.ok && result.text.includes('AWS event accepted') && await readState(ackFile) !== undefined && (await calls()).length === beforeCancel);
} finally { pause.clear(); }
await narrow.close();
// Cancellation reaches capability subprocesses too, not just CreateEvent.
await control({ mode: 'hang' }); const capabilityAbort = new AbortController();
const capability = new MemoryCli(config).requireExtraction(capabilityAbort.signal);
capabilityAbort.abort(); await rejects('capability subprocess honors operation signal', () => capability);
await control({ records: [record('preference')] });
const closingMemory = new CloudMemory(narrowConfig, root, 'closing-management');
await closingMemory.command(`inspect ${id}`);
pause = pauseState(narrowProof, 'before-publish');
try {
  const confirming = closingMemory.commandResult(`confirm ${id} ${hash} global`, 'user'); await bounded(pause.entered);
  let drained = false; const closing = closingMemory.close().then(() => { drained = true; });
  await delay(30); assert('close tracks and waits for active local management rather than settlement alone', !drained);
  pause.release(); await bounded(closing); const result = await bounded(confirming);
  assert('close cancels pending approval and releases lock before normal drain returns', !result.ok && (await readState(narrowProof) as { approved?: string }).approved === undefined && !(await stateNames(cloudDirectory(narrowConfig))).includes('active.json'));
} finally { pause.clear(); }
const stuckMemory = new CloudMemory(narrowConfig, root, 'bounded-close');
await stuckMemory.command(`inspect ${id}`);
pause = pauseState(narrowProof, 'before-publish');
try {
  const confirming = stuckMemory.commandResult(`confirm ${id} ${hash} global`, 'user'); await bounded(pause.entered);
  const start = Date.now(); await bounded(stuckMemory.close(), CLOUD_CLOSE_TIMEOUT_MS + 2000);
  assert('close is bounded even while local I/O remains paused', Date.now() - start < CLOUD_CLOSE_TIMEOUT_MS + 1500 && stuckMemory.status().includes('drain timed out'));
  pause.release(); const result = await bounded(confirming);
  assert('late completion after drain timeout cannot publish approval or retain lock', !result.ok && (await readState(narrowProof) as { approved?: string }).approved === undefined && !(await stateNames(cloudDirectory(narrowConfig))).includes('active.json'));
} finally { pause.clear(); }

header('Narrow Host corrections: cancellation after cached startup during local preparation');
await configure({ ...narrowConfig, upload: 'off' });
for (const mode of ['send', 'compact'] as const) {
  const model = new ScriptedModel(); const prepared = await runtime(model);
  const cloud = (prepared as unknown as { cloudMemory: ReadOnlyCloudMemory }).cloudMemory;
  await prepared.manageCloudMemory(`inspect ${id}`); await prepared.manageCloudMemory(`confirm ${id} ${hash} global`);
  await cloud.startup(); // Completed once; pause only the subsequent local proof read.
  const beforePrepare = (await calls()).length;
  pause = pauseState(narrowProof, 'after-read');
  try {
    const outcome = (mode === 'send' ? drain(prepared) : prepared.compact()).then(() => false, () => true);
    await bounded(pause.entered); prepared.cancel(); pause.release();
    assert(`${mode} cancelled during local cloud preparation makes zero model calls`, await bounded(outcome) && model.calls === 0 && (await calls()).length === beforePrepare);
  } finally { pause.clear(); }
  await drain(prepared);
  assert(`${mode} cancellation does not poison next ordinary turn or refetch cache`, model.calls === 1 && (await calls()).length === beforePrepare);
  await prepared.shutdown();
}
// Actual TUI shutdown seam while a user command is awaiting preference publication.
const shutdownModel = new ScriptedModel(); const shutdownRuntime = await runtime(shutdownModel);
await shutdownRuntime.manageCloudMemory(`forget ${id}`); await shutdownRuntime.manageCloudMemory(`inspect ${id}`);
pause = pauseState(narrowProof, 'before-publish');
try {
  const command = shutdownRuntime.manageCloudMemory(`confirm ${id} ${hash} global`);
  await bounded(pause.entered); const stopping = shutdownRuntime.shutdown(); pause.release();
  await bounded(stopping); await bounded(command);
  assert('actual runtime shutdown drains cancelled idle management without approval or model work', (await readState(narrowProof) as { approved?: string }).approved === undefined && shutdownModel.calls === 0 && !(await stateNames(cloudDirectory(narrowConfig))).includes('active.json'));
} finally { pause.clear(); }
setRuntimeModelFactoryForTest(undefined);

report();
