# SER-033 implementation plan

1. Extend strict session config with the single 28-day generated-memory horizon and focused validation/model-switch tests.
2. Version the memory state and add bounded source-anchor plus validation metadata schemas and compatible v1 migration.
3. Add deterministic anchor derivation and centralized current-worktree validation/eligibility with injectable clock.
4. Route startup and `/memory` list/show/mutation prompt refresh through the same eligible index; update bounded reporting.
5. Add offline safety, aging, reactivation, lifecycle, and byte-zero fixtures.
6. Update contracts, architecture index, README, and AGENTS; run focused checks, typecheck, full tests, build, Trellis validation, then scoped commit/archive/journal.
