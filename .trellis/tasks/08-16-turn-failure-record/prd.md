# Record a thrown turn's error in the trajectory

Backlog direction `SER-006` (origin report `docs/research/research_2026-08-16.md`, run `10:52:35Z`).

## Goal

When a turn's model stream throws, the session trajectory must say what happened: the error's class
and its message, on disk, readable without a model call. And a failed turn, a cancelled turn and a
clean turn must each be readable as themselves from the file alone.

## Background — measured, not assumed

- `stopReason` is assigned in exactly one place, `TurnRecording.tally()` (`src/trajectory/writer.ts`),
  from `agentResultEvent.result.stopReason`, and written into the record in `end()`. A thrown turn
  never produces `agentResultEvent`, so it closes with `stopReason: undefined`.
- `recordStream` (`src/trajectory/stream.ts`) closes the turn from a `finally`, so a failed turn does
  get a `turnEnded` record — one that says nothing about the failure.
- `TurnEndedRecord` and `TrajectoryRecordType` (`src/trajectory/record.ts`) had no failure field and
  no failure record type. So on disk a failed turn was indistinguishable from a cancelled one and
  from a clean turn whose stop reason was missing.
- The error text existed only as an ephemeral TUI notice (`runTurn` in `src/tui/App.tsx`) or a stderr
  line in headless (`src/cli.ts`).
- `Agent.stream()` stores a thrown error, fires `AfterInvocationEvent`, yields it, then rethrows the
  **identical object** — so the seam can observe the error without changing what the caller sees.
- Cancel does not throw to the consumer: `CancelledError` is converted into an `AgentResult` with
  `stopReason: 'cancelled'`, which reaches `tally()` on the ordinary path.

## Requirements

1. **The failure is recorded.** `turnEnded` gains an optional `failure: { name, message }`, both
   strings capped through the existing `capField` machinery so every truncation is written down in
   the same record's `trunc[]`.
2. **The three outcomes stay distinguishable from the file alone**: `failure` present → failed;
   `stopReason: 'cancelled'` → cancelled; any other `stopReason` string → clean; neither → the
   consumer stopped reading before a result (abandoned). One shared reading, `turnOutcome()`.
3. **The observer contract does not weaken.** The error reaches the caller of `AgentRuntime.send`
   unchanged (same object), recording stays synchronous with no I/O between receiving and yielding an
   event, and the recorder still cannot throw — including while recording a failure.
4. **`stopReason` is not invented.** A failed turn keeps `stopReason: undefined`; `'failed'` is not a
   stop reason any provider produced.
5. **The read paths report it.** `trajectory list` names the failed turns with class and a bounded
   message; `trajectory replay` reconstructs the exact live notice and prints class plus message;
   `search` matches the failure text. No `Agent`/`Model` import enters `src/trajectory/**`.
6. **No TUI change.** No frame row is added and the existing `turn failed:` notice is not duplicated;
   replay reconstructs it rather than emitting a second one.
7. **Backward compatible.** No `SCHEMA_VERSION` bump (readers already tolerate extra fields); an
   existing `v: 1` record without the field stays readable; existing bytes are never rewritten.

## Acceptance

- A turn whose stream throws leaves a record naming the error class and message; cancelled and clean
  turns remain distinguishable from it and from each other, read from the file alone.
- The thrown error still propagates out unchanged (same object, class and message).
- A recorder that fails while recording a failure still cannot fail the turn.
- `trajectory list` and `trajectory replay` report the failed turn; the `list` clause stays bounded
  even for a failure message sitting at the 8,000 code-point field cap.
- Earlier bytes are byte-identical after the failing turn is appended; a `v: 1` record without the
  new field still parses.
- `pnpm typecheck`, `pnpm test`, `pnpm tsx spike/verify-trajectory.ts`,
  `pnpm tsx spike/verify-tui.ts completion`, `git diff --check`, Trellis validation.
- A live end-to-end: a real headless run whose turn fails against a provider error, whose trajectory
  then names that error.

## Out of scope

- Per-turn token usage and duration (`SER-007`) — a separate direction that depends on this one.
- Changing the TUI notice text or adding any UI surface.
- Backlog status and the iteration log: the supervisor writes those after independent acceptance.
