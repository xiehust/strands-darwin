# Recall previous prompts from the trajectory record

Backlog direction `SER-015` (`docs/research/backlog_index.md`, origin report
`docs/research/research_2026-08-18.md` run `01:25:31Z`). Base revision `9d3b4cc`.

## Goal

Let the user recall previous prompts in the editor with `Up`/`Down`, read from the project's
**existing** trajectory records, without disturbing completion or cursor keys.

Darwin has no prompt history today: `src/tui/prompt-editor.ts` exports layout/insert/delete/
word-kill/cursor primitives and nothing about history, and `src/tui/InputBox.tsx` has no notion of
one — so a mistyped long prompt is retyped. Meanwhile every prompt this project ever sent is
already durably recorded per project in
`~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl`
(`.trellis/spec/backend/session-trajectory.md`), readable with no model call and no network
(`src/trajectory/reader.ts`, `search.ts`). This is therefore a **reader over bytes that already
exist** — no second store, no new file format, no new on-disk artifact.

## Requirements

1. **Recall reads the trajectory and nothing else.** Entries come from `userInput` records of this
   project's sessions, newest first, consecutive duplicates collapsed to one entry, spanning
   earlier sessions of the same project.
2. **The keys that already have meanings keep them.** `Up`/`Down` select completion rows whenever a
   menu is open (`/` commands or `@` paths) and otherwise move the cursor between *visual rows* of
   a multi-line draft (`moveVertical`). Recall may eat neither.
3. **No model call, no network, no write.** No `Agent`, no `Model`, no touch of the resume pointer,
   no rewrite/truncate of any trajectory file, no file created.
4. **Bounded, and honest about it.** A trajectory file may reach 64 MiB. Bound what is read and
   what is kept — in entries *and* bytes — and state what is not shown where the user can see it.
   A keystroke never waits on the read (`src/tui/path-completion.ts` is the worked precedent).
5. **No record degrades to "no history", never to an error.** `trajectory: false`, a partial
   trailing line, a damaged interior line, and a project with no sessions at all must each leave a
   usable editor and no error.
6. **Frame budget.** Anything drawn is a redrawn participant: rows are *counted* through the same
   helpers the components render from, and the header gains no row
   (`.trellis/spec/frontend/live-frame.md`, `prompt-completion.md`).
7. **Scope.** `Up`/`Down` recall is the requirement; `Ctrl+R` reverse search is optional and only
   if it costs nothing against the contracts above. No other editor features.

## Decisions

### Binding

- **`Up` recalls only when the draft is empty, or when a recall walk is already active and the
  cursor is on the first visual row.** A non-empty draft that is not a recall falls through to
  `moveVertical` exactly as today, so **recall can never replace typed text** — the strongest
  reading of Claude Code's "at the first row / the draft is empty" rule, and the one that needs no
  stash to be safe.
- **`Down` applies only while a walk is active and the cursor is on the last visual row.** It steps
  to a newer entry; past the newest it empties the draft and ends the walk. Outside a walk `Down`
  is untouched.
- A completion menu wins by construction: the existing `completions.length > 0` branches run first,
  so recall is unreachable with a menu open.
- Cursor movement does *not* end a walk (so `Up` through a multi-row recalled entry reaches its top
  row and then steps further back); any **edit** — typing, paste, backspace/delete, kill,
  word-kill, accepting a completion — ends it, as does submitting and `/clear`.

### Eligibility (what belongs in history)

History is what the record holds: the string handed to `agent.stream()`.

- Local commands (`/usage`, `/effort`, `/mode`, `/tasks`, `/agents`, `/trajectory`, `/model`,
  `/compact`, `/clear`, `/exit`) never reach `runtime.send`, so they are **absent** from history —
  nothing to filter, and the right answer: they are session controls, not prompts.
- Empty submissions never reach it either (`submit` returns early on an empty trim).
- A **skill or project-command expansion** is recorded expanded (that is the contract), and its
  body is a multi-kilobyte document nobody wants in the editor. Entries longer than
  `MAX_HISTORY_ENTRY_CHARS` (4000 code points) are therefore **excluded and counted**. The cap sits
  under the record's own `MAX_FIELD_CHARS` (8000), so a *truncated* `userInput` text can never be
  offered — recalling a shortened prompt would be worse than offering none.
- Unknown slash input is ordinary input and is recalled verbatim.

### Bounds

| Bound | Value | Why |
| --- | --- | --- |
| `MAX_HISTORY_ENTRIES` | 100 | kept in memory, newest first, after collapsing |
| `MAX_HISTORY_ENTRY_CHARS` | 4000 | see above |
| `MAX_HISTORY_SESSIONS` | 20 | trajectory files opened per read |
| `MAX_HISTORY_STAT_SESSIONS` | 200 | sessions ordered by record mtime before choosing those 20 |
| `MAX_HISTORY_TAIL_BYTES` | 256 KiB | bytes read per file, from the **end**: the newest prompts |

Every bound that cut something is stated on the recall indicator row (`newest 100 of 137`,
`12 sessions not read`, `4 long entries skipped`, `partial read: …`).

### Drawing

One dim row under the draft, above the completion menu: `history 3/12 · ↑ older ↓ newer`, plus the
bound note. Counted through `promptBoxWanted` / `planPromptBox` (`hasRecall`), granted after the
menu and before the hint, never a header row.

## Acceptance Criteria

- [ ] Recall returns this project's previous prompts, newest first, consecutive duplicates
      collapsed, reaching earlier sessions of the same project.
- [ ] Recall never fires with a `/` or `@` menu open, and never replaces multi-row cursor movement.
- [ ] A project with no records, and a session run with `trajectory: false`, degrade to
      "no history": no error, usable editor.
- [ ] The read makes no model call and no network request, writes nothing, and leaves every
      trajectory file and the resume pointer byte-identical (sha256 before/after).
- [ ] Slash commands, skill expansions and empty submissions are absent from history, tested.
- [ ] `pnpm typecheck` clean; `pnpm test` zero failures; `verify-prompt-editor`,
      `verify-frame-budget`, `verify-trajectory`, `verify-path-completion`, new
      `verify-prompt-recall`; free pty scenarios `completion`, `pathCompletion`, `cursor`,
      `multiline`, `mode`, `clear`, `tallDraft` plus a new `recall` scenario; `git diff --check`
      clean; Trellis validation passes.

## Notes

- New files: `src/trajectory/prompt-history.ts` (bounded async reader),
  `src/tui/prompt-recall.ts` (pure walk + indicator), `spike/verify-prompt-recall.ts`,
  `spike/verify-tui.ts recall`.
- The current turn's prompt is buffered at turn start and appended at turn **end** (one write per
  turn), so recall sees it from the next turn on. Documented rather than worked around: the record
  is the single source, which is what keeps `trajectory: false` honest instead of secretly
  duplicated in memory.
