# Render file edits as bounded coloured line diffs (SER-020)

Backlog direction: SER-020 (`docs/research/backlog_index.md`; origin report
`docs/research/research_2026-08-18.md`, run 12:30:29Z — supervisor-owned, not touched here).

## Problem

A `fileEditor str_replace` approval today shows raw `Path:`/`Replace:`/`With:` detail blocks and
the user diffs two wrapped strings by eye before authorizing a write. Finished fileEditor results
render the expanded input as uniform dim JSON. The gate has exposed the raw tool input for exactly
this (`src/agent/permission.ts` `PermissionRequest.input`: "Raw tool input, for a UI that wants to
show or diff it itself") and no UI ever consumed it. Claude Code ships a red/green line diff at
edit approval (its loss was filed as a regression); Codex documents TUI diffs.

## Requirements

1. For gated `fileEditor` write calls (`str_replace`, `create`, `insert`) the permission box
   presents the change as a line diff with `+ `/`- ` (and `  ` context) markers, coloured with the
   existing semantic palette (`visualColor.success` additions, `visualColor.danger` removals).
   `str_replace` diffs `old_str` against `new_str` from the input — no file read from the
   renderer; `create`/`insert` are all-additions. Markers are plain text and survive ANSI
   stripping (`.trellis/spec/frontend/tui-testing.md` § visual hierarchy).
2. The finished tool result / expanded input presentation for the same calls uses the same diff
   projection, presentation-time only. Model-visible tool content unchanged; `<Static>`
   scrollback stays immutable.
3. Information equivalence and bounds (SER-009/SER-016 contracts): approving writes the exact
   untruncated value; short values remain textually recoverable from what is shown (strip the
   two-character marker); every truncation is explicit and consumes the same budgets
   (`PERMISSION_DETAIL_LINES`/`PERMISSION_DETAIL_CODE_POINTS`, Unicode code-point truncation);
   box heights counted through one geometry source (`boxGeometry` + `frame-budget.ts`); decision
   row reachable on a short terminal; no new header baseline row.
4. The diff projection is a pure, dependency-free module (hand-rolled line diff, no npm
   dependency), reusing the existing projection seams (`tool-detail-presentation.ts`,
   `permissionDetailRows`) — never a second formatter.
5. Non-fileEditor tools untouched. `classify`/details may be extended; denial semantics, rule
   offers, source labels and everything the box states today remain stated.

## Design

- New pure module `src/tui/edit-diff.ts`: marker-prefixed line diff (`- `/`+ `/`  `) from the raw
  fileEditor input; LCS with common prefix/suffix trim, bounded DP with an equivalence-preserving
  remove-all/add-all fallback; `undefined` for anything that is not a well-formed write input.
- `classify()` tags the raw content blocks (`New content`, `Replace`, `With`, `Insert`) with
  `editContent: true`; the TUI substitutes exactly those blocks with one `Diff` block computed
  from `request.input`, keeping `Path`/`Operation`/`At line`/`Classifier` stated. If no diff is
  computable the raw blocks stay — degradation preserves information.
- `expandedToolInput`/`toolInputRows` accept the tool name and use a labelled projection
  (`path:`/`command:`(/`insert line:`) header lines + diff) for fileEditor writes; JSON fallback
  otherwise. Rows carry a tone so wrapped continuations of a `+`/`-` line stay coloured.

## Acceptance Criteria

- [x] New focused suite `spike/verify-edit-diff.ts` in `pnpm test`: bounds, Unicode, marker
      presence, equivalence on short values, all three write modes, deletion vs
      empty-replacement distinction, fallback behaviour.
- [x] `spike/verify-visual-language.tsx` updated for the new structure and passing.
- [x] `pnpm typecheck` exit 0; `pnpm test` all suites 0 failed.
- [x] `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve` (120x50): box whole — source
      label, diff rows, truncation marker, complete decision row — and approving writes the
      exact untruncated value.
- [x] `git diff --check` clean; working tree clean after commit. No push, no history rewrite.
