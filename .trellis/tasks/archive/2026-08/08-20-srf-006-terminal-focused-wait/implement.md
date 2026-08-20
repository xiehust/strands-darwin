# Implementation plan

1. Extend `BackgroundBashManager.wait` with a defaulted output-wakeup option and a terminal-focused local accumulator that uses ordinary serialized cursor reads without retaining unbounded data.
2. Add the option to the provider-facing object schema, description, validation, and wrapper dispatch while preserving lifecycle/read classification.
3. Extend the focused real-process suite for default compatibility, terminal/timeout/cancel/shutdown aggregation, UTF-8 and shared-cursor competition, wrapper forwarding, and validation.
4. Run the focused suite while editing, then `pnpm typecheck`, then one complete `pnpm test` gate after source settles.
5. Update the authoritative SDK contract and process-exit architecture/index wording, validate artifacts, archive the task, and commit.
