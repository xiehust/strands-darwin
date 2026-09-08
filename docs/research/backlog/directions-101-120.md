# Darwin self-evolution backlog — priorities 101–120

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SRF-026 — Continue a `subagent` child once after the exact stream-interruption `ModelError`: when `child.invoke()` rejects with `isRetryableStreamInterruption` and the child is not cancelled, run one `invoke(STREAM_CONTINUATION_PROMPT)` on the same live child, publish a `continuing-after-stream-interruption` heartbeat phase, and on a second failure rethrow through `withFailedChildText` with the original error as `cause` — never inside the SDK loop, never a second attempt, `workflow` nodes unchanged

- Status: `done`
- Priority: 101
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-09-08_session-20260905-014347068.md`](../../reflections/reflection_2026-09-08_session-20260905-014347068.md)

### Implementation / acceptance evidence

Done — commit `fb56661` (`feat(subagents): continue a child once after a stream interruption`, 14 files), Batch 105 in `docs/iteration-log.md`. `SubagentTool.invokeWithStreamContinuation` wraps exactly the `child.invoke(task)` call: on `isRetryableStreamInterruption` with no cancel (child signal, parent signal, `cancellationRequested()`), `setPhase({ kind: 'continuing-after-stream-interruption' })` then one `child.invoke(STREAM_CONTINUATION_PROMPT, { invocationState })`; a second failure is `continuationFailure(original, second)` (original `name`, original as `cause`, second message appended) through the unchanged `withFailedChildText`; a cancel during the continuation is rethrown unwrapped. New phase kind rendered by `subagent-format.ts`, `headless-runner.ts`, `headless-protocol.ts`; one `STREAM_CONTINUATION_DESCRIPTION_CLAUSE` on the tool description. `spike/verify-subagent-continuation.ts` (40 assertions, registered in `run-tests.ts`): fake stream ending without a stop event makes the SDK throw the exact `ModelError`; interrupted once → report, `succeeded`, 3 model calls, `inputs[2] === STREAM_CONTINUATION_PROMPT`, phase observed; interrupted twice → original message, `cause instanceof ModelError`, `failed`, no third call; other-class second failure keeps the chain through `withFailedChildText`; cancel during first attempt / during continuation → `cancelled`, never wrapped; non-interruption error → 2 calls, no phase; `continue=<id>` follow-up is its own single attempt; `workflow` node interrupted → fails without continuation. Host acceptance at `fb56661`: `pnpm typecheck` 0, `pnpm test` 0 (103 suites, 5599 passed, 0 failed), `pnpm build` 0, `dist/src/agents/subagent-tool.js` carries the phase. Original requirement text: in `src/agents/subagent-tool.ts`, wrap the `child.invoke(injectCodexContext(task, hookContext), { invocationState })` call so that when it rejects with an error for which `isRetryableStreamInterruption(error)` (from `src/agent/stream-resumption.ts`) is true and `child.cancelSignal.aborted` is false, exactly one `child.invoke(STREAM_CONTINUATION_PROMPT, { invocationState })` runs on the same live child (its retained in-memory conversation ends at the last tool result, so the continuation is an ordinary user-role message); the dispatch record's safe phase becomes `continuing-after-stream-interruption` via the existing `setPhase` for the duration; the successful continuation's result flows through the unchanged refusal check, `projectChildReport` and `withRetainedMaxTokensText`; a second failure (of any class) is rethrown through `withFailedChildText` with the *original* interruption error preserved as `cause` and `name`, so the retry guard's signature and `turnEnded.failure` are unchanged in shape; a cancelled child is never continued; the continuation is attempted at most once per dispatch (a `continue=<id>` follow-up is its own dispatch with its own single attempt); `workflow` Graph nodes are untouched. The `subagent` tool description gains one clause naming the single continuation. Acceptance: `spike/verify-subagents.ts` (or a new free suite) with a fake model that throws the exact `ModelError('Stream ended without completing a message')` once and then answers — the parent tool result is the child's report, the dispatch settles `succeeded`, the heartbeat phase was observed; a fake model that throws twice — the tool error carries the original message and `error.cause` is the first `ModelError`, dispatch settles `failed`; a child cancelled during the first attempt is not continued; a non-interruption error is not continued; `verify-stream-resumption.ts`, `verify-failed-child-text.ts`, `verify-continuable-children.ts`, `pnpm typecheck`, `pnpm test`. Docs: the Subagents load-bearing section and the Stream-interruption section state that children get the same one continuation, on the child, never in the loop.

### Notes / blockers / abandonment reason

Evidence: session `session-20260905-014347068` turn 26 — two `subagent` children dispatched at seq 1740 (09:51:14) and seq 1760 (10:03:52) died at seq 1741 (10:03:00, 11 m 46 s) and seq 1761 (10:13:16, 9 m 24 s) with the bare `Error: Stream ended without completing a message`; neither carried SER-063 last text (the last completed child message was tool-use-only) nor was SER-075-continuable (conversation ended in a tool result). The parent re-derived progress from disk (seq 1745–1757: "The child got through the captions refactor before its stream was cut off"), then wrote the portrait script itself (seq 1781–1806). 21 m 10 s of the 34 m 50 s turn produced nothing. Contrast: the parent's own interruption at seq 31 was continued 49 ms later as turn 2 (seq 32) and delivered the deck. Independent of SRF-027/028.

## SRF-027 — Record `/compact` in the trajectory: one bounded `contextCompacted` observer record written by the TUI driver after a successful `AgentRuntime.compact()` (message counts before/after, the pre-compaction estimate when known, whether a focus was given — never summary or focus text), printed as one line by `trajectory replay` and therefore `/export`, and treated by `spend.ts` as an anchor drop for the next `modelCall`'s `context ~N tokens`

- Status: `done`
- Priority: 102
- Score: 9
- Importance: 2
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 1
- Origin report: [`reflection_2026-09-08_session-20260905-014347068.md`](../../reflections/reflection_2026-09-08_session-20260905-014347068.md)

### Implementation / acceptance evidence

Done — commit `682bbb1` (`feat(trajectory): record /compact as a contextCompacted observer line`, 17 files), Batch 106 in `docs/iteration-log.md`. `ContextCompactedRecord` (`before.messages`, optional `before.estimatedTokens`, `after.messages`, `focused`; numbers only, `searchableText` empty) with `contextCompactedOf` normalizer (`boundedCount`: safe non-negative integers, a 0 estimate is absence); `TrajectoryRecorder.recordContextCompacted` buffers + flushes synchronously and degrades open through `fail()`; `AgentRuntime.recordContextCompacted` passthrough; one composer `compactAndRecord(host, focus)` in `src/agent/compact.ts` reads `contextEstimate()` best-effort *before* compacting and records only under `compacted: true` — called from the single TUI site (`App.tsx`) and from headless `--compact-before`, so both drivers describe a compaction identically. Replay prints one reducer notice `context compacted: N → M messages · ~T tokens before · focused` in transcript order (`/export` and the resume recap inherit it); `spend.ts` `modelCallEntries` drops the stale `contextTokens` on the first `modelCall` after a valid record and prints `context: reset by compaction`. Suites: `verify-trajectory.ts` 317 (round-trip, malformed/oversize rejected, absent estimate stays absent, exact replay line, search/fork tolerate), `verify-compact.ts` 84 (scripted host + real recorder: 3 shrinks → 3 lines, no-shrink/failure → none, blank focus → `focused: false`, bytes free of focus/summary text, `App.tsx` calls `compactAndRecord` exactly once), `verify-export-command.ts` 36, `verify-resume-recap.ts` 30, `verify-headless-structured.ts` 33 (`--compact-before` trace `compact → recordContextCompacted`). Host acceptance at `682bbb1`: `pnpm typecheck` 0, `pnpm test` 0 (103 suites, 5645 passed, 0 failed), `pnpm build` 0 (`dist` carries the type), `spike/verify-tui.ts completion` 69/0. Original requirement text: add a `contextCompacted` record type to `src/trajectory/record.ts` (reader/normalizer, bounded numeric fields: `before.messages`, `after.messages`, optional `before.estimatedTokens`, boolean `focused`), a writer entry point on the trajectory recorder that appends it synchronously like `shellCommand`/`taskNotification` (no I/O on the stream path, degrades open), and one call site in `src/tui/App.tsx` after `runtime.compact()` reports `compacted: true`; `formatReplay` prints one line (`context compacted: <before> → <after> messages`), so `/export` shows it byte-identically; `src/trajectory/spend.ts` stops labelling the first `modelCall` after it with the stale SDK projection (print `context: reset by compaction` or omit the `context ~N tokens` suffix for that one call). Never the summary text, never the focus text, no SDK change, no new TUI surface. Acceptance: `spike/verify-trajectory.ts` round-trips the record and rejects oversize/malformed fields; `spike/verify-compact.ts` asserts exactly one record per successful compaction and none on the no-shrink/failure paths; `spike/verify-export-command.ts` shows the line; `pnpm typecheck`, `pnpm test`; `tui completion` unchanged.

### Notes / blockers / abandonment reason

Evidence: session `session-20260905-014347068` — seq 1245 (turn 15 `turnEnded`, 07:03:52) → seq 1246 (turn 16 `userInput`, 07:39:55) with no record between; seq 1250 `modelCall.contextTokens: 705408` while that call's own spend is input 4 + cacheRead 0 + cacheWrite 43,990 (≈ 44k actual, a full cache miss); seq 1255 `contextTokens: 46647`. The stale value is the SDK `_estimateInputTokens` baseline (last assistant message carrying usage metadata — after summarization a preserved recent message still carries pre-compaction usage). Config for the session: `summaryRatio 0.8`, `preserveRecentMessages 10`. Touches `src/trajectory/record.ts` and the replay header like SRF-028; implement before it.

## SRF-028 — Name a rewind successor's origin in its own trajectory: when `AgentRuntime.create` runs with `options.rewindRestore`, the `runStarted` record carries `rewindFrom: { session, snapshotId }` (bounded strings, optional, additive), and `trajectory replay`'s header plus the interactive resume recap print it; `resumed`/`restoredMessages` semantics unchanged

- Status: `done`
- Priority: 103
- Score: 11
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 1
- Risk: 1
- Origin report: [`reflection_2026-09-08_session-20260905-014347068.md`](../../reflections/reflection_2026-09-08_session-20260905-014347068.md)

### Implementation / acceptance evidence

Done — commit `9090d07` (`feat(trajectory): name a /rewind successor's origin in runStarted`, 11 files), Batch 107 in `docs/iteration-log.md`. `RewindOrigin { session, snapshotId }` with `MAX_REWIND_ORIGIN_CHARS = 128` (code points, mirrors the private `MAX_SNAPSHOT_ID_CODE_POINTS`; `record.ts` stays dependency-free) and the shared validator `rewindOriginOf` (non-empty strings within the cap, pair dropped whole when either is malformed); `RecorderRunInfo.rewindFrom?` — `header()` destructures it out and re-adds the key only when valid, so fresh / `--resume` / `/clear` `runStarted` bytes are identical to before (no key, never `rewindFrom: undefined`); `AgentRuntime.create` passes `{ session: rewindRestore.sourceSessionId, snapshotId: rewindRestore.snapshotId }` only when `options.rewindRestore` is defined, `resumed`/`restoredMessages` and `startRewind` untouched; `formatReplay` appends ` · rewound from <session> snapshot <id>` after ` · resumed` on the one `--- run` header line (`formatRewindOrigin`); the resume recap title repeats that clause, read from the replay's validated `runs`. Suites: `verify-trajectory.ts` 340 (round-trip with/without, 8 malformed shapes byte-identical to the plain header, cap inclusive at 128 code points, exact header strings, `--turn` keeps it), `verify-rewind.ts` 31 (real offline runtimes: successor's first record names source session + snapshot id exactly as `startRewind` passed them, `resumed:false restoredMessages:2`, source trajectory `Buffer.equals` before/after, fresh/resumed/`/clear` headers lack the key), `verify-resume-recap.ts` 36 (clause present/absent/malformed, one notice only, body still `replayRecords`). Host acceptance at `9090d07`: `pnpm typecheck` 0, `pnpm test` 0 (103 suites, 5685 passed, 0 failed), `pnpm build` 0 (`dist/src/trajectory/writer.js` and `dist/src/agent/runtime.js` carry `rewindFrom`), `AGENTS.md` unchanged at 32,696 B. Original requirement text: in `src/agent/runtime.ts` `create`, when `options.rewindRestore` is defined pass `rewindFrom: { session: options.rewindRestore.sourceSessionId, snapshotId: options.rewindRestore.snapshotId }` into the `TrajectoryRecorder` `run` options; `src/trajectory/record.ts` accepts the optional field on `runStarted` (both strings capped like the other run-record strings, dropped when malformed), `formatReplay` prints it on the run header line (`rewound from <session> snapshot <id>`), and `src/trajectory/resume-recap.ts` includes it in the recap notice when present. Sessions started fresh, by `--resume` or by `/clear` write byte-identical `runStarted` records to today. Acceptance: `spike/verify-trajectory.ts` round-trips a `runStarted` with and without the field; `spike/verify-rewind.ts` asserts the successor's first record names the source session and snapshot id and that the source trajectory is untouched; `spike/verify-resume-recap.ts` shows the notice; `pnpm typecheck`, `pnpm test`.

### Notes / blockers / abandonment reason

Evidence: session `session-20260905-014347068` seq 0 `runStarted { resumed: false, restoredMessages: 188 }` and seq 5 (first call: `contextTokens 239287`, cacheRead 0, cacheWrite 240,978). `startRewind` creates the successor with `session: { kind: 'new' }` (so `restoreRequested` is false) and the snapshot supplies the messages, but the record is composed only from `session.restoreRequested` and `agent.messages.length`; the predecessor `session-20260904-145930073` holds one rewind checkpoint (completed 2026-09-04T15:18:44Z). Shares `record.ts`/replay-header edits with SRF-027; implement after it.

## SER-076 — User-written deny rules: `permissionRules.deny` in the same project-scoped `permission-rules.json` and rule grammar as `allow` (`bash:git push --force*`, `fileEditor:dist/**`, bare tool name), validated at load; judged in `PermissionGate.beforeToolCall` right after the write-scope guard and before the plan guard, `yolo`, `safe`, allow-rules and the classifier, so it holds in every mode and for every child sharing the gate; a bash deny matches when any chained segment matches and shell metacharacters never exempt it; the model receives one bounded `DENIED` error naming the rule; `/permissions` lists deny rules as `deny (configured)` and refuses to revoke them; no prompt ever offers a deny rule; `/status` counts them separately

- Status: `not-started`
- Priority: 104
- Score: 11
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-09-08.md`](../research_2026-09-08.md) (run `03:27:54Z`, `peer` path by user override)

### Implementation / acceptance evidence

Not started. Acceptance: `pnpm typecheck`, `pnpm test`; a free suite (`spike/verify-deny-rules.ts`, or an extension of `spike/verify-permissions-command.ts`) proving that a `bash:git push --force*` deny blocks `git status && git push --force` in `default`, `auto`, `plan` and `yolo`; a command with redirection/substitution whose segment matches a deny is denied; a deny wins over a matching allow rule; the model-facing error names the rule; `/permissions` lists it with origin `configured` and refuses to revoke it; an invalid deny string is a `ConfigError` naming the entry; `spike/verify-config.ts` stays green; `tui completion` re-run if `/permissions` help text changes.

### Notes / blockers / abandonment reason

Sources: Claude Code `permissions.md` ("Rules are evaluated in order: deny, then ask, then allow"; a broad deny beats a narrower allow), Codex exec-policy (`decision = "forbidden"` is the most restrictive and wins when several rules match), OpenCode `deny` rules survive `--auto` (2026-08-18 S8). Darwin evidence: `src/agent/permission-rules.ts` is allow-only by its own header; `src/config.ts:315` types `permissionRules` as `{ allow }` and `allowRulesField` (`:1301`) reads only `allow`; the gate stage order at `src/agent/permission.ts:470–545` has no stage a user-written rule can *fail*. Constraints that carry over unchanged: the metacharacter refusal and every-segment requirement stay as they are for `allow`; the load-bearing rule that no rule may cover `~/.darwin/config.json`/`.env*` is about widening and does not apply to a deny; a deny rule is a project-scoped configured fact — the session never grants one and `/permissions` never removes one (the file is the only write path). Optional `justification` text (Codex) was gated this run as a follow-up needing an object rule form.

## SER-077 — `/context` breakdown: `ContextEstimate` gains an optional `breakdown` computed on demand (only when `/context` runs, never per turn) by `model.countTokens` per component — system prompt by section (base, `<project-instructions>`, skills catalogue, working context), tool specs grouped by origin (darwin built-ins, each MCP server by name), conversation messages — printed as bounded rows (`~N tokens · P%` when the window is known) under the existing total line; a component whose count fails reads `not reported`; the total line and `/status` stay byte-identical

- Status: `not-started`
- Priority: 105
- Score: 11
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-09-08.md`](../research_2026-09-08.md) (run `03:27:54Z`, `peer` path by user override)

