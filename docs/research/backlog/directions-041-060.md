# Darwin self-evolution backlog — priorities 041–060

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SRF-011 — Return bounded current context after an exact `fileEditor str_replace` miss

- Status: `done`
- Priority: 41
- Score: 10
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-08-21_session-20260821-054705633.md`](../../reflections/reflection_2026-08-21_session-20260821-054705633.md)

### Implementation / acceptance evidence

Accepted in `3ce5e46` (child session `session-20260821-093212243`, task `bg-9f32138b-22dc-43fe-b9db-4b4e1d34f5af`, exit 0, no correction turn): Host inspected the pinned SDK patch and independently re-ran `pnpm typecheck`, `pnpm test` (all fast suites green), `spike/verify-file-editor.ts` (63), `pnpm build`, installed-SDK syntax, Trellis validation and commit/diff checks successfully.

### Notes / blockers / abandonment reason

Exact misses remain errors before any sandbox write, but now return a deterministic advisory excerpt selected by capped exact query seeds. Output is at most five numbered lines with 240 Unicode code points per line and explicit omission/truncation/no-safe-match wording; oversized queries, ambiguous candidates, exact success, bytes/metadata purity, validation and all existing view behavior are pinned. Revalidate the version-pinned patch on SDK upgrade.

## SER-031 — Add opt-in, project-scoped distilled Markdown memory with a bounded always-loaded index and topic files: derive only from closed successful trajectory turns in a delayed post-turn job, preserve source provenance, redact/drop secrets, never block the turn, and never treat learned memory as instructions

- Status: `done`
- Priority: 42
- Score: 10
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 5
- Risk: 4
- Origin report: [`research_2026-08-22.md`](../research_2026-08-22.md) (run `03:02:03Z`, user-directed `peer` override)

### Implementation / acceptance evidence

Accepted in `73bc11b` (+ task archive `f955c54`, journal `a90489d`; child session `session-20260822-032546109`, managed task `bg-370b6138-44ac-405e-8501-0a581ed85a7e`, exit 0, no correction turn). Host inspected the implementation and independently re-ran `spike/verify-memory.ts` (34), `verify-clear-session.ts` (40), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, no-search/vector/dependency/extra-Agent structural checks, AGENTS.md size, and commit/diff checks successfully.

### Notes / blockers / abandonment reason

Delivered strict opt-in project memory under the existing project-keyed user store: eligible durable successful turns deterministically rebuild bounded provenance-bearing Markdown topics plus one bounded index; secret/instruction/code/tool-dump candidates are dropped; extraction is delayed, coalesced, timeout-bound and fail-open; only a labelled fallible index enters fresh/resumed/`/clear` prompts after skills and before working context/cache. No model tool, vector index, dependency or SDK-loop fork.

## SER-032 — Add bounded `/memory` management for the generated store: list index/topic entries with scope, provenance, freshness and sensitivity state; show one; forget one/all; allow a user-authored project memory note without giving the model an ungated persistence path

- Status: `done`
- Priority: 43
- Score: 12
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-08-22.md`](../research_2026-08-22.md) (run `03:02:03Z`, user-directed `peer` override)

### Implementation / acceptance evidence

Accepted in `06873a5` (+ task archive `b2c565f`, journal `ae00a9f`; child session `session-20260822-040134487`, managed task `bg-e1396eab-d9a8-479a-bef3-695c487cb43c`, exit 0, no correction turn). Host inspected the implementation and re-ran `verify-memory-command.ts` (21), `verify-memory.ts` (34), `verify-clear-session.ts` (42), free pty `completion` (62), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis/commit/diff/AGENTS-size checks; all passed.

### Notes / blockers / abandonment reason

Delivered strict local `/memory` list/show/remember/forget over a versioned project-bound manifest. Generated and user entries report provenance, honest `unvalidated` freshness and heuristic sensitivity state; remember is screened and bounded; durable generated-ID suppressions survive rebuilds; successful mutations atomically update disk and synchronously refresh the verified live prompt. No model tool/network/vector/dependency/SDK-loop path.

