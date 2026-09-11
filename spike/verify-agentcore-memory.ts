/** Offline real-files, SDK Commands/signing/HTTP, actual runtime/gates and CLI proofs.
 * No AWS requests. A separate loopback server handles synthetic signed requests.
 * Isolates HOME; generated events, credential markers and model responses are synthetic.
 */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
import { mkdir, readFile, writeFile, readdir, symlink, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
import { MemoryTransport, setMemoryTransportOptionsForTest } from '../src/agentcore/transport.js';
import { loopbackHandler } from './agentcore-sdk-fixture.js';
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
const fixture = fileURLToPath(new URL('./agentcore-http-fixture.cjs', import.meta.url));
const server = spawn(process.execPath, [fixture], { stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => server.kill('SIGTERM'));
const port = await new Promise<number>((resolve, reject) => { server.stdout.once('data', chunk => resolve(Number(String(chunk).trim()))); server.once('error', reject); });
const preload = fileURLToPath(new URL('./agentcore-sdk-fixture.ts', import.meta.url));
Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDSYNTHETIC', AWS_SECRET_ACCESS_KEY: 'synthetic-not-a-secret', AWS_EC2_METADATA_DISABLED: 'true', DARWIN_TEST_AGENTCORE_PORT: String(port) });
setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(port) }));
const config = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'opaque-user', episodicStrategyId: 'episodes-0123456789', preferenceStrategyId: 'preferences-0123456789', preferences: false, upload: 'manual', timeoutMs: 1000 })!;
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
for (const bad of [{ ...config, actorId: '../other' }, { ...config, projectId: 'UpperCase' }, { ...config, upload: 'automatic' }, { ...config, namespace: '/' }, { ...config, episodicStrategyId: config.preferenceStrategyId }]) await rejects('invalid host configuration fails closed', () => parseAgentCoreConfig(bad));
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
assert('verified retrieval fields and host strategy/scope', queryCall.input.searchCriteria.searchQuery.includes('Fix failing') && queryCall.input.searchCriteria.memoryStrategyId === config.episodicStrategyId && queryCall.input.namespacePath === scope.episodes && queryCall.headers.authorization.includes('/us-west-2/bedrock-agentcore/aws4_request'));
assert('approval/outbox paths are sensitive policy', isSensitiveDarwinPath(root, path.join(cloudDirectory(config), `${id}.json`)));
await verifyTransport();
if (process.argv.includes('--transport-only')) {
  await memory.close(); server.kill('SIGTERM');
  await new Promise<void>(resolve => server.once('close', () => resolve()));
  report(); process.exit(process.exitCode ?? 0);
}

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
assert('wrong-scope delete never invokes DeleteMemoryRecord', !(await calls()).slice(beforeDelete).some(call => call.operation === 'delete-memory-record'));
await control({ records: [record('preference')] }); await preferences.command(`delete ${id} cloud`);
assert('only explicit delete performs cloud delete', (await calls()).at(-1).operation === 'delete-memory-record');
header('Durable new-turn outbox and preview authorization');
assert('privacy omissions reject dumps and secrets', publicProse('secret: abc') === undefined && publicProse('read /home/user/file') === undefined && publicProse('x'.repeat(1001)) === undefined);
const file = path.join(home, 'trajectory.jsonl'); const uploader = new CloudMemory(config, root, 'session-upload');
const recorder = new TrajectoryRecorder({ file, run: { session: 'session-upload', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'offline', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => uploader.settle(settlement) });
const wireAgent = new Agent({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
const wireInvocation = {};
const turn = recorder.beginTurn('Use concise replies across projects. Fix the synthetic test failure.'); await turn?.inputDurable();
uploader.uploadObserver!.begin(turn!.turn, 'Use concise replies across projects. Fix the synthetic test failure.');
const observeUpload = (owner: ReadOnlyCloudMemory, event: BeforeToolCallEvent | AfterToolCallEvent) => {
  if (event.type === 'beforeToolCallEvent') owner.uploadObserver!.before(event);
  else owner.uploadObserver!.after(event);
};
turn?.record(new ContentBlockEvent({ agent: wireAgent, invocationState: wireInvocation, contentBlock: new TextBlock('Public synthetic statement before any tool.') }));
const testUse = new ToolUseBlock({ name: 'bash', toolUseId: 'test', input: { mode: 'execute', command: 'pnpm test' } });
const beforeUpload = new BeforeToolCallEvent({ agent: wireAgent, invocationState: wireInvocation, tool: undefined, toolUse: testUse });
const afterUpload = new AfterToolCallEvent({ agent: wireAgent, invocationState: wireInvocation, tool: undefined, toolUse: testUse, result: new ToolResultBlock({ toolUseId: 'test', status: 'error', content: [new JsonBlock({ json: { exitCode: 1, output: 'SECRET LOG DUMP' } })] }) });
await observeUpload(uploader, beforeUpload); turn?.record(beforeUpload);
await observeUpload(uploader, afterUpload); turn?.record(afterUpload);
turn?.failed(new Error('synthetic failure')); turn?.end(); await recorder.close();
const pending = await uploader.command('pending'); const token = pending.split(' ')[0]!;
assert('new durable failed turn queued without network', /^[a-f0-9]{64}$/.test(token) && pending.includes('pending; not uploaded'));
const beforeSend = (await calls()).length;
assert('send without preview authorization refused', (await uploader.command(`send ${token} ${'0'.repeat(64)}`)).includes('Preview absent'));
assert('no unauthorized SDK request', (await calls()).length === beforeSend);
const preview = await uploader.command(`preview ${token}`); const previewHash = preview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)?.[1]!;
assert('preview retains failure, command, exit evidence and original logs, excludes assistant prose', !preview.includes('Public synthetic statement') && preview.includes('failed') && preview.includes('pnpm test') && preview.includes('exitCode') && preview.includes('SECRET LOG DUMP'));
await control({});
assert('manual upload acknowledges event not episode', (await uploader.command(`send ${token} ${previewHash}`)).includes('generation is asynchronous and NOT verified'));
const createCall = (await calls()).at(-1);
assert('CreateEvent scope, projectid and token fixed', createCall.input.actorId === config.actorId && createCall.input.sessionId === 'session-upload' && createCall.input.clientToken === token && createCall.input.extractionConfig.namespaceVariables.projectid === scope.projectId);
const restarted = new CloudMemory(config, root, 'different-session'); const count = (await calls()).length;
assert('restart does not duplicate accepted upload', (await restarted.command(`send ${token} ${previewHash}`)).includes('already accepted') && (await calls()).length === count);
const otherActor = new CloudMemory({ ...config, actorId: 'different' }, root, 'session');
assert('actor cannot inspect another outbox', (await otherActor.command(`preview ${token}`)).includes('refused'));

header('Large new-format event, immutable legacy and tight proof bounds');
const largeConfig = { ...config, projectId: 'large-upload' };
const large = new CloudMemory(largeConfig, root, 'large-session');
large.uploadObserver!.begin(1, '/workflow literal goal\nsecret token /home/user/.env');
for (let i = 0; i < 64; i++) {
  const use = new ToolUseBlock({ name: 'arbitrary-mcp', toolUseId: `large-${i}`, input: { token: 'synthetic', text: 'i'.repeat(6000) } });
  // Invocation state is shared by the real SDK across each turn.
  const invocationState = {};
  const before = new BeforeToolCallEvent({ agent: wireAgent, invocationState, tool: undefined, toolUse: use });
  large.uploadObserver!.before(before);
  large.uploadObserver!.after(new AfterToolCallEvent({ agent: wireAgent, invocationState, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: use.toolUseId, status: 'success', content: [new TextBlock('r'.repeat(12000) + `LARGE-TAIL-${i}`)] }) }));
}
large.settle({ durable: true, session: 'large-session', turn: 1, seq: 999, at: '2026-01-01T00:00:00Z', stopReason: 'endTurn', failure: false, partial: false });
const largeToken = (await large.command('pending')).split(' ')[0]!;
const largeRead = await large.command(`preview ${largeToken}`, 'read');
const largeBody = JSON.parse(largeRead.split('\nRead-only preview:')[0]!);
assert('new CreateEvent body exceeds old 64KiB state cap but fits 256KiB escaped request', Buffer.byteLength(JSON.stringify(largeBody)) > 65536 && Buffer.byteLength(JSON.stringify(largeBody)) <= 262144);
const largeDir = path.join(cloudDirectory(largeConfig, root), digest([largeConfig.region, largeConfig.memoryId, largeConfig.actorId, 'large-upload', largeConfig.episodicStrategyId, largeConfig.preferenceStrategyId]));
const largeFile = path.join(largeDir, `${largeToken}.event.json`); const largeBytes = await readFile(largeFile);
await mkdir(path.dirname(configPath(root)), { recursive: true });
await writeFile(configPath(root), JSON.stringify({ provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', agentCoreMemory: largeConfig }));
const largeCli = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'cloud-memory', 'preview', largeToken], { cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 1048576 });
assert('standalone CLI previews >64KiB body read-only without event/proof mutation', largeCli.status === 0 && largeCli.stdout.includes('LARGE-TAIL-63') && (await readFile(largeFile)).equals(largeBytes) && await readState(path.join(largeDir, `${largeToken}.preview.json`)) === undefined);
const callsBeforeLarge = (await calls()).length;
assert('no large upload before exact user preview authorization', !(await large.commandResult(`send ${largeToken} ${digest(JSON.parse(largeBytes.toString()))}`, 'user')).ok && (await calls()).length === callsBeforeLarge);
const largePreview = await large.command(`preview ${largeToken}`); const largeHash = largePreview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)![1]!;
await control({});
assert('manual signed loopback accepts large CreateEvent', (await large.command(`send ${largeToken} ${largeHash}`)).startsWith('AWS event accepted.'));
assert('signed loopback payload is exactly previewed payload', isDeepStrictEqual((await calls()).at(-1).input.payload, largeBody.payload));
await rejects('preference proof remains capped at 64KiB', () => writeState(path.join(home, 'proof.json'), { data: 'x'.repeat(65536) }));
await rejects('non-upload request remains capped at 32000 bytes', () => large.transport.call('retrieve-memory-records', { memoryId: config.memoryId, namespacePath: scope.project, searchCriteria: { searchQuery: 'x'.repeat(32001) } }));
// Synthetic immutable legacy body: no regeneration or migration during preview/send.
const legacyBinding = digest([largeConfig.region, largeConfig.memoryId, largeConfig.actorId, 'large-upload', largeConfig.episodicStrategyId, largeConfig.preferenceStrategyId]);
const legacyToken = digest([legacyBinding, 'legacy-session', 1, 1]);
const legacyEntry = { version: 1, binding: legacyBinding, token: legacyToken, body: { ...largeBody, sessionId: 'legacy-session', clientToken: legacyToken, payload: [{ conversational: { role: 'OTHER', content: { text: JSON.stringify({ session: 'legacy-session', turn: 1, closingSeq: 1, steps: [] }) } } }] } };
const legacyFile = path.join(largeDir, `${legacyToken}.event.json`); await writeState(legacyFile, legacyEntry, true);
const legacyBytes = await readFile(legacyFile); const legacyPreview = await large.command(`preview ${legacyToken}`);
assert('legacy OTHER-only refusal and immutable bytes/hash/token unchanged', legacyPreview.includes(digest(legacyEntry)) && (await large.command(`send ${legacyToken} ${digest(legacyEntry)}`)).includes('Legacy OTHER-only upload refused') && (await readFile(legacyFile)).equals(legacyBytes));
// Previously sendable v1 USER/TOOL evidence with an already-authorized preview.
// Read-only inspection must neither migrate bytes nor revoke that authorization.
const sendableToken = digest([legacyBinding, 'sendable-v1', 1, 7]);
const sendableBody = { ...largeBody, sessionId: 'sendable-v1', clientToken: sendableToken, payload: [
  { conversational: { role: 'OTHER', content: { text: JSON.stringify({ format: 'darwin-upload-v1', session: 'sendable-v1', turn: 1, closingSeq: 7 }) } } },
  { conversational: { role: 'USER', content: { text: 'Original v1 goal\nunchanged' } } },
  { conversational: { role: 'TOOL', content: { text: 'Original v1 tool result' } } },
] };
const sendableEntry = { version: 1, binding: legacyBinding, token: sendableToken, body: sendableBody };
const sendableHash = digest(sendableEntry);
const sendableFile = path.join(largeDir, `${sendableToken}.event.json`);
const authorizationFile = path.join(largeDir, `${sendableToken}.preview.json`);
await writeState(sendableFile, sendableEntry, true); await writeState(authorizationFile, { hash: sendableHash }, true);
const oldBodyBytes = await readFile(sendableFile); const oldAuthorization = await readFile(authorizationFile);
const readOnlyLegacy = await large.command(`preview ${sendableToken}`, 'read');
assert('sendable v1 read-only preview preserves exact old body/hash/token and pre-existing authorization', JSON.stringify(JSON.parse(readOnlyLegacy.split('\nRead-only preview:')[0]!)) === JSON.stringify(sendableBody) && readOnlyLegacy.includes(sendableHash) && (await readFile(sendableFile)).equals(oldBodyBytes) && (await readFile(authorizationFile)).equals(oldAuthorization));
assert('pre-existing v1 authorization sends through signed loopback unchanged', (await large.command(`send ${sendableToken} ${sendableHash}`)).startsWith('AWS event accepted.') && isDeepStrictEqual((await calls()).at(-1).input.payload, sendableBody.payload) && (await calls()).at(-1).input.clientToken === sendableToken && (await calls()).at(-1).headers.authorization.includes('AWS4-HMAC-SHA256') && (await readFile(sendableFile)).equals(oldBodyBytes) && (await readFile(authorizationFile)).equals(oldAuthorization));
await large.close();

