/** Offline contracts for provider usage mapping and `/usage` projection. */
import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type OpenAI from 'openai';

import type { AppConfig } from '../src/config.js';
import { formatUsageReport } from '../src/tui/App.js';
import { cacheEffectivenessRows, deltaUsage, sumUsage, usageBuckets, usageRows, type UsageTotals } from '../src/agent/usage.js';
import type { ModelPriceLookup, ModelUsageShare } from '../src/agent/cost.js';
import type { SessionCallStats } from '../src/agent/call-stats.js';
import { assert, header, report } from './shared.js';

function config(provider: 'bedrock' | 'anthropic' | 'openai', openaiApi?: 'chat' | 'responses'): AppConfig {
  return {
    provider,
    model: provider === 'openai' ? 'openai.gpt-5.6-sol' : 'global.anthropic.claude-opus-5',
    region: 'us-east-1',
    maxTokens: 1000,
    permissionMode: 'yolo',
    promptCache: true,
    promptCacheTtl: '5m',
    thinkingEffort: 'high',
    summaryRatio: 0.8, contextWarnRatio: 0.8,
    contextOffload: true,
    preserveRecentMessages: 4,
    ...(openaiApi !== undefined && { openaiApi }),
    modelChoices: [],
  };
}

function fakeClient(usages: readonly { cached?: number; cacheWrite?: number }[]): OpenAI {
  let call = 0;
  const client = {
    responses: {
      create: async () => {
        const current = usages[call++];
        if (current === undefined) throw new Error('fake response stream exhausted');
        const inputTokensDetails: Record<string, number> = {};
        if (current.cached !== undefined) inputTokensDetails['cached_tokens'] = current.cached;
        if (current.cacheWrite !== undefined) inputTokensDetails['cache_write_tokens'] = current.cacheWrite;
        return (async function* () {
          yield { type: 'response.created', response: { id: `response-${call}` } };
          yield {
            type: 'response.completed',
            response: {
              usage: {
                input_tokens: 100,
                output_tokens: 5,
                total_tokens: 105,
                input_tokens_details: inputTokensDetails,
                output_tokens_details: { reasoning_tokens: 0 },
              },
            },
          };
        })();
      },
    },
  };
  // The adapter only calls responses.create in this fixture; the cast keeps the
  // fake at the external-client boundary rather than weakening production types.
  return client as unknown as OpenAI;
}

async function adapterContract(): Promise<void> {
  header('usage — OpenAI Responses adapter');
  const model = new OpenAIModel({
    api: 'responses',
    modelId: 'openai.gpt-5.6-sol',
    client: fakeClient([{ cached: 37, cacheWrite: 61 }]),
  });
  const agent = new Agent({ model, printer: false });

  await agent.invoke('one');
  assert(
    'reported cached reads and writes reach accumulated usage',
    agent.metrics.accumulatedUsage.cacheReadInputTokens === 37 &&
      agent.metrics.accumulatedUsage.cacheWriteInputTokens === 61,
  );

  const zeroAgent = new Agent({
    model: new OpenAIModel({
      api: 'responses',
      modelId: 'openai.gpt-5.6-sol',
      client: fakeClient([{ cached: 0, cacheWrite: 0 }]),
    }),
    printer: false,
  });
  await zeroAgent.invoke('zero');
  const zeroUsage = zeroAgent.metrics.accumulatedUsage;
  assert(
    'explicit zero cache values remain present on accumulated usage',
    Object.hasOwn(zeroUsage, 'cacheReadInputTokens') && zeroUsage.cacheReadInputTokens === 0 &&
      Object.hasOwn(zeroUsage, 'cacheWriteInputTokens') && zeroUsage.cacheWriteInputTokens === 0,
  );
}

