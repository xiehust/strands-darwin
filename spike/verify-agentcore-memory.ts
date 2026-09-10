/** Offline real-files, real CLI subprocess and actual Agent/gate proofs. No AWS requests. */
import { chmod, mkdir, readFile, writeFile, readdir, symlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Agent, Model, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { CloudMemory } from '../src/agentcore/controller.js';
import { MemoryCli } from '../src/agentcore/transport.js';
import { parseAgentCoreConfig, scopeFor, type AgentCoreConfig } from '../src/agentcore/config.js';
import { parseMemoryXml, validateRecord } from '../src/agentcore/records.js';
import { cloudDirectory, writeState } from '../src/agentcore/state.js';
import { publicProse } from '../src/agentcore/projection.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath, loadConfig, permissionRulesPath } from '../src/config.js';
import { classify } from '../src/agent/permission.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
import { isSensitiveDarwinPath } from '../src/paths.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
const home = ownPrivateHome('agentcore'); const root = path.join(home, 'project'); await mkdir(root);
const fixture = fileURLToPath(new URL('./agentcore-cli-fixture.cjs', import.meta.url)); await chmod(fixture, 0o755);
const config = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'opaque-user', episodicStrategyId: 'episodes-0123456789', preferenceStrategyId: 'preferences-0123456789', cliPath: fixture, preferences: false, upload: 'manual', timeoutMs: 1000 })!;
async function control(value: object) { await writeFile(path.join(home, 'fixture-control.json'), JSON.stringify(value)); }
async function calls(): Promise<any[]> { try { return (await readFile(path.join(home, 'fixture-calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
async function rejects(label: string, action: () => unknown | Promise<unknown>) { let caught = false; try { await action(); } catch { caught = true; } assert(label, caught); }
const id = 'record-' + 'a'.repeat(40);
const scope = scopeFor(config, root);
function record(kind: 'preference' | 'episode' | 'reflection', overrides = {}) {
  return { memoryRecordId: id, memoryStrategyId: kind === 'preference' ? config.preferenceStrategyId : config.episodicStrategyId,
    namespaces: [kind === 'preference' ? scope.preferences : kind === 'reflection' ? scope.project : `${scope.episodes}session-test/`], createdAt: '2026-01-01T00:00:00Z',
    content: { text: kind === 'preference' ? 'Use concise replies in all projects.' : kind === 'episode' ? '<episode><intent>Fix tests</intent><assessment>No</assessment><justification>Exit 1</justification><turns><turn><action>Run tests</action></turn><turn><action>Fix implementation</action></turn></turns></episode>' : '<reflection><use_cases>Failing tests</use_cases><hints>Check exit evidence</hints><confidence>0.8</confidence></reflection>' }, ...overrides };
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
await control({ records: [record('preference', { content: { text: 'Changed preference' } })] });
await preferences.startup(); assert('cloud content edits invalidate approval', await preferences.context() === '');
await control({ records: [record('preference', { namespaces: ['/users/wrong/'] })] });
const beforeDelete = (await calls()).length; await preferences.command(`delete ${id} cloud`);
assert('wrong-scope delete never invokes DeleteMemoryRecord', !(await calls()).slice(beforeDelete).some(call => call.args[1] === 'delete-memory-record'));
await control({ records: [record('preference')] }); await preferences.command(`delete ${id} cloud`);
assert('only explicit delete performs cloud delete', (await calls()).at(-1).args[1] === 'delete-memory-record');
header('Durable new-turn outbox and preview authorization');
assert('privacy omissions reject dumps and secrets', publicProse('secret: abc') === undefined && publicProse('read /home/user/file') === undefined && publicProse('x'.repeat(1001)) === undefined);
const file = path.join(home, 'trajectory.jsonl'); const uploader = new CloudMemory(config, root, 'session-upload');
const recorder = new TrajectoryRecorder({ file, run: { session: 'session-upload', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'offline', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => uploader.settle(settlement, file) });
const turn = recorder.beginTurn('Fix the synthetic test failure.'); await turn?.inputDurable();
turn?.record({ type: 'contentBlockEvent', contentBlock: { text: 'Public synthetic statement before any tool.' } } as never);
turn?.record({ type: 'beforeToolCallEvent', toolUse: { name: 'bash', toolUseId: 'test', input: { mode: 'execute', command: 'pnpm test' } } } as never);
turn?.record({ type: 'afterToolCallEvent', toolUse: { toolUseId: 'test' }, result: { toolUseId: 'test', status: 'error', content: [{ json: { exitCode: 1, output: 'SECRET LOG DUMP' } }] } } as never);
turn?.failed(new Error('synthetic failure')); turn?.end(); await recorder.close();
const pending = await uploader.command('pending'); const token = pending.split(' ')[0]!;
assert('new durable failed turn queued without network', /^[a-f0-9]{64}$/.test(token) && pending.includes('pending; not uploaded'));
const beforeSend = (await calls()).length;
assert('send without preview authorization refused', (await uploader.command(`send ${token} ${'0'.repeat(64)}`)).includes('authorization'));
assert('no unauthorized subprocess', (await calls()).length === beforeSend);
const preview = await uploader.command(`preview ${token}`); const previewHash = preview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)?.[1]!;
assert('preview retains failure, command and exit evidence, excludes logs', preview.includes('Public synthetic statement') && preview.includes('failed') && preview.includes('pnpm test') && preview.includes('exitCode') && !preview.includes('SECRET LOG DUMP'));
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
for (const stopReason of ['cancelled', 'endTurn']) {
  const next = retryRecorder.beginTurn('Synthetic public goal'); await next?.inputDurable();
  next?.record({ type: 'beforeToolCallEvent', toolUse: { name: 'memory_recall', toolUseId: 'private', input: { query: 'private' } } } as never);
  next?.record({ type: 'afterToolCallEvent', toolUse: { toolUseId: 'private' }, result: { toolUseId: 'private', status: 'success', content: [{ text: 'RETRIEVED PRIVATE MEMORY' }] } } as never);
  next?.record({ type: 'contentBlockEvent', contentBlock: { text: 'PARAPHRASED MEMORY' } } as never);
  next?.record({ type: 'agentResultEvent', result: { stopReason, lastMessage: { role: 'assistant', content: [] } } } as never); next?.end();
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
  constructor(readonly toolName?: string) { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls++;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.toolName && !messages.some(message => message.content.some(block => block.type === 'toolResultBlock'))) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: this.toolName, toolUseId: 'recall-test' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ intent: 'Fix tests', limit: 2 }) } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }; return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'Synthetic public answer.' } };
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

report();
