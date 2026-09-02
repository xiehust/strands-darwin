# SER-060 /tasks shows the last three non-empty output lines of each background job

## Goal

`/tasks` currently prints one row per background job (short id, state, elapsed, command). A
user watching a long build has to ask the model for `bash output` to learn whether the job is
progressing. Codex `/ps` shows "each background terminal's command plus up to three recent,
non-empty output lines"; `claude logs <id>` is the same need. `/tasks` gains that: under each job
row, up to three recent non-empty output lines, read as a **bounded tail of the job's log file**
— never through the manager's `readOutput`, so the model's shared byte cursor and any `wait` in
flight are untouched.

Backlog record: `docs/research/backlog/directions-081-100.md` § SER-060 (Priority 81). Origin run
`## Run — 2026-09-02T14:43:25Z` in `docs/research/research_2026-09-02.md` (sources S2 Codex `/ps`,
S1 `claude logs <id>`).

## Requirements

- R1. **Tail reader.** A new module `src/tools/background-tail.ts` exports `TASK_TAIL_LINES` (3),
  `TASK_TAIL_WINDOW_BYTES` (a named KiB constant), `readBackgroundTail(outputPath)` and
  `readBackgroundTails(tasks)`. The reader opens the file read-only (`O_NOFOLLOW`, regular file
  only), reads at most the last `TASK_TAIL_WINDOW_BYTES` bytes, drops a leading partial line when
  the window did not start at byte 0, splits on `\r\n` / `\n` / `\r`, strips ANSI escape sequences
  and other C0 control characters, expands tabs to spaces, drops blank/whitespace-only lines, and
  keeps the last `TASK_TAIL_LINES`. It reports `bytesRead`. It never imports or touches
  `BackgroundBashManager`, the task's `cursor`, `OUTPUT_LIMIT` accounting or any `wait`: the
  model's `bash output`/`wait` results (`startOffset`/`endOffset`/`output`/`hasMore`) before and
  after a `/tasks` are byte-identical.
- R2. **Stated absence, never an error.** Open/stat/read failure (missing, replaced, unreadable
  file) yields `{ kind: 'unavailable' }`; a readable file with no non-empty line yields
  `{ kind: 'empty' }`. The reader never throws.
- R3. **Formatter.** `formatTasksReport(tasks, nowMs, tails)` in `src/tui/task-format.ts` prints,
  under each job row, one indented marked line (`    │ `) per tail line, each truncated end-first
  to `TASK_TAIL_LINE_LIMIT` code points with `…` (the same truncate-end vocabulary as
  `summarizeTaskCommand`). Decision: a zero-output job keeps its single row **plus one stated
  line** — `(no output yet)` for `empty`, `(output unavailable)` for `unavailable` or a task the
  reader did not cover — so every job's output state is visible. Calls without `tails` (the
  legacy shape) stay byte-identical to today.
- R4. **Dispatch.** In `src/tui/App.tsx` the `/tasks` handler awaits `listBackgroundTasks()`,
  then `readBackgroundTails(tasks)`, then dispatches the one notice. No partial or second notice,
  no live row, no timer, no model call, no trajectory record beyond the existing `userInput`
  dispatch. Read failures are inline placeholders; only a list failure keeps the existing
  `could not list background tasks:` notice.
- R5. **Docs and specs.** `docs/user-guide/reference.md` (+ `zh-CN`) `/tasks` row; tail contract
  in `.trellis/spec/frontend/tui-testing.md` (background task monitoring contract) and one
  sentence in `.trellis/spec/frontend/live-frame.md`; the cursor invariant next to the
  background-bash `wait`/cursor contract in `.trellis/spec/backend/strands-sdk-contracts.md`;
  rationale paragraph in `docs/architecture/load-bearing-decisions.md` § Process exit. README
  does not describe `/tasks`, so it is untouched. **AGENTS.md is not modified** (32,667 B of a
  32,768 B cap).

## Requirement → check

