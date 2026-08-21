# TUI Testing (Ink through a real pty)

> How interactive TUI behavior is verified in this project. Established while building
> `spike/tui-driver.ts` / `verify-tui.ts` / `acceptance-e2e.ts`; every rule below was a
> real bug or false-positive first.

---

## Method

Ink requires a TTY (raw-mode stdin, ANSI cursor writes); a plain pipe silently drops to
non-interactive mode. Tests therefore spawn the **real CLI in a node-pty pseudo-terminal**
(`spike/tui-driver.ts`) and assert against accumulated output with ANSI stripped. Because
Ink repaints by rewriting lines, the buffer holds *every frame ever drawn* — which is the
right shape for "did this ever appear on screen".


For resumed-startup UI, run free scenario `pnpm tsx spike/verify-tui.ts resume`. Seed the fixture with
a real local SDK `Agent` + `SessionManager` snapshot and the real `TrajectoryRecorder`, then launch
the real CLI with `--resume <id>` at 120x50. Anchor on the settled prompt and assert recap/request/
answer ordering before it, the latest-frame row bound, and state-exclusive fresh-session absence.
Hash `trajectory.jsonl`, `snapshot_latest.json`, and `last-session.json` before and after startup;
also compare trajectory line count. Exit from the first prompt with a deliberately invalid provider
model id, so any accidental model/network call fails the scenario rather than passing silently.

## Multiline input contract

### 1. Scope / trigger

Any change to `App` input handling or `InputBox` rendering crosses the terminal-event → draft-state → rendered-frame → submitted-prompt boundary. Verify it through the real pty, not by rendering the component alone.

### 2. Signatures

- Ink `usePaste((text: string) => void)` owns bracketed paste events.
- Ink `useInput((typed, key) => void)` owns keys: CR/plain Enter submits, LF/Ctrl+J inserts a newline.
- Terminals may send printable text plus CR/LF/CRLF as one `typed` value with `key.return === false`; the line-ending run may lead or trail the printable text and is one submit terminator.
- A draft ending in `\\` turns Enter into continuation and consumes the marker.

### 3. Contracts

- Draft line endings are canonical LF. Normalize CRLF and CR before inserting.
- Keep an immediate ref mirror beside React draft state. Multiple stdin events may arrive before React renders; handlers that submit/continue must read the mirror, not a stale render closure.
- Preserve LF and tab; drop other C0 controls and DEL.
- Paste never submits. It inserts the entire payload at the cursor, including all line breaks.
- Render the first logical line after `you> ` and later explicit lines after `...> `; soft-wrapped rows align under the content. Cursor, arrows, Home/End, and deletion use grapheme boundaries and terminal-cell widths.
- Plain Enter still submits, and slash completion still takes Up/Down/Enter precedence when shown.
- Do not enable terminal mouse tracking: native scrollback and drag-to-select take priority over click-to-position editing.
- A permission prompt owns paste and keyboard input while visible.
- Editor editability and agent availability are separate contracts. While streaming, keep normal draft styling, enabled textbox semantics, and Ink's terminal cursor at the editor position; agent-bound Enter still reaches the busy guard, keeps the exact draft, reports `still working`, and never queues it. Local report commands remain ahead of that guard.
- Compaction owns a genuinely non-editable editor: after global interrupt/exit, permission, and display-only controls, ignore editor keyboard and paste until compaction ends.
- For cursor visibility, inspect the latest DEC private `ESC[?25h` / `ESC[?25l` state in raw pty output after a settled frame. Finding any historical show sequence is not enough because Ink hides the cursor before repainting.

### 4. Validation and error matrix

| Input | Required behavior |
|---|---|
| Bracketed CRLF paste | Append all lines, normalize to LF, do not submit |
| Ctrl+J / LF | Append one LF, do not submit |
| Trailing `\\` + Enter | Replace marker with LF, do not submit |
| Plain Enter / CR | Submit the complete draft |
| `text` + leading/trailing CR/LF/CRLF in one non-paste event | Strip the whole terminator run and submit once |
| `text\\` + trailing terminator, or `\\` draft + leading terminator and text | Consume `\\`, append one LF, retain following text, do not submit |
| Other C0 or DEL inside paste | Drop the control byte, retain surrounding text |
| Paste during permission prompt | Ignore it; permission keeps keyboard ownership |
| Keyboard or paste during compaction | Ignore it; the disabled draft remains unchanged |
| Agent-bound Enter during streaming | Keep the exact draft, show `still working`, never queue or auto-send |

### 5. Good / base / bad cases

