# Implement — cost accounting

1. `src/paths.ts` — `userModelPricesFile()`.
2. `src/agent/cost.ts` — types, `estimateCost`, `formatUsd`, `describeCost`, `formatHeadlessCost` helpers.
3. `src/pricing/model-prices.ts` — cache read/write, candidate keys, resolution, bounded fetch, `ModelPriceStore`, `defaultModelPriceStore()`.
4. `spike/verify-cost.ts`, `spike/verify-model-prices.ts` — free suites; add to `spike/run-tests.ts`.
5. `src/agent/runtime.ts` — store field, `ensure` on create/changeModel, `modelPrice` accessor.
6. `src/tui/status-format.ts` — `StatusFacts.modelPrice`, cost row, child cost lines; `src/tui/App.tsx` — `/status` fact, `/usage` line.
7. `src/headless.ts` + `src/headless-runner.ts` — `cost:` record in text mode; fixture `modelPrice`.
8. Update `spike/verify-status-command.ts`, `spike/verify-usage.ts`, `spike/verify-headless.ts`, `spike/verify-headless-structured.ts`.
9. Docs: spec, user guide (+zh-CN), README if applicable, load-bearing decisions.
10. Gate: `pnpm typecheck`, `pnpm test`, `pnpm tsx spike/verify-tui.ts completion`; commit; `pnpm build`.

Rollback: every change is additive; reverting the commit restores byte-identical surfaces.
