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
