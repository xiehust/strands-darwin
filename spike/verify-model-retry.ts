/**
 * Offline SER-066 contracts: darwin owns model-call retry through the SDK's own
 * extension points, with the SDK's schedule, a failure the driver sees at once, and a
 * wait that `cancel()` ends without spending another model call.
 *
 * Every scenario drives the real `AgentRuntime` (or the real `SubagentTool` child
 * recipe) with a scripted `Model` subclass and no network. The schedule is shortened
 * through the module's test seam only; production keeps the SDK default numbers.
 *
 * What is measured, and why the bounds are what they are:
 * - `FAILURE_TO_EVENT_MS` bounds how late a failed `afterModelCallEvent` may reach the
 *   driver after the fake model threw. The SDK default would deliver it only after the
 *   whole backoff; anything near the backoff (`WAIT_MS`) is the defect this guards.
 * - `CANCEL_SETTLE_MS` bounds how long `send()` may take to settle after `cancel()`
 *   lands inside a `LONG_WAIT_MS` wait; the SDK default would need the full wait.
 * - Calls are counted on the fake model itself, so "no further model call" is a fact
 *   about the provider boundary, not about events.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  ConstantBackoff,
  ContextWindowOverflowError,
  MaxTokensError,
  Message,
  Model,
  ModelError,
  ModelThrottledError,
  TextBlock,
  type AgentStreamEvent,
  type BaseModelConfig,
  type ModelStreamEvent,
} from '@strands-agents/sdk';

import {
  DEFAULT_MODEL_RETRY_BASE_MS,
  DEFAULT_MODEL_RETRY_MAX_ATTEMPTS,
  DEFAULT_MODEL_RETRY_MAX_MS,
  RETRY_REASON_MAX_CODE_POINTS,
  defaultModelRetrySchedule,
  installModelRetry,
  isRetryableModelError,
  retryReason,
  setModelRetryScheduleForTest,
  type RetryWaitState,
} from '../src/agent/model-retry.js';
import { allowAllBridge, PermissionGate } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { trajectoryPath } from '../src/agent/session.js';
import { SubagentDispatchRegistry } from '../src/agents/dispatch-registry.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import { SubagentTool, SUBAGENT_TOOL_NAME } from '../src/agents/subagent-tool.js';
import { configPath } from '../src/config.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import type { TurnEndedRecord } from '../src/trajectory/record.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('model-retry');

const WAIT_MS = 300;
const LONG_WAIT_MS = 5_000;
const FAILURE_TO_EVENT_MS = 100;
const CANCEL_SETTLE_MS = 500;

type Step = 'throttle' | 'bedrock-throttle' | 'validation' | 'ok';

const BEDROCK_THROTTLE_MESSAGE = 'Too many requests, please wait before trying again.';

/** Plays one scripted step per model call; the last step repeats when the script runs out. */
class ScriptedModel extends Model<BaseModelConfig> {
  readonly callsAt: number[] = [];
  readonly failedAt: number[] = [];
  readonly thrown: Error[] = [];
  private config: BaseModelConfig = { modelId: 'fake.model-retry', contextWindowLimit: 32_000 };
  constructor(private readonly steps: Step[]) {
    super();
  }
  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }
  override getConfig(): BaseModelConfig {
    return this.config;
  }
  override async *stream(): AsyncIterable<ModelStreamEvent> {
    this.callsAt.push(Date.now());
    const step = this.steps.length > 1 ? this.steps.shift()! : this.steps[0]!;
    if (step !== 'ok') {
      const error =
        step === 'throttle'
          ? new ModelThrottledError('Rate exceeded')
          : Object.assign(new Error(step === 'bedrock-throttle' ? BEDROCK_THROTTLE_MESSAGE : 'Malformed input'), {
              name: step === 'bedrock-throttle' ? 'ThrottlingException' : 'ValidationException',
            });
      this.thrown.push(error);
      this.failedAt.push(Date.now());
      throw error;
    }
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'recovered' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

interface Observed {
  /** Receipt time of each failed `afterModelCallEvent`, in order. */
  failuresSeenAt: number[];
  attempts: number[];
  stopReason: string | undefined;
  error: unknown;
  /** `runtime.retryWait()` sampled when each failed event arrived. */
  waitAtFailure: (RetryWaitState | undefined)[];
  /** `runtime.retryWait()` sampled mid-wait by a timer armed at the first failure. */
  waitMidway: RetryWaitState | undefined;
}

async function drive(runtime: AgentRuntime, prompt: string, onEvent?: (event: AgentStreamEvent) => void): Promise<Observed> {
  const observed: Observed = {
    failuresSeenAt: [],
    attempts: [],
    stopReason: undefined,
    error: undefined,
    waitAtFailure: [],
    waitMidway: undefined,
  };
  try {
    for await (const event of runtime.send(prompt)) {
      if (event.type === 'afterModelCallEvent' && event.error !== undefined) {
        observed.failuresSeenAt.push(Date.now());
        observed.attempts.push(event.attemptCount);
        observed.waitAtFailure.push(runtime.retryWait());
        if (observed.failuresSeenAt.length === 1) {
          setTimeout(() => {
            observed.waitMidway = runtime.retryWait();
          }, WAIT_MS / 2);
        }
      }
      if (event.type === 'agentResultEvent') observed.stopReason = event.result.stopReason;
      onEvent?.(event);
    }
  } catch (error) {
    observed.error = error;
  }
  return observed;
}

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-model-retry-'));
await writeFile(
  configPath(),
  `${JSON.stringify({ provider: 'bedrock', model: 'fake.model-retry', region: 'us-west-2', contextOffload: false })}\n`,
);

async function withRuntime<T>(model: ScriptedModel, body: (runtime: AgentRuntime) => Promise<T>): Promise<T> {
  setRuntimeModelFactoryForTest(async () => model);
  const runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });
  try {
    return await body(runtime);
  } finally {
    await runtime.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
}