function projectionContracts(): void {
  header('usage — provider projection');
  const reported: UsageTotals = {
    inputTokens: 1200,
    outputTokens: 45,
    cacheReadInputTokens: 800,
    cacheWriteInputTokens: 300,
  };
  const openai = usageRows(reported, config('openai', 'responses'));
  assert(
    'OpenAI Responses separates uncached input, cache reads, and cache writes',
    openai[0]?.label === 'input' && openai[0]?.value === 100 &&
      openai[1]?.label === 'cached read' && openai[1]?.value === 800 &&
      openai[2]?.label === 'cache write' && openai[2]?.value === 300,
  );

  const openaiBuckets = usageBuckets(reported, config('openai', 'responses'));
  assert(
    'OpenAI Responses cost buckets are mutually exclusive',
    openaiBuckets.input === 100 && openaiBuckets.cacheRead === 800 && openaiBuckets.cacheWrite === 300,
  );
  const bedrockBuckets = usageBuckets(reported, config('bedrock'));
  assert(
    'Bedrock input is already uncached and is not reduced again',
    bedrockBuckets.input === 1200 && bedrockBuckets.cacheRead === 800 && bedrockBuckets.cacheWrite === 300,
  );
  const incompleteBuckets = usageBuckets(
    { inputTokens: 1200, outputTokens: 45, cacheReadInputTokens: 800 },
    config('openai', 'responses'),
  );
  assert(
    'OpenAI Responses does not guess uncached input when a cache subset is absent',
    incompleteBuckets.input === undefined && incompleteBuckets.cacheWrite === undefined,
  );

  const absentReport = formatUsageReport(
    { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 0 },
    config('openai', 'responses'),
    false,
  );
  assert('a reported OpenAI zero is numeric', /cached read\s+0/u.test(absentReport));
  assert('an absent OpenAI cache write is not a false zero', /cache write\s+not reported/u.test(absentReport));

  for (const provider of ['bedrock', 'anthropic'] as const) {
    const rows = usageRows({ inputTokens: 12, outputTokens: 3 }, config(provider));
    assert(
      `${provider} preserves numeric cache read and write rows`,
      rows[1]?.label === 'cache read' && rows[1]?.value === 0 &&
        rows[2]?.label === 'cache write' && rows[2]?.value === 0,
    );
  }

  const bedrockReport = formatUsageReport(
    { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 7, cacheWriteInputTokens: 9 },
    config('bedrock'),
    true,
    true,
  );
  assert('Bedrock report retains four numeric labels', /cache read\s+7/u.test(bedrockReport) && /cache write\s+9/u.test(bedrockReport));
  assert('existing resumed and in-flight notices remain', bedrockReport.includes('earlier runs are not counted') && bedrockReport.includes('not counted yet'));
}

function effectivenessContracts(): void {
  header('usage — cache effectiveness derivation');
  const warm: UsageTotals = {
    inputTokens: 1000,
    outputTokens: 50,
    cacheReadInputTokens: 8000,
    cacheWriteInputTokens: 1000,
  };
  const bedrock = cacheEffectivenessRows(warm, config('bedrock'));
  assert('Bedrock hit ratio sums input, reads, and writes as the request total',
    bedrock[0]?.label === 'cache hit ratio' && bedrock[0]?.value === '80%');
  assert('served-from-cache restates the read counter with locale grouping',
    bedrock[1]?.label === 'served from cache' && bedrock[1]?.value === '8,000');

  // Responses reports cache activity as subsets of input_tokens: the total is
  // already inputTokens, so summing again would understate the ratio.
  const responses = cacheEffectivenessRows(
    { inputTokens: 10_000, outputTokens: 50, cacheReadInputTokens: 8000, cacheWriteInputTokens: 1000 },
    config('openai', 'responses'),
  );
  assert('OpenAI Responses hit ratio divides by input alone', responses[0]?.value === '80%');

  const absent = cacheEffectivenessRows({ inputTokens: 12, outputTokens: 3 }, config('bedrock'));
  assert('unreported cache metrics yield no invented effectiveness',
    absent[0]?.value === undefined && absent[1]?.value === undefined);
  const absentRendered = formatUsageReport({ inputTokens: 12, outputTokens: 3 }, config('openai', 'chat'), false);
  assert('the rendered report says not reported for both derived rows',
    /cache hit ratio\s+not reported/u.test(absentRendered) && /served from cache\s+not reported/u.test(absentRendered));

  const idle = cacheEffectivenessRows(
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    config('bedrock'),
  );
  assert('a zero request total is 0%, never a division error', idle[0]?.value === '0%');

  const barelyWarm = cacheEffectivenessRows(
    { inputTokens: 10_000, outputTokens: 1, cacheReadInputTokens: 50, cacheWriteInputTokens: 0 },
    config('bedrock'),
  );
  assert('a nonzero ratio below one percent floors at <1%', barelyWarm[0]?.value === '<1%');

  const warmReport = formatUsageReport(warm, config('bedrock'), false);
  assert('the report renders the derived rows in the aligned block',
    /cache hit ratio\s+80%/u.test(warmReport) && /served from cache\s+8,000/u.test(warmReport));
}