await uploader.close(); await restarted.close(); await preferences.close(); await crossProject.close();
header('Retry tokens, ordered turns, memory exclusion and state corruption');
const retryRoot = path.join(home, 'retry-project'); await mkdir(retryRoot);
const retry = new CloudMemory(config, retryRoot, 'session-retry'); const retryFile = path.join(home, 'retry-trajectory.jsonl');
const retryRecorder = new TrajectoryRecorder({ file: retryFile, run: { session: 'session-retry', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'none', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => retry.settle(settlement) });
for (const stopReason of ['cancelled', 'endTurn'] as const) {
  const wireInvocation = {}; // One invocation state per turn, like Agent.stream().
  const next = retryRecorder.beginTurn('Synthetic public goal'); await next?.inputDurable();
  retry.uploadObserver!.begin(next!.turn, 'Synthetic public goal');
  const use = new ToolUseBlock({ name: 'memory_recall', toolUseId: 'private', input: { query: 'private' } });
  const before = new BeforeToolCallEvent({ agent: wireAgent, invocationState: wireInvocation, tool: undefined, toolUse: use });
  const after = new AfterToolCallEvent({ agent: wireAgent, invocationState: wireInvocation, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: 'private', status: 'success', content: [new TextBlock('RETRIEVED PRIVATE MEMORY')] }) });
  await observeUpload(retry, before); next?.record(before);
  await observeUpload(retry, after); next?.record(after);
  next?.record(new ContentBlockEvent({ agent: wireAgent, invocationState: wireInvocation, contentBlock: new TextBlock('PARAPHRASED MEMORY') }));
  next?.record(new AgentResultEvent({ agent: wireAgent, invocationState: wireInvocation, result: new AgentResult({ invocationState: wireInvocation, stopReason, lastMessage: new Message({ role: 'assistant', content: [] }) }) })); next?.end();
}
await retryRecorder.close();
const retryTokens = (await retry.command('pending')).split('\n').map(row => row.split(' ')[0]!);
const previews = await Promise.all(retryTokens.map(token => retry.command(`preview ${token}`)));
const previewOutcome = (text: string) => JSON.parse(JSON.parse(text.split('\nReview for private material;')[0]!).payload[0].conversational.content.text).outcome;
const firstIndex = previews.findIndex(text => previewOutcome(text) === 'cancelled'); const firstToken = retryTokens[firstIndex]!; const firstPreview = previews[firstIndex]!;
const firstHash = firstPreview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)![1]!;
const laterIndex = 1 - firstIndex; const laterHash = previews[laterIndex]!.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)![1]!;
assert('public memory tool text retained but assistant paraphrases omitted', previews.join('').includes('PRIVATE MEMORY') && !previews.join('').includes('PARAPHRASED MEMORY'));
assert('cancel and closed are not task success', firstPreview.includes('cancelled') && previews[laterIndex]!.includes('not inferred'));
assert('session turn order enforced', (await retry.command(`send ${retryTokens[laterIndex]} ${laterHash}`)).includes('earlier pending'));
await control({ mode: 'error' });
for (let attempt = 0; attempt < 3; attempt++) assert('finite manual failure is reported', (await retry.command(`send ${firstToken} ${firstHash}`)).includes('SDK request failed'));
const beforeCap = (await calls()).length;
assert('fourth attempt refused without SDK request', (await retry.command(`send ${firstToken} ${firstHash}`)).includes('retry cap') && (await calls()).length === beforeCap);
const attempts = (await calls()).filter(call => call.operation === 'create-event' && call.input?.clientToken === firstToken);
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
  await drain(gated); assert(`${mode} gate denies before SDK HTTP invocation`, (await calls()).length === before); await gated.shutdown();
}
assert('network recall is not statically safe', classify('episodic_recall', { intent: 'test' }).kind === 'execute');
await mkdir(path.dirname(permissionRulesPath(root)), { recursive: true });
await writeFile(permissionRulesPath(root), JSON.stringify({ deny: ['episodic_recall'] }));
const denied = await runtime(new ScriptedModel('episodic_recall'), 'yolo', true); const beforeDeny = (await calls()).length;
await drain(denied); assert('explicit deny beats yolo before SDK HTTP', (await calls()).length === beforeDeny); await denied.shutdown();
await writeFile(permissionRulesPath(root), JSON.stringify({ deny: [] }));
const allowed = await runtime(new ScriptedModel('episodic_recall'), 'default', true); const beforeAllowed = (await calls()).length;
await drain(allowed); assert('ordinary approved recall reaches signed SDK HTTP', (await calls()).length === beforeAllowed + 1);
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
await configure({ ...config, preferences: true, upload: 'off' }); await control({ mode: 'error' });
const degradedModel = new ScriptedModel(); const degraded = await runtime(degradedModel); await drain(degraded);
assert('preference SDK failure degrades open without blocking task', degradedModel.calls === 1 && degraded.cloudMemoryStatus.includes('degraded'));
await degraded.shutdown();
const noStateRoot = path.join(home, 'disabled-project'); await mkdir(noStateRoot); await configure();
const noState = await AgentRuntime.create({ projectRoot: noStateRoot, session: { kind: 'new' }, permissionBridge: async () => ({ allowed: false }) }); await drain(noState); await noState.shutdown();
let exists = true; try { await stat(cloudDirectory(config, noStateRoot)); } catch { exists = false; }
assert('disabled creates no project cloud state', !exists);
setRuntimeModelFactoryForTest(undefined);
const cliFile = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cliDisabled = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, cliFile, 'cloud-memory', 'status'], { cwd: root, encoding: 'utf8', timeout: 10000 });
assert('headless cloud command is local when disabled', cliDisabled.status === 0 && cliDisabled.stdout.includes('AgentCore: disabled'));
await configure({ ...config, upload: 'off' });
const beforeCli = (await calls()).length;
const cliStatus = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, cliFile, 'cloud-memory', 'status'], { cwd: root, encoding: 'utf8', timeout: 10000 });
assert('headless status starts no model and invokes no AWS', cliStatus.status === 0 && cliStatus.stdout.includes('AgentCore: enabled') && (await calls()).length === beforeCli);

