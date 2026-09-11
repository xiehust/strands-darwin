/** Upload v2: original public SDK data, bounded bytes, lifecycle and real runtime.
 * Offline only, isolated HOME. No archive hydration or cloud requests. */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Agent, Model, ModelError, BeforeToolCallEvent, AfterToolCallEvent, ToolUseBlock, ToolResultBlock, TextBlock, JsonBlock, ImageBlock, tool, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { z } from 'zod';
import { capture, sliceText, UploadTurn, UploadObserver, uploadBody, MAX_ACTION_BYTES, MAX_EVENT_BYTES } from '../src/agentcore/upload-projection.js';
import { CloudMemory } from '../src/agentcore/controller.js';
import { parseAgentCoreConfig, digest } from '../src/agentcore/config.js';
import { cloudDirectory, readState, setCloudStateObserverForTest } from '../src/agentcore/state.js';
import { AgentRuntime, setRuntimeModelFactoryForTest, setRuntimeRecorderOverridesForTest } from '../src/agent/runtime.js';
import { trajectoryPath } from '../src/agent/session.js';
import { configPath } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
const home = ownPrivateHome('agentcore-upload'); const root = path.join(home, 'project'); await mkdir(root);
const config = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'synthetic-user', episodicStrategyId: 'episodes-0123456789', preferenceStrategyId: 'preferences-0123456789', preferences: false, upload: 'manual' })!;
const agent = new Agent({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
const state = {};
const settlement = { durable: true as const, session: 'synthetic-session', turn: 1, seq: 99, at: '2026-01-01T00:00:00Z', stopReason: 'endTurn', failure: false, partial: false };
const envelope = { memoryId: config.memoryId, actorId: config.actorId, sessionId: settlement.session, eventTimestamp: settlement.at, clientToken: 'a'.repeat(64), extractionConfig: { namespaceVariables: { projectid: 'synthetic' } } };
function events(id: string, input: object, content = [new TextBlock('ok')] as ToolResultBlock['content'], name = 'arbitrary-mcp_secret') {
  const use = new ToolUseBlock({ name, toolUseId: id, input: input as ToolUseBlock['input'] });
  return [new BeforeToolCallEvent({ agent, invocationState: state, tool: undefined, toolUse: use }), new AfterToolCallEvent({ agent, invocationState: state, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: id, status: 'success', content }) })] as const;
}
function add(turn: UploadTurn, id: string, input: object, content?: ToolResultBlock['content'], name?: string) { const [before, after] = events(id, input, content, name); turn.before(before); turn.after(after); }
const bodyOf = (turn: UploadTurn) => uploadBody(envelope, turn, settlement)!;
const actionsOf = (body: ReturnType<typeof bodyOf>) => body.payload.filter(p => p.conversational.role === 'TOOL').map(p => JSON.parse(p.conversational.content.text));

header('Original text, pairing and explicit exclusions');
const goal = '/workflow inspect /home/user/.env\npassword token secret\n<markup>{hello}`\\ end';
const turn = new UploadTurn(1, goal);
const input = { path: '/home/user/.env', command: 'cat secret\npassword token', nested: { value: '<tag>\\raw</tag>' } };
add(turn, 'one', input, [new TextBlock('password token\n/secret/path <tag>'), new JsonBlock({ json: { exitCode: 7, nested: input } }), new ImageBlock({ format: 'png', source: { bytes: Buffer.from('BINARY-MARKER') } })]);
add(turn, 'recovery', { command: 'fix /secret' }, undefined, 'subagent');
add(turn, 'memory', { query: 'secret' }, [new TextBlock('public memory report')], 'memory_recall');
const body = bodyOf(turn); const actions = actionsOf(body);
assert('literal slash/multiline goal exact', body.payload[1]!.conversational.content.text === goal);
assert('arbitrary MCP complete identity/input/result exact, nonzero exit despite success', actions[0].invocation === 'one' && JSON.stringify(actions[0].input.content) === JSON.stringify(input) && actions[0].result.status === 'success' && actions[0].result.exitCode === 7 && actions[0].failed);
assert('public subagent and memory results not name-filtered', actions[1].tool === 'subagent' && actions[1].recovery && JSON.stringify(actions[2]).includes('public memory report'));
assert('binary/image excluded with explicit source loss', !JSON.stringify(body).includes('BINARY-MARKER') && actions[0].sourceLoss.length === 1);
const missing = new UploadTurn(2, ''); missing.before(events('cancel', { command: 'pending' })[0]); missing.finish();
const cancelled = uploadBody(envelope, missing, { ...settlement, stopReason: 'cancelled' })!;
assert('cancelled pending call has explicit absent result, never a fabricated success', actionsOf(cancelled)[0].result.missing.includes('No corresponding result') && JSON.parse(cancelled.payload[0]!.conversational.content.text).outcome === 'cancelled');
assert('no metadata-only event when no goal/actions', uploadBody(envelope, new UploadTurn(1, ''), settlement) === undefined);
const upstream = new UploadTurn(1, 'goal'); add(upstream, 'upstream', {}, [new TextBlock('[Offloaded: retrieve_offloaded_content; truncated: original missing]')]);
assert('already offloaded source explicitly limited, not hydrated', actionsOf(bodyOf(upstream))[0].sourceLoss[0].includes('upstream'));
const beforeBytes = JSON.stringify(input); capture(input); assert('projection never mutates source', JSON.stringify(input) === beforeBytes);
const immutable = events('immutable', input); const immutableBytes = immutable.map(e => JSON.stringify(e.toJSON()));
const copyTurn = new UploadTurn(1, goal); copyTurn.before(immutable[0]); copyTurn.after(immutable[1]);
assert('public SDK event objects and order remain immutable', immutable.every((e, i) => JSON.stringify(e.toJSON()) === immutableBytes[i]) && copyTurn.actions[0]!.invocation === 'immutable');


