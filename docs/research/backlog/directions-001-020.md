# Darwin self-evolution backlog — priorities 001–020

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-001 — Add an enforced read-only planning permission mode

- Status: `done`
- Priority: 1
- Score: 16
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-15.md`](../research_2026-08-15.md)

### Implementation / acceptance evidence

Accepted in `e2e1463`: Host inspected the commit/diff and re-ran `pnpm typecheck`, `pnpm test`, `spike/verify-tui.ts plan` (4 passed), Trellis validation, `git diff --check`, and clean-tree verification successfully.

### Notes / blockers / abandonment reason

`plan` denies write/execute before hooks, rules, classifiers, and prompts; the shared intervention covers child agents. Unknown tools remain fail-closed as execute.

## SER-002 — Make subagent work parallel and inspectable with source-labelled status and approvals, initially for read-heavy delegation

- Status: `done`
- Priority: 2
- Score: 8
- Importance: 4
- Architecture fit: 3
- Evidence confidence: 5
- Difficulty: 4
- Risk: 4
- Origin report: [`research_2026-08-15.md`](../research_2026-08-15.md)

### Implementation / acceptance evidence

Accepted in `404aa1c`: Host inspected all 27 files and re-ran `pnpm typecheck`, `pnpm test` (24 suites, 0 FAIL), `verify-subagents.ts` (66 passed, measured two-dispatch overlap plus resolved parent/child sources), `verify-tui.ts agents` (6), `completion` (20), `approve` (23, incl. the no-added-frame-row assertion), `cancelThenContinue` (5), `bashExit` (3), Trellis validation and `git diff --check` successfully.

### Notes / blockers / abandonment reason

Concurrency was already real (SDK default `ConcurrentToolExecutor`, measured 303 ms for two 300 ms children) so it is pinned by test and contract rather than built; approvals remain serialized by the SDK's single hook loop. Concurrent write delegation is still unguarded by design — documented, not prevented.

## SER-003 — Add append-only session trajectory export plus search/fork/replay primitives over SDK events

- Status: `done`
- Priority: 3
- Score: 8
- Importance: 4
- Architecture fit: 3
- Evidence confidence: 5
- Difficulty: 5
- Risk: 3
- Origin report: [`research_2026-08-15.md`](../research_2026-08-15.md)

### Implementation / acceptance evidence

Accepted in `af791f9`: Host inspected the commit (36 files) and re-ran `pnpm typecheck`, `pnpm test` (26 suites, 0 FAIL, exit 0, incl. `verify-trajectory.ts` 148 passed), `verify-tui.ts completion` (25) and the model-calling `approve` (23), Trellis validation, `git diff --check`; plus an independent live end-to-end in a scratch project: two real turns appended with the earlier prefix byte-identical and `seq` strictly increasing, offline replay with credentials removed, `search` hit/miss exit codes, `fork` leaving source snapshot/trajectory/`last-session.json` byte-identical while the fork continued the conversation, and `trajectory: false` writing no file at all.

### Notes / blockers / abandonment reason

Recorder is a pass-through observer in `recordStream` between `agent.stream()` and the yield; caps are 8k code points/field, 64 KiB/line, 64 MiB/file with every truncation written down; failures latch and degrade to one notice. Three findings changed the design: `toJSON()` emits the wire shape (so the first reasoning strip never fired), batch-time timestamps were replaced by observation-time stamps, and `AgentResult.toString()` already carries child reasoning into parent context — documented, not caused here.

## SER-004 — Add an optional isolated execution backend for shell/file mutation

- Status: `abandoned`
- Priority: 4
- Score: 7
- Importance: 5
- Architecture fit: 2
- Evidence confidence: 5
- Difficulty: 5
- Risk: 5
- Origin report: [`research_2026-08-15.md`](../research_2026-08-15.md)

### Implementation / acceptance evidence

Not implemented; never handed off to a child.

### Notes / blockers / abandonment reason

**`abandoned` by explicit user product decision, 2026-08-16** ("把 SER-004、SER-005 标记成放弃"), taken after the Host reported the batch halted here; no further reason was given, and none is inferred. Score (7) was above the gate, so the gate is *not* what closed this row. The state at closure: the batch had halted on section 7 "only the user can decide", because four decisions had no answer in the requirement or in repository evidence — (1) which backend darwin supports (this host has `docker` and `bwrap`; bwrap is Linux-only and macOS has neither, so the choice decides who can use the feature at all), (2) whether AWS credentials / the instance role reach inside the sandbox, (3) what isolation is actually promised once a coding agent must mount its own project read-write, so working-tree mutation stays uncontained and what is gained is host-beyond-project and network confinement, and (4) authorization to re-implement the persistent-shell `restart` reaping, background process-group cleanup, and cancelled-stream exit fallback inside a sandbox — paths `AGENTS.md` fences off behind `verify-background-bash.ts`, `probe-cancel-exit.ts`, `bashExit` and `cancelThenContinue`, all of which assume host processes. A future run may re-propose this as a new ID with those four answers supplied; it must not silently reopen this row.

## SER-005 — Establish a stable local coding-agent evaluation corpus and regression scorecard for self-evolution

- Status: `abandoned`
- Priority: 5
- Score: 6
- Importance: 4
- Architecture fit: 3
- Evidence confidence: 4
- Difficulty: 5
- Risk: 4
- Origin report: [`research_2026-08-15.md`](../research_2026-08-15.md)

### Implementation / acceptance evidence

Not implemented; never handed off to a child.

### Notes / blockers / abandonment reason

**`abandoned` by explicit user product decision, 2026-08-16** ("把 SER-004、SER-005 标记成放弃"); no reason was given, and none is inferred. Score (6) sat exactly at the gate, so the gate is not what closed this row either — it was unblocked and next in line when the decision came. The direction's substance stands unrefuted for whoever re-proposes it: measurement must precede automated optimization, and PenguinHarness's benchmark numbers remain publisher claims with no public suite.

## SER-006 — Record why a turn ended abnormally: a failed turn's error in `turnEnded`, distinguishable from cancel, and reported by `trajectory list`/`replay`

- Status: `done`
- Priority: 6
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-16.md`](../research_2026-08-16.md) (run `10:52:35Z`)

