# Prompt recall: the arrow keys, and reading a record nobody may write

> Which keypress reaches into history, what history *is*, and the bounds a reader over a 64 MiB
> append-only file is held to. Row *height* is `live-frame.md`'s subject; the other owner of the
> arrow keys is `prompt-completion.md`; pty mechanics stay in `tui-testing.md`.

Established 2026-08-18 (backlog direction `SER-015`). Asserted by `spike/verify-prompt-recall.ts`
(free) and `spike/verify-tui.ts recall` / `recallEmpty` (free — no model call at all).

## Contract: history is the trajectory record, and nothing else

Darwin stores no prompt history. Every prompt a session sent is already a `userInput` line in
`~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl`, so `readPromptHistory`
(`src/trajectory/prompt-history.ts`) is a **reader over bytes that already exist** — there is no
second store, no new file format and no new on-disk artifact, and there must never be one. A second
store would immediately disagree with the first, and the disagreement would be invisible.

- **Reading is read-only, and provably so.** The reader opens each record `'r'`, reads a tail, and
  closes the handle on every path including a failed read. `verify-prompt-recall.ts` hashes every
  record before and after, hashes (or confirms the absence of) the resume pointer, greps the module
  for write APIs, and runs the reader with the AWS environment sabotaged — the same two-halves proof
  `verify-trajectory.ts` uses for `replay`.
- **What is in history is what was *sent*.** `userInput.text` is the string handed to
  `agent.stream()` (`session-trajectory.md` § the record's shape), which decides most cases for
  free and two deliberately:
  - local commands (`/usage`, `/effort`, `/mode`, `/tasks`, `/agents`, `/trajectory`, `/model`,
    `/compact`, `/clear`, `/exit`) never reach `AgentRuntime.send` and so are **absent** — they are
    session controls, not prompts, and nothing filters them;
  - a **`!` shell command** (SER-024) is absent for the same structural reason, and deliberately so:
    it is recorded as a `shellCommand` record, never a `userInput` line, because nothing was handed
    to `agent.stream()` — recall's contract is "what the session *sent*", and rerunning a shell
    command has the terminal's own history as its home. The *next prompt* the user sends carries the
    bounded `<user-shell-command>` report prepended, so that combined `userInput` text is recalled
    exactly like an expanded project command is today (and excluded by the same 4000-point cap when
    it grows past it). Asserted by `spike/verify-shell-command.ts` and `verify-tui.ts bang` (both
    free);
  - an **empty submission** never reaches it either (`submit` returns on an empty trim);
  - **unknown slash input** is ordinary input and is recalled verbatim;
  - a **skill or project-command expansion** is recorded *expanded*, so it is excluded by
    `MAX_HISTORY_ENTRY_CHARS` (4000 code points) and counted. That cap is deliberately **below** the
    record's own `MAX_FIELD_CHARS` (8000): a `userInput` text that was truncated on the way in must
    never be offered back, because re-sending a silently shortened prompt is worse than being
    offered nothing.
- **A record that is not there is an answer.** `trajectory: false` is supported configuration, a
  session that exits before its first turn writes no file, and a first run has no sessions at all.
  Each is a *reading* with no entries and no problem — never an exception, never a notice per
  keystroke. The reader cannot reject: `listSessionIds` is wrapped, a per-record failure is skipped
  and reported as one `problem` string, and damage inside a record is tolerated exactly as
  `readTrajectory` tolerates it (skipped, counted, never repaired).
- **A session with `trajectory: false` cannot recall its own prompts**, by design: the record is the
  only source, which is what stops "history" from quietly becoming a second, unrecorded copy of
  everything the user typed. Earlier sessions that *did* record are still recalled.
- The current turn's prompt is buffered at turn start and appended when the turn **closes** (one
  write per turn), so it becomes recallable from the next reading. The TUI marks its reading stale in
  `runTurn`'s `finally` and the next `Up` opens a *pending* walk rather than offering the previous
  reading — otherwise the prompt a user most wants back, the one the last turn just sent, would be
  the one missing.

## Contract: the bounds, and that they are stated

A trajectory may reach `MAX_FILE_BYTES` (64 MiB) and a project may hold hundreds of sessions, so
every dimension is bounded and every bound that cut something is **said** on the one row recall
already draws (never a row of its own — `live-frame.md`).

| Bound | Value | What it protects |
| --- | --- | --- |
| `MAX_HISTORY_ENTRIES` | 100 | entries kept in memory, and collected per record (`newest 100, older records not read` when it stops a scan — "records", because the lines it did not read may not have been prompts) |
| `MAX_HISTORY_ENTRY_CHARS` | 4000 | the editor, and the truncation rule above |
| `MAX_HISTORY_SESSIONS` | 20 | records opened per reading |
| `MAX_HISTORY_STAT_SESSIONS` | 200 | sessions stat-ed to order them before those 20 are chosen |
| `MAX_HISTORY_TAIL_BYTES` | 256 KiB | bytes read per record |

