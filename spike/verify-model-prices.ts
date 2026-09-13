/**
 * The model price cache (`src/pricing/model-prices.ts`) — `~/.darwin/model-prices.json`
 * filled from LiteLLM one model id at a time.
 *
 * Free suite: no model call or external network. Legacy transport checks use
 * injected fetches; negative-cache recovery uses real loopback HTTP and files.
 * Priced ids never refetch; missing/expired-negative ids fetch at most once per
 * process and record their LiteLLM key, `fetchedAt`, `source` and `version`;
 * fresh negative entries suppress requests for 24 hours; key resolution follows the
 * provider order; a missing or damaged file reads as empty; every fetch failure
 * degrades to "unavailable" without a throw or a write; and `lookup()` — what
 * `/status`, `/usage` and headless read — is a read, never a fetch or a write.
 *
 * Run: pnpm tsx spike/verify-model-prices.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  MODEL_PRICES_FETCH_ENV,
  MODEL_PRICES_NEGATIVE_TTL_MS,
  MODEL_PRICES_SCHEMA_VERSION,
  MODEL_PRICES_SOURCE_URL,
  ModelPriceStore,
  defaultModelPriceStore,
  fetchPriceTable,
  lookupFromEntry,
  priceCandidateKeys,
  readModelPriceCache,
  resolveModelPrice,
  writeModelPriceCache,
} from '../src/pricing/model-prices.js';
import { userModelPricesFile } from '../src/paths.js';
import { estimateCost } from '../src/pricing/cost.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('model-prices');

/** A slice of the real table (2026-09-04), with the fields this module reads. */
const TABLE: Record<string, unknown> = {
  sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0, litellm_provider: 'one of …' },
  'global.anthropic.claude-sonnet-5': {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 2.5e-6,
    litellm_provider: 'bedrock_converse',
  },
  'bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0': {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    litellm_provider: 'bedrock',
  },
  'bedrock_mantle/openai.gpt-5.6-sol': {
    input_cost_per_token: 5.5e-6,
    output_cost_per_token: 3.3e-5,
    cache_read_input_token_cost: 5.5e-7,
    cache_creation_input_token_cost: 6.875e-6,
    litellm_provider: 'bedrock_mantle',
  },
  'openai/openai.gpt-5.6-sol': { input_cost_per_token: 9, output_cost_per_token: 9 },
  'anthropic/claude-sonnet-4-5': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
  'openai/gpt-5': { input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
  'broken/no-output-rate': { input_cost_per_token: 1e-6, output_cost_per_token: 'free' },
};

function tempFile(label: string): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), `darwin-prices-${label}-`)), 'model-prices.json');
}

/** A fetch stub serving `body` with `status`, counting calls; `body` may be a byte length to fabricate. */
function stubFetch(options: { body?: unknown; status?: number; bytes?: number; hang?: boolean } = {}): {
  fetch: typeof globalThis.fetch;
  calls: () => number;
  urls: () => readonly string[];
} {
  let calls = 0;
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls += 1;
    urls.push(String(input));
    if (options.hang === true) {
      // A real socket keeps the event loop alive while the store's (unref'd) timeout
      // runs; this ref'd timer stands in for it, and the abort must win the race.
      await new Promise<void>((_, reject) => {
        const socket = setTimeout(() => reject(new Error('the store never aborted the hung fetch')), 5_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(socket);
          reject(new Error('aborted'));
        }, { once: true });
      });
    }
    const text = options.bytes !== undefined ? 'x'.repeat(options.bytes) : JSON.stringify(options.body ?? TABLE);
    return new Response(text, {
      status: options.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls: () => calls, urls: () => urls };
}

const neverFetch: typeof globalThis.fetch = async () => {
  throw new Error('fetch must not be called: the id is already mapped');
};

function bedrock(model: string) {
  return { provider: 'bedrock' as const, model };
}

