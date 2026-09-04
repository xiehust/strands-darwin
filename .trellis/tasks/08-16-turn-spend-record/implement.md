# Implementation plan — per-turn spend in the record

## Ordering, and the mechanism chosen

`recordStream`'s `finally` calls `TurnRecording.end()`, which formats and buffers the `turnEnded`
record; only then does `AgentRuntime.send`'s `finally` run. So the spend has to be readable *at*
`end()`.

**Chosen**: a `TurnSpendMeter` (`{ read(): TurnSpend | undefined }`) created in `send` before the
stream starts and injected into `beginTurn`. `end()` calls `read()` synchronously, inside its own
guard, so a meter that throws yields *unknown* instead of latching recording off.

**Rejected**: appending a spend record from `send` after the stream.

1. It would put a record write on `send`'s **error path**, where the provider's exception is in
   flight — a throw there would replace the caller's error object and break `SER-006`'s
   identical-object rethrow.
2. It would need a second append per turn; a process killed between the two would leave a turn whose
   closing line exists and whose spend line does not, with `seq` still contiguous — an invisible hole
   in a record whose promise is that a gap means real loss.
3. It would split one fact across two lines keyed on the turn ordinal — and ordinals restart at 1 per
   process (the pre-existing finding recorded on the `SER-006` row), so that join is ambiguous for any
   multi-run session.

## Files

| File | Change |
|---|---|
| `src/trajectory/record.ts` | `TurnSpend` + `TurnSpendMeter`, optional `spend` on `TurnEndedRecord`, `turnSpendOf()` (defensive: a non-number reads as unknown, never 0) |
| `src/trajectory/spend.ts` (new) | `summarizeSpend()` / `formatSpendFields()` / `formatSpendSummary()` / `formatTurnSpend()` / `formatModelSpend()` — the one shared reading `list` and `replay` both use |
| `src/trajectory/writer.ts` | `beginTurn(input, spend?)`; `TurnRecording` reads the meter in `end()`; `capSpend` caps `provider`/`model` like `capFailure` caps a failure |
| `src/agent/runtime.ts` | `send` builds one meter (`deltaUsage` + `usageBuckets`, non-throwing) and hands it to `beginTurn`; `/usage` and `lastTurnUsage` unchanged |
| `src/trajectory/replay.ts` | `ReplayResult.spend` (per-turn records + aggregate); `formatReplay` prints bounded per-turn lines, the session line, and a per-model breakdown when >1 model |
| `src/cli-trajectory.ts` | one bounded `spend: …` segment on the `list` row |
| `spike/verify-trajectory.ts` | `turnSpend()` + `turnSpendReadPaths()`; `ScriptedModel`/`ThrowingModel` gain optional `modelMetadataEvent` usage so the **real** SDK meter accumulates offline |
| `.trellis/spec/backend/session-trajectory.md` | corrected `agentResultEvent` row, new §3 contract for spend, §8 item 8, §11 tests-required |
| `.trellis/spec/backend/error-handling.md` | rows for an unreadable meter, an unreported metric, and a report over a pre-`SER-007` file |
| `.trellis/spec/backend/strands-sdk-contracts.md` | measured: `AgentResult.toJSON()` drops `metrics` while `Message.toJSON()` keeps `metadata`; meter update timing; summarization bypasses the meter |

`src/agent/usage.ts` is deliberately **not** modified: `deltaUsage` and `usageBuckets` already are
the contract, and the runtime is the layer that owns both them and the live config.

## Validation

`pnpm typecheck`; `pnpm test`; `pnpm tsx spike/verify-trajectory.ts`;
`pnpm tsx spike/verify-tui.ts completion`; `git diff --check`; `task.py validate`; plus live evidence
in a throwaway HOME — two real headless Bedrock turns reconciled field-by-field against their
`usage:` stderr lines, a real failed turn recording spend beside its failure, prefix hashes before and
after each append, `list`/`replay` with credentials removed, and a genuinely pre-`SER-007` file
reported as unknown.
