# The completion menu: two sources, and why `@` inserts a path and never a file

> What may open the menu under the draft, what accepting a row is allowed to do, and the bounds the
> workspace scan behind `@` is held to. Row *height* is `live-frame.md`'s subject and is not
> re-litigated here; pty mechanics stay in `tui-testing.md`.

## Contract: `@` inserts the path text, never the file's content

Three peer products offer `@` in the composer and disagree about what follows — Codex adds the
file's *path* to the prompt, OpenCode inlines its *content*, Claude Code autocompletes the path.
Darwin takes the Codex shape, and this is a **decided product question, not an open one**: with a
path in the draft, every byte of file content still reaches the model through the existing
`fileEditor` read, which is classified by `PermissionGate`, gated, and recorded in the trajectory.
Inlining would be a second route for file content into context with none of that.

So `src/tui/path-completion.ts` opens no file. It reads *directory entries* (`opendir`, `lstat` via
the dirent, `realpath` for symlinks) and nothing else — asserted in `verify-path-completion.ts` by
grepping the module for every file-reading API, because a future `readFile` here would be a quiet
bypass of the permission layer rather than a visible bug.

- **Accepting a completion changes the draft and nothing else.** No tool call, no request, no
  notice, no history entry. `applyPathCompletion` is a function from strings to strings.
- **The `@` is scaffolding.** Accepting a **file** replaces the whole `@…` token with the plain path
  and one space — the text a person would have typed. Accepting a **directory** replaces it with
  `@<dir>/`, keeping the marker so the next keystroke keeps completing one level down. Dropping the
  marker on a directory would dead-end multi-level completion (nothing would re-open the query);
  keeping it on a file would leave a mention nobody asked for in the prompt.
- **Staleness is only ever a missing row.** The candidate list is a cached reading of the tree, so a
  path that has moved since costs a wrong *argument* to a tool call the user can see — never a
  silent read of the wrong file. That is what makes a 5s TTL an acceptable trade for not scanning
  per keystroke.

## Contract: where a trigger is recognized, and what a non-trigger `@` does

`pathCompletionQuery(text, cursorOffset)` is pure, and the rule is one sentence: scanning back from
the cursor reaches an `@` without crossing whitespace, **and** the character before that `@` is the
start of the draft or whitespace.

- `user@example.com` never triggers — the `@` is preceded by `r`. Neither does any `@` typed inside
  a word. A newline is whitespace, so a multi-line draft triggers per line; a space after the query
  closes it, the same "a space ends it" rule `computeCompletions` uses for commands.
- A query past `MAX_PATH_QUERY_LENGTH` (256) is prose or a pasted blob, not a path prefix, and opens
  nothing.
- **Recognizing a trigger is not opening a menu.** A query that matches no workspace path offers no
  rows, so `@override` or `@someone` in a sentence draws nothing and takes no keys. This is the
  mechanism that keeps prose safe — *not* a list of exceptions.
- Matching is prefix-then-basename and never fuzzy: paths starting with the query first, then (only
  when the query contains no `/`) paths whose last segment starts with it, both case-insensitive,
  both in scan order. A menu whose top row moves for reasons the user cannot see is worse than one
  they can predict.

## Contract: two sources, and the first must not become ambiguous

`computeCompletions` (slash commands) is computed first and **wins whenever it is non-empty**; the
path query is consulted only then. A third owner of `Up`/`Down` joined them in `SER-015` and is
behind both: while a menu is open the arrows select rows, and prompt recall is only consulted after
those branches have declined the key (`prompt-recall.md`). `computeCompletions` moves into the pure
`prompt-completion.ts` seam without changing its "the input must start with `/` and contain no space"
rule, and
`verify-tui.ts completion` remains the check that every built-in is still visible. `/help`
is a built-in row and its command section projects `BUILTIN_COMMAND_NAMES` plus
`BUILTIN_COMMAND_DESCRIPTIONS` directly; it must never own a second name/description inventory.

## Contract: Escape dismisses one query generation

`Escape` closes the completion rows currently offered by either source without editing the draft or
cursor. The suppression key is the pure query identity from `promptCompletionState`, mirrored beside
the editor so several stdin events in one React pass see the same answer. It is not a general
"completion off" flag:

- the same slash/path query stays closed, so a second `Escape` is inert;
- an edit or cursor move that produces a different query identity re-arms completion immediately;
- Tab, Enter, and arrows consult the same mirrored visibility before acting, so a dismissed menu
  cannot be accepted or navigated from a stale render;
- dismissal performs no submit, queue/runtime/trajectory mutation, notice, path rescan, or frame-row
  addition. The menu simply stops claiming its existing rows.

