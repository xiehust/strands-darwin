# Bound every participant of the live frame, not just the answer

Child of `08-17-live-frame-round-2`. Round 1 bounded the streaming answer and left this recorded
as out of scope: *"A pasted draft tall enough to overflow the frame on its own. Same mechanism,
pre-existing, and the fix is a different question (the editor owns that region)."* Measurement
since then shows the draft is not the only one left, and that the caps which look like height
bounds are not.

## Goal

No state of the TUI makes the live frame as tall as the viewport — not a tall draft, not an
in-flight tool call with details expanded, not a permission box with long details, not several of
them at once. The user can always see the row they are typing on and the question they are being
asked.

## Background — measured, not assumed

Full numbers and method in `research/probe-results.md`; the two scripts reproduce them and neither
makes a model call.

- **The draft alone**: in an 80x24 pty with this repo's header (a 14-row startup frame), the first
  `ESC[3J` appears at a **13-row draft**, and every further row costs **2** whole-screen clears.
  There is no streaming involved — this is an idle session being typed into, so the bug class is
  wider than "a long answer". The re-emitted frame grows 24 → 402 stripped lines as the overflow
  branch re-prints `fullStaticOutput` per render; here the transcript is nearly empty, in a real
  session it is the entire history, per keystroke.
- **`layoutEditor` has no cap at all**: one visual row per draft row (a 200-line paste is 200
  rows; one 5000-character line is 68 rows at 80 columns).
- **The tool panel's caps are in the wrong unit.** `EXPANDED_INPUT_LINES` (100) and
  `EXPANDED_INPUT_CODE_POINTS` (8000) bound *content*; `ToolCallPanel` then draws each line as a
  plain `<Text>` with no `wrap="truncate-end"`, so Ink word-wraps it. A 300-line file write became
  4 capped logical lines — and **41 terminal rows**. The caps permit ~102 rows at 80 columns, per
  active tool, and `activeTools.length` is itself uncapped.
- **And the tool panel redraws on its own.** `SPINNER_INTERVAL_MS` is 90ms, so an over-tall panel
  clears the screen ~11 times a second with no text arriving at all.
- **`PermissionPrompt`** bounds each detail block (`PERMISSION_DETAIL_LINES` 14,
  `PERMISSION_DETAIL_CODE_POINTS` 500) but not the number of blocks, does not truncate rows either,
  and adds a label row plus a blank row per block and 2 border rows.
- **The floor concedes the overflow.** `liveRowBudget` clamps at `MINIMUM_LIVE_BLOCK_ROWS` (4),
  deliberately "a floor, not a fit". Once the furniture reaches `rows - 5`, that floor *adds* rows
  to a frame which already overflows.
- **A pty cannot grow a draft with `send("\n" + text)`**: a multi-character event with a leading or
  trailing CR/LF is the batched-Enter path (`App.tsx:629`) and submits. Use bracketed paste
  (`ESC[200~ … ESC[201~` → `usePaste`) or one write per key. The first version of the probe got
  this wrong and spent a real model turn measuring nothing.

## Requirements

1. **The invariant is on the total, not per box.** The frame must stay strictly shorter than the
   viewport for every combination of participants. Three individually-bounded boxes still overflow
   together, so there is one budget for the redrawn region and it is divided explicitly.
2. **Bounds are in visual rows at the current width.** Not logical lines, not code points. Content
   caps (`EXPANDED_*`, `PERMISSION_DETAIL_*`) stay what they are — bounds on what is *read* — and
   stop being relied on for height. Anything drawn inside the live frame is pre-wrapped and drawn
   one `<Text wrap="truncate-end">` per row, the way `live-text.ts`/`MessageList` already do it, so
   Ink's own word wrap cannot grow a block past the rows it was granted.
3. **A stated priority order when the viewport cannot hold everything.** It must be written down
   and justified by what the user cannot act without:
   - the permission question (`allow?` and its summary line) and the draft row holding the cursor
     are never the thing that yields — a prompt you cannot see is a prompt you cannot answer, and
     rows Ink dropped are rows you cannot type on;
   - the streaming answer tail yields first (it is already history-bound);
   - then expanded tool detail (a display preference the user toggled and can toggle back);
   - then the draft becomes its own tail/window around the cursor.
4. **What is not shown is stated**, per round 1's rule and in the same voice as
   `hiddenRowsNotice`: a windowed draft says how many rows are above/below, a truncated tool detail
   says it was truncated. A silently short view reads as lost input.
5. **The floor must not be a licence to overflow.** When the furniture alone cannot fit, something
   yields per the order above until the frame fits, instead of clamping to a floor and overflowing.
   A viewport too small for even the reduced set (the question, one draft row, the cursor) is a
   documented limit, not silent corruption.
6. **The draft's content is untouched.** Only what is *drawn* changes: the whole draft is still
   submitted, `usePaste` still inserts the whole paste, the editor's own model
   (`prompt-editor.ts`) keeps producing every row. Windowing happens at render time.
7. **The terminal cursor stays correct.** Any new wrapping `Box` changes what `useBoxMetrics` is
   relative to (round 1's `offset` prop is exactly this trap), and a windowed draft means the
   cursor's frame-absolute row is no longer its row in the layout. The cursor must land on the
   right cell, and must never be positioned outside the visible window.
8. **No new frame row, no header change, nothing else observable.** No effect on permissions,
   tools, trajectory, replay or headless output; `turnReducer` keeps producing the same history.
9. **Measurements never depend on the height they bound**, or the budget oscillates — the same
   constraint round 1 put on `useBoxMetrics`.

## Acceptance

- [ ] Draft: growing the draft to 40 rows in an 80x24 pty produces **0** `ESC[3J` (today: first at
      13 rows, then 2 per row), the draft's visible window states what it is hiding, and the
      cursor stays on the row being edited. Grown by bracketed paste, and the check asserts no turn
      was submitted (so it costs no model call).
- [ ] Submitting a 200-line pasted draft still sends all 200 lines — asserted on the prompt that
      reaches the agent, not on the screen.
- [ ] Tool details: an in-flight tool whose expanded input is 41+ rows produces **0** `ESC[3J`
      across the whole call, including the 90ms spinner repaints, and the panel says the detail was
      truncated.
- [ ] Permission box: a call with two long detail blocks in a 24-row terminal produces **0**
      `ESC[3J`, and the summary line and `allow?` row are both on screen.
- [ ] Combined: streaming answer + running tool + tall draft in a 24-row terminal — still 0.
- [ ] Every new check has been shown able to fail (restore the unbounded render, get the numbers
      in `research/probe-results.md` back).
- [ ] `pnpm typecheck`, `pnpm test`, `spike/verify-live-text.ts`, `spike/verify-prompt-editor.ts`,
      `spike/probe-live-frame-overflow.tsx` in both modes, and the `verify-tui.ts` scenarios that
      see these boxes: `approve` (header + permission box in one frame), `cursor`, `multiline`,
      `chunkedEnter`, `completion`, `toolDetails`, `longAnswer`.
- [ ] `research/probe-results.md` is left as the record of the before-numbers, and the spec
      contract update is deferred to the parent.

## Out of scope

- Progressively committing finished answer lines into `<Static>` — the sibling task
  `08-17-stream-into-static`.
- Changing the content caps for *history*: `<Static>` writes are allowed to exceed the viewport
  (that is what the scrollback is for), so `EXPANDED_RESULT_LINES` and the finished-tool preview
  keep their current sizes.
- Changing what a paste does to the draft, or adding an editor scroll UI beyond the window needed
  to keep the frame legal.
