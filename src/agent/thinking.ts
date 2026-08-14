/**
 * Thinking effort: how hard the model reasons before it answers.
 *
 * Claude 4.6 and later replace a hand-picked `budget_tokens` with *adaptive*
 * thinking — the model decides per request whether to think and for how long —
 * steered by a coarse effort level. Anthropic's own ladder and default are used
 * verbatim (`high`), because a private scale would only invite the question of
 * what it maps to:
 *
 * | effort   | behaviour                                                    |
 * |----------|--------------------------------------------------------------|
 * | `low`    | minimizes thinking; skips it for simple tasks                |
 * | `medium` | moderate thinking; may skip it for very simple queries       |
 * | `high`   | always thinks (the default)                                  |
 * | `xhigh`  | always thinks, extended depth — Opus only                    |
 * | `max`    | always thinks, no depth constraint                           |
 *
 * See
 * https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html
 *
 * The Opus restriction on `xhigh` is measured, not read: that page says `max` is
 * Opus-only too, and it is not. What Bedrock actually answers, in us-west-2
 * (`spike/verify-thinking-live.ts` re-checks it):
 *
 * | model                    | low | medium | high | xhigh                | max |
 * |--------------------------|-----|--------|------|----------------------|-----|
 * | `claude-sonnet-4-6`      | ok  | ok     | ok   | rejected             | ok  |
 * | `claude-opus-5`          | ok  | ok     | ok   | ok                   | ok  |
 * | `claude-sonnet-4-5`      | rejected — the whole `output_config` is refused     |
 *
 * The `xhigh` rejection is a `ValidationException` reading
 * `output_config.effort: Input should be 'low', 'medium', 'high' or 'max'`.
 *
 * Like {@link ../agent/prompt-cache.ts | prompt caching}, this module only decides
 * *what to ask for* and hands the provider its fields; it never touches a request.
 * The reason it decides at all — rather than passing the user's level straight
 * through — is that an unsupported level is not degraded by the API, it is
 * rejected, and on **every** request. So a level the model cannot serve is clamped
 * to the highest one it can, and the clamp is reported rather than performed
 * silently.
 */
import type { JSONValue } from '@strands-agents/sdk';

import type { AppConfig, OpenAIApiMode } from '../config.js';

/** Effort levels, weakest first. Order is load-bearing: clamping walks it down. */
export const THINKING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

/** Anthropic's own default, and the strongest level every adaptive model accepts. */
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high';

/**
 * Levels only the Opus tier serves. Just `xhigh`, however the AWS page reads — see
 * the measured table above.
 */
const OPUS_ONLY_EFFORTS: readonly ThinkingEffort[] = ['xhigh'];

export interface ThinkingPlan {
  /** True when the request will carry thinking fields at all. */
  enabled: boolean;
  /** What the user asked for, whether or not it is what gets sent. */
  requested: ThinkingEffort;
  /**
   * The level actually sent. Equal to {@link requested} unless the model could
   * not serve it; undefined when nothing is sent at all.
   */
  effective: ThinkingEffort | undefined;
  /**
   * Why the effective level differs from the requested one, or why no thinking is
   * configured despite a level being set. Undefined when the request carries
   * exactly what was asked for — the same rule as the other startup loaders: only
   * a gap between intent and reality is worth a line.
   */
  problem: string | undefined;
}

/**
 * Model ids that support adaptive thinking. Matched as substrings of the model id
 * rather than compared to a table of exact ids: Bedrock ids carry a profile prefix
 * and often a version suffix (`us.anthropic.claude-sonnet-4-6`,
 * `anthropic.claude-opus-4-6-v1`), so an exact-match table would silently stop
 * recognizing a model the day AWS appends a suffix.
 */
const ADAPTIVE_MODEL_MARKERS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-5',
  'claude-mythos',
  'claude-fable',
];

/** The subset of {@link ADAPTIVE_MODEL_MARKERS} that also serves `xhigh` and `max`. */
const OPUS_TIER_MARKERS = ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-5', 'claude-mythos', 'claude-fable'];

/**
 * OpenAI's `reasoning_effort` stops at `high`; the two levels above it have no
 * equivalent, so they are clamped rather than passed through to a 400.
 *
 * Bedrock Mantle is the measured exception — `spike/probe-mantle.ts` against
 * `openai.gpt-5.6-sol` in us-east-1, on the Responses API:
 *
 * | field                        | low | medium | high | xhigh | max |
 * |------------------------------|-----|--------|------|-------|-----|
 * | `reasoning: { effort }`      | ok  | ok     | ok   | ok    | ok  |
 * | `reasoning_effort` (flat)    | 400 Unknown parameter — every level         |
 *
 * Two more facts from the same run, both load-bearing elsewhere: that model
 * refuses `/v1/chat/completions` outright (`api: 'responses'` is mandatory, hence
 * `openaiApi` in the config), and no `reasoningContentDelta` ever reaches the
 * stream — not even with `reasoning.summary` set to `auto` or `detailed` — so
 * effort is spent but never displayed.
 */
