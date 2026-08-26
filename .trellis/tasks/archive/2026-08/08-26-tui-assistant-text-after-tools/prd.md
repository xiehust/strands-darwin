# Restore assistant text after tool-heavy turns

## Goal

Ensure every accepted assistant reply remains visible in the interactive TUI, including turns with enough tool activity to exceed the completion guard's event budget.

## Background

- The reported screenshots show completed tool rows followed by no visible final assistant reply.
- The captured session trajectory proves the SDK emitted and recorded the final text block and `agentResultEvent`; the model output itself was not absent.
- `collectCompletionCandidate()` withholds public events for the completion guard and currently retains only the first `MAX_COMPLETION_GUARD_EVENTS` events. Once that prefix fills, later terminal facts can be discarded even though an overflowed candidate already fails open.
- Existing tests cover floods of raw text deltas, which are collapsed before the cap, but not floods of retained tool events.

## Requirements

1. A completion-guard candidate that exceeds its retained-event budget must fail open without silently losing its final assistant text or terminal result.
2. Retained tool evidence must not be hidden or reordered to make room for the final reply.
3. Memory use must remain bounded; the fix must not simply remove or indefinitely increase the event cap.
4. Ordinary non-overflowing turns, internal-note suppression, unfinished-plan continuation, cancellation/failure handling, trajectory recording, and headless output must retain their existing semantics.
5. Add a focused regression that exceeds the cap with retained tool events and proves the TUI reducer receives the final assistant reply.

## Acceptance Criteria

- [ ] A candidate containing more than `MAX_COMPLETION_GUARD_EVENTS` retained tool events still yields its final assistant text and terminal result.
- [ ] Overflowed candidates remain ineligible for suppression or automatic unfinished-plan continuation.
- [ ] The retained sequence preserves the original ordering of all events it keeps and does not silently hide tool calls.
- [ ] The accepted events reduced through `turnReducer` contain the final assistant history item.
- [ ] Existing completion-guard, stream/static, and update-plan focused tests pass.
- [ ] `pnpm test`, `pnpm typecheck`, and `git diff --check` pass.

## Out of Scope

- TUI visual redesign or label changes.
- Changes to the SDK agent loop, provider configuration, or model behavior.
- Rewriting historical trajectory files.
- Making all tool events unbounded in memory.
