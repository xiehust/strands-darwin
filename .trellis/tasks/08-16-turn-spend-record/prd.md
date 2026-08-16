# Record per-turn token spend in the trajectory

Backlog direction `SER-007` (origin report `docs/research/research_2026-08-16.md`, run `10:52:35Z`),
built on `SER-006` (`1f2c147`), which established how a failed turn closes.

## Goal

A session's token spend must be auditable from its trajectory record, **per turn**, after the process
is gone — with no model call and no network on the read paths, and with an unreported provider metric
staying unknown rather than becoming a zero.

## Background — measured, not assumed

- **Turn-scoped spend is absent from the record; per-call spend is not.** `AgentResult.toJSON()`
  deliberately drops `metrics` (and `traces`) — its own comment says "to avoid sending large payloads
  over the wire" — so the recorded `agentResultEvent` carries `type`/`stopReason`/`lastMessage` only.
  But `Message.toJSON()` keeps `metadata`, so a real recorded file *does* contain
  `result.lastMessage.metadata.usage` — the usage of the **final model call** of the turn. What no
  file could answer before this change: what a *turn* cost, what a **failed or cancelled** turn cost
  (neither emits `agentResultEvent`), and what a multi-cycle turn's earlier calls cost (the events
  carrying them are dropped by the allowlist). The origin report's "no token counts reach disk" is
  therefore imprecise, and the precise statement now lives in the spec.
- `AgentRuntime.usage` reads `agent.metrics.accumulatedUsage`, a **lifetime** accumulator whose two
  cache counters stay `undefined` until a provider reports them (`createEmptyUsage` /
  `accumulateUsage` in the SDK). It is process-scoped by documented design: a resumed session's
  meter starts at zero, so `/usage` and the headless `usage:` line evaporate on exit.
- The meter is updated inside `Agent._invokeModel` immediately after each model call returns, and
  never for a call that threw — so it is final by the time a turn's stream ends, and a rejected call
  contributes nothing.
- **The ordering crux**: `recordStream`'s `finally` runs `TurnRecording.end()`, which formats and
  buffers `turnEnded`, **before** `AgentRuntime.send`'s `finally` computes `lastTurnDelta`. A spend
  number produced in `send` after the stream is therefore too late for the record.
- Summarization (`/compact` and overflow reduction) calls `model.streamAggregated` **directly**,
  bypassing `Agent._invokeModel`, so its tokens never enter `agent.metrics` at all. A pre-existing
  blind spot of the meter, out of scope here, and the reason `spend` means "what the SDK meter
  attributed to this turn", not "what the provider billed".
- `/model` is gated *behind* the TUI's busy check, so a model switch cannot land mid-turn: one turn
  is one model, exactly.

## Requirements

1. **Every turn's record carries the spend that turn incurred**, as the provider reported it:
   additive optional `turnEnded.spend`, in the mutually exclusive buckets `src/agent/usage.ts`
   defines (`usageBuckets` over `deltaUsage`), which is the same projection the headless `usage:`
   line already prints.
2. **Unknown stays unknown.** An unreported metric is a **missing key**, never `0`; a reported zero
   stays present as `0`, because "the provider did not report this" and "this was zero" are different
   facts. Absent `spend` (pre-`SER-007` record, recording off, unreadable meter) reads as *unknown*
   on every report.
3. **The observer contract does not weaken.** The spend is produced by a `TurnSpendMeter` injected
   into `beginTurn` and read synchronously in `end()`. Reading it cannot throw into the stream, cannot
   latch recording off, and cannot become a second reason a turn dies; the thrown error of a failed
   turn still reaches the caller of `AgentRuntime.send` as the identical object. No record write may
   ever be put on `send`'s error path.
4. **A failed turn records its spend too** — the tokens were billed whether or not the turn finished —
   alongside the `failure` field `SER-006` established, on the same line.
5. **Spend is attributable**: `provider` and `model` sit on the same line as the numbers. A report
   never presents one total that silently mixes two models' rates.
6. **The read paths report it**, staying free of any model call, network, or `Agent`/`Model` import
   inside `src/trajectory/**`: `trajectory list` states a session's totals in one bounded segment,
   `trajectory replay` shows per-turn spend plus the aggregate, with a per-model breakdown when the
   file holds more than one model.
7. **Out of scope, decided**: `/usage` stays process-scoped and must not read the record; no
   `src/tui/**` change; no model-latency field (see requirement 9).
8. **Backward compatible**: no `SCHEMA_VERSION` bump, existing bytes never rewritten, a `v: 1` file
   written before this change still parses, replays, and is reported as *unknown* rather than as a
   zero-cost session.
9. **Duration is not re-added.** `turnEnded.ms` already records how long a turn took, so the backlog
   row's "and duration" is satisfied by an existing field. Model latency
   (`accumulatedMetrics.latencyMs`) is deliberately omitted: a recorded `0` would mean both "no model
   call completed" and "the provider reported no latency", which is exactly the ambiguity this
   direction exists to remove.

## Acceptance

- Two real headless turns in one session: each turn's recorded spend is present and reconciles with
  the process totals on the `usage:` stderr line — per metric, exactly, per process — and a metric
  printed `-` on stderr is exactly a metric whose key is absent from the record.
- A failed turn (invalid `AWS_BEARER_TOKEN_BEDROCK` → real `ModelError` / `AccessDeniedException`)
  records its spend beside its `failure`.
- An unreported metric reads as unknown end to end, from record to report; a reported `0` stays `0`.
- A meter that throws leaves the turn intact, the record's other fields intact, and recording active.
- `trajectory list` and `replay` report spend, bounded, exit 0, with credentials removed.
- A pre-`SER-007` `v: 1` file parses, replays and is reported without a fabricated zero.
- Earlier bytes byte-identical after a later turn appends.
- `pnpm typecheck`, `pnpm test`, `pnpm tsx spike/verify-trajectory.ts`,
  `pnpm tsx spike/verify-tui.ts completion`, `git diff --check`, Trellis validation.
