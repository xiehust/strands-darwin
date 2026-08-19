# PRD — `!` runs a user shell command from the prompt (SER-024)

## Problem

All three peer TUIs (Claude Code, Codex CLI, OpenCode) let the user run a shell command
from the prompt with a `!` prefix. Darwin has no non-`/` prefix: checking `git status`
means leaving the TUI or spending a model turn asking the agent to run it. The peers
disagree on policy (approval or not) and on how output enters context (raw context vs.
synthetic tool result); those disagreements are decisions this PRD makes explicitly.

## Binding constraints (from the direction)

1. `!` is user-authorized — it never goes through the permission gate's prompt flow;
   the gate's subject is model tool calls. What ran and what it printed must still be
   visible on screen and recorded honestly.
2. Output is bounded before entering conversation context, using the SER-009 truncation
   vocabulary (`boundText` in `src/tui/tool-detail-presentation.ts`).
3. `!` triggers only at the start of the draft, never inside text.
4. While a turn runs, submitting a `!` draft follows SER-010: retained, never queued,
   never executed mid-turn.
5. Plan mode behaviour is decided explicitly, below.
6. The frame budget contract holds: new live rows are counted, never estimated; the
   120x50 approve scenario must not gain a frame row.

## Design decisions (the ones the peers disagree on)

**D1 — Execution vehicle: a bounded one-shot spawn, not the runtime's persistent shell.**
`spawn('/bin/bash', ['-c', command])` with `detached: true` (its own process group),
cwd = project root, stdout+stderr merged in arrival order. Reasons: (a) a hung `!`
command must not wedge the model's persistent shell — that shell is serialized, so a
hung user command would block the model's next `bash` call, and killing it would destroy
the shell state the model relies on; (b) a one-shot's process group can be reaped
TERM→KILL (`background-bash.ts` conventions) without touching anything else; (c) no
cwd/env mutation leaks into the model's shell. Stated tradeoff: `!cd`/`!export` do not
persist to later `!` commands or to the model's shell.

**D2 — Cancellation and timeout.** Hard timeout `SHELL_TIMEOUT_MS` (2 minutes); on
expiry the process group gets SIGTERM, then SIGKILL after a grace, and the result is
reported as timed out. Ctrl+C while a `!` command runs kills it the same way (first
Ctrl+C cancels the command, second within the window exits — same shape as turn
cancellation). The TUI is never wedged: the busy state (`status: 'shell'`) always ends
when the process settles, and the double-Ctrl+C exit path stays available.