### Implementation / acceptance evidence

Accepted in `1f2c147`: Host read the whole 16-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (26 suites, all `passed, 0 failed`, exit 0, no `FAIL`), `spike/verify-trajectory.ts` (203 passed, up from 148), `spike/verify-tui.ts completion` (25 passed), `git diff --check` (clean), Trellis validation (`✓`); plus its own live end-to-end in a throwaway HOME: a clean Bedrock turn recorded `stopReason: "endTurn"` with no failure, a second turn in the same session against an invalid `AWS_BEARER_TOKEN_BEDROCK` failed for real (exit 1) and recorded no `stopReason` plus `failure: {name: "ModelError", message: "Authentication failed…", cause: "AccessDeniedException"}`, the first 1,375 bytes hashed identically before and after that append (`e381f6f9…`), and `list`/`replay`/`search AccessDeniedException` (1 match)/search-miss all exited 0 and named the failure; and a direct check that a 9,000-code-point class name plus 9,000-code-point message renders to exactly 120 code points with no newline.

### Notes / blockers / abandonment reason

`stopReason` is set only from `agentResultEvent` (`src/trajectory/writer.ts:191`), which a thrown turn never emits, so the turn closes with `stopReason: undefined` and no error field anywhere in `TurnEndedRecord`. The observer contract must not change: the error is rethrown untouched and recording stays synchronous and non-throwing. Delivered as an additive optional `failure` field (no `SCHEMA_VERSION` bump), one shared `turnOutcome` reading of failed/cancelled/clean/abandoned, and a measured extra: the SDK wraps non-`ModelError` throws, so `failure.cause` is what keeps the provider's class. **Unfixed pre-existing finding, recorded not smuggled:** turn ordinals restart at 1 per process, so a two-run session reports `1 turn(s)` and both turns say `turn 1`, contradicting the spec's "within this file" wording — a candidate for a later direction.

## SER-007 — Record per-turn token usage and duration in the trajectory, and report session spend from the record

