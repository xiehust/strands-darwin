# Fix persistent final reply duplication

## Goal

Ensure the final held-back assistant tail appears exactly once when a long reply moves from the mutable Ink frame into `<Static>` history.

## Evidence

- The reported screenshot repeats only the final paragraph below the completed answer, without a second assistant label.
- Its session trajectory contains one authoritative final text `contentBlockEvent` followed by one `agentResultEvent`; the model did not answer twice.
- The previous fix waits for Ink after dispatching `prepareAnswerClose`, but does not prove React committed that reducer action before the wait began. The existing short ASCII/30-row PTY fixture passes while the real long CJK reply still duplicates its held-back tail.

## Requirements

1. The close barrier must wait for the specific React commit that removes the mutable answer tail, then wait for Ink to flush that committed frame, before publishing the unchanged text `contentBlockEvent`.
2. Preserve direct event streaming and event order. Do not deduplicate text, consume `agentResultEvent`, buffer a whole turn, or create an alternate answer formatter.
3. Preserve reducer history, trajectory, replay, markdown, labels, and margins exactly; the barrier is terminal-presentation-only.
4. Extend the free PTY regression to the reported shape: a long CJK final reply, a narrow/short viewport, and an assertion that the final paragraph occurs once after a subsequent turn redraw.
5. The barrier must not hang during cancellation or unmount.

## Acceptance Criteria

- [ ] The reported final paragraph remains once in reconstructed terminal scrollback after the next prompt/turn.
- [ ] A committed answer-free frame precedes the final tail's `<Static>` write.
- [ ] The reducer/replay projection contains the authoritative answer exactly once.
- [ ] Focused stream/static and PTY checks pass.
- [ ] `pnpm test`, `pnpm typecheck`, and `git diff --check` pass.

## Out of Scope

- Suppressing genuinely repeated model text.
- Rewriting trajectories or changing SDK/provider events.
- Broad Ink renderer changes unrelated to this close boundary.
