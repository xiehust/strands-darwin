# How darwin develops darwin — the iteration log

A human remains the developer of record: they state the requirement, approve the plan, resolve
product or permission decisions, and independently accept the result. The implementation itself
is written by the current darwin running in this repository; once accepted and committed, that
revision becomes the darwin used to write the next one. `AGENTS.md`, the Trellis task records,
and the verification scripts carry constraints and evidence from one generation to the next.

The control loop has evolved along with the product. The first self-development runs piped
scripted input into the plain `dev-repl`. Headless `-p` turns and explicit session continuation
then made that exchange machine-readable; managed background bash jobs and `/tasks` made long
child runs observable without blocking the interactive session. Today the built-in `/developer`
workflow lets an interactive darwin act as the Host for another headless darwin: the Host requests
and reviews a plan, continues the same child session for implementation, monitors it in the
background, and independently inspects the diff and runs acceptance checks. Unresolved product
choices and authorization still go back to the human. In other words, darwin can now operate the
supervision machinery that was once driven by hand, without removing the human decision boundary.

Every entry below is a shipped commit, not a roadmap item, and every implementation was written
and submitted by darwin itself. **Every `/developer` supervision run must append its batch record
here before it reports completion** — the log is part of the paper trail, same as the Trellis
task history.

## Capability milestones (after the v0.0.1 baseline)

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-14 | `848fac1` | Remember permission approvals as constrained wildcard rules |
| 2026-08-14 | `6226ecb` | Add adaptive thinking effort and live `/effort` changes |
| 2026-08-14 | `d3032a3`, `1851492`, `dd1503c` | Add Bedrock Mantle/OpenAI, multiple model configs, and live `/model` switching |
| 2026-08-14 | `780ec93` | Add explicit `/compact` conversation compaction |
| 2026-08-14 | `72320b0` | Support multiline prompt input |
| 2026-08-14 | `476a74f` | Add project-defined slash commands |
| 2026-08-14 | `41ad79a` | Add isolated subagent delegation |
| 2026-08-14 | `ae1689d` | Add project tool-lifecycle hooks |
| 2026-08-14 | `65c22d5` | Add session-owned background bash jobs |
| 2026-08-14 | `18bec63` | Add `/tasks` background-job monitoring |
| 2026-08-14 | `12aa7d8` | Add one-shot headless mode with persistent session continuation |
| 2026-08-14 | `3a189fd` | Add the built-in `/developer` Host-supervisor workflow |

## Supervised iteration batches

Each batch is one `/developer` run: an interactive Host darwin supervising a single persistent
headless child session through planning, per-round implementation, and independent acceptance
(fast suites on every round; pty scenarios and live spikes from the Host where a round warrants
them).

### Batch 1 — TUI interaction and polish (2026-08-15)

Five mandated rounds plus one acceptance-driven fix, all in child session
`session-20260815-070446825`. Host acceptance re-ran the pty scenarios `completion`, `cursor`,
`multiline`, `approve`, `deny`, `bashExit`, `tasks`, and `alwaysAllow` against real model calls;
the one failure found (`alwaysAllow`) predated the batch and became its sixth commit.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `247b6e6` | Show elapsed time on running tool calls |
| 2026-08-15 | `e7f6b00` | Add readline editing chords (Ctrl+A/E/K/U/W) to the prompt |
| 2026-08-15 | `23cae09` | Color notices by severity (error red, degradation yellow) |
| 2026-08-15 | `b75186e` | Collapse failed tool previews from the tail, keep `DENIED:` heads |
| 2026-08-15 | `dae8da7` | Describe built-in commands in the completion menu |
| 2026-08-15 | `e099373` | Fix the stale `alwaysAllow` pty scenario (rules moved to the project-keyed file) |

### Batch 2 — token efficiency, prompt cache, context management (2026-08-15)

Five rounds in the same child session, planned against measured SDK behavior (free heuristic
`countTokens`, per-model context-window table, the vended `ContextOffloader` plugin). Host
acceptance included `verify-prompt-cache-live.ts` both on the default path and with
`contextOffload` enabled. A parallel interactive session landed `a601d8f`
(configurable Bedrock stream idle timeout) in the same tree mid-batch.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `0bdcd3c` | Add `/context`: estimated context tokens and model-window share |
| 2026-08-15 | `6a2a7d2` | Derive cache hit ratio and served-from-cache rows in `/usage` |
| 2026-08-15 | `a2788d0` | Warn once when context crosses `contextWarnRatio` of the window |
| 2026-08-15 | `32d19a1` | Show the per-turn token delta in `/usage` |
| 2026-08-15 | `115e6c0` | Offload oversized tool results behind `contextOffload` (SDK plugin, session-scoped storage) |

