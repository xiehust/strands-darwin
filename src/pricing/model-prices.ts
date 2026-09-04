/**
 * The model price cache: `~/.darwin/model-prices.json`, filled from LiteLLM's public
 * price table one model id at a time.
 *
 * This module is the feature's only I/O and darwin's only use of the network outside
 * tools and MCP. Its contract, decided by the user (2026-09-04):
 *
 * - The file stores **only the resolved mapping** — darwin model id → the four base
 *   rates plus the LiteLLM key they were read under and when — never the 2 MB table.
 * - **A mapped id is never refetched.** Only an id the file does not know triggers a
 *   fetch, and at most one per process for that id (concurrent callers share it, a
 *   failed attempt is not retried until the next launch). An id LiteLLM does not
 *   list is recorded as `litellmKey: null` so it, too, is fetched once and not on
 *   every launch.
 * - Every failure degrades to "price unavailable": no thrown error, no warning into
 *   the frame, no file write. A missing or damaged cache reads as empty.
 * - Reads are synchronous and side-effect free, so `/status` and `/usage` can read
 *   through {@link ModelPriceStore.lookup} without becoming a fetch or a write.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ModelPriceLookup, ModelRates } from './cost.js';
import type { AppConfig } from '../config.js';
import { userModelPricesFile } from '../paths.js';

export const MODEL_PRICES_SOURCE_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const MODEL_PRICES_SCHEMA_VERSION = 1;
/** The table is ~2.1 MB today; anything past this is not the table. */
export const MODEL_PRICES_MAX_BYTES = 8 * 1024 * 1024;
export const MODEL_PRICES_FETCH_TIMEOUT_MS = 10_000;

/** One cached mapping. `litellmKey: null` records "LiteLLM has no entry for this id". */
export interface ModelPriceEntry extends Partial<ModelRates> {
  litellmKey: string | null;
  /** ISO timestamp of the fetch that produced this entry. */
  fetchedAt: string;
}

export interface ModelPriceCache {
  version: typeof MODEL_PRICES_SCHEMA_VERSION;
  source: string;
  models: Record<string, ModelPriceEntry>;
}

/** The shape of the price table this module needs — the rest of each entry is ignored. */
type PriceTable = Record<string, unknown>;

/** A `PriceConfig` is the part of the live config that decides which LiteLLM key applies. */
export type PriceConfig = Pick<AppConfig, 'provider' | 'model' | 'bedrockMantle'>;

export function emptyModelPriceCache(): ModelPriceCache {
  return { version: MODEL_PRICES_SCHEMA_VERSION, source: MODEL_PRICES_SOURCE_URL, models: {} };
}

/**
 * Reads the cache, tolerant by construction: a missing file, unparsable JSON, a
 * foreign schema version or a non-object root all read as empty, and a malformed
 * entry is skipped rather than failing the file. Never throws.
 */
export function readModelPriceCache(file: string): ModelPriceCache {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return emptyModelPriceCache();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyModelPriceCache();
  }
  if (!isRecord(parsed) || parsed['version'] !== MODEL_PRICES_SCHEMA_VERSION || !isRecord(parsed['models'])) {
    return emptyModelPriceCache();
  }
  const cache = emptyModelPriceCache();
  if (typeof parsed['source'] === 'string') cache.source = parsed['source'];
  for (const [id, raw] of Object.entries(parsed['models'])) {
    const entry = validEntry(raw);
    if (entry !== undefined) cache.models[id] = entry;
  }
  return cache;
}

function validEntry(raw: unknown): ModelPriceEntry | undefined {
  if (!isRecord(raw) || typeof raw['fetchedAt'] !== 'string') return undefined;
  const key = raw['litellmKey'];
  if (key === null) return { litellmKey: null, fetchedAt: raw['fetchedAt'] };
  if (typeof key !== 'string') return undefined;
  const rates = ratesFrom(raw, {
    input: 'inputCostPerToken',
    output: 'outputCostPerToken',
    cacheRead: 'cacheReadInputTokenCost',
    cacheWrite: 'cacheCreationInputTokenCost',
  });
  if (rates === undefined) return undefined;
  return { litellmKey: key, fetchedAt: raw['fetchedAt'], ...rates };
}

