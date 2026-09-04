# Implementation notes — turn failure in the record

## What changed, and where the decision lives

| File | Change |
|---|---|
| `src/trajectory/record.ts` | `TurnFailure` (`name`, `message`, `cause?`) + optional `failure` on `TurnEndedRecord`; `failureFromError` (class from the prototype, declared `name` kept when it disagrees, non-`Error` throws described as such); `turnOutcome` / `turnFailureOf` / `failureLine` / `formatTurnFailure` + `MAX_FAILURE_SUMMARY_CHARS`; `searchableText` includes the failure |
| `src/trajectory/writer.ts` | `TurnRecording.failed(error)` — synchronous, non-throwing, no I/O — and `end()` emitting the capped failure with its truncations on the same record (`capFailure`) |
| `src/trajectory/stream.ts` | the `catch` that observes the throw and rethrows the identical object |
| `src/trajectory/replay.ts` | reconstructs the live `turn failed: <message>` error notice before `turnEnded`, collects `ReplayResult.failures`, and `formatReplay` names the class |
| `src/cli-trajectory.ts` | `describeFailedTurns` on the `list` row, bounded and capped at three named failures |
| `spike/verify-trajectory.ts` | `failedTurn()` and `failedTurnReadPaths()` (55 new assertions), `ThrowingModel`, `ProviderExplosion`, hoisted `runTrajectory` helper |

No change to `src/agent/runtime.ts` (`send` is `yield* recordStream(...)`, so it needed none), to
`src/agent/session.ts`, or to anything under `src/tui/`.

## Why an added field, not a new record type

`turnEnded` already closes every turn, including a thrown one, and readers tolerate unknown fields by
contract (`parseRecordLine` requires only `type` and `seq`). A `turnFailed` record type would have
cost a `TrajectoryRecordType` member, a `replayRecords` arm, and a second buffered record that could
be separated from the counters describing the same turn — for no gain. No `SCHEMA_VERSION` bump: the
version is for changes a reader *cannot* tolerate.

## The one addition beyond the approved plan

`failure.cause`, added after measuring that `Model.streamAggregated` wraps any non-`ModelError` throw
in `new ModelError(message, { cause })` while `BedrockModel` passes AWS exceptions through. Without
it every real provider failure would have recorded as an indistinguishable `ModelError`; the live
check confirmed it (`cause: "AccessDeniedException"`). Strictly additive, capped like the rest,
recorded in `strands-sdk-contracts.md`.

## Checks run

`pnpm typecheck`; `pnpm test` (26 suites, 0 failed); `pnpm tsx spike/verify-trajectory.ts`
(203 passed, 0 failed); `pnpm tsx spike/verify-tui.ts completion` (25 passed); `git diff --check`;
`task.py validate`; plus a live headless run against a real Bedrock rejection whose record, `list`,
`replay` and `search` all name the error.
