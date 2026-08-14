# Add conversation compaction command

## Goal

Let users deliberately shrink a long darwin conversation without abandoning its session: replace old context with a model-generated summary, retain recent messages verbatim, report the resulting context-token reduction, and keep both immediate follow-up turns and `--resume` working.

## Background

- `AgentRuntime` already installs the SDK's `SummarizingConversationManager`, configured by `summaryRatio` and `preserveRecentMessages`, but today it only runs reactively after context overflow.
- The runtime owns the live `Agent`, model, and session manager; the TUI owns slash-command dispatch and transcript notices.
- SDK 1.12.0 exposes `SummarizingConversationManager.reduce(...)`, `Model.countTokens(...)`, and `SessionManager.saveSnapshot(...)` as public APIs.
- Session snapshots are otherwise written only after an agent invocation. `/compact` is local and does not invoke the agent loop, so it must explicitly persist its rewritten message list.

## Requirements

1. Add `/compact` as a discoverable built-in TUI command.
2. Only run compaction while the agent is idle. The command must never be sent to the model as ordinary user input.
3. Use an SDK `SummarizingConversationManager` over the live agent to repeatedly summarize the oldest reducible messages until only one rolling summary plus the configured `preserveRecentMessages` remain. Preserve tool-use/result integrity through the SDK implementation; keep the existing configured manager unchanged for reactive overflow recovery.
4. Keep the configured recent messages byte-for-byte/message-for-message unchanged.
5. Measure the complete next-request context before and after compaction with the live model's `countTokens`, including the assembled system prompt and registered tool schemas. Report before, after, and tokens saved as a context-size estimate, not as billing savings.
6. Save the compacted live agent state to the current session's latest snapshot before reporting success, then keep the normal `--resume` pointer current.
7. Treat compaction as atomic from darwin's perspective: if summarization, token counting, or snapshot persistence fails, restore the original in-memory messages and report a transcript notice rather than leaving live and persisted state divergent.
8. If there are not enough messages beyond `preserveRecentMessages` to reduce, report that no compaction was needed without making a model call or altering the session.
9. A successful compaction must allow a normal follow-up turn in the same process and restore the compacted history with `--resume`.

## Acceptance Criteria

- [x] `/` completion includes `/compact` among the built-ins.
- [x] On a long conversation, `/compact` leaves one summary plus the configured recent-message window, and the retained recent messages are unchanged.
- [x] The TUI reports the message-count change and estimated context tokens before, after, and saved.
- [x] `/compact` does not enter the normal agent loop as a user prompt and is refused while another turn is active.
- [x] A turn after compaction can use a fact present only in the compacted history.
- [x] A fresh process using `--resume` restores the compacted message list and can continue from its summary.
- [x] A failure rolls back the live message list and is surfaced to the user.
- [x] `pnpm typecheck` and `pnpm test` pass.
- [x] A focused spike covers compaction, token reporting inputs, persistence/resume, and rollback without requiring a live model call; the existing free pty completion scenario covers discovery.
- [x] Relevant SDK/session contracts are recorded in `.trellis/spec/backend/strands-sdk-contracts.md`, and new failure behavior is recorded in `.trellis/spec/backend/error-handling.md`.

## Out of Scope

- Automatic threshold-based compaction or changing existing reactive overflow behavior.
- New compaction configuration keys or command arguments.
- Rewriting already-rendered TUI transcript history; compaction changes model/session context, not terminal scrollback.
- Claiming reduced billed tokens or including the summarization call's cost in the reported savings.

## Technical Notes

- Existing `summaryRatio` continues to control reactive overflow recovery. Explicit `/compact` uses the SDK maximum ratio (0.8) per pass to converge to one rolling summary plus the preserved window with fewer summarization calls.
- The report describes estimated context tokens saved because provider token counters and fallbacks differ; it does not subtract the one-off summarization cost.
- The user explicitly delegated implementation trade-offs and authorized execution through commit and push after planning.
