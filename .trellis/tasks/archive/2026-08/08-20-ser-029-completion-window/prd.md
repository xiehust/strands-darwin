# SER-029 completion selection window

## Goal

Keep the selected slash-command or `@` path candidate visible when an existing bounded completion menu overflows, so the row marked `❯` is always the candidate Tab or Enter accepts.

## Requirements

1. Window the existing completion candidates around the selected full-list index. Preserve source ordering and candidate identity; do not truncate the navigable list to the visible window.
2. Keep exactly one selected candidate visible whenever the menu draws entries, including first, middle, last, and wrapped navigation positions.
3. State all omitted candidates truthfully, including counts above and below the window, within the menu's existing single overflow-row allowance.
4. Preserve full-list wrapping for Up/Down and make Tab and Enter accept exactly the candidate marked `❯`.
5. Preserve command-over-path precedence, permission/compaction ownership, queue take-back and prompt-recall precedence, and all existing completion insertion behavior.
6. Keep `MAX_COMPLETIONS`, the frame-row grant, one-`Text`-per-counted-row convention, and bounded rendering unchanged. Add no frame participant or unbudgeted surface.

## Acceptance Criteria

- [x] Pure/render checks cover first, middle, last, and wrapped selected indices with exactly one visible `❯` and truthful above/below omission counts.
- [x] The prompt-region render matrix remains no taller than every tested grant.
- [x] Free pty `completion` proves overflowing slash navigation followed by Tab and Enter accepts the visible row.
- [x] Free pty `pathCompletion` proves overflowing path navigation followed by Tab and Enter accepts the visible row.
- [x] Existing completion/path behavior and cursor/recall/queue precedence remain green through the project suite.
- [x] Governing frontend specs state the executable windowing and acceptance contract.
- [x] `pnpm typecheck`, `pnpm test`, focused free pty scenarios, task validation, and `git diff --check` pass.

## Constraints

- No provider or live-model tests.
- Do not change research source/backlog documents or `docs/iteration-log.md`.
- Do not add dependencies, reorder candidates, or change path scanning/matching.