function cacheFileContract(): void {
  header('cache file — missing or damaged reads as empty; writes are atomic and self-describing');

  const missing = tempFile('missing');
  const empty = readModelPriceCache(missing);
  assert('a missing file reads as an empty mapping with the schema and source',
    Object.keys(empty.models).length === 0 && empty.version === MODEL_PRICES_SCHEMA_VERSION && empty.source === MODEL_PRICES_SOURCE_URL);

  const damaged = tempFile('damaged');
  writeFileSync(damaged, '{ not json');
  assert('unparsable JSON reads as empty without throwing', Object.keys(readModelPriceCache(damaged).models).length === 0);
  writeFileSync(damaged, JSON.stringify({ version: 99, source: 's', models: { a: { litellmKey: 'a', fetchedAt: 'x', inputCostPerToken: 1, outputCostPerToken: 1 } } }));
  assert('a foreign schema version reads as empty', Object.keys(readModelPriceCache(damaged).models).length === 0);
  writeFileSync(damaged, JSON.stringify([1, 2, 3]));
  assert('a non-object root reads as empty', Object.keys(readModelPriceCache(damaged).models).length === 0);
  writeFileSync(damaged, JSON.stringify({
    version: 1,
    source: MODEL_PRICES_SOURCE_URL,
    models: {
      good: { litellmKey: 'k', fetchedAt: '2026-09-04T00:00:00.000Z', inputCostPerToken: 1e-6, outputCostPerToken: 2e-6 },
      unpriced: { litellmKey: null, fetchedAt: '2026-09-04T00:00:00.000Z' },
      'no-fetchedAt': { litellmKey: 'k', inputCostPerToken: 1, outputCostPerToken: 1 },
      'bad-rate': { litellmKey: 'k', fetchedAt: 'x', inputCostPerToken: 'free', outputCostPerToken: 1 },
      'negative-rate': { litellmKey: 'k', fetchedAt: 'x', inputCostPerToken: -1, outputCostPerToken: 1 },
      'not-an-object': 42,
    },
  }));
  const mixed = readModelPriceCache(damaged);
  assert('malformed entries are skipped one by one, valid ones kept',
    Object.keys(mixed.models).sort().join(',') === 'good,unpriced' && mixed.models['unpriced']?.litellmKey === null);

  const written = tempFile('written');
  const cache = readModelPriceCache(written);
  cache.models['x'] = { litellmKey: 'x', fetchedAt: '2026-09-04T00:00:00.000Z', inputCostPerToken: 1, outputCostPerToken: 2 };
  writeModelPriceCache(written, cache);
  const raw = JSON.parse(readFileSync(written, 'utf8')) as Record<string, unknown>;
  assert('the written file carries version, source and the mapping only',
    raw['version'] === 1 && raw['source'] === MODEL_PRICES_SOURCE_URL &&
    Object.keys(raw).sort().join(',') === 'models,source,version');
  assert('no temp file is left beside the cache after the rename',
    readdirSync(path.dirname(written)).filter((name) => name.endsWith('.tmp')).length === 0);
  assert('the cache directory is created on demand', (() => {
    const nested = path.join(path.dirname(written), 'deeper', 'still', 'model-prices.json');
    writeModelPriceCache(nested, cache);
    return existsSync(nested);
  })());
}

