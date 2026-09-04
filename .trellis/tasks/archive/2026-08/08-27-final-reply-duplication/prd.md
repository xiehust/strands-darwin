# Prevent final TUI reply duplication

## Goal

Ensure the final assistant reply appears once when its remaining live tail moves into `<Static>` terminal history.

## Evidence

- The reported screenshot duplicates only the final live tail; earlier lines already committed progressively do not repeat.
- The matching trajectory contains one final `contentBlockEvent` and one identical `agentResultEvent`, so the model and SDK did not emit a second answer.
- `turnReducer` closes that block into one correct history projection. The gap is the terminal handoff: one React update both removes the live tail and appends the same text to Ink `<Static>`, allowing some terminals to retain the old live rows in scrollback.

## Requirements

1. Before an authoritative text block is appended to `<Static>`, the prior live answer rows must be removed in a completed terminal render.
2. The ordinary driver must still publish every SDK event through the existing reducer in order; no text-based event deduplication, whole-turn buffering, or alternate answer formatter may be introduced.
3. The final reducer history, trajectory replay, markdown styling, answer labels, and closing margin must remain byte-for-byte equivalent to the existing successful projection.
4. Streaming deltas must remain immediate. At most the text-block close boundary may wait for the terminal handoff; do not serialize every token or line on a render flush.
5. Add a free offline PTY regression that holds a model immediately before block close, proves the tail is live, then proves an answer-free busy frame reaches the terminal before the tail is committed to `<Static>`.

## Acceptance Criteria

- [x] The reported final-tail shape is not silently printed twice by the live-to-Static transition.
- [x] A normal final `contentBlockEvent` reaches `turnReducer` only after the old live rows have been flushed away.
- [x] The stable reducer/replay answer remains exactly the authoritative block once.
- [x] The focused stream/static and PTY checks pass.
- [x] `pnpm test`, `pnpm typecheck`, and `git diff --check` pass.

## Out of Scope

- Rewriting historical trajectories or suppressing repeated model content by value.
- Changing SDK/provider event semantics.
- Fixing every upstream Ink case involving a single `<Static>` chunk taller than the viewport.
- Visual redesign, labels, colors, or frame-priority changes.
