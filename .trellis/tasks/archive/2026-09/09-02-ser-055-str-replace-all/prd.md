# SER-055: optional `replace_all` on `fileEditor str_replace`

## Goal

The pinned SDK file editor refuses a `str_replace` whose `old_str` occurs more than once
(`No replacement was performed. Multiple occurrences of old_str … Please ensure it is unique`), and
system-prompt rule 8 forbids `sed -i`, so a bulk rename inside one file costs N gated calls today.
Extend the patched editor so `str_replace` accepts an optional `replace_all: boolean` (default
`false`) that replaces every non-overlapping occurrence in **one** write, and make the TUI state
that scope from the tool *input* (never a disk read). Absent/`false` stays byte-identical.

Backlog record: `docs/research/backlog/directions-061-080.md` § SER-055 (Priority 77). Peer
evidence: Claude Code `Edit` requires uniqueness unless `replace_all: true`.

## Requirements

- R1. Schema: `fileEditorInputSchema` gains `replace_all: z.boolean().optional()` whose description
  states it applies to `str_replace` only and that other commands ignore it. **Decision: other
  commands ignore it** — that is today's observed behaviour (the zod object strips the key; an
  `insert` carrying `replace_all: true` already succeeds with unchanged bytes), so nothing new is
  invented.
- R2. `replace_all: true`, ≥ 1 occurrence: every non-overlapping occurrence (the existing
  `findOccurrences`) is replaced in one `sandbox.writeText`; the success text names the count and
  the 1-based line numbers of the occurrences **as counted in the file before the edit** (the same
  numbers the uniqueness error reports), and shows one snippet — the first replacement's — through
  the existing snippet computation. Exactly 1 occurrence: the same result shape with count 1.
- R3. `replace_all: true`, 0 occurrences: today's exact miss error + advisory, unchanged.
  Empty `old_str`: today's exact error, unchanged (checked before occurrence counting, as today).
- R4. `replace_all` absent or `false`: every path byte-identical to today — empty-`old_str` error,
  miss advisory, `Multiple occurrences … Please ensure it is unique` error, single-replacement
  success text. Today's strings were captured **before** any change (2026-09-02, pristine
  `node_modules`) and are embedded as literal expectations.
- R5. `src/tools/file-editor-serial.ts`: passes the field through unchanged (the wrapper delegates
  the SDK `stream()` with the original context); `toolSpec` is the SDK object, so the new schema
  property is visible through the wrapper; same-path ordering unchanged.
- R6. `src/tui/edit-diff.ts`: the reader accepts `replace_all` (boolean) on `str_replace` inputs;
  `fileEditorDiff` stays the bare one-pair diff (old/new recoverable; `diffStat` unchanged);
  `fileEditorInputProjection` adds one header row `replace_all: every occurrence` when the input
  carries `replace_all: true`; the compact finished row (`compactEditDiff`) is preceded by the same
  one row. `replace_all: false` yields no marker. A non-boolean `replace_all` is an unrecognized
  shape (raw fallback). No file is read (module import graph unchanged: no `node:fs`).
- R7. Permission: `classify('fileEditor', …)` stays `kind: 'write'` with the same `summary`; a
  `str_replace` with `replace_all: true` gains one detail row `Replace all: every occurrence`
  (after `Operation`, before the `editContent` blocks) so the permission box, dev-repl and every
  other consumer of the gate state the scope; `permissionDisplayDetails` passes it through as a
  non-diff block. `summary` never carries the marker (replay prints it verbatim).
- R8. Docs: `.trellis/spec/backend/strands-sdk-contracts.md` FileEditor contract states
  `replace_all`; `.trellis/spec/frontend/tui-testing.md` diff contract names the marker row and the
  detail row; `docs/architecture/load-bearing-decisions.md` File-edit diffs / same-path sections get
  one-sentence additions; `docs/user-guide/reference.md` + `reference.zh-CN.md` mention the option;
  AGENTS.md row only if a phrase becomes false (file stays < 32 KiB).
- R9. The SDK patch is regenerated with the repository procedure (`pnpm patch` → edit →
  `pnpm patch-commit`), re-applies cleanly, and `patches/@strands-agents__sdk@1.16.0.patch` changes
  (lockfile patch hash follows). No new dependency.

## Acceptance Criteria

- [x] AC1. `spike/verify-file-editor.ts` (in `pnpm test`): 3 occurrences → one write, count 3, the
  three original line numbers, whole-file bytes equal the expected string; 0 occurrences → today's
  exact miss advisory; 1 occurrence → count 1; absent/`false` → today's captured strings exactly for
  success, miss, multiple and empty `old_str`; schema exposes the optional boolean; `insert` with
  `replace_all: true` behaves exactly as without it.
- [x] AC2. `spike/verify-file-editor-serial.ts` passes and gains a pass-through assertion.
- [x] AC3. `spike/verify-edit-diff.ts` proves the marker row for `replace_all: true`, its absence
  otherwise, `fileEditorDiff` unchanged in form, old/new still reconstructable, the permission detail
  row, `summary` unchanged, no `node:fs` in the module; `spike/verify-visual-language.tsx` green.
- [x] AC4. Patch re-applies (`pnpm install --frozen-lockfile` after regeneration; `node --check`
  on the installed file) and `git diff --stat` shows the patch file changed.
- [x] AC5. `pnpm typecheck` clean; full `pnpm test` exit 0 with zero FAIL lines.
- [x] AC6. Commits follow the convention; task archived; `git status --porcelain` clean.

## Evidence (2026-09-02)