- Good: `alpha\r\nbeta` paste renders `you> alpha` then `...> beta` and remains editable.
- Base: a one-line draft and Enter behave exactly as before.
- Bad: splitting at the first newline submits `alpha` and silently loses `beta`; stripping all controls also destroys every intended LF. Treating batched `text\r\n` as draft text leaves an empty continuation row and never starts the turn.

### 6. Tests required

Run `verify-tui.ts cursor` for keyboard insertion/deletion and to prove that mouse tracking remains disabled, preserving native selection and scrollback. Run `verify-tui.ts multiline`; assert on first and continuation rows, absence of `working…` after paste/manual newline, consumed continuation marker, backspace across LF, and bounded clean exit after plain Enter submits `/exit`. Run `verify-tui.ts chunkedEnter` to send text and Enter in one pty write and cover batched continuation plus CRLF submission. Run `verify-tui.ts usage` for streaming editability, raw cursor visibility, local reporting, exact busy refusal/no queue, and explicit second submission. Run `verify-tui.ts compacting` for disabled keyboard/paste ownership, and `verify-tui.ts approve` for permission ownership of a hidden draft. Run `verify-tui.ts completion` after changing the Enter or Up/Down branches. Keep Unicode/wrapping/resize geometry in the focused pure prompt-editor suite.

### 7. Wrong vs correct

```typescript
// Wrong: truncates a paste at its first line.
void submit(draft + typed.slice(0, typed.search(/[\r\n]/)));

// Correct: use Ink's bracketed-paste channel and retain normalized layout.
usePaste((text) => setEditor((editor) => insertAtCursor(editor, normalizeDraftText(text))));

// Wrong: a batched event such as `\rnext` falls through as multiline draft text.
setDraft((draft) => draft + normalizeDraftText(typed));

// Correct: recognize one leading or trailing line-ending run as Enter, then
// apply continuation/submission at that position before retaining payload text.
const enter = typed.match(/^[\r\n]+/)?.[0] ?? typed.match(/[\r\n]+$/)?.[0];
if (typed.length > 1 && enter !== undefined) handleBatchedEnter(typed, enter);
```

## Local `/help` contract

- Match `/help` with any whitespace separator before the busy guard. Exact `/help` dispatches one
  bounded transcript notice; arguments, including tab/newline-separated arguments, dispatch only
  `/help takes no arguments`.
- The formatter is pure over canonical built-in constants and fixed input facts. It cannot receive a
  runtime, tool, queue, config/session writer, filesystem client, or network client.
- Verify idle and busy behavior through the free `completion` pty scenario. Use a running `!`
  command for offline busy state, preserve a queued sentinel across `/help`, assert `/help` itself is
  never listed as queued, and assert no `working…` model state. The latest frame must not contain the
  report because the report belongs to existing Static transcript history.
- Verify the report independently with `verify-help-command.ts`: exact canonical command rows in
  canonical order, no duplicate/invented names, every required syntax/key fact, and finite line,
  command, and per-line code-point bounds.

A backend-only model tool such as `search_memory` should not get a bespoke pty scenario merely to
prove shared rendering. Verify that it emits ordinary SDK tool events/results and structurally assert
that no TUI component, completion command or live-frame surface was added; existing tool lifecycle
suites remain the rendering contract.

## Custom slash-command contract

### 1. Scope / trigger

Changes to `.darwin/commands/` discovery, runtime slash expansion, or completion order cross filesystem → runtime → TUI boundaries and require both direct loader tests and a real-pty completion scenario.
Discovery also scans project/global `.agents/commands` under the shared precedence contract (project `.darwin`, project `.agents`, global `.darwin`, global `.agents`). Direct symlinked Markdown files may resolve to regular files; failures are surfaced. Completion consumes only the accepted registry. Startup renders bounded `hooks:` warnings when authoritative `.darwin/hooks/*.json` sources shadow legacy inputs; dev REPL reports the same facts.

### 2. Signatures

- Sources: direct `<extension-root>/commands/<name>.md` files from project/global `.darwin` and `.agents`; a direct symlink may resolve to a regular file.
- Invocation: `/<name> [arguments]`.
- Placeholder: every literal `$ARGUMENTS` becomes the trimmed argument tail; no arguments means the empty string.
- Completion order: built-ins → accepted custom commands → skills. `/quit` remains a reserved but unadvertised alias.

### 3. Contracts

- Names use letters, numbers, hyphens, and underscores and match case-insensitively.
- Built-in names and skill names are reserved case-insensitively. Skills win collisions; the custom file is skipped and warned about.
- Bodies are read at startup; directory hot reload is not part of the contract.
- Unknown slash input remains ordinary model input. Expansion failures must not replace it with a partial prompt.

### 4. Validation and error matrix

