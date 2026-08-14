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

- Draft line endings are canonical LF. Normalize CRLF and CR before appending.
- Keep an immediate ref mirror beside React draft state. Multiple stdin events may arrive before React renders; handlers that submit/continue must read the mirror, not a stale render closure.
- Preserve LF and tab; drop other C0 controls and DEL.
- Paste never submits. It appends the entire payload, including all line breaks.
- Render the first logical line after `you> ` and later lines after `...> `; the cursor follows the last line.
- Editing remains append/backspace-only. Plain Enter still submits, and slash completion still takes precedence when shown.
- A permission prompt owns paste as well as ordinary keys; pasted text must not leak into the hidden draft while approval is pending.

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

Run `verify-tui.ts multiline`. Assert on first and continuation rows, absence of `working…` after paste/manual newline, consumed continuation marker, backspace across LF, and bounded clean exit after plain Enter submits `/exit`. Run `verify-tui.ts chunkedEnter` to send text and Enter in one pty write and cover batched continuation plus CRLF submission. Run `verify-tui.ts completion` after changing the Enter branch.

### 7. Wrong vs correct

```typescript
// Wrong: truncates a paste at its first line.
void submit(draft + typed.slice(0, typed.search(/[\r\n]/)));

// Correct: use Ink's bracketed-paste channel and retain normalized layout.
usePaste((text) => setDraft((draft) => draft + normalizeDraftText(text)));

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

## Scenario checklist for agent-driven flows

Model-driven turns choose their own tool order, so scripted prompt sequences are fragile.
`acceptance-e2e.ts` uses a generic approve-until-idle loop instead, and asserts on the
*set* of gated kinds (`write` present, `execute` present), the on-disk outcome, and an
independent re-run of the proof command — not on the exact order of prompts.