- Status: `done`
- Priority: 7
- Score: 12
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-16.md`](../research_2026-08-16.md) (run `10:52:35Z`)

### Implementation / acceptance evidence

Accepted in `e4033ef` (+`ffba24e`): Host read the diff (16 files) and re-ran `pnpm typecheck` (exit 0), `pnpm test` (26 suites, all `passed, 0 failed`, exit 0), `spike/verify-trajectory.ts` (257 passed, up from 203), `spike/verify-tui.ts completion` (25 passed), `git diff --check` (clean), Trellis validation (`✓`); plus its own live reconciliation in a throwaway HOME: three turns in one session, each turn's recorded `spend` equal field-for-field to that process's `usage:` stderr line (`input=2 output=3 cacheRead=0 cacheWrite=10379`; `input=2 output=3 cacheRead=1460 cacheWrite=3592`; and a real provider rejection recording `input=0 output=0` with the cache keys absent, matching stderr's `cacheRead=- cacheWrite=-`, beside its `failure`), the first 1,497 bytes hashed identically after both later appends (`d3637ad3…`), `list`/`replay` exiting 0 with credentials removed and the endpoint dead while totalling `input=4 output=6 cacheRead=1460(+1 unreported) cacheWrite=13971(+1 unreported)`, and two real pre-spend sessions reporting `spend: unknown` / `turn 1 spend: unknown (not recorded)` rather than a fabricated zero.

### Notes / blockers / abandonment reason

Measured on a real recorded file: `agentResultEvent.result` carries only `type`/`stopReason`/`lastMessage`, `metrics` undefined, so no spend or latency reaches disk; `runtime.usage` is process-scoped by documented design. **Depends on SER-006** — a failed turn's tokens are billed too, so the failure path must close the record honestly first. Unknown provider metrics must stay unknown, never 0 (`usageBuckets`). Delivered as an additive optional `turnEnded.spend` read from a non-throwing meter injected into `beginTurn` (a write from `send`'s `finally` was rejected because a throw there would replace the provider's error object and break SER-006's guarantee), with provider/model stamped on the same line so no total mixes two price lists. **Correction this direction produced:** the origin report's "no token counts reach disk" was imprecise — `Message.toJSON()` keeps `metadata`, so `agentResultEvent.result.lastMessage.metadata.usage` was already recorded for the *final model call* of a turn; what was absent is anything turn-scoped and anything at all for a failed or cancelled turn. Hence the field is `spend`, not `usage`. Two limitations recorded in the spec, not hidden: `spend` is what the SDK meter attributed (summarization bypasses the meter entirely), and turn ordinals still restart per process so aggregates count `turnEnded` records.

## SER-008 — Opt-in per-session diagnostics log for SDK `debug`/`info` plus darwin notices

- Status: `done`
- Priority: 8
- Score: 8
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-08-16.md`](../research_2026-08-16.md) (run `10:52:35Z`)

### Implementation / acceptance evidence

Accepted in `aa2b7b7`: Host read the diff and ran every check in a **separate git worktree** at the child's commit (an unrelated external commit `0e6f08c` and three uncommitted edits appeared in the main tree mid-run, so the main tree could not be trusted for verification): `pnpm typecheck` (exit 0), `pnpm test` (**27** suites, all `passed, 0 failed`, exit 0), `spike/verify-diagnostics.ts` (70 passed), `spike/verify-config.ts` (199 passed, up from 190), `spike/verify-tui.ts approve` with real model calls (23 passed, no frame row added on 50 rows), `completion` (25 passed), `git show --check` clean. Plus four live cases of its own against real Bedrock in a throwaway HOME: field absent → only `trajectory.jsonl`/`snapshot_latest.json` in the session dir and no `diagnostics:` record; field on → an 11-line file holding the SDK's real `added cache point to last user message`, `dispatching to 1 handler(s)`, `handler=<darwin:permission-gate> … returned proceed`, `auto-detected includeToolResultStatus` beside timestamped `darwin info` notices; `"diagnostics": "yes"` → `"diagnostics" must be true or false.` and refusal to start; a directory in place of the file → turn still succeeded with one bounded `EISDIR` record and the directory untouched; a file pre-filled to 8,388,300 bytes → stopped at the real 8 MiB constant with `diagnostics stopped: reached the 8388608-byte per-session budget (nothing after this line was written)` as the literal last line.

### Notes / blockers / abandonment reason

`routeSdkLogs` hard-wires `debug`/`info` to no-ops with no escape hatch, while the SDK logs Bedrock throttling at `logger.debug` (`dist/src/models/bedrock.js:1181`), so a throttled session leaves no evidence. Must be off by default and capped: debug output can contain conversation-derived material, the same reason `contextOffload` defaults off. Delivered as a boolean `diagnostics` in `SessionFields` and a `setSdkVerboseSink` tap that leaves the renderer path untouched; with no tap the SDK's `debug`/`info` are the *literal* no-ops it ships, so off is indistinguishable from before the feature and no notice call site changed (dispatch is wrapped outside the reducer). Three bounds: 8k code points per line, 8 MiB per file, 1 MiB pending with counted drops — dropping a diagnostic is allowed and written down, delaying an event is not. Two measurements corrected the implementation: a trajectory-style `flush()` dropped 0 of 200 lines at a 400-byte bound until it was gated on an in-flight write (then 197 of 200), and checking the file bound after writing let one burst overshoot by 42 lines. Stated in the spec rather than left to be discovered: an SDK warning appears twice on purpose (different sources), and a subagent's SDK diagnostics **do** land in this file because the SDK logger is process-global, unlike the trajectory which records no child event.

