/** Upload v2: original public SDK data, bounded bytes, lifecycle and real runtime.
 * Offline only, isolated HOME. No archive hydration or cloud requests. */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Agent, Model, ModelError, BeforeToolCallEvent, AfterToolCallEvent, BeforeToolsEvent, ToolResultEvent, HookOrder, ExecuteToolStage, ToolUseBlock, ToolResultBlock, TextBlock, JsonBlock, ImageBlock, tool, type BaseModelConfig, Message, type ModelStreamEvent } from '@strands-agents/sdk';
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
function events(id: string, input: object, content = [new TextBlock('ok')] as ToolResultBlock['content'], name = 'arbitrary-mcp_secret', invocationState = state) {
  const use = new ToolUseBlock({ name, toolUseId: id, input: input as ToolUseBlock['input'] });
  return [new BeforeToolCallEvent({ agent, invocationState, tool: undefined, toolUse: use }), new AfterToolCallEvent({ agent, invocationState, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: id, status: 'success', content }) })] as const;
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


header('Host regressions: full action allocation, collections, accessors and identity');
for (const size of [3000, 6000]) {
  const small = new UploadTurn(1, 'goal'); const text = 'x'.repeat(size) + 'TAIL';
  add(small, `small-${size}`, { query: 'small' }, [new TextBlock(text)]);
  const action = actionsOf(bodyOf(small))[0];
  assert(`${size} byte result plus tiny input retained exactly within full action cap`, action.result.content.content[0].text === text && action.result.content.losses.length === 0 && action.input.losses.length === 0 && Buffer.byteLength(JSON.stringify(action)) <= MAX_ACTION_BYTES);
}
const smallEscaped = new UploadTurn(1, 'goal'); const escapedText = '\\"\n中😀'.repeat(350);
add(smallEscaped, 'escaped-small', { query: 'tiny' }, [new TextBlock(escapedText)]);
assert('small escape-heavy result complete when serialized action fits', actionsOf(bodyOf(smallEscaped))[0].result.content.content[0].text === escapedText && actionsOf(bodyOf(smallEscaped))[0].result.content.losses.length === 0);
const inputHeavy = new UploadTurn(1, 'goal'); const inputText = 'i'.repeat(6000);
add(inputHeavy, 'input-heavy', { query: inputText }, [new TextBlock('tiny result')]);
assert('large input also borrows small result space without truncation', actionsOf(bodyOf(inputHeavy))[0].input.content.query === inputText && actionsOf(bodyOf(inputHeavy))[0].input.losses.length === 0);
const blocks = new UploadTurn(1, 'goal');
add(blocks, 'blocks', {}, [new TextBlock('x'.repeat(2000)), new TextBlock('FINAL SUMMARY')]);
assert('small multi-block result complete including final summary', JSON.stringify(actionsOf(bodyOf(blocks))[0].result.content.content) === JSON.stringify([{ text: 'x'.repeat(2000) }, { text: 'FINAL SUMMARY' }]));
const completeBlocks = new UploadTurn(1, 'goal'); const shortBlocks = Array.from({ length: 32 }, (_, i) => new TextBlock(`short-${i}`));
add(completeBlocks, 'complete-32', {}, shortBlocks);
assert('complete short collection at traversal boundary preserved without loss', JSON.stringify(actionsOf(bodyOf(completeBlocks))[0].result.content.content) === JSON.stringify(shortBlocks.map(b => ({ text: b.text }))) && actionsOf(bodyOf(completeBlocks))[0].result.content.losses.length === 0);
const longBlocks = new UploadTurn(1, 'goal');
add(longBlocks, 'long-blocks', {}, [new TextBlock('x'.repeat(50000)), new TextBlock('FINAL SUMMARY')]);
assert('long first block cannot starve final summary', actionsOf(bodyOf(longBlocks))[0].result.content.content[1].text === 'FINAL SUMMARY');
const plainArray = capture(Array.from({ length: 100 }, (_, i) => i));
assert('ordinary nested arrays also retain exact prefix/suffix indices', JSON.stringify(plainArray).includes('"index":99,"value":99') && plainArray.losses.some(l => l.reason.includes('[16, 84)')));
const blockTail = new UploadTurn(1, 'goal');
add(blockTail, 'blocks-80', {}, Array.from({ length: 80 }, (_, i) => new TextBlock(`block-${i}`)));
const collection = actionsOf(bodyOf(blockTail))[0].result.content;
assert('long content retains prefix/suffix exact indices with explicit omitted middle', collection.content.originalLength === 80 && collection.content.entries[0].index === 0 && collection.content.entries.at(-1).index === 79 && collection.content.entries.at(-1).value.text === 'block-79' && collection.losses.some((l: { reason: string }) => l.reason.includes('[16, 64)')));
for (const size of [5000, 50000]) {
  const bashTurn = new UploadTurn(1, 'goal');
  const output = 'o'.repeat(size) + 'STDOUT END';
  add(bashTurn, 'bash', {}, [new JsonBlock({ json: { output, error: 'IMPORTANT ERROR', cwd: '/project', exitCode: 1 } })], 'bash');
  const action = actionsOf(bodyOf(bashTurn))[0]; const json = action.result.content.content[0].json;
  assert(`stdout ${size}: short stderr/cwd/exit preserved and output tail exact`, json.error === 'IMPORTANT ERROR' && json.cwd === '/project' && json.exitCode === 1 && action.failed && (size === 5000 ? json.output === output && action.result.content.losses.length === 0 : json.output.at(-1).endsWith('STDOUT END')));
  if (size > 5000) {
    const loss = action.result.content.losses.find((l: { path: string }) => l.path === '/0/json/output');
    assert('reallocated result ranges still refer to original source', loss.text.ranges.every((range: [number, number], i: number) => output.slice(...range) === json.output[i]) && loss.text.retainedBytes === json.output.reduce((n: number, p: string) => n + Buffer.byteLength(p), 0));
  }
}
let getterCalls = 0;
const getterArray: unknown[] = [];
Object.defineProperty(getterArray, '0', { enumerable: true, get() { getterCalls++; return 'computed'; } });
Object.defineProperty(getterArray, '1', { enumerable: true, get() { getterCalls++; throw new Error('must not evaluate'); } });
const getterCapture = capture({ nested: getterArray });
const accessorEvent = events('accessor', { nested: getterArray });
const accessorBlock = new TextBlock('placeholder');
Object.defineProperty(accessorBlock, 'text', { get() { getterCalls++; throw new Error('SDK field accessor'); } });
accessorEvent[1].result.content.push(accessorBlock);
const accessorTurn = new UploadTurn(1, 'goal'); accessorTurn.before(accessorEvent[0]); accessorTurn.after(accessorEvent[1]);
assert('nested array and SDK field accessors never evaluated, including throwing getter', getterCalls === 0 && getterCapture.losses.length === 2 && JSON.stringify(accessorTurn.actions).includes('without evaluation'));
assert('getter-bearing event and descriptors unmutated', Object.getOwnPropertyDescriptor(getterArray, '0')?.get !== undefined && getterArray.length === 2 && accessorEvent[1].result.content[1] === accessorBlock);
const pairing = new UploadObserver(); pairing.begin(1, 'goal');
const oldPair = events('reused', { old: true }, [new TextBlock('OLD RESULT')], 'old', {});
const newPair = events('reused', { new: true }, [new TextBlock('NEW RESULT')], 'new', {});
pairing.before(oldPair[0]); pairing.before(newPair[0]); pairing.after(oldPair[1]); pairing.after(newPair[1]);
const paired = actionsOf(bodyOf(pairing.take(1)!));
assert('same ID in distinct invocation states pairs only its own result', paired[0].tool === 'old' && paired[0].result.content.content[0].text === 'OLD RESULT' && paired[1].tool === 'new' && paired[1].result.content.content[0].text === 'NEW RESULT' && paired[0].invocationScope !== paired[1].invocationScope);
const duplicate = new UploadTurn(1, 'goal');
const dupA = events('duplicate', {}, [new TextBlock('FIRST')]); const dupB = events('duplicate', {}, [new TextBlock('SECOND')]);
duplicate.before(dupA[0]); duplicate.before(dupB[0]); duplicate.after(dupA[1]); duplicate.after(dupB[1]);
assert('same state duplicate ID never misattributes either interleaved result', duplicate.actions.every(a => 'missing' in a.result) && duplicate.unmatchedResults === 2 && duplicate.actions[1]!.attempt === 2);
const sequentialDuplicate = new UploadTurn(1, 'goal');
sequentialDuplicate.before(dupA[0]); sequentialDuplicate.after(dupA[1]); sequentialDuplicate.before(dupB[0]); sequentialDuplicate.after(dupA[1]); sequentialDuplicate.after(dupB[1]);
assert('same-state reuse after completion preserves first evidence and refuses later attribution', JSON.stringify(sequentialDuplicate.actions[0]).includes('FIRST') && 'missing' in sequentialDuplicate.actions[1]!.result);
const fallbackObserver = new UploadObserver(); fallbackObserver.begin(1, 'old'); fallbackObserver.before(oldPair[0]);
fallbackObserver.fallback(new ToolResultEvent({ agent, invocationState: oldPair[0].invocationState, result: oldPair[1].result }));
const frozenTurn = fallbackObserver.take(1)!; const frozen = JSON.stringify(bodyOf(frozenTurn));
fallbackObserver.begin(2, 'new'); fallbackObserver.before(newPair[0]); fallbackObserver.fallback(new ToolResultEvent({ agent, invocationState: oldPair[0].invocationState, result: oldPair[1].result })); fallbackObserver.after(oldPair[1]);
const freshTurn = fallbackObserver.take(2)!;
assert('late public fallback/background result cannot touch new turn or prior candidate', JSON.stringify(bodyOf(frozenTurn)) === frozen && freshTurn.unmatchedResults === 2 && 'missing' in freshTurn.actions[0]!.result);

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
const bothSides = new UploadTurn(1, 'goal'); const unicodeSource = '😀中\u0000\\\"'.repeat(6000) + 'EXACT TAIL';
add(bothSides, 'both-sides', { text: unicodeSource }, [new TextBlock(unicodeSource)]);
const bothAction = actionsOf(bodyOf(bothSides))[0];
for (const [captured, parts] of [[bothAction.input, bothAction.input.content.text], [bothAction.result.content, bothAction.result.content.content[0].text]]) {
  const text = captured.losses.find((l: { text?: unknown }) => l.text !== undefined).text;
  assert('both-side dynamic reallocation keeps Unicode source ranges/bytes exact', text.ranges.every((range: [number, number], i: number) => unicodeSource.slice(...range) === parts[i]) && text.retainedBytes === parts.reduce((n: number, p: string) => n + Buffer.byteLength(p), 0) && parts.at(-1).endsWith('EXACT TAIL'));
}
assert('both-side escaping and metadata obey serialized full action cap', Buffer.byteLength(JSON.stringify(bothAction)) <= MAX_ACTION_BYTES);
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
const saturatedId = events('pending-999', {}, [new TextBlock('UNMATCHABLE')]); many.after(saturatedId[1]);
assert('identity ledger saturation stays bounded and reports unmatchable result', many.unmatchedResults === 1 && many.actions.at(-1)!.sourceLoss.some(l => l.includes('512 keys')) && JSON.stringify(many.actions.at(-1)).includes('cannot be safely attributed'));
const batchBound = new UploadTurn(1, 'batch');
const batchUses = Array.from({ length: 80 }, (_, i) => new ToolUseBlock({ name: 'batch-tool', toolUseId: `batch-${i}`, input: {} }));
batchBound.batch(new BeforeToolsEvent({ agent, invocationState: state, message: new Message({ role: 'assistant', content: batchUses }) }));
for (const use of batchUses) batchBound.fallback(new ToolResultEvent({ agent, invocationState: state, result: new ToolResultBlock({ toolUseId: use.toolUseId, status: 'error', content: [new TextBlock('BATCH CANCELLED')] }) }));
assert('bounded batch prefix/suffix loss distinct from internal events and unmatched results', batchBound.actions.length === 32 && batchBound.batchEntriesOmitted === 48 && batchBound.unmatchedResults === 48 && batchBound.internalEvents === 0 && batchBound.actions.at(-1)!.invocation === 'batch-79');
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
header('Real SDK/runtime public fallback paths (no loop/executor replacement)');
for (const mode of ['batch-cancel', 'generator-error', 'denied', 'transformed'] as const) {
  const runtime = await createRuntime(false, new UploadModel());
  const sdk = (runtime as unknown as { agent: Agent }).agent;
  const controller = (runtime as unknown as { cloudMemory: CloudMemory }).cloudMemory;
  let afterCount = 0; let publicCount = 0;
  sdk.addHook(AfterToolCallEvent, () => { afterCount++; });
  sdk.addHook(ToolResultEvent, () => { publicCount++; });
  if (mode === 'batch-cancel') sdk.addHook(BeforeToolsEvent, event => { event.cancel = 'BATCH CANCEL RESULT'; });
  if (mode === 'generator-error') sdk.addMiddleware(ExecuteToolStage, async function* () { throw new Error('GENERATOR ERROR RESULT'); });
  if (mode === 'denied') sdk.addHook(BeforeToolCallEvent, event => { event.cancel = 'DENIED RESULT'; });
  if (mode === 'transformed') sdk.addHook(AfterToolCallEvent, event => { event.result = new ToolResultBlock({ toolUseId: event.result.toolUseId, status: 'success', content: [new TextBlock('TRANSFORMED OUTPUT')] }); });
  for await (const _event of runtime.send(mode)) {}
  const rows = (await controller.command('pending')).split('\n'); let preview = '';
  for (const row of rows) { const candidate = await controller.command(`preview ${row.split(' ')[0]}`); if (candidate.includes(runtime.info.sessionId)) preview = candidate; }
  if (mode === 'batch-cancel' || mode === 'generator-error') {
    assert(`runtime ${mode}: available public result captured and explicitly labelled without After hook`, afterCount === 0 && publicCount === 1 && preview.includes(mode === 'batch-cancel' ? 'BATCH CANCEL RESULT' : 'GENERATOR ERROR RESULT') && preview.includes('ToolResultEvent fallback') && !preview.includes('No corresponding result observed'));
    if (mode === 'batch-cancel') assert('batch cancellation input is labelled requested, not executed', preview.includes('BeforeTools requested input; execution not observed'));
  } else if (mode === 'denied') assert('runtime denial retains actual error execution evidence', afterCount === 1 && preview.includes('DENIED RESULT') && preview.includes('pre-after-hook execution evidence'));
  else assert('final public transformed result never replaces original execution snapshot', publicCount === 1 && preview.includes('ORIGINAL-LATE-TAIL-0') && !preview.includes('TRANSFORMED OUTPUT') && preview.includes('not necessarily final model-visible output'));
  await runtime.shutdown();
}
let finishBackground!: () => void;
const backgroundGate = new Promise<void>(resolve => { finishBackground = resolve; });
const backgroundObserver = new UploadObserver(); backgroundObserver.begin(1, 'background goal');
const backgroundAgent = new Agent({ model: new UploadModel(), printer: false, retryStrategy: null,
  backgroundTasks: { always: ['arbitrary_upload_mcp'], waitForCompletion: false },
  tools: [tool({ name: 'arbitrary_upload_mcp', description: 'Bounded synthetic background test', inputSchema: z.object({ command: z.string(), index: z.number() }), callback: async () => { await backgroundGate; return 'LATE BACKGROUND RESULT'; } })] });
