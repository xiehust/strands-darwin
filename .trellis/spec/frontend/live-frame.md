# The live frame: one row budget, and what leaves it

## React production import is part of the frame memory bound

The interactive CLI must select `NODE_ENV=production` while it performs the first dynamic imports of
React, Ink, `StartupScreen`, and the rest of the TUI graph. `src/tui/react-environment.ts` owns that
narrow import-time override and restores the caller's environment immediately afterwards; headless,
`sessions`, and trajectory commands do not pass through it.

This is a memory-safety contract, not a rendering optimization. React 19's development reconciler
calls `performance.measure()` for component commits, and Node retains those User Timing entries until
they are explicitly cleared. The existing 90 ms `App` busy tick therefore grows heap even while a
provider emits no event. Do not work around it by disabling the spinner, periodically clearing the
process-global performance timeline, increasing Node's heap, or changing direct streaming.

`spike/verify-react-production-memory.ts` checks the import-time override/restoration and runs a real
Ink busy frame for 10,000 accelerated ticks in a 96 MiB child heap, beside a 2,000-tick development
control. It requires the control to retain thousands of measures, the production path to retain zero,
and forced-GC heap/RSS to stay bounded. The paired worker is
`spike/verify-react-production-memory-worker.tsx`.

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
  cut tool input, collapsed tool calls, cut permission detail. Completion overflow uses its existing
  one row for a total plus truthful `above`/`below` counts; the entries are a bounded window around
  the selected full-list candidate, so `❯` never leaves the granted rows.
- **Long subagent progress moves the existing tool row.** `SRF-015` safe phase updates and ≤30 s
  heartbeats attach to the active parent `subagent` call by its stable dispatch id; the one row
  shows elapsed plus only `starting`, `model`, or a bounded tool name. It adds no participant,
  claim, transcript notice, or timer in React. Parallel children remain one row each, and
  `planToolPanel` keeps the existing `… N more tool calls running` omission row when the grant
  cannot show them all. `/agents cancel <id>` is handled above busy queueing as a user-only local
  control; it does not enter the prompt queue or model context. Required check:
  `spike/verify-subagent-heartbeats.ts`.
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
- Escape dismissal creates no participant or row. Closing completion removes only the menu's existing claim; ending recall removes only its existing one-row indicator. Draft layout, cursor, queue, tools, answer, and transcript remain untouched.



### Parent progress checklist (`SER-036`)

The latest successful `update_plan` replacement is transient `TurnState.livePlan`. It is a first-class
frame participant after running tools and before the queue/answer: `wanted = item count + title`, floor
1 when present. `PlanChecklist` receives only the exact grant and emits one
`<Text wrap="truncate-end">` per formatted row, so a 200-code-point item is still one visual row at
narrow widths. The final Static projection intentionally uses the same one-row truncation policy:
its bounded item count is also an honest visual-row bound rather than an invitation to wrap.
A one-row grant states `plan · N items`; a partial list spends its final granted row on
`… N more plan items`, so hidden work is never silently cut. ASCII markers remain semantic without
colour: `[ ]` pending, `[>]` in progress, `[x]` completed.

Successful `update_plan` events enter the reducer immediately through `streamEvent`, replacing
`livePlan` while the turn is still open. `turnEnded` **appends** exactly one bounded `plan` item after
everything the turn already committed, then clears `livePlan`. Appending is load-bearing, not a style
choice: Ink's `<Static>` consumes its `items` array by index (`items.slice(index)`), so an insert
before entries already written shifts the committed suffix back into the unconsumed window — the
closing answer is then written to the terminal a second time (the reported duplicate-final-reply bug,
sessions 2026-08-27/28/30) while the checklist itself is silently swallowed. `turnEnded` must extend
`history` without moving any existing entry; `spike/verify-update-plan.tsx` asserts that prefix
stability directly and `spike/probe-final-reply-duplication.ts` reproduces the terminal-level
duplication against any regression. The live checklist rows above the frame remain the in-turn
presentation; the appended projection is the turn's terminal record.
Failure/cancellation paths use the same terminal projection. Repeating the terminal action or starting
the next user turn cannot duplicate or retain the live list. An unfinished list is advisory and never
starts another model turn. The final projection uses the same markers, shows at most 10 items plus
title/hidden-count rows, and is TUI history only; replay/export retain the ordinary tool row and
deliberately omit this UI-local final projection.

