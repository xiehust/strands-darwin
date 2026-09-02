/**
 * SRF-020 — same-path fileEditor mutations apply in call order within one Agent.
 *
 * Offline. A scripted model emits one assistant message carrying several
 * `fileEditor` tool uses; the default `ConcurrentToolExecutor` races them, and
 * `SerializedFileEditorTool` decides only when each delegated call starts. The
 * real SDK singleton edits real temp files; a deliberately slow fake original
 * proves what stays concurrent and what waits.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  ConcurrentToolExecutor,
  Model,
  tool,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type Tool,
} from '@strands-agents/sdk';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { z } from 'zod';

import { buildRecipeChild } from '../src/agents/child-recipe.js';
import { PermissionGate } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { MUTATING_FILE_EDITOR_COMMANDS, SerializedFileEditorTool, mutationKey } from '../src/tools/file-editor-serial.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('file-editor-serial');

interface ScriptedToolUse {
  readonly id: string;
  readonly input: Record<string, unknown>;
}

interface ObservedResult {
  readonly status: 'success' | 'error';
  readonly text: string;
}

/** Emits every scripted tool use in ONE assistant message, then ends the turn. */
class BatchModel extends Model<BaseModelConfig> {
  calls = 0;
  private config: BaseModelConfig = { modelId: 'fake.file-editor-serial', contextWindowLimit: 200_000 };

  constructor(private readonly batch: readonly ScriptedToolUse[]) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const hasResult = messages.some((message) => message.content.some((block) => block.type === 'toolResultBlock'));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      for (const use of this.batch) {
        yield {
          type: 'modelContentBlockStartEvent',
          start: { type: 'toolUseStart', name: 'fileEditor', toolUseId: use.id },
        };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(use.input) } };
        yield { type: 'modelContentBlockStopEvent' };
      }
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'batch observed' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

class NoCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.file-editor-serial-runtime', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    throw new Error('the runtime installation check must not call a model');
  }
}

function resultsOf(agent: Agent): Map<string, ObservedResult> {
  const observed = new Map<string, ObservedResult>();
  for (const message of agent.messages) {
    for (const block of message.content) {
      if (block.type !== 'toolResultBlock') continue;
      const typed = block as { toolUseId: string; status: 'success' | 'error'; content: readonly unknown[] };
      const text = typed.content
        .map((inner) => (inner as { text?: string }).text ?? '')
        .join('');
      observed.set(typed.toolUseId, { status: typed.status, text });
    }
  }
  return observed;
}

async function runBatch(editor: Tool, batch: readonly ScriptedToolUse[]): Promise<{ agent: Agent; results: Map<string, ObservedResult> }> {
  const model = new BatchModel(batch);
  const agent = new Agent({ model, tools: [editor], printer: false });
  await agent.invoke('apply the batch');
  assert('the scripted model saw exactly one tool round', model.calls === 2);
  return { agent, results: resultsOf(agent) };
}

function replace(id: string, filePath: string, oldStr: string, newStr: string): ScriptedToolUse {
  return { id, input: { command: 'str_replace', path: filePath, old_str: oldStr, new_str: newStr } };
}