### Batch 3 — child spend visibility and offload hardening (2026-08-15)

Three rounds closing the loop the batches themselves exposed: a supervised child's token spend
was invisible to the Host, `maxResultTokens` could crash startup with a raw SDK throw, and
offload storage accumulation was undocumented. The batch-3 report was the first to include the
per-child usage table its own first round made possible.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `f574b81` | Headless runs report token spend as a `usage:` stderr record; `/developer` aggregates it |
| 2026-08-15 | `359465a` | Reject a `maxResultTokens` the offloader cannot accept (measured floor: 1001) |
| 2026-08-15 | `7372216` | State that offload storage accumulates by design; pin reference durability with a test |

### Batch 4 — self-evolution research workflow (2026-08-15)

One planning and one implementation round in child session
`session-20260815-145125890`. The first managed task,
`bg-ec73fd80-194a-4c4d-abd0-0f7d785ec0c8`, failed deterministically before any
model, session, or usage record because the Host accidentally passed an extra `--`.
Planning then succeeded in `bg-674aa247-1395-4bd6-a1ac-807fd94c12e5`, and implementation
succeeded in `bg-efcaecdf-1652-4217-a418-d200b9e84072`.

The implementation delegation prohibited commits, so Host acceptance was completed before the
user's later explicit commit-and-push request. The Host inspected the complete diff, including the
new `SKILL.md`, backlog index, research report template, and Trellis artifacts. Host acceptance
re-ran `verify-skills.ts` (84 passed, 0 failed), `pnpm typecheck`, and `pnpm test` successfully;
the test run emitted the expected MCP `continueOnError` diagnostic for
`DARWIN_DEFINITELY_UNSET` on stderr and still exited 0. `pnpm build` plus the compiled-skill grep
passed, and `npm pack --dry-run --json` contained both the `developer` and
`self-evolution-research` packaged `SKILL.md` assets. Trellis task validation passed with only
the existing max-file-byte truncation warnings for the large SDK contract spec, and
`git diff --check` passed.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `f905229` | Add the built-in self-evolution research workflow, persistent ranked backlog/report contracts, required-built-in verification, and concise product/spec documentation |
| 2026-08-15 | `731003e` | Normalize developer usage into independently costed input, cache-read, cache-write, and output buckets |

### Batch 5 — enforced read-only planning mode (2026-08-15)

SER-001 runs in child session `session-20260815-152031521`. The first managed launch,
`bg-14a78197-3457-4dec-ab4d-3655ea301b79`, was denied by permissions before any model call,
session record, or usage record. The planning task
`bg-6bc36836-0776-42d9-9e55-bbfbe6b940d6` then succeeded. Repository work is tracked in the
single Trellis task `08-15-ser-001-plan-mode`.

The child implemented the Host-approved `plan` permission mode and committed it in
`e2e1463`. The implementation task was
`bg-51a73455-5dc3-48a0-ad8f-3dd25e93b536`. Host acceptance inspected the complete commit/diff
and independently re-ran `pnpm typecheck`, `pnpm test` (exit 0 with the expected MCP
`continueOnError` diagnostic), the network-free `verify-tui.ts plan` scenario (4 passed), Trellis
task validation, `git diff --check`, and clean-tree verification successfully.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `e2e1463` | Enforce read-only `plan` mode across config/CLI, hooks, parent/child interventions, TUI/headless diagnostics, and focused acceptance |

### Batch 6 — parallel, inspectable subagents (2026-08-15)

SER-002 runs in child session `session-20260815-155540093`; planning ran as
`bg-d6b5e653-bd0a-4d32-8d64-23258f2b2239`. Unlike Batch 5 the implementation was carried out
directly in that same conversation as the Host's implementation worker, so there is no separate
implementation task id. Repository work is tracked in the single Trellis task
`08-15-parallel-subagents`.

Planning began by measuring the SDK instead of assuming it, which changed the shape of the whole
iteration: `@strands-agents/sdk@1.12.0` defaults `toolExecutor` to `ConcurrentToolExecutor`, so
two dispatches in one assistant message already overlap (303 ms for two 300 ms children, both
starting at +2 ms), while hook callbacks — and therefore permission prompts — are serialized by
the single stream loop. Concurrency therefore needed a regression test and a written contract,
not new machinery; the real work was making concurrent delegation *legible*: a required
`AssessedPermissionRequest.source`, a `[parent]` / `[<agent>#<dispatch>]` label riding the
existing prompt line, a dispatch registry with `/agents` plus terminal notices, and an explicit
read-heavy-only limitation on concurrent writes.