## SER-009 — Bound permission details by rendered size as well as logical lines, with explicit truncation that keeps the decision row reachable

- Status: `done`
- Priority: 9
- Score: 15
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-08-16.md`](../research_2026-08-16.md) (run `14:41:34Z`)

### Implementation / acceptance evidence

Accepted in `0b3822a`: Host read the full 13-file commit, confirmed no research/log changes, and re-ran `pnpm typecheck`, `pnpm test` (29 suites / 1,544 assertions), the focused projection suite (23), the real 120×50 `verify-tui.ts approve` scenario (21), Trellis validation, `git show --check`, and clean-tree verification successfully.

### Notes / blockers / abandonment reason

Permission summary/detail projections are marker-inclusive, line- and code-point-bounded, Unicode-safe, and preserve short values exactly. The settled newest Ink repaint proves source, bounded content, `allow?`, y/n and both rule offers coexist; approving still writes the exact untruncated value.

## SER-010 — Make the prompt editor visibly editable while streaming, preserving permission ownership and the no-queue busy-submit contract

- Status: `done`
- Priority: 10
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-16.md`](../research_2026-08-16.md) (run `14:41:34Z`)

### Implementation / acceptance evidence

Accepted in `b11c281` + `81e5897`: Host read both commits and re-ran typecheck, all 29 fast suites / 1,544 assertions, focused prompt/compact checks, cursor (5), multiline three consecutive times (9 each), chunkedEnter (4), completion (25), live usage (20), live approve (23 on clean rerun), live compacting (5), Trellis validation, commit/diff checks, and clean-tree verification successfully.

### Notes / blockers / abandonment reason

Streaming now presents an enabled editor with a visible terminal cursor while busy Enter retains rather than queues; local reports still run. Permission and compaction own keyboard/paste. Host's first acceptance exposed a real leading-batched-Enter race; `81e5897` recognizes leading or trailing terminators and deterministically pins continuation-marker consumption.

## SER-011 — Add opt-in structured headless output: one final JSON envelope or a real-time JSONL event stream, while preserving the existing text protocol byte-for-byte

