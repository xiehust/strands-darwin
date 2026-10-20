/** Offline real SDK/runtime proof: human corrections between complete tool batches. */
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Agent, AfterToolsEvent, HookOrder, Model, ModelError, type BaseModelConfig, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { makeFileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { installPromptSteering, MAX_STEERING_PER_BOUNDARY, type PromptSteeringSource } from '../src/agent/prompt-steering.js';
import { configPath } from '../src/config.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { readPromptHistory } from '../src/trajectory/prompt-history.js';
import { replayRecords, formatReplay } from '../src/trajectory/replay.js';
import { rewindHistoryBoundary } from '../src/trajectory/rewind-history.js';
import { steeringCandidates, type QueuedPrompt } from '../src/tui/prompt-queue.js';
import { initialTurnState, turnReducer } from '../src/tui/turn-state.js';
import { ownPrivateHome } from './shared.js';

ownPrivateHome('prompt-steering');

class ToolModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.steering', contextWindowLimit: 32_000 };
  readonly calls: Message[][] = [];
  beforeCall?: (call: number) => Promise<void>;
  constructor(private readonly file: string) { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls.push(messages);
    await this.beforeCall?.(this.calls.length);
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.calls.length === 1) {
      for (const id of ['read-one', 'read-two']) {
        yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'fileEditor', toolUseId: id } };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ command: 'view', path: this.file }) } };
        yield { type: 'modelContentBlockStopEvent' };
      }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'corrected answer' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}

function queueSource(initial: QueuedPrompt[] = []) {
  let entries = initial;
  const sent: string[] = [], rejected: string[] = [];
  let state = initialTurnState;
  const source: PromptSteeringSource = {
    pending: () => steeringCandidates(entries),
    claim: prompt => {
      if (entries[0] !== prompt) return false;
      entries = entries.slice(1);
      return true;
    },
    delivered: prompt => {
      sent.push(prompt.text);
      state = turnReducer(state, { type: 'userInput', text: prompt.text });
    },
    restore: prompts => { entries = [...prompts, ...entries]; },
    reject: (prompt, reason) => {
      if (entries[0] !== prompt) return;
      rejected.push(reason);
      entries = [];
    },
  };
  return { source, sent, rejected, entries: () => entries, set: (next: QueuedPrompt[]) => { entries = next; },
    state: () => state, action: (action: Parameters<typeof turnReducer>[1]) => { state = turnReducer(state, action); } };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-steering-'));
const file = path.join(root, 'input.txt');
await writeFile(file, 'real file for parallel read tools\n');
await mkdir(path.dirname(configPath()), { recursive: true });
await writeFile(configPath(), JSON.stringify({ provider: 'bedrock', model: 'fake.steering', region: 'us-west-2', contextOffload: false, memory: false }));
let active: AgentRuntime | undefined;
async function runtime(model: ToolModel) {
  setRuntimeModelFactoryForTest(async () => model);
  active = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: allowAllBridge });
  return active;
}

