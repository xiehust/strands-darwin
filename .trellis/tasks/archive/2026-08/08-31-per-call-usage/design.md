# Design — per-model-call usage observability

## Data sources (all already in the observed stream; no new channel)

- `afterModelCallEvent`: `stopData.message.metadata.usage` (per-call provider
  counters), `stopData.message.content` (toolUse block count per response),
  `stopData.stopReason`, `attemptCount` (retries visible).
- `beforeModelCallEvent`: `projectedInputTokens?` (context size estimate).
- Parent-only by construction: child streams are private to their dispatch;
  every surface says "parent" scope implicitly (children are already covered
  by the childUsage aggregation shipped in 9e39de5).

## A. `modelCall` trajectory record

New additive record type written by `TurnRecording` when it observes a
completed `afterModelCallEvent` (stopData present):

```
{ turn, type: 'modelCall', attempt, ms, stopReason?, contextTokens?, spend? }
```

- `spend`: the call's own counters in the same `TurnSpend` bucket vocabulary
  as `turnEnded.spend` (provider/model attribution included). Projection needs
  the live config, which `src/trajectory/**` must not import — so
  `AgentRuntime.send` injects a per-call projector beside the existing
  `startTurnSpend` meter (same injection pattern, same file). Absent when the
  provider reported no usage — never zeros.
- `contextTokens`: last `beforeModelCallEvent.projectedInputTokens` seen this
  turn; absent when unreported.
- `ms`: since turn start — lets a reader line calls up against tool records.
- Failed attempts (no stopData) are not recorded; they stay visible via
  `attemptCount` gaps and `turnEnded.failure`.
- Observer rules unchanged: synchronous, capped envelope, degrade open, rides
  the existing buffered turn append; replay (`formatReplay`) prints a bounded
  one-line projection; schema bump per session-trajectory spec rules.

## B. Session efficiency stats — `src/agent/call-stats.ts`

`SessionCallStats` (runtime-owned, session-scoped, `/clear` inherits nothing):
updated synchronously from the same event observation point in
`AgentRuntime.send` (`recordStream`'s pass-through loop):

- `calls` — completed model calls
- raw `Usage` sum over calls (for avg request input per call, derived at
  render through the existing bucket helpers; unknown stays unknown)
- response tool-shape tallies: `noTool` / `singleTool` / `multiTool` (toolUse
  blocks in the completed message)
- bounded recent window (last 10 completed calls' toolUse counts) for the
  advisory

Surfaces (render-time projections, absent-never-0):
- `/usage` report: new `efficiency` section — model calls, avg input/call,
  single-/multi-/no-tool response counts. Works mid-turn like the rest of the
  report (counters move per completed call).
- `/status`: one bounded line from the same renderer.
- Headless: text mode one `model-calls:` stderr line beside `usage:`;
  structured terminal record gains additive optional `callStats` field.
  Emitted only when ≥1 call was observed (same additive convention as
  `usage-children:`).

## C. Repeated-long-context advisory — `src/tui/spend-advisory.ts`

Pure decision function + App-owned latch, on the context-pressure precedent
(advise, never act; post-turn only; `<Static>` notice; silent when unknown):

- Fires when cumulative `cacheReadInputTokens` (parent meter) crosses each
  successive multiple of `cacheReadWarnTokens` (config, default 4_000_000;
  0/absent disables) AND the recent window shows a single-tool-dominated
  pattern (≥8 of last 10 completed calls had ≤1 toolUse).
- One bounded notice naming both facts and recommending batching + parallel
  reads (and `/compact` when the context estimate is known-high).
- Latch per multiple (cacheRead is monotonic, so "re-arm on drop" cannot
  apply); `/clear` resets naturally with the successor runtime; TUI only —
  a headless run reads the same story from `callStats`/trajectory.

## Tests (free)

- `verify-trajectory.ts`: modelCall record shape, spend projection, absence
  rules, replay projection, schema-version behavior.
- new `verify-call-stats.ts` (or extend `verify-usage.ts`): tally math,
  tool-shape counting, unknown metrics, window behavior.
- `verify-usage.ts`/`verify-status-command.ts`: report sections with and
  without stats (byte-identity with none).
- `verify-headless.ts`/`verify-headless-structured.ts`: `model-calls:` line
  and `callStats` field, additive-only.
- advisory: threshold multiples, pattern gate, latch, disable via config.

## Spec updates (finish phase)

- `backend/session-trajectory.md`: `modelCall` record type + caps.
- `backend/structured-headless-output.md`: `callStats` terminal field.
- `docs/architecture/load-bearing-decisions.md` + AGENTS.md index row if the
  trajectory row's wording needs the new record named.