**D3 — Policy vs. permission modes (Claude Code's side, with one deliberate extension).**
`!` runs without approval in every mode, including plan. The gate governs what the
*model* may do; a user typing `!rm -rf build` is the user acting directly, exactly as
they could in the terminal next door, and prompting the user to approve the user answers
no threat model. Plan mode therefore does not block `!` — plan constrains the model's
writes, and the command's report reaching a planning model changes nothing about what
the model may execute. The header already states the mode; the `!` transcript row states
what ran and what it printed, which is the honesty requirement.

**D4 — One bounded projection for everything.** The full output is collected (bounded
in memory), then projected once with `boundText(output, 'ok', SHELL_REPORT bounds)` —
head kept, `… truncated N code points and M lines` marker appended. That same projection
is (a) the finished transcript row's preview, (b) the conversation report, and (c) the
trajectory record's `output` field, so screen, model and record cannot say three
different things. Head-kept even on failure, because the live panel streamed the head
first and the record must match what was shown; the marker states the loss.
Bounds: `SHELL_REPORT_CODE_POINTS = 4000`, `SHELL_REPORT_LINES = 80` — under the
recorder's `MAX_FIELD_CHARS` (8000) so the writer's field cap never re-truncates.

**D5 — Context entry: held report, prepended to the next prompt (Codex's side).**
OpenCode's synthetic tool result would fabricate an assistant `toolUse` the model never
made; injecting a bare user message risks a consecutive-user-roles rejection on Bedrock
Converse. Instead the bounded report is held in the App and prepended (wrapped in
`<user-shell-command>` tags, with command and exit status) to the next prompt the user
sends to the model. Honest by construction: the trajectory `userInput` contract is
"exactly what was handed to `agent.stream()`", and that is what it will show. Stated
consequences: a `!` command followed by no further prompt never reaches the model
(shown on screen and recorded regardless); `/clear` drops pending reports with the
conversation they were destined for (the notice already says the old session is
resumable). The transcript's user row shows the prompt the user typed; the report rides
along like an expanded custom command does today.

**D6 — Trajectory: a new `shellCommand` record type; `!` entries are not recalled.**
The record carries `{command, exitCode, signal, timedOut, durationMs, output}` with the
D4-bounded output, written through the existing `buffer()`/`flush()` path (synchronous
compose, capped fields, non-throwing, appended off the streaming path — the observer
contract untouched). It is **not** a `userInput` record: nothing was handed to
`agent.stream()`, and writing one would make prompt recall offer `!` text back as if it
were a prompt. Decision: `!` commands are not offered by prompt recall — recall's
contract is "what the session *sent*", and local commands (`/usage`, `/mode`) already
are not recalled; rerunning a shell command has the terminal's own history as its home.
Replay/export: `formatReplay` **prints** the new record (as the same user row +
finished-tool row the live session showed, through the same `turnReducer` projection);
records written by older darwins are untouched, so prior transcripts stay
byte-identical.

**D7 — Live output: the existing tool panel, no new frame surface.** The running
command appears in `ActiveToolCalls` as a pseudo-tool named `shell` (spinner, elapsed
suffix — all existing, counted rows), and its detail rows show a bounded tail of the
arriving output, always (not gated on Ctrl+B expanded mode: the tail is the point of
`!`). The rows are *counted* through the same `toolInputRows` the panel draws with —
the claims computation and the panel share the predicate — so the budget contract holds
and an idle/approve frame gains nothing. On completion the panel row is replaced by a
finished tool history row in `<Static>` with the D4 projection as its result preview.

**D8 — Parse rule.** The trimmed draft must start with `!`; the command is everything
after the `!`, trimmed; a bare `!` is a notice, not an error. `!` anywhere else in a
draft is ordinary text. Recognized *below* the busy check (D9), above the model send.

**D9 — Busy interplay (SER-010).** `!` while `streaming`/`compacting` hits the existing
busy check: notice, draft retained, nothing queued. While a `!` command itself runs the
status is `shell` (header: `running !`), so a second submission — `!` or prompt — is
retained by the same check; `!` commands never run concurrently and never during a turn.

## Scope

- `src/tui/shell-command.ts` (new): parse, spawn/collect/kill, report composition.
- `src/tui/turn-state.ts`: `shellStarted`/`shellOutput`/`shellCommand` actions.
- `src/tui/App.tsx`: submit-path branch, `shell` status, Ctrl+C kill, pending
  reports, spinner gating.
- `src/tui/tool-detail-presentation.ts` + `frame-budget.ts` + `ToolCallPanel.tsx`:
  raw-text projection and always-on detail rows for the `shell` pseudo-tool.
- `src/trajectory/record.ts` / `writer.ts` / `replay.ts`: the `shellCommand` record.
- `src/agent/runtime.ts`: `recordShellCommand` passthrough to the recorder.
- Spikes: new `spike/verify-shell-command.ts` (free, in `pnpm test`), new free
  `shellCommand` pty scenario in `spike/verify-tui.ts`.
- Specs: `.trellis/spec/frontend/live-frame.md`, `prompt-recall.md`,
  `.trellis/spec/backend/session-trajectory.md`, AGENTS.md row,
  `docs/architecture/load-bearing-decisions.md`.

## Non-goals

- No new slash command (MAX_COMPLETIONS untouched).
- No persistent user shell, no `!!` history, no `!` in the dev REPL driver.
- No immediate message injection into `agent.messages`.

## Acceptance

- `pnpm typecheck` clean; `pnpm test` all suites pass with the new suite included.
- `spike/verify-tui.ts shellCommand` (free): a real `!` command runs, output on screen,
  record on disk, no model call; existing free scenarios still pass.
- The `shellCommand` record replays as the same transcript rows the live session shows.
- The approve scenario's 120x50 frame is row-for-row unchanged.
