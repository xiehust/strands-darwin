/** Parent model-stream idle watchdog (SER-095), not a turn deadline. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Middleware } from '@anthropic-ai/sdk';
import { InvokeModelStage } from '@strands-agents/sdk';
import type { LocalAgent, Message, MiddlewareHandlerOf, Model, StreamOptions } from '@strands-agents/sdk';

export const DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS = 120;
export const MAX_STREAM_IDLE_TIMEOUT_SECONDS = 2_147_483;

export class StreamIdleError extends Error {
  constructor(seconds: number) {
    super(`stream idle for ${seconds}s`);
    this.name = 'StreamIdleError';
  }
}

// The direct Anthropic adapter in the pinned SDK drops StreamOptions.cancelSignal.
// Its client middleware is the transport bridge. Async-local scope is entered
// only for a provider iterator read, never around an Agent/tool. Set the public
// request options signal too: the client's error path consults it before retrying
// a pre-header abort. No retry, private provider fields or global fetch replacement.
const transportSignal = new AsyncLocalStorage<AbortSignal>();
export const modelStreamMiddleware: Middleware = (request, next, context) => {
  const signal = transportSignal.getStore();
  if (signal === undefined) return next(request);
  const combined = request.signal ? AbortSignal.any([signal, request.signal]) : signal;
  if (context.options !== undefined) context.options.signal = combined;
  return next({ ...request, signal: combined });
};

/**
 * Register AFTER model retry, so its intentional backoff is outside this stage.
 * A per-call model facade uses the public streamAggregated extension: SDK parsing,
 * event bytes, metadata and model state are unchanged. Only pending provider reads
 * are timed; upstream hooks/driver backpressure, token counting, tools, permission,
 * background completion and compaction have no timer. No prefetch or loop fork.
 */
export function installStreamIdleWatchdog(
  agent: LocalAgent,
  seconds = DEFAULT_STREAM_IDLE_TIMEOUT_SECONDS,
): void {
  const watchdog: MiddlewareHandlerOf<typeof InvokeModelStage> = async function* (context, next) {
    const userSignal = context.agent.cancelSignal;
    const model = context.model;
    let active: ReturnType<Model['streamAggregated']> | undefined;
    const guardedStream: Model['streamAggregated'] = async function* (messages: Message[], options?: StreamOptions) {
      const abort = new AbortController();
      const signal = AbortSignal.any([userSignal, abort.signal]);
      const source = model.streamAggregated(messages, { ...options, cancelSignal: signal });
      let idle: StreamIdleError | undefined;
      let done = false;
      try {
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          if (seconds > 0 && !userSignal.aborted) {
            timer = setTimeout(() => {
              if (userSignal.aborted) return;
              idle = new StreamIdleError(seconds);
              abort.abort();
            }, seconds * 1000);
            timer.unref();
          }
          let result: Awaited<ReturnType<typeof source.next>>;
          try {
            // Await the aborting read, not a detached Promise.race loser. A late
            // result is discarded before the SDK can append it or launch a tool.
            result = await transportSignal.run(signal, () => source.next());
          } catch (error) {
            userSignal.throwIfAborted();
            throw idle ?? error;
          } finally {
            clearTimeout(timer);
          }
          userSignal.throwIfAborted();
          if (idle !== undefined) throw idle;
          if (result.done) {
            done = true;
            return result.value;
          }
          yield result.value;
        }
      } finally {
        abort.abort();
        try {
          if (!done) await source.return(undefined as never);
        } finally {
          // Cleanup cannot replace the terminal idle identity; user cancellation
          // still wins if it arrives while the provider's finally is running.
          userSignal.throwIfAborted();
          if (idle !== undefined) throw idle;
        }
      }
    };
    // Do not mutate the shared provider (children may use it too). Bind delegated
    // methods to the original, including methods with provider-private fields.
    const guarded = new Proxy(model, {
      get(target, key) {
        if (key === 'streamAggregated') return (...args: Parameters<Model['streamAggregated']>) => {
          active = guardedStream(...args);
          return active;
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      return yield* next({ ...context, model: guarded });
    } finally {
      // The SDK checks cancel between yields and manually advances its model
      // iterator. Close ours even when that check bypasses the next provider read.
      try {
        await active?.return(undefined as never);
      } catch (error) {
        // The SDK already owns a between-yield cancellation. Do not replace its
        // internal CancelledError with the provider generator's cleanup abort.
        if (!userSignal.aborted) throw error;
      }
    }
  };
  agent.addMiddleware(InvokeModelStage, watchdog);
}
