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
- A draft ending in `\\` turns Enter into continuation and consumes the marker.

### 3. Contracts

- Draft line endings are canonical LF. Normalize CRLF and CR before appending.
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
| Other C0 or DEL inside paste | Drop the control byte, retain surrounding text |
| Paste during permission prompt | Ignore it; permission keeps keyboard ownership |

### 5. Good / base / bad cases

- Good: `alpha\r\nbeta` paste renders `you> alpha` then `...> beta` and remains editable.
- Base: a one-line draft and Enter behave exactly as before.
- Bad: splitting at the first newline submits `alpha` and silently loses `beta`; stripping all controls also destroys every intended LF.

### 6. Tests required

Run `verify-tui.ts multiline`. Assert on first and continuation rows, absence of `working…` after paste/manual newline, consumed continuation marker, backspace across LF, and bounded clean exit after plain Enter submits `/exit`. Run `verify-tui.ts completion` after changing the Enter branch.

### 7. Wrong vs correct

```typescript
// Wrong: truncates a paste at its first line.
void submit(draft + typed.slice(0, typed.search(/[\r\n]/)));

// Correct: use Ink's bracketed-paste channel and retain normalized layout.
usePaste((text) => setDraft((draft) => draft + normalizeDraftText(text)));
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
