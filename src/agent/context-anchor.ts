/**
 * The `/context` measurement anchor.
 *
 * darwin's context size has always been a character heuristic in practice: it asks
 * `Model.countTokens`, and Bedrock's `CountTokens` refuses the inference-profile ids
 * darwin requires, so the SDK caches the model as skipped and falls back to
 * `chars/4` text plus `chars/2` tool-spec JSON. But the provider already reports what
 * each request really cost, and `AgentRuntime` already observes those counters for
 * `/usage`. This module is the pure state that carries one such measurement into the
 * estimate: the prompt-token total of the most recent completed model call, plus
 * where the conversation stood when it happened.
 *
 * With an anchor, `/context` is `measured base + heuristic tail`: the system prompt and
 * every `toolSpec` — the biggest and most heuristic-hostile part of a request — become
 * a measured number, and only the messages appended since that call are estimated. The
 * residual error is therefore bounded by one call's worth of tail rather than
 * accumulating over a session. Deliberately *not* a fitted `measured / heuristic`
 * correction factor: that trades one unknown for another (tokenizer-, provider- and
 * content-dependent), needs unjustifiable smoothing and clamps, and would silently
 * scale everything downstream, including the context-pressure latch.
 *
 * Pure and non-throwing by construction, on `call-stats.ts`'s terms: allocation only,
 * no SDK import, structural reads. The runtime observes model-call events between
 * `stream()` and `yield`, so a malformed payload must cost the anchor, never the turn.
 */
import type { AppConfig } from '../config.js';
import { readCallUsage, type CompletedModelCall } from './call-stats.js';
import { requestInputTokens } from './usage.js';

/** One measured request, and the conversation position it measured. */
export interface ContextAnchor {
  /**
   * The provider's prompt-token total for that call ({@link requestInputTokens}):
   * uncached input plus cache reads and writes, because a cached prefix still
   * occupies the context window.
   */
  requestTokens: number;
  /** `agent.messages.length` as observed when the call completed. */
  messageCount: number;
  /**
   * The message object at `messageCount - 1`, by reference. Identity is the cheap
   * way to notice that the history under the anchor was rewritten (compaction) rather
   * than merely appended to — a length check alone cannot see a same-length rewrite.
   */
  boundary: unknown;
}

/**
 * The anchor a completed model call installs, or `undefined` when the call is not a
 * usable measurement — no `stopData`, counters the provider did not report, a split
 * that cannot be made honestly, or an empty history.
 *
 * A call that measures nothing must not invalidate anything: the caller keeps the
 * previous anchor, which is still the best measurement available.
 */
export function anchorFromCall(
  call: CompletedModelCall,
  messages: readonly unknown[],
  config: AppConfig,
): ContextAnchor | undefined {
  const usage = readCallUsage(call.message?.metadata?.usage);
  if (usage === undefined) return undefined;
  const requestTokens = requestInputTokens(usage, config);
  if (requestTokens === undefined || !Number.isFinite(requestTokens) || requestTokens < 0) {
    return undefined;
  }
  const messageCount = messages.length;
  if (messageCount < 1) return undefined;
  return { requestTokens, messageCount, boundary: messages[messageCount - 1] };
}

/**
 * The anchor if it still describes this history, `undefined` otherwise.
 *
 * Valid means the conversation has only grown since the measurement: at least as many
 * messages, and the same object still sitting on the boundary. `/compact` shortens and
 * rewrites the array, `/rewind` and `/clear` build a successor runtime, and a model
 * switch retires the measurement explicitly — so every way the base can stop being
 * true ends here, in absence. A dropped anchor is never repaired, only replaced by the
 * next completed call.
 */
export function resolveAnchor(
  anchor: ContextAnchor | undefined,
  messages: readonly unknown[],
): ContextAnchor | undefined {
  if (anchor === undefined) return undefined;
  if (messages.length < anchor.messageCount) return undefined;
  if (messages[anchor.messageCount - 1] !== anchor.boundary) return undefined;
  return anchor;
}