- Status: `done`
- Priority: 11
- Score: 14
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-08-17.md`](../research_2026-08-17.md) (run `01:10:12Z`)

### Implementation / acceptance evidence

Accepted in `58a20b5` + `ebd4796`: Host read the implementation and correction diffs, found and had the child fix one path-contract violation, then independently re-ran `pnpm typecheck`, all 30 fast suites, focused headless (68), structured headless (8), trajectory (257), max-token recovery (20), `pnpm build`, Trellis validation, `git diff --check`, commit checks, explicit cwd-location and clean-tree checks successfully. The child also completed exactly two low-token real Bedrock smoke calls: final JSON and five-record monotonic JSONL, both exit 0 with empty stderr and durable success.

### Notes / blockers / abandonment reason

Claude Code, Codex and Cursor independently expose structured headless output. Darwin already has one typed stream seam plus trajectory serialization knowledge; the public schema must be versioned, omit reasoning text, represent terminal outcomes structurally, and leave default stdout/stderr, cleanup, snapshot and resume-pointer semantics byte-for-byte unchanged. A daemon/App Server and filesystem rewind were separately gated out rather than folded into this direction.

## SER-012 — Replace Darwin's hand-built Agent Skills core with the SDK's official `AgentSkills`/`Skill`, preserving Darwin's layered catalogue, required built-ins, `/skill-name` UX, permission safety, prompt/cache order and observable `load_skill` compatibility

- Status: `done`
- Priority: 12
- Score: 12
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 4
- Origin report: [`research_2026-08-17.md`](../research_2026-08-17.md) (run `02:49:08Z`)

### Implementation / acceptance evidence

Accepted in `53105b0` + `6fc919a` + `906c400` + `06ef164` + `16cee9a` + `d5b0d68` (+ archive `02dbcb2`). The Host acceptance that closed it is recorded in full in [`../iteration-log.md`](../../iteration-log.md) ("Batch — official SDK Agent Skills"): focused real `Agent`/`SessionManager` skills suite (69 passed), adversarial cached and uncached ambiguity probes, `pnpm typecheck`, `pnpm test` (31 suite summaries, zero failures), `pnpm build` plus both bundled skill assets, the free `completion` pty scenario (25 passed), Trellis validation, `git diff --check`, protected-history/research hashes and `git show --check` per commit. **This row's status was left stale by that invocation and is being closed, not re-decided, on 2026-08-18**; the closing run re-verified independently rather than trusting the record: all seven commits confirmed ancestors of `b7e227f` (`git merge-base --is-ancestor`), the official core present in `src/skills/{loader,plugin,prompt,resource-safety}.ts` with `AgentSkills` reached through `@strands-agents/sdk/vended-plugins/skills`, working tree clean, `pnpm typecheck` exit 0, and `pnpm test` reporting 33 suite summaries all `0 failed` with no `FAIL`.

### Notes / blockers / abandonment reason

Installed `@strands-agents/sdk@1.12.0` now publicly exports `@strands-agents/sdk/vended-plugins/skills`, so the architecture's explicit deletion trigger has fired. Keep Darwin's built-in/project/global precedence, required assets, problem reporting and slash UX as the thin product-policy boundary; delete duplicated parsing, prompt injection, resource traversal and activation code only where real-Agent probes prove the official plugin owns the behavior. Preserve `load_skill({name})` as a safe observable compatibility contract unless every instruction/permission consumer is migrated atomically, and prove fresh/resumed working-context and final cache-point order.

## SER-013 — Switch the permission mode inside a running session, user-only and session-scoped, with the effective mode always visible and no in-flight decision resolved under the wrong mode

- Status: `done`
- Priority: 13
- Score: 13
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `01:25:31Z`)

### Implementation / acceptance evidence

Accepted in `ff0a9f5` + `eeb32a2` (child session `session-20260818-012951871`, task `bg-0f0062ef`, exit 0, no correction turn needed): Host read the full 23-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 37 suite summaries all `0 failed`, no `FAIL`), the new `spike/verify-permission-mode-switch.ts` (100 passed), `verify-permission-modes` (101), `verify-tool-hooks` (44), `verify-subagents` (68), `verify-config` (205), `verify-headless` (80), `verify-prompt-editor` (28), `verify-clear-session` (37), the free pty `mode` (25), `completion` (29), `clear` (19) and `plan` (4), `git diff --check`, `git show --check` on both commits, Trellis validation and clean-tree verification. Required live `verify-tui.ts approve` (real Bedrock, 120x50) passed 23/23 on 6 of 7 Host runs; the single failure asserted all 23 and then timed out on exit because the model volunteered an extra exploratory `bash ls` whose permission box swallows `/exit` — a separate worktree at the pre-change commit `31a5880` failed identically on 1 of 5 runs, so it is pre-existing model nondeterminism, not a regression. Host also ran its own live-free end-to-end in a throwaway HOME: `default -> plan -> yolo -> bogus -> default` each reported with the previous mode named, the invalid argument changing nothing, `config.json` byte-identical by sha256 (`b66e97e6...`), and a fresh process starting from configured policy again. Logged as [`Batch 16`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Three independent peers treat approval policy as live session state (Claude Code `Shift+Tab` + mode indicator, Codex `/permissions` + `/status`, OpenCode palette toggle + muted auto indicator), while Darwin fixes the mode at construction (`ApprovalMode`/`APPROVAL_MODES`, `src/agent/permission.ts:45`; `--permission-mode`/`--yolo`, `src/cli-args.ts:128`) with no setter — `rg 'setMode|changeMode'` finds only `AgentRuntime.changeModel`. Darwin's own plan denial tells the user to "run outside plan mode" (`permission.ts:228`), which today means killing the process. Four constraints are load-bearing, not incidental: the switch is **user-only** (`permission.ts:578` — the agent must not rewrite its own mode; Claude Code states the same rule in prose); it is **session-scoped and never written to config**, because a persisted widening is exactly what the rule-exemption policy forbids; the plan guard must stay ahead of hooks, allow-rules, the `auto` classifier and the bridge for parent *and* child agents (`.trellis/spec/backend/strands-sdk-contracts.md` § enforced read-only planning); and a prompt queued or an `auto` classifier check in flight when the mode changes must never be resolved under a mode that would not have asked (Claude Code documents discarding such a verdict). Header already owns a mode row (`src/tui/App.tsx:955-967`), so no frame row may be added. Precedents to copy: `/effort`, `/model` (`runtime.ts:829`), `/clear`.

## SER-014 — Complete workspace file paths from `@` in the prompt, inserting the path only — never inlining file content

- Status: `done`
- Priority: 14
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `01:25:31Z`)

### Implementation / acceptance evidence

Accepted in `70d3655` + `279121b` (child session `session-20260818-022510423`, task `bg-4c6db950`, exit 0, no correction turn needed): Host read the full 16-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 38 suite summaries all `0 failed`), the new `spike/verify-path-completion.ts` (59), `verify-frame-budget` (54), `verify-prompt-editor` (28), the free pty `pathCompletion` (18), `completion` (29 with every built-in listed), `cursor` (5), `multiline` (9), `mode` (25), `clear` (19), `tallDraft` (8), `git diff --check`, `git show --check` on both commits, Trellis validation and clean-tree verification. No live model call was needed. Host also wrote its own 15-assertion probe rather than trusting the safety claims: a canary inside a completed file appears nowhere in the reading or the accepted draft, `node_modules`/`.git` are neither offered nor walked, a symlink out of the root is not offered while one inside is, no candidate is absolute or `..`-relative, `@` inside a word is not a trigger, and a 9,000-entry directory is bounded and says so — measuring 31 ms for that bounded scan, 893 candidates from 898 entries in this repository, and a worst per-keystroke match of 0.63 ms. Logged as [`Batch 17`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Claude Code, Codex and OpenCode all offer `@` path completion, but they disagree on what follows: Codex inserts the **path**, OpenCode **inlines file content**. Take the Codex shape deliberately — inserting the path keeps file bytes flowing through `fileEditor` under the existing gate and trajectory, while inlining would add a second ungated route for file content into context. Extension point is the pure `computeCompletions(input, commandNames)` (`src/tui/App.tsx:1429`), which today returns nothing unless the input is a bare `/prefix`; `MAX_COMPLETIONS` and `src/tui/frame-budget.ts` already govern the menu, and heights must be counted, never estimated (`.trellis/spec/frontend/live-frame.md`). The difficulty is the scan, not the UI: bound the entry count, exclude `.git`/`node_modules`-class directories, refuse symlink escape, and never stall the editor on a large tree. `verify-tui.ts completion` must still show every built-in.

## SER-015 — Recall previous prompts in the editor, read from the project's existing trajectory records, without disturbing completion or cursor keys

- Status: `done`
- Priority: 15
- Score: 9
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `01:25:31Z`)

### Implementation / acceptance evidence

Accepted in `13e8968` + `7abc916` (child session `session-20260818-025938746`, task `bg-a81befde`, exit 0, no correction turn needed): Host read the full 20-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 39 suite summaries all `0 failed`), the new `spike/verify-prompt-recall.ts` (61), `verify-frame-budget` (61), `verify-trajectory` (257), `verify-path-completion` (59), `verify-prompt-editor` (28), the free pty `recall` (20), `recallEmpty` (4), `completion` (29), `pathCompletion` (18), `cursor` (5), `multiline` (9), `mode` (25), `clear` (19), `tallDraft` (8), `git diff --check`, `git show --check` on both commits, Trellis validation and clean-tree verification. No live model call was needed. Host's own 12-assertion probe also passed: newest-first order, consecutive duplicates collapsed, a prompt recalled from an earlier session of the same project, every record byte-identical by sha256 after the read, no resume pointer created, the read still working with `AWS_REGION`/endpoint/profile sabotaged, a record-less project reading as no history rather than an error, a corrupt plus half-written line tolerated and not repaired, and an over-long prompt skipped, counted and stated — measuring 1.9 ms for two records. `Ctrl+R` reverse search was explicitly optional and deliberately not implemented: a second focus-owning input mode would have cost the key-ownership and frame-row risk this direction was told to avoid. Logged as [`Batch 18`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Darwin has no prompt history at all (`src/tui/prompt-editor.ts`, `src/tui/InputBox.tsx`), yet every past user prompt is already recorded per project in `~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl` and readable with no model call and no network (`src/trajectory/reader.ts`, `.trellis/spec/backend/session-trajectory.md`) — so this is a reader over existing bytes, not a new store. Claude Code specifies the semantics worth copying (history scoped per working directory, recall spanning past sessions of the same project, consecutive duplicates collapsed to one entry, `Ctrl+R` reverse search); Codex confirms `Up`/`Down` draft restore plus `Ctrl+R`. Evidence confidence is 4, not 5, because no peer says what a *trajectory-sourced* history should do about a session recorded with `trajectory: false` — degrade to "no history", never an error. The binding is the risk: `Up`/`Down` already select completion rows when a menu is open and otherwise move the cursor between visual rows (`src/tui/App.tsx:807-840`); recall must eat neither.

## SER-016 — Establish and apply a cohesive Darwin visual language across the TUI: compact status-first header, stronger turn/tool/notice hierarchy, a clearly active composer and completion selection, and a polished but information-equivalent permission modal

- Status: `done`
- Priority: 16
- Score: 13
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `06:09:36Z`)

### Implementation / acceptance evidence

Accepted in `ab71a8c` (child session `session-20260818-061057110`, managed task `bg-f42e105b-399c-44e0-9107-651af1226311`, exit 0, no correction turn): Host read the full 22-file commit and independently re-ran `pnpm typecheck`, `pnpm test` (40 suite summaries, all `0 failed`), focused visual/frame/static suites (22/61/58), free pty `completion`/`pathCompletion`/`recall`/`cursor`/`multiline`/`mode`/`plan`/`clear`/`tallDraft` (29/18/20/5/9/25/4/19/8), live 120x50 `approve` (23/23), Trellis validation, `git diff --check`, `git show --check` and clean-tree verification. Logged as Batch 19 in [`../iteration-log.md`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Delivered a dependency-free semantic palette/marker vocabulary shared by all five visual surfaces, a status-first capability-count header with no baseline row growth, ANSI-independent transcript/notice/tool distinctions, stronger composer/menu selection, and an information-equivalent permission modal. Frame budgeting, `<Static>`, cursor geometry, key ownership and permission content remain intact; README and frontend contracts now pin the design.

## SER-017 — List and revoke permission allow-rules in-session (`/permissions`): show every live rule with its origin (configured vs granted this session), revoke one or all, user-only, with revocation persisted and incapable of widening anything

- Status: `done`
- Priority: 17
- Score: 13
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `09:15:03Z`)

### Implementation / acceptance evidence

Accepted in `8d120dd` (child session `session-20260818-093028503`, task `bg-02b125c3-b033-47e2-b6ec-438b8074465a`, exit 0, no correction turn): Host read the full 17-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 41 suite summaries all `0 failed`), the new `spike/verify-permissions-command.ts` (42), the free pty `completion` (30, `/permissions` row asserted), `pathCompletion` (18), `recall` (20), `mode` (25), Trellis validation, `git diff --check`/`git show --check` and clean-tree verification. Host's own 14-assertion probe in a throwaway HOME over the real gate, config seam and handler also passed: origins distinguished, revocation immediate on the live list, file round-trip does not resurrect, untouched rule survives as widening canary, filter-only proof (bogus revoke adds nothing), unknown subcommand degrades to usage adding nothing. No live model call needed — the permission modal is unchanged. Logged as [`Batch 20`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Claude Code `/permissions` views and removes rules by scope mid-turn; Codex `/permissions` inspects active boundaries. Darwin's gate exposes `get allowRules`/`addAllowRule` (`src/agent/permission.ts:324,329`) and persists to `permission-rules.json` (`src/config.ts:1033`) with **no list and no removal path** — a mistaken "always allow" silences prompts forever unless the user hand-edits JSON. Revocation only narrows, so a bug costs an extra prompt, never a silent widening; the user-only boundary and `isRuleExempt` policy carry over from SER-013. The command must not become a second grant path: additions go through the existing prompt flow only.

## SER-018 — Inspect MCP servers in-session (`/mcp`): per-server connection state, tool names/counts, config source and overridden/ignored files, with a failed server stated as failed instead of silently contributing zero tools

- Status: `done`
- Priority: 18
- Score: 12
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `09:15:03Z`)

### Implementation / acceptance evidence

Accepted in `a443981` (child session `session-20260818-100731833`, task `bg-f67fc62b-4ce7-4cf0-8ebb-c7707f72d2cd`, exit 0, no correction turn): Host read the full 18-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 42 suite summaries all `0 failed`), the new `spike/verify-mcp-command.ts` (33), the new free pty `mcp` (9), `completion` (31, `/mcp` visible), `pathCompletion` (18), Trellis validation, `git diff --check`/`git show --check` and clean-tree verification. Host's own 11-assertion probe in a throwaway HOME ran the exact acceptance scenario against real MCP servers: one healthy fixture and one broken command both named, the broken one stated `failed — contributing no tools` rather than omitted, bounded tool names for the healthy one, the config file and an ignored root `.mcp.json` both stated, connection states byte-identical before/after the read (mutation-freedom), and a record-less project reading as a normal notice naming the three candidate files. No live model call needed.

### Notes / blockers / abandonment reason

`reconnect` was deliberately NOT shipped, with a measured reason recorded in the PRD and `strands-sdk-contracts.md` § MCP: the SDK's `connect(true)` flips connection state without re-registering tools into the agent's registry, so it would report a "connected" server whose tools the model still cannot call, and the await has no timeout to bound — inspection-only was the honest scope. Tool names come from the SDK's own `_registeredToolNames` (populated at `initialize()`), read on the existing `loadServersQuietly` private-field precedent, guarded to degrade to "unavailable". Logged as [`Batch 21`](../../iteration-log.md).

## SER-019 — Export the current conversation in-session (`/export <path>`): write the transcript from this session's own trajectory record to a user-named file, reusing the replay projection; absence of a record degrades to "nothing to export"

- Status: `done`
- Priority: 19
- Score: 9
- Importance: 2
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `09:15:03Z`)

### Implementation / acceptance evidence

Accepted in `dd08f8f` (child session `session-20260818-104704270`, task `bg-d5b3a70c-ed8a-427e-84be-5f12bd119c95`, exit 0, no correction turn): Host read the full 13-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 43 suite summaries all `0 failed`), the new `spike/verify-export-command.ts` (32), the free pty `completion` (35, `/export` row asserted), `mcp` (9), `recall` (20), Trellis validation, `git diff --check` and clean-tree verification. Host's own 12-assertion probe ran against a **real** recorded session of this project (the SER-017 child): export written, record and resume pointer byte-identical by sha256 afterwards, transcript body byte-identical to `formatReplay` of the same record, an existing target refused atomically (`wx`) and left byte-identical, a target inside `~/.darwin/sessions/` refused, trajectory-off and missing-record reading as "nothing to export" with no file, no argument yielding usage, and an unwritable directory degrading to one error notice. No live model call needed. Logged as [`Batch 22`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Claude Code `/export [filename]`, OpenCode `/export` (Markdown), Codex `/copy`. Darwin's projection already exists and cannot drift from the live transcript (`replayRead`/`formatReplay` reuse `turnReducer` and respect `AnswerPart`, `src/trajectory/replay.ts:166,233`); the work is one seam: locate the current session's record, project, write one file, report as a notice. Importance 2 because `darwin trajectory replay` in a second terminal is a real workaround. Constraints: the trajectory stays observer-only (export reads, never blocks a turn), `trajectory: false` reads as "nothing to export" like prompt recall's absence rule, and clipboard is deliberately out of scope (SSH-hostile).

## SER-020 — Render file edits as bounded coloured line diffs at the permission prompt and in the finished tool result, computed from the raw input the gate already exposes, information-equivalent, with `+`/`-` markers that survive ANSI stripping

- Status: `done`
- Priority: 20
- Score: 13
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-18.md`](../research_2026-08-18.md) (run `12:30:29Z`)