/**
 * Writes the whole cache atomically: a sibling temp file, then `rename`, so a
 * reader never sees a half-written file and a crash leaves the previous one intact.
 * Throws on I/O failure; the store catches, because a price is never worth a turn.
 */
export function writeModelPriceCache(file: string, cache: ModelPriceCache): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * The LiteLLM keys to try for one darwin model id, most specific match first: the
 * exact id (Bedrock inference profiles such as `global.anthropic.claude-sonnet-5`
 * are listed bare), then the provider-prefixed form LiteLLM uses when the bare id
 * is ambiguous — `bedrock/`, `bedrock_mantle/` (OpenAI-compatible Bedrock), `anthropic/`, `openai/`.
 */
export function priceCandidateKeys(config: PriceConfig): readonly string[] {
  const id = config.model;
  switch (config.provider) {
    case 'bedrock':
      return [id, `bedrock/${id}`];
    case 'anthropic':
      return [id, `anthropic/${id}`];
    case 'openai':
      return config.bedrockMantle === true ? [id, `bedrock_mantle/${id}`] : [id, `openai/${id}`];
  }
}

/**
 * Resolves one model against a fetched table: the first candidate key whose entry
 * carries numeric `input_cost_per_token` and `output_cost_per_token` wins; the
 * cache rates are copied when present. No hit records `litellmKey: null` — a
 * resolved "no price", not an absence, so the id is not fetched again next launch.
 */
export function resolveModelPrice(table: unknown, config: PriceConfig, fetchedAt: string): ModelPriceEntry {
  if (isRecord(table)) {
    for (const key of priceCandidateKeys(config)) {
      const rates = ratesFrom(table[key], {
        input: 'input_cost_per_token',
        output: 'output_cost_per_token',
        cacheRead: 'cache_read_input_token_cost',
        cacheWrite: 'cache_creation_input_token_cost',
      });
      if (rates !== undefined) return { litellmKey: key, fetchedAt, ...rates };
    }
  }
  return { litellmKey: null, fetchedAt };
}

/** Projects one cache entry (or its absence) into the lookup the surfaces render. */
export function lookupFromEntry(entry: ModelPriceEntry | undefined): ModelPriceLookup {
  if (entry === undefined) return { kind: 'unavailable' };
  if (entry.litellmKey === null || entry.inputCostPerToken === undefined || entry.outputCostPerToken === undefined) {
    return { kind: 'none' };
  }
  return {
    kind: 'priced',
    litellmKey: entry.litellmKey,
    rates: {
      inputCostPerToken: entry.inputCostPerToken,
      outputCostPerToken: entry.outputCostPerToken,
      ...(entry.cacheReadInputTokenCost !== undefined && { cacheReadInputTokenCost: entry.cacheReadInputTokenCost }),
      ...(entry.cacheCreationInputTokenCost !== undefined && {
        cacheCreationInputTokenCost: entry.cacheCreationInputTokenCost,
      }),
    },
  };
}

export interface FetchPriceTableOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBytes?: number;
  url?: string;
}

/**
 * Fetches the LiteLLM table with a bounded timeout and a bounded body, or returns
 * `undefined` — never throws. Non-2xx, an over-cap body (by `content-length` or by
 * actually counting the streamed bytes), invalid JSON or a non-object root are all
 * "unavailable"; nothing is written by this function.
 */
export async function fetchPriceTable(options: FetchPriceTableOptions = {}): Promise<PriceTable | undefined> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? MODEL_PRICES_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? MODEL_PRICES_FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetchImpl(options.url ?? MODEL_PRICES_SOURCE_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) return undefined;
    const text = await readBounded(response, maxBytes);
    if (text === undefined) return undefined;
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the body while counting bytes; `undefined` the moment the cap is exceeded. */
async function readBounded(response: Response, maxBytes: number): Promise<string | undefined> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxBytes ? undefined : text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface ModelPriceStoreOptions {
  /** The cache file; production uses {@link userModelPricesFile}. */
  file: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
  url?: string;
  /**
   * `false` makes {@link ModelPriceStore.ensure} a pure cache check: nothing is ever
   * fetched, only what the file already knows is priced. The default store reads it
   * from {@link MODEL_PRICES_FETCH_ENV} (`off`), which is how `pnpm test` keeps the
   * real-runtime suites off the network and how an air-gapped user keeps darwin from
   * calling GitHub at all.
   */
  fetchEnabled?: boolean;
}