Required checks: `spike/verify-frame-budget.ts`, `spike/verify-update-plan.tsx`, and free pty
`spike/verify-tui.ts updatePlan`.


## Contract: startup owns the terminal before App, then leaves completely

Interactive startup renders `StartupScreen` on one Ink instance before `AgentRuntime.create()`
begins. While runtime/config/MCP/session setup is pending it may animate only an honest
`initializing` state; once a resumed runtime exists, the same root may say `restoring session`
while `loadResumeRecap()` runs. The CLI then `rerender()`s that exact Ink instance with `App` as
soon as the awaited work settles — there is no minimum display duration and no second renderer.

- Startup is **pre-App**, not a new participant in `frameBudget`: after handoff no startup row,
  interval, marker, input handler, transcript item, or ready-header motion remains.
- `StartupScreen` uses Ink components and `useWindowSize`; it does not write terminal bytes or own
  input. Wide/roomy mode is at most three rows, while width below 34 columns or height below five
  rows is one row; very narrow mode uses compact `D` plus motion and `i`/`r` state markers rather
  than truncating identity or state. Every frame keeps those semantics after ANSI stripping.
- Motion means only “the awaited initialization has not settled”; do not invent percentages,
  completed stages, or provider progress. One interval advances a fixed bounded sequence and React
  cleanup clears it on handoff, failure, or unmount.
- A runtime creation failure unmounts and awaits Ink before the existing config/session error is
  written. A recap failure additionally closes permissions and shuts down the acquired runtime.
  Successful ownership remains unchanged: the ordinary App exit closes permissions and runtime.

Required checks: `spike/verify-startup-screen.tsx` for deterministic motion, layout, interval
cleanup, and no side channel; `spike/verify-startup-pty.ts` for delayed-runtime ordering, complete
handoff, usable input, known-error cleanup, and byte-identical resumed startup. Re-run
`verify-frame-budget.ts`, `verify-visual-language.tsx`, and free pty `completion`, `clear`, and
`resume` when this boundary changes.

### The ready welcome is one-shot Static scrollback, not startup or frame furniture

When the interactive App first replaces `StartupScreen`, `WelcomeHeader` is the first
presentation-only item committed through `MessageList`'s existing `<Static>`, ahead of transcript
history. (Adjacent Ink Static owners do not commit independently, so this shared owner is required.)
Wide terminals receive the complete five-line wordmark, medium terminals a complete three-line
wordmark, and narrow or short terminals `◆ DARWIN`; selection happens in the pure
`welcomeLayout(columns, rows)` helper, and no selected line may wrap or truncate. The initial
layout value is captured once at App mount: a later terminal resize must not mutate an item already
committed by `<Static>`. Wide and medium forms add only their muted tagline and closing margin.

The welcome is once per interactive **process**, for fresh and resumed launches. It is not a
`HistoryItem`, trajectory/replay/export content, model message, measured header row, or frame-budget
claim. Its first-item position makes it precede resumed-session recap history. App remains mounted
when `/clear` replaces the runtime; the remounted transcript Static omits the welcome, so it is never
emitted again. `/clear` may still remove its earlier terminal bytes as part of
the explicitly sanctioned screen-and-scrollback clear. Headless mode has no welcome.

Required checks: responsive rows and widths in `spike/verify-startup-screen.tsx`; fresh/resumed
ordering, settled-frame absence, local-command stability, and `/clear` non-repetition in
`spike/verify-startup-pty.ts`. Keep `verify-frame-budget.ts` green to prove the live frame did not
grow.


## Contract: the busy rows are alive, and stay exactly the rows they were

While a turn streams, the `working…` hint and the `thinking…` row carry a live suffix — elapsed
turn time plus the session's reported token spend (`src/tui/busy-suffix.ts`, SER-022) — with no
new frame row, no new tick source, and no new information channel.

