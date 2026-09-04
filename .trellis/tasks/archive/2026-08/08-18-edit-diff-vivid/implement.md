# Implementation record — SER-023

## What changed

- `src/tui/edit-diff.ts` — pure additions, still opens no file:
  `DiffStat`/`diffStat`/`formatDiffStat` (counts from the marker vocabulary),
  `DiffEmphasis`/`diffLineEmphasis` (equal-count run pairing, code-point
  prefix/suffix trim, UTF-16 ranges into the marker-prefixed line),
  `emphasisSpans` (identity slicing for renderers); `permissionDisplayDetails`
  labels the collapsed block `Diff (+N -N)`.
- `src/tui/tool-detail-presentation.ts` — `compactEditDiff` (bounded compact
  excerpt: `… N earlier lines` for skipped leading context, `boundText` for the
  tail; `COMPACT_DIFF_LINES = 8`, `COMPACT_DIFF_CODE_POINTS = 1600`).
- `src/tui/turn-state.ts` — compact branch stores the excerpt as `inputPreview`
  (was `''`); optional `diffStat` field on the tool history item (absent means
  "not a diff", never 0; `formatReplay` ignores it).
- `src/tui/frame-budget.ts` — `BoundedContentRow.emphasis`; `contentRows` maps
  logical-line emphasis onto wrapped rows in the one counted calculation
  (tab-bearing lines skip emphasis, keep tone).
- `src/tui/ToolCallPanel.tsx` — `ToolCallResult` renders compact excerpts
  (4-space indent, no `Input:` label), splices the coloured `(+N -N)` stat into
  the summary row *before the path* (a suffix stat is what `truncate-end` eats
  on a long path — measured live), bolds emphasis spans; active-panel rows
  render `row.emphasis`.
- `src/tui/PermissionPrompt.tsx` — detail rows render `row.emphasis` nested in
  the same one-`<Text>` counted row.
- Tests: `spike/verify-edit-diff.ts` 62 → 98 assertions;
  `spike/verify-visual-language.tsx` 42 → 47; `spike/verify-tui.ts` `approve`
  26 → 29 (compact diff rows + stat in the transcript, stat on the `Diff` label).
- Specs: `.trellis/spec/frontend/tui-testing.md` diff contract extended;
  `docs/architecture/load-bearing-decisions.md` § File-edit diffs; AGENTS.md row.

## Verification run

- `pnpm typecheck` exit 0; `pnpm test` exit 0 (46 suite totals, all `0 failed`).
- Live 120x50 `verify-tui.ts approve`: 29 passed, 0 failed.
- Free pty: completion 35, mode 25, clear 19, recall 20, pathCompletion 18 — all 0 failed.
- Purity grep on `edit-diff.ts`: no `node:` import, no fs API (only a type import
  from `../agent/permission.js`).
- Replay byte-stability: `trajectory replay session-20260816-105204802` (938 KB
  real record, 33 `str_replace` occurrences) byte-identical between HEAD
  (`9c29f2b`, via a second worktree) and this change (`cmp` clean, 169,905 bytes).

## Decisions taken (and one left open)

- Stat placement on the summary row: before the path, after the command —
  discovered live that the approve scenario's huge path truncates a suffix stat
  off a 120-column row. `✓ fileEditor str_replace` adjacency preserved (existing
  pty waits anchor on it).
- Emphasis pairing: k-th removal with k-th addition only for equal-count runs;
  pairs sharing no common edge get no emphasis (unrelated lines, not an edit).
- Left open: the compact excerpt is also stored for `denied`/`error` fileEditor
  results (the diff of what was *attempted*). Deliberate — the summary row's
  `⊘`/`✗` states the outcome — but a reviewer may prefer suppressing it.
