# Design — cost accounting

## Boundaries

```
src/pricing/model-prices.ts   price cache + LiteLLM fetch (the only I/O, the only network)
src/agent/cost.ts             pure cost math + rendering over UsageBuckets (no I/O, no SDK)
src/agent/runtime.ts          one store per process; startup/`/model` kick `ensure()`; `modelPrice` accessor
src/tui/status-format.ts      `cost` row + child cost lines (StatusFacts.modelPrice)
src/tui/App.tsx               `/usage` cost line; `/status` passes `runtime.modelPrice`
src/headless.ts               `formatHeadlessCost`; runner writes it in text mode
src/paths.ts                  `userModelPricesFile()`
```

## Contracts

### `ModelPriceLookup` (cost.ts)

```ts
type ModelPriceLookup =
  | { kind: 'priced'; litellmKey: string; rates: ModelRates }
  | { kind: 'none' }          // resolved: LiteLLM has no key → recorded litellmKey: null
  | { kind: 'unavailable' };  // not fetched yet / fetch failed
```

`estimateCost(buckets, rates)` returns `{ input?, output?, cacheRead?, cacheWrite?, total, missing[] }`
— a bucket that is `undefined` or has no rate while its count is > 0 lands in `missing`
and is excluded from `total`, so `missing.length > 0` means the total is a floor.
`describeCost(lookup, usage, config)` renders one bounded line:
`≈ $0.0123 (base rates, LiteLLM)` / `≥ $0.0123 (cacheWrite not reported; base rates, LiteLLM)` /
`unknown (no price for <model>)` / `unknown (price unavailable)`.

### Cache file (`~/.darwin/model-prices.json`, version 1)

```json
{ "version": 1, "source": "<url>", "models": { "<darwin id>": { "litellmKey": "bedrock/...", "inputCostPerToken": 3e-6, "outputCostPerToken": 1.5e-5, "cacheReadInputTokenCost": 3e-7, "cacheCreationInputTokenCost": 3.75e-6, "fetchedAt": "2026-09-04T00:00:00.000Z" } } }
```

Read: missing → empty; unparsable / wrong version / non-object → empty; each malformed
entry skipped. Write: `mkdir -p`, `<file>.<pid>.<rand>.tmp` + `rename`; the entry is
merged into a fresh re-read so two processes cannot erase each other's ids.

### `ModelPriceStore`

- `lookup(config)` — synchronous read-only projection; no fetch, no write. `/status`,
  `/usage`, headless read through this.
- `ensure(config)` — read; if the id is mapped return; else fetch once per id per
  process (a `Map<id, Promise>` dedupes concurrent callers, a failed attempt is
  remembered so the process never retries that id); on success resolve keys and merge +
  write; resolve to nothing → write `litellmKey: null`. Never throws (`.catch` inside).
- Fetch: global `fetch` injectable; `AbortController` 10 s timeout (unref'd timer);
  streamed body capped at 8 MiB; non-200 / over-cap / invalid JSON / non-object → `undefined`.
- Candidate keys per provider: `[id, 'bedrock/'+id]`, `[id, 'bedrock_mantle/'+id]`,
  `[id, 'anthropic/'+id]`, `[id, 'openai/'+id]`; first key whose entry has numeric
  `input_cost_per_token` and `output_cost_per_token` wins.

### Runtime

Module-level singleton `defaultModelPriceStore()` so `/clear` successors share the
per-process fetch dedupe; `create()` and `changeModel()` call `void store.ensure(config)`
after the model is built (fire-and-forget). `get modelPrice(): ModelPriceLookup` returns
`store.lookup(this.liveConfig)`. Children never touch the store.

### Headless

`cost: total=<usd|-> input=<usd|-> output=<usd|-> cacheRead=<usd|-> cacheWrite=<usd|-> model=<id> pricing=<key|unavailable|none>`
over the parent meter (`usage:`'s buckets). `total=-` whenever any bucket is missing.
Written in text mode after the usage records and before `model-calls:`. Structured modes
unchanged (out of scope).

## Tradeoffs

- Rates follow the live model over a cumulative meter: a mid-session `/model` mixes
  price lists. Accepted and stated ("approximate"); per-call attribution lives in the
  trajectory and is out of scope.
- Headless `total=-` on a partial sum rather than a `>=` grammar keeps `<usd|->` parsable.
