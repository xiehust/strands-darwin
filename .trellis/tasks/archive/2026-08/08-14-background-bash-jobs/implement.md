# Background bash jobs — implementation plan

1. Add a session-scoped background process manager and wrapped `bash` tool under `src/tools/`, with mode-aware schemas, collision-safe file-backed combined output, serialized task state/cursor tracking, in-flight launch tracking, and exact SDK delegation for foreground operations.
2. Implement POSIX process-group TERM→KILL stop, natural-leader-exit descendant cleanup, bounded manager shutdown, and process-exit last-resort cleanup.
3. Wire one manager/tool through `AgentRuntime.create()`, the initialized subagent catalogue, runtime shutdown, and session-derived log paths without changing the SDK loop.
4. Extend bash permission classification so `start` uses existing execution/rule behavior and lifecycle modes are statically safe. Verify tool-hook composition remains unchanged.
5. Add `spike/verify-background-bash.ts` covering prompt return after the spawn event, delayed combined output, status/exit metadata and stop precedence, bounded incremental UTF-8 output (including concurrent reads and malformed terminal bytes), unknown ids/deleted logs, concurrent idempotent stop, child-process-group cleanup, stubborn descendants after natural leader exit, collision-free logs under a resumed session id, foreground delegation, real-Agent hook/permission behavior, shared main/child manager behavior, shutdown racing an in-flight start, and runtime shutdown.
6. Add separate-process probes that load the SDK bash module, start a leader plus descendant, and cover direct exit, SIGINT, SIGTERM, normal shutdown, and CLI-style delayed forced exit; prove neither process survives. Add the focused suite to `pnpm test`.
7. Update README with the mode contract and operational limitations.
8. Run focused verification, existing permission/subagent suites, `pnpm typecheck`, and `pnpm test`; then run the model-calling `bashExit` TUI scenario with `AWS_REGION=us-west-2` because process-exit changes require its real PTY/model path.
9. Run Trellis quality review, update backend SDK/error-handling specs with measured contracts, review the final diff, commit using project conventions, push `main`, then archive the task in the repository's normal follow-up task commit if required.

## Validation commands

```bash
pnpm tsx spike/verify-background-bash.ts
pnpm tsx spike/verify-permission-modes.ts
pnpm tsx spike/verify-subagents.ts
pnpm typecheck
pnpm test
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts bashExit
```

The focused suite must use deadline-bounded process assertions. No test may wait indefinitely for a child exit.

## Risk and rollback points

- Preserve the SDK-vended tool for foreground `execute`/`restart`; do not reimplement its persistent-shell semantics.
- Register one wrapped tool instance so background task ids are shared across main and child agents, but forward the caller's `ToolContext` so foreground sessions remain per agent.
- Never derive a path from `taskId`; map lookup is the complete authority boundary.
- Signal negative PIDs only for processes this manager spawned with `detached: true`.
- Keep shutdown bounded and resource-isolated with `Promise.allSettled`; one stubborn process must not skip MCP, subagent, or persistent-shell cleanup, and an unconfirmed group must remain registered for process exit.
- Latch shutdown before awaiting launch setup, and await tracked starts before the stop snapshot; no start may spawn after shutdown has moved past it.
- Install process-global cleanup once and use the synchronous `exit` event with immediate group `SIGKILL`; do not rely on `beforeExit` or on SIGINT/SIGTERM listener order against the SDK.
- Do not persist process-control metadata for resume. Retained logs are diagnostic artifacts, not resumable jobs.