/** Set to `off` to disable the background price fetch for the process; the cache is still read. */
export const MODEL_PRICES_FETCH_ENV = 'DARWIN_MODEL_PRICES_FETCH';

/**
 * The per-process price store: read-only {@link lookup} for every surface, and
 * {@link ensure} — lookup, fetch once if absent, record — for startup and `/model`.
 */
export class ModelPriceStore {
  /** One settled-or-pending attempt per model id: the "one fetch per process per id" rule. */
  private readonly attempts = new Map<string, Promise<void>>();

  constructor(private readonly options: ModelPriceStoreOptions) {}

  get file(): string {
    return this.options.file;
  }

  /** What the cache says about this model right now. Synchronous; reads the file, writes nothing. */
  lookup(config: PriceConfig): ModelPriceLookup {
    try {
      return lookupFromEntry(readModelPriceCache(this.options.file).models[config.model]);
    } catch {
      return { kind: 'unavailable' };
    }
  }

  /**
   * Makes sure the cache has an entry for this model if the network can provide one.
   * A mapped id returns without fetching; an unmapped id fetches at most once per
   * process (shared by concurrent callers) and records the result — the resolved
   * rates, or `litellmKey: null`. Never rejects: callers fire and forget it.
   */
  async ensure(config: PriceConfig): Promise<void> {
    try {
      if (readModelPriceCache(this.options.file).models[config.model] !== undefined) return;
      if (this.options.fetchEnabled === false) return;
      let attempt = this.attempts.get(config.model);
      if (attempt === undefined) {
        attempt = this.fetchAndRecord(config).catch(() => undefined);
        this.attempts.set(config.model, attempt);
      }
      await attempt;
    } catch {
      // Degrade to "price unavailable"; a price is never worth a turn or a notice.
    }
  }

  private async fetchAndRecord(config: PriceConfig): Promise<void> {
    const table = await fetchPriceTable({
      ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
      ...(this.options.timeoutMs !== undefined && { timeoutMs: this.options.timeoutMs }),
      ...(this.options.maxBytes !== undefined && { maxBytes: this.options.maxBytes }),
      ...(this.options.url !== undefined && { url: this.options.url }),
    });
    if (table === undefined) return;
    const fetchedAt = (this.options.now ?? (() => new Date()))().toISOString();
    const entry = resolveModelPrice(table, config, fetchedAt);
    // Re-read before merging so two processes filling different ids cannot erase
    // each other's work; the rename below then publishes the merged file whole.
    const cache = readModelPriceCache(this.options.file);
    cache.source = this.options.url ?? MODEL_PRICES_SOURCE_URL;
    cache.models[config.model] = entry;
    writeModelPriceCache(this.options.file, cache);
  }
}

let defaultStore: ModelPriceStore | undefined;

/**
 * The process-wide store over `~/.darwin/model-prices.json`. One instance per
 * process so a `/clear` successor runtime shares the fetch-once bookkeeping with
 * its predecessor instead of starting a second download of the same table.
 * `DARWIN_MODEL_PRICES_FETCH=off` in the environment keeps it cache-only.
 */
export function defaultModelPriceStore(): ModelPriceStore {
  defaultStore ??= new ModelPriceStore({
    file: userModelPricesFile(),
    fetchEnabled: process.env[MODEL_PRICES_FETCH_ENV]?.trim().toLowerCase() !== 'off',
  });
  return defaultStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the four rates under the given field names; undefined unless input and output are finite, non-negative numbers. */
function ratesFrom(
  raw: unknown,
  fields: { input: string; output: string; cacheRead: string; cacheWrite: string },
): ModelRates | undefined {
  if (!isRecord(raw)) return undefined;
  const input = rate(raw[fields.input]);
  const output = rate(raw[fields.output]);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = rate(raw[fields.cacheRead]);
  const cacheWrite = rate(raw[fields.cacheWrite]);
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    ...(cacheRead !== undefined && { cacheReadInputTokenCost: cacheRead }),
    ...(cacheWrite !== undefined && { cacheCreationInputTokenCost: cacheWrite }),
  };
}

function rate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
