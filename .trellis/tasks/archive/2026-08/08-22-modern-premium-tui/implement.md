# Implementation plan

1. Add pure responsive welcome-layout constants/helper and a focused `WelcomeHeader` Ink component. Keep the logo hand-maintained, dependency-free, text-complete without color, and outside turn state.
2. Mount the welcome as a presentation-only first item in `MessageList`'s existing `<Static>` owner, proving it commits once, precedes resume recap, survives ordinary redraws and resize without mutation, and never enters the measured header or shared frame budget.
3. Consolidate the semantic palette to one cyan brand/active/information accent while preserving green/yellow/red only for success/warning/error/diff meaning.
4. Remove inverse-video styling from the prompt prefix and completion selection while preserving textual markers, bold/accent focus, five-column editor geometry, real cursor placement, menu planning, and key ownership.
5. Add deterministic tests for welcome breakpoints/rows/widths, static rendering, once-only structure, unified color roles, no inverse SGR, unchanged textual markers, and unchanged header baseline.
6. Extend the offline startup PTY fixture/suite for fresh and resumed welcome ordering, absence from the settled live frame, no repeat after a local command, and no repeat after `/clear`; preserve startup failure cleanup and byte-identical resume state.
7. Update README visual example and executable frontend/architecture contracts with the one-shot welcome and restrained palette/focus rules.
8. Run focused checks, fix locally, then run the full quality gate.

## Validation commands

```bash
pnpm tsx spike/verify-startup-screen.tsx
pnpm tsx spike/verify-startup-pty.ts
pnpm tsx spike/verify-visual-language.tsx
pnpm tsx spike/verify-frame-budget.ts
pnpm tsx spike/verify-tui.ts completion
pnpm tsx spike/verify-tui.ts pathCompletion
pnpm tsx spike/verify-tui.ts recall
pnpm tsx spike/verify-tui.ts clear
pnpm tsx spike/verify-tui.ts mode
pnpm tsx spike/verify-tui.ts mcp
pnpm tsx spike/verify-tui.ts queue
pnpm tsx spike/verify-tui.ts bang
pnpm typecheck
pnpm test
python3 ./.trellis/scripts/task.py validate 08-22-modern-premium-tui
git diff --check
```

No live model scenario is required unless source changes touch permission-modal geometry or focused free checks reveal a frame interaction that only the live 120x50 `approve` scenario covers.

## Risk and rollback points

- **Adjacent Ink `<Static>` ownership:** verify before broad styling. If a separate welcome static owner is not stable, use one explicit presentation-only initial item in the existing static owner without recording/replaying it.
- **PTY frame semantics:** assertions must distinguish `tui.screen` scrollback from `tui.frame` live output; welcome must exist in the former and not the latter after settling.
- **Unicode width:** thresholds and tests use display width, not JavaScript string length assumptions. Compact fallback prevents wrapping.
- **Color regression:** forced-color tests assert named semantic roles; ANSI-stripped output remains authoritative.
- **Cursor drift:** no prefix width or row insertion occurs inside `InputBox`; completion/cursor PTY suites are mandatory.
- **Rollback:** welcome component and styling changes are presentation-only and can be independently reverted without data/config migration.
