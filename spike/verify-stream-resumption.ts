/** Network-free SRF-001 classification, SDK stream, trajectory, and bound checks. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  ContextWindowOverflowError,
  MaxTokensError,
  Model,
  ModelError,
  Message,
  type BaseModelConfig,
  type ModelStreamEvent,
} from '@strands-agents/sdk';

import {
  isRetryableStreamInterruption,
  runWithStreamResumption,
  STREAM_CONTINUATION_PROMPT,
} from '../src/agent/stream-resumption.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { recordStream } from '../src/trajectory/stream.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
import type { TurnEndedRecord } from '../src/trajectory/record.js';
import { assert, header, report } from './shared.js';

const INTERRUPTION = 'Stream ended without completing a message';

class ScriptedInterruptionModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.stream-resumption', contextWindowLimit: 200_000 };
  readonly inputs: string[] = [];
  calls = 0;

  constructor(private readonly failCalls: number) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    this.inputs.push(messages.at(-1)?.content.flatMap((block) => block.type === 'textBlock' ? [block.text] : []).join('') ?? '');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'textDelta', text: this.calls <= this.failCalls ? 'partial work' : 'continued safely' },
    };
    if (this.calls <= this.failCalls) throw new ModelError(INTERRUPTION);
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function recorder(file: string): TrajectoryRecorder {
  return new TrajectoryRecorder({
    file,
    run: {
      session: 'session-stream-resumption', agentId: 'darwin', darwinVersion: 'test',
      provider: 'bedrock', model: 'fake.stream-resumption', permissionMode: 'default',
      thinkingEffort: 'low', resumed: false, restoredMessages: 0,
    },
  });
}

async function realAgentTrajectoryContract(): Promise<void> {
  header('stream resumption — real Agent, failed trajectory, one continuation');
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-stream-resumption-'));
  try {
    const file = path.join(root, 'trajectory.jsonl');
    const rec = recorder(file);
    const model = new ScriptedInterruptionModel(1);
    const agent = new Agent({ model, systemPrompt: 'test', printer: false });
    await agent.initialize();
    const inputs: string[] = [];
    const originalErrors: ModelError[] = [];

    const result = await runWithStreamResumption(
      'original request containing PRIVATE-ORIGINAL-TEXT',
      async (input) => {
        inputs.push(input);
        const seen = [];
        for await (const event of recordStream(agent.stream(input), rec.beginTurn(input))) seen.push(event);
        return seen;
      },
      (error) => originalErrors.push(error),
    );
    await rec.close();

    const read = await readTrajectory(file);
    const ends = read.records.filter((record): record is TurnEndedRecord => record.type === 'turnEnded');
    const userInputs = read.records.filter((record) => record.type === 'userInput');
    assert('recognized interruption runs exactly one distinct continuation', model.calls === 2 && inputs.length === 2);
    assert('the first failed turn and successful continuation are distinct trajectory turns',
      ends.length === 2 && ends[0]?.failure?.name === 'ModelError' && ends[1]?.stopReason === 'endTurn');
    assert('the observer exposes the original ModelError object before continuing',
      originalErrors.length === 1 && originalErrors[0]?.message === INTERRUPTION);
    assert('the continuation result comes from the second ordinary Agent stream',
      result.some((event) => event.type === 'agentResultEvent'));
    assert('the internal prompt is bounded and explicitly anti-repeat',
      [...STREAM_CONTINUATION_PROMPT].length <= 500 &&
      STREAM_CONTINUATION_PROMPT.includes('Do not repeat completed work') &&
      STREAM_CONTINUATION_PROMPT.includes('Do not') &&
      !STREAM_CONTINUATION_PROMPT.includes('PRIVATE-ORIGINAL-TEXT'));
    assert('trajectory records the bounded continuation prompt, not a replay of original private text',
      userInputs.length === 2 && userInputs[1]?.type === 'userInput' &&
      userInputs[1].text === STREAM_CONTINUATION_PROMPT && !userInputs[1].text.includes('PRIVATE-ORIGINAL-TEXT'));
    assert('the failed turn bytes remain before the append-only continuation turn',
      (await readFile(file, 'utf8')).indexOf('"failure"') < (await readFile(file, 'utf8')).lastIndexOf('"userInput"'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function boundedRetryContract(): Promise<void> {
  header('stream resumption — second failure and exclusion matrix');
  const model = new ScriptedInterruptionModel(2);
  const agent = new Agent({ model, systemPrompt: 'test', printer: false });
  await agent.initialize();
  let caught: unknown;
  try {
    await runWithStreamResumption(
      'original',
      async (input) => {
        for await (const _event of agent.stream(input)) { /* consume */ }
        return undefined;
      },
      () => undefined,
    );
  } catch (error) {
    caught = error;
  }
  assert('a qualifying continuation failure is not retried again',
    model.calls === 2 && caught instanceof ModelError && caught.message === INTERRUPTION);

  const cases: unknown[] = [
    new ModelError('authentication failed'),
    new ModelError('validation failed'),
    new ModelError('generic provider failure'),
    new MaxTokensError('maximum tokens reached', new Message({ role: 'assistant', content: [] })),
    new ContextWindowOverflowError('context window exceeded'),
    new Error(INTERRUPTION),
    new Error('Interrupted.'),
  ];
  assert('only the exact ModelError stream interruption is classified retryable',
    isRetryableStreamInterruption(new ModelError(INTERRUPTION)) &&
    isRetryableStreamInterruption(new ModelError(`${INTERRUPTION}.`)) &&
    cases.every((error) => !isRetryableStreamInterruption(error)));
  for (const error of cases) {
    let calls = 0;
    let observed: unknown;
    try {
      await runWithStreamResumption('original', async () => {
        calls += 1;
        throw error;
      }, () => undefined);
    } catch (thrown) {
      observed = thrown;
    }
    assert(`excluded ${error instanceof Error ? error.name : 'value'} is thrown identically without continuation`,
      calls === 1 && observed === error);
  }
}

await realAgentTrajectoryContract();
await boundedRetryContract();
report();
