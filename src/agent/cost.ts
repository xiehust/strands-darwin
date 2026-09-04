/**
 * Cost accounting — a pure projection of the token buckets darwin already
 * reports onto per-token rates.
 *
 * One module, no `Agent`/`Model`/I/O import, shared by `/status`, `/usage` and the
 * headless `cost:` record so the three surfaces cannot disagree about what a
 * session cost. The arithmetic is deliberately simple — Σ bucket × base rate —
 * and every rendering says so: the figure is approximate (base rates only, no
 * tiered/long-context pricing, no summarization calls, live model's rates over a
 * cumulative meter) and is labelled as such wherever it appears.
 *
 * The honesty rule carried over from `usageBuckets` is that an unreported bucket
 * is unknown, never 0: a total with a missing bucket is a *floor*, rendered `≥`,
 * never an exact-looking number.
 */
import type { AppConfig } from '../config.js';
import { usageBuckets, type UsageBuckets, type UsageTotals } from './usage.js';

/** Per-token USD rates for one model, as LiteLLM publishes them (base tier only). */
export interface ModelRates {
  inputCostPerToken: number;
  outputCostPerToken: number;
  /** Undefined when LiteLLM lists no cache-read rate for the model. */
  cacheReadInputTokenCost?: number;
  /** Undefined when LiteLLM lists no cache-write (creation) rate for the model. */
  cacheCreationInputTokenCost?: number;
}

/**
 * What the price cache knows about the live model. `priced` carries the rates and
 * the LiteLLM key they were read under (auditable); `none` means LiteLLM was
 * consulted and has no entry for this id; `unavailable` means the table has not
 * been fetched (yet, or at all — offline, timeout, bad payload).
 */
export type ModelPriceLookup =
  | { kind: 'priced'; litellmKey: string; rates: ModelRates }
  | { kind: 'none' }
  | { kind: 'unavailable' };

/** The provenance every rendered figure names, so it can never read as an invoice. */
export const COST_BASIS_LABEL = 'base rates, LiteLLM';

export type CostBucket = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/** Why a bucket could not be priced — the two are different statements. */
export interface MissingCostBucket {
  bucket: CostBucket;
  /** `not reported`: the provider gave no count; `unpriced`: counted, but LiteLLM has no rate. */
  reason: 'not reported' | 'unpriced';
}

export interface CostEstimate {
  /** USD per bucket; undefined exactly when the bucket is listed in {@link missing}. */
  input: number | undefined;
  output: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  /** USD sum of the priced buckets — a floor when {@link missing} is non-empty. */
  total: number;
  /** Buckets excluded from the total, in fixed bucket order. */
  missing: readonly MissingCostBucket[];
}

const BUCKET_ORDER: readonly CostBucket[] = ['input', 'output', 'cacheRead', 'cacheWrite'];

/**
 * Σ bucket × rate over the four mutually exclusive buckets.
 *
 * A bucket the provider never reported is missing (`not reported`); a counted
 * bucket whose rate LiteLLM does not list is missing (`unpriced`) — unless its
 * count is 0, in which case it costs a measured $0 whatever the rate would be.
 */
export function estimateCost(buckets: UsageBuckets, rates: ModelRates): CostEstimate {
  const rateOf: Record<CostBucket, number | undefined> = {
    input: rates.inputCostPerToken,
    output: rates.outputCostPerToken,
    cacheRead: rates.cacheReadInputTokenCost,
    cacheWrite: rates.cacheCreationInputTokenCost,
  };
  const priced: Record<CostBucket, number | undefined> = {
    input: undefined,
    output: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  };
  const missing: MissingCostBucket[] = [];
  let total = 0;
  for (const bucket of BUCKET_ORDER) {
    const tokens = buckets[bucket];
    if (tokens === undefined) {
      missing.push({ bucket, reason: 'not reported' });
      continue;
    }
    const rate = rateOf[bucket];
    if (tokens === 0) {
      priced[bucket] = 0;
      continue;
    }
    if (rate === undefined || !Number.isFinite(rate)) {
      missing.push({ bucket, reason: 'unpriced' });
      continue;
    }
    const cost = tokens * rate;
    priced[bucket] = cost;
    total += cost;
  }
  return { ...priced, total, missing };
}

/** `$0.0123` — USD with four decimals, the resolution the base rates justify. */
export function formatUsd(value: number): string {
  return `$${formatUsdNumber(value)}`;
}

/** `0.0123` — the bare four-decimal figure the headless `cost:` record uses. */
export function formatUsdNumber(value: number): string {
  return value.toFixed(4);
}

/**
 * The one-line cost statement `/status` and `/usage` print — bounded, labelled
 * approximate, and honest about what it does not know:
 *
 * - `≈ $0.0123 (base rates, LiteLLM)` when every bucket is priced;
 * - `≥ $0.0123 (cacheWrite not reported; base rates, LiteLLM)` when one is not;
 * - `unknown (no price for <model id>)` when LiteLLM has no entry;
 * - `unknown (price unavailable)` when the table could not be read.
 */
export function describeCost(lookup: ModelPriceLookup, usage: UsageTotals, config: AppConfig): string {
  if (lookup.kind === 'unavailable') return 'unknown (price unavailable)';
  if (lookup.kind === 'none') return `unknown (no price for ${config.model})`;
  const estimate = estimateCost(usageBuckets(usage, config), lookup.rates);
  if (estimate.missing.length === 0) return `≈ ${formatUsd(estimate.total)} (${COST_BASIS_LABEL})`;
  const caveats = estimate.missing.map(({ bucket, reason }) => `${bucket} ${reason}`).join(', ');
  return `≥ ${formatUsd(estimate.total)} (${caveats}; ${COST_BASIS_LABEL})`;
}

/**
 * The machine-facing view of the same estimate: each field is the four-decimal
 * USD figure or `-` for unknown — never `0` — and `total` is `-` whenever any
 * bucket is missing, because a floor written into a `total=` field would be
 * read as the total.
 */
export function costFields(
  lookup: ModelPriceLookup,
  usage: UsageTotals,
  config: AppConfig,
): Record<CostBucket | 'total', string> {
  const unknown = { input: '-', output: '-', cacheRead: '-', cacheWrite: '-', total: '-' };
  if (lookup.kind !== 'priced') return unknown;
  const estimate = estimateCost(usageBuckets(usage, config), lookup.rates);
  const field = (value: number | undefined): string => (value === undefined ? '-' : formatUsdNumber(value));
  return {
    input: field(estimate.input),
    output: field(estimate.output),
    cacheRead: field(estimate.cacheRead),
    cacheWrite: field(estimate.cacheWrite),
    total: estimate.missing.length === 0 ? formatUsdNumber(estimate.total) : '-',
  };
}

/** The `pricing=` value of the headless record: the audited key, or why there is none. */
export function describePricingSource(lookup: ModelPriceLookup): string {
  return lookup.kind === 'priced' ? lookup.litellmKey : lookup.kind;
}
