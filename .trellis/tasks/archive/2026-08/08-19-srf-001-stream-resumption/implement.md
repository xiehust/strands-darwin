# Implementation plan

1. Add pure stream-resumption classification/prompt/orchestration with deterministic unit coverage using a real SDK `Agent` and scripted model.
2. Route TUI `runTurn` through the orchestration helper while preserving one busy interval and SER-027 failure/cancel ownership.
3. Route text and structured headless turns through the helper; add explicit continuation protocol records and privacy tests for text, JSON, and stream JSON.
4. Update backend/frontend executable specs, architecture rationale, AGENTS.md invariant/check index, and task artifacts.
5. Run the focused new suite while editing, then typecheck. After source settles run `pnpm test` once, Trellis validation, and `git diff --check`; archive the accepted-ready task and commit without changing SRF-001 from `in-progress`.
