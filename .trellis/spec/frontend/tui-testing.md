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

## Multiline input contract

### 1. Scope / trigger

Any change to `App` input handling or `InputBox` rendering crosses the terminal-event → draft-state → rendered-frame → submitted-prompt boundary. Verify it through the real pty, not by rendering the component alone.

### 2. Signatures

- Ink `usePaste((text: string) => void)` owns bracketed paste events.
- Ink `useInput((typed, key) => void)` owns keys: CR/plain Enter submits, LF/Ctrl+J inserts a newline.
- Terminals may send printable text plus CR/LF/CRLF as one `typed` value with `key.return === false`; a multi-character trailing line-ending run is one submit terminator.
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

### 4. Validation and error matrix

| Input | Required behavior |
|---|---|
| Bracketed CRLF paste | Append all lines, normalize to LF, do not submit |
| Ctrl+J / LF | Append one LF, do not submit |
| Trailing `\\` + Enter | Replace marker with LF, do not submit |
| Plain Enter / CR | Submit the complete draft |
| `text` + CR/LF/CRLF in one non-paste event | Strip the whole terminator run and submit once |
| `text\\` + batched terminator | Consume `\\`, append one LF, do not submit |
| Other C0 or DEL inside paste | Drop the control byte, retain surrounding text |
| Paste during permission prompt | Ignore it; permission keeps keyboard ownership |

### 5. Good / base / bad cases

- Good: `alpha\r\nbeta` paste renders `you> alpha` then `...> beta` and remains editable.
- Base: a one-line draft and Enter behave exactly as before.
- Bad: splitting at the first newline submits `alpha` and silently loses `beta`; stripping all controls also destroys every intended LF. Treating batched `text\r\n` as draft text leaves an empty continuation row and never starts the turn.

### 6. Tests required

Run `verify-tui.ts cursor` for keyboard insertion/deletion and to prove that mouse tracking remains disabled, preserving native selection and scrollback. Run `verify-tui.ts multiline`; assert on first and continuation rows, absence of `working…` after paste/manual newline, consumed continuation marker, backspace across LF, and bounded clean exit after plain Enter submits `/exit`. Run `verify-tui.ts chunkedEnter` to send text and Enter in one pty write and cover batched continuation plus CRLF submission. Run `verify-tui.ts completion` after changing the Enter or Up/Down branches. Keep Unicode/wrapping/resize geometry in the focused pure prompt-editor suite.

### 7. Wrong vs correct

```typescript
// Wrong: truncates a paste at its first line.
void submit(draft + typed.slice(0, typed.search(/[\r\n]/)));

// Correct: use Ink's bracketed-paste channel and retain normalized layout.
usePaste((text) => setEditor((editor) => insertAtCursor(editor, normalizeDraftText(text))));

// Wrong: a batched text event ending in CRLF falls through as multiline draft text.
setDraft((draft) => draft + normalizeDraftText(typed));

// Correct: strip a multi-character line-ending suffix and submit the mirrored draft.
const suffix = typed.match(/[\r\n]+$/)?.[0];
if (typed.length > 1 && suffix !== undefined) submit(draftRef.current + typed.slice(0, -suffix.length));
```

## Custom slash-command contract

### 1. Scope / trigger

Changes to `.darwin/commands/` discovery, runtime slash expansion, or completion order cross filesystem → runtime → TUI boundaries and require both direct loader tests and a real-pty completion scenario.

### 2. Signatures

- Source: `<projectRoot>/.darwin/commands/<name>.md` (direct regular files only).
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
- Background lifecycle `bash` calls (`start`, `list`, `status`, `output`, `stop`) are a presentation-only projection. Compact mode suppresses successful status and empty output polls, retains child text without cursor/path metadata, and keeps failures fully diagnostic. Unknown successful payloads fall back to ordinary rendering.
- `Ctrl+B` toggles compact/expanded lifecycle details after permission ownership but before editor handling. It works idle or streaming, appends an immediate notice, and must not alter the draft/cursor. Existing `<Static>` scrollback is immutable; only active and subsequent calls change.

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
- `spike/verify-background-tool-ui.ts`: lifecycle recognition, compact active/result summaries, status/empty-output suppression, child output, malformed fallback, failure preservation, expanded mode, and foreground compatibility.
- `spike/verify-tui.ts backgroundDetails`: zero-model `Ctrl+B` toggles both ways, reports each mode, preserves a draft, and starts no turn.
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

- The input box renders `you>` even while disabled, so idleness is
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
