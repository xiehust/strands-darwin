# PRD — Compact diff excerpt, change stats and intraline emphasis for file edits (SER-023)

Origin: `docs/research/backlog_index.md` SER-023, report `docs/research/research_2026-08-18.md`
(run 16:03:24Z, user-directed `tui` override). User intent: every file edit's diff visible and
vivid in the transcript ("以diff显示…酷炫一点").

## Problem

1. `turn-state.ts:332-335` stores `inputPreview: ''` unless `toolDetailsExpanded`, so in default
   compact mode a finished (or auto-approved) `fileEditor` write shows **no diff at all**.
2. The finished tool summary row (`ToolCallPanel.tsx` `ToolCallResult`) and the permission box
   `Diff` block label carry no `+N -N` change stats.
3. `diffMiddle` emits whole-line tones only — a replaced line pair gives no cue *where in the
   line* the change is.

## Scope (three pieces, one module family)

1. **Compact-mode visibility** — a bounded, toned diff excerpt for finished `fileEditor` writes
   in default compact mode. Explicit about what it withheld; **absence of a marker means nothing
   was withheld**. The full diff stays on the existing Ctrl+T expanded toggle, unchanged in
   completeness. Excerpt strings are bounded *before* they enter immutable history state
   (the `toolResultPreview`/`expandedToolInput` precedent).
2. **Change stats** — `+added/-removed` line counts computed in `src/tui/edit-diff.ts` (pure,
   derived from the same `- `/`+ ` markers), stated on the existing tool summary row and on the
   permission box `Diff` block label. **No new frame row anywhere.**
3. **Intraline emphasis** — for a replaced line pair, bold on the changed span
   (common-prefix/suffix trim, Unicode/code-point safe), layered over the existing red/green row
   tone. The plain markers stay the durable statement: ANSI-stripped output stays byte-identical
   to today's diff text; stripping the two-character markers still reconstructs old/new exactly.

## Non-negotiable constraints

- SER-020 purity: `edit-diff.ts` never reads a file — grep-provably free of fs APIs. No
  old-side absolute line numbers (explicitly gated out).
- SER-016 information equivalence: compact excerpt states what it withheld; expanded view and
  the permission box lose nothing; approving still writes the exact untruncated input.
- Frame discipline (`.trellis/spec/frontend/live-frame.md`): every rendered row counted, never
  estimated. `BoundedContentRow.tone` is the single colour channel — extend that row shape with
  an emphasis range, never a second path. `toolInputRows`/`permissionDetailRows` and what the
  components draw stay one calculation.
- `tui-testing.md` § visual hierarchy: markers survive ANSI stripping; stable assertable
  substrings for pty tests.
- Replay/export byte-stability: `/export` and `darwin trajectory replay` output unchanged for
  existing records. Verified: `formatReplay` prints only `summary` and `preview` for tool items
  (`src/trajectory/replay.ts:252-257`); the reducer's `summary` string is therefore **not**
  extended — the stat rides a new optional history field the formatter ignores.
- Tone stays scoped to `fileEditor` rows only.
- 120x50 live `approve` scenario stays green with no added frame row.

## Design

- `edit-diff.ts` (pure additions):
  - `diffStat(diffText)` → `{ added, removed }` counted from the marker vocabulary;
    `formatDiffStat(stat)` → `"+N -N"`.
  - `diffLineEmphasis(lines)` → per-line `{ start, end }` UTF-16 ranges (or `undefined`),
    computed by pairing the k-th removal with the k-th addition of a changed run **only when the
    run has equally many removals and additions**, then trimming the common code-point
    prefix/suffix. Pairs sharing no edge context, empty spans, and marker/context lines get no
    emphasis. Enhancement only — never changes any text.
  - `permissionDisplayDetails` labels the collapsed block `Diff (+N -N)`.
- `tool-detail-presentation.ts`: `compactEditDiff(input, toolName)` — the bounded compact
  excerpt. Skips leading unchanged context beyond one line with an explicit
  `… N earlier lines` row, then bounds the rest through the existing `boundText` (explicit
  `… truncated …` marker). Constants `COMPACT_DIFF_LINES`/`COMPACT_DIFF_CODE_POINTS`.
- `turn-state.ts`: compact branch stores the excerpt as `inputPreview`; new optional
  `diffStat` on the tool history item (absent for non-fileEditor / unrecognized shapes —
  absence means "not a diff", never 0).
- `ToolCallPanel.tsx` `ToolCallResult`: renders `inputPreview` in compact mode too (diff rows,
  4-space indent, no `Input:` label); appends ` (+N -N)` spans (green/red) to the existing
  summary `<Text>` row; bold emphasis span inside each toned row's single `<Text>`.
- `frame-budget.ts`: `BoundedContentRow` gains optional `emphasis` range;
  `toolInputRows`/`permissionDetailRows` map logical-line emphasis onto wrapped rows in the
  same single calculation the heights come from (lines containing tabs skip emphasis — wrap
  expansion would skew offsets; the tone still applies).
- `PermissionPrompt.tsx` / `ActiveToolCalls`: render the emphasis span nested inside the
  existing one-`<Text>`-per-row elements. No geometry change.

## Acceptance Criteria

- [x] `pnpm typecheck` exit 0; `pnpm test` exit 0, every suite `0 failed`.
- [x] `spike/verify-edit-diff.ts` extended: stat counts (create/insert/str_replace/delete/
      empty-replacement/unknown), compact excerpt bounds + withheld statements +
      nothing-withheld-says-nothing, emphasis ranges (Unicode-safe), reconstruction unchanged.
- [x] `spike/verify-visual-language.tsx` extended: compact finished edit shows toned diff rows
      and the stat after ANSI stripping; permission modal retains `Diff (+1 -1):`.
- [x] Live `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve` green at 120x50, extended
      to assert the finished edit's compact diff rows and the `+1 -1` stat in the transcript.
- [x] Free pty scenario `completion` green (plus any touched others).
- [x] Purity grep: no fs/read API in `edit-diff.ts`.
- [x] `git diff --check` clean; Trellis validation passing; conventional commit, no push.
