# Darwin self-evolution backlog — priorities 021–040

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-021 — Render assistant answers as styled markdown (headings, bold/italic, inline code, fenced code blocks) at presentation time, over the committed text unchanged — streaming, `<Static>`-committed pieces, replay/export byte-stability and divergence reconciliation all preserved

- Status: `done`
- Priority: 21
- Score: 12
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `12:30:29Z`)

### Implementation / acceptance evidence

Accepted in `0b9adea` (child session `session-20260818-134215605`, task `bg-9da6e671`, exit 0, no correction turn): Host read the full 22-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 45 suite summaries all `0 failed`), the new `spike/verify-markdown.tsx` (49), `verify-visual-language.tsx` (41), free pty `completion` (35)/`recall` (20)/`multiline` (9)/`clear` (19), the live 120×50 `verify-tui.ts approve` (26/26), `git diff --check`/`git show --check`, Trellis validation and clean-tree verification. Host's own probes: 16-assertion reassembly/fence-state probe (joined spans byte-equal the input on adversarial cases; `codeOpen` deterministic across piece boundaries), and a two-worktree byte-stability proof — the same real 96,740-byte record (427 markdown-bearing lines) replayed at `b2bdbeb` vs `0b9adea`, `cmp` byte-identical. Logged as [`Batch 24`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Codex renders markdown incl. syntax-highlighted code blocks in the TUI (developers.openai.com/codex/cli/features); Darwin draws raw `**bold**`/fences (`src/tui/MessageList.tsx:72,87`). The hard part is named, not hidden: `turn-state.ts` commits finished lines to `<Static>` mid-turn and `AnswerPart` splits answers across entries, so fence/style state must be derived deterministically per piece; the reducer's committed plain text stays the reconciliation and replay source of truth (`turn-state.ts:402`, `src/trajectory/replay.ts`), so styling is render-only and `/export`/`replay` must stay byte-identical. Pty assertions strip ANSI and need a stable assertable substring.

## SER-022 — Make the busy state alive: elapsed time and live token spend as a suffix of the existing `working…`/`thinking…` rows, ticking with the frame — no new frame row, no new information channel

- Status: `done`
- Priority: 22
- Score: 10
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 3
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `12:30:29Z`)

### Implementation / acceptance evidence

Accepted in `72966f4` (child session `session-20260818-142206509`, task `bg-c8b08209`, exit 0, no correction turn): Host read the full 11-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 46 suite summaries all `0 failed`), the new `spike/verify-busy-suffix.ts` (13), the live `verify-tui.ts usage` (22/22 incl. readout-appears and readout-ticks), the live 120×50 `approve` (26/26), free `completion` (35), `git diff --check`/`git show --check`, Trellis validation and clean-tree verification; plus a 6-assertion honesty probe (unreported bucket absent never `↑0`, measured zero shown, floor-not-round units, bounded counts, one-line suffix). The scenario fix the child shipped alongside was independently confirmed pre-existing: at `34513ea` the `usage` scenario asserted `/usage for token counts`, a header line `ab71a8c` had already removed. Logged as [`Batch 25`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Repository-evidenced only (self-review rule; evidence confidence 3 because no peer source was consulted for this item): `src/tui/App.tsx:1255` is a static `working…` hint, while `runtime.usage` (SER-007) already meters the live turn in-process and `ToolCallPanel.tsx` has the tick precedent. The header/live-frame contracts (`.trellis/spec/frontend/live-frame.md`) forbid a new baseline row, hence the suffix shape; idle must show none of it, and `verify-tui.ts approve` at 120×50 remains the no-added-row check.

## SER-023 — Make every file edit's diff visible and vivid in the transcript: a bounded toned diff excerpt for finished `fileEditor` writes in default compact mode (explicit about withheld lines, full view staying on the Ctrl+T toggle), `+N -N` change stats on the existing tool summary row and the permission `Diff` label, and intraline change emphasis (bold on the changed span within replaced lines) — computed from tool input only, markers still the durable statement, no new frame row

- Status: `done`
- Priority: 23
- Score: 13
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `16:03:24Z`, user-directed `tui` override)

