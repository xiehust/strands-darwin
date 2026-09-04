/**
 * Darwin-owned model-call retry (SER-066): the SDK's schedule, a cancellable wait,
 * and a visible failure.
 *
 * The pinned SDK's `DefaultModelRetryStrategy` sleeps inside its `AfterModelCallEvent`
 * hook callback, and `Agent._streamCore` runs hook callbacks *before* it yields the
 * event to the consumer — so a driver learns of a throttled attempt only after the
 * whole backoff has elapsed, and `agent.cancel()` during that sleep does nothing
 * until it ends (the loop then spends one more model call before settling). Any
 * darwin hook that slept in the same place would inherit both defects, so the wait
 * is split across two SDK extension points on the same Agent:
 *
 * 1. The `AfterModelCallEvent` hook only *decides*: classifies the error, computes
 *    the delay, publishes the bounded wait state, and sets `event.retry = true` at
 *    once. The failed event therefore reaches the driver within milliseconds of the
 *    failure, and the loop moves on to the next attempt.
 * 2. An `InvokeModelStage` wrap middleware — the SDK's designed interception point
 *    around one model call — performs the pending wait *before* calling `next()`.
 *    The wait resolves on its timer or on `cancelSignal` abort; on abort the
 *    middleware rethrows the attempt's original error without invoking the provider,
 *    so the loop's ordinary catch path (`AfterModelCallEvent` with that error, no
 *    retry because the signal is aborted) ends the turn with no further model call.
 *
 * `AgentRuntime.create` and `buildRecipeChild` pass `retryStrategy: null` so the SDK
 * default no longer stacks its own uncancellable sleep; each Agent gets one installer
 * call and one private state (never shared across agents). The schedule is the SDK's
 * own numbers through the SDK's own exported `ExponentialBackoff`.
 */
import {
  AfterInvocationEvent,
  AfterModelCallEvent,
  BeforeInvocationEvent,
  ContextWindowOverflowError,
  ExponentialBackoff,
  InvokeModelStage,
  MaxTokensError,
  ModelError,
  ModelThrottledError,
  type BackoffStrategy,
  type LocalAgent,
  type MiddlewareHandlerOf,
} from '@strands-agents/sdk';

import { isRetryableStreamInterruption } from './stream-resumption.js';

/** The SDK default's numbers (`DefaultModelRetryStrategy`), kept on purpose. */
export const DEFAULT_MODEL_RETRY_MAX_ATTEMPTS = 6;
export const DEFAULT_MODEL_RETRY_BASE_MS = 4_000;
export const DEFAULT_MODEL_RETRY_MAX_MS = 240_000;
/** Upper bound of the published `reason`, in code points. */
export const RETRY_REASON_MAX_CODE_POINTS = 200;

export interface ModelRetrySchedule {
  /** Total model calls one retry budget may make (the SDK counts the first as attempt 1). */
  readonly maxAttempts: number;
  readonly backoff: BackoffStrategy;
}

/** One retry wait, published before it begins and cleared when it ends. Immutable. */
export interface RetryWaitState {
  /** The attempt that failed (1-based, the SDK's `attemptCount`). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly waitMs: number;
  /** Epoch milliseconds when the next attempt may start. */
  readonly until: number;
  /** ≤ {@link RETRY_REASON_MAX_CODE_POINTS} code points, derived from the error name/message. */
  readonly reason: string;
}

/**
 * How the last turn's retry budget ended, when it ended badly (SER-067). `exhausted`:
 * every one of `attempts` calls was throttled and the last error propagated.
 * `cancelled`: the wait before `attempt` (the attempt that was about to be made, out of
 * `maxAttempts`) was aborted by `cancel()`, so the turn ended with the previous attempt's
 * error and no further model call. Cleared when the next invocation begins.
 */
export type ModelRetryOutcome =
  | { readonly kind: 'exhausted'; readonly attempts: number }
  | { readonly kind: 'cancelled'; readonly attempt: number; readonly maxAttempts: number };

export interface ModelRetryHandle {
  /** The wait in progress (or decided and about to start), `undefined` otherwise. */
  retryWait(): RetryWaitState | undefined;
  /** The last invocation's bad retry ending, until the next invocation begins. */
  retryOutcome(): ModelRetryOutcome | undefined;
}

/**
 * Optional observer for one installer's waits — how a recipe child publishes its
 * (otherwise private) wait as a dispatch phase. Callbacks run synchronously inside the
 * hook/middleware and must not throw; a throw is swallowed so it cannot alter the loop.
 */
export interface ModelRetryObserver {
  /** A wait was decided and is about to begin. */
  waitStarted?(state: RetryWaitState): void;
  /**
   * The wait ended: `completed` is true when the timer elapsed and the next attempt
   * begins, false when it was cancelled (or abandoned before it ran).
   */
  waitEnded?(state: RetryWaitState, completed: boolean): void;
}

