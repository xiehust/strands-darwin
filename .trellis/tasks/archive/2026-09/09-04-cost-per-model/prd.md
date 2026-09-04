# Cost accounting per model: offline trajectory pricing, live per-model shares, skill capture

Second iteration over `09-04-cost-accounting` (commit 31ed30c). Decided by the user, 2026-09-04.

## Goal

Price every model's spend at *that model's* rates — in the offline `trajectory list`/`replay`
readers and in the live `/status`/`/usage`/headless `cost:` surfaces — and let the supervisor
skills capture the headless `cost:` record beside `usage:`.

## Requirements

### A. `trajectory list` / `trajectory replay` (offline, exact per model)

- `src/trajectory/spend.ts` prices each `ModelSpend` at its own rates read from
  `~/.darwin/model-prices.json` — **read only**: the CLI readers never fetch, never write,
  never call a model. `list` shows one bounded `cost:` clause; `replay` adds `session cost:`
  and a per-model cost beside the existing per-model token rows.
- Honesty rules unchanged: a model with no cache entry (or `litellmKey: null`) is *unpriced* —
  the total is a `≥` floor naming the unpriced model(s) (bounded), never 0, never dropped;
  an unreported bucket is unknown; a bucket only some turns reported is `partly reported`;
  turns with no spend make the total a floor (`N turn(s) unknown`); every figure is labelled
  `base rates, LiteLLM` — the same vocabulary as `describeCost`.
- `spend.ts` keeps its rule: nothing from `src/agent/**`. The pure arithmetic moves to
  `src/pricing/cost.ts`; `src/agent/cost.ts` re-exports it and keeps the config-aware
  wrappers. One implementation.
- Lookup key is the darwin model id — `TurnSpend.model`, carried on `ModelSpend` as its own
  field (`label` is never split).
- `/export` stays a pure record projection (no price-cache dependency): pricing is a
  `replayRead` option only the CLI passes. Decision recorded here.

### B. Live `/status` / `/usage` / headless `cost:` — per model

- The runtime tallies each completed turn's meter delta under the config in effect for that
  turn (the same `before` snapshot and config the trajectory meter uses); whatever the meter
  holds beyond the tally (the turn in flight) is the live model's. `runtime.modelShares`
  exposes `{ config, usage, lookup }` per model — a sync read of the price cache, no fetch,
  no write, no pointer move.
- Single-model session: every report is byte-identical to the previous iteration's
  expectations. Multi-model: `≈ $x (2 models; base rates, LiteLLM)`; a model with no
  price makes it `≥ $x (2 models; no price for <id>; …)`; `/usage` adds one line per model
  under the cost line only when more than one model contributed.
- Children keep pricing at the live model's config; the session total folds child usage into
  the live model's share.
- Headless `cost:` unchanged for one model; with several: `model=<n>-models pricing=mixed`,
  bucket fields `-` wherever any share leaves them unknown (the `<usd|->` grammar is kept,
  and every value stays `\S+`). `usage:` byte-identical.

### C. Supervisor skills capture `cost:`

- `developer` and `self-reflection` skills capture
  `^cost: total=(\d+\.\d+|-) input=(\d+\.\d+|-) output=(\d+\.\d+|-) cacheRead=(\d+\.\d+|-) cacheWrite=(\d+\.\d+|-) model=(\S+) pricing=(\S+)$`
  per child task and report USD per task plus an aggregate (`-` unknown, never summed as 0;
  a task with no line stated). Short additions; `pnpm build` after commit.

### Out of scope

Structured `json`/`stream-json` `cost` field; busy-row cost; new config fields; new slash
commands (`MAX_COMPLETIONS` untouched); README; AGENTS.md (45 bytes under its cap).

## Requirement-to-test checklist (all free)

| # | Requirement | Proving check |
|---|---|---|
| 1 | `list` cost clause: priced single model; two priced; one unpriced (floor + name); no cache file (unknown, not 0); unreported bucket | `verify-trajectory-cost.ts` |
| 2 | `replay` session cost + per-model breakdown, same cases; `/export` body unchanged (no prices) | `verify-trajectory-cost.ts`, `verify-export-command.ts` |
| 3 | Readers never fetch/write: cache mtime unchanged, HOME isolated, `fetch` stub throws | `verify-trajectory-cost.ts` |
| 4 | `/status`, `/usage` after an offline `changeModel` price each model at its own rates; single-model byte-identical | `verify-model-shares.ts` (runtime), `verify-status-command.ts`, `verify-usage.ts` |
| 5 | Headless `cost:` single-model unchanged; multi-model rendering asserted | `verify-headless*.ts`, `verify-cost.ts` |
| 6 | Skill text: cost regex present in both skills; suites pinning skill text pass | `rg`, `verify-self-reflection.ts`, `verify-skills.ts` |
| 7 | Pure aggregation rules (`sessionCost`/`describeSessionCost`/`sessionCostFields`) | `verify-cost.ts` |
| 8 | Wiring | `pnpm typecheck` |
| 9 | Full gate | `pnpm test` |

## Notes

- `spend.ts` imports `src/pricing/model-prices.ts` (sync cache reader) and `src/pricing/cost.ts`;
  neither imports `src/agent/**` at runtime.
- No command surface touched → `verify-tui.ts completion` not required.
- Decisions made while implementing: `/export` passes no prices (transcript = record alone);
  a `/model` switch that has run no turn adds no share (a zero remainder is not a second model);
  `TrajectoryIo.pricesFile` is a test seam defaulting to `userModelPricesFile()`; the trajectory
  side gained a third bucket reason, `partly reported`, for metrics only some turns reported.
- Checklist status at commit: rows 1–9 all proven (see report); `pnpm test` exit 0.
