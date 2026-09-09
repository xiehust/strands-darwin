/**
 * Refusal-class stop reasons — the provider or its classifiers declined the request.
 *
 * Claude Fable 5.1 (and the Mythos line) end such a turn *successfully* from the
 * SDK's point of view: the agent loop sees a non-`toolUse` stop and returns an
 * `AgentResult` whose text may be empty. Nothing throws, so without this module a
 * driver would show an empty answer with no reason, and a delegated child would be
 * reported as `succeeded`. The drivers and delegation tools ask here and state the
 * outcome; the loop itself is never touched (the SDK owns the stop, darwin only
 * names it).
 *
 * The stop-reason vocabulary differs per provider, so the class is a fixed set of
 * exactly three SDK words, not one provider's string (SRF-029 — a Bedrock session
 * lost three turns to `contentFiltered` while only `refusal` was recognised):
 *
 * - `refusal` — the direct Anthropic provider (`models/anthropic.js`) passes the
 *   API's `stop_reason: "refusal"` through unchanged: the model's own classifiers
 *   blocked the response.
 * - `contentFiltered` — the Bedrock provider's `STOP_REASON_MAP` (`models/bedrock.js`)
 *   for Converse's `content_filtered`: the same classifier block, reached through
 *   Bedrock, which spells it differently.
 * - `guardrailIntervened` — the same map's `guardrail_intervened`: a configured
 *   Bedrock Guardrail, not the model, stopped the turn. Kept distinguishable from the
 *   classifier block because the remedy differs (the guardrail is the account's).
 *
 * Nothing else qualifies. `maxTokens`, `stopSequence`, `endTurn` and `toolUse` are
 * the model finishing on its own terms; `cancelled`, `interrupt` and `checkpoint`
 * are darwin's or the SDK's own stops. Every user-facing string names the reason
 * actually received, so a reader can tell the three apart.
 */

/** The SDK stop reasons that mean "the provider or its classifiers declined". */
export const REFUSAL_STOP_REASONS = Object.freeze(['refusal', 'contentFiltered', 'guardrailIntervened'] as const);

export type RefusalStopReason = (typeof REFUSAL_STOP_REASONS)[number];

export function isRefusalStop(stopReason: string): stopReason is RefusalStopReason {
  return (REFUSAL_STOP_REASONS as readonly string[]).includes(stopReason);
}

/** One bounded user-facing line for the transcript or stderr. */
export function refusalNotice(stopReason: string): string {
  return `model declined this request (stop_reason: ${stopReason}) — rephrase it or start a new turn`;
}

/**
 * The TUI's variant of {@link refusalNotice}: the same line plus the remedy only the
 * TUI can offer (SRF-030). A refused turn still appended the prompt and the declined
 * reply to the SDK conversation, and `AgentRuntime.send` now catalogues its pre-prompt
 * checkpoint, so `/rewind` to that prompt is the one user-chosen way to cut the
 * exchange out before rephrasing — darwin never removes it on its own. Headless
 * drivers have no `/rewind` and keep printing the base line.
 */
export function refusalNoticeWithRewind(stopReason: string): string {
  return `${refusalNotice(stopReason)} — the declined reply stays in the conversation; /rewind to this prompt removes it before you rephrase`;
}

/** The error a headless run ends with when a refusal left no reply at all. */
export function refusalEmptyReplyError(stopReason: string): string {
  return `The model declined this request (stop_reason: ${stopReason}) and produced no reply.`;
}

/** The fixed note a refused child's failure carries back to the parent. */
export function childRefusalError(stopReason: string): string {
  return `child model declined the delegated task (stop_reason: ${stopReason})`;
}

/**
 * The one line replay (and therefore `/export` and the resume recap) prints in the
 * answer slot of a refusal-class turn, after whatever partial text it streamed. The
 * live session showed {@link refusalNotice} instead — its remedy is advice for the
 * moment, meaningless in a transcript read later — so the transcript states only
 * the fact and the reason, parenthesised because it is not the model's text.
 */
export function refusalTranscriptLine(stopReason: string): string {
  return `(model declined this request — stop_reason: ${stopReason})`;
}