- **The suffix rides directly behind the busy word**, ahead of the static command hints: both rows
  are one `<Text wrap="truncate-end">`, so they can never wrap or grow a row at any width, and on
  a narrow terminal the tail that truncates is the part that never changes. The hint's claim in
  `promptBoxWanted` (`hasHint`, 2 rows) and `thinkingRows = 1` therefore stay correct untouched.
- **One tick, one synchronous read.** The existing spinner interval (only while
  `effectiveStatus === 'streaming'`) is the only clock; the render recomputes elapsed from a
  per-turn `Date.now()` ref (set in `runTurn`, cleared in its `finally`, so cancelled and failed
  turns stop the readout with the tick) and reads spend from `runtime.usage` — the SDK's
  in-memory accumulator, which counts a model call when it *finishes*, the same lagging reading
  mid-turn `/usage` reports as "not counted yet". Never a second interval, never I/O per frame.
- **Honesty is the `usageBuckets` rule.** The spend shown is `usageBuckets(runtime.usage, config)`:
  an unreported metric (`input === undefined` on OpenAI Responses without cache detail) is absent
  from the suffix, never rendered as 0; a genuinely zero accumulator renders `↑0 ↓0`; a meter read
  that throws degrades to the elapsed-only suffix (the `startTurnSpend` cannot-throw precedent).
  The `thinking…` row carries the reduced, elapsed-only suffix — both rows can be on screen at
  once, and stating the spend twice in one frame is noise.

Required checks: `spike/verify-busy-suffix.ts` (free, in `pnpm test`) and the live
`verify-tui.ts usage` scenario, whose mid-turn half asserts the readout is present and that a
second elapsed reading appears while the turn still runs.

## Contract: a busy submission queues — visibly, boundedly, and unsent until idle

**SER-027, 2026-08-19, deliberately supersedes SER-010's "retained, never queued" busy-submit
contract by explicit user product decision** (`docs/research/research_2026-08-19.md`, addendum
`02:01:06Z`). A submission while a turn streams or a `!` command runs (`status` `streaming` or
`shell`) leaves the editor and joins a FIFO queue (`src/tui/prompt-queue.ts`, App state); when the
session returns to idle the queue **drains one entry at a time through the ordinary `submit()`
path** — each queued prompt its own turn, each queued `!` its own run. Next-turn-only delivery:
nothing is ever injected into a running SDK stream.

- **What queues, exactly.** Prompts, skill/command expansions and `!` commands queue. Local
  report/control commands (`/usage`, `/effort`, `/mode`, `/permissions`, `/tasks`, `/agents`,
  `/context`, `/trajectory`, `/export`, `/mcp`, `/status`) keep answering mid-turn immediately —
  they sit above the busy check, as before. `/clear`, `/compact`, `/model`, `/exit` and `/quit`
  **refuse** with a `… does not queue` notice, draft retained — the one place SER-010's retention
  shape deliberately survives (`refusesToQueue`): a session-replacing command run minutes later,
  unprompted, is worse than a second Enter. Compaction still owns the whole keyboard, so nothing
  can queue during it.
- **The listing is counted rows, bounded, above the input box.** `QueuedMessages.tsx` draws one
  `queued · <entry>` row per entry (newlines shown as `⏎`, one `<Text wrap="truncate-end">` per
  counted row), a sibling of the input box inside the chrome column — so `InputBox`'s
  parent-relative metrics absorb its height and the frame-absolute cursor stays on its draft row.
  It is a fourth `frameBudget` participant (`queued` claim, granted after tools and before the
  live answer, floor 0); `planQueueList` keeps the head (next to send) and states the cut with
  `… n more queued`. The **busy hint carries ` · N queued`** (`queuedCountHint`) behind the live
  readout, ahead of the static hints, on both the `working…` and `running ! command…` rows — a
  listing cut to zero rows is still counted, so nothing invisible accumulates.
- **`Up` takes the queue back** — see `prompt-recall.md` for the full key-precedence chain. One
  press returns every entry to the editor, one per line, **ahead of any typed text**, cursor at
  the end; the queue empties and nothing is sent.
- **A cancel or a failed turn never silently sends the queue.** Ctrl+C (streaming or shell) and a
  turn error mark the busy state aborted; when it ends, `returnQueuedToEditor` puts the entries
  back in the editor with a `… returned to the editor, not sent` notice. A `!` timeout is not a
  cancel — the user asked for nothing — so the queue drains normally after it.