function resolutionContract(): void {
  header('key resolution — exact id first, then the provider-specific LiteLLM prefix');

  assert('bedrock tries the bare id, then bedrock/',
    priceCandidateKeys(bedrock('m')).join(' ') === 'm bedrock/m');
  assert('openai over Bedrock Mantle tries the bare id, then bedrock_mantle/',
    priceCandidateKeys({ provider: 'openai', model: 'm', bedrockMantle: true }).join(' ') === 'm bedrock_mantle/m');
  assert('openai over the Bedrock runtime endpoint is a Bedrock profile: bare id, then bedrock/',
    priceCandidateKeys({ provider: 'openai', model: 'm', bedrockRuntime: true }).join(' ') === 'm bedrock/m');
  assert('direct openai tries the bare id, then openai/',
    priceCandidateKeys({ provider: 'openai', model: 'm' }).join(' ') === 'm openai/m');
  assert('anthropic tries the bare id, then anthropic/',
    priceCandidateKeys({ provider: 'anthropic', model: 'm' }).join(' ') === 'm anthropic/m');

  const at = '2026-09-04T00:00:00.000Z';
  const exact = resolveModelPrice(TABLE, bedrock('global.anthropic.claude-sonnet-5'), at);
  assert('a bare Bedrock inference profile resolves to the exact key with all four rates',
    exact.litellmKey === 'global.anthropic.claude-sonnet-5' && exact.inputCostPerToken === 2e-6 &&
    exact.outputCostPerToken === 1e-5 && exact.cacheReadInputTokenCost === 2e-7 && exact.cacheCreationInputTokenCost === 2.5e-6 &&
    exact.fetchedAt === at);
  const prefixed = resolveModelPrice(TABLE, bedrock('us.anthropic.claude-haiku-4-5-20251001-v1:0'), at);
  assert('a Bedrock id listed only under bedrock/ resolves to that key, cache rates absent',
    prefixed.litellmKey === 'bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0' &&
    prefixed.inputCostPerToken === 1e-6 && prefixed.cacheReadInputTokenCost === undefined);
  const mantle = resolveModelPrice(TABLE, { provider: 'openai', model: 'openai.gpt-5.6-sol', bedrockMantle: true }, at);
  assert('a Mantle model resolves to bedrock_mantle/, not the openai/ twin',
    mantle.litellmKey === 'bedrock_mantle/openai.gpt-5.6-sol' && mantle.inputCostPerToken === 5.5e-6);
  const direct = resolveModelPrice(TABLE, { provider: 'openai', model: 'openai.gpt-5.6-sol' }, at);
  assert('the same id without Mantle resolves to openai/', direct.litellmKey === 'openai/openai.gpt-5.6-sol');
  assert('anthropic resolves through anthropic/',
    resolveModelPrice(TABLE, { provider: 'anthropic', model: 'claude-sonnet-4-5' }, at).litellmKey === 'anthropic/claude-sonnet-4-5');
  const none = resolveModelPrice(TABLE, bedrock('us.made-up.model-v9'), at);
  assert('an id no candidate matches records litellmKey null with fetchedAt, no rates',
    none.litellmKey === null && none.fetchedAt === at && none.inputCostPerToken === undefined);
  assert('an entry without a numeric output rate is not a hit',
    resolveModelPrice(TABLE, { provider: 'anthropic', model: 'broken/no-output-rate' }, at).litellmKey === null);
  assert('a non-object table resolves nothing without throwing',
    resolveModelPrice('nope', bedrock('m'), at).litellmKey === null && resolveModelPrice(undefined, bedrock('m'), at).litellmKey === null);

  assert('lookupFromEntry projects absence → unavailable, null key → none, rates → priced',
    lookupFromEntry(undefined).kind === 'unavailable' && lookupFromEntry(none).kind === 'none' &&
    lookupFromEntry(exact).kind === 'priced' && (lookupFromEntry(exact) as { litellmKey: string }).litellmKey === exact.litellmKey);
}

