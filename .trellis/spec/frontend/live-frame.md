# The live frame: one row budget, and what leaves it

> How the redrawn part of darwin's TUI decides its height, and why finished answer text belongs to
> `<Static>` rather than to the frame. Split out of `tui-testing.md`, which is injected as context
> and truncated past 32 KB.
>
> Pty-testing mechanics (anchored waits, idle detection, exit assertions) stay in
> `tui-testing.md`; the required checks for this area are listed at the end of each contract below.

## Contract: the live frame is one shared row budget

**Nothing that is redrawn may make the live frame as tall as the terminal.** Ink 7 does not clip
an over-tall frame, it changes strategy — `shouldClearTerminalForFrame()` in `ink/build/ink.js`
returns true as soon as `outputHeight > rows`, and that branch writes `clearTerminal + the entire
static transcript + the frame` **directly to stdout**, bypassing the throttled log. `clearTerminal`
is `ESC[2J ESC[3J ESC[H`: the screen *and the scrollback*. At delta rate that is a strobing screen
and a destroyed transcript. The limit is `rows - 1`: Ink calls a frame fullscreen at
`outputHeight >= rows` and clears when the next one shrinks below that (`isLeavingFullscreen`).

Every redrawn participant is in scope: measured, a 13-row draft in a 24-row terminal costs 2 clears
per further row with nothing streaming, and one in-flight call with details expanded draws 41 rows
(`tasks/archive/2026-08/08-17-live-frame-chrome/research/`).

- **One budget, handed out, not measured.** `src/tui/frame-budget.ts` divides
  `rows - 1 - header - thinking` between prompt region, tool panel and answer, in that priority
  order. Only the **header** is measured (`useBoxMetrics`) — its height depends on nothing below
  it; measuring the boxes being bounded is what oscillates.
- **Priority follows what the user cannot act without**: the draft row under the cursor and the
  question asked never yield, expanded detail yields before them, the answer yields first
  (`<Static>` already holds its text in full). A **share ceiling** — no more than half while
  something lower wants rows — stops the first served taking everything; the permission box is
  exempt (`modal: true`) because the loop is blocked on it. Without that exemption it lost its last
  detail row, which is where `… truncated N code points` lives.
- **Heights are counted in visual rows at the current width**, through the same helpers the
  components render from. `EXPANDED_INPUT_LINES` / `PERMISSION_DETAIL_LINES` bound what is *read*:
  4 capped logical lines measured 41 terminal rows.
- **A row whose height must be known is one `<Text>` with nested spans.** Several `<Text>` children
  of a `<Box>` are flex items and wrap independently — that made the permission summary two rows
  and ate the `] ` after `[parent`. Pre-wrapped content is one `<Text wrap="truncate-end">` per row.
- **What is hidden is stated**, one row each: scrolled-out answer lines, draft rows above/below,
  cut tool input, collapsed tool calls, cut permission detail.
- `useBoxMetrics` is **parent**-relative while `useCursor` is frame-absolute, and a windowed draft
  moves the cursor's row again: `InputBox` takes its parent's offset as a prop and adds the rows its
  window hides. If the cursor lands in the header after a layout change, this is why.
- A **windowed draft has no `you>` row** (it scrolled out), so `waitForIdle` and `awaitsPermission`
  cannot be used while a tall draft is up — clear the draft first.
- Tests required: `spike/verify-frame-budget.ts` (arithmetic **plus** `renderToString` of the real
  components — "what Ink draws is never taller than the grant", which caught the flex rows),
  `verify-live-text.ts`, `probe-live-frame-overflow.tsx` both modes, and `verify-tui.ts`
  `tallDraft` (free) / `tallDraftStreaming` / `approve` / `cursor` / `completion` / `longAnswer`.
  Unbounding the draft turns `tallDraft`'s 8 passes into 4 failures.

## Contract: a finished answer line belongs to `<Static>`, not to the live frame

Answer text is committed to history **while the turn runs**: every complete line up to but not
including the last non-blank one (`commitFinishedLines`, `src/tui/turn-state.ts`). A line-oriented
answer then needs no tail; the tail stays load-bearing for the shape with no finished lines, one
unbroken paragraph. It is *cheaper* — 30,675 bytes against 60,040 for a 120-line answer, since the
alternative redraws the whole tail per delta
(`tasks/archive/2026-08/08-17-stream-into-static/research/`).

- **`<Static>` cannot be recalled**, so nothing provisional enters it. The last non-blank line is
  held back, and trailing blank lines with it — the assembled block trims its end, and committing a
  trailing blank line made a clean answer report a divergence.
- **The authoritative block still decides.** `contentBlockEvent` is reconciled against
  `committedAnswer`: a continuation commits the remainder; a real disagreement is **stated** as a
  `warn` notice with the authoritative text in full. No ordinary model can reach that branch (the
  SDK's base `Model.streamAggregated` assembles the block from the deltas it just yielded), so it is
  exercised at the reducer, not through a fake provider.
- **The label and the blank row belong to specific pieces.** `AnswerPart` is
  `whole | first | middle | last`: label on `whole`/`first`, bottom margin on `whole`/`last`. Ink
  fixes a margin when it writes the entry, so this cannot be decided later — and `formatReplay` must
  respect the same flags or a replay prints one `darwin>` per piece.

Two assertion traps, both paid for once:

- Do **not** assert "appears exactly once" against accumulated pty output: every row that passed
  through the live tail was drawn once per repaint. Duplication is asserted over the reducer's
  history and over `formatReplay` (`spike/verify-stream-into-static.ts`, which also drives a real
  offline `Agent`).
- Do **not** assert the scrolled-out notice on a line-oriented answer — that asserts the *absence*
  of this contract. `longAnswer` and `tallDraftStreaming` both carried such an assertion from the
  previous round and had to move it: `longAnswer` onto a deliberate unbroken-paragraph turn,
  `tallDraftStreaming` onto the draft's own window notice sampled mid-answer.

Tests required: `spike/verify-stream-into-static.ts` (pure, plus one offline `Agent`), and the pty
scenarios `longAnswer` and `tallDraftStreaming`. `verify-trajectory.ts` covers replay agreeing with
the live reducer.
