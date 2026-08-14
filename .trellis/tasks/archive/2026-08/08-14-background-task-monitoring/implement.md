# Background task monitoring — implementation plan

1. Extend `BackgroundBashManager` with deterministic `list()` snapshots and exactly-once terminal subscriptions; extend the wrapped `bash` schema/callback/description/output type with safe `list` mode.
2. Expose narrow listing/subscription methods from `AgentRuntime` and classify `bash list` as a safe read without changing hooks or the shared main/subagent manager.
3. Add shared task formatting helpers, reserve `/tasks`, handle it before the busy-turn guard, and subscribe the mounted TUI to terminal events as dim transcript notices.
4. Extend focused background-bash tests for listing, input validation, permissions, terminal event cardinality, failure metadata, unsubscribe, and listener isolation; add formatter tests and completion coverage.
5. Add a real-pty task-monitor scenario proving completion is visible while idle, `/tasks` works during a streaming turn, and neither path interrupts the turn. Keep assertions anchored and exits deadline-bounded.
6. Update README with the agent/TUI contracts and current-runtime limitation.
7. Run focused suites, `pnpm typecheck`, `pnpm test`, and relevant PTY scenarios. Because the manager/process lifecycle changes, also run the existing background exit probe and `bashExit` regression when model access is available.
8. Run Trellis quality review, update backend/frontend specs with the measured contracts, review the diff, commit with the project convention, push the current branch, and archive/finish the task as required by the workflow.

## Validation commands

```bash
pnpm tsx spike/verify-background-bash.ts
pnpm tsx spike/verify-tui.ts completion
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts tasks
pnpm tsx spike/probe-background-bash-exit.ts
pnpm typecheck
pnpm test
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts bashExit
```

The focused test file may be split if formatter/TUI setup is clearer elsewhere, but new fast tests must remain in `pnpm test`.

## Risk and rollback points

- Keep one terminal transition/publication path. Do not independently poll in the TUI or notify from both child `close` and `stop`, which would duplicate or race notices.
- Preserve per-task serialization and process-group cleanup. A UI listener must be observer-only and unable to delay or fail cleanup.
- Handle `/tasks` before the busy guard but never call `turnEnded`, `cancel`, `send`, or model reconfiguration.
- Keep command summaries bounded only at presentation time; agent-side list results retain full commands.
- Unsubscribe on TUI unmount so shutdown-generated `stopped` transitions cannot write into a dead renderer.
- Do not persist the registry or infer live control from retained logs.