## SER-033 — Revalidate and age generated memories: verify code-derived source anchors against the current worktree before startup inclusion, mark invalid/stale entries, and expire unconfirmed generated facts on a configurable conservative horizon while preserving explicit user-authored notes

- Status: `done`
- Priority: 44
- Score: 10
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-22.md`](../research_2026-08-22.md) (run `03:02:03Z`, user-directed `peer` override)

### Implementation / acceptance evidence

Accepted in `64989d6` (+ task archive `0b53fb4`, journal `dc9244f`; child session `session-20260822-042916698`, managed task `bg-574c2443-8b57-4252-9dbc-b7d18c263fb3`, exit 0, no correction turn). Host inspected the implementation and re-ran `verify-memory-validation.ts` (15), `verify-memory-command.ts` (21), `verify-config.ts` (216), `verify-clear-session.ts` (42), `pnpm typecheck`, full `pnpm test`, `pnpm build`, and Trellis/commit/diff/AGENTS-size checks; all passed.

### Notes / blockers / abandonment reason

Delivered exact bounded project-relative line/hash anchors, fail-closed `valid`/`invalid`/`expired`/`unknown` states, and strict `memoryHorizonDays` (default 28, integer 0–365; 0 disables expiry only). One centralized validation projection governs startup, pre-request, `/clear` and `/memory`; only current non-expired generated facts enter ambient context, while explicit user notes never auto-expire. v1 generated state migrates unknown and remains omitted.

## SER-034 — Raise informational transcript contrast: render `info ·` with a clear semantic accent and command/report body text at normal terminal intensity, preserving exact report text, stable ANSI-stripped markers, warning/error hierarchy, `<Static>` ownership, and monochrome readability

- Status: `done`
- Priority: 45
- Score: 17
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 2
- Origin report: [`research_2026-08-22.md`](../research_2026-08-22.md) (run `06:37:01Z`, user-directed `tui` override)

### Implementation / acceptance evidence

Accepted in `af84a03` (+ task archive `7c49cd9`, journal `4c135e5`; child session `session-20260822-104129517`, managed tasks `bg-d54a0aa6-48fb-4ce9-afa1-4d1f8c3c9710` and `bg-57f117eb-932d-409f-8d44-88d4cd88575b`, both exit 0). Host inspected the implementation and independently re-ran `verify-visual-language.tsx` (53), free pty `completion` (62) and `mcp` (13), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, commit/diff/clean-tree and AGENTS-size checks; all passed.

### Notes / blockers / abandonment reason

Delivered one shared cyan informational role: only the durable `info ·` marker is accented while exact report bodies render at normal intensity with no dim SGR. Warning/error styling, ANSI-stripped bytes, `<Static>` ownership, margins and row geometry remain unchanged.

## SER-035 — Add a responsive animated Darwin startup screen: render immediately while runtime and resume initialization run, use a compact Darwin/evolution motif with honest motion, then hand the terminal cleanly to the ordinary `App` with no fixed delay, lingering timer, input theft, transcript artifact, or settled-frame growth

- Status: `done`
- Priority: 46
- Score: 9
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 4
- Risk: 4
- Origin report: [`research_2026-08-22.md`](../research_2026-08-22.md) (run `06:37:01Z`, user-directed `tui` override)

### Implementation / acceptance evidence

Accepted in `53d806f` plus correction `1526090` (task archives `5548a0d`, `7ce38dd`; journals `dc37b9b`, `e9e9705`; child session `session-20260822-105247940`, managed tasks `bg-8c72301c-49bb-4de2-86eb-2f973eef9835` and `bg-505f0da9-136a-4936-97ba-8661254e1bb8`, both exit 0). Host inspected the implementation, found the new resume fixture's exact restored-count assumption during full-gate acceptance, and accepted only after correction. Host re-ran startup component (17), startup pty (19), frame budget (75), visual language (53), free pty completion/clear/resume (62/19/12), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive, commit/diff/clean-tree and AGENTS-size checks; all passed.

### Notes / blockers / abandonment reason

One Ink instance now renders a bounded one- or three-row `◆ DARWIN` evolution motif immediately, states only real runtime/recap pending phases, and rerenders atomically to the unchanged `App`. React cleanup stops its sole interval; known errors unmount before stderr; pty proof covers motion-before-readiness, total handoff, usable input, and byte-identical resume artifacts. The corrected fixture uses suite-owned storage and semantic recap assertions. No fixed delay, input hook, raw terminal write, transcript item, provider call, or settled App row was added.

## SER-036 — Add a parent-agent structured progress checklist: a bounded whole-list `update_plan` tool with `pending`/`in_progress`/`completed` items, a row-budgeted live TUI projection during the turn, and one final bounded Static projection at turn end; keep the tool call/result as the only trajectory evidence and clear live state before the next turn

- Status: `done`
- Priority: 47
- Score: 11
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-23.md`](../research_2026-08-23.md) (run `14:00:33Z`, rolled `peer` path)

