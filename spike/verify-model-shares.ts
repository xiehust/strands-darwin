/**
 * Per-model cost shares — a real offline `AgentRuntime`, a `/model` switch, and every
 * live cost surface pricing each model's tokens at its own rates.
 *
 * Free suite: the model factory is swapped for scripted models (one per configured
 * model id) through `setRuntimeModelFactoryForTest`, so `send()` and `changeModel()`
 * run the real runtime paths — the per-turn tally, the remainder rule, the cache read —
 * without a provider, and the price cache is a file this suite writes under its own
 * `HOME`. Proves:
 *
 * - a single-model session is one share over the whole meter, so `/status`, `/usage`
 *   and the headless `cost:` record render exactly as the one-lookup form did;
 * - after `/model` and a turn on the new model, two shares split the meter metric for
 *   metric, each priced at its own cached rates — not the live rates over the meter;
 * - a switch that has not run a turn adds no share; the record says `2-models`/`mixed`
 *   only once two models actually spent;
 * - reading the shares fetches nothing and writes nothing (cache bytes and mtime
 *   unchanged, `fetch` never reached).
 *
 * Run: pnpm tsx spike/verify-model-shares.ts
 */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';

import { describeCost, describeModelCosts } from '../src/agent/cost.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { sumUsage, type UsageTotals } from '../src/agent/usage.js';
import { configPath, type AppConfig, type ModelChoice } from '../src/config.js';
import { formatHeadlessCost } from '../src/headless.js';
import { userModelPricesFile } from '../src/paths.js';
import { MODEL_PRICES_SCHEMA_VERSION, MODEL_PRICES_SOURCE_URL, type ModelPriceCache } from '../src/pricing/model-prices.js';
import { formatUsageReport } from '../src/tui/App.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const OWNED_HOME = ownPrivateHome('model-shares');

const OPUS = 'global.anthropic.claude-opus-5';
const SOL = 'openai.gpt-5.6-sol';
const OPUS_RATES = { inputCostPerToken: 2e-6, outputCostPerToken: 1e-5, cacheReadInputTokenCost: 2e-7, cacheCreationInputTokenCost: 2.5e-6 };
const SOL_RATES = { inputCostPerToken: 1e-6, outputCostPerToken: 5e-6 };

/** Reports one fixed usage per call — the tokens a turn on this model costs. */
class MeteredModel extends Model<BaseModelConfig> {
  calls = 0;
  private conf: BaseModelConfig = { modelId: 'fake.metered', contextWindowLimit: 200_000 };

  constructor(private readonly usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number }) {
    super();
  }

  override updateConfig(next: BaseModelConfig): void {
    this.conf = { ...this.conf, ...next };
  }

  override getConfig(): BaseModelConfig {
    return this.conf;
  }

  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield {
      type: 'modelMetadataEvent',
      usage: { ...this.usage, totalTokens: this.usage.inputTokens + this.usage.outputTokens },
    };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-model-shares-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(
    configPath(root),
    JSON.stringify({
      permissionMode: 'yolo',
      trajectory: false,
      models: [
        { enable: true, name: 'opus', provider: 'bedrock', model: OPUS, region: 'us-west-2', maxTokens: 8192 },
        { enable: false, name: 'sol', provider: 'openai', model: SOL, bedrockMantle: true, openaiApi: 'chat', region: 'us-east-1', maxTokens: 8192 },
      ],
    }, null, 2),
  );
  return root;
}

