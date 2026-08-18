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
- **State that changes mid-session moves an existing row; it never adds one.** The header's model
  line carries cache and effort, and its `mode:` row is re-read live from the runtime on every render
  (`/mode`, `.trellis/spec/backend/strands-sdk-contracts.md` § switching the permission mode) —
  `mode:` appears exactly once whatever the mode reads. Anything longer belongs in a notice, which is
  `<Static>` transcript, not frame. When measuring this in a pty, note that `tui.frame` is everything
  after Ink's last frame erase and so includes any notice written since: slice from the header's title
  row before counting.
- `useBoxMetrics` is **parent**-relative while `useCursor` is frame-absolute, and a windowed draft
  moves the cursor's row again: `InputBox` takes its parent's offset as a prop and adds the rows its
  window hides. If the cursor lands in the header after a layout change, this is why.
- A **windowed draft has no `you>` row** (it scrolled out), so `waitForIdle` and `awaitsPermission`
  cannot be used while a tall draft is up — clear the draft first.

## Contract: one semantic visual language, colour optional

`src/tui/visual-language.ts` is the vocabulary shared by `App`, `MessageList`, `InputBox`,
`PermissionPrompt`, and `ToolCallPanel`. Components still own their geometry, but semantic colours
and stable role/state markers must come from that module rather than accumulating unrelated local
literals.

- **Text carries critical state.** ANSI colour and emphasis reinforce the hierarchy; they never
  create it. ANSI-stripped output distinguishes `you>`, `darwin>`, `tool ·`, `info ·`, `warn !`,
  and `error !`; completion selection keeps `❯`; the permission heading and every decision remain
  readable without colour.
- **The header is status-first and compact.** `◆ DARWIN · <state>` leads, followed by the existing
  model/session line (including cache and effort), exactly one `mode:` row, and required loader
  state. Loaded skills, commands, agents and MCP servers are summarized by count rather than dumped
  by name; `/` remains the discoverable inventory. The deterministic 80-column baseline is at most
  eight visual rows, never more than the pre-SER-016 header.
- **Transcript labels do not alter transcript ownership.** Assistant pieces still use `AnswerPart`
  to emit exactly one `darwin>` label and one closing margin, and finished answer text still belongs
  to `<Static>`. Tool and notice markers are prefixes on their existing rows, not new rows.
- **Active controls remain explicit.** The editable composer emphasizes its existing `you> ` prefix
  without changing the five-column editor geometry. Slash and path menus share a textual `❯`
  selection plus visual emphasis. Key ownership and completion row planning do not change.
- **The permission modal is information-equivalent.** Styling may group identity, provenance,
  details and decisions, but exact kind/reason, source, bounded details, queue count, rule offers,
  and reachable `y`, `n`, and `esc` decisions remain. Heading-marker changes must be included in
  `boxGeometry`, so rendered rows and claimed rows remain one calculation.

Required network-free checks: `spike/verify-visual-language.tsx`,
`spike/verify-frame-budget.ts`, and `spike/verify-stream-into-static.ts`. Required pty checks remain
those listed below, including the 120x50 live `approve` scenario for the complete modal.

- The **completion menu is one budgeted block whatever fills it**: title + entries + the `… n more`
  row, capped at `MAX_COMPLETIONS` offered entries, with `planPromptBox` deciding how many survive.
  Both sources — slash commands and `@` workspace paths — draw the same shape, so a menu's *kind*
  never reaches the budget; and anything a source needs to say about itself (a bounded scan, an
  unreadable directory) is a **suffix of the existing title row**, never a row of its own. Contract:
  `prompt-completion.md`.
- The **prompt-recall indicator is one row and a suffix, never a block**: `hasRecall` in
  `promptBoxWanted`/`planPromptBox` buys exactly `RECALL_INDICATOR_ROWS` (1), granted after the menu
  and before the hint, drawn *below* the draft (a row above it would move the frame-absolute cursor
  off the row it is on), and everything the reading has to admit — bounds, skipped prompts, a partial
  read — is appended to that same row. Contract: `prompt-recall.md`.
- Tests required: `spike/verify-frame-budget.ts` (arithmetic **plus** `renderToString` of the real
  components — "what Ink draws is never taller than the grant", which caught the flex rows),
  `verify-live-text.ts`, `probe-live-frame-overflow.tsx` both modes, and `verify-tui.ts`
  `tallDraft` (free) / `tallDraftStreaming` / `approve` / `cursor` / `completion` /
  `pathCompletion` / `recall` / `longAnswer`. Unbounding the draft turns `tallDraft`'s 8 passes into 4
  failures.

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