### Implementation / acceptance evidence

Accepted in `1de577d` plus Host-found row-bound correction `6f9c1c7` (task archives `20af308`, `ae16f98`; journals `6b5f0d7`, `542462e`; child session `session-20260823-140856961`, managed tasks `bg-20e52254-2bac-406c-b58a-2b9c53549e1b` and `bg-bb251cf6-5ccb-44c4-8e7c-a940d845b10e`, both exit 0). Host inspected the implementation, found long checklist rows could exceed their visual-row grant, accepted only after the same-session correction, and independently re-ran `verify-update-plan.tsx` (31), `verify-frame-budget.ts` (77), `verify-trajectory.ts` (267), `verify-subagents.ts` (69), free pty `updatePlan` (6), `pnpm typecheck`, full `pnpm test`, `pnpm build`, commit/diff/clean-tree and AGENTS-size checks; all passed.

### Notes / blockers / abandonment reason

Delivered a parent-only strict whole-list advisory tool (1–20 unique items, 200 code points/item, 2,000 total), statically safe in every permission mode. Successful ordinary tool events replace transient live state; the shared frame budget states omitted rows; turn end commits one bounded Static projection and clears live state. Live and final rows truncate structurally at narrow widths. No dependency, child access, persistence/config field, trajectory record type, or replay duplication.

## SER-037 — Make Escape dismiss transient prompt UI without changing the draft: close the current slash/path completion menu and end an active prompt-recall walk, re-arming completion after the query changes, while permission Escape still denies and compaction still owns input

- Status: `done`
- Priority: 48
- Score: 11
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-23.md`](../research_2026-08-23.md) (run `14:44:07Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted in `635c712` (+ task archive `3082945`, journal `34d0e28`; child session `session-20260823-144935764`, task `bg-4ec8d509-fdb8-4af6-9e02-fffb58dc46da`, exit 0, no correction turn). Host inspected the implementation and independently re-ran `verify-prompt-completion.ts` (11), `verify-help-command.ts` (25), `verify-frame-budget.ts` (77), free pty `completion` (66), `pathCompletion` (27), `recall` (22), `recallEmpty` (4), `compacting` (5), `permissionEscape` (3), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, commit/diff/clean-tree and AGENTS-size checks; all passed.

### Notes / blockers / abandonment reason

Delivered query-generation-scoped Escape dismissal for slash/path completion and prompt recall. Draft/cursor stay unchanged, stale batched Tab/Enter/arrows cannot act, edits or cursor movement re-arm completion, permission Escape still denies, compaction still owns input, and no notice/frame/runtime/model/trajectory/queue surface was added.