| Entry / input | Required behavior |
|---|---|
| Missing commands directory | Empty registry, no warning |
| Nested or non-`.md` entry | Ignore silently |
| Invalid filename, empty body, unreadable file | Skip that file, surface `command skipped` |
| Built-in / skill / duplicate-name collision | Keep existing owner, skip and warn about custom file |
| Known command without `$ARGUMENTS` | Send body unchanged |
| Unknown slash command | Pass through unchanged |

### 5. Good / base / bad cases

- Good: `review.md` containing `Review $ARGUMENTS` plus `/review auth` sends `Review auth`.
- Base: built-ins and `/skill-name` retain their previous behavior.
- Bad: advertising both `COMMIT-MESSAGE.md` and the `commit-message` skill makes one menu row lie about which prompt will run.

### 6. Tests required

- `pnpm tsx spike/verify-custom-commands.ts`: discovery, all-placeholder replacement, case folding, reserved names, skill/duplicate collisions, unreadable/empty entries, unknown input.
- `pnpm tsx spike/verify-tui.ts completion`: use a temporary project, assert the collision warning, narrow prefixes to prove custom and skill rows, then restore `/` and assert built-ins lead. The menu shows six rows, so do not assume every command is simultaneously visible.
- Run `pnpm typecheck` and `pnpm test` after runtime contract changes.

### 7. Wrong vs correct

```typescript
// Wrong: the UI independently decides collision precedence.
const completions = [...builtins, ...commands, ...skills];

// Correct: the loader rejects collisions; every advertised runtime name is invokable.
const completions = [...BUILTIN_COMMAND_NAMES, ...info.commandNames, ...info.skillNames];
```

## Background task monitoring contract

### 1. Scope / trigger

Changes to background-task listing, terminal subscriptions, `/tasks`, or completion notices cross manager → runtime → React reducer → Ink `<Static>` boundaries. Verify manager semantics directly and user visibility through a real pty.

### 2. Signatures

```typescript
runtime.listBackgroundTasks(): Promise<BackgroundTaskStatus[]>
runtime.subscribeToBackgroundTasks(listener): () => void
/tasks // local command; no arguments; valid while idle or streaming
```

The report shows short id, presentation-only command summary, state, and elapsed duration. Running duration ends at report time; terminal duration ends at `finishedAt`.

### 3. Contracts

- Handle `/tasks` before the busy-turn guard, like `/usage`. Match any whitespace separator (`/^\/tasks(?:\s|$)/`) so tab/newline arguments are rejected locally rather than reaching the model.
- `/tasks` reads the runtime manager directly: it must not call `send`, cancel, queue, or emit a tool event. Empty state says `none in this run` because `--resume` does not restore process control.
- Subscribe in a mounted `useEffect` and return the unsubscribe closure. Dispatch only a `notice`; never `turnEnded` or status changes. The dim `<Static>` history entry is non-modal, visible while idle, and cannot steal permission/input focus.
- Normalize command whitespace and bound summaries only at presentation time. Truncate by Unicode code points, not UTF-16 code units, so an emoji boundary cannot render `�`; agent-side list output keeps the full command.
- Background lifecycle `bash` calls (`start`, `list`, `status`, `output`, `wait`, `stop`) are a presentation-only projection. Compact mode suppresses successful status and empty output polls. Successful waits are ephemeral while the observed task state is running, whether their incremental output is empty or non-empty; a terminal wait retains exactly one short-id/state row, also when its result carries output. Nested output/status/command/path/cursor metadata stays out of compact wait history. Failures remain fully diagnostic, expanded mode keeps the ordinary bounded payload, provider/model-visible results remain unchanged, and unknown or internally contradictory successful payloads fall back rather than being silently suppressed.
- `Ctrl+B` toggles compact/expanded details for every tool after permission ownership but before editor handling. It works idle or streaming, appends an immediate `tool details:` notice, and must not alter the draft/cursor. Existing `<Static>` scrollback is immutable; only active and subsequent calls change.
- Compact results are bounded by both four logical lines and 2,000 Unicode code points, so minified JSON cannot bypass the terminal bound. Success keeps the head, errors the tail, and denied output its first reason plus the tail; truncation is explicit.
- Expanded mode shows bounded input (8,000 code points / 100 lines) and result (32,000 code points / 200 lines) for ordinary, MCP, plugin, subagent and background tools. These are presentation bounds only; model-visible content stays unchanged.
- Permission prompts bound untrusted summaries to one logical line / 160 Unicode code points and each detail to 14 logical lines / 500 Unicode code points. The explicit omission marker consumes those budgets, short values (including blank whitespace) remain textually unchanged, and truncation never splits a code point.
- Permission pty checks assert against the settled latest Ink repaint, not text retained in accumulated terminal output. At 120×50 that frame must retain source plus bounded summary, labelled detail prefix plus omission marker, and the complete `allow? y n always: a=… A=… esc=deny` decision row.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| No current-runtime tasks | One dim `background tasks — none in this run` report |
| `/tasks` plus space/tab/newline argument | `/tasks takes no arguments`; no model turn |
| List read fails | Dim actionable notice; active turn remains untouched |
| Task finishes while streaming/permission-blocked | Append notice; active turn and prompt ownership continue |
| Task finishes while idle | React dispatch redraws immediately without keyboard input |
| TUI unmounts before runtime shutdown stops jobs | Effect unsubscribes; no write into dead renderer |
| Long/multiline/Unicode command | Single-line bounded complete-code-point summary |