### Implementation / acceptance evidence

Accepted in `7405d44` (+ task-record close `578cc2d`; child session `session-20260818-161103916`, task `bg-b660155d`, exit 0, no correction turn): Host read the full 17-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 46 suite summaries all `0 failed`), `spike/verify-edit-diff.ts` (98, up from 62), `verify-visual-language.tsx` (47), free pty `completion` (35), the live 120×50 `verify-tui.ts approve` (29/29 clean run incl. the three new assertions: `Diff (+1 -1):` label, stat on the finished `✓` row, compact `- `/`+ ` excerpt in the transcript; two earlier attempts hit the SER-013-documented pre-existing exit nondeterminism after asserting 28–29 PASS), purity re-grep (sole import a type), `git diff --check`/`git show --check`, Trellis validation and clean-tree verification. Host's own 20-assertion probe (stat counts across all shapes, bounded excerpt landing on the first change, no-marker-means-nothing-withheld, emphasis identity/Unicode/unrelated-pair rules, byte-exact old/new reconstruction) and an independent replay byte-stability proof: a real 9.4 MB record replayed at `9c29f2b` vs `7405d44`, 825,149 bytes `cmp` byte-identical. Logged as [`Batch 26`](../../iteration-log.md).

### Notes / blockers / abandonment reason

User-directed ("优化TUI…以diff显示…酷炫一点"). Repository evidence: `turn-state.ts:332-335` records `inputPreview: ''` in default compact mode, so an auto-approved edit shows no diff at all; `ToolCallPanel.tsx:116-120` summary carries no `+N -N`; `edit-diff.ts` `diffMiddle` emits whole-line tones only. Constraints carried forward, all load-bearing: SER-020 purity (`edit-diff.ts` reads no file — grep-provable), SER-016 information equivalence (a compact excerpt must state what it withheld; expanded stays complete), SER-009 truncation contracts, `tui-testing.md` markers-survive-ANSI-stripping, `live-frame.md` counted heights, replay/export byte-stability for history state, and the 120×50 `approve` no-added-row check. Old-side absolute line numbers, syntax highlighting and side-by-side layout were gated out (scores 4/3/3 < 6) — the first would break the purity contract.

## SER-024 — Run a user-typed shell command from the prompt with a `!` prefix: executed directly (user-authorized, not a model tool call), live bounded output in the TUI, the command and its bounded output entering the conversation and the trajectory record honestly — permission gate, frame budget and no-queue contract untouched

- Status: `done`
- Priority: 24
- Score: 11
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-08-19.md`](../research_2026-08-19.md) (run `01:20:26Z`)

### Implementation / acceptance evidence

Accepted in `d0fb23f` (child session `session-20260819-020346651`; first task `bg-2f7904c7` died in a transient stream timeout after research, retry task `bg-c29768de` exit 0, no correction turn): Host read the full 22-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 47 suite summaries all `0 failed`, no `FAIL`), the new `spike/verify-shell-command.ts` (56), the new free pty `bang` (16), free `completion` (35), `pathCompletion` (18), `recall` (20), `recallEmpty` (4), `mode` (25), `clear` (19), `multiline` (9), `chunkedEnter` (4), `cursor` (5), `mcp` (9), the live 120×50 `verify-tui.ts approve` (29/29), `git show --check`, Trellis validation and protected-docs check. Host's own probes: a 13-assertion module probe (prefix only at draft start, exit codes, timeout kill under 5s, group reaping with a clean tag probe disproving an initial pgrep self-match, firehose marker stating true totals, report shape); and replay byte-stability — a real 332,818-byte record of this project replayed at `bd5cc96` vs `d0fb23f`, `cmp` byte-identical. Logged as [`Batch 27`](../../iteration-log.md).

### Notes / blockers / abandonment reason

All three TUI peers ship `!` (Claude Code runs it without approval and adds output to context; Codex applies "the current approval and sandbox settings"; OpenCode adds output as a tool result) — the policy and context-shape disagreements are Darwin's design decisions to make explicitly. Darwin today has no non-`/` prefix (`src/tui/App.tsx:2024`). The runtime already owns a persistent shell with reaping; output must be bounded before entering context (SER-009 vocabulary); the trajectory `userInput` interplay with prompt recall must be decided, not emergent; while a turn runs, `!` follows SER-010 (retained, never queued).

## SER-025 — List this project's sessions and resume one by choice: a `darwin sessions` listing (id, age, first user prompt when recorded) over the existing per-project snapshot store, and `--resume <id>` reopening a named session — no model call, no network, `last-session.json` semantics unchanged for bare `--resume`

- Status: `done`
- Priority: 25
- Score: 11
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-19.md`](../research_2026-08-19.md) (run `01:20:26Z`)

