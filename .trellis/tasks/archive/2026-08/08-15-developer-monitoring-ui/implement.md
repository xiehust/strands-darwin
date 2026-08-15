# Implementation plan

1. Add pure TUI background-bash presentation helpers that recognize lifecycle modes, shorten labels, and extract safe compact results with full-preview fallback.
2. Extend `turn-state` with compact/expanded mode, active compact summaries, successful polling suppression, concise output/history projection, and failure preservation.
3. Wire `Ctrl+B` through `App`, preserving permission keyboard ownership and prompt draft state; pass the display mode to live/static tool rendering as needed.
4. Add a network-free reducer/presentation suite and register it in `spike/run-tests.ts`.
5. Add a zero-model real-pty keyboard scenario and update user-facing shortcut/background-monitoring documentation.
6. Run focused suites, `pnpm typecheck`, and `pnpm test`; review the diff specifically for unrelated working-tree overlap.

## Validation commands

```bash
pnpm tsx spike/verify-background-tool-ui.ts
pnpm tsx spike/verify-tui.ts backgroundDetails
pnpm tsx spike/verify-task-format.ts
pnpm tsx spike/verify-background-bash.ts
pnpm typecheck
pnpm test
```

## Risk and rollback points

- `<Static>` history cannot be rewritten; tests must assert that toggling affects active/subsequent calls only.
- Tool-result shape drift must fall back to full rendering, never suppress unknown content.
- `src/tui/App.tsx`, `spike/verify-tui.ts`, and `spike/run-tests.ts` may contain unrelated edits during implementation; inspect hunks rather than replacing files.
- Rollback is confined to presentation/reducer/shortcut/test changes; no persisted data migration exists.
