/**
 * Cost accounting on the live surfaces — `/status`, `/usage` and the headless
 * `cost:` record — as the config-aware face of the pure arithmetic in
 * `src/pricing/cost.ts`.
 *
 * Everything that computes or renders money is re-exported from there unchanged, so
 * this module adds exactly one thing: the projection from the runtime's vocabulary
 * (`UsageTotals` + `AppConfig`, via `usageBuckets`) into the `CostShare` the pure
 * module prices. The trajectory readers make the same projection from a record
 * (`src/trajectory/spend.ts`) without ever importing this file — one arithmetic, two
 * entry points, no second implementation.
 *
 * A session is priced **per model**: the runtime tallies each model's share of the
 * meter under the config in effect for its turns ({@link ModelUsageShare}), and the
 * sum prices each share at its own rates. A single-model session renders exactly as
 * the one-lookup wrappers ({@link describeCost}, {@link costFields}) always did.
 */
import type { AppConfig } from '../config.js';
import {
  describeSessionCost,
  sessionCost,
  sessionCostFields,
  type CostBucket,
  type CostShare,
  type ModelPriceLookup,
} from '../pricing/cost.js';
import { sumUsage, usageBuckets, type UsageTotals } from './usage.js';

export {
  COST_BASIS_LABEL,
  describePricingSource,
  describeSessionCost,
  estimateCost,
  formatModelList,
  formatUsd,
  formatUsdNumber,
  MAX_COST_MODEL_CHARS,
  sessionCost,
  sessionCostFields,
  type CostBucket,
  type CostBuckets,
  type CostEstimate,
  type CostShare,
  type MissingCostBucket,
  type MissingModelBucket,
  type ModelPriceLookup,
  type ModelRates,
  type SessionCost,
  type UnpricedModel,
} from '../pricing/cost.js';

/**
 * One model's share of this process's meter: the counters it incurred, the config
 * that projects them into buckets (provider/API decide the split), and what the
 * price cache says about it. `runtime.modelShares` is a list of these.
 */
export interface ModelUsageShare {
  config: AppConfig;
  usage: UsageTotals;
  lookup: ModelPriceLookup;
}

/** The pure module's unit, from the runtime's vocabulary. */
export function costShare(share: ModelUsageShare): CostShare {
  return { model: share.config.model, lookup: share.lookup, buckets: usageBuckets(share.usage, share.config) };
}

/**
 * The one-line cost statement `/status` and `/usage` print for a list of model
 * shares — `describeSessionCost` over each share priced at its own rates. See that
 * function for the exact wording; one share renders as {@link describeCost} does.
 */
export function describeModelCosts(shares: readonly ModelUsageShare[]): string {
  return describeSessionCost(sessionCost(shares.map(costShare)));
}

/** The headless `cost:` fields for a list of model shares (`-` is unknown, never 0). */
export function modelCostFields(shares: readonly ModelUsageShare[]): Record<CostBucket | 'total', string> {
  return sessionCostFields(sessionCost(shares.map(costShare)));
}

/**
 * The one-lookup form: one model, one meter — `/status`'s child lines (children run
 * the live model's config) and every caller that has a single model to price.
 */
export function describeCost(lookup: ModelPriceLookup, usage: UsageTotals, config: AppConfig): string {
  return describeModelCosts([{ config, usage, lookup }]);
}

/** The one-lookup form of {@link modelCostFields}. */
export function costFields(
  lookup: ModelPriceLookup,
  usage: UsageTotals,
  config: AppConfig,
): Record<CostBucket | 'total', string> {
  return modelCostFields([{ config, usage, lookup }]);
}

/**
 * Folds child spend into the live model's share — children run the parent's live
 * model config, so their tokens are priced at its rates — appending a share when no
 * parent turn ran on that model yet. Pure: returns a new list. A single-model
 * session yields one share over `sumUsage([parent, children])`, the session-total
 * projection `/status` always printed.
 */
export function withChildUsage(
  shares: readonly ModelUsageShare[],
  children: UsageTotals,
  live: AppConfig,
  lookup: ModelPriceLookup,
): ModelUsageShare[] {
  const index = shares.findIndex((share) => share.config.model === live.model && share.config.provider === live.provider);
  if (index === -1) return [...shares, { config: live, usage: children, lookup }];
  return shares.map((share, at) => (at === index ? { ...share, usage: sumUsage([share.usage, children]) } : share));
}