### Implementation / acceptance evidence

Accepted in `33d5bb0` (+ task archive `9656b5b`; child session `session-20260819-032859311`, task `bg-2343dc6a`, exit 0, no correction turn): Host read the full 11-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 48 suite summaries all `0 failed`, no `FAIL`), the new `spike/verify-sessions-command.ts` (42), free pty `clear` (19), `completion` (35), `bang` (16), `git show --check` on both commits, Trellis archive validation and AGENTS.md size (17,031 B < 32 KiB). Host's own probe ran against the **real** project store: `darwin sessions` listed 30+ sessions newest-first with `(last)` on the correct id, bounded first prompts, `(not recorded)` degradation and one stated skip, while all 121 store files hashed byte-identical before and after; an unknown id refused in one line (exit 1, zero stack frames, no fallback); `sessions extra` exited 2 with usage; `--resume` followed by a flag kept its bare pointer meaning. No model call needed. Logged as [`Batch 28`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Codex `codex resume` reopens a recent chat from the current repository or searches local chats; OpenCode `/sessions` lists and switches. Darwin: pointer-only `--resume` (`src/agent/session.ts:20`), blind `--session <id>`, `darwin trajectory list` only covers trajectory-on sessions. First-prompt context degrades to "not recorded" where trajectory was off (prompt-recall's absence rule); other projects' sessions stay invisible.

## SER-026 — One consolidated read-only `/status` report: model/provider, cache and effort, permission mode and live allow-rule count, MCP server states, skills count, session id, trajectory/diagnostics state, process token spend and context estimate — composed from existing state only, on the `/mcp` read-only-projection precedent

- Status: `done`
- Priority: 26
- Score: 10
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 2
- Risk: 1
- Origin report: [`research_2026-08-19.md`](../research_2026-08-19.md) (run `01:20:26Z`)

### Implementation / acceptance evidence

Accepted in `799a072` (+ task archive `9058224`; child session `session-20260819-035915969`; first task `bg-d1f5f1ce` died in a transient `Stream ended without completing a message` with nothing written, retry task `bg-e368eec6` exit 0, no correction turn): Host read the full 11-file diff, confirmed every `StatusFacts` field reads a pre-existing runtime accessor (`rg 'get allowRuleCount|get permissionMode|…'` — no runtime change in the diff), and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 49 suite summaries all `0 failed`, no `FAIL`), the new `spike/verify-status-command.ts` (40), free pty `completion` (47, `/status` row asserted), `mcp` (13, incl. failed-server-in-/status), `pathCompletion` (18), `bang` (16), `recall` (20), `mode` (25), `git show --check` on both commits, Trellis archive validation, AGENTS.md 17,532 B < 32 KiB, and `MAX_COMPLETIONS` 14→15. Host's own 7-assertion formatter probe: failed server stated as failed, unknown cache buckets `not reported` never 0, 9 skills bounded to 6 names `… 3 more`, context degradation one line not a failed report, resumed/in-flight caveats present exactly when true. README command table carries the `/status` row. No model call needed. Logged as [`Batch 29`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Codex documents `/status` as "show current session configuration". Every fact already has an in-process accessor (`runtime.usage`, `gate.allowRules`, MCP registry projection, config fields); the command is a formatter, never a new information channel. Adding a built-in slash command must grow `MAX_COMPLETIONS` and re-run the free `completion` pty scenario.

