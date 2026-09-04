/**
 * `stopReason: 'refusal'` — the model's safety classifiers declined the request.
 *
 * Claude Fable 5.1 (and the Mythos line) end such a turn *successfully* from the
 * SDK's point of view: the agent loop sees a non-`toolUse` stop and returns an
 * `AgentResult` whose text may be empty. Nothing throws, so without this module a
 * driver would show an empty answer with no reason, and a delegated child would be
 * reported as `succeeded`. The drivers and delegation tools ask here and state the
 * outcome; the loop itself is never touched (the SDK owns the stop, darwin only
 * names it).
 */

/** The SDK's stop reason for a model-side refusal, on every provider. */
export const REFUSAL_STOP_REASON = 'refusal';

/** One bounded user-facing line for the transcript or stderr. */
export const REFUSAL_NOTICE =
  'model declined this request (stop_reason: refusal) — rephrase it or start a new turn';

/** The error a headless run ends with when a refusal left no reply at all. */
export const REFUSAL_EMPTY_REPLY_ERROR =
  'The model declined this request (stop_reason: refusal) and produced no reply.';

/** The fixed note a refused child's failure carries back to the parent. */
export const CHILD_REFUSAL_ERROR = 'child model declined the delegated task (stop_reason: refusal)';

export function isRefusalStop(stopReason: string): boolean {
  return stopReason === REFUSAL_STOP_REASON;
}
