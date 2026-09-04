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
  describeSessionCost,
  estimateCost,
  formatUsd,
  sessionCost,
  sessionCostFields,
  type CostShare,
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

/** The per-model aggregation both the live surfaces and the trajectory readers price through. */
function perModel(): void {
  header('sessionCost — each model at its own rates; the unknown named, never zeroed');

  const sonnet: CostShare = {
    model: 'global.anthropic.claude-sonnet-5',
    lookup: PRICED,
    buckets: { input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 10_000 },
  };
  const sol: CostShare = {
    model: 'openai.gpt-5.6-sol',
    lookup: { kind: 'priced', litellmKey: 'bedrock_mantle/openai.gpt-5.6-sol', rates: { inputCostPerToken: 1e-6, outputCostPerToken: 5e-6 } },
    buckets: { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
  };

  // One share is exactly the one-lookup rendering, byte for byte.
  const one = sessionCost([sonnet]);
  assert('one priced share is exact, one model, nothing left out',
    one.exact && one.models.length === 1 && one.pricedShares === 1 && Math.abs(one.total - 3.125) < 1e-12);
  assert('…and renders as describeCost always did',
    describeSessionCost(one) === describeCost(PRICED, { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 }, config('bedrock')));
  assert('one unavailable share renders the one-lookup wording',
    describeSessionCost(sessionCost([{ ...sonnet, lookup: { kind: 'unavailable' } }])) === 'unknown (price unavailable)');
  assert('one unlisted share renders the one-lookup wording',
    describeSessionCost(sessionCost([{ ...sonnet, lookup: { kind: 'none' } }])) === 'unknown (no price for global.anthropic.claude-sonnet-5)');

  // Two priced models: each at its own rates, summed, and counted in the clause.
  const two = sessionCost([sonnet, sol]);
  assert('two priced shares sum each at its own rates', two.exact && Math.abs(two.total - 4.625) < 1e-12 && two.models.length === 2);
  assert('…and the clause counts the models', describeSessionCost(two) === `≈ $4.6250 (2 models; ${COST_BASIS_LABEL})`);
  assert('the live rates over the whole meter would have said something else',
    describeCost(sol.lookup, { inputTokens: 2_000_000, outputTokens: 200_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 }, config('openai', 'chat')) !== describeSessionCost(two));
  const twoFields = sessionCostFields(two);
  assert('the machine fields sum per bucket with an exact total',
    twoFields.total === '4.6250' && twoFields.input === '3.0000' && twoFields.output === '1.5000' && twoFields.cacheRead === '0.1000' && twoFields.cacheWrite === '0.0250');

  // One model unpriced: its money is unknown — a floor naming it, never $0 or dropped.
  const unpriced = sessionCost([sonnet, { ...sol, lookup: { kind: 'none' } }]);
  assert('an unlisted model leaves the total a floor over the priced share and is named',
    !unpriced.exact && Math.abs(unpriced.total - 3.125) < 1e-12 && unpriced.unpriced[0]?.model === 'openai.gpt-5.6-sol' &&
    describeSessionCost(unpriced) === `≥ $3.1250 (2 models; no price for openai.gpt-5.6-sol; ${COST_BASIS_LABEL})`);
  assert('an unavailable model in a mix is named too (alone it needs no name)',
    describeSessionCost(sessionCost([sonnet, { ...sol, lookup: { kind: 'unavailable' } }])) === `≥ $3.1250 (2 models; price unavailable for openai.gpt-5.6-sol; ${COST_BASIS_LABEL})`);
  const unpricedFields = sessionCostFields(unpriced);
  assert('an unpriced model makes every machine field `-`: a partial sum in a field would be read as the sum',
    Object.values(unpricedFields).every((value) => value === '-'));
  assert('nothing priced at all is unknown, every reason named',
    describeSessionCost(sessionCost([{ ...sonnet, lookup: { kind: 'none' } }, { ...sol, lookup: { kind: 'unavailable' } }])) ===
      'unknown (no price for global.anthropic.claude-sonnet-5; price unavailable for openai.gpt-5.6-sol)');
  assert('no shares at all is unknown, not $0', describeSessionCost(sessionCost([])) === 'unknown (no spend recorded)');

  // Missing buckets in a mix name their model; alone they read as before.
  const gap = sessionCost([sonnet, { ...sol, buckets: { ...sol.buckets, cacheWrite: undefined } }]);
  assert('a missing bucket in a mix names its model', describeSessionCost(gap) === `≥ $4.6250 (2 models; openai.gpt-5.6-sol: cacheWrite not reported; ${COST_BASIS_LABEL})`);
  assert('…and that bucket and the total are `-` in the machine fields while the others still sum',
    sessionCostFields(gap).cacheWrite === '-' && sessionCostFields(gap).total === '-' && sessionCostFields(gap).input === '3.0000');
  const partly = sessionCost([{ ...sonnet, partlyReported: ['cacheRead'] }]);
  assert('a partly reported bucket is priced over what was reported and said to be partial',
    Math.abs(partly.total - 3.125) < 1e-12 && describeSessionCost(partly) === `≥ $3.1250 (cacheRead partly reported; ${COST_BASIS_LABEL})` && sessionCostFields(partly).total === '-');
  assert('an outside caveat makes the figure a floor without changing its sum',
    describeSessionCost(one, ['2 turn(s) unknown']) === `≥ $3.1250 (2 turn(s) unknown; ${COST_BASIS_LABEL})`);

  // Bounded: many models are counted, at most three named; long ids are capped.
  const many = sessionCost(['a', 'b', 'c', 'd', 'e'].map((model) => ({ model, lookup: { kind: 'none' as const }, buckets: sol.buckets })));
  assert('at most three unpriced models are named, the rest counted',
    describeSessionCost(sessionCost([sonnet, ...['a', 'b', 'c', 'd', 'e'].map((model) => ({ model, lookup: { kind: 'none' as const }, buckets: sol.buckets }))])) ===
      `≥ $3.1250 (6 models; no price for a, b, c +2 more; ${COST_BASIS_LABEL})` && many.models.length === 5);
  const longId = 'x'.repeat(200);
  const long = describeSessionCost(sessionCost([{ model: longId, lookup: { kind: 'none' }, buckets: sol.buckets }]));
  assert('a model id is capped in the clause', long.length < 100 && long.includes('…') && !long.includes(longId));
}

arithmetic();
rendering();
machineFields();
perModel();
report();
