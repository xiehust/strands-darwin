# Bound the live frame so a long answer cannot flicker

Reported from use: while the agent is streaming a long answer, the whole interface flashes
continuously (「界面不断闪动」).

## Goal

A streamed answer of any length renders as calmly as a short one, and the terminal's own
scrollback survives it. The complete answer must still reach the transcript.

## Background — measured, not assumed

- Ink 7 does not clip an over-tall live frame, it *changes strategy*.
  `shouldClearTerminalForFrame()` (`node_modules/ink/build/ink.js`) returns true as soon as
  `outputHeight > viewportRows`, and that branch writes
  `ansiEscapes.clearTerminal + this.fullStaticOutput + outputToRender` **directly to
  `options.stdout`** — bypassing `throttledLog`, so the 30fps cap does not apply either.
- `ansiEscapes.clearTerminal` is `ESC[2J ESC[3J ESC[H`. `ESC[3J` erases the **scrollback**, so
  every frame also destroys the history the transcript relies on being able to scroll back to.
- `liveText` (`src/tui/turn-state.ts`) accumulated the whole in-flight answer and
  `MessageList` drew all of it in one `<Text>`, inside the live frame. So the frame's height
  was the answer's height: unbounded.
- Quantified in `spike/probe-live-frame-overflow.tsx` (no model, no network): a 60-line answer
  in a 24-row pty produced **43** whole-screen clears; the same run with the live region
  bounded produced **0**.
- Everything else in the frame was already bounded by an existing contract (the header's
  "competes for frame height" rule, the tool-detail and permission presentation caps). The
  streaming answer was the one unbounded participant.
- `useBoxMetrics` reports a box's layout **relative to its parent** (`getComputedLayout()`),
  while `useCursor` coordinates are relative to the whole live frame
  (`buildCursorSuffix(visibleLineCount, cursor)` in `ink/build/cursor-helpers.js`). `InputBox`
  relied on those being the same thing, which held only while its parent was the root box.

## Requirements

1. **The live frame stays strictly shorter than the viewport** while an answer streams, so the
   `clearTerminal` branch is never taken. One spare row: Ink also clears when a frame that was
   exactly `rows` tall shrinks (`isLeavingFullscreen`).
2. **The streaming answer is shown as a tail** — the newest rows that fit — and what it is not
   showing is **stated on screen**, not silently dropped.
3. **Nothing is lost.** The assembled text block still enters `<Static>` history in full; that
   single write is the one allowed to exceed the viewport, and it is what the terminal's
   scrollback then holds.
4. **The height is exact, not estimated.** The rows are wrapped by darwin (word-preferring,
   grapheme-safe, wide-character and tab aware, last column left empty) and drawn one
   `<Text wrap="truncate-end">` per row, so Ink's own word wrap cannot grow the block past the
   budget it was given.
5. **The budget is measured, not guessed**: the header box and the box below the transcript are
   measured with `useBoxMetrics`, because the header grows a line for every degradation it
   reports. Neither measurement may depend on the live text's own height (or the budget
   oscillates). Before the first layout pass, assume chrome rather than guess low.
6. **The terminal cursor stays on the prompt.** Any new wrapping box changes what
   `useBoxMetrics` is relative to; the frame-absolute cursor position must be restored
   explicitly.
7. **No new frame row, no behaviour change anywhere else**: no header line, no status change,
   no effect on permissions, tools, trajectory or replay (`turnReducer` keeps producing the
   same history, so live rendering and replay cannot drift).

## Acceptance

- A 120-line answer in a 20-row terminal produces **zero** `ESC[3J` in the raw pty bytes, shows
  the scrolled-out notice while streaming, and still leaves the whole answer in the transcript.
- The regression check can actually fail: an unbounded `maxLiveRows` turns those 0 clears into
  ~60 in the same scenario.
- The block is never taller than the rows it was given, for line-oriented text, one enormous
  unbroken paragraph (the common streaming shape), and a narrow terminal.
- The terminal cursor still lands at the end of the draft on the `you>` row.
- `pnpm typecheck`, `pnpm test`, the full `spike/verify-tui.ts` suite (the frame-height contract
  lives in `approve`; the cursor and streaming-editor contracts in `cursor` / `usage`), and
  `spike/probe-live-frame-overflow.tsx` in both modes.

## Out of scope

- A pasted draft tall enough to overflow the frame on its own. Same mechanism, pre-existing,
  and the fix is a different question (the editor owns that region); recorded rather than
  silently folded in.
- Progressively committing finished lines of the in-flight answer into `<Static>`. It would
  scroll more naturally, but it gives up the invariant that the *assembled* block is what
  enters history — `contentBlockEvent` is authoritative and may differ from the deltas, and
  Static output cannot be taken back.
- Any change to the header's height or content.
