# Implementation plan

1. Add the installed SDK `httpRequest` singleton to the parent runtime tools list.
2. Add one focused offline regression for registration, default-mode gate denial, and plan-mode pre-prompt denial; register it in the fast test runner.
3. Run the focused test, then `pnpm typecheck` while editing.
4. Update the SDK contract/load-bearing index with the settled invariant.
5. Run Trellis review and the complete gate (`pnpm test`, `pnpm typecheck`, `pnpm build`) once after source settles.
6. Record check results, finish/archive the task if required, commit, and verify diff/status/hash without rerunning the suite.