/**
 * The attempt a wait leads to — `state.attempt` is the one that failed, so the next
 * is one more. Every SER-067 surface (busy row, headless event, child phase, notices)
 * names *this* number: "retry 3/6" is the third call of six about to be made.
 */
export function retryNextAttempt(state: RetryWaitState): number {
  return state.attempt + 1;
}

/**
 * `throttled, retry 3/6 in 12s` — the one bounded phrase every live surface appends.
 * Remaining seconds are `until` against `nowMs`, rounded up so `0s` appears only once
 * the deadline has passed, and never negative. No `reason`: the row is bounded and
 * provider text may be long.
 */
export function describeRetryWait(state: RetryWaitState, nowMs: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((state.until - nowMs) / 1000));
  return `throttled, retry ${retryNextAttempt(state)}/${state.maxAttempts} in ${remainingSeconds}s`;
}

/**
 * The failed turn's notice, with the retry ending named when there is one:
 * `turn failed after 6 attempts: <message>` at the cap, `cancelled during retry wait
 * (attempt 2/6): <message>` after a cancelled wait, plain `turn failed: <message>`
 * otherwise. Shared by the TUI and headless drivers so the two cannot drift.
 */
export function retryFailureNotice(outcome: ModelRetryOutcome | undefined, message: string): string {
  const heading = retryFailureHeading(outcome);
  return `${heading ?? 'turn failed'}: ${message}`;
}

/** The heading alone (`turn failed after 6 attempts`), or `undefined` when retry played no part. */
export function retryFailureHeading(outcome: ModelRetryOutcome | undefined): string | undefined {
  if (outcome === undefined) return undefined;
  if (outcome.kind === 'exhausted') {
    return `turn failed after ${outcome.attempts} ${outcome.attempts === 1 ? 'attempt' : 'attempts'}`;
  }
  return `cancelled during retry wait (attempt ${outcome.attempt}/${outcome.maxAttempts})`;
}

/** A fresh SDK-default schedule: 6 attempts, exponential 4 s base / 240 s cap, full jitter. */
export function defaultModelRetrySchedule(): ModelRetrySchedule {
  return {
    maxAttempts: DEFAULT_MODEL_RETRY_MAX_ATTEMPTS,
    backoff: new ExponentialBackoff({ baseMs: DEFAULT_MODEL_RETRY_BASE_MS, maxMs: DEFAULT_MODEL_RETRY_MAX_MS }),
  };
}

/**
 * Test seam: a factory for the schedule every later installer call uses, so offline
 * suites run in seconds. Production never sets it — the default stays the SDK's numbers.
 */
let scheduleFactoryForTest: (() => ModelRetrySchedule) | undefined;

export function setModelRetryScheduleForTest(factory: (() => ModelRetrySchedule) | undefined): void {
  scheduleFactoryForTest = factory;
}

/**
 * Whether a failed model call may be retried against unchanged history.
 *
 * `ModelThrottledError` is the SDK's own retryable set (in-stream Bedrock throttling,
 * Anthropic/OpenAI 429s). The second clause covers Bedrock's *pre-stream* 429: the AWS
 * client's `ThrottlingException` is rethrown as-is by the Bedrock provider and wrapped
 * by `Model.streamAggregated` as a plain `ModelError` whose `cause` is that exception.
 * Overflow, output-token exhaustion and the stream-interruption `ModelError` owned by
 * `stream-resumption.ts` are never retried here, whatever their cause says.
 */
export function isRetryableModelError(error: unknown): boolean {
  if (error instanceof ModelThrottledError) return true;
  if (!(error instanceof ModelError)) return false;
  if (error instanceof ContextWindowOverflowError || error instanceof MaxTokensError) return false;
  // Guarded through an `unknown` alias: the type guard would otherwise narrow the
  // already-known `ModelError` to `never` on its false branch.
  const candidate: unknown = error;
  if (isRetryableStreamInterruption(candidate)) return false;
  const cause: unknown = error.cause;
  return cause instanceof Error && cause.name === 'ThrottlingException';
}

/** `<name>: <message>` (the AWS cause's name for the pre-stream case), bounded in code points. */
export function retryReason(error: Error): string {
  const cause: unknown = error.cause;
  const label =
    !(error instanceof ModelThrottledError) && cause instanceof Error && cause.name !== '' ? cause.name : error.name;
  const message = error.message.trim();
  const text = message === '' ? label : `${label}: ${message}`;
  const points = Array.from(text);
  if (points.length <= RETRY_REASON_MAX_CODE_POINTS) return text;
  return `${points.slice(0, RETRY_REASON_MAX_CODE_POINTS - 1).join('')}…`;
}