Local validation for this batch: `pnpm typecheck`; `pnpm test` (exit 0 with the expected MCP
`continueOnError` diagnostic, including `verify-subagents.ts` 66 passed and the new
`verify-subagent-format.ts` 40 passed); the new network-free `verify-tui.ts agents` (6 passed);
`verify-tui.ts completion` (20 passed); and the model-calling `verify-tui.ts approve` (23 passed),
`cancelThenContinue` (5 passed) and `bashExit` (3 passed).

Host acceptance inspected the complete commit `404aa1c` — all 27 files, and the production diff in
full — then re-ran independently: `pnpm typecheck`; `pnpm test` (24 suites, 0 FAIL, exit 0);
`verify-subagents.ts` under a private HOME (66 passed, printing the measured two-dispatch overlap
and the resolved `parent` / `general#suba` / `explorer#subb` sources); `verify-tui.ts agents`
(6 passed) and `completion` (20 passed) with no model calls; and the model-calling
`verify-tui.ts approve` (23 passed, including *prompt says which agent asked* and *the source label
did not push the box off the frame*), `cancelThenContinue` (5 passed) and `bashExit` (3 passed).
Trellis task validation passed with only the known >32 KB truncation warning for the large SDK
spec, `git diff --check` was clean, and the child left the tree free of its `/tmp` probes and of
any edit to the Host-owned research files.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `404aa1c` | Attribute every permission request to its originating agent, add `/agents` dispatch observability, and pin measured subagent concurrency |

### Batch 7 — append-only session trajectories (2026-08-16)

SER-003 runs in child session `session-20260816-024553753`: planning as
`bg-a832b48a-b6ac-4882-a2ca-3212d5a60dc0`, implementation and commit as
`bg-7a24a529-fc26-4211-8740-dd7da07a4398`, both turns in that one persisted conversation.
Repository work is tracked in the single Trellis task `08-16-session-trajectory`.

The direction came from DeepSeek Harness's append-only event stream: one record is what makes
trajectory inspection, search, fork and replay possible at all. Darwin already persisted
snapshots, but a snapshot is rewritten every turn and says what a conversation *is*, never what
it *did* — a tool call later compacted away left no trace anywhere. The record is therefore an
observer and nothing more: `recordStream` sits between `agent.stream()` and the `yield`, records
synchronously without I/O, and cannot throw, so it can neither reorder an event nor become a
second reason a turn dies; a write failure latches, stops recording, and surfaces one notice.
Bytes already on disk are never rewritten, three caps bound the file, and every truncation is
written down so "this is all there was" can never be mistaken for "this was cut". Replay feeds
the same `turnReducer` the live frame uses and constructs no `Agent` and no `Model` at all —
offline is a property of the module graph, asserted structurally rather than promised.