- **Tails, not files.** The prompts a person wants back are the last ones written, so each record is
  read from its end and the first line of that window — which the byte offset may have cut in half,
  possibly mid-UTF-8 — is dropped and counted (`tailBounded`). Measured: a 320 KiB record in 3.0ms.
- **Records are ordered by their own mtime**, not by session id: ids sort chronologically only
  because darwin generates them that way, and `--session my-experiment` does not.
- **Prompts are ordered by the time the record observed them** (`t`, stable-sorted), so a resumed
  session appending to an old file interleaves correctly instead of by filename.
- **Consecutive duplicates collapse to one entry**, in recall order — the Claude Code semantics, so
  `Up` twice reaches the previous *distinct* prompt.
- **Nothing blocks.** The read is async, started by the first `Up` (never at startup), cached, and
  invalidated when a turn ends. Measured: 20 records in 2.6ms with 0.00ms worst event-loop lag — the
  number that matters for Ink, whose renders and keystrokes are callbacks on one loop.

## Contract: recall takes no key that already had a meaning

`Up`/`Down` already do two jobs — selecting completion rows and moving between the *visual rows* of a
multi-line draft. Recall is third in line, and the order is enforced by where it is consulted in
`App.tsx`'s `useInput`, not by a predicate that could drift:

1. **A completion menu wins.** The `completions.length > 0` branches handle both keys first, so
   recall is unreachable while a `/` or `@` menu is open — by construction.
2. **`Up` recalls only from an empty draft**, or from the first visual row of a draft that *is* an
   open walk. A non-empty draft the user typed falls through to `moveVertical` exactly as before, so
   **recall can never replace typed text**. That is why no stashed draft exists: there is nothing to
   stash. (Claude Code binds "first row / empty"; this is the strict reading of it, and the one that
   cannot lose work.)
3. **`Down` applies only inside a walk**, and only from the last visual row. Past the newest entry it
   empties the draft — where the walk began — and ends the walk. Outside a walk, `Down` is untouched.
4. **Cursor movement does not end a walk; every edit does.** So `Up` through a recalled multi-row
   prompt moves up its rows and only then steps further back, while typing, pasting,
   backspace/delete, `Ctrl+K`/`Ctrl+U`, `Ctrl+W`, accepting a completion and submitting all hand the
   draft back to the user (`endRecall`).
5. **The walk never wraps.** At the oldest entry `Up` holds still and the row says `(oldest)`;
   wrapping to the newest is how a walk loses the user's place.
6. A recalled entry lands with the **cursor at its end**, which is what makes rule 2's "first visual
   row" reachable for a one-row prompt and rule 4's row-walk natural for a multi-row one.

The walk itself (`src/tui/prompt-recall.ts`) is pure and synchronous — `openPromptRecall`,
`stepPromptRecall`, `promptRecallIndicator` over a snapshot of the entries, so a reading landing
mid-walk cannot renumber what `Up` is stepping through. The split is `path-completion.ts`'s: bounded
async I/O in one module, the part a keystroke runs in another.

## Contract: one row, counted, and honest

- The indicator is **one row** under the draft and above the completion menu — below it, so a
  windowed draft's cursor row (frame-absolute in `useCursor`) is not moved by it. Counted through
  `promptBoxWanted`/`planPromptBox` (`hasRecall`, `RECALL_INDICATOR_ROWS`), granted after the menu
  and before the hint: it explains why the draft just changed, which is worth more than a standing
  reminder of which commands exist and less than the list the other arrow key is driving.
- It is **one `<Text wrap="truncate-end">`** — the live-frame rule for any row whose height must be
  known — and everything it has to add is a **suffix**: `history 3/12 · ↑ older ↓ newer — newest 100
  of 137, 3 session(s) not read, 2 long prompt(s) skipped`.
- The three states it distinguishes are load-bearing: `history: reading this project’s record…`
  while the read is in flight (claiming "no earlier prompts" about a file nobody has opened yet is a
  lie in the row the user is reading), `history: no earlier prompts in this project` for a real empty
  reading, and the position otherwise.
- The header gains **no** row, ever (`live-frame.md`).

Tests required: `spike/verify-prompt-recall.ts` (the reader against real files — damage, every bound,
byte identity, the sabotaged environment, plus one turn recorded by the real `TrajectoryRecorder` so
the shape read back is the shape darwin writes — and the pure walk), `spike/verify-tui.ts recall`
(the bindings coexisting, the collapse, the earlier session, byte identity) and `recallEmpty`
(`trajectory: false` and a project with no record degrade to no history), `spike/verify-frame-budget.ts`
(the indicator in the "never taller than its grant" matrix, and its position between draft and menu),
plus `verify-tui.ts cursor`, `multiline`, `completion`, `pathCompletion` and `tallDraft` for the keys
and rows recall must not have taken.
