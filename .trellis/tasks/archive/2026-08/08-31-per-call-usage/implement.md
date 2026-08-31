# Implementation plan

1. **call-stats core** — `src/agent/call-stats.ts` (SessionCallStats, pure
   update from afterModelCallEvent data, recent window); free suite.
2. **runtime wiring** — observe events in `AgentRuntime.send` beside
   `recordStream`; expose `runtime.callStats` accessor; per-call spend
   projector injected into `beginTurn` alongside `startTurnSpend`.
3. **modelCall record** — `TurnRecording` buffers it on afterModelCallEvent;
   replay projection; schema/caps; extend `verify-trajectory.ts`.
4. **TUI surfaces** — `/usage` efficiency section, `/status` line; extend
   `verify-usage.ts` + `verify-status-command.ts` (byte-identity with no
   calls).
5. **headless surfaces** — `model-calls:` line + structured `callStats`;
   extend `verify-headless.ts` + `verify-headless-structured.ts`.
6. **advisory** — `src/tui/spend-advisory.ts` + App latch + `cacheReadWarnTokens`
   config key (default 4M, 0 disables); free suite; `verify-config.ts` if the
   config surface grows.
7. **gate** — `pnpm typecheck`, `pnpm test`.
8. **specs/docs + build** — session-trajectory & structured-headless-output
   specs, load-bearing doc/AGENTS.md wording, commit, `pnpm build`.