## SER-027 — Queue messages typed while a turn runs, deliberately superseding SER-010's no-queue busy-submit contract: queued entries listed visibly, sent when the turn ends, and retrievable back into the editor — permission/compaction key ownership, prompt recall's `Up` semantics and the frame budget all preserved

- Status: `done`
- Priority: 27
- Score: 9
- Importance: 4
- Architecture fit: 3
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-19.md`](../research_2026-08-19.md) (addendum `02:01:06Z`)

### Implementation / acceptance evidence

Accepted in `b39cd30` (child session `session-20260819-051836979`; first task `bg-b60fda98` died in a transient `Stream ended without completing a message` with nothing written, retry task `bg-8a19690e` exit 0, no correction turn): Host read the full 17-file diff — including every flipped SER-010 assertion, confirmed 1:1 deliberate contract inversions, never deletions — and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 50 suite summaries all `0 failed`), the new `spike/verify-prompt-queue.ts` (28), the new free pty `queue` (17), `bang` (19), `completion` (47), `pathCompletion` (18), `recall` (20), `recallEmpty` (4), `mode` (25), `clear` (19), `multiline` (9), `chunkedEnter` (4), `cursor` (5), `tallDraft` (8), `mcp` (13), the live 120×50 `approve` (29/29) and live `usage` (23/23, incl. queued-listed/left-editor/counted/auto-drained-as-own-turn), `git show --check`, Trellis validation, AGENTS.md 18,510 B < 32 KiB. Host's own 12-assertion module probe: refusal set exact (`/clear`/`/compact`/`/model`/`/exit`/`/quit` and nothing else), take-back ordering ahead of typed text, one-row flattening, ANSI-strippable marker, zero-count silence. Supersession recorded everywhere the old contract lived (`live-frame.md`, `prompt-recall.md` Up precedence, AGENTS.md rows, README, `!` busy path now queues). Logged as [`Batch 30`](../../iteration-log.md).

### Notes / blockers / abandonment reason

**Reopened by explicit user product decision, 2026-08-19** ("add queue-while-working in backlog") — the `01:20:26Z` run had declined to score it because it conflicts with SER-010's shipped no-queue contract, and said only a user decision could reopen it. Peer evidence: Claude Code queues messages typed while it works, lists them above the input box, sends them between tool calls or as the next turn, with `Up` take-back; Codex `Tab` queues a follow-up for the next turn. Constraints: the specs and suites pinning the no-queue contract (`.trellis/spec/frontend/live-frame.md`, `spike/verify-prompt-editor.ts`) must be updated deliberately, never worked around; queued rows are new counted frame rows; `Up` is already shared by menu, cursor and prompt recall (SER-015). Next-turn-only delivery is the smaller safe scope — peers disagree on mid-turn injection.

## SRF-001 — Bounded automatic resumption of a turn killed by a retryable stream `ModelError`: one visible, recorded continuation through the ordinary `submit()` path, never inside the SDK loop

- Status: `done`
- Priority: 28
- Score: 10
- Importance: 4
- Architecture fit: 3
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`reflection_2026-08-19_session-20260819-075248263.md`](../../reflections/reflection_2026-08-19_session-20260819-075248263.md)

### Implementation / acceptance evidence

Accepted in `6978780` (child session `session-20260819-094850274`, task `bg-1d888c94-5b14-4236-81d3-142732e794f5`, exit 0, no correction turn): Host inspected the implementation and re-ran `pnpm typecheck`, `pnpm test` (37 suite summaries, all `0 failed`), `verify-stream-resumption.ts` (16), `verify-headless-structured.ts` (10), `verify-prompt-queue.ts` (28), `git show --check`, clean-tree and AGENTS.md-size checks successfully. No provider call was needed for acceptance. Logged as Batch 31 in [`../iteration-log.md`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Evidence: session-20260819-075248263 turn 1 died at seq 119 (`ModelError: "Stream ended without completing a message"`, 678,954 ms, 20 model calls, no `agentResultEvent`) and only resumed because the user typed `continue` (seq 120); headless `developer` children have no user to do that. Constraints: the SDK loop is never forked — retry lives at the runtime/submit layer (SER-027 drain-path precedent); at most one continuation per turn, stated visibly, recorded as its own turn; the failed turn's `failure` record (SER-006) stays untouched; never retry auth/validation failures.

## SRF-002 — Make redundant `command` harmless in bash `status`/`output`/`stop` modes (ignore it or document the per-mode field matrix in the tool description)

- Status: `done`
- Priority: 29
- Score: 10
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 1
- Risk: 2
- Origin report: [`reflection_2026-08-19_session-20260819-075248263.md`](../../reflections/reflection_2026-08-19_session-20260819-075248263.md)

### Implementation / acceptance evidence

Accepted in `bb89b53` (child session `session-20260819-100420866`, task `bg-3349e788-4903-4e37-a0a7-7e3c555a4d48`, exit 0, no correction turn): Host inspected the focused diff and independently re-ran `verify-background-bash.ts` (72), `pnpm typecheck`, `pnpm test` (51 suite summaries, all `0 failed`), `git show --check`, clean-tree and AGENTS.md-size checks successfully. No provider call was needed. Logged as Batch 32 in [`../iteration-log.md`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Evidence: session-20260819-075248263 seq 191/192 — `bash` poll call carrying both `taskId` and a redundant `command` rejected with `"command is not accepted in status mode"`, costing one extra model call (corrected seq 194/195). Prefer ignoring only the specific redundant field, or the description-only fix (per-mode field matrix), over loosening the schema generally.

## SRF-003 — Add a bounded blocking wait/state-change operation for background bash tasks that returns incremental output

- Status: `done`
- Priority: 30
- Score: 11
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`reflection_2026-08-19_session-20260819-094621980.md`](../../reflections/reflection_2026-08-19_session-20260819-094621980.md)

### Implementation / acceptance evidence

Accepted in `0f65591` (+ task archive `3ca6851`; child session `session-20260819-112756566`, task `bg-f7b55c75-38ef-4d92-b505-95f41657656a`, exit 0, no correction turn): Host inspected the implementation and independently re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 51 suite summaries all `0 failed`), the focused `spike/verify-background-bash.ts` (96 passed), `git show --check` on both commits, AGENTS.md size (19,239 bytes < 32 KiB), and clean-tree verification. No provider call was needed for acceptance.

### Notes / blockers / abandonment reason

Delivered `bash wait` with required bounded `waitMs` (1–30,000 ms), one response containing status plus cursor-consumed incremental output, and explicit output/changed/terminal/timeout/cancelled/shutdown reasons. Wait shares the existing serialized cursor, is classified read-safe, never executes a command, cancellation releases only the observer, and shutdown retains TERM→KILL process-group reaping.

## SRF-004 — Treat persistent-shell exit code 0 as successful foreground execution, with a restart notice and race regression coverage

- Status: `done`
- Priority: 31
- Score: 11
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`reflection_2026-08-19_session-20260819-094621980.md`](../../reflections/reflection_2026-08-19_session-20260819-094621980.md)

### Implementation / acceptance evidence

Accepted in `cb3efc3` (+ archive `c650cd3`; child session `session-20260819-114507345`, task `bg-dc3dfa27-b104-4645-ad9e-0bf278221c7a`, exit 0, no correction turn): Host inspected the pinned SDK patch and independently re-ran `pnpm typecheck`, `pnpm test` (51 green suite summaries), `spike/verify-background-bash.ts` (108), `probe-cancel-exit.ts`, `verify-clear-session.ts` (37), and free pty `bashExit`/`cancelThenContinue` (3/5), plus commit checks and clean-tree verification.

### Notes / blockers / abandonment reason

Root cause reproduced: concurrent foreground invocations shared one persistent shell's listeners/sentinel, cross-attributing output and all rejecting when one command exited. The pinned SDK patch now serializes foreground operations per Agent, waits for stdout and stderr boundaries, returns clean exit 0 with captured output plus a restart notice, lazily replaces the shell, and preserves nonzero/signal metadata as failure. Revisit on SDK upgrade.

## SRF-005 — Clamp oversized positive `fileEditor view` end lines to EOF

- Status: `done`
- Priority: 32
- Score: 11
- Importance: 2
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 1
- Risk: 1
- Origin report: [`reflection_2026-08-19_session-20260819-094621980.md`](../../reflections/reflection_2026-08-19_session-20260819-094621980.md)

### Implementation / acceptance evidence

Accepted in `9d6524e` (child session `session-20260819-120322968`, task `bg-443daddc-a9fe-4017-9723-93d4c919a377`, exit 0, no correction turn): Host inspected the pinned SDK patch and independently re-ran `pnpm typecheck`, `pnpm test` (52 green suite summaries), and `spike/verify-file-editor.ts` (37), plus patched-SDK syntax and commit checks and clean-tree verification.

### Notes / blockers / abandonment reason

The SDK-private range helper now clamps only a positive end beyond EOF for a non-empty regular text file. Provider schema/output remain unchanged; start beyond EOF, invalid zero/negative ends, ordering, empty-file, directory, missing, decode and size-limit behavior remain explicit and covered. Revalidate on SDK upgrade.

## SER-028 — Restore human context when a TUI session resumes: show a bounded read-only recap from that session's trajectory before the prompt, without a model call or synthetic model message

- Status: `done`
- Priority: 33
- Score: 13
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-19.md`](../research_2026-08-19.md) (run `14:12:37Z`)