### 5. Good / Base / Bad Cases

- **Good:** `/tasks` appears before the active turn's last word; a later failure notice also appears before that word; the turn still reaches normal idle.
- **Base:** empty `/tasks` while idle is free and starts no model request.
- **Bad:** polling from React delays idle notices; calling `turnEnded` for a task event clears live assistant/tool state; matching only `'/tasks '` lets tab arguments leak to the model.

### 6. Tests Required

- `spike/verify-task-format.ts`: whitespace, bounds, Unicode code-point truncation, running/terminal time endpoints, empty report, and failure metadata.
- `spike/verify-background-tool-ui.ts`: lifecycle recognition, compact active/result summaries, status/empty-output suppression, empty and non-empty running-wait suppression, terminal waits with and without output, malformed fallback, failure preservation, expanded mode, and foreground compatibility.
- `spike/verify-tui.ts toolDetails`: zero-model `Ctrl+B` toggles both ways, reports each mode, preserves a draft, and starts no turn.
- `spike/verify-tui.ts completion`: zero-model `/tasks`, space/tab argument rejection, completion row, and no `working…` marker.
- `spike/verify-tui.ts tasks`: anchored proof that one completion arrives after idle was established, `/tasks` renders during streaming, another completion arrives during that same turn, both precede the final word, and exit is deadline-bounded.
- Manager-level tests own exactly-once stop/success/failure and unsubscribe semantics; do not duplicate private-manager assertions in React tests.

### Developer supervisor live scenario

`spike/verify-developer-live.ts` is the opt-in cross-process acceptance for `/developer`. Drive the real Host TUI in a temporary git repository, wait for the first managed `taskId` result before submitting `/tasks` (the rendered command can precede manager registration), and assert `/tasks` renders while the Host remains busy. Then prove two retained child logs use one exact `session-*`, the second command contains `--session`, no grandchild task was created, no command drifted to the Host source cwd, the intended diff exists, and an independently invoked fixture test passes. Keep every wait and process exit deadline-bounded; remove the temporary repository in `finally`.


### 7. Wrong vs Correct

```typescript
// WRONG: status mutation interrupts the model UI, and polling delays idle delivery.
setInterval(async () => {
  dispatch({ type: 'turnEnded' })
  render(await runtime.listBackgroundTasks())
}, 1000)

// CORRECT: one observer-only subscription for the mounted renderer.
useEffect(
  () => runtime.subscribeToBackgroundTasks((task) => {
    dispatch({ type: 'notice', text: formatTaskCompletion(task) })
  }),
  [runtime],
)
```


Component-level testing (ink-testing-library) was rejected: the bugs worth catching
(permission gating, resume, process exit) live in the seams, not in components.

## Subagent dispatch monitoring and source-labelled approvals

### 1. Scope / trigger

Changes to `/agents`, dispatch subscriptions, the delegation row in the live panel, or the
permission prompt's source label cross registry → runtime → React reducer → Ink boundaries.
Verify registry semantics directly (`spike/verify-subagents.ts`), projections purely
(`spike/verify-subagent-format.ts`), and user visibility through a real pty.

### 2. Signatures

```typescript
runtime.listSubagentDispatches(): SubagentDispatchStatus[]   // synchronous: in-memory, no I/O
runtime.subscribeToSubagentDispatches(listener): () => void
/agents // local command; no arguments; valid while idle or streaming
request.source // { kind: 'parent' | 'child'; label; dispatchId?; agentName? } — always present
```

### 3. Contracts

- Handle `/agents` before the busy-turn guard with `/^\/agents(?:\s|$)/`, exactly like `/tasks`:
  it reads the registry directly and must not call `send`, cancel, queue, or emit a tool event.
  Unlike `/tasks` the read is synchronous — the registry is in memory, so there is no failure
  path to report.
