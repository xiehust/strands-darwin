import type { AppConfig } from '../config.js';
import type { CallSpendProjector, TurnSpend, TurnSpendMeter } from '../trajectory/record.js';

/** Cumulative token counts reported by the active model during this process. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Undefined until the provider reports this metric. */
  cacheReadInputTokens?: number;
  /** Undefined until the provider reports this metric. */
  cacheWriteInputTokens?: number;
}

/** Mutually exclusive token buckets suitable for provider-specific cost accounting. */
export interface UsageBuckets {
  /** Undefined when a provider-native total cannot be split without guessing. */
  input: number | undefined;
  output: number;
  /** Undefined until the provider reports this metric. */
  cacheRead: number | undefined;
  /** Undefined until the provider reports this metric. */
  cacheWrite: number | undefined;
}

/**
 * Normalizes provider-native counters into independently billable buckets.
 *
 * OpenAI Responses includes cache activity inside `inputTokens`; Bedrock and
 * Anthropic report those counters beside it. When either Responses cache
 * subset is unreported, uncached input stays unknown instead of being guessed.
 */
export function usageBuckets(usage: UsageTotals, config: AppConfig): UsageBuckets {
  const cacheRead = usage.cacheReadInputTokens;
  const cacheWrite = usage.cacheWriteInputTokens;
  const input =
    config.provider === 'openai' && config.openaiApi === 'responses'
      ? cacheRead === undefined || cacheWrite === undefined
        ? undefined
        : Math.max(0, usage.inputTokens - cacheRead - cacheWrite)
      : usage.inputTokens;

  return { input, output: usage.outputTokens, cacheRead, cacheWrite };
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
  const buckets = usageBuckets(usage, config);
  const common = {
    input: { label: 'input', value: buckets.input },
    output: { label: 'output', value: buckets.output },
  } as const;

  if (config.provider === 'openai' && config.openaiApi === 'responses') {
    return [
      common.input,
      { label: 'cached read', value: buckets.cacheRead },
      { label: 'cache write', value: buckets.cacheWrite },
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
 * Adds several meters' totals into one — the parent's meter plus each child
 * dispatch's, for the session-total projection.
 *
 * The numeric fields are plain sums. The optional cache counters follow the
 * "unknown metric is never 0" rule in aggregate form: a cache key is present in
 * the result only if at least one operand reports it, and within that sum an
 * absent operand counts as 0 — a meter that never reported cache activity adds
 * nothing, but cannot erase what another meter measured. When *no* operand
 * reports a cache counter the result omits it too, so an all-unknown metric
 * still renders as `not reported`, never as an invented zero.
 */
export function sumUsage(totals: readonly UsageTotals[]): UsageTotals {
  const sum: UsageTotals = {
    inputTokens: totals.reduce((acc, usage) => acc + usage.inputTokens, 0),
    outputTokens: totals.reduce((acc, usage) => acc + usage.outputTokens, 0),
  };
  if (totals.some((usage) => usage.cacheReadInputTokens !== undefined)) {
    sum.cacheReadInputTokens = totals.reduce((acc, usage) => acc + (usage.cacheReadInputTokens ?? 0), 0);
  }
  if (totals.some((usage) => usage.cacheWriteInputTokens !== undefined)) {
    sum.cacheWriteInputTokens = totals.reduce((acc, usage) => acc + (usage.cacheWriteInputTokens ?? 0), 0);
  }
  return sum;
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

/**
 * A meter for one turn: the spend from `before` up to whenever it is read.
 *
 * Lives here, beside {@link deltaUsage} and {@link usageBuckets}, because those two
 * define what the numbers mean; the trajectory only stores them. `AgentRuntime.send`
 * creates one per turn and hands it to the recorder, which reads it while the turn's
 * closing record is composed — the only moment at which the turn's spend is both final
 * and still in front of the write.
 *
 * Two properties are the reason this is a function and not four lines inlined at the
 * call site. It **cannot throw**: an observer that reads a number must never become a
 * second reason a turn dies, so any failure degrades to `undefined`, which the record
 * stores as nothing and every report reads as unknown. And it is the *same* projection
 * the headless `usage:` line prints ({@link usageBuckets}), so a recorded turn and a
 * process total are comparable field for field — including the part where an unreported
 * metric is absent on both sides rather than zero on either.
 *
 * The provider/model labels are stamped from the config in effect for this turn, so a
 * `/model` switch mid-session cannot leave one total silently mixing two price lists.
 */
export function startTurnSpend(
  before: UsageTotals,
  readUsage: () => UsageTotals,
  config: AppConfig,
): TurnSpendMeter {
  return {
    read: (): TurnSpend | undefined => {
      try {
        const buckets = usageBuckets(deltaUsage(before, readUsage()), config);
        return {
          provider: config.provider,
          model: config.model,
          ...(buckets.input !== undefined && { input: buckets.input }),
          output: buckets.output,
          ...(buckets.cacheRead !== undefined && { cacheRead: buckets.cacheRead }),
          ...(buckets.cacheWrite !== undefined && { cacheWrite: buckets.cacheWrite }),
        };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * The per-call sibling of {@link startTurnSpend}: projects one completed model
 * call's own counters — `afterModelCallEvent.stopData.message.metadata.usage`, not a
 * meter delta — through the same {@link usageBuckets}, stamped with the same
 * per-turn provider/model attribution.
 *
 * Lives here for `startTurnSpend`'s reasons, verbatim: the buckets define what the
 * numbers mean, the trajectory only stores them, and `src/trajectory/**` must not
 * import the config this projection needs. `project()` cannot throw — a counter it
 * cannot project degrades to `undefined`, which the record stores as nothing and
 * every report reads as unknown.
 */
export function startCallSpend(config: AppConfig): CallSpendProjector {
  return {
    project: (usage): TurnSpend | undefined => {
      try {
        const buckets = usageBuckets(usage, config);
        return {
          provider: config.provider,
          model: config.model,
          ...(buckets.input !== undefined && { input: buckets.input }),
          output: buckets.output,
          ...(buckets.cacheRead !== undefined && { cacheRead: buckets.cacheRead }),
          ...(buckets.cacheWrite !== undefined && { cacheWrite: buckets.cacheWrite }),
        };
      } catch {
        return undefined;
      }
    },
  };
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