function deltaContracts(): void {
  header('usage — per-turn delta');
  const before: UsageTotals = {
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadInputTokens: 500,
    cacheWriteInputTokens: 100,
  };
  const after: UsageTotals = {
    inputTokens: 1800,
    outputTokens: 350,
    cacheReadInputTokens: 1200,
    cacheWriteInputTokens: 100,
  };
  const delta = deltaUsage(before, after);
  assert('input delta is the difference', delta.inputTokens === 800);
  assert('output delta is the difference', delta.outputTokens === 150);
  assert('cache read delta is the difference', delta.cacheReadInputTokens === 700);
  assert('cache write delta of zero is still reported', delta.cacheWriteInputTokens === 0);

  // Accumulator can never go backwards; a same-value snapshot yields zero, never negative.
  const same = deltaUsage(after, after);
  assert('same before and after yields zero deltas, never negative',
    same.inputTokens === 0 && same.outputTokens === 0 &&
    same.cacheReadInputTokens === 0 && same.cacheWriteInputTokens === 0);

  // Undefined metrics before the turn propagate into the delta.
  const noCache: UsageTotals = { inputTokens: 10, outputTokens: 5 };
  const withCache: UsageTotals = { inputTokens: 20, outputTokens: 8, cacheReadInputTokens: 300 };
  const deltaNoCache = deltaUsage(noCache, noCache);
  assert('undefined cache metrics produce no delta keys', deltaNoCache.cacheReadInputTokens === undefined);
  const deltaMixed = deltaUsage(noCache, withCache);
  assert('metric appearing in after but not before is attributed in full',
    deltaMixed.cacheReadInputTokens === 300);

  // Last-turn section appears when lastTurn is provided, is absent otherwise.
  const report0 = formatUsageReport({ inputTokens: 0, outputTokens: 0 }, config('bedrock'), false);
  assert('no-turn-yet: last-turn section is absent', !report0.includes('last turn'));
  const reportWithTurn = formatUsageReport(
    { inputTokens: 1800, outputTokens: 350, cacheReadInputTokens: 1200, cacheWriteInputTokens: 100 },
    config('bedrock'),
    false,
    false,
    delta,
  );
  assert('last-turn section heading present when a turn has completed',
    reportWithTurn.includes('last turn (previous turn)'));
  assert('last-turn input row shows the delta, not the lifetime total',
    /input\s+800/u.test(reportWithTurn));
  assert('last-turn cache read row shows the delta',
    /cache read\s+700/u.test(reportWithTurn));
}

function sumContracts(): void {
  header('usage — cross-meter sum');
  const parent: UsageTotals = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheWriteInputTokens: 5 };
  const child: UsageTotals = { inputTokens: 200, outputTokens: 20, cacheReadInputTokens: 70, cacheWriteInputTokens: 7 };
  const full = sumUsage([parent, child]);
  assert('numeric fields are plain sums',
    full.inputTokens === 300 && full.outputTokens === 30 &&
    full.cacheReadInputTokens === 120 && full.cacheWriteInputTokens === 12);

  // The undefined-cache rule: absent everywhere stays absent, never a fake 0.
  const noCache: UsageTotals = { inputTokens: 1, outputTokens: 2 };
  const allUnknown = sumUsage([noCache, { inputTokens: 3, outputTokens: 4 }]);
  assert('a cache metric no meter reported is absent from the sum',
    allUnknown.inputTokens === 4 && allUnknown.outputTokens === 6 &&
    allUnknown.cacheReadInputTokens === undefined && allUnknown.cacheWriteInputTokens === undefined &&
    !Object.hasOwn(allUnknown, 'cacheReadInputTokens') && !Object.hasOwn(allUnknown, 'cacheWriteInputTokens'));

  // One reporting meter is enough; the silent one counts as 0 within the sum.
  const mixed = sumUsage([noCache, { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 9 }]);
  assert('one reporting operand keeps the metric, absent operands count as 0',
    mixed.cacheReadInputTokens === 9 && mixed.cacheWriteInputTokens === undefined);

  // A reported zero is a measurement, and survives the sum as one.
  const zero = sumUsage([{ inputTokens: 1, outputTokens: 1, cacheWriteInputTokens: 0 }, noCache]);
  assert('a reported zero stays a present zero', Object.hasOwn(zero, 'cacheWriteInputTokens') && zero.cacheWriteInputTokens === 0);

  const single = sumUsage([parent]);
  assert('a one-operand sum is that operand, field for field',
    single.inputTokens === 100 && single.outputTokens === 10 &&
    single.cacheReadInputTokens === 50 && single.cacheWriteInputTokens === 5);
  const empty = sumUsage([]);
  assert('an empty sum is all-zero counters with no cache keys',
    empty.inputTokens === 0 && empty.outputTokens === 0 &&
    !Object.hasOwn(empty, 'cacheReadInputTokens') && !Object.hasOwn(empty, 'cacheWriteInputTokens'));
}