## SER-038 — Extend Darwin's layered command hooks with bounded lifecycle events for `TurnComplete` and `PermissionRequest`: structured outcome/source payloads, deterministic global/project ordering, non-blocking observation-only execution, and process-group cleanup; no terminal writes, model context, permission decisions, trajectory records, or SDK-loop interception

- Status: `done`
- Priority: 49
- Score: 11
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-24.md`](../research_2026-08-24.md) (run `01:30:51Z`, rolled `peer` path)

### Implementation / acceptance evidence

Accepted in `8ae7855` + verification correction `b673cd5` (+ task archive `1ac2894`; child session `session-20260824-013615973`, managed tasks `bg-07db22aa-f364-453d-8ddc-cdba3c44bd92` and `bg-65b30294-3a97-42c0-9bfa-19375f167f2f`, both exit 0). Host inspected the implementation, found and corrected a completion-order-dependent focused assertion, then independently passed lifecycle (20), config (231), state layers (37), tool hooks (44), permission mode (100), subagents (69), headless (80), structured headless (11), clear-session (44), trajectory (267), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation and commit/diff/clean-tree checks. Logged as [`Batch 52`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Delivered exactly two strict layered lifecycle events. Commands receive bounded closed JSON, start observation-only without blocking, expose no output/result channel, and are reaped as process groups on cancel, `/clear`, startup unwind and shutdown. Permission prompts publish once when visible across queueing/withdrawal/re-decision; interactive/headless turns publish final outcomes outside the SDK loop.

## SRF-012 — Reflect only a closed trajectory cutoff, never the currently open reflection turn

- Status: `done`
- Priority: 50
- Score: 14
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`reflection_2026-08-24_session-20260824-105238516.md`](../../reflections/reflection_2026-08-24_session-20260824-105238516.md)

### Implementation / acceptance evidence

Accepted in `e527320` (child session `session-20260824-110019745`, managed task `bg-c273c723-f9f6-4d51-83e2-f39e70cbddfb`, exit 0, no correction turn): Host inspected the implementation and independently passed `verify-self-reflection.ts` (12), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis validation, source/dist identity, `git diff --check`, commit/tree checks and AGENTS.md size.

### Notes / blockers / abandonment reason

Locator now emits the latest valid `turnEnded` turn/seq as an inclusive cutoff; the worker must verify it and exclude every later open-tail record from grading, citations, spend and timing. Current/named sessions with no closed turn refuse, named missing ids never fall back, and all locator paths are byte-zero against session state.

## SRF-013 — Add a bounded pre-`endTurn` guard that converts internal working notes into one continuation for a real tool action or user-facing answer

- Status: `done`
- Priority: 51
- Score: 14
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`reflection_2026-08-24_session-20260824-111655828.md`](../../reflections/reflection_2026-08-24_session-20260824-111655828.md)

### Implementation / acceptance evidence

Accepted in `989e36c` (+ task archive `41571a3`, journal `78b01ba`; child session `session-20260824-135926608`, managed task `bg-5fbc46bf-e0fe-4a32-8505-1cc83160fa18`, exit 0, no correction turn). Host inspected the implementation and independently re-ran `verify-completion-guard.ts` (24), `verify-stream-resumption.ts` (16), `verify-max-tokens-recovery.ts` (20), `verify-headless-structured.ts` (11), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, commit/diff and AGENTS-size checks; all passed.

### Notes / blockers / abandonment reason

Delivered a conservative bounded classifier and exactly one fixed private driver-owned continuation. Matched successful notes are withheld from TUI/text/JSON/JSONL and trajectory/replay payloads while an honest suppression terminal remains; tool-bearing candidates fail open, and a second match, failure or cancellation never loops.

## SRF-014 — Expose persistent-shell cwd and preflight likely project-root-relative path mistakes

- Status: `done`
- Priority: 52
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-08-24_session-20260824-111655828.md`](../../reflections/reflection_2026-08-24_session-20260824-111655828.md)