try {
  const first = { text: 'Actually, only explain; do not change files.' };
  const second = { text: 'Use the existing implementation.' };
  assert.deepEqual(steeringCandidates([first, second, { text: '!git status' }, first]), [first, second]);
  for (const barrier of [{ text: '/review' }, { text: 'image', image: { type: 'imageBlock' } as never },
    { kind: 'taskNotification', text: 'notification' } as QueuedPrompt]) {
    assert.deepEqual(steeringCandidates([barrier, first]), []);
  }
  assert.equal(steeringCandidates(Array.from({ length: MAX_STEERING_PER_BOUNDARY + 1 }, () => first)).length, MAX_STEERING_PER_BOUNDARY);

  const model = new ToolModel(file);
  const run = await runtime(model);
  const queue = queueSource();
  queue.action({ type: 'userInput', text: 'original request' });
  model.beforeCall = async call => {
    if (call === 2) {
      const persisted = await readTrajectory(run.info.trajectoryFile!);
      assert.deepEqual(persisted.records.filter(r => r.type === 'userInput').map(r => r.text), ['original request', first.text, second.text]);
    }
  };
  let completedTools = 0, results = 0;
  for await (const event of run.send('original request', undefined, undefined, undefined, queue.source)) {
    queue.action({ type: 'streamEvent', event });
    if (event.type === 'beforeToolsEvent') queue.set([first, second]);
    if (event.type === 'afterToolCallEvent') {
      completedTools++;
      assert.deepEqual(queue.sent, [], 'no injection between siblings of one parallel tool batch');
    }
    if (event.type === 'agentResultEvent') results++;
  }
  queue.action({ type: 'turnEnded' });
  assert.equal(completedTools, 2);
  assert.equal(results, 1, 'steering does not start another agent invocation');
  assert.equal(model.calls.length, 2);
  const message = model.calls[1]!.at(-1)!;
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content.map(b => b.type), ['toolResultBlock', 'toolResultBlock', 'textBlock', 'textBlock']);
  assert.deepEqual(message.content.flatMap(b => b.type === 'textBlock' ? [b.text] : []), [first.text, second.text]);
  assert.deepEqual(queue.sent, [first.text, second.text]);
  assert.deepEqual(queue.entries(), []);
  await run.shutdown(); active = undefined;
  const recorded = await readTrajectory(run.info.trajectoryFile!);
  const inputs = recorded.records.filter(r => r.type === 'userInput');
  assert.deepEqual(inputs.map(r => r.delivery), [undefined, 'steering', 'steering']);
  assert.equal(new Set(inputs.map(r => r.turn)).size, 1);
  assert.equal(recorded.records.filter(r => r.type === 'turnEnded').length, 1);
  const recalled = await readPromptHistory(root);
  assert.ok(recalled.entries.includes(first.text) && recalled.entries.includes(second.text));
  const replay = replayRecords(recorded.records);
  const normalize = (history: typeof replay.history) => history.map(({ id: _id, ...item }) => item);
  assert.deepEqual(normalize(replay.history), normalize(queue.state().history));
  assert.ok(formatReplay({ ...replay, damage: undefined }).includes(first.text));
  assert.equal(rewindHistoryBoundary(recorded.records, { snapshotId: 'test', prompt: 'original request', completedAt: new Date().toISOString(), trajectoryTurn: inputs[0]!.turn }), recorded.records.indexOf(inputs[0]!));

  // A real controlling Codex hook runs on the correction, not just the opening prompt.
  const hook = path.join(root, 'submit.cjs');
  const hookLog = path.join(root, 'hook-inputs');
  await writeFile(hook, `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p=JSON.parse(s);require('node:fs').appendFileSync(${JSON.stringify(hookLog)},p.prompt+'\\n');console.log(JSON.stringify(p.prompt==='blocked correction'?{decision:'block',reason:'blocked offline'}:{hookSpecificOutput:{additionalContext:'private hook context'}}))});`);
  await mkdir(path.join(root, '.agents'), { recursive: true });
  await writeFile(path.join(root, '.agents/hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${JSON.stringify(hook)}`, timeout: 5 }] }] } }));
  const hookedModel = new ToolModel(file);
  const hooked = await runtime(hookedModel);
  const blocked = queueSource([{ text: 'blocked correction' }]);
  for await (const _ of hooked.send('original', undefined, undefined, undefined, blocked.source)) { /* real loop */ }
  assert.deepEqual(blocked.sent, []);
  assert.equal(blocked.rejected.length, 1);
  assert.equal(hookedModel.calls.length, 2, 'a refused correction does not kill original work');
  assert.deepEqual((await readFile(hookLog, 'utf8')).trim().split('\n'), ['original', 'blocked correction']);
  await hooked.shutdown(); active = undefined;
  assert.equal((await readFile(hooked.info.trajectoryFile!, 'utf8')).includes('blocked correction'), false);

  const allowedModel = new ToolModel(file);
  const allowed = await runtime(allowedModel);
  const allowedQueue = queueSource([first]);
  for await (const _ of allowed.send('original', undefined, undefined, undefined, allowedQueue.source)) { /* real loop */ }
  assert.ok(allowedModel.calls[1]!.at(-1)!.content.some(b => b.type === 'textBlock' && b.text.includes(first.text) && b.text.includes('private hook context')));
  await allowed.shutdown(); active = undefined;
  const allowedRecords = await readTrajectory(allowed.info.trajectoryFile!);
  assert.deepEqual(allowedRecords.records.filter(r => r.type === 'userInput').map(r => r.text), ['original', first.text]);
  assert.equal((await readFile(allowed.info.trajectoryFile!, 'utf8')).includes('private hook context'), false);

  const failedModel = new ToolModel(file);
  const failure = new ModelError('provider failed after correction');
  failedModel.beforeCall = async call => { if (call === 2) throw failure; };
  const failed = await runtime(failedModel);
  const failedQueue = queueSource([first]);
  await assert.rejects(async () => {
    for await (const _ of failed.send('original', undefined, undefined, undefined, failedQueue.source)) { /* real failure */ }
  }, error => error === failure);
  assert.deepEqual(failedQueue.sent, [first.text]);
  assert.deepEqual(failedQueue.entries(), [], 'consumed corrections never come back as unsent');
  await failed.shutdown(); active = undefined;

  await writeFile(configPath(), JSON.stringify({ provider: 'bedrock', model: 'fake.steering', region: 'us-west-2', contextOffload: false, memory: false, trajectory: false }));
  const unrecordedModel = new ToolModel(file);
  const unrecorded = await runtime(unrecordedModel);
  const unrecordedQueue = queueSource([first]);
  for await (const _ of unrecorded.send('original', undefined, undefined, undefined, unrecordedQueue.source)) { /* recording is not required */ }
  assert.deepEqual(unrecordedQueue.sent, [first.text]);
  assert.equal(unrecordedModel.calls.length, 2);
  assert.equal(unrecorded.info.trajectoryFile, undefined);
  await unrecorded.shutdown(); active = undefined;

  // The same installation over a real SDK loop exercises asynchronous ownership races.
  for (const scenario of ['takeback', 'later-takeback', 'cancel', 'reject', 'late', 'halt', 'append-failure', 'abandon'] as const) {
    const model = new ToolModel(file);
    const agent = new Agent({ model, tools: [makeFileEditor()], printer: false });
    const queue = queueSource(scenario === 'later-takeback' ? [first, second] : [first]);
    const accepted: string[] = [], prepared: string[] = [];
    const appendFailure = new Error('failed batch cleanup');
    if (scenario === 'halt') agent.addHook(AfterToolsEvent, event => { event.endTurn = true; });
    if (scenario === 'append-failure') agent.addHook(AfterToolsEvent, () => { throw appendFailure; }, { order: HookOrder.SDK_LAST + 1 });
    const cleanup = installPromptSteering(agent, queue.source, async text => {
      // Yield once as a real UserPromptSubmit hook does; mutate the driver's state
      // before the ownership check, not the model or executor.
      prepared.push(text);
      await Promise.resolve();
      if (scenario === 'takeback') queue.set([]);
      if (scenario === 'later-takeback') queue.set([first]);
      if (scenario === 'cancel') agent.cancel();
      if (scenario === 'reject') throw new Error('refused correction');
      if (scenario === 'late') queue.set([...queue.entries(), second]);
      return text;
    }, async text => { accepted.push(text); });
    try {
      for await (const event of agent.stream('original')) {
        if (scenario === 'abandon' && event.type === 'afterToolsEvent') break;
      }
      assert.notEqual(scenario, 'append-failure');
    } catch (error) {
      assert.equal(scenario, 'append-failure');
      assert.equal(error, appendFailure);
    } finally { cleanup(); }
    if (scenario === 'later-takeback') {
      assert.deepEqual(prepared, [first.text], 'withdrawn later text never runs a submit hook');
      assert.deepEqual(accepted, [first.text]);
    } else if (scenario === 'late') {
      assert.deepEqual(accepted, [first.text]);
      assert.deepEqual(queue.entries(), [second], 'arrivals during preparation remain queued');
      for await (const _ of agent.stream('next invocation')) { /* removed hook stays removed */ }
      assert.deepEqual(queue.entries(), [second]);
    } else {
      assert.deepEqual(accepted, [], scenario);
      assert.deepEqual(queue.sent, [], scenario);
    }
    if (scenario === 'cancel' || scenario === 'halt') assert.equal(model.calls.length, 1);
    if (scenario === 'reject') assert.equal(queue.rejected.length, 1);
    if (scenario === 'append-failure' || scenario === 'abandon') {
      assert.deepEqual(queue.entries(), [first], 'unappended admissions return to the queue');
      assert.equal(JSON.stringify(agent.messages).includes(first.text), false);
    }
  }
} finally {
  await active?.shutdown();
  setRuntimeModelFactoryForTest(undefined);
  await rm(root, { recursive: true, force: true });
}
console.log('PASS prompt steering: SDK batches, queue ownership, hooks, trajectory and rewind');
