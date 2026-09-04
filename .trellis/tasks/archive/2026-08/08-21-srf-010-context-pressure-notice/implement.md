# SRF-010 implementation plan

1. Evolve the existing `createContextWarnLatch` only: retain the configured threshold and state machine, but strengthen its one-line recommendation for the next broad implementation or verification turn.
2. Expand `verify-context-format.ts` with exact threshold, disabled, unknown/invalid, re-arm and wording bounds; route emitted notices through `turnReducer` to prove exactly one Static-history row and no live-frame state.
3. Update the backend context-counting contract, frontend transcript/live-frame contract, architecture rationale/index, and task records without touching the Host-owned backlog.
4. Run the focused context suite while editing, then typecheck. Once source settles, run one complete `pnpm test` plus focused affected offline suites, build, Trellis validation, and diff/status checks.
5. Mark and archive the task, stage all intended paths explicitly excluding `docs/research/backlog_index.md`, commit, and confirm the backlog remains dirty and unstaged.