/** Runs one input through the unwrapped SDK singleton, returning the same projection. */
async function unwrapped(agent: Agent, input: Record<string, unknown>): Promise<ObservedResult> {
  const stream = fileEditor.stream({
    toolUse: { name: fileEditor.name, toolUseId: 'unwrapped-control', input },
    agent,
    invocationState: {},
    cancelSignal: new AbortController().signal,
    interrupt: () => {
      throw new Error('unexpected interrupt');
    },
  } as never);
  let item = await stream.next();
  while (!item.done) item = await stream.next();
  const result = item.value.toJSON() as { toolResult: { status: 'success' | 'error'; content: Array<{ text?: string }> } };
  return { status: result.toolResult.status, text: result.toolResult.content.map((c) => c.text ?? '').join('') };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface TimedCall {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

/** A fake original with the SDK tool's name: slow when `new_str === 'slow'`, records timings. */
function slowOriginal(calls: TimedCall[], epoch: () => number): Tool {
  return tool({
    name: 'fileEditor',
    description: 'timing probe',
    inputSchema: z.object({
      command: z.string(),
      path: z.string(),
      new_str: z.string().optional(),
      old_str: z.string().optional(),
      insert_line: z.number().optional(),
    }),
    callback: async (input, context) => {
      const start = Date.now() - epoch();
      if (input.new_str === 'slow') await sleep(300);
      calls.push({ id: context?.toolUse.toolUseId ?? '?', start, end: Date.now() - epoch() });
      return `${input.command} ${input.path}`;
    },
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-file-editor-serial-'));
let runtime: AgentRuntime | undefined;

try {
  header('fileEditor serial — wrapper is a transparent projection of the SDK tool');
  const wrapper = new SerializedFileEditorTool(fileEditor);
  assert('same tool name', wrapper.name === fileEditor.name && wrapper.name === 'fileEditor');
  assert('same description bytes', wrapper.description === fileEditor.description);
  assert('same provider toolSpec object', wrapper.toolSpec === fileEditor.toolSpec);
  assert('mutating commands are exactly create/str_replace/insert',
    [...MUTATING_FILE_EDITOR_COMMANDS].sort().join(',') === 'create,insert,str_replace');
  assert('view never serializes', mutationKey({ command: 'view', path: '/tmp/a' }) === undefined);
  assert('a relative path never serializes (the SDK rejects it itself)',
    mutationKey({ command: 'str_replace', path: 'src/a.ts' }) === undefined);
  assert('non-object and pathless inputs never serialize',
    mutationKey('x') === undefined && mutationKey({ command: 'create' }) === undefined && mutationKey(null) === undefined);
  assert('trailing separators and duplicate separators resolve to the written path',
    mutationKey({ command: 'insert', path: '/tmp//a/b/' }) === '/tmp/a/b' && mutationKey({ command: 'create', path: '/tmp/a/b' }) === '/tmp/a/b');

  header('fileEditor serial — N disjoint str_replace in one message all survive, in order');
  const disjoint = path.join(root, 'disjoint.txt');
  const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
  await writeFile(disjoint, `${words.join('\n')}\n`);
  const disjointBatch = words.map((word, index) => replace(`d${index + 1}`, disjoint, word, `${word.toUpperCase()}-${index + 1}`));
  const { agent: disjointAgent, results: disjointResults } = await runBatch(new SerializedFileEditorTool(fileEditor), disjointBatch);
  const disjointText = await readFile(disjoint, 'utf8');
  assert('six results, every one success',
    disjointResults.size === 6 && [...disjointResults.values()].every((result) => result.status === 'success'));
  assert('all six edits are present in the file',
    disjointText === `${words.map((word, index) => `${word.toUpperCase()}-${index + 1}`).join('\n')}\n`);
  assert('each success snippet shows its own replacement',
    words.every((word, index) => disjointResults.get(`d${index + 1}`)?.text.includes(`${word.toUpperCase()}-${index + 1}`) === true));
  assert('no chain entry lingers after the batch settles',
    (disjointAgent.tools[0] as SerializedFileEditorTool).pendingPaths(disjointAgent).length === 0);

  // Control: the unwrapped singleton under the same batch. Informational only —
  // the race is what SRF-020 removes, and its exact outcome is scheduler-dependent.
  const control = path.join(root, 'control.txt');
  await writeFile(control, `${words.join('\n')}\n`);
  await runBatch(fileEditor, words.map((word, index) => replace(`c${index + 1}`, control, word, `${word.toUpperCase()}-${index + 1}`)));
  const controlSurvivors = (await readFile(control, 'utf8')).split('\n').filter((line) => line.includes('-')).length;
  console.log(`  note  unwrapped control kept ${controlSurvivors}/6 edits (every result reported success)`);

  header('fileEditor serial — dependent edits prove strict call order');
  const chained = path.join(root, 'chained.txt');
  await writeFile(chained, 'seed\n');
  const chainBatch = [
    replace('k1', chained, 'seed', 'seed one'),
    replace('k2', chained, 'seed one', 'seed one two'),
    replace('k3', chained, 'seed one two', 'seed one two three'),
    replace('k4', chained, 'seed one two three', 'seed one two three four'),
  ];
  const { results: chainResults } = await runBatch(new SerializedFileEditorTool(fileEditor), chainBatch);
  assert('every dependent edit found the text the previous one wrote',
    chainResults.size === 4 && [...chainResults.values()].every((result) => result.status === 'success'));
  assert('the file carries the fourth edit', (await readFile(chained, 'utf8')) === 'seed one two three four\n');

  header('fileEditor serial — insert after a length-changing str_replace lands in the updated file');
  const grown = path.join(root, 'grown.txt');
  await writeFile(grown, 'one\ntwo\nthree\n');
  const { results: grownResults } = await runBatch(new SerializedFileEditorTool(fileEditor), [
    replace('g1', grown, 'two', 'two\ntwo-b\ntwo-c'),
    { id: 'g2', input: { command: 'insert', path: grown, insert_line: 3, new_str: 'INSERTED' } },
  ]);
  assert('replace and insert both succeed', grownResults.get('g1')?.status === 'success' && grownResults.get('g2')?.status === 'success');
  assert('insert_line 3 means after the third line of the UPDATED file',
    (await readFile(grown, 'utf8')) === 'one\ntwo\ntwo-b\nINSERTED\ntwo-c\nthree\n');

  header('fileEditor serial — a failed edit releases the chain, error bytes untouched');
  const missed = path.join(root, 'missed.txt');
  await writeFile(missed, 'const value = 1;\nconst other = 2;\n');
  const missInput = { command: 'str_replace', path: missed, old_str: 'const value = 42;', new_str: 'const value = 43;' };
  const controlAgent = new Agent({ model: new NoCallModel(), tools: [fileEditor], printer: false });
  await controlAgent.initialize();
  const unwrappedMiss = await unwrapped(controlAgent, missInput);
  assert('the unwrapped miss is an error with advisory context',
    unwrappedMiss.status === 'error' && unwrappedMiss.text.includes('Advisory context only'));
  const { results: missResults } = await runBatch(new SerializedFileEditorTool(fileEditor), [
    { id: 'm1', input: missInput },
    replace('m2', missed, 'const other = 2;', 'const other = 3;'),
  ]);
  assert('the wrapped miss is still an error', missResults.get('m1')?.status === 'error');
  assert('the miss error text is byte-identical to the unwrapped SDK tool',
    missResults.get('m1')?.text === unwrappedMiss.text);
  assert('the following edit on the same path was not blocked', missResults.get('m2')?.status === 'success');
  assert('the following edit landed', (await readFile(missed, 'utf8')) === 'const value = 1;\nconst other = 3;\n');

  header('fileEditor serial — unrelated calls stay concurrent, same-path mutations wait');
  const timed: TimedCall[] = [];
  const t0 = Date.now();
  const timedWrapper = new SerializedFileEditorTool(slowOriginal(timed, () => t0));
  const slowPath = path.join(root, 'slow.txt');
  const otherPath = path.join(root, 'other.txt');
  const { agent: timedAgent } = await runBatch(timedWrapper, [
    { id: 's1', input: { command: 'str_replace', path: slowPath, old_str: 'a', new_str: 'slow' } },
    { id: 'o1', input: { command: 'str_replace', path: otherPath, old_str: 'a', new_str: 'slow' } },
    { id: 'v1', input: { command: 'view', path: slowPath } },
    { id: 's2', input: { command: 'insert', path: slowPath, insert_line: 1, new_str: 'slow' } },
    { id: 'o2', input: { command: 'create', path: `${otherPath}/`, new_str: 'fast' } },
  ]);
  const byId = new Map(timed.map((call) => [call.id, call]));
  const s1 = byId.get('s1');
  const s2 = byId.get('s2');
  const o1 = byId.get('o1');
  const v1 = byId.get('v1');
  const o2 = byId.get('o2');
  assert('all five probe calls ran', timed.length === 5 && s1 !== undefined && s2 !== undefined && o1 !== undefined && v1 !== undefined && o2 !== undefined);
  if (s1 && s2 && o1 && v1 && o2) {
    assert('the other file\'s slow edit started alongside the first (not after it)', o1.start < 150 && o1.end < 450);
    assert('a view on the busy path does not wait', v1.start < 150 && v1.end < 150);
    assert('the second same-path mutation waited for the first to settle', s2.start >= s1.end && s2.start >= 290);
    assert('two slow same-path mutations take ~600 ms, not ~300', s2.end >= 590);
    assert('a trailing-slash spelling of the other path joins that path\'s chain', o2.start >= o1.end);
    assert('nothing on the other path waited for the slow chain', o1.end < s2.start + 10);
  }
  assert('timing chains are released after the batch', timedWrapper.pendingPaths(timedAgent).length === 0);

  header('fileEditor serial — buildRecipeChild children are wrapped with isolated per-Agent chains');
  const parentCalls: TimedCall[] = [];
  const p0 = Date.now();
  const sharedWrapper = new SerializedFileEditorTool(slowOriginal(parentCalls, () => p0));
  const sharedPath = path.join(root, 'shared.txt');
  const parentModel = new BatchModel([
    { id: 'p1', input: { command: 'str_replace', path: sharedPath, old_str: 'a', new_str: 'slow' } },
    { id: 'p2', input: { command: 'str_replace', path: sharedPath, old_str: 'a', new_str: 'fast' } },
  ]);
  const parent = new Agent({ model: parentModel, tools: [sharedWrapper], printer: false });
  await parent.initialize();
  const gate = new PermissionGate({ mode: 'yolo', projectRoot: root, ask: async () => ({ allowed: true }) });
  const child = buildRecipeChild({
    definition: { name: 'probe', description: 'probe child', systemPrompt: 'probe', tools: undefined, file: undefined },
    config: {
      provider: 'bedrock', model: 'fake', region: 'us-west-2', maxTokens: 1000, permissionMode: 'yolo',
      promptCache: false, thinkingEffort: 'high', summaryRatio: 0.8, contextWarnRatio: 0.8, contextOffload: true,
      preserveRecentMessages: 4, modelChoices: [],
    },
    model: new BatchModel([{ id: 'c1', input: { command: 'str_replace', path: sharedPath, old_str: 'a', new_str: 'fast' } }]),
    tools: parent.tools,
    intervention: gate,
    projectInstructions: undefined,
    idPrefix: 'serial-test',
    dispatch: undefined,
  });
  const childEditor = child.tools.find((candidate) => candidate.name === 'fileEditor');
  assert('the child receives the wrapped editor', childEditor instanceof SerializedFileEditorTool && childEditor === sharedWrapper);
  const parentRun = parent.invoke('parent batch');
  await sleep(60);
  assert('mid-flight the parent owns a pending chain for the path', sharedWrapper.pendingPaths(parent).includes(sharedPath));
  assert('the child has no chain for that path (different chain object)', sharedWrapper.pendingPaths(child).length === 0);
  const childStart = Date.now() - p0;
  await child.invoke('child batch');
  const childCall = parentCalls.find((call) => call.id === 'c1');
  assert('the child\'s same-path edit did not wait for the parent\'s slow edit',
    childCall !== undefined && childCall.end - childStart < 150);
  await parentRun;
  const p1 = parentCalls.find((call) => call.id === 'p1');
  const p2 = parentCalls.find((call) => call.id === 'p2');
  assert('the parent\'s own second edit still waited for its first', p1 !== undefined && p2 !== undefined && p2.start >= p1.end);
  assert('both Agents release their chains', sharedWrapper.pendingPaths(parent).length === 0 && sharedWrapper.pendingPaths(child).length === 0);

  header('fileEditor serial — the runtime installs the wrapper in place of the singleton');
  setRuntimeModelFactoryForTest(async () => new NoCallModel());
  runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: async () => ({ allowed: true }),
  });
  const runtimeAgent = (runtime as unknown as { agent: Agent }).agent;
  const runtimeEditor = runtimeAgent.tools.find((candidate) => candidate.name === 'fileEditor');
  assert('the parent Agent\'s fileEditor is the SRF-020 wrapper', runtimeEditor instanceof SerializedFileEditorTool);
  assert('exactly one fileEditor is registered', runtimeAgent.tools.filter((candidate) => candidate.name === 'fileEditor').length === 1);
  assert('the runtime never sets toolExecutor (SDK default ConcurrentToolExecutor)',
    (runtimeAgent as unknown as { _toolExecutor: unknown })._toolExecutor instanceof ConcurrentToolExecutor);
  assert('the wrapper keeps the SDK spec for the model', runtimeEditor?.toolSpec === fileEditor.toolSpec);
} finally {
  await runtime?.shutdown();
  setRuntimeModelFactoryForTest(undefined);
  await rm(root, { recursive: true, force: true });
}

report();