function childSectionContracts(): void {
  header('usage — /usage child sections');
  const parent: UsageTotals = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheWriteInputTokens: 5 };
  const children = { dispatches: 2, usage: { inputTokens: 40, outputTokens: 4 } };

  // Absent children → byte-identical to the pre-children report, whatever else is set.
  const without = formatUsageReport(parent, config('bedrock'), false, false, undefined);
  const withUndefined = formatUsageReport(parent, config('bedrock'), false, false, undefined, undefined);
  assert('zero dispatches renders byte-identically to the pre-children report', without === withUndefined);
  assert('the zero-dispatch report has no child sections',
    !without.includes('subagents') && !without.includes('session total'));

  const withChildren = formatUsageReport(parent, config('bedrock'), false, false, undefined, children);
  assert('the subagent section counts its dispatches', withChildren.includes('subagents (2 dispatches)'));
  assert('a single dispatch is not pluralized',
    formatUsageReport(parent, config('bedrock'), false, false, undefined, { ...children, dispatches: 1 })
      .includes('subagents (1 dispatch)'));
  assert('the session total is labelled as including subagents', withChildren.includes('session total (incl. subagents)'));
  assert('the session-total input row is the parent plus the children', /input\s+140/u.test(withChildren));
  assert('the child input row shows the children alone', /input\s+40/u.test(withChildren));
  // Bedrock's projection renders an absent child cache counter as its provider
  // contract dictates (numeric beside inputTokens) while the totals stay honest:
  // the summed cache read is the parent's alone, never doubled or zeroed.
  assert('the summed cache read is the parent value untouched by cache-silent children',
    /cache read\s+50/u.test(withChildren));
}

function efficiencySectionContracts(): void {
  header('usage — /usage efficiency section');
  const parent: UsageTotals = { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheWriteInputTokens: 5 };
  const stats: SessionCallStats = {
    calls: 12,
    meteredCalls: 12,
    usage: { inputTokens: 1200, outputTokens: 240, cacheReadInputTokens: 46_800 },
    noTool: 2,
    singleTool: 8,
    multiTool: 2,
    recentToolUseCounts: [1, 1, 0, 1, 2, 1, 1, 1, 0, 1],
  };

  // Absent stats → byte-identical to the pre-efficiency report, the childUsage rule.
  const without = formatUsageReport(parent, config('bedrock'), false);
  const withUndefined = formatUsageReport(parent, config('bedrock'), false, false, undefined, undefined, undefined);
  assert('zero observed calls renders byte-identically to the pre-efficiency report', without === withUndefined);
  assert('the zero-call report has no efficiency section', !without.includes('efficiency'));

  const withStats = formatUsageReport(parent, config('bedrock'), false, false, undefined, undefined, stats);
  assert('the efficiency section is present and labelled', withStats.includes('efficiency (completed model calls)'));
  assert('the section counts model calls', /model calls\s+12/u.test(withStats));
  assert('avg request input per call comes from the shared bucket arithmetic',
    /avg request input\/call\s+4,000/u.test(withStats));
  assert('the tool shapes are split out',
    /single-tool responses\s+8/u.test(withStats) &&
    /multi-tool responses\s+2/u.test(withStats) &&
    /no-tool responses\s+2/u.test(withStats));
  const unmetered = formatUsageReport(parent, config('bedrock'), false, false, undefined, undefined, {
    ...stats,
    meteredCalls: 0,
    usage: undefined,
  });
  assert('an unmetered average reads not reported, never 0',
    /avg request input\/call\s+not reported/u.test(unmetered));
  assert('efficiency coexists with the child sections without touching them',
    formatUsageReport(parent, config('bedrock'), false, false, undefined,
      { dispatches: 1, usage: { inputTokens: 4, outputTokens: 2 } }, stats)
      .includes('session total (incl. subagents)'));
}