async function storeContract(): Promise<void> {
  header('ModelPriceStore — mapped ids never fetch; unmapped ids fetch once and are recorded');

  // Existing mapping → no fetch. The stub throws if called; the store must not even get there.
  const preloaded = tempFile('preloaded');
  const seeded = readModelPriceCache(preloaded);
  seeded.models['global.anthropic.claude-sonnet-5'] = {
    litellmKey: 'global.anthropic.claude-sonnet-5', fetchedAt: '2026-09-01T00:00:00.000Z', inputCostPerToken: 2e-6, outputCostPerToken: 1e-5,
  };
  writeModelPriceCache(preloaded, seeded);
  const preStat = statSync(preloaded).mtimeMs;
  const cached = new ModelPriceStore({ file: preloaded, fetch: neverFetch });
  await cached.ensure(bedrock('global.anthropic.claude-sonnet-5'));
  const lookup = cached.lookup(bedrock('global.anthropic.claude-sonnet-5'));
  assert('an id the file already maps is priced without a fetch',
    lookup.kind === 'priced' && lookup.litellmKey === 'global.anthropic.claude-sonnet-5' && lookup.rates.inputCostPerToken === 2e-6);
  assert('the ensure-on-mapped-id path writes nothing', statSync(preloaded).mtimeMs === preStat);

  // lookup() is a read: no fetch (the stub would throw), no write, even for an unmapped id.
  const unmappedLookup = cached.lookup(bedrock('never.seen'));
  assert('lookup of an unmapped id is unavailable and neither fetches nor writes',
    unmappedLookup.kind === 'unavailable' && statSync(preloaded).mtimeMs === preStat);

  // Missing id → exactly one fetch, mapping recorded with key, fetchedAt, source, version.
  const fresh = tempFile('fresh');
  const now = new Date('2026-09-04T12:00:00.000Z');
  const stub = stubFetch();
  const store = new ModelPriceStore({ file: fresh, fetch: stub.fetch, now: () => now });
  assert('before ensure, the price is unavailable', store.lookup(bedrock('global.anthropic.claude-sonnet-5')).kind === 'unavailable');
  await Promise.all([
    store.ensure(bedrock('global.anthropic.claude-sonnet-5')),
    store.ensure(bedrock('global.anthropic.claude-sonnet-5')),
    store.ensure(bedrock('global.anthropic.claude-sonnet-5')),
  ]);
  assert('concurrent ensures for one id share exactly one fetch of the source URL',
    stub.calls() === 1 && stub.urls()[0] === MODEL_PRICES_SOURCE_URL);
  const file = JSON.parse(readFileSync(fresh, 'utf8')) as { version: number; source: string; models: Record<string, Record<string, unknown>> };
  const entry = file.models['global.anthropic.claude-sonnet-5'];
  assert('the mapping is written with litellmKey, the four rates, fetchedAt, source and version',
    file.version === 1 && file.source === MODEL_PRICES_SOURCE_URL &&
    entry?.['litellmKey'] === 'global.anthropic.claude-sonnet-5' && entry?.['fetchedAt'] === now.toISOString() &&
    entry?.['inputCostPerToken'] === 2e-6 && entry?.['cacheCreationInputTokenCost'] === 2.5e-6);
  assert('only the resolved mapping is stored, never the table',
    Object.keys(file.models).length === 1 && !readFileSync(fresh, 'utf8').includes('sample_spec'));
  assert('no temp file remains', readdirSync(path.dirname(fresh)).filter((name) => name.endsWith('.tmp')).length === 0);
  assert('the lookup now prices the model', store.lookup(bedrock('global.anthropic.claude-sonnet-5')).kind === 'priced');
  await store.ensure(bedrock('global.anthropic.claude-sonnet-5'));
  assert('a second ensure for the now-mapped id does not fetch again', stub.calls() === 1);

  // A different id (`/model`) fetches again — once — and merges into the same file.
  await store.ensure({ provider: 'openai', model: 'openai.gpt-5.6-sol', bedrockMantle: true });
  assert('a new id fetches once more and is merged beside the first',
    stub.calls() === 2 && Object.keys(readModelPriceCache(fresh).models).sort().join(',') === 'global.anthropic.claude-sonnet-5,openai.gpt-5.6-sol');
  const mantle = store.lookup({ provider: 'openai', model: 'openai.gpt-5.6-sol', bedrockMantle: true });
  assert('the Mantle id is priced under its bedrock_mantle/ key',
    mantle.kind === 'priced' && mantle.litellmKey === 'bedrock_mantle/openai.gpt-5.6-sol');

  // An unresolvable id: one fetch, `litellmKey: null` recorded, fresh across processes.
  await store.ensure(bedrock('us.made-up.model-v9'));
  assert('an unlisted id is fetched once and recorded as no price',
    stub.calls() === 3 && readModelPriceCache(fresh).models['us.made-up.model-v9']?.litellmKey === null &&
    store.lookup(bedrock('us.made-up.model-v9')).kind === 'none');
  const laterFetch = stubFetch();
  const later = new ModelPriceStore({ file: fresh, fetch: laterFetch.fetch, now: () => now });
  await later.ensure(bedrock('us.made-up.model-v9'));
  assert('a later process reuses the fresh no-price entry without fetching',
    laterFetch.calls() === 0 && later.lookup(bedrock('us.made-up.model-v9')).kind === 'none');

  // Fetch disabled: ensure is a pure cache check.
  const off = stubFetch();
  const disabled = new ModelPriceStore({ file: tempFile('off'), fetch: off.fetch, fetchEnabled: false });
  await disabled.ensure(bedrock('global.anthropic.claude-sonnet-5'));
  assert('fetchEnabled: false never fetches and leaves the price unavailable',
    off.calls() === 0 && disabled.lookup(bedrock('global.anthropic.claude-sonnet-5')).kind === 'unavailable');
  assert('the default store reads the switch from the environment variable the test harness sets',
    MODEL_PRICES_FETCH_ENV === 'DARWIN_MODEL_PRICES_FETCH');
}

