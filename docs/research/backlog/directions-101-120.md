# Darwin self-evolution backlog — priorities 101–120

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SRF-026 — Continue a `subagent` child once after the exact stream-interruption `ModelError`: when `child.invoke()` rejects with `isRetryableStreamInterruption` and the child is not cancelled, run one `invoke(STREAM_CONTINUATION_PROMPT)` on the same live child, publish a `continuing-after-stream-interruption` heartbeat phase, and on a second failure rethrow through `withFailedChildText` with the original error as `cause` — never inside the SDK loop, never a second attempt, `workflow` nodes unchanged

- Status: `not-started`
- Priority: 101
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-09-08_session-20260905-014347068.md`](../../reflections/reflection_2026-09-08_session-20260905-014347068.md)

### Implementation / acceptance evidence

Not started. Requirement: in `src/agents/subagent-tool.ts`, wrap the `child.invoke(injectCodexContext(task, hookContext), { invocationState })` call so that when it rejects with an error for which `isRetryableStreamInterruption(error)` (from `src/agent/stream-resumption.ts`) is true and `child.cancelSignal.aborted` is false, exactly one `child.invoke(STREAM_CONTINUATION_PROMPT, { invocationState })` runs on the same live child (its retained in-memory conversation ends at the last tool result, so the continuation is an ordinary user-role message); the dispatch record's safe phase becomes `continuing-after-stream-interruption` via the existing `setPhase` for the duration; the successful continuation's result flows through the unchanged refusal check, `projectChildReport` and `withRetainedMaxTokensText`; a second failure (of any class) is rethrown through `withFailedChildText` with the *original* interruption error preserved as `cause` and `name`, so the retry guard's signature and `turnEnded.failure` are unchanged in shape; a cancelled child is never continued; the continuation is attempted at most once per dispatch (a `continue=<id>` follow-up is its own dispatch with its own single attempt); `workflow` Graph nodes are untouched. The `subagent` tool description gains one clause naming the single continuation. Acceptance: `spike/verify-subagents.ts` (or a new free suite) with a fake model that throws the exact `ModelError('Stream ended without completing a message')` once and then answers — the parent tool result is the child's report, the dispatch settles `succeeded`, the heartbeat phase was observed; a fake model that throws twice — the tool error carries the original message and `error.cause` is the first `ModelError`, dispatch settles `failed`; a child cancelled during the first attempt is not continued; a non-interruption error is not continued; `verify-stream-resumption.ts`, `verify-failed-child-text.ts`, `verify-continuable-children.ts`, `pnpm typecheck`, `pnpm test`. Docs: the Subagents load-bearing section and the Stream-interruption section state that children get the same one continuation, on the child, never in the loop.

### Notes / blockers / abandonment reason

Evidence: session `session-20260905-014347068` turn 26 — two `subagent` children dispatched at seq 1740 (09:51:14) and seq 1760 (10:03:52) died at seq 1741 (10:03:00, 11 m 46 s) and seq 1761 (10:13:16, 9 m 24 s) with the bare `Error: Stream ended without completing a message`; neither carried SER-063 last text (the last completed child message was tool-use-only) nor was SER-075-continuable (conversation ended in a tool result). The parent re-derived progress from disk (seq 1745–1757: "The child got through the captions refactor before its stream was cut off"), then wrote the portrait script itself (seq 1781–1806). 21 m 10 s of the 34 m 50 s turn produced nothing. Contrast: the parent's own interruption at seq 31 was continued 49 ms later as turn 2 (seq 32) and delivered the deck. Independent of SRF-027/028.

## SRF-027 — Record `/compact` in the trajectory: one bounded `contextCompacted` observer record written by the TUI driver after a successful `AgentRuntime.compact()` (message counts before/after, the pre-compaction estimate when known, whether a focus was given — never summary or focus text), printed as one line by `trajectory replay` and therefore `/export`, and treated by `spend.ts` as an anchor drop for the next `modelCall`'s `context ~N tokens`

- Status: `not-started`
- Priority: 102
- Score: 9
- Importance: 2
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 1
- Origin report: [`reflection_2026-09-08_session-20260905-014347068.md`](../../reflections/reflection_2026-09-08_session-20260905-014347068.md)

### Implementation / acceptance evidence

Not started. Requirement: add a `contextCompacted` record type to `src/trajectory/record.ts` (reader/normalizer, bounded numeric fields: `before.messages`, `after.messages`, optional `before.estimatedTokens`, boolean `focused`), a writer entry point on the trajectory recorder that appends it synchronously like `shellCommand`/`taskNotification` (no I/O on the stream path, degrades open), and one call site in `src/tui/App.tsx` after `runtime.compact()` reports `compacted: true`; `formatReplay` prints one line (`context compacted: <before> → <after> messages`), so `/export` shows it byte-identically; `src/trajectory/spend.ts` stops labelling the first `modelCall` after it with the stale SDK projection (print `context: reset by compaction` or omit the `context ~N tokens` suffix for that one call). Never the summary text, never the focus text, no SDK change, no new TUI surface. Acceptance: `spike/verify-trajectory.ts` round-trips the record and rejects oversize/malformed fields; `spike/verify-compact.ts` asserts exactly one record per successful compaction and none on the no-shrink/failure paths; `spike/verify-export-command.ts` shows the line; `pnpm typecheck`, `pnpm test`; `tui completion` unchanged.

### Notes / blockers / abandonment reason

Evidence: session `session-20260905-014347068` — seq 1245 (turn 15 `turnEnded`, 07:03:52) → seq 1246 (turn 16 `userInput`, 07:39:55) with no record between; seq 1250 `modelCall.contextTokens: 705408` while that call's own spend is input 4 + cacheRead 0 + cacheWrite 43,990 (≈ 44k actual, a full cache miss); seq 1255 `contextTokens: 46647`. The stale value is the SDK `_estimateInputTokens` baseline (last assistant message carrying usage metadata — after summarization a preserved recent message still carries pre-compaction usage). Config for the session: `summaryRatio 0.8`, `preserveRecentMessages 10`. Touches `src/trajectory/record.ts` and the replay header like SRF-028; implement before it.

## SRF-028 — Name a rewind successor's origin in its own trajectory: when `AgentRuntime.create` runs with `options.rewindRestore`, the `runStarted` record carries `rewindFrom: { session, snapshotId }` (bounded strings, optional, additive), and `trajectory replay`'s header plus the interactive resume recap print it; `resumed`/`restoredMessages` semantics unchanged

- Status: `not-started`
- Priority: 103
- Score: 11
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 1
- Risk: 1
- Origin report: [`reflection_2026-09-08_session-20260905-014347068.md`](../../reflections/reflection_2026-09-08_session-20260905-014347068.md)

### Implementation / acceptance evidence

Not started. Requirement: in `src/agent/runtime.ts` `create`, when `options.rewindRestore` is defined pass `rewindFrom: { session: options.rewindRestore.sourceSessionId, snapshotId: options.rewindRestore.snapshotId }` into the `TrajectoryRecorder` `run` options; `src/trajectory/record.ts` accepts the optional field on `runStarted` (both strings capped like the other run-record strings, dropped when malformed), `formatReplay` prints it on the run header line (`rewound from <session> snapshot <id>`), and `src/trajectory/resume-recap.ts` includes it in the recap notice when present. Sessions started fresh, by `--resume` or by `/clear` write byte-identical `runStarted` records to today. Acceptance: `spike/verify-trajectory.ts` round-trips a `runStarted` with and without the field; `spike/verify-rewind.ts` asserts the successor's first record names the source session and snapshot id and that the source trajectory is untouched; `spike/verify-resume-recap.ts` shows the notice; `pnpm typecheck`, `pnpm test`.

### Notes / blockers / abandonment reason

Evidence: session `session-20260905-014347068` seq 0 `runStarted { resumed: false, restoredMessages: 188 }` and seq 5 (first call: `contextTokens 239287`, cacheRead 0, cacheWrite 240,978). `startRewind` creates the successor with `session: { kind: 'new' }` (so `restoreRequested` is false) and the snapshot supplies the messages, but the record is composed only from `session.restoreRequested` and `agent.messages.length`; the predecessor `session-20260904-145930073` holds one rewind checkpoint (completed 2026-09-04T15:18:44Z). Shares `record.ts`/replay-header edits with SRF-027; implement after it.
