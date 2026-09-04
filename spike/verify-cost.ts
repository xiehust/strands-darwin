/**
 * Cost accounting — the pure projection (`src/agent/cost.ts`).
 *
 * Free suite: no model call, no network, no I/O. Proves the arithmetic and the
 * honesty rules every surface shares: Σ bucket × rate when all four buckets are
 * known; an unreported bucket makes the total a stated floor, never a smaller
 * exact-looking number and never 0; a model without a price says so; every
 * rendering is one bounded line labelled approximate with its basis.
 *
 * Run: pnpm tsx spike/verify-cost.ts
 */
import {
  COST_BASIS_LABEL,
  costFields,
  describeCost,
  describePricingSource,
  estimateCost,
  formatUsd,
  type ModelPriceLookup,
  type ModelRates,
} from '../src/agent/cost.js';
import { usageBuckets } from '../src/agent/usage.js';
import type { AppConfig } from '../src/config.js';
import { assert, header, report } from './shared.js';

function config(provider: 'bedrock' | 'anthropic' | 'openai', openaiApi?: 'chat' | 'responses'): AppConfig {
  return {
    provider,
    model: provider === 'openai' ? 'openai.gpt-5.6-sol' : 'global.anthropic.claude-sonnet-5',
    region: 'us-east-1',
    maxTokens: 1000,
    permissionMode: 'yolo',
    promptCache: true,
    thinkingEffort: 'high',
    summaryRatio: 0.8,
    contextWarnRatio: 0.8,
    contextOffload: true,
    preserveRecentMessages: 4,
    ...(openaiApi !== undefined && { openaiApi }),
    modelChoices: [],
  };
}

/** LiteLLM's `global.anthropic.claude-sonnet-5` base rates, verbatim (2026-09-04). */
const SONNET: ModelRates = {
  inputCostPerToken: 2e-6,
  outputCostPerToken: 1e-5,
  cacheReadInputTokenCost: 2e-7,
  cacheCreationInputTokenCost: 2.5e-6,
};
const PRICED: ModelPriceLookup = { kind: 'priced', litellmKey: 'global.anthropic.claude-sonnet-5', rates: SONNET };

function arithmetic(): void {
  header('estimateCost — Σ bucket × rate over the four exclusive buckets');

  const full = estimateCost({ input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 10_000 }, SONNET);
  const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-12;
  assert('each bucket is tokens × its own rate',
    near(full.input, 2) && near(full.output, 1) && near(full.cacheRead, 0.1) && near(full.cacheWrite, 0.025));
  assert('the total is the exact sum when every bucket is known', Math.abs(full.total - 3.125) < 1e-12 && full.missing.length === 0);

  const zero = estimateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, SONNET);
  assert('a measured zero costs a measured $0 — known, not missing', zero.total === 0 && zero.missing.length === 0);

  // Unreported buckets: excluded from the total and named, in fixed bucket order.
  const partial = estimateCost({ input: 1_000_000, output: 100_000, cacheRead: undefined, cacheWrite: undefined }, SONNET);
  assert('an unreported bucket is excluded and named, never priced as 0',
    partial.total === 3 && partial.cacheRead === undefined && partial.cacheWrite === undefined &&
    partial.missing.map((m) => `${m.bucket}:${m.reason}`).join(',') === 'cacheRead:not reported,cacheWrite:not reported');
  const unsplit = estimateCost({ input: undefined, output: 100_000, cacheRead: 5, cacheWrite: 5 }, SONNET);
  assert('an unsplittable input bucket is missing while the others still price',
    unsplit.input === undefined && unsplit.missing[0]?.bucket === 'input' && unsplit.output === 1);

  // A rate LiteLLM does not list: a counted bucket is unpriced; a zero one is $0.
  const noCacheRates: ModelRates = { inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 };
  const unpriced = estimateCost({ input: 10, output: 10, cacheRead: 1000, cacheWrite: 0 }, noCacheRates);
  assert('a counted bucket with no listed rate is unpriced, a zero one is a known $0',
    unpriced.cacheRead === undefined && unpriced.cacheWrite === 0 &&
    unpriced.missing.length === 1 && unpriced.missing[0]?.bucket === 'cacheRead' && unpriced.missing[0]?.reason === 'unpriced');
  assert('the buckets come from the shared usageBuckets projection',
    estimateCost(usageBuckets({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 }, config('bedrock')), SONNET).total === full.total);
}

function rendering(): void {
  header('describeCost — one bounded line, labelled approximate, honest about the unknown');

  assert('USD renders with four decimals and a dollar sign', formatUsd(3.125) === '$3.1250' && formatUsd(0) === '$0.0000' && formatUsd(0.00004) === '$0.0000');

  const bedrock = config('bedrock');
  const exact = describeCost(PRICED, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 }, bedrock);
  assert('a fully priced figure reads ≈ with its basis', exact === `≈ $3.1250 (${COST_BASIS_LABEL})`);
  assert('the basis names base rates and LiteLLM', COST_BASIS_LABEL === 'base rates, LiteLLM');

  const floor = describeCost(PRICED, { inputTokens: 1_000_000, outputTokens: 100_000 }, bedrock);
  assert('an unreported bucket turns the figure into a stated floor with the missing buckets named',
    floor === `≥ $3.0000 (cacheRead not reported, cacheWrite not reported; ${COST_BASIS_LABEL})`);
  const responses = describeCost(PRICED, { inputTokens: 1_000, outputTokens: 10, cacheReadInputTokens: 100 }, config('openai', 'responses'));
  assert('an unsplittable Responses input is a floor over the buckets that are known',
    responses.startsWith('≥ $') && responses.includes('input not reported') && responses.includes('cacheWrite not reported'));

  assert('an unfetched price is unknown, never a number',
    describeCost({ kind: 'unavailable' }, { inputTokens: 10, outputTokens: 10 }, bedrock) === 'unknown (price unavailable)');
  assert('a model LiteLLM does not list is named as unpriced',
    describeCost({ kind: 'none' }, { inputTokens: 10, outputTokens: 10 }, bedrock) === 'unknown (no price for global.anthropic.claude-sonnet-5)');

  for (const line of [exact, floor, responses]) {
    assert(`rendering is one bounded line: ${line}`, !line.includes('\n') && line.length < 160);
  }
}

function machineFields(): void {
  header('costFields — the headless projection: four-decimal figures or `-`, never 0');

  const bedrock = config('bedrock');
  const full = costFields(PRICED, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 }, bedrock);
  assert('every bucket and the total render as bare four-decimal USD',
    full.total === '3.1250' && full.input === '2.0000' && full.output === '1.0000' && full.cacheRead === '0.1000' && full.cacheWrite === '0.0250');
  const partial = costFields(PRICED, { inputTokens: 1_000_000, outputTokens: 100_000 }, config('openai', 'chat'));
  assert('an unreported bucket is `-` and so is the total (a floor in total= would read as the total)',
    partial.total === '-' && partial.cacheRead === '-' && partial.cacheWrite === '-' && partial.input === '2.0000');
  const unavailable = costFields({ kind: 'unavailable' }, { inputTokens: 5, outputTokens: 5 }, bedrock);
  assert('no price means every field is `-`', Object.values(unavailable).every((value) => value === '-'));
  assert('the pricing source is the audited key or the reason there is none',
    describePricingSource(PRICED) === 'global.anthropic.claude-sonnet-5' &&
    describePricingSource({ kind: 'none' }) === 'none' &&
    describePricingSource({ kind: 'unavailable' }) === 'unavailable');
}

arithmetic();
rendering();
machineFields();
report();