async function failureContract(): Promise<void> {
  header('fetch failures — unavailable, no throw, no write, no retry this process');

  const cases: { label: string; stub: ReturnType<typeof stubFetch>; timeoutMs?: number; maxBytes?: number }[] = [
    { label: 'non-200', stub: stubFetch({ status: 503 }) },
    { label: 'bad JSON', stub: stubFetch({ bytes: 10 }) },
    { label: 'non-object JSON', stub: stubFetch({ body: [1, 2] }) },
    { label: 'over-cap body', stub: stubFetch({ bytes: 5000 }), maxBytes: 4096 },
    { label: 'timeout', stub: stubFetch({ hang: true }), timeoutMs: 50 },
  ];
  for (const { label, stub, timeoutMs, maxBytes } of cases) {
    const file = tempFile(label.replace(/\W+/gu, '-'));
    const store = new ModelPriceStore({
      file,
      fetch: stub.fetch,
      ...(timeoutMs !== undefined && { timeoutMs }),
      ...(maxBytes !== undefined && { maxBytes }),
    });
    let threw = false;
    try {
      await store.ensure(bedrock('global.anthropic.claude-sonnet-5'));
    } catch {
      threw = true;
    }
    assert(`${label}: ensure resolves without throwing`, !threw);
    assert(`${label}: the price stays unavailable`, store.lookup(bedrock('global.anthropic.claude-sonnet-5')).kind === 'unavailable');
    assert(`${label}: nothing is written`, !existsSync(file) && readdirSync(path.dirname(file)).length === 0);
    await store.ensure(bedrock('global.anthropic.claude-sonnet-5'));
    assert(`${label}: the failed id is not retried within the process`, stub.calls() === 1);
  }

  const thrower: typeof globalThis.fetch = async () => {
    throw new TypeError('fetch failed');
  };
  assert('a rejecting fetch (offline) is unavailable, not an error',
    (await fetchPriceTable({ fetch: thrower })) === undefined);
  const declared: typeof globalThis.fetch = async () =>
    new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } });
  assert('an over-cap content-length is refused before the body is read',
    (await fetchPriceTable({ fetch: declared, maxBytes: 1024 })) === undefined);
  const ok = await fetchPriceTable({ fetch: stubFetch().fetch });
  assert('a healthy table parses to its object', ok !== undefined && 'global.anthropic.claude-sonnet-5' in ok);

  // A write failure (the cache path is a directory) degrades the same way.
  const dirAsFile = tempFile('dir');
  mkdirSync(dirAsFile, { recursive: true });
  const stub = stubFetch();
  const store = new ModelPriceStore({ file: dirAsFile, fetch: stub.fetch });
  let threw = false;
  try {
    await store.ensure(bedrock('global.anthropic.claude-sonnet-5'));
  } catch {
    threw = true;
  }
  assert('an unwritable cache path degrades to unavailable without throwing',
    !threw && stub.calls() === 1 && store.lookup(bedrock('global.anthropic.claude-sonnet-5')).kind === 'unavailable');
}

