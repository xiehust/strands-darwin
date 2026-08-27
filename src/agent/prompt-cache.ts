/**
 * Prompt caching: where the cache points go, and when there are none.
 *
 * Everything darwin sends is re-sent: the tool schemas never change within a
 * session, the system prompt (base + AGENTS.md + `<available_skills>` +
 * `<working-context>`) is fixed once assembled, and the conversation only grows at
 * the end. Cache points mark
 * that unchanged prefix so the provider bills it as a cache read instead of fresh
 * input — see
 * https://strandsagents.com/docs/user-guide/concepts/model-providers/amazon-bedrock/#caching
 *
 * The placement itself belongs to the SDK; this module only decides *whether* and
 * hands the SDK its configuration:
 *
 * - tools + conversation: `BedrockModel({ cacheConfig })` appends a cache point
 *   after `toolConfig.tools` and to the last user message on every request.
 * - system prompt: a final `CachePointBlock` appended after initialization and
 *   session restore. Official AgentSkills appends its catalogue before each
 *   invocation; Darwin's later hook moves that block ahead of working context and
 *   this final cache point.
 *
 * These explicit cache points are Claude-only. OpenAI performs prompt caching
 * automatically at the provider, so darwin neither configures nor reports it as
 * unsupported. Deciding Bedrock support here rather than leaving it to the SDK's
 * `strategy: 'auto'` is deliberate: auto-detection on a model that cannot cache
 * logs a `console.warn` per model construction, which would tear the Ink frame.
 */
import { CachePointBlock, TextBlock } from '@strands-agents/sdk';
import type { SystemPrompt } from '@strands-agents/sdk';
import type { BedrockCacheConfig } from '@strands-agents/sdk/models/bedrock';

import type { AppConfig } from '../config.js';

/**
 * Cache lifetime. Bedrock accepts `5m` (its default) and `1h`; the Anthropic API
 * has no equivalent field and ignores it.
 */
export const PROMPT_CACHE_TTLS = ['5m', '1h'] as const;
export type PromptCacheTtl = (typeof PROMPT_CACHE_TTLS)[number];

/** The three cacheable parts of a request, in the order they are sent. */
export type PromptCachePart = 'tools' | 'system prompt' | 'conversation';

export interface PromptCachePlan {
  /** True when at least one Darwin-managed cache point will be placed. */
  enabled: boolean;
  /** True when caching is automatic and entirely provider-managed. */
  automatic: boolean;
  /** Which parts carry a Darwin-managed cache point. Empty when disabled or automatic. */
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

const DISABLED: PromptCachePlan = {
  enabled: false,
  automatic: false,
  parts: [],
  ttl: undefined,
  problem: undefined,
};
const AUTOMATIC: PromptCachePlan = { ...DISABLED, automatic: true };

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
      return {
        enabled: true,
        automatic: false,
        parts: ['tools', 'system prompt', 'conversation'],
        ttl,
        problem: undefined,
      };
    case 'anthropic':
      // `AnthropicModelConfig` has no `cacheConfig`, so the SDK places no cache
      // points of its own for this provider; only the one we place by hand works.
      return { enabled: true, automatic: false, parts: ['system prompt'], ttl, problem: undefined };
    case 'openai':
      // OpenAI caching is automatic and provider-managed; darwin has no cache
      // points to configure, but the visible plan must distinguish that from off.
      return AUTOMATIC;
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


/** Whether cache mutation can safely recognize the current Darwin-owned prompt shape. */
export function canUpdateSystemPromptCache(agent: SystemPromptHolder): boolean {
  return normalizedPromptBlocks(agent.systemPrompt) !== undefined;
}

/**
 * Places or removes Darwin's final system-prompt cache point.
 *
 * Official AgentSkills supports block arrays and injects its catalogue on every
 * invocation. Darwin keeps prompt parts as separate text blocks and appends one
 * cache point only at the tail. Unknown block arrays are refused rather than
 * guessed at.
 */
export function applySystemPromptCachePoint(agent: SystemPromptHolder, plan: PromptCachePlan): boolean {
  const prompt = normalizedPromptBlocks(agent.systemPrompt);
  if (prompt === undefined) return false;

  const withoutCache = prompt.filter((block) => !(block instanceof CachePointBlock));
  if (!plan.parts.includes('system prompt')) {
    agent.systemPrompt = withoutCache;
    return false;
  }

  agent.systemPrompt = [
    ...withoutCache,
    new CachePointBlock({ cacheType: 'default', ...(plan.ttl !== undefined && { ttl: plan.ttl }) }),
  ];
  return true;
}

function normalizedPromptBlocks(prompt: SystemPrompt | undefined): Exclude<SystemPrompt, string> | undefined {
  if (typeof prompt === 'string') {
    return prompt.trim() === '' ? undefined : [new TextBlock(prompt)];
  }
  if (!Array.isArray(prompt) || prompt.length === 0) return undefined;
  if (prompt.some((block) => !(block instanceof TextBlock) && !(block instanceof CachePointBlock))) {
    return undefined;
  }

  const withoutCache = prompt.filter((block) => !(block instanceof CachePointBlock));
  if (prompt.length - withoutCache.length > 1) return undefined;
  const cacheCount = prompt.length - withoutCache.length;
  if (cacheCount === 1 && !(prompt.at(-1) instanceof CachePointBlock)) return undefined;

  // Darwin owns only explicit prompt shapes: initial base text, plus optional official
  // skills and learned memory, ending in working context. Arbitrary text arrays are
  // not safe to rewrite during /model switching.
  if (withoutCache.length === 1) return [...prompt];
  if (withoutCache.length === 2 && isWorkingContextBlock(withoutCache[1])) return [...prompt];
  if (
    withoutCache.length === 3 &&
    isOfficialSkillsBlock(withoutCache[1]) &&
    isWorkingContextBlock(withoutCache[2])
  ) {
    return [...prompt];
  }
  return undefined;
}

function isOfficialSkillsBlock(block: unknown): block is TextBlock {
  if (!(block instanceof TextBlock)) return false;
  const text = block.text.trim();
  return text.startsWith('<available_skills>') && text.endsWith('</available_skills>');
}


function isWorkingContextBlock(block: unknown): block is TextBlock {
  if (!(block instanceof TextBlock)) return false;
  const text = block.text.trim();
  return text.startsWith('<working-context>') && text.endsWith('</working-context>');
}

/** True when a Bedrock model id names a Claude model. */
function isClaudeModel(modelId: string): boolean {
  const lowered = modelId.toLowerCase();
  return CLAUDE_MODEL_MARKERS.some((marker) => lowered.includes(marker));
}

function unsupportedModel(modelId: string): string {
  return `${modelId} does not support prompt caching — only Claude models do`;
}