backgroundAgent.addHook(BeforeToolsEvent, event => backgroundObserver.batch(event), { order: HookOrder.SDK_LAST });
backgroundAgent.addHook(BeforeToolCallEvent, event => backgroundObserver.before(event), { order: HookOrder.SDK_LAST });
let backgroundAfter!: () => void; let backgroundAfterCount = 0;
const backgroundCompleted = new Promise<void>(resolve => { backgroundAfter = resolve; });
backgroundAgent.addHook(AfterToolCallEvent, event => { backgroundAfterCount++; backgroundObserver.after(event); backgroundAfter(); }, { order: HookOrder.SDK_FIRST });
backgroundAgent.addHook(ToolResultEvent, event => backgroundObserver.fallback(event), { order: HookOrder.SDK_LAST });
for await (const _event of backgroundAgent.stream('background goal')) {}
const ackTurn = backgroundObserver.take(1)!; const ackBody = JSON.stringify(bodyOf(ackTurn));
assert('real SDK background dispatch acknowledgement captured without After hook', backgroundAfterCount === 0 && ackBody.includes('ToolResultEvent fallback') && ackBody.includes('Task ID:') && !ackBody.includes('No corresponding result observed') && !ackBody.includes('LATE BACKGROUND RESULT'));
backgroundObserver.begin(2, 'successor'); finishBackground();
// Wait on the actual public completion hook; no polling or timing assumption.
await backgroundCompleted;
for await (const _event of backgroundAgent.stream('drain background completion')) {}
const successor = backgroundObserver.take(2)!;
assert('background completion never mutates closed candidate or fabricates successor action', JSON.stringify(bodyOf(ackTurn)) === ackBody && successor.actions.length === 0 && successor.unmatchedResults === 1);
backgroundObserver.clear();

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