### Implementation / acceptance evidence

Not started. Acceptance: `spike/verify-context-format.ts` extended with breakdown rows (bounded row count, `not reported` on a failed component count, `P%` only when the window is known); a runtime-level check that the `/context` total line and `/status`'s context value are byte-identical with and without the breakdown; `spike/verify-context-anchor.ts` unchanged; `tui completion` unchanged; `pnpm typecheck`, `pnpm test`.

### Notes / blockers / abandonment reason

Sources: kiro-cli `/context show` ("Context files 0.9% / Tools 0.5% / Kiro responses 0.7% / Your prompts 3.8%", per-file shares), Claude Code `/context` per-row sizes ("The Skills row in `/context` reports the size of the listing after the budget is applied") and `/skill-doctor`. Darwin evidence: `AgentRuntime.contextEstimate()` (`src/agent/runtime.ts:1358–1388`) returns one total; `countConversationTokens` (`src/agent/compact.ts:283`) already calls `model.countTokens(messages, { systemPrompt, toolSpecs })`; `formatContextReport`/`formatContextValue` (`src/tui/context-format.ts`) render one line; `composeSystemPrompt` (`src/agent/instructions.ts:100`) and the later skills/working-context appends hold the sections as strings at composition time; `mcpServerStatuses` (`src/mcp/registry.ts:68–85`) already names each server's tools. The breakdown is an estimate over the *current* request shape, not the anchor measurement — label it so, and keep the anchor-based total as the authoritative line. Do not count on every turn: `countTokens` on Bedrock/Anthropic may reach the provider's counting API.