interface PendingWait {
  readonly state: RetryWaitState;
  /** The failed attempt's error, rethrown unchanged when the wait is cancelled. */
  readonly error: Error;
}

/**
 * Resolves `true` when `until` has passed, `false` as soon as `signal` aborts. The
 * timer is cleared on both paths, so a cancelled wait leaves no handle behind.
 */
function waitUntilOrAbort(until: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const remaining = Math.max(0, until - Date.now());
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, remaining);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Installs darwin's retry on one Agent constructed with `retryStrategy: null`.
 *
 * Per-budget timing state resets when `event.attemptCount === 1`, exactly where the
 * SDK's `DefaultModelRetryStrategy.onFirstModelAttempt` resets its own. The hook
 * defers to a hook that already set `event.retry`, ignores successes, never acts once
 * the agent's `cancelSignal` is aborted, and stops at `maxAttempts` so the last
 * attempt's error propagates unchanged from the loop.
 */
export function installModelRetry(
  agent: LocalAgent,
  schedule: ModelRetrySchedule = scheduleFactoryForTest?.() ?? defaultModelRetrySchedule(),
  observer: ModelRetryObserver = {},
): ModelRetryHandle {
  if (!Number.isInteger(schedule.maxAttempts) || schedule.maxAttempts < 1) {
    throw new RangeError(`Model retry maxAttempts must be an integer >= 1, got ${schedule.maxAttempts}.`);
  }

  let firstFailureAt: number | undefined;
  let lastDelayMs: number | undefined;
  let pending: PendingWait | undefined;
  let current: RetryWaitState | undefined;
  let outcome: ModelRetryOutcome | undefined;

  const notify = (callback: (() => void) | undefined): void => {
    try {
      callback?.();
    } catch {
      // An observer is presentation; it cannot be allowed to change the loop's course.
    }
  };

  /** Ends the published wait (if any) and tells the observer how it ended. */
  const endWait = (completed: boolean): void => {
    const ended = current;
    pending = undefined;
    current = undefined;
    if (ended !== undefined) notify(() => observer.waitEnded?.(ended, completed));
  };

  // A fresh invocation starts with no story to tell about the previous one.
  agent.addHook(BeforeInvocationEvent, () => {
    outcome = undefined;
  });

  agent.addHook(AfterModelCallEvent, (event) => {
    if (event.attemptCount === 1) {
      firstFailureAt = undefined;
      lastDelayMs = undefined;
    }
    // A wait that was decided but never consumed (another hook redirected the loop)
    // must not leak into a later, unrelated call.
    endWait(false);
    if (event.retry === true || event.error === undefined) return;
    if (event.agent.cancelSignal.aborted) return;
    if (!isRetryableModelError(event.error)) return;
    if (event.attemptCount >= schedule.maxAttempts) {
      outcome = Object.freeze({ kind: 'exhausted', attempts: event.attemptCount });
      return;
    }

    const now = Date.now();
    if (firstFailureAt === undefined) firstFailureAt = now;
    const waitMs = Math.max(
      0,
      schedule.backoff.nextDelay({
        attempt: event.attemptCount,
        elapsedMs: now - firstFailureAt,
        ...(lastDelayMs === undefined ? {} : { lastDelayMs }),
      }),
    );
    lastDelayMs = waitMs;
    const state: RetryWaitState = Object.freeze({
      attempt: event.attemptCount,
      maxAttempts: schedule.maxAttempts,
      waitMs,
      until: now + waitMs,
      reason: retryReason(event.error),
    });
    current = state;
    pending = { state, error: event.error };
    event.retry = true;
    notify(() => observer.waitStarted?.(state));
  });

  // Turn end or failure, whichever way the loop left: nothing is waiting any more.
  agent.addHook(AfterInvocationEvent, () => endWait(false));

  const waitBeforeModelCall: MiddlewareHandlerOf<typeof InvokeModelStage> = async function* (context, next) {
    const wait = pending;
    if (wait !== undefined) {
      pending = undefined;
      let completed = false;
      try {
        completed = await waitUntilOrAbort(wait.state.until, context.agent.cancelSignal);
      } finally {
        if (!completed) {
          outcome = Object.freeze({
            kind: 'cancelled',
            attempt: retryNextAttempt(wait.state),
            maxAttempts: wait.state.maxAttempts,
          });
        }
        endWait(completed);
      }
      // Cancelled mid-wait: the attempt that was scheduled never asks the provider.
      // Rethrowing the failed attempt's own error keeps what `send()` reports exactly
      // what the provider last said; the loop's catch yields the ordinary
      // AfterModelCallEvent for it, and the hook above declines to retry an aborted agent.
      if (!completed) throw wait.error;
    }
    return yield* next(context);
  };
  agent.addMiddleware(InvokeModelStage, waitBeforeModelCall);

  return { retryWait: () => current, retryOutcome: () => outcome };
}