| Requirement | Check |
|---|---|
| R1 last three non-empty lines, ANSI-stripped, marked, indented, under the job row (real job) | `spike/verify-tasks-tail.ts` (a) |
| R1 cursor untouched: tail then `output` equals a control run's `output`; tail after `output` still shows the last three | `spike/verify-tasks-tail.ts` (b) |
| R1 tail during an in-flight `wait` leaves the wait's result identical to a control | `spike/verify-tasks-tail.ts` (b′) |
| R1 file larger than the window: markers present, `bytesRead ≤ TASK_TAIL_WINDOW_BYTES < file size` | `spike/verify-tasks-tail.ts` (f) |
| R2 job with no output → `(no output yet)` | `spike/verify-tasks-tail.ts` (c) |
| R2 deleted `outputPath` → `(output unavailable)`, no throw | `spike/verify-tasks-tail.ts` (d) |
| R3 long line truncated end-first with `…` at `TASK_TAIL_LINE_LIMIT` | `spike/verify-tasks-tail.ts` (e), `spike/verify-task-format.ts` |
| R3 legacy call without tails byte-identical; placeholders; marker | `spike/verify-task-format.ts` |
| R4 `/tasks` pty surface unchanged for the empty state, `!`/queue surfaces green | `spike/verify-tui.ts completion`, `bang`, `queue` (no model-free way exists to start a real background job from the pty, so the unit suite carries the tail assertions) |
| Gate | `pnpm typecheck`, `pnpm test`, `pnpm build` |

## Acceptance Criteria

- [x] AC1. `spike/verify-tasks-tail.ts` (new, in `spike/run-tests.ts`) green: (a)–(f) above with
  real jobs through the real `BackgroundBashManager`. (33/33)
- [x] AC2. `spike/verify-task-format.ts` extended and green (18/18, was 10); `spike/verify-tui.ts
  completion` 69, `bang` 19, `queue` 17 — all 0 failed.
- [x] AC3. `pnpm typecheck`, `pnpm test` (all suites, 0 failed), `pnpm build` exit 0.
- [x] AC4. Commits follow the convention; task archived; tree clean; AGENTS.md byte-identical
  (32,667 B).

## Evidence (2026-09-02)

- `verify-tasks-tail.ts`: a six-line job (two blank, one whitespace-only, one ANSI-red, one with a
  tab) tails to exactly `['three red', 'four    five', 'six']`; `output()` after a tail read equals a
  control job's `output()` in `startOffset`/`endOffset`/`output`/`hasMore`, a second `output()` is
  empty at the same end offset for both, and the tail after `output()` is deep-equal to the tail
  before it. A terminal-focused `wait` spanning a mid-flight tail read (which saw `warming` without
  consuming it) returns `reason: terminal` with an output identical to its control. `true` → `empty`,
  blank-only log → `empty`, deleted log and a directory path → `unavailable` without a throw; a
  140-`x` line renders as 99 `x` + `…`; a log of ~3× the window reads exactly `TASK_TAIL_WINDOW_BYTES`
  (8192) bytes and still shows the three trailing markers, and its manager cursor afterwards starts
  at 0; a running `sleep 1000` job shows `boot`/`ready` under a `running` row.
- `verify-task-format.ts`: legacy call without `tails` still three rows and marker-free; rows for
  `lines`/`empty`/`unavailable`/uncovered task; code-point truncation keeps an emoji whole.

## Decisions

- **Zero-output jobs get one stated line** (`(no output yet)`), not the bare row: the reader ran
  for every job, and a silent row would be indistinguishable from "tails not implemented".
- **Reader in `src/tools/background-tail.ts`, width in `src/tui/task-format.ts`.** Sanitizing
  (ANSI, controls, tabs, blank lines, count) is a property of the log text and lives with the
  reader; the display width is presentation and lives with the formatter, next to
  `summarizeTaskCommand`, whose truncation was factored into a shared `truncateEnd` (behaviour
  pinned by the pre-existing `verify-task-format.ts` assertions).
- **`formatTasksReport(tasks, nowMs, tails?)`** — the optional third argument keeps every
  existing call and test byte-identical; `App.tsx` always passes the map.
- **A leading partial line is dropped only when a complete line follows it**, so a window that
  lands inside one very long line still shows that line's tail rather than nothing.
- **`O_NOFOLLOW` + regular-file check** mirrors the manager's own log-ownership caution without
  exposing its private dev/inode identity; a swapped symlink reads `(output unavailable)`.
- No model-free pty path can start a background job (a `!` command is not one), so the pty
  `completion` scenario keeps its empty-state `/tasks` assertions and the unit suite carries the
  tail proof — stated in `tui-testing.md` § Tests Required.

## Out of scope

- A `/tasks <id>` full-log viewer or a live-updating tail row.
- Changing the model-facing `bash` tool or the manager in any way.