## SER-078 — Terminal-mediated attention notification: config `terminalNotify` (default `false`) writes one documented OSC notification sequence (OSC 777 `notify` and/or OSC 9; the exact set chosen from terminal documentation and recorded) with a bounded, sanitized title/body (`darwin · <project>` / `waiting for approval` or `turn complete`) at exactly the bell's two driver moments through the same real-stdout seam; TTY only, never headless, never children, never per frame; README states the tmux passthrough and iTerm2 alert-setting requirements

- Status: `not-started`
- Priority: 106
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-08.md`](../research_2026-09-08.md) (run `03:27:54Z`, `peer` path by user override)

### Implementation / acceptance evidence

Not started. Acceptance: `spike/verify-terminal-bell.ts` (or a sibling suite) proving that off performs no write, on writes exactly one sequence per moment, the body sanitizer strips ESC/BEL/`;`/newlines and bounds length, non-TTY stdout writes nothing, headless drivers never import the module; `spike/verify-config.ts` covers the new boolean key; grep proof that one module is the sole writer of the sequence; `pnpm typecheck`, `pnpm test`.

### Notes / blockers / abandonment reason

Sources: Claude Code `preferredNotifChannel` (`"auto"` "sends a desktop notification in iTerm2, Ghostty, and Kitty … reaches your local machine over SSH"; iTerm2 needs "Send escape sequence-generated alerts"; tmux needs passthrough), OpenCode `attention.notifications` ("terminal-mediated desktop notifications only when the terminal is blurred"), WezTerm escape-sequence reference for OSC 9 (`\e]9;%s\e\\`) and OSC 777 (`\e]777;notify;%s;%s\e\\`). Darwin evidence: `src/tui/terminal-bell.ts` (`ringTerminalBell`, one BEL to real stdout, off by default) and `src/tui/terminal-title.ts` (OSC 2) are the seam; `src/tui/App.tsx:1013` is the turn-complete moment and the permission publication moment is beside it. Distinct from the 2026-08-24 gated direction ("Build native cross-platform desktop notifications", Score 4): no platform API, no dependency, no focus detection — the terminal decides whether to show it. Unsupported terminals consume unknown OSC sequences silently; the developer must verify that claim against the sequence set chosen and state it in the module header.

## SER-079 — Permission decision audit in the trajectory: `PermissionGateOptions.onDecision?` publishes one frozen decision per gate outcome (`toolUseId`, `toolName`, `kind`, `risk`, effective `mode`, `source` dispatch id, `outcome` ∈ `write-scope-denied` | `plan-denied` | `deny-rule` | `yolo` | `safe` | `allow-rule` | `classifier` | `user-approved` | `user-denied` | `restart-limit-denied`, matched/granted rule when any, `promptedUser`) — never tool input; the runtime records it as one bounded `permissionDecision` observer record; `trajectory replay` (and therefore `/export`) prints one line only for prompted or denied decisions; `trajectory list` unchanged; never model-visible; headless drivers unchanged

- Status: `not-started`
- Priority: 107
- Score: 9
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-09-08.md`](../research_2026-09-08.md) (run `03:27:54Z`, `peer` path by user override)