Permission ownership is earlier in `App.useInput`, so permission `Escape` still denies. Compaction's
input-ownership return is also earlier, so editor `Escape` is ignored while compaction runs.

`MAX_COMPLETIONS` grows with the canonical list so adding help cannot hide the previous tail; the
twentieth built-in, `/copy` (SER-057), grew it to 21, and `verify-tui.ts completion` asserts the row
with its description because a custom command may also be named `copy`.

`InputBox` therefore takes a `completionKind`: a command row is `/name — description`, a path row is
the path itself with no description (inventing one would mean reading the file). Only the rendering
differs; the *height* is identical, so `planPromptBox`/`promptBoxWanted` know nothing about the
kind and `MAX_COMPLETIONS` caps both.

## Contract: overflow follows the selected candidate

Navigation and acceptance operate on the complete, source-ordered candidate array; bounding is a
presentation concern only. `completionWindow` projects the entry grant into one contiguous window
around that full-list index. It never sorts, copies identities into a second catalogue, or clamps
navigation to the visible rows. `Up`/`Down` still wrap over the complete array.

- Whenever at least one entry is granted, the selected candidate is inside the window and is the
  **only** row marked `❯`. First and last selections pin the window to the corresponding edge;
  middle selections keep source order around the marker.
- The existing single overflow row states every omitted candidate as a total plus `N above`,
  `N below`, or both. It is paid from the unchanged `planPromptBox` grant; no second omission row,
  frame participant, or unbounded list is allowed.
- Tab and Enter resolve the same full-list identity that the visible `❯` marks. Completion state
  has an immediate ref mirror, and acceptance re-derives candidates from the immediate editor
  mirror, because terminals may batch arrows plus acceptance before React commits another render.
  A stale render closure must never accept a different row.
- Command-before-path ownership and every later keyboard owner remain unchanged: completion arrows
  precede queue take-back and recall, while permission and compaction still own the keyboard first.

## Contract: the scan is bounded, exclusion-first, and cannot escape the project root

`scanWorkspacePaths(projectRoot)` is breadth-first — the shallow paths are the ones people complete,
and truncation then drops the deepest rather than an arbitrary subtree.

- **Bounds:** `MAX_SCAN_ENTRIES` 8000 dirents inspected, `MAX_SCAN_DEPTH` 8 levels,
  `MAX_PATH_CANDIDATES` 4000 candidates. Measured in this repository: 892 candidates from 897
  entries, 33ms; a `node_modules`-sized directory hits the candidate bound at 4001 entries in 27ms.
- **`EXCLUDED_DIRECTORY_NAMES` is matched at any depth** and excludes by *name*: `.git`,
  `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.nuxt`, `.turbo`, `.cache`, `.venv`,
  `venv`, `__pycache__`, `target`, `vendor`, `.pnpm-store`, `.yarn`, `.gradle`, `.idea`, `.svn`,
  `.hg`. Excluded directories are neither walked nor offered. This is what keeps the numbers above
  small: scanning this repository's own `node_modules` as a root reaches only 448 entries, because
  pnpm's top level is symlinks and every nested `node_modules` is excluded.
- **Symlinks are never traversed**, and are offered only when `realpath` stays inside the project
  root. `src/skills/resource-safety.ts` *throws* on the same conditions because a skill about to run
  is a security boundary; a completion menu **skips** instead — fewer rows must never be able to
  stop somebody typing. An unreadable directory degrades the same way.
- **Nothing blocks.** The scan is async, started by the first trigger (never at startup) and cached
  per project root for `PATH_SCAN_TTL_MS`. A keystroke only ever runs the pure matcher: measured
  worst case 0.32ms over 892 candidates, and worst event-loop lag during a full scan 0.1ms. That
  second number is the one that matters for Ink, whose renders and keystrokes are callbacks on the
  same loop.
- **A bounded or degraded reading is stated in the row the menu already has** — the title becomes
  `files (…) — bounded scan: N paths:` or `— partial scan: <reason>:`. Never a row of its own: the
  frame budget counts the menu as title + entries + overflow (`live-frame.md`).

Tests required: `spike/verify-path-completion.ts` (pure trigger/match/accept contracts, a real temp
tree for exclusions and the symlink escape, and the two measurements above — all free),
`spike/verify-tui.ts pathCompletion` (free, no model call: the menu, both acceptance shapes, the
absent file content, the non-trigger cases), `spike/verify-frame-budget.ts` (a path menu is in the
"never taller than its grant" matrix, and the note is asserted to be a title suffix), and
`spike/verify-tui.ts completion` for the source that already existed.