### Implementation / acceptance evidence

Accepted in `977b2db` (+ task archive `1a74b16`, whitespace correction `578cc04`; child session `session-20260819-141551448`, tasks `bg-73ccfd59-e064-4c23-8cec-72a8dbe09df4` and focused correction `bg-72b35248-c8b5-40fd-ad8f-811ef19bdbbf`, both exit 0): Host inspected the implementation and independently re-ran `pnpm typecheck`, full `pnpm test`, `verify-resume-recap.ts` (20), `verify-tui.ts resume` (12 at 120×50), `verify-trajectory.ts` (257), `verify-sessions-command.ts` (42), `verify-clear-session.ts` (37), Trellis validation, range/commit whitespace checks and AGENTS.md-size validation successfully.

### Notes / blockers / abandonment reason

Claude Code's sourced session recap makes the human-visible gap explicit. Darwin restores the SDK snapshot for the model (`runtime.info.resumed`, `messageCount`) but initializes the TUI with empty `initialTurnState`; `replayRead` already provides an offline, mutation-free transcript projection. Show the last completed user request and assistant answer, state omission/damage/missing-record honestly, keep fresh sessions unchanged, and never touch agent messages, trajectory, snapshot or resume pointer.

## SER-029 — Keep completion selection visible across overflow: window the existing bounded slash/path menu around the selected candidate, with omission above/below stated and Tab/Enter accepting exactly the visibly selected row

