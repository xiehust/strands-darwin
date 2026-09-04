# Implementation plan — SER-038 lifecycle observation hooks

1. Extend strict hook parsing and source aggregation for the two lifecycle keys; add config/layer tests.
2. Extract/reuse bounded detached process-group execution and implement the fire-and-observe lifecycle runner with cleanup tests.
3. Wire exactly-once permission publication at the queue's visible-current transition.
4. Wire final outcome publication into interactive and headless driver boundaries and lifecycle ownership into CLI `/clear`/cancel/shutdown paths.
5. Add offline integrated coverage for payloads, outcomes, no-output/no-trajectory behavior, and cleanup.
6. Update load-bearing docs/specs/user guide.
7. Run focused affected suites, then typecheck, then one final `pnpm test` and `pnpm build`; review and commit all authorized files.

## Verification record

Focused offline suites passed: lifecycle hooks (19), config (231), state layers (37), tool hooks (44), permission mode switch (100), subagents (69), trajectory (267), headless (80), structured headless (11), and `/clear` (44). Final `pnpm typecheck`, `pnpm test`, and `pnpm build` all exited 0; `git diff --check` is clean.
