# Stream finished answer lines into scrollback

Child of `08-17-live-frame-round-2`. Round 1 recorded this as out of scope with its reason
attached: *"It would scroll more naturally, but it gives up the invariant that the assembled block
is what enters history — `contentBlockEvent` is authoritative and may differ from the deltas, and
Static output cannot be taken back."* This task is that trade, taken deliberately: the invariant is
not abandoned, it is made checkable at the point where the block closes.

## Goal

A long answer scrolls up into the terminal's own scrollback as it arrives, the way a command's
output does, instead of sitting in a bounded tail and then appearing all at once when the block
closes. The live region holds only the part that cannot yet be committed.

## Background — how it works today

- `textDelta` appends to `state.liveText` (`turn-state.ts`); nothing enters history while the text
  arrives.
- History is written at exactly three points, always from the *whole* accumulated or assembled
  text: `contentBlockEvent` for a `textBlock` (authoritative — it replaces the deltas with
  `block.text.trim()`), and `flushLiveText` on `beforeToolCallEvent` and `turnEnded` (an
  unterminated remainder, e.g. a cancelled turn). So a multi-item assistant answer already exists
  today whenever a tool interrupts the text.
- `MessageList` draws `liveText` as a bounded tail with `… N earlier lines scrolled out of the live
  view`. For a 120-line answer that notice is the only sign of the earlier rows until the very end.
- `spike/verify-tui.ts longAnswer` asserts today's shape directly: 0 `ESC[3J`, the scrolled-out
  notice present *for a `row 1..120` answer*, and the whole answer in the transcript afterwards.
  This feature makes the middle assertion obsolete for that shape — a line-oriented answer will be
  committed as it goes and will not need the notice at all.
- `src/trajectory/replay.ts` feeds recorded events through the same `turnReducer`, so any split
  this introduces is reproduced by replay for free — and any split done *outside* the reducer would
  make live and replay disagree.

## Requirements

1. **Commit only what cannot change.** A logical line is committable once its terminating newline
   has arrived; an unterminated trailing fragment stays in the live region. `<Static>` output cannot
   be recalled, so nothing provisional may enter it.
2. **The authoritative block still decides what history says.** When `contentBlockEvent` closes the
   text, what was already committed is reconciled against `block.text`:
   - it is a prefix → commit the remainder only;
   - it diverges → the divergence is **stated** as a notice and the authoritative text is what
     stands. Never two silent versions of the same answer, and never a silent discard of what the
     terminal already printed.
   The reconciliation must also preserve today's visible result for the ordinary case: the same
   answer must render identically whether it was committed progressively or in one write, including
   the `trim()` semantics at the block's edges.
3. **One `agent` label per answer, not per commit.** Continuation chunks render without the label
   and the bottom margin belongs to the last chunk, so a 120-line answer does not become 120
   labelled blocks. The transcript must be indistinguishable from today's for the same text.
4. **No duplication and no loss on the other exits.** A tool call starting mid-answer, a cancelled
   turn (`turnEnded`), and a failed turn each flush only the *uncommitted* remainder.
5. **`turnReducer` stays the single projection.** The split happens in the reducer, so live
   rendering, replay and headless output cannot diverge; replaying a recorded session must produce
   the same transcript as the live run produced.
6. **The tail stays.** One unbroken paragraph — the common streaming shape — has no committable
   line for a long time, so `live-text.ts` and its notice remain load-bearing. This task shrinks the
   live region, it does not remove the bound; the frame invariant is still enforced by the sibling
   task's shared budget.
7. **Progressive commits must not cost more than the single write.** Each commit is an append to
   `<Static>`; it must not trigger a whole-screen clear, a re-emission of the transcript, or a
   per-line re-render of history. This is measured, not assumed.

## Acceptance

- [ ] A 120-line answer in a 20-row pty: **0** `ESC[3J`; the answer is visible in the transcript
      *while* `working…` is still shown (progressive, not one final write); the complete answer
      appears in the transcript exactly once, with no duplicated or missing lines; one `agent`
      label.
- [ ] One unbroken ~4000-character paragraph: still bounded, still shows
      `… N earlier lines scrolled out of the live view`, still lands complete in history. The
      `longAnswer` scenario's notice assertion is **re-expressed onto this shape** rather than
      deleted, so the tail keeps a regression check.
- [ ] Divergence is exercised on purpose with `spike/offline-model.ts` (deltas that differ from the
      assembled block — no model call): the notice is shown, the authoritative text stands, and
      nothing is silently dropped.
- [ ] Ctrl+C mid-answer, and a tool call starting mid-answer: nothing duplicated, nothing lost.
- [ ] `trajectory replay` of a recorded long answer renders the same transcript as the live run
      (same items, same order, same text).
- [ ] Cost measured: clears and bytes written for a 120-line answer, progressive vs. today's single
      write, recorded in the task.
- [ ] `pnpm typecheck`, `pnpm test`, `spike/verify-live-text.ts`, `spike/verify-trajectory.ts`,
      `spike/verify-headless-structured.ts`, `spike/probe-live-frame-overflow.tsx` in both modes,
      and `verify-tui.ts` `longAnswer` + `cancelThenContinue` + `usage`.

## Out of scope

- Committing partial lines, or re-flowing text already written to `<Static>` (impossible by
  definition — the terminal owns those rows).
- Rendering markdown, syntax highlighting, or any transformation of answer text. This changes
  *when* text is written, not what it says.
- Recording anything new in the trajectory: the events are unchanged, only their projection into
  history is.
- Subagent output. Child streams never pass through `send`, and that stays true.