header('UTF-8, escaping, traversal and capacity');
for (const text of ['😀中\u0000\n\\"'.repeat(10000), 'a'.repeat(300000) + 'TAIL', '\ud800raw\udfff']) {
  const cut = sliceText(text, 1000);
  assert('exact Unicode-safe ranges and byte accounting', cut.retainedBytes <= 1000 && cut.parts.every((part, i) => part === text.slice(...cut.ranges[i]!)) && cut.retainedBytes === cut.parts.reduce((n, p) => n + Buffer.byteLength(p), 0));
  assert('bounded original byte measurement truthful', text.length > 262144 ? cut.originalBytes === null && cut.sourceLoss.length > 0 : cut.originalBytes === Buffer.byteLength(text));
}
let deep: object = {}; for (let i = 0; i < 10000; i++) deep = { child: deep };
const wide = Object.fromEntries(Array.from({ length: 100000 }, (_, i) => [`key-${i}`, 'value']));
for (const value of [deep, wide, new Array(1000000).fill('x'), { huge: 'x'.repeat(10000000) }, { bytes: Buffer.alloc(1000000) }]) {
  const start = performance.now(); const captured = capture(value);
  assert('huge/deep/wide/array/binary capture bounded and losses explicit', performance.now() - start < 1000 && Buffer.byteLength(JSON.stringify(captured)) < MAX_ACTION_BYTES && captured.losses.length > 0);
}
const adversarialKeys = Object.fromEntries(Array.from({ length: 32 }, (_, i) => ['\u0000'.repeat(120) + i, '😀'.repeat(20000)]));
const escapedAction = new UploadTurn(1, '\u0000'.repeat(20000));
add(escapedAction, '\u0000'.repeat(256), adversarialKeys, [new JsonBlock({ json: adversarialKeys })]);
assert('escaped names/keys/control payload obey full action and event byte bounds', escapedAction.actions.every(a => Buffer.byteLength(JSON.stringify(a)) <= MAX_ACTION_BYTES) && Buffer.byteLength(JSON.stringify(bodyOf(escapedAction))) <= MAX_EVENT_BYTES);
const many = new UploadTurn(1, goal);
for (let i = 0; i < 400; i++) add(many, `call-${i}`, { command: `operation-${i}`, text: '\u0000😀\\"'.repeat(10000) }, [new JsonBlock({ json: { exitCode: i === 350 ? 1 : 0, output: 'long original '.repeat(3000) + `TAIL-${i}` } })]);
const manyBody = bodyOf(many); const chosen = actionsOf(manyBody); const quality = JSON.parse(manyBody.payload[0]!.conversational.content.text).quality;
assert('serialized event and every message/action bounded after escaping', Buffer.byteLength(JSON.stringify(manyBody)) <= MAX_EVENT_BYTES && manyBody.payload.length <= 100 && manyBody.payload.every(p => Buffer.byteLength(p.conversational.content.text) <= 100000) && chosen.every(a => Buffer.byteLength(JSON.stringify(a)) <= MAX_ACTION_BYTES));
assert('failure/recovery and tail verification prioritized with complete chronological pairs', [350, 351, 399].every(i => chosen.some(a => a.invocation === `call-${i}` && a.result.status === 'success')) && chosen.every((a, i) => i === 0 || a.ordinal > chosen[i - 1].ordinal));
assert('capacity, content and internal omissions separate and truthful', quality.actionBodiesOmitted === 400 - chosen.length && quality.contentTruncatedActions > 0 && quality.internalEventsExcluded === 0 && quality.actionSummariesOmitted > 0);
assert('live action and summary windows bounded', many.actions.length <= 64 && many.summaries.length <= 96 && many.pending.size === 0);
for (let i = 0; i < 1000; i++) many.before(events(`pending-${i}`, { text: 'p'.repeat(20000) })[0]);
assert('many pending calls bounded including missing-result actions', many.pending.size <= 64 && many.actions.every(a => Buffer.byteLength(JSON.stringify(a)) <= MAX_ACTION_BYTES));
const observer = new UploadObserver(); for (let i = 1; i <= 30; i++) observer.begin(i, goal);
assert('unsettled turn queue bounded', observer.retainedTurns === 8); observer.clear(); assert('close clears all transient turns', observer.retainedTurns === 0);
const cloud = new CloudMemory(config, root, settlement.session);
cloud.uploadObserver!.begin(1, goal); cloud.settle({ durable: false, turn: 1, reason: 'synthetic nondurable' });
assert('nondurable settlement discards collection', cloud.uploadObserver!.retainedTurns === 0 && (await cloud.command('pending')).includes('No pending'));
await cloud.close();