### Implementation / acceptance evidence

Accepted in `3f4c27a` (+ task archive `aad5ac8`, journal `f5b4704`; child session `session-20260824-143558666`, managed tasks `bg-c1dfd213-fcad-4835-bad4-b40d3cf0dcd9` and `bg-de388247-4298-4251-a6e7-29e41e30b0ec`, both ended without a final result after completing/committing the work). Host inspected the implementation and independently passed `verify-background-bash.ts` (134), `verify-clear-session.ts` (44), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, commit/diff and AGENTS-size checks.

### Notes / blockers / abandonment reason

Foreground execute now reports its serialized shell's effective cwd; configured restart reports the reset project root. A conservative preflight refuses only simple relative `cd` or command-path shapes absent under cwd but present under project root, naming both locations without launching or mutating; complex syntax, absolute/PATH commands, existing cwd paths and paths missing in both places retain ordinary behavior.

## SRF-015 — Emit bounded, reasoning-safe heartbeats and a cancellable task id during long blocking subagent calls

- Status: `done`
- Priority: 53
- Score: 12
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`reflection_2026-08-24_session-20260824-111655828.md`](../../reflections/reflection_2026-08-24_session-20260824-111655828.md)

### Implementation / acceptance evidence

Accepted in `e6ae0f2` + transient-heartbeat correction `e3ac4db` + headless fixture correction `0363101` (+ task archive `4b88b29`; child session `session-20260824-150312114`, managed tasks `bg-fce09961-82f3-436c-af02-cd647dd17b30` and `bg-74634550-c667-4220-a0a2-51b16a13ace5`, both ended without final prose after committing). Host independently passed `verify-subagent-heartbeats.ts` (21), `verify-subagents.ts` (69), `verify-frame-budget.ts` (77), `verify-trajectory.ts` (267), `verify-headless-structured.ts` (11), `verify-completion-guard.ts` (24), free pty `completion` (66), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis validation and commit/diff/AGENTS-size checks.

### Notes / blockers / abandonment reason

Running dispatches now emit unref'd ≤30-second bounded heartbeats carrying only stable id, elapsed time and closed safe phase on the existing TUI row, text stderr, or stream JSON. `/agents cancel <id>` is user-only and cancels one child while siblings/parent continue; unknown/terminal ids refuse locally, full Ctrl+C remains broad, and all timers/cancellers clear before settlement with no trajectory/model/lifecycle path.

## SRF-016 — Add a bounded repeated-failure retry guard for tool and command loops

- Status: `done`
- Priority: 54
- Score: 14
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`reflection_2026-08-25_session-20260825-023511752.md`](../../reflections/reflection_2026-08-25_session-20260825-023511752.md)

### Implementation / acceptance evidence

Accepted in `b5133d3` + correction `7511778` (task archive `7c8e3c8`; journals `3762301`, `919d5be`; child session `session-20260826-043541334`, managed tasks `bg-cf9b6d41-1e2e-486d-b789-04bdacec30d4` exit 1 without final prose and `bg-f4462f87-296a-456d-8402-b75e182b42e1` exit 0). Host inspected the implementation and independently passed `verify-retry-guard.ts` (15), `verify-background-bash.ts` (135), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, commit/diff/clean-tree and AGENTS-size checks.

### Notes / blockers / abandonment reason

Delivered a per-Agent, per-invocation SDK intervention guard: three bounded normalized same-signature failures remain intact; the second injects evidence-backed-hypothesis guidance, the third says stop/report/ask, and later calls to that tool are denied before Pre hooks, permission or the body. Success clears tool state, a new invocation resets it, concurrent children are isolated, structured bash failures are covered through an additive pinned-SDK `exitCode`, and user `!` commands remain outside the guard.

## SRF-017 — Preflight CodeGraph availability and fall back without a doomed retry

