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

## Scenario checklist for agent-driven flows

Model-driven turns choose their own tool order, so scripted prompt sequences are fragile.
`acceptance-e2e.ts` uses a generic approve-until-idle loop instead, and asserts on the
*set* of gated kinds (`write` present, `execute` present), the on-disk outcome, and an
independent re-run of the proof command — not on the exact order of prompts.
