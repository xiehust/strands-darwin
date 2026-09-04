# Make the whole live frame fit, and stream text into scrollback

Round 2 of the live-frame work. Round 1 (`archive/2026-08/08-17-live-frame-flicker`) fixed the
reported symptom — a streaming answer flickering the whole interface — by bounding `liveText` and
drawing it as a tail. It closed with two items explicitly recorded as out of scope. This task is
those two items, and they are one task because they pull on the same budget from opposite ends.

## Goal

The live frame fits the terminal in *every* state the TUI can be in, not only while an answer
streams; and a long answer reaches the terminal's own scrollback while it arrives rather than in
one write at the end.

## Why one parent with two children

- `08-17-live-frame-chrome` — **bound every participant of the live frame, not just the answer.**
  A correctness fix for the same class of bug as round 1: today an idle session with a 13-row
  draft, or a single in-flight tool call with details expanded, still clears the screen and the
  scrollback. Measured in `08-17-live-frame-chrome/research/probe-results.md`.
- `08-17-stream-into-static` — **stream finished answer lines into scrollback.** A behaviour
  change, not a bug fix: it moves finished lines out of the redrawn region into `<Static>`, which
  both improves how a long answer reads and shrinks the thing round 1 had to bound.

They share one invariant (`frame height < rows`) and one budget, so a change on either side moves
what the other must reserve. Folding them into one task would put a bug fix and a behaviour change
in one commit; splitting them with no parent would lose the shared contract.

## Requirements on the pair

1. **One invariant, everywhere**: nothing that is redrawn may make the live frame as tall as the
   viewport, in any combination of header, streaming answer, tool panel, permission box and draft,
   at any terminal size. `ESC[3J` in the raw pty bytes is the measurement and the target is always
   zero.
2. **One budget, shared, with a stated priority.** Neither child may simply cap its own box: they
   must agree where the total is divided and what yields first, and that answer is written into
   `.trellis/spec/frontend/tui-testing.md`, not only into the code.
3. **Nothing is lost, and what is hidden is stated.** Round 1's rule extends to every
   participant: the whole answer still reaches the transcript, the whole draft is still submitted,
   and a view showing less than it holds says so on screen.
4. **`turnReducer` stays the single projection.** Live rendering, `<Static>` history, headless
   output and trajectory replay keep coming from the same reducer, so none of this can drift into
   two versions of the transcript.
5. **No new frame row.** The header contract holds: startup state rides an existing line, and the
   header does not grow for either child.

## Order

`live-frame-chrome` first. It is a bug, it is measurable today, and `stream-into-static` changes
what the answer contributes to the very budget the first child divides up — landing it first would
mean sizing the budget against a shape that is about to change.

## Acceptance

- [ ] Every scenario in both children's PRDs produces **0** `ESC[3J`, and each new check has been
      shown able to fail (remove the bound, get the measured counts back).
- [ ] `pnpm typecheck`, `pnpm test`, the full `spike/verify-tui.ts` suite,
      `spike/verify-live-text.ts`, and `spike/probe-live-frame-overflow.tsx` in both modes.
- [ ] The "the live frame must fit the viewport" contract in
      `.trellis/spec/frontend/tui-testing.md` is updated once, at the end, to describe the shared
      budget rather than only the answer tail.

## Out of scope

- Any change to the header's height or content.
- A scrollback/pager UI of darwin's own (`less`-style scrolling of history). The terminal's
  scrollback *is* the scrollback; that is the whole reason `<Static>` is used here.
- Alternate screen buffer / fullscreen mode. It would make the height question moot and the
  scrollback question unanswerable — the opposite of the trade this project made.
