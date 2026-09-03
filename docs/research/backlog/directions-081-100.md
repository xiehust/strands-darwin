# Darwin self-evolution backlog — priorities 081–100

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-060 — Show up to three recent non-empty output lines under each background job in `/tasks`, read as a bounded tail of the job's `outputPath` — never through `readOutput`, so the model's shared cursor and `wait` semantics are untouched; rows stay one `<Text>` each and counted

- Status: `done`
- Priority: 81
- Score: 9
- Importance: 2
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 1
- Origin report: [`research_2026-09-02.md`](../research_2026-09-02.md) (run `14:43:25Z`, rolled `peer` path)

### Implementation / acceptance evidence

Accepted 2026-09-02 in `5c4dcb3` (child session `session-20260902-165036184`, managed task `bg-8e375138-ad65-43da-ab06-f61611e4c303`, exit 0, no correction turn; journal `12d04d3`, Trellis task archived in `5099137`). New `src/tools/background-tail.ts` — `TASK_TAIL_LINES = 3`, `TASK_TAIL_WINDOW_BYTES = 8 KiB`, `sanitizeTailLine` (ANSI/C0 stripped, tabs→spaces), `readBackgroundTail(outputPath)` → `{lines, bytesRead} | {empty} | {unavailable}` and `readBackgroundTails(tasks)`; it opens the log itself with `O_RDONLY|O_NOFOLLOW`, reads at most the last window, drops a leading partial line only when a complete line follows, imports nothing from `background-bash.ts` and never rejects. `task-format.ts` gains `TASK_TAIL_LINE_LIMIT = 100`, `TASK_TAIL_PREFIX` (`    │ `), the two placeholders and `formatTaskTail`; `formatTasksReport(tasks, nowMs, tails?)` keeps legacy calls byte-identical; a zero-output job keeps its row plus one stated `(no output yet)` line (decision recorded in `tui-testing.md`). `App.tsx` `/tasks` awaits `listBackgroundTasks()` then `readBackgroundTails()` before the single notice. Host acceptance, all independently re-run at `5099137`: `pnpm typecheck` exit 0; full `pnpm test` exit 0 (87 suites, 0 `FAIL`); `spike/verify-tasks-tail.ts` 33/33 (real manager job with blank and ANSI lines → exactly the last three non-empty lines stripped/marked/indented; tail-then-`output` equals a control job's `output` field by field and a terminal-focused `wait` spanning a tail read equals control; tail after `output` unchanged; no output and blank-only → `(no output yet)`; deleted path and a directory → `(output unavailable)` without throw; 99 chars + `…` at the limit; > 8 KiB file → `bytesRead === 8192`, markers shown, cursor still 0); `spike/verify-task-format.ts` 18/18; `spike/verify-background-bash.ts` 157/157; free pty `bang` 19/19, `queue` 17/17, `completion` 69/69; `pnpm build` exit 0; `git show --check` clean on the feature and archive commits (journal commit: one cosmetic blank-line finding); AGENTS.md untouched at 32,667 B. No model-free way exists to start a real background job from a pty, so the unit suite carries the tail proof (stated in `tui-testing.md`). Docs: `reference.md`/`zh-CN` `/tasks` row; specs `tui-testing.md`, `strands-sdk-contracts.md` cursor-matrix row, `error-handling.md` row, `live-frame.md` sentence; `load-bearing-decisions.md` § Process exit paragraph. Child self-reported one rule-8 slip (journal whitespace trim via a `python3` heredoc). Logged as [`Batch 85`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Requirement: `formatTasksReport` in `src/tui/task-format.ts` gains, under each job row, up to three (`TASK_TAIL_LINES`) recent non-empty output lines, each truncated end-first to a bounded width, indented and marked so they cannot be mistaken for job rows. The lines come from a new bounded tail reader over `BackgroundTaskStatus.outputPath` (read the last N KiB of the file, split, drop blank lines, keep the last three) that is separate from `BackgroundBashManager.readOutput` and never touches the task's shared `cursor`, `OUTPUT_LIMIT` accounting or any `wait` in flight — `bash output`/`wait` results before and after a `/tasks` are byte-identical. Unreadable or empty output is stated (`(no output yet)` / `(output unavailable)`), never an error; the report stays a transcript block (no live row) and the existing one-line-per-job shape is preserved for zero-output jobs. Peer evidence: Codex `/ps` "each background terminal's command plus up to three recent, non-empty output lines" (S2), `claude logs <id>` (S1). Acceptance: `spike/verify-background-bash.ts` (or a sibling in `pnpm test`) starts a real job that writes several lines, asserts the `/tasks` formatter shows the last three non-empty ones bounded, then proves an `output` call's `startOffset`/`endOffset` are unchanged by the `/tasks` read; a job with no output shows the stated placeholder; `spike/verify-tui.ts bang`/`queue` stay green; `pnpm typecheck`, `pnpm test`, `pnpm build`. Handoff constraint: AGENTS.md has 101 B of headroom — no new AGENTS.md row; the invariant sentence goes to `.trellis/spec/frontend/live-frame.md` and `docs/user-guide/reference.md`.

## SER-061 — Bound concurrent delegation: a configurable `maxConcurrentSubagents` cap on running dispatches, refused as one bounded tool error before any model or child exists and telling the model not to retry; `workflow` nodes count against the same ceiling

- Status: `done`
- Priority: 82
- Score: 13
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 1
- Origin report: [`research_2026-09-03.md`](../research_2026-09-03.md) (run `14:57:47Z`, user-directed `peer` path)

### Implementation / acceptance evidence

Accepted 2026-09-03 in `1ae3556` (child session `session-20260903-152606204`, managed task `bg-87431762-d703-49e8-96ca-ede02bf99b13`, exit 0, no correction turn; run without Trellis by user direction). New `src/agents/concurrency-limit.ts` (`concurrencyCap`, fixed `concurrencyLimitMessage`, `concurrencyDescriptionClause`), `SubagentDispatchRegistry.runningCount()`, `DEFAULT_MAX_CONCURRENT_SUBAGENTS = 8` in `src/config.ts` validated by `integerField(…, { min: 1 })`; `subagent` refuses after name resolution and before `begin()`/`createModel`; `workflow` refuses when `running + min(nodes, maxConcurrency ?? nodes) > cap` right after `validate()`; `runtime.ts` untouched. Host re-ran at `1ae3556`: `pnpm typecheck` exit 0; full `pnpm test` (pipefail) exit 0 — 88 suites, 4421 passed, 0 failed; `spike/verify-subagent-limit.ts` 27/0 ((N+1)th call refused with `createModel` uncalled and no registry record/child; workflow refused before any node; settlement re-admits; `maxConcurrency` 2 admits a 3-node DAG under cap 2; `updateConfig` lowers the live cap; fresh registry has 0 running); `pnpm build` exit 0 with `maxConcurrentSubagents` in `dist/src/config.js`; `git show --check` clean; AGENTS.md 31,782 B. Docs: `configuration*.md` rows, `extensions*.md` sentences, spec § subagents/workflow, load-bearing § Subagents, AGENTS.md row clause. Logged as [`Batch 86`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Recorded nuance (child report, stated in spec and `extensions.md`): a workflow node holds a slot from `begin()` even while the SDK graph has it waiting on a dependency, so an 8-node DAG with `maxConcurrency: 1` passes admission (needs 1) and then occupies 8 slots until nodes settle — the registry count is the single source of truth by design; counting only scheduled nodes would need new state.

Original requirement: `AppConfig` gains a validated positive-integer `maxConcurrentSubagents` (default stated in `src/config.ts` and `docs/user-guide/reference.md`; a bad value refuses to start like every other config field). `SubagentTool.dispatch` consults the existing `SubagentDispatchRegistry` count of `running` records: when it is at the cap, the call returns one bounded tool error naming the cap and the running count and stating that the model must not retry until a dispatch settles — before `createModel`, before `begin()`, so no dispatch record, model or child exists. `WorkflowTool` applies the same check before building any node: a DAG whose effective parallelism (`min(nodes, maxConcurrency)`) cannot fit in the remaining slots is refused with the same shape. Settlement frees the slot through the registry's existing terminal transition; `/clear`'s successor starts empty. Peer evidence: Claude Code "Concurrent subagent limit reached … tells Claude not to retry" (S1b), Codex `agents.max_concurrent_threads_per_session` (S2), SDK `BackgroundTasksConfig.maxConcurrency` default 4 (S6). Prerequisite for SER-064. Acceptance: a `pnpm test` suite (offline, fake model) dispatches cap+1 `subagent` calls and proves the (cap+1)th returns the refusal with no model construction and no registry record, a `workflow` over the remaining slots is refused before any child, and settlement re-admits; `spike/verify-config.ts` covers the field and its refusal; `spike/verify-subagents.ts`, `spike/verify-workflow-tool.ts`, `spike/verify-subagent-heartbeats.ts` stay green; `pnpm typecheck`, `pnpm test`, `pnpm build`. Handoff constraint: AGENTS.md is 31,616 B against the 32 KiB cap — extend the existing Subagents row's invariant text by a clause rather than adding a row.

## SER-062 — Harden child reports: one pure projection over every `subagent`/`workflow` report before it becomes the parent tool result — backslash-escape lines imitating darwin's own prompt framing or transcript roles and prepend one bounded marker line when a pattern or permission-bypass vocabulary matched; never remove or reword

- Status: `done`
- Priority: 83
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-03.md`](../research_2026-09-03.md) (run `14:57:47Z`, user-directed `peer` path)

### Implementation / acceptance evidence

Accepted 2026-09-03 in `7e4a1ac` (child session `session-20260903-155750363`; first task `bg-4a753a79-1a8a-4c74-aaec-f582b642a80a` died before any model call on `Bedrock is unable to process your request.` with nothing written, retry task `bg-97975826-abfa-4d9a-bd58-418fd7104094` exit 0, no correction turn; run without Trellis by user direction). New `src/agents/report-projection.ts` (`projectChildReport`: anchored prefix checks only, backslash before framing tags/`Human:`/`Assistant:` at line start, one fixed marker line `[darwin: subagent report matched instruction-shaped pattern(s): …]` with categories in fixed order, permission vocabulary marker-only, clean input returned as the same object, existing canonical marker folded not stacked, CRLF preserved); applied at `SubagentTool.run` after `withRetainedMaxTokensText` and at the `workflow` terminus with the empty placeholder byte-identical. Host re-ran at `7e4a1ac`: `pnpm typecheck` exit 0; full `pnpm test` (pipefail) exit 0 — 89 suites, 4478 passed, 0 failed; own `tsx` probe (escaped tag/role lines, mid-line tag untouched, idempotent, clean `===`, vocabulary marker-only, placeholder unchanged); `pnpm build` exit 0 with `dist/src/agents/report-projection.js`; `git show --check` clean; AGENTS.md 32,032 B < 32,768. Docs: spec `#### Report projection (SER-062)`, load-bearing § Subagents, `extensions*.md`, AGENTS.md row clause. Logged as [`Batch 87`](../../iteration-log.md).

### Notes / blockers / abandonment reason

Child-reported risks, accepted as designed: `alwaysAllow`/`permissionMode` are darwin's own terms, so a child reporting on `src/agent/permission.ts` earns a harmless marker; a child emitting a byte-exact canonical marker as its first line has it folded (categories widen to the union, later lines still escaped). The projection is a report-level projection, not a security boundary — the gate still governs any tool call the report leads to.

Original requirement: a pure function (new module under `src/agents/`) applied at exactly the two return sites — `SubagentTool.run`'s report and `WorkflowTool`'s terminus content — that (a) inserts one backslash into a line that opens or closes darwin's own framing tags (`<project-instructions>`, `<available_skills>`, `<working-context>`, `<system-reminder>`) or starts with `Human:`/`Assistant:`, so the imitation reads as text; (b) when any pattern matched, or when the report mentions permission-bypass vocabulary (`alwaysAllow`, `permissionMode`, `--dangerously`, `bypass`), prepends one fixed bounded marker line of the shape `[darwin: subagent report matched instruction-shaped pattern(s): …]` naming the categories; (c) otherwise returns the input byte-identical. It never deletes, reorders or rewords; the projected string is the ordinary tool result, so trajectory, replay, retry guard and dispatch records see one value. Peer evidence: Claude Code subagent output scanning v2.1.210 (S1b). Darwin evidence: `SubagentTool.run` returns `withRetainedMaxTokensText(result.toString(), …)` verbatim; offload/memory marker-spoof resistance is the precedent. Acceptance: a `pnpm test` suite feeds crafted reports through the projection and asserts backslash placement, the single marker line, byte-identity for clean input, and idempotence (projecting twice adds nothing); `spike/verify-workflow-tool.ts` proves terminus coverage; `spike/verify-subagents.ts` stays green; `pnpm typecheck`, `pnpm test`, `pnpm build`.

## SER-063 — Keep a failed child's evidence: when a child's `invoke()` throws after producing assistant text, the tool error carries the bounded last assistant text plus a fixed cut-off note; the dispatch still settles `failed`, the retry guard still counts a failure and the trajectory keeps the error

- Status: `not-started`
- Priority: 84
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-03.md`](../research_2026-09-03.md) (run `14:57:47Z`, user-directed `peer` path)

### Implementation / acceptance evidence

(none yet)

### Notes / blockers / abandonment reason

Requirement: in `SubagentTool.run` (and the equivalent node failure path in `WorkflowTool`), when the child's invocation throws and the child's own `messages` end with assistant text, rethrow an error whose message is the original message followed by one fixed note (`subagent was cut off before finishing; its last output follows`) and the bounded (code-point capped, cap stated) last assistant text — still an **error** result, so `dispatch.finish('failed')`, the retry guard's failure count and `turnEnded.failure` are unchanged. A child that produced no text yields the unchanged error. Only the failing child's own final text is read — never reasoning, tool payloads or earlier turns — through the same seam that returns the success report, so the "records never carry child transcript" invariant holds. Passes through SER-062's projection. Peer evidence: Claude Code "API errors in subagents" v2.1.199 (S1b) and failed-teammate notification carrying the error text (S1). Darwin evidence: the catch in `SubagentTool.dispatch` rethrows bare; `withRetainedMaxTokensText`/`RETAINED_PARTIALS` already retains partials for the max-tokens path. Acceptance: a `pnpm test` case with a fake child model that streams text then throws proves the error content, the `failed` state and that `spike/verify-retry-guard.ts` counts it; a text-less failure is byte-identical to today; `spike/verify-subagents.ts` stays green; `pnpm typecheck`, `pnpm test`, `pnpm build`.

## SER-064 — Background delegation through the SDK: construct the parent `Agent` with `backgroundTasks` so the model may mark a `subagent`/`workflow` call `_background_execution` and keep working while the child runs, with results delivered by the SDK's `strands_background_task_result` pair; gate/retry-guard ordering, trajectory, TUI rows and child catalogues stay proven

- Status: `not-started`
- Priority: 85
- Score: 10
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-09-03.md`](../research_2026-09-03.md) (run `14:57:47Z`, user-directed `peer` path)

### Implementation / acceptance evidence

(none yet)

### Notes / blockers / abandonment reason

Requirement: `runtime.ts` — the only place that constructs `Agent` — passes `backgroundTasks: { agentic: ['subagent', 'workflow'], never: [every other registered tool name], waitForCompletion: true, maxConcurrency: <SER-061 cap> }` on the parent only; children (`buildRecipeChild`) never receive the option, and `strands_manage_background_task` is added to `PARENT_ONLY_TOOL_NAMES` so no child catalogue carries it. Nothing else about the loop changes: the SDK executor yields `BeforeToolCallEvent` and honours `cancel` before `routeToolCall` (`dist/src/tools/executors/executor.js`), so permission denial, plan mode and the retry guard precede background dispatch exactly as today. The ack result and the later delivered `strands_background_task_result` tool-use/result pair are ordinary stream events: `turn-state.ts` renders them as tool rows (ack: "delegated in background · task <id>"; result: the existing subagent row shape), `formatReplay` shows the same, and `/agents` remains the dispatch view. Ctrl+C cancels running background children through the existing registry. `/rewind` and `/clear` are proven against `assertCanLoadSnapshot`/`_loadAppState`. Depends on SER-061 (fan-out ceiling first) and inherits SER-062/SER-063 at the report seam. Peer evidence: Claude Code background subagents (S1b), Codex background-agent panel (S2). SDK evidence: `BackgroundTasksConfig` and plugin behaviour verified in the installed 1.16.0 source (S6). Acceptance: offline `pnpm test` suite with a fake model — parent marks a `subagent` call background, receives the ack, issues another tool call before the child settles, receives the result before its next model call; plan mode denies a background-marked write-capable delegation before dispatch; `spike/verify-trajectory.ts`/replay render both rows; `spike/verify-rewind.ts`, `verify-clear-session.ts` green; children's tool lists contain neither the manage tool nor the flag; `spike/verify-tui.ts updatePlan`/`queue` green. Live: `AWS_REGION=us-west-2 pnpm tsx spike/verify-subagents.ts` shows a parent continuing while a child runs. `pnpm typecheck`, `pnpm test`, `pnpm build`. Spec: add the contract to `backend/strands-sdk-contracts.md` and a clause to the AGENTS.md Subagents row (31,616 B — mind the 32 KiB cap).

## SER-065 — Declared write scopes for `workflow` nodes: optional normalized path-prefix `writeScopes` per node; overlapping scopes on nodes not ordered by an edge path are refused before any child exists, and a scoped node's `fileEditor` mutation outside its scopes is denied by the existing gate through dispatch `source` — never a new gate; unscoped nodes unchanged

- Status: `not-started`
- Priority: 86
- Score: 9
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-09-03.md`](../research_2026-09-03.md) (run `14:57:47Z`, user-directed `peer` path)

### Implementation / acceptance evidence

(none yet)

### Notes / blockers / abandonment reason

Requirement: `workflowInputSchema` nodes gain optional `writeScopes: string[]` (1–8 entries, each a relative path prefix normalized against the project root; absolute, `..`-escaping or empty entries are a bounded validation error). Validation, alongside the existing cycle/duplicate/unknown checks and before any dispatch or model, refuses a DAG in which two nodes with overlapping scopes (one prefix contains the other) are not connected by a directed edge path in either direction — the "serialize writes by edges" rule made checkable. At run time the dispatch record carries the node's scopes; the permission gate, which already resolves `source` from `BeforeToolCallEvent.agent.id`, denies (`deny(...)`, never `confirm()`) a `fileEditor` `create`/`str_replace`/`insert` whose resolved path is outside the caller's declared scopes with one bounded reason naming the scopes. `view`, other tools, unscoped nodes, `subagent` dispatches and the parent are unchanged; bash is explicitly out of scope and the tool description says so. Peer evidence: DeepSeek `writeScopes` "normalized advisory path prefixes rather than locks" with overlap warnings (S3), Claude Code "each teammate owns a different set of files" (S1). Darwin evidence: `WorkflowTool` refuses invalid DAGs before dispatch; the same-path race is measured in load-bearing § Same-path fileEditor ordering. Acceptance: `spike/verify-workflow-tool.ts` proves unordered overlap is refused before any child, ordered overlap is accepted, bad prefixes are refused, and an in-scope/out-of-scope write from a scoped node is allowed/denied by the existing gate with the dispatch `source` in the reason; `spike/verify-permissions-command.ts` and `verify-workflow-command.ts` unchanged; `pnpm typecheck`, `pnpm test`, `pnpm build`.