header('Queue, late-result identity and nonthrowing observer');
const lateObserver = new UploadObserver();
const oldEvents = events('same-id', { command: 'old' });
lateObserver.begin(1, 'old goal'); lateObserver.before(oldEvents[0]); lateObserver.end();
lateObserver.begin(2, 'new goal'); lateObserver.after(oldEvents[1]);
const newTurn = lateObserver.take(2)!;
assert('late previous-invocation result cannot mix into next turn', newTurn.actions.length === 0 && newTurn.unmatchedResults === 1);
lateObserver.clear();
const saturated = new CloudMemory(config, root, 'saturated');
for (let i = 1; i <= 10; i++) {
  saturated.uploadObserver!.begin(i, `queued ${i}`);
  saturated.settle({ ...settlement, session: 'saturated', turn: i, seq: i });
}
assert('detached queue refuses excess without retaining collector state', saturated.problem?.includes('queue full') === true && saturated.uploadObserver!.retainedTurns === 0);
await saturated.command('pending'); await saturated.close();
const throwingInput = new Proxy({}, { ownKeys() { throw new Error('untrusted accessor'); } });
lateObserver.begin(3, 'goal'); lateObserver.before(events('bad', throwingInput)[0]);
assert('observer failures are swallowed and recorded, never change source error identity', lateObserver.take(3)!.observerErrors === 1);
lateObserver.clear();
const closing = new CloudMemory(config, root, 'closing');
const closingBinding = digest([config.region, config.memoryId, config.actorId, closing.scope.projectId, config.episodicStrategyId, config.preferenceStrategyId]);
const closingToken = digest([closingBinding, 'closing', 1, 1]);
const closingFile = path.join(cloudDirectory(config, root), closingBinding, `${closingToken}.event.json`);
let release!: () => void; let entered!: () => void;
const paused = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
setCloudStateObserverForTest(async (file, boundary) => { if (file === closingFile && boundary === 'before-publish') { entered(); await paused; } });
closing.uploadObserver!.begin(1, 'closing goal'); closing.settle({ ...settlement, session: 'closing', seq: 1 });
await reached; await closing.close(); release();
// Public chain barrier, no sleep/poll: cancelled local publication must drain.
await (closing as unknown as { chain: Promise<void> }).chain;
setCloudStateObserverForTest(undefined);
assert('close timeout bars delayed candidate publication and releases transient state', await readState(closingFile) === undefined && closing.uploadObserver!.retainedTurns === 0);