### Implementation / acceptance evidence

Accepted in `dfbab04` (child session `session-20260818-123849412`; first task `bg-6a49b177` died in a transient stream timeout with nothing written, retry task `bg-c0253f1f` exit 0, no correction turn): Host read the full 20-file diff and re-ran `pnpm typecheck` (exit 0), `pnpm test` (exit 0, 44 suite summaries all `0 failed`), the new `spike/verify-edit-diff.ts` (62), `verify-visual-language.tsx` (36), the live 120×50 `verify-tui.ts approve` (26/26 — diff rows, truncation marker, source label and complete decision row in one settled frame, approved edit applied exactly), `git diff --check`/`git show --check`, Trellis validation and clean-tree verification. Host's own 9-assertion probe: both sides recovered byte-exactly from the markers (Unicode intact), delete vs empty replacement distinguishable, create all-added, unknown shape `undefined`, 3,000-line pathological diff equivalent in 6ms; plus a purity grep proving `edit-diff.ts` opens no file. Logged as [`Batch 23`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Claude Code shows a red/green diff at edit approval by default (anthropics/claude-code#48198 records users filing its loss as a regression); Codex documents TUI diffs. Darwin's gate exposes raw tool input for exactly this ("for a UI that wants to show or diff it itself", `src/agent/permission.ts:96`) and no UI ever consumed it. `str_replace` carries old and new strings in the input, so the diff is a pure string projection — no file read. Constraints: SER-016 information equivalence (approving writes the exact untruncated value; nothing the box showed before may be omitted), SER-009 truncation contracts, `permissionDetailRows`/frame budget bound the rows, and the `+`/`-` markers must survive ANSI stripping per `tui-testing.md` § visual hierarchy.