- Status: `done`
- Priority: 55
- Score: 12
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 2
- Risk: 1
- Origin report: [`reflection_2026-08-25_session-20260825-023511752.md`](../../reflections/reflection_2026-08-25_session-20260825-023511752.md)

### Implementation / acceptance evidence

Accepted in `117103e` (+ task archive `d01d041`, journal `8647a20`; child session `session-20260826-051104786`, managed task `bg-ff49fca8-ebcd-4b2f-8b93-2a0b0cf59128`, exit 0). Host inspected the source/spec/test diff and independently passed `verify-codegraph-preflight.ts` (14), `verify-mcp-command.ts` (33), `verify-subagents.ts` (71), `pnpm typecheck`, full `pnpm test`, `pnpm build`, commit/diff checks and AGENTS-size validation.

### Notes / blockers / abandonment reason

Delivered a runtime-local, read-only preflight for the exact `codegraph` semantic readers: unavailable or unsafe targets return one bounded successful `bash`/`fileEditor` fallback without invoking MCP; initialized targets delegate unchanged; per-target decisions are cached and shared by parent/child catalogues.

## SRF-018 — Return zero-result web searches as successful empty results

- Status: `done`
- Priority: 56
- Score: 10
- Importance: 2
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 2
- Risk: 1
- Origin report: [`reflection_2026-08-25_session-20260825-023511752.md`](../../reflections/reflection_2026-08-25_session-20260825-023511752.md)

### Implementation / acceptance evidence

Accepted in `7dda590` (+ task archive `7c7c718`, journal `d1dddfd`; child session `session-20260826-070659337`, managed task `bg-08473b8f-5249-4951-9d9d-20d553d3e190`, exit 0). Host inspected the source/spec/test diff and independently passed `verify-web-search-empty-results.ts` (8), `verify-retry-guard.ts` (15), `verify-tool-hooks.ts` (44), `verify-subagents.ts` (71), `verify-codegraph-preflight.ts` (14), `verify-mcp-command.ts` (33), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis validation and commit/diff/AGENTS-size checks.

### Notes / blockers / abandonment reason

Delivered provider-specific compatibility at Darwin's post-registration MCP seam: only the exact `web-search` server `search` tool's verified MCP `-32602` no-results signature becomes successful query-preserving empty JSON; non-empty bytes/events and malformed/transport/auth/timeout/other provider failures remain unchanged; parent/child and refresh share the wrapper.

## SER-039 — Add bounded `Ctrl+R` reverse prompt-history search over Darwin's existing project trajectory: filter newest-first with duplicate collapse, navigate matches, accept into the editor, cancel without changing the draft, and preserve completion/queue/permission/compaction key ownership and frame bounds

- Status: `done`
- Priority: 57
- Score: 11
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-26.md`](../research_2026-08-26.md) (run `11:43:24Z`, rolled `peer` path)

### Implementation / acceptance evidence

Accepted in `9cdbffc` (child session `session-20260826-115313304`, managed task `bg-7136ab3f-6aeb-4861-a88c-59870aafa8e0`, exit 0, no correction turn): Host inspected the 24-file implementation and independently passed `verify-prompt-history-search.ts` (19), `verify-frame-budget.ts` (80), `verify-help-command.ts` (26), `verify-prompt-recall.ts` (61), free pty `historySearch` (11), `compacting` (5), `cursor` (5), `completion` (66), `pathCompletion` (27), `recall` (22), `recallEmpty` (4), `permissionEscape` (3), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, structural no-I/O/model/network grep, commit/diff/clean-tree and AGENTS-size checks. The pre-existing free pty `queue` fixture failed identically at parent `315cb71` after its unchanged batched draft-clear chord, so it was recorded as non-regression rather than repaired in this scope.

### Notes / blockers / abandonment reason

Claude Code and Codex both document `Ctrl+R` history search. Darwin already has a mutation-free project trajectory reader, sequential recall state, immediate editor mirrors, and a bounded one-row recall projection (`src/trajectory/prompt-history.ts`, `src/tui/prompt-recall.ts`, `src/tui/App.tsx`, `src/tui/InputBox.tsx`). Keep scope project-only; no model/network/write path and no new history store.

## SER-040 — Add conversation-only `/rewind` as a source-preserving branch at a completed prompt boundary: checkpoint SDK conversation state, select a prior prompt, restore into a fresh successor session, and return that prompt to the editor; never mutate the source session or workspace

- Status: `done`
- Priority: 58
- Score: 10
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-26.md`](../research_2026-08-26.md) (run `12:29:54Z`, rolled `peer` path)

