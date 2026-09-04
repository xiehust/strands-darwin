/**
 * Cost accounting — the pure arithmetic and rendering, shared by the live surfaces
 * (`/status`, `/usage`, the headless `cost:` record, through `src/agent/cost.ts`) and
 * the offline trajectory readers (`trajectory list`/`replay`, through
 * `src/trajectory/spend.ts`).
 *
 * It lives under `src/pricing/` and imports nothing from `src/agent/**` so that the
 * trajectory readers can price a record while staying as offline as replaying it: no
 * `Agent`, no `Model`, no config, no I/O — only token buckets and per-token rates.
 *
 * The arithmetic is deliberately simple — Σ bucket × base rate, **per model** — and
 * every rendering says so: the figure is approximate (base rates only, no
 * tiered/long-context pricing, no summarization calls) and is labelled as such wherever
 * it appears. Two honesty rules carry over from `usageBuckets`: an unreported bucket is
 * unknown, never 0, and a model whose price is not known is *unpriced*, never free — a
 * total that leaves either out is a floor, rendered `≥`, and names what it left out.
 */

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
 * What the price cache knows about one model. `priced` carries the rates and the
 * LiteLLM key they were read under (auditable); `none` means LiteLLM was consulted
 * and has no entry for this id; `unavailable` means the table has not been fetched
 * (yet, or at all — offline, timeout, bad payload).
 */
export type ModelPriceLookup =
  | { kind: 'priced'; litellmKey: string; rates: ModelRates }
  | { kind: 'none' }
  | { kind: 'unavailable' };

/** The provenance every rendered figure names, so it can never read as an invoice. */
export const COST_BASIS_LABEL = 'base rates, LiteLLM';

export type CostBucket = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

/**
 * The four mutually exclusive token buckets, each `undefined` when unknown. The live
 * `UsageBuckets` projection and a trajectory `ModelSpend`'s metric totals both fit.
 */
export interface CostBuckets {
  input: number | undefined;
  output: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
}

/** Why a bucket could not be priced exactly — three different statements. */
export interface MissingCostBucket {
  bucket: CostBucket;
  /**
   * `not reported`: no count at all; `unpriced`: counted, but LiteLLM lists no rate;
   * `partly reported`: a sum over turns of which some did not report it (the priced
   * part is in the total, as a floor).
   */
  reason: 'not reported' | 'unpriced' | 'partly reported';
}

export interface CostEstimate {
  /** USD per bucket; undefined exactly when the bucket is listed in {@link missing}. */
  input: number | undefined;
  output: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  /** USD sum of the priced buckets — a floor when {@link missing} is non-empty. */
  total: number;
  /** Buckets excluded from (or only partly in) the total, in fixed bucket order. */
  missing: readonly MissingCostBucket[];
}

const BUCKET_ORDER: readonly CostBucket[] = ['input', 'output', 'cacheRead', 'cacheWrite'];

/**
 * Σ bucket × rate over the four mutually exclusive buckets of **one** model.
 *
 * A bucket nobody reported is missing (`not reported`); a counted bucket whose rate
 * LiteLLM does not list is missing (`unpriced`) — unless its count is 0, in which
 * case it costs a measured $0 whatever the rate would be. `partlyReported` buckets
 * are priced (the reported part is a floor) and listed as such.
 */