async function negativeCacheContract(): Promise<void> {
  header('negative cache — real HTTP recovery, expiry bounds and failure preservation');
  const config = { provider: 'openai' as const, model: 'global.openai.gpt-6-astra', bedrockRuntime: true };
  const base = Date.parse('2026-09-09T06:10:09.039Z');
  let clock = base + MODEL_PRICES_NEGATIVE_TTL_MS - 1;
  let requests = 0;
  let status = 200;
  let body = '{}';
  let beforeResponse: (() => void) | undefined;
  // The diagnosed model's public base rates, served locally (no live price dependency).
  const table = { [config.model]: {
    input_cost_per_token: 0.00001, output_cost_per_token: 0.00005,
    cache_read_input_token_cost: 0.000001, cache_creation_input_token_cost: 0.0000125,
  } };
  const server = createServer((_request, response) => {
    requests += 1;
    beforeResponse?.();
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('loopback server has no port');
  const url = `http://127.0.0.1:${address.port}/prices`;
  const now = () => new Date(clock);
  const seed = (label: string, fetchedAt = new Date(base).toISOString()): string => {
    const file = tempFile(label);
    const cache = readModelPriceCache(file);
    cache.models[config.model] = { litellmKey: null, fetchedAt };
    cache.models['unrelated-priced'] = {
      litellmKey: 'unrelated-priced', fetchedAt: 'old', inputCostPerToken: 1, outputCostPerToken: 2,
    };
    writeModelPriceCache(file, cache);
    return file;
  };
  try {
    assert('negative TTL is exactly one day', MODEL_PRICES_NEGATIVE_TTL_MS === 86_400_000);
    const file = seed('negative-expiry');
    const original = readFileSync(file, 'utf8');
    const originalMtime = statSync(file).mtimeMs;
    const store = new ModelPriceStore({ file, url, now });
    await store.ensure(config);
    await new ModelPriceStore({ file, url, now }).ensure(config);
    assert('fresh negative entries survive launches without a request or write',
      requests === 0 && readFileSync(file, 'utf8') === original && statSync(file).mtimeMs === originalMtime);

    clock += 1;
    assert('expired lookup is still a read-only no-price result',
      store.lookup(config).kind === 'none' && requests === 0 && readFileSync(file, 'utf8') === original);
    await new ModelPriceStore({ file, url, now, fetchEnabled: false }).ensure(config);
    assert('fetch disabled preserves expired negative entries without a request or write',
      requests === 0 && readFileSync(file, 'utf8') === original && statSync(file).mtimeMs === originalMtime);
    await Promise.all([store.ensure(config), store.ensure(config), store.ensure(config)]);
    const renewed = readModelPriceCache(file).models[config.model];
    assert('at the TTL boundary concurrent ensures share one real HTTP request', requests === 1);
    assert('a successful no-match renews the negative timestamp',
      renewed?.litellmKey === null && renewed.fetchedAt === now().toISOString());
    const renewedBytes = readFileSync(file, 'utf8');
    clock += MODEL_PRICES_NEGATIVE_TTL_MS - 1;
    await new ModelPriceStore({ file, url, now }).ensure(config);
    assert('a renewed negative suppresses requests until its next TTL',
      requests === 1 && readFileSync(file, 'utf8') === renewedBytes);
    clock += 1;
    await store.ensure(config);
    assert('even after TTL expiry the same process never attempts an id twice', requests === 1);

    body = JSON.stringify(table);
    const recovery = new ModelPriceStore({ file, url, now });
    await Promise.all([recovery.ensure(config), recovery.ensure(config)]);
    const priced = recovery.lookup(config);
    assert('a later process recovers a published exact-model price from the negative cache',
      requests === 2 && priced.kind === 'priced' && priced.litellmKey === config.model);
    assert('recovery keeps unrelated prices and records the real source and schema',
      readModelPriceCache(file).models['unrelated-priced']?.inputCostPerToken === 1 &&
      readModelPriceCache(file).source === url && readModelPriceCache(file).version === 1);
    assert('recovered rates can price the diagnosed worker token totals',
      priced.kind === 'priced' && Math.abs(estimateCost({
        input: 184, output: 42713, cacheRead: 8429915, cacheWrite: 236611,
      }, priced.rates).total - 13.5250425) < 1e-10);
    const pricedBytes = readFileSync(file, 'utf8');
    clock += 100 * MODEL_PRICES_NEGATIVE_TTL_MS;
    await new ModelPriceStore({ file, url, now }).ensure(config);
    await new ModelPriceStore({ file, url, now }).ensure(bedrock('unrelated-priced'));
    assert('priced entries never refetch, regardless of age or invalid timestamp',
      requests === 2 && readFileSync(file, 'utf8') === pricedBytes);

    for (const fetchedAt of ['', 'invalid', new Date(clock + 1).toISOString()]) {
      const invalidFile = seed('negative-invalid-time', fetchedAt);
      const count = requests;
      const invalid = new ModelPriceStore({ file: invalidFile, url, now });
      await invalid.ensure(config);
      assert(`negative timestamp ${JSON.stringify(fetchedAt)} cannot suppress recovery forever`,
        requests === count + 1 && invalid.lookup(config).kind === 'priced');
    }
    for (const failure of [
      { name: 'HTTP failure', status: 503, body: '{}' },
      { name: 'malformed JSON', status: 200, body: 'not json' },
    ]) {
      status = failure.status;
      body = failure.body;
      const failedFile = seed('negative-refresh-failure');
      const before = readFileSync(failedFile, 'utf8');
      const mtime = statSync(failedFile).mtimeMs;
      const count = requests;
      const failed = new ModelPriceStore({ file: failedFile, url, now });
      await Promise.all([failed.ensure(config), failed.ensure(config)]);
      await failed.ensure(config);
      assert(`${failure.name}: one attempt, old negative bytes/timestamp retained`,
        requests === count + 1 && readFileSync(failedFile, 'utf8') === before &&
        statSync(failedFile).mtimeMs === mtime && failed.lookup(config).kind === 'none');
      status = 200;
      body = JSON.stringify(table);
      const next = new ModelPriceStore({ file: failedFile, url, now });
      await next.ensure(config);
      assert(`${failure.name}: next process can recover without manual cache deletion`,
        requests === count + 2 && next.lookup(config).kind === 'priced');
    }

    // Publish a positive mapping while another store's older table is in flight.
    const racingFile = seed('negative-race');
    let publishedBytes = '';
    const winner = resolveModelPrice(table, config, now().toISOString());
    beforeResponse = () => {
      const cache = readModelPriceCache(racingFile);
      cache.models[config.model] = winner;
      writeModelPriceCache(racingFile, cache);
      publishedBytes = readFileSync(racingFile, 'utf8');
    };
    body = '{}';
    const racing = new ModelPriceStore({ file: racingFile, url, now });
    await racing.ensure(config);
    assert('a late no-match response cannot erase a concurrently published price',
      racing.lookup(config).kind === 'priced' && readFileSync(racingFile, 'utf8') === publishedBytes);
    beforeResponse = undefined;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function pathContract(): void {
  header('paths — the cache lives under the user-global .darwin, derived from the home directory');
  const file = userModelPricesFile();
  assert('the cache file is ~/.darwin/model-prices.json under the (private) HOME',
    file === path.join(HOME, '.darwin', 'model-prices.json'));
  assert('the default store is one process-wide instance over that file',
    defaultModelPriceStore() === defaultModelPriceStore() && defaultModelPriceStore().file === file);
  assert('nothing has been written to the private HOME by any read in this suite', !existsSync(file));
}

cacheFileContract();
resolutionContract();
await storeContract();
await failureContract();
await negativeCacheContract();
pathContract();
report();
