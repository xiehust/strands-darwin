# Implementation Plan — Ctrl+B for all tool details

1. Add pure Unicode-safe, dual line/code-point preview bounding and input serialization helpers with compact/expanded constants.
2. Generalize reducer state/action names, retain input for every active tool, and stamp completed tool items with the selected display mode and input projection.
3. Update active/completed tool components to render compact or expanded details while preserving status direction and media labels.
4. Preserve background lifecycle semantic compaction/suppression and migrate its helper argument names only.
5. Expand `spike/verify-background-tool-ui.ts` for ordinary-tool long JSON, Unicode, line/character composition, expanded input/results, active rows, immutable mode stamping, and background compatibility.
6. Rename/update the zero-model pty scenario assertions and frontend spec from background-only to all-tool detail behavior.
7. Run `pnpm tsx spike/verify-background-tool-ui.ts`, `pnpm typecheck`, `pnpm test`, and `pnpm tsx spike/verify-tui.ts backgroundDetails` (or its renamed scenario key).

## Risky Files / Rollback Points

- `src/tui/turn-state.ts`: event projection and immutable history shape; preserve replay compatibility and background suppression.
- `src/tui/ToolCallPanel.tsx`: terminal bounds must apply before Ink wrapping; never render raw unbounded input/output.
- `src/tui/MessageList.tsx`: keep `<Static>`; do not make completed history reactive.
- `spike/verify-tui.ts`: keep waits anchored and scenario model-free.

## No-Change Boundaries

- SDK agent loop and event types.
- Tool, permission, hook, session, trajectory, and headless contracts.
- Background process ownership and manager result shapes.