- Pre-change capture: the four `str_replace` strings (multiple / miss / empty / single) plus the
  `insert` text and the provider schema were printed from the installed tool before any edit and
  embedded verbatim in `verify-file-editor.ts` § "replace_all absent/false is byte-identical".
- `pnpm tsx spike/verify-file-editor.ts`: 89 passed, 0 failed (was 63).
- `pnpm tsx spike/verify-file-editor-serial.ts`: 50 passed, 0 failed (was 45).
- The four pre-change spike files (`git show HEAD:spike/…`) still pass unchanged against the new
  code and patch (63 / 45 / 96 / 69) — the existing contracts did not move.
- `pnpm tsx spike/verify-edit-diff.ts`: 112 passed, 0 failed (was 96).
- `pnpm tsx spike/verify-visual-language.tsx`: 74 passed, 0 failed (was 69).
- `pnpm typecheck` clean; full `pnpm test` exit 0, zero `FAIL` lines, 84 suite summaries.
- Patch: `pnpm patch @strands-agents/sdk@1.16.0 --edit-dir …` (existing patch pre-applied) → edits
  → `node --check` → `pnpm patch-commit`; `git diff --stat` shows `patches/…patch | 112 ++--` and
  the lockfile `patch_hash` (3 lines). Re-apply proof: `pnpm patch --ignore-existing` (pristine,
  0 `replace_all`) + `patch -p1 --dry-run` clean + `diff -r` of the patched pristine `dist` against
  the installed `dist` is empty. `pnpm install --frozen-lockfile` exit 0. `pnpm build` done.
- AGENTS.md 32,578 → 32,667 B (< 32,768): the FileEditor recovery row gained one clause.
- Decision made in flight: the permission-box marker comes from `classify()` as a detail row
  (`Replace all: every occurrence`), not from the TUI projection, so dev-repl and every other gate
  consumer state it too; the finished/expanded rows use the edit-diff header row
  (`replace_all: every occurrence`). `classify` kind/summary unchanged (asserted).

## Requirement-to-test checklist

| Requirement | Proof |
|---|---|
| R1 schema | `verify-file-editor.ts`: `schema.properties.replace_all.type === 'boolean'`, not in `required`, description contains `str_replace`; `insert` + `replace_all: true` text identical to the captured `insert` text |
| R2 three occurrences | `verify-file-editor.ts`: `replace_all: true`, 3 hits → `success`, exactly one sandbox write, text contains `3 occurrences` and `[1,3,5]`, file bytes equal the expected string, snippet is the first replacement's |
| R2 one occurrence | same suite: 1 hit → `success`, text contains `1 occurrence` and `[4]` |
| R2 non-overlapping | same suite: `old_str: 'aa'` in `aaaa` → 2 replacements, not 3 |
| R3 miss / empty | same suite: `replace_all: true` + absent `old_str` text === captured miss text (path-substituted); empty `old_str` text === captured empty text |
| R4 identity | same suite: absent and `false` texts === captured success / miss / multiple / empty strings |
| R5 wrapper | `verify-file-editor-serial.ts`: wrapped `replace_all: true` call on 3 hits succeeds with all three replaced (same result bytes as unwrapped) and the wrapper's `toolSpec` exposes `replace_all` |
| R6 marker | `verify-edit-diff.ts`: `fileEditorInputProjection` contains `replace_all: every occurrence` for `true`, not for `false`/absent; `compactEditDiff` first row is the marker, rest equals `fileEditorDiff`; `fileEditorDiff` equals the non-replace_all diff; `oldOf`/`newOf` recover the pair; `diffStat` equal; `replace_all: 'yes'` → `undefined` |
| R6 no disk read | `verify-edit-diff.ts`: the module source contains no `node:fs` / `readFile` import |
| R7 permission | `verify-edit-diff.ts`: `classify` → `kind: 'write'`, `summary === 'fileEditor str_replace: <path>'`, labels `Path,Operation,Replace all,Replace,With`; `permissionDisplayDetails` → `Path,Operation,Replace all,Diff (+1 -1)`; absent → today's `Path,Operation,Replace,With` |
| R8 docs | `rg -n replace_all` over the four doc/spec files; `wc -c AGENTS.md` < 32768 |
| R9 patch | `git diff --stat patches/`; `pnpm install --frozen-lockfile` exit 0; `node --check` |
| AC5 | `pnpm typecheck`; `pnpm test` |
| AC6 | `git log --oneline`, `task.py archive`, `git status --porcelain` |

## Constraints

- Mutations limited to: `patches/@strands-agents__sdk@1.16.0.patch` (via `pnpm patch` of
  `file-editor.js` + `types.d.ts`, with the lockfile hash that follows), `src/tools/file-editor-serial.ts`,
  `src/tui/edit-diff.ts`, `src/tui/tool-detail-presentation.ts` (marker row of `compactEditDiff`),
  `src/agent/permission.ts` (one detail row), the three spikes named above (+ `verify-visual-language.tsx`
  extend-only), `.trellis/spec/**`, `.trellis/tasks/**`, `.trellis/workspace/**`,
  `docs/architecture/load-bearing-decisions.md`, `docs/user-guide/reference*.md`, AGENTS.md.
- Out of scope, recorded: `src/hooks/tool-hooks.ts` `validatePortableToolInput` lists the fileEditor
  keys a Codex `PreToolUse updatedInput` may carry and does not include `replace_all`; a hook that
  rewrites a `replace_all` input is refused fail-closed (`has unsupported fields`), never misapplied.