- Status: `done`
- Priority: 34
- Score: 13
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-20.md`](../research_2026-08-20.md) (run `01:05:09Z`)

### Implementation / acceptance evidence

Accepted in `91ce096` (+ task archive `18ebbcc`; child session `session-20260820-011013386`, managed task `bg-4f672d5b-2702-4c23-b13a-52fafe646a3a`, exit 0, no correction turn): Host inspected the full implementation and independently re-ran `pnpm typecheck`, `pnpm test` (all fast suites green), `verify-frame-budget.ts` (75), free pty `completion` (52), `pathCompletion` (23), `cursor` (5), `recall` (20), `recallEmpty` (4), and `queue` (17), plus `git show --check`, `git diff --check`, and clean-tree verification.

### Notes / blockers / abandonment reason

Delivered a contiguous bounded completion window over the unchanged full candidate order, exactly one visible `❯`, truthful above/below omission counts on the existing overflow row, and immediate selection/acceptance mirrors so batched arrows plus Tab/Enter cannot diverge. Command/path precedence, keyboard ownership, row grants, path scanning, and `MAX_COMPLETIONS` remain unchanged.

## SER-030 — Add bounded in-session `/help` for Darwin commands, prompt syntax, and keyboard editing, and correct the stale README input/key documentation

- Status: `done`
- Priority: 35
- Score: 12
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-20.md`](../research_2026-08-20.md) (run `01:05:09Z`)

