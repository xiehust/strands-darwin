# Implementation notes — opt-in session diagnostics log

## What was built

| File | Change |
|---|---|
| `src/agent/diagnostics.ts` | **New.** `DiagnosticsLog` (synchronous non-throwing `write`, bound `sdkSink`/`notice`, `status`, `close`), `formatDiagnosticLine`, and the three bounds. |
| `src/agent/sdk-logging.ts` | Module state plus `setSdkVerboseSink(sink | undefined)`. `SdkLogEntry` is deliberately **not** widened; `debug`/`info` are literal `() => {}` with no tap. |
| `src/agent/session.ts` | `DIAGNOSTICS_FILENAME`, `diagnosticsPath()` beside `trajectoryPath()`. |
| `src/config.ts` | `diagnostics?: boolean` on `SessionFields`, in `SESSION_KEYS`, validated with `booleanField`. |
| `src/agent/runtime.ts` | Builds the log early in `create` and installs the tap; `info.diagnosticsFile`, `get diagnostics()`, `get diagnosticsStatus()`; clears the tap and closes the log in `shutdown()`. |
| `src/tui/App.tsx` | `withNoticeDiagnostics` (exported, testable) wrapping the reducer's dispatch; one startup notice; one post-turn problem notice. |
| `src/cli.ts` | `note(text, level)` mirrors post-create stderr records; `diagnostics: <file>` startup record; `diagnostics: <problem>` record at the end. |
| `src/headless.ts` | `formatHeadlessDiagnosticsProblem`, mirroring the trajectory one. |
| `spike/verify-diagnostics.ts` | **New**, 70 assertions, registered in `run-tests.ts` (26 → 27 suites). |
| `spike/verify-config.ts` | `diagnosticsField()`: default-off, both booleans, `ConfigError` naming the field, misplaced-in-entry, survives `/model`. |

## Decisions that took a measurement to make

- **A tap, not a wider sink.** Widening `SdkLogEntry.level` to four levels breaks `App.tsx`'s
  `severity: entry.level` (`NoticeSeverity` has no `debug`), so the verbose channel is a second,
  independent sink. It also has a different lifetime — a renderer belongs to a mounted frame, the tap
  to a session — which is why `sdk-logging.ts` holds both in module state and rebuilds the handlers,
  rather than the tap being an argument to `routeSdkLogs`. Consequence worth keeping: the runtime can
  install the tap during `create`, before the model/MCP/skills log their startup `debug` lines, with
  no new plumbing in either entry point.
- **`flush()` must not drain while a write is in flight.** The first draft copied the trajectory
  writer's `flush()`, which hands every batch straight to the chain. Measured in the backpressure
  test: **0 of 200** lines were dropped at a 400-byte pending bound, because `pending` was emptied on
  every arrival and the growth simply moved into a chain of queued batches. Gating on a `writing`
  flag makes the pending-byte bound real (197 of 200 dropped in the same test), and `close()` then has
  to loop rather than await once, because the awaited chain can schedule a successor.
- **The file bound is applied before writing, not after.** One append carries a whole burst, so
  checking `fileBytes >= maxBytes` afterwards let a 600-byte budget write 42 lines. The batch is now
  trimmed to what fits, so only the stop marker itself overshoots (measured live: 8,388,730 bytes
  against an 8,388,608-byte budget).
- **A tool-calling turn is the smallest real source of SDK `debug` output.** The SDK's intervention
  registry only logs a dispatch some handler *implements*, and darwin's `PermissionGate` implements
  `onBeforeToolCall` only — so a text-only scripted turn produced no debug lines at all. The suite's
  model now calls a tool, which is both what production does and what makes the capture assertion
  meaningful. The event label in the log is `beforeToolCall`, not the method name.
- **`close()` latches.** A line offered after the chain is no longer awaited might or might not reach
  disk, so it is refused; the headless mirror is naturally silent after `shutdown()` as a result, and
  the file's last line means "the session ended here".

## Verification

`pnpm typecheck` (exit 0) · `pnpm test` (27 suites, all `0 failed`, exit 0) ·
`spike/verify-diagnostics.ts` (70 passed) · `spike/verify-config.ts` (199 passed) ·
`spike/verify-tui.ts approve` (23 passed, model-calling, the no-frame-row contract) ·
`spike/verify-tui.ts completion` (25 passed) · `git diff --check` clean.

Live, in a throwaway HOME against real Bedrock (`us.anthropic.claude-haiku-4-5`): a bad value refuses
to start in both modes (`"diagnostics" must be true or false.`); the default run wrote no diagnostics
file anywhere and left stderr unchanged; the on-run captured real `added cache point to last user
message`, `auto-detected includeToolResultStatus` and permission-gate dispatch lines beside
timestamped `darwin info` lines; a diagnostics.log replaced by a directory degraded to one
`diagnostics: … EISDIR …` record with the turn still exiting 0; and a pre-filled 8 MiB file stopped
with the marker as its last line, again exit 0.