- **A pending permission holds the queue untouched.** The prompt owns the keyboard (unchanged),
  so the queue can neither grow nor drain while one is up; the listing stays rendered beside the
  permission box. The drain effect also refuses to fire while `/clear` assembles a successor, and
  `/clear` drops the queue with the conversation.
- **Trajectory honesty is structural.** Enqueueing dispatches nothing and records nothing; a
  drained entry becomes a `userInput` transcript row and trajectory line at send time, exactly as
  sent; an entry taken back, cancel-returned or dropped by `/clear` was never sent and leaves no
  record — so prompt recall (a reader over sent prompts) needs no change.

Required checks: `spike/verify-prompt-queue.ts` (free, in `pnpm test`: the refusal set, row
projection, take-back composition, hint segment, budget arithmetic, rendered height never above
the grant), `spike/verify-tui.ts queue` (free pty: listing, take-back ordering with typed text,
cancel return, `/clear` refusal, recall untouched, no `userInput` record), `bang` (free: a queued
`!` drains and runs after the running one) and the live `usage` mid-turn half (a queued prompt
drains into its own real turn, no second Enter).

### Clipboard attachment chip

A pending clipboard image claims exactly one prompt-region row. `promptBoxWanted` counts it and `planPromptBox` grants it after completion/search chrome but before recall/hint informational rows; when granted, `InputBox` draws one `Text wrap="truncate-end"`. The row states bounded format/size and the removal gesture only. Queue rows remain one truncated row and state `[image]` without bytes. No image introduces a header, modal, permanent frame surface, animation, or second budget.

### `/memory` remains transcript history

`/memory` has no header field or live-frame row. The strict local report is one bounded existing notice (`≤48` lines, `≤180` code points per line). It runs only while idle; busy use is refused rather than queued because changing the assembled prompt during a request would race the model-visible context. Completion and `/help` use the canonical built-in registry, and `MAX_COMPLETIONS` must cover every built-in.


## Contract: one semantic visual language, colour optional

`src/tui/visual-language.ts` is the vocabulary shared by `App`, `MessageList`, `InputBox`,
`PermissionPrompt`, and `ToolCallPanel`. Components still own their geometry, but semantic colours
and stable role/state markers must come from that module rather than accumulating unrelated local
literals.

- **Text carries critical state.** ANSI colour and emphasis reinforce the hierarchy; they never
  create it. Brand identity, assistant/tool identity, active work, selection and information use one
  cyan accent; green/yellow/red are reserved for success/warning/error and diff semantics. Muted
  metadata uses dimmed default foreground rather than fixed gray, preserving contrast across light
  and dark terminal themes. The composer and selected completion use stable text plus accent/bold,
  never reverse-video background treatment. ANSI-stripped output distinguishes `you>`, `darwin>`,
  `tool ·`, `info ·`, `warn !`, and `error !`; completion selection keeps `❯`; the permission
  heading and every decision remain readable without colour. The durable `info ·` prefix alone
  carries the shared informational accent; its report body stays at normal terminal intensity with
  no dim SGR. This presentation is owned by the common notice renderer, so command reports never
  select their own styling.
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
- A **running `!` command adds no frame surface** (SER-024): it *is* an entry in the existing tool
  panel — spinner row, elapsed suffix, and detail rows holding a bounded live output tail
  (`liveShellTail`: last `SHELL_LIVE_TAIL_LINES`/`SHELL_LIVE_TAIL_POINTS`). The one difference from
  a real tool is that its detail rows are always visible, and that difference lives in **one
  predicate** — `toolDetailsVisible` in `frame-budget.ts` — used by both the claims computation in
  `App.tsx` and the panel, so counted and drawn stay one answer. Its status hint is the existing
  hint row (`hasHint`), its header state moves the existing `·` status word, and the finished row
  is `<Static>` history. An idle frame, and the 120x50 `approve` frame, gain nothing.
  Free checks: `verify-tui.ts bang`, `verify-shell-command.ts`.