const OPENAI_MAX_EFFORT: ThinkingEffort = 'high';

/**
 * Decides what this run asks the model to think.
 *
 * Pure and cheap, so the model factory, the runtime and the header all call it
 * rather than threading a plan through the config type — same shape as
 * `planPromptCache`.
 */
export function planThinking(config: AppConfig, effort = config.thinkingEffort): ThinkingPlan {
  switch (config.provider) {
    case 'bedrock':
    case 'anthropic':
      return planClaude(config.model, effort);
    case 'openai':
      // Not gated on the model id: OpenAI's reasoning models are not identifiable
      // from a prefix the way Claude's are, and refusing a model we failed to
      // recognize would be worse than the request error. A non-reasoning model
      // rejects the reasoning field outright — documented on the config field.
      //
      // Mantle is exempt from the clamp because it was measured not to need it:
      // `openai.gpt-5.6-sol` accepts the whole ladder through `max` on the
      // Responses API. Clamping it anyway would quietly think less than asked.
      return config.bedrockMantle !== true && isAbove(effort, OPENAI_MAX_EFFORT)
        ? {
            enabled: true,
            requested: effort,
            effective: OPENAI_MAX_EFFORT,
            problem: `provider "openai" has no ${effort} reasoning effort — using ${OPENAI_MAX_EFFORT}`,
          }
        : { enabled: true, requested: effort, effective: effort, problem: undefined };
  }
}

/** Adaptive thinking for a Claude model id, clamped to what that model serves. */
function planClaude(modelId: string, effort: ThinkingEffort): ThinkingPlan {
  const lowered = modelId.toLowerCase();

  if (!ADAPTIVE_MODEL_MARKERS.some((marker) => lowered.includes(marker))) {
    return {
      enabled: false,
      requested: effort,
      effective: undefined,
      problem: `${modelId} does not support adaptive thinking — Claude Sonnet 4.6 / Opus 4.6 and later do`,
    };
  }

  const opusTier = OPUS_TIER_MARKERS.some((marker) => lowered.includes(marker));
  if (!opusTier && OPUS_ONLY_EFFORTS.includes(effort)) {
    // Down to `high`, not up to `max`, even though `max` would be accepted: asking
    // for more depth than the user did is a bill they did not agree to.
    return {
      enabled: true,
      requested: effort,
      effective: DEFAULT_THINKING_EFFORT,
      problem: `${modelId} does not support ${effort} effort (Opus only) — using ${DEFAULT_THINKING_EFFORT}`,
    };
  }

  return { enabled: true, requested: effort, effective: effort, problem: undefined };
}

/**
 * The Bedrock `additionalRequestFields` (and the Anthropic `params`) for a plan,
 * or undefined when the model gets no thinking configuration.
 *
 * `effort` deliberately sits in its own `output_config` object: Bedrock returns a
 * `ValidationException` when it is nested inside `thinking`.
 *
 * `type: 'adaptive'` is the only mode used, never `enabled`/`budget_tokens`. Two
 * reasons beyond it being the recommended form: the newest models reject the old
 * one outright, and switching *between* modes invalidates the conversation cache
 * breakpoint — so always-adaptive is what makes `/effort` free to change
 * mid-session.
 */
export function claudeThinkingFields(plan: ThinkingPlan): JSONValue | undefined {
  if (!plan.enabled || plan.effective === undefined) return undefined;
  return {
    thinking: { type: 'adaptive' },
    output_config: { effort: plan.effective },
  };
}

/**
 * The OpenAI `params` for a plan, or undefined when nothing is configured.
 *
 * The two APIs spell it differently and neither tolerates the other's spelling:
 * Chat Completions takes a flat `reasoning_effort`, while the Responses API takes
 * a nested `reasoning.effort` and answers `400 Unknown parameter:
 * 'reasoning_effort'` to the flat one — measured on Mantle, see the table above.
 */
export function openaiThinkingParams(
  plan: ThinkingPlan,
  api: OpenAIApiMode = 'chat',
): Record<string, unknown> | undefined {
  if (!plan.enabled || plan.effective === undefined) return undefined;
  return api === 'responses'
    ? { reasoning: { effort: plan.effective } }
    : { reasoning_effort: plan.effective };
}

/** Narrows an arbitrary value to an effort level. */
export function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return typeof value === 'string' && (THINKING_EFFORTS as readonly string[]).includes(value);
}

/** True when `effort` sits above `limit` on the ladder. */
function isAbove(effort: ThinkingEffort, limit: ThinkingEffort): boolean {
  return THINKING_EFFORTS.indexOf(effort) > THINKING_EFFORTS.indexOf(limit);
}