export function estimateCost(
  buckets: CostBuckets,
  rates: ModelRates,
  partlyReported: readonly CostBucket[] = [],
): CostEstimate {
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
    if (partlyReported.includes(bucket)) missing.push({ bucket, reason: 'partly reported' });
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

/** The `pricing=` value of the headless record: the audited key, or why there is none. */
export function describePricingSource(lookup: ModelPriceLookup): string {
  return lookup.kind === 'priced' ? lookup.litellmKey : lookup.kind;
}

/**
 * One model's share of a session's spend, with what the price cache says about it.
 * The unit every surface prices: a session is a list of these, one per model, each
 * priced at its own rates.
 */
export interface CostShare {
  /** The darwin model id — the price-cache key, and the name a caveat uses. */
  model: string;
  lookup: ModelPriceLookup;
  buckets: CostBuckets;
  /** Buckets whose count is a sum over turns of which some did not report it. */
  partlyReported?: readonly CostBucket[];
}

/** A model whose spend is not in the total, and why. */
export interface UnpricedModel {
  model: string;
  /** `none`: LiteLLM has no entry; `unavailable`: the table was never read. */
  kind: 'none' | 'unavailable';
}

/** A bucket of a priced model that is not (fully) in the total. */
export interface MissingModelBucket extends MissingCostBucket {
  model: string;
}

/**
 * A session's cost over its models. `total` sums the priced buckets of the priced
 * models — the exact figure when {@link exact}, a floor otherwise. Everything the
 * floor leaves out is named: {@link unpriced} models (their spend is unknown money,
 * never $0) and {@link missing} buckets of priced models.
 */
export interface SessionCost {
  total: number;
  /** Distinct model ids, in first-appearance order. */
  models: readonly string[];
  /** Shares priced at their own rates. */
  pricedShares: number;
  unpriced: readonly UnpricedModel[];
  missing: readonly MissingModelBucket[];
  /**
   * USD per bucket summed over the priced shares, undefined when any share left it
   * unknown — an unpriced model leaves every bucket unknown.
   */
  buckets: { input: number | undefined; output: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined };
  /** No unpriced model, no missing bucket: the total is Σ bucket × rate, nothing left out. */
  exact: boolean;
}

/**
 * Prices each share at its own rates and folds them into one {@link SessionCost}.
 *
 * Per model, not "live rates × whole meter": a session that switched models
 * mid-way holds two price lists, and the only honest sum prices each model's tokens
 * with its own. A share without a price contributes nothing and is listed under
 * `unpriced`; a priced share's missing buckets are listed under `missing` with the
 * model that owns them. A share that is a duplicate model id is priced separately
 * and counted once in `models`.
 */
export function sessionCost(shares: readonly CostShare[]): SessionCost {
  const models: string[] = [];
  const unpriced: UnpricedModel[] = [];
  const missing: MissingModelBucket[] = [];
  const buckets: Record<CostBucket, number | undefined> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const unknownBuckets = new Set<CostBucket>();
  let total = 0;
  let pricedShares = 0;

  for (const share of shares) {
    if (!models.includes(share.model)) models.push(share.model);
    if (share.lookup.kind !== 'priced') {
      unpriced.push({ model: share.model, kind: share.lookup.kind });
      for (const bucket of BUCKET_ORDER) unknownBuckets.add(bucket);
      continue;
    }
    pricedShares += 1;
    const estimate = estimateCost(share.buckets, share.lookup.rates, share.partlyReported ?? []);
    total += estimate.total;
    for (const gap of estimate.missing) {
      missing.push({ model: share.model, ...gap });
      unknownBuckets.add(gap.bucket);
    }
    for (const bucket of BUCKET_ORDER) {
      const value = estimate[bucket];
      if (value !== undefined) buckets[bucket] = (buckets[bucket] ?? 0) + value;
    }
  }
  for (const bucket of unknownBuckets) buckets[bucket] = undefined;

  return {
    total,
    models,
    pricedShares,
    unpriced,
    missing,
    buckets: { ...buckets },
    exact: unpriced.length === 0 && missing.length === 0,
  };
}

/** Models named in a caveat before the rest are only counted — the `spend.ts` bound. */
const LISTED_MODELS = 3;

/**
 * Cap on one rendered model id in a caveat, in code points: a model id is
 * configuration, so it is as unbounded as any other user-supplied string.
 */
export const MAX_COST_MODEL_CHARS = 60;

/** A bounded, comma-separated list of model ids: at most three named, the rest counted. */
export function formatModelList(models: readonly string[]): string {
  const named = models.slice(0, LISTED_MODELS).map((model) => boundedWord(model, MAX_COST_MODEL_CHARS));
  const rest = models.length - named.length;
  return `${named.join(', ')}${rest > 0 ? ` +${rest} more` : ''}`;
}

function boundedWord(value: string, limit: number): string {
  const points = [...value.replace(/\s+/gu, ' ').trim()];
  return points.length <= limit ? points.join('') : `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * The one-line cost statement every human-facing surface prints — bounded, labelled
 * approximate, and honest about what it does not know:
 *
 * - `≈ $0.0123 (base rates, LiteLLM)` when every bucket of every model is priced;
 * - `≈ $0.0123 (2 models; base rates, LiteLLM)` when more than one model contributed;
 * - `≥ $0.0123 (cacheWrite not reported; base rates, LiteLLM)` when a bucket is not
 *   (with more than one model, `<id>: cacheWrite not reported`);
 * - `≥ $0.0123 (2 models; no price for <id>; base rates, LiteLLM)` when a model in
 *   the mix has no price — its spend is left out and said so;
 * - `unknown (no price for <id>)` / `unknown (price unavailable)` when nothing could
 *   be priced at all.
 *
 * `caveats` are extra reasons the total is a floor that the shares cannot carry
 * (the trajectory's `N turn(s) unknown`); any caveat makes the figure `≥`.
 */
export function describeSessionCost(cost: SessionCost, caveats: readonly string[] = []): string {
  const none = cost.unpriced.filter((entry) => entry.kind === 'none').map((entry) => entry.model);
  const unavailable = cost.unpriced.filter((entry) => entry.kind === 'unavailable').map((entry) => entry.model);
  const unpricedClauses = [
    ...(none.length === 0 ? [] : [`no price for ${formatModelList(none)}`]),
    ...(unavailable.length === 0
      ? []
      : [cost.models.length === 1 ? 'price unavailable' : `price unavailable for ${formatModelList(unavailable)}`]),
  ];

  if (cost.pricedShares === 0) {
    return `unknown (${unpricedClauses.length === 0 ? 'no spend recorded' : unpricedClauses.join('; ')})`;
  }

  const missingClauses =
    cost.models.length === 1
      ? cost.missing.length === 0
        ? []
        : [cost.missing.map(({ bucket, reason }) => `${bucket} ${reason}`).join(', ')]
      : cost.models
          .filter((model) => cost.missing.some((gap) => gap.model === model))
          .map(
            (model) =>
              `${boundedWord(model, MAX_COST_MODEL_CHARS)}: ` +
              cost.missing
                .filter((gap) => gap.model === model)
                .map(({ bucket, reason }) => `${bucket} ${reason}`)
                .join(', '),
          );

  const segments = [
    ...(cost.models.length > 1 ? [`${cost.models.length} models`] : []),
    ...unpricedClauses,
    ...missingClauses,
    ...caveats,
    COST_BASIS_LABEL,
  ];
  const floor = !cost.exact || caveats.length > 0;
  return `${floor ? '≥' : '≈'} ${formatUsd(cost.total)} (${segments.join('; ')})`;
}

/**
 * The machine-facing view of the same figure: each field is the four-decimal USD
 * sum or `-` for unknown — never `0` — and `total` is `-` whenever anything is
 * left out or only partly in, because a floor written into a `total=` field would
 * be read as the total.
 */
export function sessionCostFields(cost: SessionCost): Record<CostBucket | 'total', string> {
  const field = (value: number | undefined): string => (value === undefined ? '-' : formatUsdNumber(value));
  if (cost.pricedShares === 0) return { input: '-', output: '-', cacheRead: '-', cacheWrite: '-', total: '-' };
  return {
    input: field(cost.buckets.input),
    output: field(cost.buckets.output),
    cacheRead: field(cost.buckets.cacheRead),
    cacheWrite: field(cost.buckets.cacheWrite),
    total: cost.exact ? formatUsdNumber(cost.total) : '-',
  };
}