### Implementation / acceptance evidence

Accepted in `124bb8d` (+ task archive `18b3ae5`; child session `session-20260820-012939115`, managed task `bg-7003a2f0-5a99-49a1-af34-64a9f88e724b`, exit 0, no correction turn): Host inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm test` (all fast suites green), `verify-help-command.ts` (23), `verify-frame-budget.ts` (75), free pty `completion` (61), `pathCompletion` (23), `recall` (20), `queue` (17), `toolDetails` (6), `multiline` (9), and `cursor` (5), plus commit/diff/clean-tree and AGENTS.md-size checks.

### Notes / blockers / abandonment reason

Delivered a canonical, explicitly bounded local `/help` projection on the existing transcript notice surface, available idle or during offline busy work without a model call or queue mutation. `/help` arguments refuse locally, every built-in remains offered with `MAX_COMPLETIONS = 16`, README now documents the shipped multiline/editor controls, and the false single-line limitation is removed.

## SRF-006 — Add an opt-in terminal-focused background `bash wait` mode that advances/aggregates incremental output without waking on each fragment, while remaining bounded by `waitMs` and returning on terminal state, cancellation, shutdown or timeout

- Status: `done`
- Priority: 36
- Score: 13
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`reflection_2026-08-20_session-20260820-010254692.md`](../../reflections/reflection_2026-08-20_session-20260820-010254692.md)

### Implementation / acceptance evidence

Accepted in `6350c8f` (+ task archive `2860cf2`; child session `session-20260820-155011267`, task `bg-33033cd0-06d3-4072-ae21-80c85087a045`, exit 0, no correction turn): Host inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm test` (all fast suites green), `spike/verify-background-bash.ts` (116), commit/diff checks, Trellis archive validation, AGENTS.md size, and clean-tree verification successfully.

### Notes / blockers / abandonment reason

Delivered opt-in `wakeOnOutput: false`: it retains a bounded contiguous UTF-8-safe output range while waiting only for terminal state, cancellation, shutdown or timeout; overflow and concurrent consumers preserve the shared cursor without duplication. Omitted/true behavior remains output-sensitive, bounds stay 1–30000 ms, and wait remains read-safe.

## SRF-007 — Make redundant `timeout` harmless in background `bash start` mode, with schema regression coverage

- Status: `done`
- Priority: 37
- Score: 12
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 1
- Origin report: [`reflection_2026-08-20_session-20260820-010254692.md`](../../reflections/reflection_2026-08-20_session-20260820-010254692.md)

### Implementation / acceptance evidence