async function main(): Promise<void> {
  header('modelShares — a real offline runtime prices each model at its own rates across /model');
  assert('this suite writes its own global state', configPath().startsWith(`${OWNED_HOME}${path.sep}`));

  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    throw new Error('reading shares must never fetch');
  }) as typeof fetch;

  const pricesFile = userModelPricesFile();
  await mkdir(path.dirname(pricesFile), { recursive: true });
  const cache: ModelPriceCache = {
    version: MODEL_PRICES_SCHEMA_VERSION,
    source: MODEL_PRICES_SOURCE_URL,
    models: {
      [OPUS]: { litellmKey: OPUS, fetchedAt: '2026-09-04T00:00:00.000Z', ...OPUS_RATES },
      [SOL]: { litellmKey: `bedrock_mantle/${SOL}`, fetchedAt: '2026-09-04T00:00:00.000Z', ...SOL_RATES },
    },
  };
  await writeFile(pricesFile, JSON.stringify(cache), 'utf8');
  const cacheBefore = await stat(pricesFile);
  const cacheBytes = await readFile(pricesFile);

  const opusUsage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 };
  const solUsage = { inputTokens: 1_000_000, outputTokens: 100_000 };
  const models = { [OPUS]: new MeteredModel(opusUsage), [SOL]: new MeteredModel(solUsage) };
  setRuntimeModelFactoryForTest(async (config: AppConfig) => models[config.model as keyof typeof models] as MeteredModel);

  const root = await fixture();
  const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: allowAllBridge });
  try {
    // Before any turn: one share, the live model, over the (zero) meter.
    const fresh = runtime.modelShares;
    assert('before the first turn there is exactly one share, the live model over the meter',
      fresh.length === 1 && fresh[0]?.config.model === OPUS && fresh[0]?.usage.inputTokens === 0 && fresh[0]?.lookup.kind === 'priced');
    assert('…rendering exactly as the one-lookup form',
      describeModelCosts(fresh) === describeCost(runtime.modelPrice, runtime.usage, runtime.config));

    for await (const _event of runtime.send('first turn on opus')) {
      // Consume the ordinary stream; the tally happens when it settles.
    }
    assert('the scripted opus model served the turn', models[OPUS].calls === 1);
    const single = runtime.modelShares;
    assert('one model, one share, and the share is the meter',
      single.length === 1 && sameUsage(single[0]!.usage, runtime.usage) && single[0]!.config.model === OPUS);
    const singleCost = describeModelCosts(single);
    assert('a single-model session prices exactly as before: describeCost over the meter',
      singleCost === describeCost(runtime.modelPrice, runtime.usage, runtime.config) && singleCost === '≈ $3.1250 (base rates, LiteLLM)');
    assert('…and the headless record is the single-model record',
      formatHeadlessCost(single) === `cost: total=3.1250 input=2.0000 output=1.0000 cacheRead=0.1000 cacheWrite=0.0250 model=${OPUS} pricing=${OPUS}`);

    // Switch without a turn: the meter has nothing new, so no second share appears.
    const target = runtime.modelChoices.find((entry) => entry.name === 'sol') as ModelChoice;
    const switched = await runtime.changeModel(target);
    await switched.saved;
    assert('the live config moved to sol', runtime.config.model === SOL && runtime.config.provider === 'openai');
    const afterSwitch = runtime.modelShares;
    assert('a switch that ran no turn adds no share — no second model that spent nothing',
      afterSwitch.length === 1 && afterSwitch[0]?.config.model === OPUS && describeModelCosts(afterSwitch) === singleCost);
    assert('…while the live rates over the whole meter would now claim a different figure',
      describeCost(runtime.modelPrice, runtime.usage, runtime.config) !== singleCost);

    for await (const _event of runtime.send('second turn on sol')) {
      // The tally attributes this turn to sol, the config in effect when it started.
    }
    assert('the scripted sol model served the second turn', models[SOL].calls === 1 && models[OPUS].calls === 1);
    const two = runtime.modelShares;
    assert('two models, two shares, in first-appearance order',
      two.length === 2 && two[0]?.config.model === OPUS && two[1]?.config.model === SOL);
    assert('the shares split the meter metric for metric',
      sameUsage(sumUsage(two.map((share) => share.usage)), runtime.usage));
    assert('each share is exactly its model\u2019s turn',
      sameUsage(two[0]!.usage, opusUsage) && two[1]!.usage.inputTokens === 1_000_000 && two[1]!.usage.outputTokens === 100_000);
    assert('each share carries its own cached price',
      two[0]!.lookup.kind === 'priced' && two[0]!.lookup.litellmKey === OPUS &&
      two[1]!.lookup.kind === 'priced' && two[1]!.lookup.litellmKey === `bedrock_mantle/${SOL}`);
    // The sol share's cache counters: the openai/chat scripted model reports none, but
    // the SDK meter carries opus's counters forward, so the delta records a measured 0.
    const twoCost = describeModelCosts(two);
    assert('the cost row prices each model at its own rates and counts them',
      twoCost === '≈ $4.6250 (2 models; base rates, LiteLLM)');
    assert('…which the live rates over the whole meter do not produce',
      describeCost(runtime.modelPrice, runtime.usage, runtime.config) !== twoCost);
    assert('the headless record says how many models and that the pricing is mixed',
      formatHeadlessCost(two) === 'cost: total=4.6250 input=3.0000 output=1.5000 cacheRead=0.1000 cacheWrite=0.0250 model=2-models pricing=mixed');
    const usageReport = formatUsageReport(runtime.usage, runtime.config, false, false, runtime.lastTurnUsage, runtime.childUsage, runtime.callStats, two);
    assert('/usage carries the mixed line and one line per model under it',
      usageReport.includes('≈ $4.6250 (2 models; base rates, LiteLLM)') &&
      usageReport.includes(`    bedrock/${OPUS}: ≈ $3.1250 (base rates, LiteLLM)`) &&
      usageReport.includes(`    openai/${SOL}: ≈ $1.5000 (base rates, LiteLLM)`));

    // Back to opus and a third turn: the tally merges into the existing opus share.
    const back = runtime.modelChoices.find((entry) => entry.name === 'opus') as ModelChoice;
    await (await runtime.changeModel(back)).saved;
    for await (const _event of runtime.send('third turn, opus again')) {
      // Same model as the first turn: one share, twice the tokens.
    }
    const merged = runtime.modelShares;
    assert('a model used again merges into its share rather than adding a third',
      merged.length === 2 && merged[0]?.usage.inputTokens === 2_000_000 && merged[0]?.usage.cacheReadInputTokens === 1_000_000);
    assert('…and the shares still sum to the meter', sameUsage(sumUsage(merged.map((share) => share.usage)), runtime.usage));
    assert('the row prices the merged share at opus rates plus sol\u2019s at its own',
      describeModelCosts(merged) === '≈ $7.7500 (2 models; base rates, LiteLLM)');

    const cacheAfter = await stat(pricesFile);
    assert('reading the shares wrote nothing to the price cache',
      cacheAfter.mtimeMs === cacheBefore.mtimeMs && (await readFile(pricesFile)).equals(cacheBytes));
    assert('and never fetched', fetched === 0);
  } finally {
    await runtime.shutdown();
    setRuntimeModelFactoryForTest(undefined);
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
}

function sameUsage(a: UsageTotals, b: UsageTotals): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadInputTokens === b.cacheReadInputTokens &&
    a.cacheWriteInputTokens === b.cacheWriteInputTokens
  );
}

await main();
report();