## Contract: markdown styling is a projection over the committed text, never a rewrite of it

Assistant answer text — history pieces and the live region — is drawn with markdown-aware styling
(`src/tui/markdown.ts` pure and dependency-free, `src/tui/MarkdownText.tsx` the renderer): headings
bold with a dim `#` marker, `**bold**`/`*italic*` emphasized, inline and fenced code in
`markdownCodeColor`, fence delimiters/rules/inline markers dim. Syntax highlighting by language is
deliberately out of scope.

- **Every character is kept.** Markers are de-emphasized in place, never stripped: concatenating a
  line's spans reproduces the line byte for byte, so ANSI-stripped output *is* the committed plain
  text, pty assertions keep matching answer substrings, and `formatReplay` (`/export`, replay) is
  byte-identical to before the feature existed — proven against real recorded sessions, not assumed.
  `turn-state.ts` still commits exact plain lines; reconciliation and the divergence warning compare
  plain strings.
- **Fence state across pieces is one boolean, decided at push time.** `<Static>` never redraws, so
  each assistant piece carries `codeOpen` — `fenceOpenAfter(committedAnswer)` when it is pushed —
  and the live region derives its own initial state with the *same function over the same string*
  (`liveCodeOpen` in `App`), which is what makes a live re-render unable to disagree with what
  `<Static>` already wrote. The fence classifier is therefore a boolean toggle by design (any
  ```` ``` ````/`~~~` line opens; inside a block a bare one closes): a classifier needing the
  opening fence's character or length would need more state than the reducer carries.
- **The Ink traps still bind.** A history piece is ONE outer `<Text>` whose children are nested
  styled spans and literal `'\n'` strings — an empty `<Text>` renders **zero** rows (measured), so
  one-`<Text>`-per-line would swallow the blank lines a paragraph break committed. A live row stays
  ONE `<Text wrap="truncate-end">` and the row list is exactly what `liveTextView` counted; rows
  carry their source line index (`LiveRow.line`) so tone needs no second wrapping calculation, and a
  row that is not its whole logical line falls back to whole-row tone rather than re-deriving inline
  spans against transformed text.
- **Scope is answers only.** User messages, notices, tool output, the prompt editor and dev-repl are
  untouched; `_underscore_` emphasis is deliberately not recognized (snake_case identifiers are far
  more common in answers than underscore emphasis).

Tests required: `spike/verify-markdown.tsx` (module invariants, reducer-carried fence state,
ANSI-strip equality, `formatReplay` byte-stability — force color first via `spike/force-color.ts`,
or the "styling happened" assertion passes vacuously on a pipe), the markdown section of
`spike/verify-visual-language.tsx`, and the pty scenarios above unchanged.

## Contract: the only sanctioned whole-screen clear is `/clear`, and it costs two things at once

`<Static>` cannot be recalled, so "reset the transcript" means clearing the terminal — the same
`ESC[2J ESC[3J ESC[H` Ink writes in its pathological branch. That is not a contradiction of the
budget above: the rule is *never per render*. `/clear` writes it **once**, from the submit handler,
on explicit user action, and `spike/verify-tui.ts clear` asserts the count is exactly 1.

Two mechanisms are needed, and either one alone is a bug:

- **Write it through Ink**, `useStdout().write(...)`, not `process.stdout.write`. Ink's
  `writeToStdout` clears its live frame, writes the data, then restores the frame (`restoreLastOutput`
  replays the frame only, never the static transcript), so the escape sequence cannot land in the
  middle of a repaint.
- **Remount `<Static>`** by changing its React key (`TurnState.staticEpoch`, passed to `MessageList`).
  Ink accumulates every byte `<Static>` has written in `Ink.fullStaticOutput` and re-emits it on the
  next whole-screen redraw; emptying `items` does not touch that buffer. `reconciler.js` fires
  `onStaticChange` when the `<Static>` node identity changes and `handleStaticChange` resets the
  buffer — a key-driven remount is the supported reset. Without it the cleared transcript reappears
  the first time a frame overflows.

Whatever holds per-session UI state resets with it (`contextWarnLatch`, the one-shot trajectory and
diagnostics problem notices); a *display preference* like `toolDetailsExpanded` does not — it belongs
to the user, not to the conversation.

Tests required: `spike/verify-tui.ts clear` (free — no model call) for the single clear, the gone
transcript and the usable prompt; `spike/verify-clear-session.ts` for what the switch does off-screen.