- The empty report is `subagent dispatches — none in this run`. It says *dispatches*, not agents:
  `runtime.info.agentNames` (the definitions available to delegate to, shown in the header) and
  dispatch state (the runs that happened) are different things surfaced by different paths, and
  one report that could be read as either is worse than two reports.
- Subscribe in a mounted `useEffect` and return the unsubscribe closure. Dispatch only a
  `notice`; never `turnEnded` or a status change. Concurrent children finish in an unscripted
  order, including while a permission prompt owns the keyboard.
- Bound every rendered field at presentation time (task summary, agent label), truncating by
  Unicode code points. The registry keeps the full task text; nothing child-produced is stored.
- The permission prompt renders the source on the **existing summary line**
  (`[parent] fileEditor str_replace: …`), never on a line of its own, and renders it for parent
  calls too. The box shares the live frame with the header, so a new row is a row Ink drops.
- The live delegation row (`subagent explorer#a1b2c3d4: <bounded task>`) is computed in the pure
  reducer from `event.toolUse` alone via `shortDispatchId`, so it shows the same dispatch id the
  registry recorded without the reducer ever reading the registry.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| No dispatches this run | One `subagent dispatches — none in this run` report |
| `/agents` plus space/tab/newline argument | `/agents takes no arguments`; no model turn |
| Dispatch finishes while streaming or permission-blocked | Append a notice; turn and prompt ownership continue |
| Several dispatches running | One row each, distinguishable by `<agent>#<dispatch>` |
| Long/multiline/Unicode task | Single-line bounded complete-code-point summary |
| Parent-originated prompt | Labelled `[parent]`, not left unlabelled |
| Child-originated prompt | Labelled `[<agent>#<dispatch>]` matching the `/agents` row |

### 5. Good / base / bad cases

- Good: two dispatches run concurrently, `/agents` lists both mid-turn, one finishes and its
  notice lands in `<Static>` history while the other keeps running.
- Base: `/agents` while idle with no delegation is free and starts no model request.
- Bad: giving the label its own row (pushes `allow?` off a 50-row pty — the exact failure the
  header contract below records); asserting `'/agents'` alone (it also occurs in the streaming
  hint, so the assertion would pass with no report on screen); polling the registry from React.

### 6. Tests required

- `spike/verify-subagent-format.ts`: report/notice/live-row projections and id purity.
- `spike/verify-subagents.ts`: concurrency, provenance and registry observer semantics.
- `spike/verify-tui.ts agents`: zero-model empty report (asserted verbatim), space and tab
  argument rejection, the completion row with its description, no `working…`, `exitedWithin`.
- `spike/verify-tui.ts approve`: the `[parent]` label together with `allow?`, `Path:` and `With:`
  — one assertion for the label, one that the box is still whole.
- `spike/verify-tui.ts completion`: the builtin completion order starts at `❯ /agents`. A new
  builtin command changes which row is selected first; re-run this scenario when adding one, and
  keep the total at or below `MAX_COMPLETIONS` so every builtin still fits one screen.

### 7. Wrong vs correct

```typescript
// WRONG: a label of its own is a frame row, and the registry is not the reducer's business.
<Text>[{lookupDispatch(runtime, request)}]</Text>
<Text>{request.summary}</Text>

// CORRECT: one row, provenance the gate already resolved, parent included.
<Box>
  <Text color="cyan">[{request.source.label}] </Text>
  <Text>{request.summary}</Text>
</Box>
```

## Contract: anchored waits (`mark()` / `from:`)

Recurring text makes unanchored waits meaningless: `you>` is drawn every frame, so
`waitFor('you>')` matches a frame from *before* the action being awaited.

```typescript
// Wrong — returns immediately, then reads the file before the edit lands:
await tui.waitFor('you>');

// Correct — only matches output produced after the action:
const m = tui.mark();
tui.send('y');
await tui.waitFor(/✓ fileEditor str_replace/, { from: m });
```

## Contract: idle detection needs a busy marker, plus settle time

- The input box renders `you>` while streaming as well as idle, so idleness is
  `lastIndexOf('you>') > lastIndexOf('working…')` — the newest prompt drawn after the
  newest busy hint. A bare `you>` check deadlocks or false-passes.
- **Gotcha**: right after submitting, no `working…` frame exists yet, so the predicate
  reads idle. Wait for `working…` (anchored) before entering an approve/idle loop.
- **Gotcha**: one Ink frame arrives as multiple pty chunks. A predicate evaluated between
  the input-line chunk and the `working…` chunk misreads state — the driver's
  `settleMs` (predicate must hold across a quiet period) exists for this; it was a real
  intermittent failure, not paranoia.

## Contract: process exit is an assertion, not an assumption

