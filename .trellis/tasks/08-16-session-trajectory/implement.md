# Implementation plan — session trajectory

## Module layout

New `src/trajectory/`, deliberately free of any `Agent` / `Model` / `runtime.js` import so the read
side can never make a model call:

| File | Owns |
|---|---|
| `record.ts` | Schema types, `SCHEMA_VERSION`, the three caps, event allowlist, `projectEvent`, `capStrings`, `encodeRecord`, `parseRecordLine` |
| `writer.ts` | `TrajectoryRecorder`: lazy open, seq continuation, serialized append chain, latched problem, byte budget, `beginTurn/record/end/flush/close` |
| `reader.ts` | `readTrajectory` → `{ records, partialTrailingLine, unreadableLines }` |
| `search.ts` | `searchTrajectory` / `searchProject`, bounded substring matching + excerpt |
| `replay.ts` | records → `TurnAction[]` → existing `turnReducer` → `HistoryItem[]`, plus `formatReplay` |
| `fork.ts` | `forkSession`: snapshot + offload + trajectory prefix copy, `forkedFrom` marker |

`src/cli-trajectory.ts` parses and executes the `darwin trajectory …` subcommand (its own parser, so
`parseCliArgs`'s returned shape is untouched).

## Sequence

1. `src/agent/session.ts`: export `newSessionId`, add `trajectoryPath`, `sessionSnapshotPath`,
   `snapshotExistsFor`, `listSessionIds` — the file that already owns this layout keeps owning it.
2. `src/trajectory/record.ts` + `reader.ts`: format first, because both writer and every reader
   depend on it. Caps are code-point based (`headlessField` convention, avoids the U+FFFD bug).
3. `src/trajectory/writer.ts`: injected `open` (the `BackgroundBashManager` pattern) so a write
   failure is testable without a broken filesystem.
4. `src/agent/runtime.ts`: build the recorder in `create` (config-gated), wrap `send` with
   `for await` + `yield`, expose `trajectoryProblem` / `trajectoryStatus`, await the append chain in
   `shutdown`.
5. `src/config.ts`: `trajectory` boolean in `SessionFields` + `SESSION_KEYS` + validation.
6. `replay.ts`, `search.ts`, `fork.ts` — pure read side.
7. `src/cli-args.ts` (`--session` interactive), `src/cli-trajectory.ts`, `src/cli.ts` routing.
8. TUI: `/trajectory` built-in, post-turn problem notice, `MAX_COMPLETIONS` 8 → 9.
9. `src/headless.ts`: one bounded stderr record for a trajectory problem.
10. `spike/verify-trajectory.ts` + registration; update `spike/verify-headless.ts`,
    `spike/verify-config.ts`, `spike/verify-tui.ts`.
11. Docs: new spec `session-trajectory.md`, spec index link, `strands-sdk-contracts.md` measured
    contracts, `error-handling.md` rows, `AGENTS.md`, `README.md`.

## Load-bearing details

- **Append guard**: if the file does not end in `\n`, the first append of a run prefixes one. An
  interrupted write must stay one broken line instead of being glued onto the next valid record.
- **Seq continuation**: on lazy open read at most the last 64 KiB, take the last *complete* line's
  `seq`, continue from `seq + 1`. Gaps then mean something was really lost.
- **Serialized appends**: one promise chain. `O_APPEND` atomicity does not order concurrent writes.
- **Turn buffering**: records are built synchronously during the stream (no I/O between events) and
  flushed as one write at turn end, so recording adds no await to the hot path.
- **Partial assistant text**: deltas are not recorded, so the recorder accumulates capped text
  deltas itself and writes `turnEnded.partialText` when a turn ended with unflushed text — that is
  what `flushLiveText` puts in live history for a cancelled turn.
- **Replay reuses `turnReducer`**: replay builds `TurnAction`s, never its own history items, so live
  and replay cannot drift into two projections.

## Verification

`spike/verify-trajectory.ts`, network-free, `ownPrivateHome`, real SDK `Agent` + scripted `Model`
(the `verify-compact.ts` pattern) and a real `AgentRuntime` wherever the claim is about `send`:
append/byte-identity, partial-line tolerance, caps + recorded truncation, injected write failure,
pass-through event equality (recording on vs off) and mid-stream `break`, search hit + honest miss,
fork byte-identity + usability, replay equality against the live projection + determinism + no model
call, and child isolation.