function shortSchedule(maxAttempts: number, delayMs: number): void {
  setModelRetryScheduleForTest(() => ({ maxAttempts, backoff: new ConstantBackoff({ delayMs }) }));
}

/** Live `setTimeout` handles in this process (Node ≥ 17); a leaked wait timer shows up here. */
function activeTimeouts(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;
}

try {
  header('model retry — classifier and production defaults (pure)');
  {
    const schedule = defaultModelRetrySchedule();
    assert(
      'the production schedule is the SDK default: 6 attempts, exponential 4 s base / 240 s cap',
      schedule.maxAttempts === 6 &&
        DEFAULT_MODEL_RETRY_MAX_ATTEMPTS === 6 &&
        DEFAULT_MODEL_RETRY_BASE_MS === 4_000 &&
        DEFAULT_MODEL_RETRY_MAX_MS === 240_000 &&
        schedule.backoff.constructor.name === 'ExponentialBackoff',
    );
    const delays = [1, 2, 3, 4, 5].map((attempt) => schedule.backoff.nextDelay({ attempt, elapsedMs: 0 }));
    assert(
      'full jitter: every default delay lies within [0, min(4000·2^(n−1), 240000)]',
      delays.every((delay, index) => delay >= 0 && delay <= Math.min(4_000 * 2 ** index, 240_000)),
    );
    const bedrock = new ModelError(BEDROCK_THROTTLE_MESSAGE, {
      cause: Object.assign(new Error(BEDROCK_THROTTLE_MESSAGE), { name: 'ThrottlingException' }),
    });
    const validation = new ModelError('Malformed input', {
      cause: Object.assign(new Error('Malformed input'), { name: 'ValidationException' }),
    });
    const interruption = new ModelError('Stream ended without completing a message', {
      cause: Object.assign(new Error('x'), { name: 'ThrottlingException' }),
    });
    const partial = new Message({ role: 'assistant', content: [new TextBlock('partial')] });
    assert('ModelThrottledError is retryable', isRetryableModelError(new ModelThrottledError('Rate exceeded')));
    assert('a ModelError caused by an AWS ThrottlingException is retryable', isRetryableModelError(bedrock));
    assert('a ModelError with another cause is not', !isRetryableModelError(validation));
    assert('a ModelError without a cause is not', !isRetryableModelError(new ModelError('opaque')));
    assert(
      'overflow, max-tokens and the stream-interruption text are never retryable, whatever the cause',
      !isRetryableModelError(new ContextWindowOverflowError('too long')) &&
        !isRetryableModelError(new MaxTokensError('cut', partial)) &&
        !isRetryableModelError(interruption),
    );
    assert('plain errors and non-errors are not retryable', !isRetryableModelError(new Error('x')) && !isRetryableModelError('x'));
    assert(
      'reason names the throttle class and message',
      retryReason(new ModelThrottledError('Rate exceeded')) === 'ModelThrottledError: Rate exceeded' &&
        retryReason(bedrock) === `ThrottlingException: ${BEDROCK_THROTTLE_MESSAGE}`,
    );
    const long = retryReason(new ModelThrottledError('é'.repeat(RETRY_REASON_MAX_CODE_POINTS + 50)));
    assert(
      `reason is bounded at ${RETRY_REASON_MAX_CODE_POINTS} code points with an ellipsis`,
      Array.from(long).length === RETRY_REASON_MAX_CODE_POINTS && long.endsWith('…'),
    );
    let threw = false;
    try {
      installModelRetry(new Agent({ model: new ScriptedModel(['ok']), printer: false, retryStrategy: null }), {
        maxAttempts: 0,
        backoff: new ConstantBackoff({ delayMs: 1 }),
      });
    } catch {
      threw = true;
    }
    assert('an invalid maxAttempts is refused at install time', threw);
  }

  header('model retry — (a) throttled twice, succeeds on attempt 3; failures reach the driver before the wait');
  {
    shortSchedule(6, WAIT_MS);
    const model = new ScriptedModel(['throttle', 'throttle', 'ok']);
    const observed = await withRuntime(model, (runtime) => drive(runtime, 'retry me'));
    assert('the turn ends endTurn', observed.stopReason === 'endTurn' && observed.error === undefined);
    assert('exactly three model calls were made', model.callsAt.length === 3);
    assert(
      'the driver saw attempts 1 and 2 fail, in order',
      JSON.stringify(observed.attempts) === '[1,2]' && observed.failuresSeenAt.length === 2,
    );
    const lateness = observed.failuresSeenAt.map((seen, index) => seen - model.failedAt[index]!);
    assert(
      `each failed afterModelCallEvent reached the driver within ${FAILURE_TO_EVENT_MS} ms of the failure (${lateness.join(', ')} ms)`,
      lateness.every((ms) => ms >= 0 && ms < FAILURE_TO_EVENT_MS),
    );
    const gaps = observed.failuresSeenAt.map((seen, index) => model.callsAt[index + 1]! - seen);
    assert(
      `the next attempt started only after the ${WAIT_MS} ms wait (${gaps.join(', ')} ms after the event)`,
      gaps.every((ms) => ms >= WAIT_MS - 15),
    );
    assert(
      'the driver never saw a failed event for the successful attempt',
      !observed.attempts.includes(3),
    );
  }

  header('model retry — (e) the retry-wait state is published before the wait and cleared after the turn');
  {
    shortSchedule(6, WAIT_MS);
    const model = new ScriptedModel(['throttle', 'ok']);
    let afterTurn: RetryWaitState | undefined | 'unread' = 'unread';
    const observed = await withRuntime(model, async (runtime) => {
      const seen = await drive(runtime, 'state me');
      afterTurn = runtime.retryWait();
      return seen;
    });
    const atFailure = observed.waitAtFailure[0];
    assert(
      'when the failed event arrives, retryWait() already reports the decided wait',
      atFailure !== undefined &&
        atFailure.attempt === 1 &&
        atFailure.maxAttempts === 6 &&
        atFailure.waitMs === WAIT_MS &&
        atFailure.reason === 'ModelThrottledError: Rate exceeded',
    );
    assert(
      'until is the failure time plus the wait, in epoch milliseconds',
      atFailure !== undefined &&
        Math.abs(atFailure.until - (model.failedAt[0]! + WAIT_MS)) < FAILURE_TO_EVENT_MS,
    );
    assert('the state is frozen', atFailure !== undefined && Object.isFrozen(atFailure));
    assert(
      'midway through the wait the same state is still readable',
      observed.waitMidway !== undefined && observed.waitMidway.attempt === 1 && observed.waitMidway.until === atFailure?.until,
    );
    assert('after the turn ends retryWait() is undefined', afterTurn === undefined && observed.stopReason === 'endTurn');
  }

  header('model retry — (c) Bedrock pre-stream ThrottlingException is retried; another cause is not');
  {
    shortSchedule(6, WAIT_MS);
    const model = new ScriptedModel(['bedrock-throttle', 'ok']);
    const observed = await withRuntime(model, (runtime) => drive(runtime, 'bedrock 429'));
    assert(
      'a ModelError wrapping an AWS ThrottlingException is retried and the turn succeeds on attempt 2',
      observed.stopReason === 'endTurn' && model.callsAt.length === 2 && JSON.stringify(observed.attempts) === '[1]',
    );
    assert(
      'the SDK really wrapped the fake provider error as a plain ModelError with the exception as cause',
      observed.waitAtFailure[0]?.reason === `ThrottlingException: ${BEDROCK_THROTTLE_MESSAGE}`,
    );

    const other = new ScriptedModel(['validation', 'ok']);
    const failed = await withRuntime(other, (runtime) => drive(runtime, 'bad input'));
    assert(
      'a ModelError with a ValidationException cause fails the turn on attempt 1',
      failed.error instanceof ModelError && failed.stopReason === undefined && other.callsAt.length === 1,
    );
    assert(
      'the error reaching send() is the SDK-wrapped ModelError of that attempt, cause intact',
      failed.error instanceof ModelError && failed.error.cause === other.thrown[0] && failed.waitAtFailure[0] === undefined,
    );
  }

  header('model retry — (d) every attempt throttles: exactly maxAttempts calls, original error, failure recorded');
  {
    shortSchedule(3, WAIT_MS);
    const model = new ScriptedModel(['throttle']);
    let sessionId = '';
    const observed = await withRuntime(model, async (runtime) => {
      sessionId = runtime.info.sessionId;
      return drive(runtime, 'always throttled');
    });
    assert('exactly maxAttempts (3) model calls were made', model.callsAt.length === 3);
    assert(
      'send() throws the last attempt\'s own error object',
      observed.error === model.thrown[2] && observed.error instanceof ModelThrottledError,
    );
    assert('the driver saw every failed attempt, including the last', JSON.stringify(observed.attempts) === '[1,2,3]');
    assert('no wait was decided for the last attempt', observed.waitAtFailure[2] === undefined);
    const read = await readTrajectory(trajectoryPath(root, sessionId));
    const ended = read.records.find((record): record is TurnEndedRecord => record.type === 'turnEnded');
    assert(
      'the trajectory turnEnded carries the failure and no stop reason',
      ended !== undefined &&
        ended.failure?.name === 'ModelThrottledError' &&
        ended.failure.message === 'Rate exceeded' &&
        ended.stopReason === undefined,
    );
    assert(
      'no modelCall record was invented for a failed attempt',
      read.records.every((record) => record.type !== 'modelCall'),
    );
  }

  header('model retry — (b) cancel() during a wait settles promptly with no further model call');
  {
    shortSchedule(6, LONG_WAIT_MS);
    const model = new ScriptedModel(['throttle']);
    let cancelledAt = 0;
    let settledAt = 0;
    let midWait: RetryWaitState | undefined;
    let afterCancel: RetryWaitState | undefined | 'unread' = 'unread';
    const timeoutsBefore = activeTimeouts();
    const observed = await withRuntime(model, async (runtime) => {
      const seen = await drive(runtime, 'cancel me', (event) => {
        if (event.type === 'afterModelCallEvent' && event.error !== undefined && cancelledAt === 0) {
          setTimeout(() => {
            midWait = runtime.retryWait();
            cancelledAt = Date.now();
            runtime.cancel();
          }, 150);
        }
      });
      settledAt = Date.now();
      afterCancel = runtime.retryWait();
      return seen;
    });
    assert('the cancel landed inside a published wait', midWait !== undefined && midWait.attempt === 1 && midWait.waitMs === LONG_WAIT_MS);
    assert(
      `send() settled within ${CANCEL_SETTLE_MS} ms of cancel() (${settledAt - cancelledAt} ms), not after the ${LONG_WAIT_MS} ms wait`,
      cancelledAt > 0 && settledAt - cancelledAt < CANCEL_SETTLE_MS,
    );
    assert('the fake model recorded no further call after cancel', model.callsAt.length === 1);
    assert(
      'the turn ends with the last attempt\'s own error (the SDK loop settles cancelled only after a provider call)',
      observed.error === model.thrown[0] && observed.stopReason === undefined,
    );
    assert('the retry-wait state is cleared by the cancel', afterCancel === undefined);
    assert(
      'the aborted attempt is reported once more and never retried',
      JSON.stringify(observed.attempts) === '[1,2]' && observed.waitAtFailure[1] === undefined,
    );
    const timers = activeTimeouts();
    assert(
      `no wait timer survives the cancel (${timeoutsBefore} live timeouts before, ${timers} after; a leaked one would hold the process ${LONG_WAIT_MS} ms)`,
      timers <= timeoutsBefore,
    );
  }

  header('model retry — a fresh turn after a failed one starts a fresh budget');
  {
    shortSchedule(2, WAIT_MS);
    const model = new ScriptedModel(['throttle', 'throttle', 'throttle', 'ok']);
    const results = await withRuntime(model, async (runtime) => {
      const first = await drive(runtime, 'first');
      const second = await drive(runtime, 'second');
      return { first, second };
    });
    assert(
      'turn 1 fails at the cap (2 calls) and turn 2 retries once more before succeeding (2 calls)',
      results.first.error instanceof ModelThrottledError &&
        results.second.stopReason === 'endTurn' &&
        model.callsAt.length === 4 &&
        JSON.stringify(results.second.attempts) === '[1]',
    );
  }

  header('model retry — (f) a recipe child retries the same way and dispatch cancel is not delayed by its wait');
  {
    const registry: AgentDefinitionRegistry = {
      definitions: [
        { name: 'general', description: 'offline child', systemPrompt: 'offline child', tools: undefined, file: '/tmp/general.md' },
      ],
      problems: [],
    };
    const gate = new PermissionGate({ mode: 'yolo', projectRoot: '/tmp', ask: async () => ({ allowed: true }) });
    const fakeConfig = { model: 'offline', provider: 'bedrock', region: 'us-west-2' } as never;
    const fixture = (models: ScriptedModel[]) => {
      const dispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
      const tool = new SubagentTool({
        registry,
        tools: [],
        intervention: gate,
        projectInstructions: undefined,
        config: fakeConfig,
        createModel: async () => models.shift()!,
        dispatches,
      });
      return { tool, dispatches };
    };
    const host = async (tool: SubagentTool): Promise<Agent> => {
      const agent = new Agent({ model: new ScriptedModel(['ok']), tools: [tool.tool], printer: false, retryStrategy: null });
      await agent.initialize();
      return agent;
    };
    type DirectResult = { status?: string; content?: Array<{ text?: string }> };

    shortSchedule(6, WAIT_MS);
    const childModel = new ScriptedModel(['throttle', 'bedrock-throttle', 'ok']);
    const ok = fixture([childModel]);
    const parent = await host(ok.tool);
    const startedAt = Date.now();
    const result = (await parent.tool[SUBAGENT_TOOL_NAME]!.invoke({ task: 'retry inside' } as never, {
      recordDirectToolCall: false,
    })) as DirectResult;
    const elapsed = Date.now() - startedAt;
    assert(
      'the child retried an in-stream throttle and a pre-stream ThrottlingException, then reported',
      result.status === 'success' && childModel.callsAt.length === 3 && (result.content ?? []).some((b) => b.text?.includes('recovered')),
    );
    assert(`the child honoured both waits (${elapsed} ms ≥ ${2 * WAIT_MS} ms)`, elapsed >= 2 * WAIT_MS - 20);
    assert('the child dispatch settled succeeded', ok.dispatches.list().every((entry) => entry.state === 'succeeded'));

    shortSchedule(6, LONG_WAIT_MS);
    const stuckModel = new ScriptedModel(['throttle']);
    const stuck = fixture([stuckModel]);
    const parent2 = await host(stuck.tool);
    const invocation = parent2.tool[SUBAGENT_TOOL_NAME]!.invoke({ task: 'wait forever' } as never, {
      recordDirectToolCall: false,
    }) as Promise<DirectResult>;
    // Let the child make its one call and enter the wait.
    const deadline = Date.now() + 2_000;
    while (stuckModel.callsAt.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    const running = stuck.dispatches.list().find((entry) => entry.state === 'running');
    const cancelAt = Date.now();
    const cancelOutcome = running === undefined ? undefined : stuck.dispatches.cancel(running.dispatchId).outcome;
    const settled = await invocation;
    const settleMs = Date.now() - cancelAt;
    assert('the targeted dispatch cancel was accepted while the child waited', cancelOutcome === 'cancelled');
    assert(
      `the dispatch settled within ${CANCEL_SETTLE_MS} ms of the cancel (${settleMs} ms), not after ${LONG_WAIT_MS} ms`,
      settleMs < CANCEL_SETTLE_MS,
    );
    assert('the child model recorded no further call after the cancel', stuckModel.callsAt.length === 1);
    assert(
      'the tool result is an error naming the throttle, and the dispatch is terminal',
      settled.status === 'error' &&
        (settled.content ?? []).some((b) => b.text?.includes('Rate exceeded')) &&
        stuck.dispatches.list().every((entry) => entry.state !== 'running'),
    );
  }
} finally {
  setModelRetryScheduleForTest(undefined);
  setRuntimeModelFactoryForTest(undefined);
  await rm(root, { recursive: true, force: true });
}

report();