header('Actual runtime captures original source before trajectory and offloader');
class UploadModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline-upload', contextWindowLimit: 2000000 };
  calls = 0;
  constructor(readonly count = 1, readonly failure?: Error) { super(); }
  updateConfig(value: BaseModelConfig) { this.config = { ...this.config, ...value }; }
  getConfig() { return this.config; }
  async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const index = this.calls++;
    if (index === this.count && this.failure) throw this.failure;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (index < this.count) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ASSISTANT-PRIVATE-MARKER' + 'a'.repeat(9000) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'arbitrary_upload_mcp', toolUseId: `runtime-${index}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ command: '/secret/path\npassword token', index }) } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ASSISTANT-PRIVATE-MARKER' } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}
async function createRuntime(offload: boolean, model: UploadModel, upload: 'manual' | 'off' = 'manual') {
  await mkdir(path.dirname(configPath(root)), { recursive: true });
  await writeFile(configPath(root), JSON.stringify({ provider: 'bedrock', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', trajectory: true, memory: false, promptCache: false, contextOffload: offload, agentCoreMemory: { ...config, upload } }));
  setRuntimeModelFactoryForTest(async () => model);
  const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: true }) });
  const sdk = (runtime as unknown as { agent: Agent }).agent;
  sdk.toolRegistry.add(tool({ name: 'arbitrary_upload_mcp', description: 'Synthetic original source', inputSchema: z.object({ command: z.string(), index: z.number() }), callback: ({ index }) => 'original '.repeat(6000) + `ORIGINAL-LATE-TAIL-${index}` }));
  return runtime;
}
for (const offload of [false, true]) {
  const runtime = await createRuntime(offload, new UploadModel(80));
  for await (const _event of runtime.send(goal)) {}
  const file = trajectoryPath(root, runtime.info.sessionId);
  const history = JSON.stringify((runtime as unknown as { agent: Agent }).agent.messages);
  assert(`offload ${offload}: result offloading actually ${offload ? 'occurred' : 'disabled'}`, offload ? history.includes('retrieve_offloaded_content') : history.includes('original '.repeat(6000)));
  await runtime.shutdown();
  const originalTrajectory = await readFile(file);
  const box = new CloudMemory(config, root, runtime.info.sessionId);
  const rows = (await box.command('pending')).split('\n');
  let preview = '';
  for (const row of rows) { const candidate = await box.command(`preview ${row.split(' ')[0]}`); if (candidate.includes(runtime.info.sessionId)) preview = candidate; }
  assert(`offload ${offload}: >1MiB trajectory and original >8000-cp result tail retained`, (await stat(file)).size > 1048576 && preview.includes('ORIGINAL-LATE-TAIL-79'));
  assert(`offload ${offload}: goal preserved, no assistant prose; projection read leaves trajectory immutable`, preview.includes('password token') && !preview.includes('ASSISTANT-PRIVATE-MARKER') && (await readFile(file)).equals(originalTrajectory));
  assert(`offload ${offload}: no 1MiB-tail projection failure`, !preview.includes('New turn unavailable'));
  await box.close();
}
const sentinel = new ModelError('identical-original-error');
const failing = await createRuntime(false, new UploadModel(1, sentinel));
let caught: unknown; try { for await (const _event of failing.send('failure goal')) {} } catch (error) { caught = error; }
assert('runtime failure rethrows identical error with collector enabled', caught === sentinel);
await failing.shutdown();
const abandoned = await createRuntime(false, new UploadModel());
for await (const event of abandoned.send('early return')) { if (event.type === 'beforeToolCallEvent') break; }
const abandonedCloud = (abandoned as unknown as { cloudMemory: CloudMemory }).cloudMemory;
await abandoned.shutdown();
assert('early stream return shuts down without hanging or retaining transient state', abandonedCloud.uploadObserver!.retainedTurns === 0);
const disabled = await createRuntime(false, new UploadModel(), 'off');
assert('upload off has no observer instance/state', (disabled as unknown as { cloudMemory: CloudMemory }).cloudMemory.uploadObserver === undefined);
for await (const _event of disabled.send('disabled')) {} await disabled.shutdown();
setRuntimeRecorderOverridesForTest({ openFile: async () => { throw new Error('Synthetic unavailable trajectory'); } });
const nondurable = await createRuntime(false, new UploadModel());
for await (const _event of nondurable.send('nondurable')) {}
const controller = (nondurable as unknown as { cloudMemory: CloudMemory }).cloudMemory;
await nondurable.shutdown();
assert('failed trajectory settlement and shutdown release transient collector', controller.uploadObserver!.retainedTurns === 0);
setRuntimeRecorderOverridesForTest(undefined); setRuntimeModelFactoryForTest(undefined);


report();
