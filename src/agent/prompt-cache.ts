/**
 * Prompt caching: where the cache points go, and when there are none.
 *
 * Everything darwin sends is re-sent: the tool schemas never change within a
 * session, the system prompt (base + AGENTS.md + `<available-skills>`) is fixed
 * once assembled, and the conversation only grows at the end. Cache points mark
 * that unchanged prefix so the provider bills it as a cache read instead of fresh
 * input — see
 * https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#caching
 *
 * The placement itself belongs to the SDK; this module only decides *whether* and
 * hands the SDK its configuration:
 *
 * - tools + conversation: `BedrockModel({ cacheConfig })` appends a cache point
 *   after `toolConfig.tools` and to the last user message on every request.
 * - system prompt: a `CachePointBlock` appended to `Agent.systemPrompt`, which is
 *   why {@link applySystemPromptCachePoint} runs after `agent.initialize()` —
 *   `SkillsPlugin.initAgent` appends its fragment first, and refuses a block array.
 *
 * Caching is Claude-only. Deciding that here rather than leaving it to the SDK's
 * `strategy: 'auto'` is deliberate: auto-detection on a model that cannot cache
 * logs a `console.warn` per model construction, which would tear the Ink frame.
 */
import { CachePointBlock, TextBlock } from '@strands-agents/sdk';
import type { SystemPrompt } from '@strands-agents/sdk';
import type { BedrockCacheConfig } from '@strands-agents/sdk/models/bedrock';

import type { AppConfig, Provider } from '../config.js';

/**
 * Cache lifetime. Bedrock accepts `5m` (its default) and `1h`; the Anthropic API
 * has no equivalent field and ignores it.
 */
export const PROMPT_CACHE_TTLS = ['5m', '1h'] as const;
export type PromptCacheTtl = (typeof PROMPT_CACHE_TTLS)[number];

/** The three cacheable parts of a request, in the order they are sent. */
export type PromptCachePart = 'tools' | 'system prompt' | 'conversation';

export interface PromptCachePlan {
  /** True when at least one cache point will be placed. */
  enabled: boolean;
  /** Which parts carry a cache point. Empty when disabled. */
  parts: readonly PromptCachePart[];
  /** TTL to stamp on every cache point, or undefined for the provider default. */
  ttl: PromptCacheTtl | undefined;
  /**
   * Why caching is off although the config asked for it. Undefined both when
   * caching is on and when it was switched off deliberately — neither needs
   * reporting, same rule as the other startup loaders.
   */
  problem: string | undefined;
}

/**
 * Models whose ids mean "Claude" to Bedrock's prompt-cache support, matching the
 * SDK's own `MODELS_SUPPORTING_ANTHROPIC_CACHING` so this decision cannot drift
 * from the one the SDK would have made.
 */
const CLAUDE_MODEL_MARKERS = ['anthropic', 'claude'];

const DISABLED: PromptCachePlan = { enabled: false, parts: [], ttl: undefined, problem: undefined };

/**
 * Decides what this run can cache.
 *
 * Pure and cheap, so both the model factory and the runtime call it rather than
 * threading a plan through the config type.
 */
export function planPromptCache(config: AppConfig): PromptCachePlan {
  if (!config.promptCache) return DISABLED;

  const ttl = config.promptCacheTtl;

  switch (config.provider) {
    case 'bedrock':
      if (!isClaudeModel(config.model)) {
        return { ...DISABLED, problem: unsupportedModel(config.model) };
      }
      return { enabled: true, parts: ['tools', 'system prompt', 'conversation'], ttl, problem: undefined };
    case 'anthropic':
      // `AnthropicModelConfig` has no `cacheConfig`, so the SDK places no cache
      // points of its own for this provider; only the one we place by hand works.
      return { enabled: true, parts: ['system prompt'], ttl, problem: undefined };
    case 'openai':
      return { ...DISABLED, problem: unsupportedProvider('openai') };
  }
}

/**
 * The `cacheConfig` for a Bedrock model, or undefined when nothing is cached.
 *
 * `strategy: 'auto'` is safe to pass here because {@link planPromptCache} has
 * already established the model supports caching; auto then resolves to
 * `anthropic` without warning.
 */
export function bedrockCacheConfig(plan: PromptCachePlan): BedrockCacheConfig | undefined {
  if (!plan.parts.includes('tools') && !plan.parts.includes('conversation')) return undefined;

  return {
    strategy: 'auto',
    // One TTL everywhere: Bedrock requires TTLs to be non-increasing across
    // tools → system → messages, and equal values satisfy that trivially.
    ...(plan.ttl !== undefined && { toolsTTL: plan.ttl, messagesTTL: plan.ttl }),
  };
}

/** The one agent property this module touches, so a spike can stand in for an Agent. */
export interface SystemPromptHolder {
  systemPrompt?: SystemPrompt | undefined;
}

/**
 * Turns a fully assembled string prompt into `[text, cachePoint]`.
 *
 * Must run after `agent.initialize()`: the skills catalogue is appended during
 * initialization, and a cache point placed before it would sit in the middle of
 * the prompt — caching a prefix that ends mid-sentence and, worse, being silently
 * dropped by `SkillsPlugin.initAgent`, which throws on a block-array prompt.
 *
 * A non-string prompt therefore means the order was broken (or someone already
 * placed cache points); leave it alone rather than guessing where the boundary
 * belongs. Returns whether the cache point was placed.
 */
export function applySystemPromptCachePoint(agent: SystemPromptHolder, plan: PromptCachePlan): boolean {
  if (!plan.parts.includes('system prompt')) return false;

  const prompt = agent.systemPrompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') return false;

  agent.systemPrompt = [
    new TextBlock(prompt),
    new CachePointBlock({ cacheType: 'default', ...(plan.ttl !== undefined && { ttl: plan.ttl }) }),
  ];
  return true;
}

/** True when a Bedrock model id names a Claude model. */
function isClaudeModel(modelId: string): boolean {
  const lowered = modelId.toLowerCase();
  return CLAUDE_MODEL_MARKERS.some((marker) => lowered.includes(marker));
}

function unsupportedModel(modelId: string): string {
  return `${modelId} does not support prompt caching — only Claude models do`;
}

function unsupportedProvider(provider: Provider): string {
  return `provider "${provider}" does not support prompt caching`;
}
