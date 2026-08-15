import type { AppConfig } from '../config.js';

/** Cumulative token counts reported by the active model during this process. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Undefined until the provider reports this metric. */
  cacheReadInputTokens?: number;
  /** Undefined until the provider reports this metric. */
  cacheWriteInputTokens?: number;
}

export interface UsageRow {
  label: string;
  /** Undefined means the provider/API did not report this metric. */
  value: number | undefined;
}

/**
 * Projects provider-neutral SDK counters into the terminology and availability
 * contract of the active provider/API.
 */
export function usageRows(usage: UsageTotals, config: AppConfig): readonly UsageRow[] {
  const common = {
    input: { label: 'input', value: usage.inputTokens },
    output: { label: 'output', value: usage.outputTokens },
  } as const;

  if (config.provider === 'openai' && config.openaiApi === 'responses') {
    // Responses reports cache activity as subsets of input_tokens. Show mutually
    // exclusive counters so the rows can be added without double-counting input.
    const uncachedInput = Math.max(
      0,
      usage.inputTokens - (usage.cacheReadInputTokens ?? 0) - (usage.cacheWriteInputTokens ?? 0),
    );
    return [
      { label: 'input', value: uncachedInput },
      { label: 'cached read', value: usage.cacheReadInputTokens },
      { label: 'cache write', value: usage.cacheWriteInputTokens },
      common.output,
    ];
  }

  if (config.provider === 'bedrock' || config.provider === 'anthropic') {
    return [
      common.input,
      { label: 'cache read', value: usage.cacheReadInputTokens ?? 0 },
      { label: 'cache write', value: usage.cacheWriteInputTokens ?? 0 },
      common.output,
    ];
  }

  return [
    common.input,
    { label: 'cache read', value: undefined },
    { label: 'cache write', value: undefined },
    common.output,
  ];
}

/** Renders one projected value without turning an absent metric into zero. */
export function formatUsageValue(value: number | undefined): string {
  return value === undefined ? 'not reported' : value.toLocaleString('en-US');
}

/**
 * Subtracts `before` from `after` to produce the delta for one turn.
 *
 * Undefined metrics propagate: if the provider did not report a metric
 * before the turn it will not be present in the delta either, so the
 * last-turn section never invents a zero for an unreported counter.
 * The accumulator never goes backwards, so negative deltas are clamped to 0.
 */
export function deltaUsage(before: UsageTotals, after: UsageTotals): UsageTotals {
  const delta: UsageTotals = {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
  };
  if (after.cacheReadInputTokens !== undefined) {
    delta.cacheReadInputTokens = Math.max(0, after.cacheReadInputTokens - (before.cacheReadInputTokens ?? 0));
  }
  if (after.cacheWriteInputTokens !== undefined) {
    delta.cacheWriteInputTokens = Math.max(0, after.cacheWriteInputTokens - (before.cacheWriteInputTokens ?? 0));
  }
  return delta;
}

/** A derived effectiveness metric; undefined means the provider never reported it. */
export interface CacheEffectivenessRow {
  label: string;
  /** Pre-rendered, since a ratio is a percentage rather than a token count. */
  value: string | undefined;
}

/**
 * How well the prompt cache is working, derived from the same counters
 * {@link usageRows} projects.
 *
 * Provider-aware for the same reason: Bedrock/Anthropic report cache reads and
 * writes *beside* `inputTokens`, so the request total is their sum, while OpenAI
 * Responses reports them as *subsets* of `input_tokens`, which is already the
 * total. An unreported metric keeps every derived row at "not reported" —
 * arithmetic over an invented zero would claim the cache is broken rather than
 * unmeasured.
 */
export function cacheEffectivenessRows(usage: UsageTotals, config: AppConfig): readonly CacheEffectivenessRow[] {
  const read = usage.cacheReadInputTokens;
  if (read === undefined) {
    return [
      { label: 'cache hit ratio', value: undefined },
      { label: 'served from cache', value: undefined },
    ];
  }

  const submitted =
    config.provider === 'openai' && config.openaiApi === 'responses'
      ? usage.inputTokens
      : usage.inputTokens + read + (usage.cacheWriteInputTokens ?? 0);

  return [
    // A zero denominator means no request has completed yet; that is a measured
    // nothing, not an unreported metric.
    { label: 'cache hit ratio', value: submitted <= 0 ? '0%' : formatRatioPercent(read / submitted) },
    { label: 'served from cache', value: formatUsageValue(read) },
  ];
}

/** Integer percent with a `<1%` floor, so a barely-warm cache never reads as cold. */
function formatRatioPercent(ratio: number): string {
  const percent = ratio * 100;
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}