Planning measured the SDK rather than assuming it, and three findings changed the
implementation: stream events' `toJSON()` emits the **wire** shape, so a first draft's reasoning
strip matching `type === 'reasoningBlock'` never fired and reasoning text would have reached
disk (replay now rehydrates through the SDK's own `contentBlockFromData`); a turn appends in one
write, so batch-time timestamps made every record of a turn share one instant, and records are
now stamped when observed; and `AgentResult.toString()` already carries a child's reasoning into
parent context, which predates this change, is not fixable by filtering the record, and is now
documented as an SDK gotcha instead of being papered over. Four planned assertions were
strengthened rather than kept, including two that were tautologies as written.

Host acceptance inspected the commit `af791f9` in full (36 files) and independently re-ran:
`pnpm typecheck`; `pnpm test` (26 suites, 0 `FAIL`, exit 0, including the new
`verify-trajectory.ts` at 148 passed); `verify-trajectory.ts` standalone (148 passed);
`verify-tui.ts completion` (25 passed, network-free); and the model-calling `verify-tui.ts
approve` (23 passed) because `MAX_COMPLETIONS` and `App.tsx` changed. Trellis validation passed
with only the known >32 KB truncation warning for the large SDK spec, and `git diff --check` was
clean. Beyond the named checks the Host ran a live end-to-end in a scratch git repository with
real Bedrock turns: turn 1 recorded 8 records / 2,501 bytes; turn 2 grew the file to 3,892 with
the first 2,501 bytes byte-identical and `seq` 0–12 strictly increasing; `trajectory replay`
reproduced both turns with `AWS_REGION` unset and bogus credentials; `search` printed 4 hits and
`no matches`, both exit 0; `fork` produced a new session while the source trajectory, source
snapshot and `last-session.json` stayed byte-identical, and the fork then answered a follow-up
from its own inherited memory; and `trajectory: false` wrote no file at all, with
`trajectory list` reporting `no trajectory recorded (snapshot only)`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-16 | `af791f9` | Record an append-only trajectory of every turn and add `darwin trajectory list/search/replay/fork` plus `/trajectory` |

### Batch 8 — a failed turn says so in the record (2026-08-16)

The direction came from this repository, not from a peer product: the research run rolled the
12.5% observability self-review path and found that the artifact Batch 7 had just built could not
answer the question it exists for. A turn whose model stream threw still closed with a `turnEnded`
line — `recordStream`'s `finally` guaranteed that much — but `stopReason` is assigned only from
`agentResultEvent`, which a thrown turn never emits, so the record showed `stopReason: undefined`
and carried no error at all. On disk a failed turn was indistinguishable from a cancelled one and
from a clean turn with a missing stop reason, and the provider's message existed only as an
ephemeral TUI notice or a stderr line.

The fix stayed inside the observer contract that made Batch 7 safe. `recordStream` gained a
`catch` that reads two strings off the error and **rethrows the identical object**, so the caller
of `AgentRuntime.send` cannot tell recording exists; `catch` runs before the existing `finally`,
so the closing line carries the failure. `turnEnded` gained one optional `failure` field, with no
`SCHEMA_VERSION` bump because `parseRecordLine` is documented to tolerate extra fields, and no
invented `'failed'` stop reason, because no provider produced one. One shared helper
(`turnOutcome`) is the single reading of failed / cancelled / clean / abandoned, so `list`,
`replay` and the tests cannot drift into three answers, and `replay` reconstructs the exact live
`turn failed:` notice rather than growing a second projection. Nothing under `src/tui/` changed,
so the frame-height contract is untouched.

Measurement changed the design once, as it did in Batch 7: the child probed the SDK and found
`Model.streamAggregated` rethrows a `ModelError` untouched but wraps anything else in
`new ModelError(message, { cause })`, so *every* real provider rejection would have recorded as an
indistinguishable `ModelError`. An additive, capped `failure.cause` keeps the provider's class —
confirmed live as `ModelError` + `cause: AccessDeniedException`.

Host acceptance read the whole diff (16 files) and independently re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (26 suites, all `passed, 0 failed`, exit 0, no `FAIL`); `spike/verify-trajectory.ts`
standalone (**203 passed**, up from 148); `spike/verify-tui.ts completion` (25 passed, network-free);
`git diff --check` clean; Trellis validation `✓`. Then a live end-to-end of its own in a throwaway
HOME: one clean Bedrock turn, then a second turn in the same session against a well-formed but
invalid `AWS_BEARER_TOKEN_BEDROCK`, which failed for real (`exit 1`,
`error: Authentication failed: Please make sure your API Key is valid.`). The recorded lines show
`stopReason: "endTurn"` with no failure for turn one and, for the failed turn, no `stopReason` plus
`failure: {name: "ModelError", message: "Authentication failed…", cause: "AccessDeniedException"}`;
the file's first 1,375 bytes hashed identically before and after the failing append
(`e381f6f9…`); `trajectory list`, `replay`, `search AccessDeniedException` (1 match) and a search
miss all exited 0 and named the failure. The Host also checked the bound it had demanded directly:
a 9,000-code-point class name plus a 9,000-code-point message renders to exactly 120 code points
with no newline, so a hostile provider string cannot widen a summary row.

One pre-existing oddity surfaced and was deliberately left alone: turn ordinals restart at 1 in
each process, so a two-run session reports `1 turn(s)` and both turns say `turn 1`. It predates
this change (`TrajectoryRecorder.turns` starts at 0 per run), contradicts the spec's "within this
file" wording, and fixing it would rewrite existing record semantics — recorded here for a later
direction rather than smuggled into this one.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-16 | `1f2c147` | Record why a turn ended abnormally: a failed turn's error, class and cause in `turnEnded`, reported by `trajectory list`/`replay`/`search` |