- Tests required: `spike/verify-frame-budget.ts` (arithmetic **plus** `renderToString` of the real
  components — "what Ink draws is never taller than the grant", which caught the flex rows),
  `verify-live-text.ts`, `probe-live-frame-overflow.tsx` both modes, and `verify-tui.ts`
  `tallDraft` (free) / `tallDraftStreaming` / `approve` / `cursor` / `completion` /
  `pathCompletion` / `recall` / `longAnswer`. Unbounding the draft turns `tallDraft`'s 8 passes into 4
  failures.

## Contract: `/help` is bounded Static transcript, never frame furniture

`formatHelpReport` is a pure local projection. `App` handles `/help` before the busy guard and
dispatches the result through the existing `notice` action, so it is written once by `MessageList`
into `<Static>` history. It adds no Header row, component, budget claim, live hint, queue row, tool
event, or other redrawn surface. It calls no runtime accessor and performs no I/O or network work.

The command rows come directly from the canonical `BUILTIN_COMMAND_NAMES` and
`BUILTIN_COMMAND_DESCRIPTIONS`; the formatter's finite command, line, and per-line code-point caps
bound the transcript entry, and omission must be stated if the command cap is ever reached. The line
cap is **derived, not hand-picked**: `MAX_HELP_LINES === MAX_HELP_COMMANDS + HELP_FIXED_LINES`, where
`HELP_FIXED_LINES` counts the title, the command-section header, both fixed blocks and the one-line
overflow notice. A filled command inventory therefore can never make `slice(0, MAX_HELP_LINES)` drop a
documented control; adding a fixed row means raising `HELP_FIXED_LINES` with it. The fixed key facts
must name every shipped composer chord — including `SER-042`'s word jumps (`Alt`/`Ctrl`+arrow,
`Alt+B`/`Alt+F`) and word deletions (`Alt+Backspace`/`Alt+D`) and `SER-044`'s undo (`Ctrl+_`, `Ctrl+-`)
— and both READMEs plus `docs/user-guide/reference*.md` state the same chords in the same vocabulary.
Any whitespace-separated argument is rejected by the same pre-busy local branch. Required checks:
`verify-help-command.ts` for canonical content and explicit bounds, and free pty `verify-tui.ts
completion` for idle/busy projection, argument rejection, queue stability, and absence from the
latest live frame.

## Contract: resumed context is startup Static history, never frame furniture

`SER-028` seeds `turnReducer` history with the full replayed session transcript only when an
interactive runtime actually restored SDK messages. `MessageList` writes those entries through its
existing `<Static>` exactly once, before the input prompt. They are terminal scrollback/history: not
a Header row, not a chrome claim, not re-rendered live state, and not part of `frameBudget` — which
is why the transcript can be unbounded (scrollback length equals session length) without touching
the budget. Fresh sessions pass no startup history, so their frame baseline is byte-for-byte the
pre-feature shape. `/clear`'s existing `clear` action empties the recap and remounts Static with the
old transcript.

The replayed rows are `replayRecords` output verbatim — no per-row truncation beyond what the record
itself carries; source/degradation notices are fixed one-line entries. A real `120x50` pty resume
fixture asserts the latest live frame still fits 50 rows while the multi-turn transcript precedes
`you>`.

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
- **Closing a live tail is a two-render terminal handoff.** A text `contentBlockEvent` would otherwise
  remove the mutable tail and append the same text to `<Static>` in one Ink render. On a scrolled
  terminal the old live rows can then escape into scrollback before Static writes them again. The
  interactive driver dispatches a monotonically identified `prepareAnswerClose`, awaits a React
  layout-effect acknowledgement of that specific answer-free commit, then awaits Ink's public
  `waitUntilRenderFlush()` before publishing the unchanged content-block event through `turnReducer`.
  Cancellation/unmount resolves pending acknowledgements so stream consumption cannot hang. This
  exception is close-boundary-only: deltas, tools and every other event remain directly streamed, no
  text is deduplicated, and the transient action changes neither `committedAnswer` nor replay/trajectory.
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

## Contract: high context pressure is one transcript notice, never a live-frame participant

