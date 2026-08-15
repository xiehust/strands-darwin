/** Offline contracts for one-shot max-output-token recovery. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  Message,
  Model,
  SessionManager,
  TextBlock,
  tool,
  type BaseModelConfig,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { z } from 'zod';

import {
  installMaxTokensRecovery,
  withRetainedMaxTokensText,
} from '../src/agent/max-tokens-recovery.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import { PermissionGate } from '../src/agent/permission.js';
import { runHeadlessTurn } from '../src/headless.js';
import { initialTurnState, turnReducer } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

type Step =
  | { kind: 'success'; text: string }
  | { kind: 'maxTokens'; text: string }
  | { kind: 'error'; error: Error }
  | { kind: 'cancel'; text: string; delayMs: number };

interface Call {
  messages: ReturnType<Message['toJSON']>[];
  config: BaseModelConfig;
}

class ScriptedModel extends Model<BaseModelConfig> {
  readonly calls: Call[] = [];
  private config: BaseModelConfig;

  constructor(private readonly steps: readonly Step[], config: BaseModelConfig = MODEL_CONFIG) {
    super();
    this.config = structuredClone(config);
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const step = this.steps[this.calls.length];
    this.calls.push({
      messages: messages.map((message) => message.toJSON()),
      config: structuredClone(this.config),
    });
    if (step === undefined) throw new Error('script exhausted');
    if (step.kind === 'error') throw step.error;
    if (step.kind === 'cancel') {
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } };
      await new Promise((resolve) => setTimeout(resolve, step.delayMs));
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      return;
    }

    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield {
      type: 'modelMessageStopEvent',
      stopReason: step.kind === 'maxTokens' ? 'maxTokens' : 'endTurn',
    };
  }
}

type TestModelConfig = BaseModelConfig & {
  additionalRequestFields: Record<string, unknown>;
};

const MODEL_CONFIG: TestModelConfig = {
  modelId: 'fake.max-tokens',
  contextWindowLimit: 200_000,
  maxTokens: 64_000,
  additionalRequestFields: {
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  },
};

function textOf(message: Message | ReturnType<Message['toJSON']> | undefined): string {
  return message?.content
    .map((block) => {
      if (block instanceof TextBlock) return block.text;
      if ('text' in block && typeof block.text === 'string') return block.text;
      return '';
    })
    .join('') ?? '';
}

function conversationText(messages: readonly Message[]): string {
  return messages.map(textOf).join('|');
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function recoveredAgent(model: Model, options: { id?: string; sessionManager?: SessionManager } = {}): Agent {
  const agent = new Agent({
    model,
    ...(options.id !== undefined && { id: options.id }),
    ...(options.sessionManager !== undefined && { sessionManager: options.sessionManager }),
    printer: false,
  });
  installMaxTokensRecovery(agent);
  return agent;
}

async function collect(agent: Agent, input: string): Promise<string> {
  let text = '';
  for await (const event of agent.stream(input)) {
    if (event.type === 'contentBlockEvent' && event.contentBlock.type === 'textBlock') {
      text += event.contentBlock.text;
    }
  }
  return text;
}

async function successContracts(): Promise<void> {
  header('max tokens — one continuation with coherent streamed output');
  const model = new ScriptedModel([
    { kind: 'maxTokens', text: 'alpha ' },
    { kind: 'success', text: 'omega' },
  ]);
  const agent = recoveredAgent(model);
  const output = await collect(agent, 'write a long answer');

  assert('the first maxTokens response causes exactly one continuation', model.calls.length === 2);
  assert('streamed output contains the partial followed by continuation once', output === 'alpha omega');
  assert('retained partial is assistant context on the continuation call', model.calls[1]?.messages.at(-2)?.role === 'assistant' && textOf(model.calls[1]?.messages.at(-2)) === 'alpha ');
  const control = textOf(model.calls[1]?.messages.at(-1));
  assert('continuation receives an explicit no-repeat cutoff instruction', control.includes('Continue exactly from the cutoff') && control.includes('without repeating'));
  assert('history retains partial, control, and continuation exactly once', count(conversationText(agent.messages), 'alpha ') === 1 && count(conversationText(agent.messages), 'omega') === 1);
  assert('model maxTokens and high effort config stay byte-identical', model.calls.every((call) => JSON.stringify(call.config) === JSON.stringify(MODEL_CONFIG)));
}

async function ordinaryFailuresAndCancellation(): Promise<void> {
  header('max tokens — ordinary success, other errors, and cancellation');
  const normal = new ScriptedModel([{ kind: 'success', text: 'normal' }]);
  assert('normal success makes no extra call', await collect(recoveredAgent(normal), 'hello') === 'normal' && normal.calls.length === 1);

  const freshTurnsModel = new ScriptedModel([
    { kind: 'maxTokens', text: 'first turn partial ' },
    { kind: 'success', text: 'first turn end' },
    { kind: 'maxTokens', text: 'second turn partial ' },
    { kind: 'success', text: 'second turn end' },
  ]);
  const freshTurnsAgent = recoveredAgent(freshTurnsModel);
  const firstTurn = await collect(freshTurnsAgent, 'one');
  const secondTurn = await collect(freshTurnsAgent, 'two');
  assert(
    'a fresh invocation receives its own one-shot allowance',
    firstTurn === 'first turn partial first turn end' &&
      secondTurn === 'second turn partial second turn end' &&
      freshTurnsModel.calls.length === 4,
  );

  const other = new ScriptedModel([{ kind: 'error', error: new Error('transport down') }]);
  let otherError = '';
  try {
    await collect(recoveredAgent(other), 'hello');
  } catch (error) {
    otherError = error instanceof Error ? error.message : String(error);
  }
  assert('non-MaxTokensError propagates without retry', otherError === 'transport down' && other.calls.length === 1);

  const slow = new ScriptedModel([
    { kind: 'cancel', text: 'began', delayMs: 100 },
    { kind: 'success', text: 'should not run' },
  ]);
  const cancelled = recoveredAgent(slow);
  const invocation = cancelled.invoke('slow');
  await new Promise((resolve) => setTimeout(resolve, 20));
  cancelled.cancel();
  const result = await invocation;

  assert('cancellation ends promptly without continuation', result.stopReason === 'cancelled' && slow.calls.length === 1);
}

async function headlessProjection(): Promise<void> {
  header('max tokens — headless assembles the recovered reply without duplication');
  const model = new ScriptedModel([
    { kind: 'maxTokens', text: 'headless partial ' },
    { kind: 'success', text: 'headless end' },
  ]);
  const agent = recoveredAgent(model);
  const reply = await runHeadlessTurn({
    send: (input) => agent.stream(input),
    expandSlashCommand: async () => null,
  }, 'go', () => undefined);
  assert('headless output contains each recovered piece exactly once', reply === 'headless partial headless end');
}

async function tuiProjection(): Promise<void> {
  header('max tokens — TUI reducer shows the recovered reply without duplication');
  const model = new ScriptedModel([
    { kind: 'maxTokens', text: 'tui partial ' },
    { kind: 'success', text: 'tui end' },
  ]);
  const agent = recoveredAgent(model);
  let state = initialTurnState;
  for await (const event of agent.stream('go')) {
    state = turnReducer(state, { type: 'streamEvent', event });
  }
  state = turnReducer(state, { type: 'turnEnded' });
  const visible = state.history
    .filter((item) => item.kind === 'assistant')
    .map((item) => item.text)
    .join('');
  assert('TUI output contains each recovered piece exactly once', visible === 'tui partialtui end');
}

async function secondTruncationPersists(): Promise<void> {
  header('max tokens — second truncation fails and persists every partial');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-max-tokens-'));
  const storage = new LocalFileStorage(root);
  const sessionManager = new SessionManager({
    sessionId: 'max-tokens-test',
    storage,
    saveLatestOn: 'invocation',
  });
  const model = new ScriptedModel([
    { kind: 'maxTokens', text: 'first partial ' },
    { kind: 'maxTokens', text: 'second partial' },
  ]);
  const agent = recoveredAgent(model, { id: 'darwin', sessionManager });

  try {
    let failure: Error | undefined;
    try {
      await agent.invoke('too long');
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    assert('the continuation truncation propagates explicitly', failure?.name === 'MaxTokensError' && failure.message.includes('maximum token limit'));
    assert('only one automatic continuation was attempted', model.calls.length === 2);
    assert('live history retains both partials once', count(conversationText(agent.messages), 'first partial ') === 1 && count(conversationText(agent.messages), 'second partial') === 1);

    const restored = new Agent({
      id: 'darwin',
      model: new ScriptedModel([{ kind: 'success', text: 'unused' }]),
      sessionManager: new SessionManager({ sessionId: 'max-tokens-test', storage, saveLatestOn: 'invocation' }),
      printer: false,
    });
    await restored.initialize();
    const restoredText = conversationText(restored.messages);
    assert('failed invocation snapshot restores both partials', restoredText.includes('first partial ') && restoredText.includes('second partial'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function invocationWideAllowance(): Promise<void> {
  header('max tokens — allowance is invocation-wide across tool cycles');
  const marker = tool({
    name: 'marker',
    description: 'returns a marker',
    inputSchema: z.object({}),
    callback: () => 'done',
  });
  const model = new ScriptedModel([
    { kind: 'maxTokens', text: 'initial partial ' },
    // Recovery succeeds with a tool request, creating a later model cycle whose
    // SDK attemptCount starts at one again.
    { kind: 'success', text: '' },
    { kind: 'maxTokens', text: 'later partial' },
  ]);
  // Replace scripted step two with an explicit tool-use stream.
  const originalStream = model.stream.bind(model);
  let calls = 0;
  model.stream = async function* (messages: Message[], options?: StreamOptions) {
    calls += 1;
    if (calls !== 2) {
      yield* originalStream(messages, options);
      return;
    }
    this.calls.push({ messages: messages.map((message) => message.toJSON()), config: structuredClone(this.getConfig()) });
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'marker', toolUseId: 'marker-1' } };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{}' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  };
  const agent = new Agent({ model, tools: [marker], printer: false });
  installMaxTokensRecovery(agent);
  let failed = false;
  try {
    await agent.invoke('run');
  } catch (error) {
    failed = error instanceof Error && error.name === 'MaxTokensError';
  }
  assert('later tool-cycle truncation does not gain another continuation', failed && model.calls.length === 3);
  assert('the later partial is still retained before failure', conversationText(agent.messages).includes('later partial'));
}

async function childCoverage(): Promise<void> {
  header('max tokens — SubagentTool child returns the coherent recovered report');
  const registry: AgentDefinitionRegistry = {
    definitions: [{
      name: 'general',
      description: 'test child',
      systemPrompt: 'report',
      tools: [],
      file: undefined,
    }],
    problems: [],
  };
  const childModel = new ScriptedModel([
    { kind: 'maxTokens', text: 'child partial ' },
    { kind: 'success', text: 'child end' },
  ]);
  const subagents = new SubagentTool({
    registry,
    tools: [],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: '/tmp', ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: {
      provider: 'bedrock', model: 'fake', region: 'us-west-2', maxTokens: 64_000,
      permissionMode: 'yolo', promptCache: false, thinkingEffort: 'high',
      summaryRatio: 0.8, preserveRecentMessages: 4, modelChoices: [],
    },
    createModel: async () => childModel,
  });
  try {
    const parent = new Agent({ model: new ScriptedModel([{ kind: 'success', text: 'unused' }]), tools: [subagents.tool], printer: false });
    await parent.initialize();
    const response = await parent.tool.subagent?.invoke({ task: 'long child task' });
    assert('child recovery is wired and returns both pieces once', JSON.stringify(response).includes('child partial child end') && childModel.calls.length === 2);
  } finally {
    await subagents.shutdown();
  }
}

async function invokeProjection(): Promise<void> {
  header('max tokens — invoke-only result projection');
  const model = new ScriptedModel([
    { kind: 'maxTokens', text: 'retained ' },
    { kind: 'success', text: 'final' },
  ]);
  const agent = recoveredAgent(model);
  const invocationState = {};
  const result = await agent.invoke('go', { invocationState });
  assert('invoke consumers can prepend privately retained text', withRetainedMaxTokensText(result.toString(), invocationState) === 'retained final');
}

await successContracts();
await ordinaryFailuresAndCancellation();
await headlessProjection();
await tuiProjection();
await secondTruncationPersists();
await invocationWideAllowance();
await invokeProjection();
await childCoverage();
report();
