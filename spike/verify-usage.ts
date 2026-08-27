/** Offline contracts for provider usage mapping and `/usage` projection. */
import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type OpenAI from 'openai';

import type { AppConfig } from '../src/config.js';
import { formatUsageReport } from '../src/tui/App.js';
import { cacheEffectivenessRows, deltaUsage, usageBuckets, usageRows, type UsageTotals } from '../src/agent/usage.js';
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

await adapterContract();
projectionContracts();
effectivenessContracts();
deltaContracts();
report();