After a completed turn, `App` checks `AgentRuntime.contextEstimate()` through the existing
`createContextWarnLatch`. The threshold has one owner: configured `contextWarnRatio` (default `0.8`;
custom ratios remain authoritative; `0` disables it). SRF-010 does not add a second threshold or a
second notice at the same crossing. At or above the ratio, a known positive model window emits one
bounded single-line warning recommending that the user consider `/compact` before the next broad
implementation or verification turn.

The notice is ordinary finished `TurnState.history`, rendered once by `<Static>`. It is not a header,
busy, prompt, queue, tool, or answer row and therefore adds no participant to `frame-budget.ts`.
Darwin never invokes compaction from this path: `/compact` remains user-controlled and this check adds
no conversation mutation, timer, channel, or mid-turn work. Remaining above the threshold is silent;
a later **known** below-threshold estimate re-arms the latch (including after a successful user-run
`/compact`). Unknown/zero/negative/non-finite windows, invalid token estimates, and estimation
failures cannot mean pressure and cannot re-arm a latched crossing. `/clear` replaces the latch with
fresh successor-session state under the existing per-session reset contract below.

Tests required: `spike/verify-context-format.ts` pins threshold/crossing/re-arm/disabled/unknown
behavior, bounded wording, one transcript notice, and empty live-turn state. Keep
`verify-frame-budget.ts`, `verify-prompt-queue.ts`, `verify-resume-recap.ts`,
`verify-clear-session.ts`, `verify-compact.ts`, and `verify-status-command.ts` green.


An unrecovered `ContextWindowOverflowError` uses the ordinary failed-turn Static notice and the shared bounded driver projection: provider detail plus `/compact`, a narrower retry, or `/clear`. It adds no live-frame participant, row, automatic retry, or compaction. The existing failed-turn path still marks the busy state aborted and returns queued prompts to the editor unsent. The offline real-pty `spike/verify-tui.ts contextOverflow` scenario proves the notice, no continuation, and that the same session returns to an executable prompt.


## Contract: the terminal attention bell is a raw control byte, never a frame participant (SER-043)

With `terminalBell: true` (default `false`), the interactive driver writes exactly one BEL
(`\x07`) to the **real stdout** at each of the two existing driver-owned lifecycle publication
points: a permission prompt being published to the user (the `PermissionQueue` observer wiring in
`cli.ts` `runInteractive`, which already de-duplicates re-asks of one prompt identity) and a turn
completing (next to `observeTurnComplete(..., 'interactive')` in `App`'s `runTurn` finally, any
outcome). `src/tui/terminal-bell.ts` is the only writer.

BEL is a non-printing control byte written between Ink renders, so it is not a row, not a budget
participant, and invisible to ANSI-stripped assertions, `/export` byte-stability and replay. It is
never emitted per frame render, never from headless drivers, never for child agents, and never
inside lifecycle hook command execution. Disabled performs no write at all — the default path stays
byte-identical to before the feature existed — and a throwing stdout is swallowed.

Tests required: `spike/verify-terminal-bell.ts` (unit contract plus real-pty raw-byte counts for
both config states, no model call) and the `terminalBell` block in `spike/verify-config.ts`.


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

## Contract: successful turns stream directly

There is no successful-turn exception to line-by-line `<Static>` commitment. `App.runTurn` dispatches
ordinary SDK events as they arrive, so finished tool rows, live checklists, and complete assistant
lines can be visible before the terminal event. `turnEnded` only flushes the remaining tail and
finalizes transient state; it must not replay already-consumed events or start another model turn.
The busy owner and SER-027 queue still span SRF-001 stream-interruption recovery exactly as before.
Required checks: `spike/verify-stream-into-static.ts`, `spike/verify-update-plan.tsx`, and free pty
`spike/verify-tui.ts updatePlan` with a deliberately delayed terminal event.

## Reverse prompt-history search rows (SER-039)

The `Ctrl+R` surface lives inside the existing prompt-region claim; it adds no header or permanent frame row. `promptBoxWanted` and `planPromptBox` count one truncated title row, at most five truncated match rows, and one truncated omission row. The title carries loading/empty/no-match state plus reader degradation; the omission row counts hidden newer/older matches. A short grant keeps the editor cursor row and search title, states omissions when one row remains for that purpose, and never draws a partially granted row. While search is open it replaces completion/recall chrome rather than stacking another uncounted surface.
