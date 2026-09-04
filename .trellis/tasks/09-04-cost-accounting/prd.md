# Cost accounting priced from the LiteLLM price table

## Goal

Show what a session has cost in USD, priced from LiteLLM's public
`model_prices_and_context_window.json`, on the existing spend surfaces (`/status`,
`/usage`, the headless stderr records) — as an approximate, base-rate projection over
the token buckets darwin already reports, never a new information channel.

## Requirements (decided by the user, 2026-09-04)

### Price source and local cache

- Source: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`.
  Fields used: `input_cost_per_token`, `output_cost_per_token`,
  `cache_read_input_token_cost`, `cache_creation_input_token_cost`. Tiered
  (`*_above_200k_tokens`) and `*_above_1hr` rates are ignored.
- Local cache `~/.darwin/model-prices.json`, path derived through `src/paths.ts`
  (`userDarwinDir()`), never `process.cwd()` or a hard-coded home. Stores only the
  resolved mapping darwin model id → `{ litellmKey, inputCostPerToken,
  outputCostPerToken, cacheReadInputTokenCost?, cacheCreationInputTokenCost?, fetchedAt }`
  plus top-level `source` and schema `version`. Never the whole LiteLLM file.
  Atomic write (temp + rename); a missing or damaged file reads as empty, never a crash.
- If the cache file has a mapping for the current model id, no fetch happens. Only a
  missing id triggers one fetch per process for that id. `/model` to a new id follows
  the same rule (lookup → fetch once if absent → record).
- Key resolution order: exact darwin id; then provider-specific — bedrock →
  `bedrock/<id>`; openai over Bedrock Mantle → `bedrock_mantle/<id>`; anthropic →
  `anthropic/<id>`; direct openai → `openai/<id>`. The resolved `litellmKey` is
  recorded. An id with no key records `litellmKey: null` with `fetchedAt` (so it is not
  refetched every launch); a later `/model` to a different id still fetches.
- Fetch starts in the background at runtime startup, never awaited by startup or the
  first turn; ~10 s timeout, bounded response size; every failure degrades silently to
  "price unavailable" — never a startup refusal, a thrown error into the Ink frame or a
  `console.warn`. No new npm dependency (global `fetch`). Children never fetch.

### Cost math

- One module with no `Agent`/`Model` import, over `usageBuckets`: cost = Σ bucket ×
  rate. An `undefined` bucket is unknown, never 0: the total reads as a partial
  (`≥ $x.xxxx (… not reported)`), never a fake exact number. No price → `unknown (no
  price for <model>)`; not fetched yet → `unknown (price unavailable)`.
- Always labelled approximate: `≈ $0.0123 (base rates, LiteLLM)`; USD, 4 decimals;
  every rendered line bounded.

### Surfaces (additive only)

- `/status`: one `cost` row directly beside `tokens`; with `childUsage` also
  `cost (subagents, N dispatches)` and `cost (session total)` in the style of the
  existing usage lines. Zero-call report otherwise byte-identical. `/status` stays
  byte-zero mutation: no fetch, no write — facts come from one new read-only runtime
  accessor.
- `/usage`: the same `cost` line.
- Headless text mode: a new stderr line
  `cost: total=<usd|-> input=<usd|-> output=<usd|-> cacheRead=<usd|-> cacheWrite=<usd|-> model=<id> pricing=<litellmKey|unavailable|none>`
  after `usage:` (and after `usage-children:`/`usage-total:` when present). `usage:`
  and `session:` stay byte-identical; `-` means unknown, never 0.
- Out of scope: `trajectory list/replay` spend totals, the busy-row suffix, config
  fields, the header row, any new slash command, `MAX_COMPLETIONS`, the structured
  (`json`/`stream-json`) headless protocol.

### Docs and specs

- `.trellis/spec/backend/strands-sdk-contracts.md` gains the contract;
  `docs/user-guide/reference.md`, `sessions-and-state.md` and their `zh-CN` twins;
  README if it lists the surfaces; `docs/architecture/load-bearing-decisions.md` a short
  rationale heading. `AGENTS.md` stays under 32 KiB.

## Acceptance Criteria — requirement-to-test checklist

Every row is a free check (no model call, no network) wired into `pnpm test`.

| # | Requirement | Proving check |
| --- | --- | --- |
| 1 | Missing cache file → empty mapping | `verify-model-prices.ts` "missing file reads as empty" |
| 2 | Damaged JSON / wrong version / malformed entries → empty, no throw | `verify-model-prices.ts` "damaged cache" |
| 3 | Existing mapping for the current id → no fetch | `verify-model-prices.ts` fetch stub that fails the suite if called |
| 4 | Missing id → exactly one fetch; mapping written atomically with `litellmKey`, `fetchedAt`, `source`, `version` | `verify-model-prices.ts` "first lookup fetches once"; no `*.tmp` left behind |
| 5 | Unresolvable id → `litellmKey: null` recorded, not refetched next process | `verify-model-prices.ts` "no-price entry" |
| 6 | Key resolution order per provider (bedrock exact→`bedrock/`, mantle `bedrock_mantle/`, anthropic `anthropic/`, openai `openai/`) | `verify-model-prices.ts` "candidate keys" + resolution over a fixture table |
| 7 | Timeout / non-200 / bad JSON / over-cap → unavailable, no throw, no write | `verify-model-prices.ts` "fetch failures degrade" |
| 8 | Concurrent `ensure()` for one id shares one fetch; `/model` to another id fetches again | `verify-model-prices.ts` "one fetch per id per process" |
| 9 | All four buckets known → exact sum | `verify-cost.ts` |
| 10 | A bucket `undefined` → partial `≥`, never 0 | `verify-cost.ts` |
| 11 | No price / unavailable → `unknown (…)` wording | `verify-cost.ts` |
| 12 | Rendering bounded and labelled approximate, 4-decimal USD | `verify-cost.ts` |
| 13 | `/status` cost row beside tokens; child cost lines additive; rest byte-identical | `verify-status-command.ts` |
| 14 | `/status`/`/usage` never fetch or write | `verify-model-prices.ts` (`lookup()` with a failing fetch stub, file mtime unchanged) + formatter purity (no I/O import) |
| 15 | `/usage` cost line | `verify-usage.ts` |
| 16 | Headless `cost:` line format; `usage:` byte-identical | `verify-headless.ts`, `verify-headless-structured.ts` |
| 17 | Runtime accessor + startup fetch wiring typechecks; `/status` handler passes the accessor | `pnpm typecheck` |
| 18 | Command surface untouched | `spike/verify-tui.ts completion` (free) |

## Notes

- Pricing uses the *live* model's rates over the per-process meter; a session that
  switched models mid-run is priced at the current model's rates — one more reason the
  figure is labelled approximate.
- Decision made during implementation: `DARWIN_MODEL_PRICES_FETCH=off` (environment, not a
  config field) makes the store cache-only. Needed because every free suite that builds a
  real `AgentRuntime` runs under a private HOME with no cache and would otherwise start the
  download (and keep the event loop alive up to the 10 s timeout); `spike/run-tests.ts` and
  `spike/verify-tui.ts` set it. Also a legitimate air-gapped opt-out.
- Structured (`json`/`stream-json`) headless output gains no `cost` field (out of scope);
  noted in `structured-headless-output.md` for a later additive step.
- No AGENTS.md index row: the file is at 32,723 of 32,768 bytes; the rationale lives in
  `docs/architecture/load-bearing-decisions.md` § Cost accounting instead.