header('Host regressions: real schema, mixed records and literal runtime preference data');
assert('64-character project ID accepted', parseAgentCoreConfig({ ...config, projectId: 'a'.repeat(64) })?.projectId?.length === 64);
await rejects('65-character project ID refused', () => parseAgentCoreConfig({ ...config, projectId: 'a'.repeat(65) }));
assert('real SDK CreateEvent serializes ISO outbox timestamp to epoch seconds', createCall.input.eventTimestamp === Date.parse(JSON.parse(preview.slice(0, preview.indexOf('\nReview for private material'))).eventTimestamp) / 1000);
assert('SDK wire preserves custom project namespace value at its 64-character bound', createCall.input.extractionConfig.namespaceVariables.projectid.length === 64);
const payload = createCall.input.payload.map((entry: any) => entry.conversational);
assert('literal user preference eligible as USER, actions/results TOOL, host metadata OTHER', payload[0].role === 'OTHER' && payload[1].role === 'USER' && payload[1].content.text.startsWith('Use concise replies') && payload.length === 3 && payload[2].role === 'TOOL' && JSON.parse(payload[2].content.text).result.exitCode === 1);
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
function cli(...args: string[]) { return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, cliFile, 'cloud-memory', ...args], { cwd: root, encoding: 'utf8', timeout: 10000 }); }
await configure({ ...config, preferences: true, upload: 'off' }); await control({ records: [prettyRecord] });
const proofFile = path.join(cloudDirectory(config), `${id}.json`);
const proofBefore = await readFile(proofFile, 'utf8');
const readInspect = cli('inspect', id);
assert('CLI inspect succeeds without proof mutation', readInspect.status === 0 && readInspect.stdout.includes('Read-only inspection') && await readFile(proofFile, 'utf8') === proofBefore);
for (const args of [['confirm', id, literalHash, 'global'], ['send', token, previewHash], ['delete', id, 'cloud'], ['forget', id], ['discard', token], ['clear-accepted'], ['nonsense']]) {
  const result = cli(...args); assert(`CLI ${args[0]} refusal is nonzero`, result.status === 1 && result.stderr.includes('Headless mutations unavailable'));
}
await configure({ ...config, upload: 'off' }); await control({ mode: 'error' });
const missing = cli('preferences'); assert('CLI retrieval failure exits nonzero', missing.status === 1 && missing.stdout.includes('SDK request failed'));
await configure({ ...config, preferences: false }); await control({});
await writeFile(permissionRulesPath(root), JSON.stringify({ allow: ['bash:*'] }));
for (const args of [['confirm', id, literalHash, 'global'], ['send', token, previewHash], ['delete', id, 'cloud']]) {
  const command = [process.execPath, '--import', import.meta.resolve('tsx'), '--import', preload, cliFile, 'cloud-memory', ...args].map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
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
const cliCancel = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, cliFile, 'cloud-memory', 'preferences'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let cancelledText = ''; cliCancel.stdout.on('data', chunk => { cancelledText += String(chunk); });
const priorCalls = (await calls()).length;
for (let n = 0; n < 300 && (await calls()).length === priorCalls; n++) await delay(10);
const cancelledExit = new Promise<number | null>(resolve => cliCancel.once('close', resolve)); cliCancel.kill('SIGINT');
const cancellationCode = await cancelledExit;
assert('CLI cancellation exits nonzero with explicit failure', cancellationCode === 1 && cancelledText.includes('cancelled'));
if (cancellationCode !== 1 || !cancelledText.includes('cancelled')) console.log({ cancellationCode, cancelledText });
// Credential-chain and endpoint exclusion tests live in verifyTransport, through signed requests.
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
assert('actual runtime SDK wire retains pnpm test action before error exit evidence', runtimeSteps.length === 1 && runtimeSteps[0]?.input.content.command === 'pnpm test' && runtimeSteps[0]?.result.status === 'success' && runtimeSteps[0]?.failed === true && runtimeSteps[0]?.result.exitCode === 1);
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
assert('denied compaction made no SDK request', (await calls()).length === beforeCompact);
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
const lifecycleRecorder = new TrajectoryRecorder({ file: lifecycleFile, run: { session: 'capacity-session', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'none', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => lifecycle.settle(settlement) });
for (let index = 1; index <= 33; index++) {
  const next = lifecycleRecorder.beginTurn(`Synthetic capacity goal ${index}`); await next?.inputDurable();
  lifecycle.uploadObserver!.begin(next!.turn, `Synthetic capacity goal ${index}`);
  next?.record(new AgentResultEvent({ agent: wireAgent, invocationState: wireInvocation, result: new AgentResult({ invocationState: wireInvocation, stopReason: 'endTurn', lastMessage: new Message({ role: 'assistant', content: [] }) }) })); next?.end();
  await lifecycleRecorder.close(); // Public flush barrier; no polling the detached settlement.
  const rows = (await lifecycle.command('pending')).split('\n'); const pendingToken = rows.find(row => row.includes('pending; not uploaded'))?.split(' ')[0]!;
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
  assert('cancel after local revocation starts neither Get nor Delete SDK Command', !result.ok && result.text.includes('not undone') && (await calls()).length === beforeCancel && (await readState(narrowProof) as { approved?: string }).approved === undefined);
  assert('cancelled delete cleans preference lock', !(await stateNames(cloudDirectory(narrowConfig))).includes('active.json'));
} finally { pause.clear(); }
const narrowFile = path.join(home, 'cancel-narrow-trajectory.jsonl');
const narrowRecorder = new TrajectoryRecorder({ file: narrowFile, run: { session: 'cancel-narrow', agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'none', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => narrow.settle(settlement) });
const narrowTurn = narrowRecorder.beginTurn('Synthetic cancellation goal'); await narrowTurn?.inputDurable();
narrow.uploadObserver!.begin(narrowTurn!.turn, 'Synthetic cancellation goal');
narrowTurn?.record(new AgentResultEvent({ agent: wireAgent, invocationState: wireInvocation, result: new AgentResult({ invocationState: wireInvocation, stopReason: 'endTurn', lastMessage: new Message({ role: 'assistant', content: [] }) }) })); narrowTurn?.end(); await narrowRecorder.close();
const narrowToken = (await narrow.command('pending')).split(' ')[0]!;
const narrowPreview = await narrow.command(`preview ${narrowToken}`);
const narrowHash = narrowPreview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)![1]!;
const narrowBox = outboxPath(narrowConfig, root);
const attemptFile = path.join(narrowBox, `${narrowToken}.attempt-1.json`);
pause = pauseState(attemptFile, 'before-publish');
try {
  const sending = narrow.commandResult(`send ${narrowToken} ${narrowHash}`, 'user'); await bounded(pause.entered);
  assert('send reaches local reservation without a capability subprocess', await readState(attemptFile) === undefined);
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

await memory.close(); setMemoryTransportOptionsForTest(undefined);
server.kill('SIGTERM');
await new Promise<void>(resolve => server.once('close', () => resolve()));
report();

async function verifyTransport() {
  header('SDK transport bounds, normalization and manual compatibility');
  const get = { memoryId: config.memoryId, memoryRecordId: id, namespace: scope.preferences };
  const client = new MemoryTransport(config);
  await control({ records: [] });
  const retrieve = { memoryId: config.memoryId, namespacePath: scope.preferences, searchCriteria: { searchQuery: 'communication', topK: 1 } };
  const empty = await client.call('retrieve-memory-records', retrieve);
  assert('service empty retrieval with searchType becomes the existing plain envelope', JSON.stringify(empty) === JSON.stringify({ memoryRecordSummaries: [] }));
  await control({ records: [record('preference', { metadata: { searchType: { stringValue: 'record metadata is retained' } } })] });
  const nonempty = await client.call('retrieve-memory-records', retrieve) as any;
  assert('searchType envelope omission preserves record metadata and Date normalization', !Object.hasOwn(nonempty, 'searchType') && nonempty.memoryRecordSummaries[0].metadata.searchType.stringValue === 'record metadata is retained' && nonempty.memoryRecordSummaries[0].createdAt === '2026-01-01T00:00:00.000Z');
  assert('nonempty retrieval with searchType still passes strict scope policy', (await memory.recall('preference', 'communication', 1)).records.length === 1);
  await control({ response: { memoryRecordSummaries: [], searchType: 's'.repeat(64) } });
  assert('searchType exact 64-character bound accepted and omitted', !Object.hasOwn(await client.call('retrieve-memory-records', retrieve) as object, 'searchType'));
  for (const searchType of [{ kind: 'search' }, [], null, 1, '', 's'.repeat(65), 'bad\nvalue', 'bad\u0000value', 'bad\u007fvalue', 'bad\u0085value', 'bad\u202evalue']) {
    await control({ response: { memoryRecordSummaries: [], searchType } });
    let error = '';
    try { await client.call('retrieve-memory-records', retrieve); } catch (caught) { error = String(caught); }
    assert('malformed searchType refused with fixed bounded error', error === 'Error: AgentCore response failed bounded validation; refused');
  }
  const wireRecord = { ...record('preference'), createdAt: 1767225600 };
  for (const response of [
    { memoryRecordSummaries: [], searchType: 'synthetic-search', differentUnknown: true },
    { memoryRecordSummaries: [{ ...wireRecord, searchType: 'nested unknown' }], searchType: 'synthetic-search' },
    { memoryRecordSummaries: [{ ...wireRecord, content: { ...wireRecord.content, searchType: 'nested unknown' } }], searchType: 'synthetic-search' },
    { memoryRecordSummaries: [{ ...wireRecord, metadata: { searchType: { arbitrary: 'unknown metadata union' } } }], searchType: 'synthetic-search' },
  ]) {
    await control({ response });
    await rejects('searchType exception does not allow other top-level or nested unknown fields', () => client.call('retrieve-memory-records', retrieve));
  }
  await control({ records: [record('preference', { namespaces: ['/users/other/'] })] });
  await rejects('searchType envelope does not weaken record namespace validation', () => memory.recall('preference', 'communication', 1));
  await control({ response: { memoryRecord: wireRecord, searchType: 'synthetic-search' } });
  await rejects('GetMemoryRecord has no searchType compatibility exception', () => client.call('get-memory-record', get));
  await control({ response: { memoryRecordId: id, searchType: 'synthetic-search' } });
  await rejects('DeleteMemoryRecord has no searchType compatibility exception', () => client.call('delete-memory-record', get));
  await control({ response: { event: { memoryId: config.memoryId, actorId: config.actorId, sessionId: 'synthetic-search', eventId: 'synthetic-event', eventTimestamp: 1767225600 }, searchType: 'synthetic-search' } });
  await rejects('CreateEvent has no searchType compatibility exception', () => client.call('create-event', { memoryId: config.memoryId, actorId: config.actorId, sessionId: 'synthetic-search', eventTimestamp: '2026-01-01T00:00:00Z', clientToken: 's'.repeat(64), payload: [{ conversational: { role: 'OTHER', content: { text: 'synthetic' } } }] }));
  const legacy = new CloudMemory(parseAgentCoreConfig({ ...config, cliPath: '/nonexistent/ignored' })!, root, 'legacy');
  assert('legacy executable accepted with bounded notice, new config has no cliPath default', legacy.status().includes('deprecated and ignored') && !legacy.status().includes('/nonexistent/ignored') && config.cliPath === undefined);
  for (const cliPath of ['relative', 123, '/' + 'x'.repeat(1024)]) await rejects('malformed legacy path remains invalid', () => parseAgentCoreConfig({ ...config, cliPath }));
  await control({ records: [record('preference', { metadata: { tag: { stringValue: 'keep' }, at: { dateTimeValue: 1767225600 } } })] });
  const normalized = await client.call('get-memory-record', get) as any;
  assert('SDK Dates become ISO strings and only envelope metadata removed', !('$metadata' in normalized) && normalized.memoryRecord.createdAt === '2026-01-01T00:00:00.000Z' && normalized.memoryRecord.metadata.at.dateTimeValue === '2026-01-01T00:00:00.000Z' && normalized.memoryRecord.metadata.tag.stringValue === 'keep');
  validateRecord(normalized.memoryRecord, 'preference', config, root);
  assert('Get namespace IAM condition reaches wire', (await calls()).at(-1).input.namespace === scope.preferences);
  await client.call('delete-memory-record', get);
  assert('Delete command and namespace IAM condition reach wire', (await calls()).at(-1).operation === 'delete-memory-record' && (await calls()).at(-1).input.namespace === scope.preferences);
  const responses = [
    { memoryRecord: { ...record('preference'), createdAt: 1767225600, extra: true } },
    { memoryRecord: { ...record('preference'), createdAt: 1767225600, content: { text: 'safe', forged: true } } },
    { memoryRecord: { ...record('preference'), createdAt: 1767225600 }, unexpected: true },
    { $metadata: { fake: true }, memoryRecord: { ...record('preference'), createdAt: 1767225600 } },
    { memoryRecord: { ...record('preference'), createdAt: 1767225600, content: { text: 42 } } },
    { memoryRecord: { ...record('preference'), createdAt: 1767225600, metadata: null } },
  ];
  for (const response of responses) {
    await control({ response });
    await rejects('unknown or malformed remote fields are refused across SDK and policy boundary', async () => {
      const output = await client.call('get-memory-record', get) as any;
      validateRecord(output.memoryRecord, 'preference', config, root);
    });
  }
  await control({ records: [record('preference', { metadata: { actorId: { stringValue: 'other-actor' } } })] });
  await rejects('malicious metadata survives SDK boundary and fails policy validation', () => memory.recall('preference', 'communication', 1));
  const oldConfig = parseAgentCoreConfig({ ...config, cliPath: '/nonexistent/legacy' })!;
  assert('removing legacy cliPath preserves namespace and durable state binding', JSON.stringify(scopeFor(oldConfig, root)) === JSON.stringify(scopeFor(config, root)) && cloudDirectory(oldConfig, root) === cloudDirectory(config, root));
  // Legacy CLI timestamp metadata differs only in formatting, but evidence hashes
  // must not be silently migrated. Preserve the stored proof and request re-review.
  const legacyRecord = record('preference', { metadata: { at: { dateTimeValue: '2026-01-01T00:00:00+00:00' } } });
  const legacyHash = validateRecord(legacyRecord, 'preference', config, root).hash;
  const proofFile = path.join(cloudDirectory(config), `${id}.json`);
  await writeState(proofFile, { version: 1, approved: legacyHash });
  const proofBytes = await readFile(proofFile, 'utf8');
  await control({ records: [record('preference', { metadata: { at: { dateTimeValue: 1767225600 } } })] });
  const review = new CloudMemory({ ...config, preferences: true }, root, 'timestamp-review'); await review.startup();
  assert('legacy datetime metadata approval is not applied or silently rewritten', await review.context() === '' && await readFile(proofFile, 'utf8') === proofBytes);
  assert('metadata hash mismatch reports bounded inspect/confirm re-review guidance', review.status().includes('require re-review') && review.status().includes('/cloud-memory inspect') && review.status().includes('confirm') && !review.status().includes(legacyHash));
  const reviewed = await review.command(`inspect ${id}`);
  const sdkHash = validateRecord(record('preference', { metadata: { at: { dateTimeValue: '2026-01-01T00:00:00.000Z' } } }), 'preference', config, root).hash;
  assert('format-only change still requires fresh inspection and explicit confirmation', sdkHash !== legacyHash && reviewed.includes(sdkHash) && (await review.command(`confirm ${id} ${sdkHash} global`)).includes('explicitly adopted'));
  assert('fresh byte-identical metadata proof applies and clears re-review notice', (await review.context()).includes('concise') && !review.status().includes('require re-review'));
  const restoredReview = new CloudMemory({ ...config, preferences: true }, root, 'timestamp-restored'); await restoredReview.startup();
  assert('byte-identical datetime metadata approval survives new controller startup', (await restoredReview.context()).includes('concise') && !restoredReview.status().includes('require re-review'));
  await restoredReview.close();
  await review.command(`forget ${id}`); await review.context();
  assert('revoked proof is not mislabeled as a changed approval', !review.status().includes('require re-review'));
  await review.close(); await unlink(proofFile); await unlink(`${proofFile}.inspection`);
  // Numeric service timestamps and SDK Dates must not change content/proof hashes without metadata.
  await control({ records: [record('preference')] });
  const dated = await client.call('get-memory-record', get) as any;
  assert('legacy preference content hash survives SDK Date/envelope normalization', validateRecord(dated.memoryRecord, 'preference', config, root).hash === validateRecord(record('preference'), 'preference', config, root).hash);
  for (const raw of ['{"x":' + '['.repeat(25) + '0' + ']'.repeat(25) + '}', JSON.stringify({ memoryRecordSummaries: Array(10001).fill(null) })]) {
    await control({ raw }); await rejects('pre-deserialization structure depth/count finite', () => client.call('get-memory-record', get));
  }
  for (const [mode, expected] of [['large', '256 KiB'], ['diagnostics', '8 KiB'], ['invalid-json', 'SDK request failed'], ['error', 'HTTP 503'], ['hang', 'timed out'], ['body-hang', 'timed out']]) {
    await control({ mode }); const before = (await calls()).length; let message = '';
    try { await client.call('get-memory-record', get); } catch (error) { message = String(error); }
    assert(`${mode}: bounded safe error and maxAttempts one`, message.includes(expected!) && !message.includes('secret service') && (await calls()).length === before + 1);
  }
  await control({ records: [] });
  const input = { memoryId: config.memoryId, namespacePath: scope.episodes, searchCriteria: { searchQuery: '', topK: 1 } };
  const room = 32000 - Buffer.byteLength(JSON.stringify(input));
  input.searchCriteria.searchQuery = 'é'.repeat(Math.floor(room / 2)) + (room % 2 ? 'a' : '');
  await client.call('retrieve-memory-records', input);
  assert('exact multibyte 32000-byte input accepted through SDK serialization', Buffer.byteLength(JSON.stringify(input)) === 32000 && (await calls()).at(-1).input.searchCriteria.searchQuery === input.searchCriteria.searchQuery);
  const before = (await calls()).length;
  await rejects('32001-byte input rejected before signing/HTTP', () => client.call('retrieve-memory-records', { ...input, searchCriteria: { ...input.searchCriteria, searchQuery: input.searchCriteria.searchQuery + 'a' } }));
  const pre = new AbortController(); pre.abort();
  await rejects('pre-abort prevents credential/request work', () => client.call('get-memory-record', get, pre.signal));
  const immediate = client.call('get-memory-record', get); client.cancel();
  await rejects('immediate per-Agent cancel before first await', () => immediate);
  assert('oversize and early abort never reach HTTP', (await calls()).length === before);
  for (const kind of ['signal', 'agent', 'deadline', 'destroy'] as const) {
    let release!: () => void; let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    let handlerCalls = 0;
    setMemoryTransportOptionsForTest(() => {
      const handler = loopbackHandler(port);
      return { credentials: async () => { entered(); await held; return { accessKeyId: 'AKIDDELAYED', secretAccessKey: 'synthetic' }; }, requestHandler: { ...handler, handle: (...args: Parameters<typeof handler.handle>) => { handlerCalls++; return handler.handle(...args); } } };
    });
    const delayed = new MemoryTransport({ ...config, timeoutMs: 100 }); const abort = new AbortController();
    const start = performance.now();
    const result = delayed.call('get-memory-record', get, abort.signal).then(() => '', error => String(error));
    await bounded(ready);
    if (kind === 'signal') abort.abort(); else if (kind === 'agent') delayed.cancel(); else if (kind === 'destroy') delayed.destroy();
    const message = await bounded(result);
    assert(`${kind} returns during unresolved credential wait within total deadline`, message.includes(kind === 'deadline' ? 'timed out' : 'cancelled') && performance.now() - start < 1000);
    release(); await delay(40);
    assert(`${kind} credential resolution cannot later reach signed HTTP handler`, handlerCalls === 0);
    delayed.destroy();
  }
  setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(port) }));
  await control({ mode: 'hang' });
  const parallelA = new MemoryTransport({ ...config, timeoutMs: 5000 }); const parallelB = new MemoryTransport({ ...config, timeoutMs: 5000 });
  const parallelBefore = (await calls()).length; let bSettled = false;
  const a1 = parallelA.call('get-memory-record', get).catch(error => error);
  const a2 = parallelA.call('get-memory-record', get).catch(error => error);
  const b = parallelB.call('get-memory-record', get).catch(error => error).finally(() => { bSettled = true; });
  for (let n = 0; n < 300 && (await calls()).length < parallelBefore + 3; n++) await delay(10);
  parallelA.cancel(); await Promise.all([a1, a2]);
  assert('per-Agent cancel isolates concurrent other-Agent request', !bSettled && (await calls()).length === parallelBefore + 3);
  parallelB.destroy(); await b; await rejects('destroy latches future requests', () => parallelB.call('get-memory-record', get));
  await control({ records: [record('preference')] }); await parallelA.call('get-memory-record', get);
  assert('cancel leaves next ordinary request usable', (await calls()).at(-1).operation === 'get-memory-record'); parallelA.destroy();
  const endpointKeys = ['AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_BEDROCK_AGENTCORE', 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS', 'AWS_REGION'] as const;
  const saved = endpointKeys.map(key => process.env[key]);
  try {
    Object.assign(process.env, { AWS_ENDPOINT_URL: 'https://invalid.example', AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: 'https://invalid.example', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false', AWS_REGION: 'eu-west-1' });
    const endpoint = new MemoryTransport(config); await endpoint.call('get-memory-record', get); endpoint.destroy();
    const wire = (await calls()).at(-1);
    assert('environment endpoints ignored, configured region signs actual SDK request', !wire.headers.host.includes('invalid.example') && wire.headers.authorization.includes('/us-west-2/bedrock-agentcore/aws4_request'));
    assert('transport never mutates global endpoint/credential environment', process.env['AWS_ENDPOINT_URL'] === 'https://invalid.example' && process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] === 'false');
  } finally { endpointKeys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; }); }
  // Fresh CLI processes exercise the official profile/container chain, not fake clients.
  const credentialFile = path.join(home, 'synthetic-credentials');
  const awsConfig = path.join(home, 'synthetic-aws-config');
  await writeFile(credentialFile, '[synthetic]\naws_access_key_id = AKIDPROFILE\naws_secret_access_key = synthetic\n');
  await writeFile(awsConfig, '[profile synthetic]\nregion = eu-west-1\nendpoint_url = https://invalid.example\nservices = synthetic\n[services synthetic]\nbedrock-agentcore =\n  endpoint_url = https://invalid.example\n');
  const chainEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_')));
  Object.assign(chainEnv, { AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: awsConfig, AWS_SHARED_CREDENTIALS_FILE: credentialFile });
  await mkdir(path.dirname(configPath(root)), { recursive: true });
  await writeFile(configPath(root), JSON.stringify({ agentCoreMemory: { ...config, cliPath: '/nonexistent/legacy', upload: 'off' } }));
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  function chain(env: NodeJS.ProcessEnv) { return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, cliPath, 'cloud-memory', 'inspect', id], { cwd: root, env: { ...chainEnv, ...env }, encoding: 'utf8', timeout: 10000 }); }
  const profile = chain({ AWS_PROFILE: 'synthetic' });
  assert('official profile credentials sign, shared-config endpoints ignored, legacy path unused', profile.status === 0 && profile.stderr.includes('deprecated and ignored') && (await calls()).at(-1).headers.authorization.includes('Credential=AKIDPROFILE/') && !(await calls()).at(-1).headers.host.includes('invalid.example'));
  // Standard source_profile/role_arn resolution must use STS's XML decoder and
  // independent credential HTTP, never the AgentCore abort/body guard.
  const roleConfig = path.join(home, 'synthetic-role-config');
  const roleArn = 'arn:aws:iam::000000000000:role/synthetic-test'; // Deliberately fictitious account.
  await writeFile(roleConfig, `[profile assumed]\nrole_arn = ${roleArn}\nsource_profile = synthetic\nrole_session_name = synthetic-session\nregion = us-west-2\nendpoint_url = https://invalid.example\nservices = synthetic\n[services synthetic]\nsts =\n  endpoint_url = https://invalid.example\nbedrock-agentcore =\n  endpoint_url = https://invalid.example\n`);
  const roleEnv = { AWS_PROFILE: 'assumed', AWS_CONFIG_FILE: roleConfig, AWS_ENDPOINT_URL: 'https://invalid.example', AWS_ENDPOINT_URL_STS: 'https://invalid.example', AWS_ENDPOINT_URL_BEDROCK_AGENTCORE: 'https://invalid.example', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false', AWS_MAX_ATTEMPTS: '4' };
  const roleBefore = (await calls()).length;
  const assumed = chain(roleEnv);
  assert('real AssumeRole profile resolves STS XML then signs AgentCore with assumed credentials', assumed.status === 0 && (await calls()).length === roleBefore + 1 && (await calls()).at(-1).headers.authorization.includes('Credential=AKIDASSUMED/') && (await calls()).at(-1).headers['x-amz-security-token'] === 'synthetic-assumed-token');
  async function stsCalls(): Promise<any[]> { try { return (await readFile(path.join(home, 'fixture-sts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } }
  const sts = (await stsCalls()).at(-1);
  assert('AssumeRole uses synthetic source credentials and rejects configured STS/AgentCore endpoints', sts?.input.RoleArn === roleArn && sts?.input.RoleSessionName === 'synthetic-session' && sts?.headers.authorization.includes('Credential=AKIDPROFILE/') && sts?.headers.host === 'sts.us-west-2.amazonaws.com' && !(await calls()).at(-1).headers.host.includes('invalid.example'));
  await control({ stsError: true }); const stsBefore = (await stsCalls()).length;
  const roleFailure = chain(roleEnv);
  assert('STS failure has one attempt despite env retry override and no memory request', roleFailure.status === 1 && (await stsCalls()).length === stsBefore + 1 && (await calls()).length === roleBefore + 1 && !roleFailure.stdout.includes('synthetic secret'));
  const transportModule = fileURLToPath(new URL('../src/agentcore/transport.ts', import.meta.url));
  for (const mode of ['abort', 'timeout'] as const) {
    await control({ pauseSts: true, records: [record('preference')] });
    const beforeMemory = (await calls()).length;
    const probe = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', preload, '--input-type=module', '-e', `
      import { MemoryTransport } from ${JSON.stringify(transportModule)};
      const memory = new MemoryTransport(${JSON.stringify({ ...config, timeoutMs: 600 })});
      const abort = new AbortController();
      process.on('message', message => { if (message === 'abort') abort.abort(); if (message === 'finish') { memory.destroy(); process.disconnect(); } });
      const result = await memory.call('get-memory-record', ${JSON.stringify(get)}, abort.signal).then(() => 'unexpected success', error => error.message);
      process.send(result);
    `], { env: { ...chainEnv, ...roleEnv }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const outcome = new Promise<string>(resolve => probe.once('message', result => resolve(String(result))));
    const exited = new Promise<void>(resolve => probe.once('close', () => resolve()));
    try {
      for (let n = 0; n < 300; n++) { try { await stat(path.join(home, 'fixture-sts-paused')); break; } catch { await delay(10); } }
      await stat(path.join(home, 'fixture-sts-paused'));
      if (mode === 'abort') probe.send('abort');
      const result = await bounded(outcome);
      assert(`actual AssumeRole ${mode} settles while STS is still awaiting response`, result.includes(mode === 'abort' ? 'cancelled' : 'timed out'));
      await writeFile(path.join(home, 'fixture-sts-release'), 'release');
      await delay(200); // Let STS XML decoding and late signer continuation finish.
      assert(`released AssumeRole after ${mode} never sends late AgentCore request`, (await calls()).length === beforeMemory);
      probe.send('finish'); await bounded(exited);
    } finally { probe.kill('SIGKILL'); await unlink(path.join(home, 'fixture-sts-paused')).catch(() => {}); await unlink(path.join(home, 'fixture-sts-release')).catch(() => {}); }
  }
  await control({ records: [record('preference')] });
  const tokenFile = path.join(home, 'synthetic-token'); await writeFile(tokenFile, 'synthetic-file-token');
  for (const auth of [{ AWS_CONTAINER_AUTHORIZATION_TOKEN: 'synthetic-direct-token' }, { AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: tokenFile }]) {
    const container = chain({ AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'absent'), AWS_CONFIG_FILE: path.join(home, 'absent'), AWS_CONTAINER_CREDENTIALS_FULL_URI: `http://127.0.0.1:${port}/credentials`, ...auth });
    assert('official container credentials and authorization token/file used', container.status === 0 && (await calls()).at(-1).headers.authorization.includes('Credential=AKIDCONTAINER/'));
  }
  const credentialCalls = (await readFile(path.join(home, 'fixture-credentials.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert('container token and token-file reach only credential endpoint', credentialCalls.some(call => call.authorization === 'synthetic-direct-token') && credentialCalls.some(call => call.authorization === 'synthetic-file-token'));
  const noCredentials = chain({ AWS_CONFIG_FILE: path.join(home, 'absent'), AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'absent') });
  assert('official IMDS disable gives bounded nonzero CLI failure without credentials', noCredentials.status === 1 && noCredentials.stdout.includes('SDK request failed') && !noCredentials.stdout.includes('AKID'));
  await unlink(configPath(root));
  // Exercise the SDK's real Node HTTP handler against loopback too. A TCP listener
  // that never speaks TLS reproduces connection timeout without contacting AWS.
  const { BedrockAgentCoreClient } = await import('@aws-sdk/client-bedrock-agentcore');
  const { createServer } = await import('node:net');
  const sockets = new Set<import('node:net').Socket>();
  const silent = createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
  const silentPort = (silent.address() as import('node:net').AddressInfo).port;
  const provider = new BedrockAgentCoreClient({ region: config.region, requestHandler: { connectionTimeout: 80, requestTimeout: 200, throwOnRequestTimeout: true } });
  const defaultHandler = provider.config.requestHandler;
  let destroyed = false;
  setMemoryTransportOptionsForTest(() => ({ requestHandler: {
    ...defaultHandler,
    updateHttpClientConfig: () => {}, httpHandlerConfigs: () => ({}),
    handle: (request: any, options: any) => defaultHandler.handle({ ...request, hostname: '127.0.0.1', port: silentPort }, options),
    destroy: () => { destroyed = true; provider.destroy(); },
  } }));
  const connection = new MemoryTransport(config); const connectStart = performance.now();
  await rejects('real SDK Node handler TLS connection timeout', () => connection.call('get-memory-record', get));
  assert('connection timeout occurs before total deadline', performance.now() - connectStart < 900);
  connection.destroy(); assert('transport destroy forwards to SDK HTTP handler', destroyed);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>(resolve => silent.close(() => resolve()));
  setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(port) }));
  const source = await readFile(new URL('../src/agentcore/transport.ts', import.meta.url), 'utf8');
  assert('transport imports no subprocess/files and has no temp/CLI/capability path', !/node:(?:child_process|fs)|mkdtemp|cliPath|requireExtraction|process\.env/.test(source));
  client.destroy(); await legacy.close();
}