function costLineContracts(): void {
  header('usage — /usage cost line');
  const parent: UsageTotals = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 };
  const priced: ModelPriceLookup = {
    kind: 'priced',
    litellmKey: 'global.anthropic.claude-sonnet-5',
    rates: { inputCostPerToken: 2e-6, outputCostPerToken: 1e-5, cacheReadInputTokenCost: 2e-7, cacheCreationInputTokenCost: 2.5e-6 },
  };

  // No shares passed → byte-identical to the pre-cost report (the childUsage rule);
  // the runtime always passes them, so the TUI report always carries the line.
  const without = formatUsageReport(parent, config('bedrock'), false);
  const withUndefined = formatUsageReport(parent, config('bedrock'), false, false, undefined, undefined, undefined, undefined);
  assert('no shares render byte-identically to the pre-cost report', without === withUndefined && !/^\s+cost\s/mu.test(without));

  // The runtime's single-model shape: one share over the whole meter.
  const one = (usage: UsageTotals, cfg: AppConfig, lookup: ModelPriceLookup): readonly ModelUsageShare[] => [{ config: cfg, usage, lookup }];
  const withPrice = formatUsageReport(parent, config('bedrock'), false, false, undefined, undefined, undefined, one(parent, config('bedrock'), priced));
  const lines = withPrice.split('\n');
  const costIndex = lines.findIndex((line) => /^\s+cost\s/u.test(line));
  assert('the cost line closes the main block, directly under the derived cache rows',
    costIndex > 0 && lines[costIndex - 1]?.includes('served from cache') === true);
  assert('the line is the shared describeCost rendering, labelled approximate with its basis',
    lines[costIndex]?.endsWith('≈ $3.1250 (base rates, LiteLLM)') === true);
  assert('pricing adds exactly one line and leaves every other line byte-identical',
    lines.length === without.split('\n').length + 1 && lines.filter((_, i) => i !== costIndex).join('\n') === without);

  const unavailable = formatUsageReport(parent, config('bedrock'), false, false, undefined, undefined, undefined, one(parent, config('bedrock'), { kind: 'unavailable' }));
  assert('an unfetched price reads unavailable, never $0', /cost\s+unknown \(price unavailable\)/u.test(unavailable) && !unavailable.includes('$'));
  const none = formatUsageReport(parent, config('bedrock'), false, false, undefined, undefined, undefined, one(parent, config('bedrock'), { kind: 'none' }));
  assert('a model LiteLLM does not list is named', none.includes('unknown (no price for global.anthropic.claude-opus-5)'));
  const partialUsage: UsageTotals = { inputTokens: 1_000_000, outputTokens: 100_000 };
  const partial = formatUsageReport(partialUsage, config('openai', 'chat'), false, false, undefined, undefined, undefined, one(partialUsage, config('openai', 'chat'), priced));
  assert('an unreported bucket makes the figure a stated floor',
    partial.includes('≥ $3.0000 (cacheRead not reported, cacheWrite not reported; base rates, LiteLLM)'));

  // After a /model switch: each model's share at its own rates, then one line per model
  // under the cost line so the mixed figure can be taken apart. Single-model reports add nothing.
  const sol: ModelPriceLookup = { kind: 'priced', litellmKey: 'bedrock_mantle/openai.gpt-5.6-sol', rates: { inputCostPerToken: 1e-6, outputCostPerToken: 5e-6 } };
  const solUsage: UsageTotals = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const mixed = formatUsageReport(sumUsage([parent, solUsage]), config('openai', 'chat'), false, false, undefined, undefined, undefined, [
    { config: config('bedrock'), usage: parent, lookup: priced },
    { config: config('openai', 'chat'), usage: solUsage, lookup: sol },
  ]);
  const mixedLines = mixed.split('\n');
  const mixedCost = mixedLines.findIndex((line) => /^\s+cost\s/u.test(line));
  assert('two models are priced at their own rates and counted on the cost line',
    mixedLines[mixedCost]?.endsWith('≈ $4.6250 (2 models; base rates, LiteLLM)') === true);
  assert('one per-model line follows for each model, in share order',
    mixedLines[mixedCost + 1] === '    bedrock/global.anthropic.claude-opus-5: ≈ $3.1250 (base rates, LiteLLM)' &&
    mixedLines[mixedCost + 2] === '    openai/openai.gpt-5.6-sol: ≈ $1.5000 (base rates, LiteLLM)');
  assert('a single-model report carries no per-model lines', !withPrice.includes('    bedrock/'));
  const mixedUnpriced = formatUsageReport(sumUsage([parent, solUsage]), config('openai', 'chat'), false, false, undefined, undefined, undefined, [
    { config: config('bedrock'), usage: parent, lookup: priced },
    { config: config('openai', 'chat'), usage: solUsage, lookup: { kind: 'unavailable' } },
  ]);
  assert('a model whose price is unavailable makes the figure a floor that names it',
    mixedUnpriced.includes('≥ $3.1250 (2 models; price unavailable for openai.gpt-5.6-sol; base rates, LiteLLM)') &&
    mixedUnpriced.includes('    openai/openai.gpt-5.6-sol: unknown (price unavailable)'));
}

await adapterContract();
projectionContracts();
effectivenessContracts();
deltaContracts();
sumContracts();
childSectionContracts();
efficiencySectionContracts();
costLineContracts();
report();
