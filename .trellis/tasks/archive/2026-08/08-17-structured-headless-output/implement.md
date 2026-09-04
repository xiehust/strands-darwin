# Implementation plan — structured headless output

1. Add strict `--output-format` parsing and default `text`; prove invalid combinations are pre-runtime.
2. Add a central versioned protocol module with typed records, safe projections, usage/failure helpers,
   bounds and JSON/JSONL writers.
3. Refactor headless orchestration into an injectable driver while preserving the literal text write
   path and process lifecycle. Wire structured permission and SDK diagnostic events.
4. Consume the same `AgentRuntime.send()` stream. Project only completed post-redaction assistant
   text and typed tool/lifecycle records; keep the terminal result complete.
5. Add subprocess/driver text snapshots plus scripted-runtime and real-SDK structured tests for all
   terminal stages, cancellation, privacy, bounds, escaping, usage and max-token recovery.
6. Update backend specs and README; leave Host-owned research/log files untouched.
7. Run focused suites, typecheck, full tests, build, diff/Trellis validation and exactly two low-token
   Bedrock smoke calls in disposable HOME/project state.
8. Inspect the full diff/status and commit using the repository convention.

## Validation commands

- `pnpm tsx spike/verify-headless.ts`
- `pnpm tsx spike/verify-headless-structured.ts`
- `pnpm tsx spike/verify-trajectory.ts`
- `pnpm tsx spike/verify-max-tokens-recovery.ts`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `git diff --check`
- `python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-17-structured-headless-output`
- two direct `src/cli.ts` Bedrock calls: one JSON, one stream-json