### Implementation / acceptance evidence

Not started. Acceptance: `spike/verify-trajectory.ts` extended — one `permissionDecision` record per gate outcome, its `toolUseId` equal to the recorded `beforeToolCallEvent`'s, no input/arguments field, every string under the record field cap, replay prints a line for prompted/denied outcomes only and nothing for silent approvals; the gate suites (`verify-permissions-command.ts`, `verify-workflow-scopes.ts`, `verify-subagents.ts`) unchanged; `src/trajectory/**` still imports no `Agent`/`Model`/gate type (structural no-model-import property); `pnpm typecheck`, `pnpm test`.

### Notes / blockers / abandonment reason

Sources: DeepSeek harness `approval.md` (`approval/asked` → `approval/decided` audit pair, log-only, "deliberately omits tool arguments … through `callId`", per-session policy as a logged event), Codex 0.153.0 "Guardian review history survives compaction, restarts, and user-created forks" (2026-09-07 S2c). Darwin evidence: `RECORDED_EVENT_TYPES` (`src/trajectory/record.ts:56–61`) and the observer records `shellCommand`/`taskNotification`/`contextCompacted` (`:69–78`) — the pattern to follow; `PermissionGateOptions` (`src/agent/permission.ts:239`) has no observer; the stage order at `:470–545` enumerates every outcome the vocabulary names; headless denial goes only to stderr/`permission.denied` (`src/headless.ts:147–152`). Follows SER-076 so `deny-rule` is a real outcome. The record must be composed from a plain frozen object the gate hands out (the gate keeps its `dispatchSource` resolver discipline: the observer learns nothing about the agent), and a throwing observer must never affect the decision.