### Implementation / acceptance evidence

Accepted in `db57a87` + Host-found retention correction `9ef6cc0` (research/task records `a27b3cd` + `8121110`; child session `session-20260826-123525049`; managed tasks `bg-f64d9202-996c-4274-bac3-980df3cc0f9d`, `bg-5d688c44-6ec3-4061-ac2f-9c0ccb51c85c`, and `bg-4b27036a-3d7d-4770-84be-9f8099a557e9`, all exit 0). Host inspected the implementation, rejected the initially unbounded immutable history, accepted only after the 100-snapshot serialized hard cap, and independently passed runtime rewind 20/20, chooser 7/7, free pty `rewind` 7/7, completion 67/67, frame budget 80/80, help 26/26, prompt queue 28/28, `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, commit/diff/clean-tree and AGENTS-size checks.

### Notes / blockers / abandonment reason

Claude Code and Codex establish prompt-bound rewind/branch UX; the current Strands TypeScript SDK now publicly supplies immutable snapshots, chronological listing and targeted restore, correcting the earlier premise that historical conversation restoration required trajectory reconstruction. Use SDK snapshots only for model state; trajectory remains observer-only and optional. The source session, its latest/immutable snapshots and trajectory stay untouched; a fresh successor session inherits live permission/MCP/background-process ownership like `/clear`, and the selected prompt returns to the editor. Scope is explicitly conversation-only: workspace files, shell/`!` effects, hooks, MCP writes, subagents, background jobs and learned-memory files are not rewound and the notice must say so.


## SER-041 — Attach a clipboard image to the next interactive prompt as a bounded visible chip, using the existing image decoder and SDK `ImageBlock` input while keeping trajectory/recall text-only and truthful

- Status: `done`
- Priority: 59
- Score: 14
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 2
- Origin report: [`research_2026-08-27.md`](../research_2026-08-27.md) (run `12:45:27Z`, rolled `peer` path)

### Implementation / acceptance evidence

Accepted in `2b04e59` plus Host-found provider-rejection correction `f4645d1` (task archive `152aa7d`, journal `20b39e3`; child session `session-20260827-125133864`; managed tasks `bg-28198ab5-9ffc-4dc1-8932-c30a5287b5d0` and `bg-90e4820b-b04f-496e-896a-8813be8cd12d`, both succeeded, exit 0). Host inspected the 32-file implementation, rejected the initial provider-failure state because it consumed the only in-memory image, and accepted only after the same literal prompt and image were restored for retry/removal without another clipboard or model call. Host independently passed runtime image input 5/5, clipboard adapter 8/8, image decoder/viewer 34/34, prompt queue 31/31, free pty `clipboardImage` 14/14, `queue` 17/17, `permissionEscape` 3/3, `compacting` 5/5, `completion` 67/67, `recall` 22/22, `historySearch` 14/14, stream resumption, help, `pnpm typecheck`, and `pnpm build`; commit/diff checks, clean-tree verification, and AGENTS.md size (28,097 bytes < 32 KiB) also passed. The full `pnpm test` reached only the expected Host-owned interim backlog failure while this evidence section was empty; after this closure the backlog validator and full gate are rerun before final reporting.

### Notes / blockers / abandonment reason

Claude Code and Codex both document direct screenshot input in their terminal composers. Darwin already has bounded local image decoding in `src/tools/image-viewer.ts`, and the installed Strands SDK accepts content-block arrays with byte-backed `ImageBlock`, but `AgentRuntime.send` currently narrows every user turn to a string. Add one interactive clipboard-image attachment path without forking the SDK loop or replacing the path-based `imageViewer` tool. The attachment must be visibly bounded in the live composer, survive unrelated draft edits, clear only when the prompt is actually sent or the user explicitly removes it, and preserve permission/compaction/paste/queue key ownership. Never put image bytes, clipboard contents, or a fabricated local path into trajectory, replay, export, prompt recall, memory evidence, or shell reports; record the literal user prompt and only a bounded truthful attachment fact where the existing record schema permits it. Failures and unsupported terminal/provider paths must leave the draft and attachment state honest and actionable.


## SER-042 — Add word-wise composer navigation and deletion: Alt/Ctrl+Arrow and Alt+B/F word jumps plus Alt+Backspace/Alt+D word deletes as grapheme-aware prompt-editor primitives, preserving completion/queue/recall/permission key ownership

- Status: `done`
- Priority: 60
- Score: 15
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 1
- Origin report: [`research_2026-08-28.md`](../research_2026-08-28.md) (run `13:03:31Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted in `c32e5f6` (task archive `6c3c7b1`, journal `bf71a13`; child session `session-20260828-133204010`; managed task `bg-b260775b-2125-4863-be93-c6e808e24113`, succeeded, exit 0). Pure word primitives (`moveWordHorizontal`, `deleteWordAfter`, shared `wordBoundaryBefore`/`wordBoundaryAfter` refactoring Ctrl+W's `deleteWordBefore` onto the same boundary) landed in `src/tui/prompt-editor.ts`; chords wired in `App.tsx` after every existing key owner and before the generic ctrl/meta ignore. Host inspected the full diff (grep-level proof the editor module gained pure functions only; plain arrows/backspace paths byte-identical in the unmodified branches) and independently passed `verify-prompt-editor.ts` 43/43, free pty `wordNav` 11/11, `cursor` 5/5, `multiline` 9/9, `completion` 67/67, `recall` 22/22, `recallEmpty` 4/4, `queue` 17/17, `historySearch` 11/11, `pnpm typecheck`, full `pnpm test` (exit 0), `pnpm build`, `git diff --check`/`show --check`, clean tree, and AGENTS.md size 29,452 bytes < 32 KiB.

### Notes / blockers / abandonment reason

Left/Right currently move exactly one grapheme (`src/tui/App.tsx:2087–2099`, `moveHorizontal(…, ±1, …)`) and every meta/alt chord is discarded by the generic ignore (`src/tui/App.tsx:2132`). The installed Ink keypress parser already delivers Alt+Left/Right (`CSI 1;3D/C`), Ctrl+Left/Right (`CSI 1;5D/C`), Alt+B/F (`metaKeyCodeRe`) and kitty-protocol alt/meta with `key.meta`/`key.ctrl` set, so the gap is entirely app-side. Add word-boundary primitives in `src/tui/prompt-editor.ts` beside the existing `deleteWordBefore` (line 178), reusing its word-character notion and the module's `Intl.Segmenter` grapheme segmentation so word jumps never split a grapheme; wire Alt/Ctrl+Arrow word movement, Alt+B/F equivalents, Alt+Backspace (delete word before, alias of Ctrl+W's primitive) and Alt+D (delete word after) in `App.tsx` **after** the existing owners — permission prompt, completion menu (Tab/arrows), queue take-back, recall, history/rewind search — so no current key contract changes; plain arrows and all existing chords stay byte-identical. Extend `spike/verify-prompt-editor.ts` with word-boundary cases (ASCII, emoji/ZWJ, CJK, punctuation runs, whitespace runs, line boundaries) and add a free pty scenario proving the chords act on the draft while menus/queue/recall still own their keys. No new frame row, no config, no persistence.