Use `exitedWithin(ms)`, never an unbounded `exited()`. A TUI that cannot exit *is the bug*
(we shipped two: bash session handles and a cancelled model stream's socket); an unbounded
wait converts that bug into a suite hang.

## Contract: permission-box detection reads the frame tail; kinds read the whole screen

- "A prompt is up" = the newest frame tail contains `allow?` and does *not* end with an
  editable `you>` line (the box replaces the input box).
- But extracting the prompt's kind must `matchAll` over the whole screen and take the
  last hit: a long details block (a big file body) pushes `permission required (write)`
  out of any fixed-size tail window.

## Known flake: a model-driven scenario must not assert the model's precision

Three separate flakes in one scenario (`approve`) on 2026-08-17, all of them the scenario asking the
*model* for something instead of asking darwin. Each is worth recognising by shape.

**Do not assert byte-equality against text the model had to transcribe.** `approve` compared the
edited file with a 620-character expectation, which failed in two of three full-suite runs — the
model writes 617 x's, or 621. What the scenario is *for* is that approving the prompt applies the
edit in place and touches nothing else, so it now asserts that structurally (`approvedEditIsExact`)
and leaves the exact length where it is darwin's own business: the `… truncated N code points`
marker on the permission frame, which is computed from whatever the model actually sent.

**A scenario that goes off-script fails twice.** When the model answered with a question instead of
the edit, the disk assertion failed *and* the following `/exit` landed mid-turn, so the run died on
`exitedWithin` 30s later. A second failure downstream of a model deviation is not a second bug.

## Known flake: a prompt cannot forbid a tool call, and an unanswered prompt hangs the scenario

`approve` tells the model, in words, not to run shell commands. It mostly obeys. When it does not,
the extra call raises a **second** permission box, the scenario answers only the first, and the
following `waitForIdle` burns its whole timeout with every assertion already passed. Observed twice
in a full-suite run on 2026-08-17 while the same scenario passed three times standalone.

So: a scenario that depends on the model *not* doing something is a scenario that will flake. Prefer
`--permission-mode` or an allow rule to make the extra call harmless, and treat "all assertions
passed, then the run timed out waiting for idle" as this shape rather than as a regression in what
was under test.

Related, and measured while fixing it: a wait on a 170-character path followed by an assertion on
the same string is **self-fulfilling** — the wait *is* the assertion, and it hides the fact that the
path never appears contiguously (Ink breaks a string wider than the terminal). Split the two: wait
on a short unique anchor, and compare the long value with `withoutWhitespace(...)`, which drops the
wrap. That is also what made the wait occasionally burn its whole 60s budget on an otherwise healthy
run.

## Contract: assertion strings must be exclusive to the state under test

Renaming the product from `strands-darwin` to `darwin` silently turned
`screen.includes('darwin')` assertions into tautologies — the test cwd is `/tmp/darwin-*`,
so the string is on screen from frame one. Assert on text only the asserted state can draw
(`/exit to quit` for the header, `permission required (write)` for the gate). Rename/path
tasks are exactly when old assertions degrade this way, so re-inspect them there.

Cheap scenarios first: anything about header lines, completion lists, or the input box
needs no submit and no model call (~1s, zero tokens). Don't fold pure-rendering assertions
into a model-driven scenario that takes 30s.

## Contract: the header competes for frame height

Header, tool panel, permission box and input box render in one live frame (only completed
history is `<Static>`), and Ink drops the overflow on a terminal shorter than the frame. A
single new header line — `prompt cache: …` on its own row — was enough to push `allow?` and
the details block off the 50-row pty, failing three permission assertions while the flow
itself still worked. Add startup state as a suffix on an existing line (the model line), keep
whole new lines for rare warnings, and re-run `verify-tui.ts approve` after touching the
header: it is the only check that sees the header and the box in the same frame.

## Contract: the live frame's row budget lives in its own document

Everything about how the redrawn frame divides its rows between header, answer, tool panel,
permission box and draft — and about committing finished answer lines to `<Static>` while a turn is
still running — is **`.trellis/spec/frontend/live-frame.md`**. Read it before changing anything that
draws inside the live frame; the one-line version is that Ink does not clip an over-tall frame, it
clears the screen *and the scrollback* per render instead.

Split out because this file is injected into implement and check runs and is silently truncated past
32 KB, which would drop whichever contract happened to sit last.

## Contract: visual hierarchy is asserted structurally

Use `spike/verify-visual-language.tsx` for deterministic Ink rendering. Strip ANSI before checking
critical distinctions: colour is enhancement, so tests pin stable textual role/state markers,
capability-count summaries, one `mode:`, model-line cache/effort, composer/menu selection, and every
permission-modal fact. Keep the real pty suite for terminal behavior — cursor geometry, completion
and recall key ownership, multiline drafts, frame slicing, and modal reachability — rather than
making model-driven scenarios compare cosmetic escape sequences or exact generated prose.

Header row acceptance is a visual-row assertion at a declared width, not a newline guess. Any text
added to a measured/budgeted surface must update both its geometry helper and the structural fixture;
do not weaken an assertion to accept omitted state.

## Contract: file edits render as marker-stable line diffs

### 1. Scope / trigger

Any change to how a gated `fileEditor` write (`str_replace`, `create`, `insert`) is presented at
the permission prompt or in the expanded tool input (active panel and finished `<Static>` item).

### 2. Signatures

- `src/tui/edit-diff.ts` — pure, dependency-free, opens no file:
  `fileEditorDiff(rawInput): string | undefined` (marker-prefixed diff of the input's own strings),
  `fileEditorInputProjection(rawInput): string | undefined` (`command:`/`path:`(/`insert line:`)
  header lines + diff), `permissionDisplayDetails(request): PermissionDisplayDetail[]`,
  `diffLineTone(line): 'add' | 'remove' | undefined`. SER-023 additions, same purity:
  `diffStat(diffText): { added, removed }` and `formatDiffStat(stat): '+N -N'` (counted from the
  markers, on the *untruncated* diff), `diffLineEmphasis(lines): (DiffEmphasis | undefined)[]`
  (per-line intraline changed span, UTF-16 offsets into the marker-prefixed line) and
  `emphasisSpans(text, emphasis): { pre, mid, post }` (identity slicing for renderers).
- `PermissionDetail.editContent?: boolean` (`classify()` in `src/agent/permission.ts`) marks the
  raw content blocks a diffing UI may substitute; every unmarked block must stay stated.
- `permissionDetailRows(value, columns, diff = false)` and `toolInputRows(input, columns, toolName?)`
  return `BoundedContentRow { text, tone?, emphasis? }` — tone and emphasis travel with the counted
  row so wrapped continuations of a `+ `/`- ` line stay coloured and the changed span stays bold,
  and the counted text never changes with either.
- `compactEditDiff(input, toolName?): string[]` (`src/tui/tool-detail-presentation.ts`) — the
  finished row's diff, complete and never truncated; `[]` for anything that is not a recognized
  `fileEditor` write.
- The tool history item carries `diffStat?: { added, removed }` (`turn-state.ts`) — absent means
  "not a diff", never 0. `formatReplay` prints only `summary`/`preview`, which is what keeps
  `/export` and `trajectory replay` byte-stable; never fold the stat into `summary`.

### 3. Contracts

- Marker vocabulary is `- ` removed / `+ ` added / `  ` context, plain text, at the start of the
  logical line; colour (`diffToneColor`: success green / danger red) is enhancement only.
- Information equivalence: stripping the two-character marker recovers the old value from
  `- `/`  ` lines and the new value from `+ `/`  ` lines; absent `new_str` (delete) renders as
  removals only, distinguishable from `new_str: ''` (one empty `+ ` line). Approving always
  writes the untruncated input — the diff is a projection, never the payload.
- Bounding rides the existing budgets on the **live** surfaces only (`permissionDetail`,
  `expandedToolInput` for the active panel); the truncation marker row is never toned. An input
  the reader does not recognize (unknown command, wrong types, extra keys) falls back to the raw
  blocks / JSON, losing nothing.
- Finished rows show the diff **complete, never truncated**, in both modes: compact rows carry
  the bare diff (`compactEditDiff`), expanded rows the labelled projection
  (`fileEditorInputProjection`, unbounded). Finished rows are written once into `<Static>`
  scrollback and never repainted, so their length costs scrollback, not live-frame rows —
  only the active tool panel and the permission box, which repaint every frame, stay bounded.
- The `+N -N` stat rides existing surfaces only — spliced into the finished summary row *before*
  the path (`✓ fileEditor str_replace (+1 -1): /path`; the row truncates end-first and the path
  is its one unbounded part — a suffix stat is exactly what a long path eats) and into the
  permission block label (`Diff (+1 -1):`). Never a new row.
- Intraline emphasis is enhancement layered like tone: replaced pairs (equal-count `- `/`+ ` runs,
  k-th with k-th) get their common-prefix/suffix-trimmed span bolded; pairs sharing no edge
  context, empty spans, unequal runs and tab-bearing lines (wrap expansion would skew offsets)
  get none. ANSI-stripped output stays byte-identical to the plain diff.
- Tone scope is the tool: only `fileEditor` rows are ever toned or emphasized, so a bash command
  starting with `- ` stays plain. dev-repl keeps the raw `Replace:`/`With:` blocks.

### 4. Tests required

`spike/verify-edit-diff.ts` (equivalence, bounds, Unicode, all three write modes, fallbacks —
in `pnpm test`), the diff sections of `spike/verify-visual-language.tsx`, and the live
`verify-tui.ts approve` diff assertions — which must not span a wrap boundary: a long unbroken
token wraps onto marker-less continuation rows (measured at 116 box columns on a 120x50 pty).


## Contract: effective plan mode stays on the existing mode row

`plan` is a permission mode, not a new panel. Render `mode: plan — read-only; write and execute
calls are denied` on the header's existing mode row; if allow rules are loaded, mark them ignored
on that same row. The value must come from `runtime.info.permissionMode`, after CLI override
resolution.

`spike/verify-tui.ts plan` is intentionally network-free: write a conflicting configured mode,
launch the real pty with `--permission-mode plan`, wait for the state-exclusive full plan text,
assert the configured mode is absent as effective, submit `/exit`, and use `exitedWithin`. Do not
turn this header check into a model-driven scenario.

## Contract: the pty suite owns HOME, and resets what a project key carries

Darwin's config, sessions and allow rules are **user-global** (`~/.darwin/…`, project-keyed
under `~/.darwin/projects/<key>/`), and a pty child inherits the harness's environment. So
`verify-tui.ts` repoints `process.env.HOME` at an owned temp dir *at module load*, before
anything resolves a home:

- Repoint HOME in the harness, not per child. In-process helpers (`permissionRulesPath()`,
  the config path) then name exactly the file the TUI under test writes — which is what
  makes reading it back an assertion rather than a guess.
- An owned HOME hides `~/.aws`, and this suite makes real model calls. Point
  `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` back at the real home (harmless when
  absent, as on an instance role) so isolation cannot cost authentication.
- Scenarios that need a config **write it** into the owned HOME instead of relying on the
  built-in defaults, which move: the `/effort` clamp assertions only hold on a model that
  serves adaptive thinking but not `xhigh`, and they silently stopped holding the day the
  default model became an Opus-tier one. For the same reason, header assertions should not
  pin the inference-profile prefix (`/bedrock\/(us|eu|apac|global)\.anthropic\./`, not
  `bedrock/us.anthropic`).
- `resetWorkDir()` must clear **everything the shared project key carries**, not just the
  work tree: the allow rule `alwaysAllow` writes outlives the directory it was granted in,
  and left behind it silences the very prompt `cancelThenContinue` waits for (a 240s timeout,
  three scenarios later, with nothing on screen to suggest why).

Two symptoms that mean this contract is broken: a scenario reading a config from
`<workdir>/.darwin/config.json` (nothing writes there any more), and a notice assertion
missing the `~/` the TUI actually prints (`saved to ~/.darwin/config.json`).

## Scenario checklist for agent-driven flows

Model-driven turns choose their own tool order, so scripted prompt sequences are fragile.
`acceptance-e2e.ts` uses a generic approve-until-idle loop instead, and asserts on the
*set* of gated kinds (`write` present, `execute` present), the on-disk outcome, and an
independent re-run of the proof command — not on the exact order of prompts.

## SRF-001 focused coverage

Stream-interruption recovery is policy/orchestration, so its primary deterministic coverage is
`spike/verify-stream-resumption.ts` (real SDK Agent and trajectory) plus
`spike/verify-headless-structured.ts` (all automation protocols). TUI regression coverage must also
run `spike/verify-prompt-queue.ts`: one `runTurn` owns both attempts, and only a final failure or user
cancel may return queued entries unsent. A test double must never call `AgentRuntime.send` recursively
or replace the SDK error object merely to make this scenario easier to drive.

## Contract: completion overflow needs pure, render, and pty proof

A bounded completion menu has two independently observable properties, so one test level is not
enough:

- Pure/render checks in `spike/verify-frame-budget.ts` cover first, middle, last, and wrapped
  full-list selections. Every rendered case must contain exactly one `❯`, preserve candidate order,
  state omitted counts above/below truthfully, and remain inside every prompt-region grant in the
  render matrix.
- Real pty `verify-tui.ts completion` and `pathCompletion` must drive an overflowing menu with
  `Up`/`Down`, wait for the selected marker to settle, then prove both Tab and Enter insert exactly
  that marked slash/path candidate. Include a wrap case and assert acceptance does not start a turn.
- Keep arrow writes and acceptance separate behind anchored waits when the assertion is about the
  visible row. Separately, production keeps immediate selection/editor mirrors so batched terminal
  events cannot make the accepted identity differ from the marker.

These are free checks; no provider call is required.
