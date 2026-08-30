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

## Resolution (2026-08-30)

The two timing fixes (`9da06c3`, `0ae83f8`) hardened the wrong boundary. The real root cause was
found via the recorded failing session (`session-20260830-110550523`) and a deterministic pty
reproduction (`spike/probe-final-reply-duplication.ts`):

- The failing turn used `update_plan`, so `turnEnded`'s `finishTurn` called
  `insertFinalPlanBeforeAnswer`, inserting the final checklist projection **into the middle** of
  `history` — before the already-committed closing answer entry.
- Ink's `<Static>` consumes its `items` array by index (`items.slice(index)`); a mid-array insert
  shifts the committed suffix back into the unconsumed window. The closing `last` answer entry
  (label-free, own bottom margin — exactly the reported screenshot shape) was written to the
  terminal a second time, and the checklist itself was silently swallowed (0 occurrences in the
  reconstructed terminal).
- Reproduction was 100% deterministic across 60x20/90x30/120x45/200x50 and four delta-timing
  patterns once the fixture issued `update_plan` before the closing reply; without `update_plan`
  it never reproduced — which is why the bug read as "occasional".

Fix: `finishTurn` now **appends** the final checklist projection after everything the turn already
committed; `insertFinalPlanBeforeAnswer` is deleted. `spike/verify-update-plan.tsx` asserts the
append-only (prefix-stability) invariant across `turnEnded`, the pty `updatePlan` scenario counts
the closing answer exactly once and the persisted checklist in the erase-aware reconstructed
terminal, and the probe stays as the terminal-level regression. Spec updated:
`.trellis/spec/frontend/live-frame.md` § SER-036.