Accepted in `44d5078` (+ task archive `647c375`; child session `session-20260820-160436215`, task `bg-ce978c9e-ec41-4a1d-bb32-9ff0ff788a90`, exit 0, no correction turn): Host inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm test` (all fast suites green), `spike/verify-background-bash.ts` (118), commit/diff, archive, AGENTS.md-size and clean-tree checks successfully.

### Notes / blockers / abandonment reason

Positive `start.timeout` is accepted through the existing numeric schema and retained in raw permission/hook input, but omitted from permission presentation and never reaches `manager.start(command)` or process lifetime. Execute/restart behavior and non-start lifecycle rejection remain unchanged.

## SRF-008 — Accept one conventional leading standalone `--` in Darwin CLI arguments so `pnpm start -- --yolo…` and `pnpm start --yolo…` are equivalent

- Status: `done`
- Priority: 38
- Score: 11
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-08-20_session-20260820-010254692.md`](../../reflections/reflection_2026-08-20_session-20260820-010254692.md)

### Implementation / acceptance evidence

Accepted in `262c3f5` (child session `session-20260820-161536842`, task `bg-21f1211c-bac3-4cc5-a40d-a665b2156d37`, exit 0, no correction turn): Host inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm test` (all fast suites green), `spike/verify-cli-args.ts` (11), strict process/parser checks, task archive validation, commit/diff and clean-tree checks successfully.

### Notes / blockers / abandonment reason

`cli.ts` removes exactly one argv-leading standalone `--` before all routing; later/second separators and unknown arguments stay strict. Direct and separated TUI/headless options, sessions and trajectory routing are equivalent without model calls; bare `--resume` semantics remain intact.

## SRF-009 — Make active-turn `userInput` durably visible to offline trajectory readers before invocation

- Status: `done`
- Priority: 39
- Score: 13
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`reflection_2026-08-21_session-20260821-054705633.md`](../../reflections/reflection_2026-08-21_session-20260821-054705633.md)

### Implementation / acceptance evidence

Accepted in `019ac58` (child session `session-20260821-085909241`, task `bg-0b77d586-5d9a-4f94-b4d8-5757cb68dc64`, exit 0, no correction turn): Host inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm test` (all fast suites green), `spike/verify-trajectory.ts` (267), `verify-stream-resumption.ts` (16), `verify-clear-session.ts` (37), `pnpm build`, Trellis validation, commit/diff checks successfully.

### Notes / blockers / abandonment reason

Delivered a 2-second fail-open recorder barrier that appends the current `userInput` before `Agent.stream()` begins. A real offline `AgentRuntime` probe reads that input during invocation; write failure or timeout latches the existing trajectory problem while invocation continues, and timeout detaches the stuck chain so shutdown remains bounded. Append-only prefix identity, sequence continuity, event/error identity, replay, stream resumption and `/clear` contracts remain intact.

## SRF-010 — Add a bounded context-pressure notice that recommends user-controlled compaction

- Status: `done`
- Priority: 40
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`reflection_2026-08-21_session-20260821-054705633.md`](../../reflections/reflection_2026-08-21_session-20260821-054705633.md)

### Implementation / acceptance evidence

Accepted in `e5f77a6` (child session `session-20260821-091623784`, task `bg-f8cb1052-0aeb-4598-9a8b-b912fa1f81d2`, exit 0, no correction turn): Host inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm test` (all fast suites green), `verify-context-format.ts` (22), `verify-compact.ts` (13), `verify-status-command.ts` (40), `verify-frame-budget.ts` (75), `verify-clear-session.ts` (37), `pnpm build`, Trellis validation and commit/diff checks successfully.

### Notes / blockers / abandonment reason

Reworded the existing configurable `contextWarnRatio` latch into one bounded transcript-only pressure notice recommending `/compact` before the next broad implementation or verification turn. It keeps the default/custom/disabled thresholds, one-shot and known-below re-arm behavior, fresh `/clear` latch, unknown/invalid silence and user-controlled compaction; no new threshold, timer, channel or live-frame row.
