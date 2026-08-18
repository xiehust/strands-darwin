# At-mention path completion in the prompt editor (SER-014)

## Goal

The user can complete workspace file paths from `@` in the prompt editor. Accepting a completion
inserts **the path text only** — no file is opened, no content is read, nothing is sent to the
model, no tool runs.

Explicitly *not* this task: inlining file content (OpenCode's shape), a second context-injection
route of any kind, fuzzy/scored ranking, `@`-completion of anything other than workspace paths
(agents, skills, symbols), or completion in the headless/dev-repl surfaces.

## Background — what the code was before

- `computeCompletions(input, commandNames)` (`src/tui/App.tsx`) returns candidates only for a bare
  `/prefix`: it bails unless the input starts with `/` and returns `[]` as soon as the input
  contains a space. There was no second completion source, and `InputBox` rendered every row as
  `/{name}` with `builtinCommandDescription(name)`.
- `MAX_COMPLETIONS = 11` (`src/tui/InputBox.tsx`) caps what is *offered*; `planPromptBox`
  (`src/tui/frame-budget.ts`) decides how much of that survives a short terminal, and states the
  rest through its `… n more` row (`.trellis/spec/frontend/live-frame.md`).
- Three peers offer `@` in the composer and disagree about what it means: Codex adds the *path*,
  OpenCode inlines the file's *content*, Claude Code triggers path autocomplete — sources in
  `docs/research/research_2026-08-18.md` (run `01:25:31Z`), backlog SER-014.
- Bounded-listing precedent: `src/agent/working-context.ts` (`MAX_LISTED_ENTRIES`, one level,
  symlinks marked and never followed). Symlink-refusal precedent: `src/skills/resource-safety.ts`
  (`lstat` + `realpath` + `isInside`, an entry budget that throws).

## Requirements

1. **Path only.** Accepting a completion changes the draft text and nothing else. Completion never
   opens a file, never reads bytes, never calls a tool and never sends anything to the model.
2. **Bounded scan.** The candidate scan is bounded in entries *and* depth, skips the directories a
   repository scan has no business walking, and cannot produce a candidate outside the project
   root through a symlink.
3. **No stall.** Typing never waits on the filesystem. The scan is asynchronous and cached; only
   pure string matching runs per keystroke. Proven by measurement, in this repository, with
   `node_modules/` and `dist/` present.
4. **`/` completion unchanged.** `computeCompletions` keeps its exact behaviour (including "a space
   ends the command"), the command menu wins whenever it has candidates, and
   `spike/verify-tui.ts completion` stays green with every built-in visible.
5. **Counted heights.** The menu height is counted through the helpers the components render from;
   nothing new is estimated and no new frame row is added. What is not shown is stated.
6. **Keyboard ownership untouched.** The permission box and compaction keep the keyboard (SER-010);
   `Up`/`Down`/`Tab`/`Enter` semantics while a menu is open are exactly what `/` completion already
   had.

## Decisions

- **Trigger.** A query is open when, scanning back from the cursor, an `@` is reached without
  crossing whitespace, and the character before that `@` is start-of-draft or whitespace (`\s`, so
  a newline counts — a multi-line draft triggers per line). Consequences, all deliberate:
  `user@example.com` never triggers (the `@` is preceded by `r`); `@` typed mid-word never
  triggers; a query containing whitespace closes itself; a query longer than
  `MAX_PATH_QUERY_LENGTH` (256) is not a path prefix and opens nothing. A trigger with **no
  matching workspace path opens no menu at all**, which is what keeps `@override` or `@someone` in
  prose from hijacking anything.
- **Marker is scaffolding.** Accepting a **file** replaces the whole `@…` token with the plain path
  plus one space — the Codex shape, plain path text in the prompt. Accepting a **directory**
  replaces it with `@<dir>/`, keeping the marker so the very next keystroke continues completing
  inside that directory; the marker only survives while the mention is unresolved.
- **Two sources, never ambiguous.** The command menu is computed first and wins whenever it is
  non-empty; the path menu is consulted only then. `computeCompletions` is not touched.
- **Ranking is prefix-then-basename, never fuzzy.** Path-prefix matches first, then (only when the
  query has no `/`) basename-prefix matches, both case-insensitive, both in scan order. Scan order
  is breadth-first, so root entries come before deep ones and a truncated scan drops the deepest.
- **Bounds.** `MAX_SCAN_ENTRIES = 8000` dirents inspected, `MAX_SCAN_DEPTH = 8` levels,
  `MAX_PATH_CANDIDATES = 4000` candidates kept (this repository, excluding the skipped
  directories, is 908 entries at depth ≤ 6). Excluded names — `.git`, `node_modules`, `dist`,
  `build`, `out`, `coverage`, `.next`, `.nuxt`, `.turbo`, `.cache`, `.venv`, `venv`,
  `__pycache__`, `target`, `vendor`, `.pnpm-store`, `.yarn`, `.gradle`, `.idea`, `.svn`, `.hg` —
  are neither walked nor offered.
- **Symlinks are never traversed** and are offered only when `realpath` stays inside the project
  root; one pointing out is skipped entirely. Unlike `resource-safety.ts` this *skips* rather than
  throws: a completion menu degrading to fewer rows is right, refusing to type is not.
- **Cache.** One scan per project root, reused for `PATH_SCAN_TTL_MS = 5000`, started by the first
  trigger (never at startup — a session that never types `@` pays nothing) and refreshed on the
  next trigger after the TTL. While a scan is in flight the menu simply has no rows; a scan that
  cannot read a directory degrades to whatever it did read and says so in the menu title.
- **The menu states its own limits in the row it already has.** Title `files (…)` instead of
  `commands (…)`, with the scan problem or the entry bound appended to that same title row; the
  `… n more` row keeps saying how many matches are not shown.

## Acceptance Criteria

- [ ] Typing `@` offers bounded path completions from the project; accepting one inserts the path
      text and nothing else; no file content is read or injected.
- [ ] Excluded directories never appear; a symlink to a directory outside the root produces no
      candidate outside it.
- [ ] A large tree neither stalls the editor nor overflows the frame; the menu obeys
      `MAX_COMPLETIONS` and the frame budget and states what it is not showing.
- [ ] A non-trigger `@` (prose, email address) leaves the draft alone and opens no menu.
- [ ] `spike/verify-path-completion.ts` (new, free) covers trigger/non-trigger, matching,
      acceptance, exclusions, symlink escape, bounds, and prints a measurement of the scan and of
      per-keystroke matching in this repository.
- [ ] `spike/verify-tui.ts pathCompletion` (new, free, no model call) proves it end to end in a
      real pty.
- [ ] Existing checks green: `verify-tui.ts completion`, `verify-prompt-editor.ts`,
      `verify-frame-budget.ts`, `verify-tui.ts multiline`/`cursor`, `verify-tui.ts mode`.
- [ ] `pnpm typecheck` exit 0, `pnpm test` zero failures, `git diff --check` clean, Trellis
      validation passes.
