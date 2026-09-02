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

### Batch 9 — every turn records what it cost (2026-08-16)

Same observability research run as Batch 8, next direction. A session's spend existed only in
memory: `AgentRuntime.usage` reads the SDK meter and its own comment says "Counts this process
only. Sessions persist messages, not metrics", so `/usage` and the headless `usage:` line
evaporated on exit and a resumed session's meter restarted at zero — which is why the spend figures
in this very log had to be scraped from child stderr.

Planning corrected the research report rather than inheriting it, and the correction shaped the
design. Token counts *were* already reaching disk, but not the ones anybody wanted:
`Message.toJSON()` keeps `metadata`, so a recorded `agentResultEvent` carries
`result.lastMessage.metadata.usage` — the provider's counters for the **final model call** of the
turn — while `AgentResult.toJSON()` deliberately drops `metrics`. A multi-cycle turn's earlier
calls, and every failed or cancelled turn, had nothing. The new field is therefore called `spend`,
not `usage`: two different numbers under one name in one file would have been worse than none.

The ordering was the real problem. `recordStream`'s `finally` closes and buffers `turnEnded`
*before* `send`'s `finally` computes its usage delta, so the number that exists at the end of a
turn is always one step too late for the record. The chosen mechanism is a non-throwing meter
injected into `beginTurn` and read while the closing record is composed — the `dispatchSource`
precedent from Batch 6, and it keeps the write off `send`'s error path, where a throw would replace
the provider's exception with the recorder's and break Batch 8's identical-object guarantee. One
`before` snapshot feeds both the meter and `lastTurnDelta`, so the record and `/usage` cannot
become two readings of one turn.

The honesty rules are the point of the feature. An unreported metric is an **absent key**, never
`0`, end to end from record to rendered report — because OpenAI Responses genuinely cannot split
uncached input when a cache subset is missing, and "nobody measured" must not read as "free". A
present `0` stays a distinct, real measurement. Provider and model are stamped on the same line as
the numbers, so a total can never silently mix two price lists, and `/model` cannot land mid-turn
anyway (it sits behind the busy check). Two limitations are written into the spec instead of hidden:
`spend` is what the SDK meter attributed to a turn, not what the provider billed — summarization
calls `model.streamAggregated` directly and is invisible to the meter — and turn ordinals still
restart per process, so the aggregate counts `turnEnded` records rather than ordinals.

Host acceptance read the diff (16 files, `runtime.ts`, `usage.ts`, `writer.ts`, `record.ts`,
`replay.ts`, `cli-trajectory.ts` in full) and re-ran: `pnpm typecheck` (exit 0); `pnpm test` (26
suites, all `passed, 0 failed`, exit 0, no `FAIL`); `spike/verify-trajectory.ts` (**257 passed**, up
from 203); `spike/verify-tui.ts completion` (25 passed); `git diff --check` clean; Trellis validation
`✓`. Then its own live reconciliation in a throwaway HOME: three turns in one session, each its own
process, each turn's recorded `spend` equal **field for field** to that process's `usage:` stderr
line — `input=2 output=3 cacheRead=0 cacheWrite=10379`, then `input=2 output=3 cacheRead=1460
cacheWrite=3592`, then a real provider rejection recording `input=0 output=0` with **no cache keys
at all** beside its `failure`, exactly where stderr printed `cacheRead=- cacheWrite=-`. The file's
first 1,497 bytes hashed identically (`d3637ad3…`) after both later appends. With credentials
removed, EC2 metadata disabled and the endpoint pointed at a dead socket, `list` and `replay` both
exited 0 and totalled `input=4 output=6 cacheRead=1460(+1 unreported) cacheWrite=13971(+1
unreported)`. And two real pre-spend sessions written earlier the same day report `spend: unknown`
and `turn 1 spend: unknown (not recorded)` — not a fabricated zero.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-16 | `e4033ef` | Record each turn's token spend and its provider/model in the trajectory, and report session totals from `trajectory list`/`replay` |
| 2026-08-16 | `ffba24e` | Pin the unsplittable-input case: an unreported cache subset leaves input unknown, never zero |

### Batch 10 — the diagnostics darwin was throwing away (2026-08-16)

Third and last direction of the observability research run. `routeSdkLogs` routed the SDK's
`warn`/`error` to the renderer — deliberately, since the SDK's default `console.warn` tears the Ink
frame — but wired `debug` and `info` to `() => {}` with no way to route them anywhere. The SDK says
some things *only* at `debug`: that a request was throttled, where it placed its cache points, that
native token counting fell back to estimation. So a session that was slow because the provider
throttled it left no evidence at all, and darwin's own notices lived in Ink's scrollback and died
with the frame.

`diagnostics: true` now appends all four SDK levels plus every darwin notice, with its severity, to
a per-session `diagnostics.log` beside the record — one timestamped, whitespace-collapsed line each,
built for `tail -f`. `warn`/`error` reach the renderer *and* the file, so one file holds the whole
story instead of the half nobody was shown.

Three decisions carry the safety case. **Off is indistinguishable from before the feature existed**:
with no tap installed the SDK's `debug`/`info` are the *literal* no-ops it ships, not closures that
test a flag at 60 call sites; no log is built, no line is formatted, and the TUI gets the reducer's
dispatch back unwrapped rather than a wrapper — which is also why not one of the ~50 notice sites
changed. It is **off by default** because these lines interpolate provider payloads and can carry
conversation-derived material, the same reason `contextOffload` defaults off. And it is an
**observer** under the trajectory's rules, with one bound the trajectory never needed: `logger.debug`
is called synchronously from inside the SDK's stream loop, so lines stay queued while an append is in
flight and are dropped past a pending-bytes bound — dropping a *diagnostic* is acceptable and is
counted and written down in the file, while delaying or dropping an *event* is not. Discoverability
is a transcript notice and a headless stderr record, never a header row, because the frame-height
contract has no spare line.

Two measurements changed the implementation, both reported rather than smoothed over. A first
`flush()` copied from the trajectory writer drained on every arrival and dropped **0 of 200** lines
at a 400-byte bound — the growth had simply moved into a queue of pending batches — so the bound is
now gated on an in-flight flag (**197 of 200** dropped). And checking the file bound *after* writing
let a 600-byte budget write 42 lines, because one append carries a whole burst; the batch is now
trimmed to what fits, so only the stop marker overshoots.

Host acceptance was run in a **separate git worktree** at the child's commit, because an unrelated
external commit and three uncommitted edits appeared in the main tree during the run (see below) and
a check must not be contaminated by work under review. In that clean worktree: `pnpm typecheck`
(exit 0); `pnpm test` (**27** suites, all `passed, 0 failed`, exit 0, no `FAIL`);
`spike/verify-diagnostics.ts` (70 passed); `spike/verify-config.ts` (199 passed, up from 190);
`spike/verify-tui.ts approve` against real model calls (23 passed — no frame row added on its 50-row
terminal); `completion` (25 passed); `git show --check` on the commit clean. Then four live cases of
its own against real Bedrock in a throwaway HOME: with the field absent, a real turn left **only**
`trajectory.jsonl` and `snapshot_latest.json` in the session directory and printed no `diagnostics:`
record; with it on, a turn that ran a bash tool call produced an 11-line file holding the SDK's own
`added cache point to last user message`, `event=<beforeToolCall> | dispatching to 1 handler(s)`,
`handler=<darwin:permission-gate> … returned proceed` and `auto-detected includeToolResultStatus`
beside timestamped `darwin info` notices; `"diagnostics": "yes"` refused to start with
`"diagnostics" must be true or false.`; a directory placed where the file belongs left the turn
succeeding and produced one bounded `EISDIR` degradation record without overwriting the directory;
and a file pre-filled to 8,388,300 bytes stopped at the real 8 MiB constant with
`diagnostics stopped: reached the 8388608-byte per-session budget (nothing after this line was
written)` as its literal last line.

Two anomalies are recorded because they are part of this batch's history, not the child's work:
commit `0e6f08c` ("add project skills and tasks records", 65 files) appeared mid-run, un-ignoring and
committing `.darwin/**` project skills, agents, commands and hooks — not written by the child, whose
commits follow the project convention and which correctly excluded those files from its own commit;
and three files (`spike/verify-skills.ts` and the `self-evolution-research` skill's `SKILL.md` and
`roll-research-path.mjs`, which rebalances the research-path weights) were left modified in the
working tree by that same external activity. Neither touches the diagnostics change; both are why
acceptance moved to a worktree.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-16 | `aa2b7b7` | Opt-in per-session `diagnostics.log`: the SDK's `debug`/`info` and every darwin notice, bounded, off by default |

### Batch 11 — permission decisions stay reachable (2026-08-16)

First direction of the TUI self-review batch. Permission details were clipped by source newlines only, so a minified command or replacement could wrap through the live 50-row frame and push the decision controls off screen. The implementation adds presentation-only, marker-inclusive bounds: one line / 160 Unicode code points for summaries and 14 lines / 500 code points for each detail. Short values, including empty and whitespace-only values, remain textually unchanged; raw tool input and permission decisions are untouched.

The pty driver now exposes the latest standard Ink repaint separately from accumulated output, so a safety assertion cannot pass because `allow?` appeared in one old frame while the content appeared in another. The real approval scenario uses an oversized path and replacement, proves the settled 120×50 frame contains provenance, bounded summary/detail, explicit omission markers, y/n and both allow-rule options, then approves and verifies the exact untruncated replacement reached disk.

Child session: `session-20260816-144438648`. Managed tasks: planning `bg-b6de3748-3d35-4ab0-a462-8ec4ab3d8d02` (succeeded), implementation `bg-84997c6a-1edc-4d2b-a589-9aa67167eef6` (succeeded). Token spend: planning `input=22 output=18,419 cacheRead=1,074,849 cacheWrite=172,482`; implementation `input=166 output=22,555 cacheRead=17,238,045 cacheWrite=252,129`; total `input=188 output=40,974 cacheRead=18,312,894 cacheWrite=424,611`.

Host acceptance read the full 13-file commit, confirmed no `docs/research/**` or iteration-log edits came from the child, and re-ran: `pnpm typecheck`; `pnpm test` (29 suites / 1,544 assertions); `spike/verify-permission-presentation.ts` (23 passed); the real Bedrock `spike/verify-tui.ts approve` scenario (21 passed); `git show --check`; Trellis validation; and clean-tree verification. All passed. The only validation warnings state that the append-only research report exceeds Trellis's context-injection cap and will be truncated when injected.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-16 | `0b3822a` | Bound permission summaries/details and prove the complete approval row stays reachable in the settled 120×50 frame |

### Batch 12 — the busy editor no longer looks disabled (2026-08-16)

Second and final direction of the TUI self-review batch. `App` already accepted typing while a model streamed, answered local reports before its busy guard, and retained rather than queued an agent-bound draft. `InputBox` nevertheless hid the terminal cursor, dimmed the text, and advertised disabled semantics. The change separates editability from agent availability: streaming keeps the editor visually and semantically active, while Enter still reaches the existing `still working` refusal and never creates a queue. Permission prompts still own keyboard/paste, and compaction now owns a genuinely non-editable editor rather than merely looking disabled.

The pty driver reads Ink's latest DEC cursor show/hide state, so the streaming test proves an actual visible terminal cursor. The live usage scenario edits at a moved cursor, runs `/usage`, verifies exact draft retention after a refused Enter, waits through a quiet idle interval to disprove auto-send, then explicitly starts and completes the retained second turn. The approval scenario proves permission-time keyboard/paste cannot alter a hidden draft, and a new compacting scenario proves both input channels are ignored until compaction finishes.

Child session: `session-20260816-150446850`. Managed tasks: planning `bg-cf3ae450-2e20-41dc-9e12-673c2598f8f6` (succeeded); implementation `bg-0bd145f5-e6ba-4664-9956-f412d4962d71` (succeeded); correction `bg-7b39a8dc-0d4f-485f-a81e-9ba30048e144` (transient provider failure after writing the correction, automatically retried); retry `bg-ffadbee3-5679-423d-90de-f4ca6611e021` (succeeded). Token spend: planning `input=56 output=20,913 cacheRead=2,053,171 cacheWrite=130,902`; implementation `input=168 output=22,188 cacheRead=13,402,169 cacheWrite=202,714`; failed correction `input=44 output=2,964 cacheRead=4,543,647 cacheWrite=7,644`; retry `input=80 output=6,813 cacheRead=8,768,123 cacheWrite=14,013`; total `input=348 output=52,878 cacheRead=28,767,110 cacheWrite=355,273`.

Host acceptance first exposed a real pty race: terminals may deliver `\rslash-delta` as one event, but the handler recognized only trailing terminators, so a continuation backslash survived. The focused correction recognizes leading or trailing batched Enter and deterministically tests that shape. Final Host checks: `pnpm typecheck`; `pnpm test` (29 suites / 1,544 assertions); prompt-editor (28); compact (13); cursor (5); multiline three consecutive times (9 each); chunkedEnter (4); completion (25); real Bedrock usage (20); real Bedrock approve (23 on a clean rerun after one unrelated model-output deviation); real Bedrock compacting (5); Trellis validation; `git show --check` for both commits; `git diff --check`; and clean-tree verification. All accepted.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-16 | `b11c281` | Keep the streaming prompt visibly editable while retaining the no-queue busy guard and permission/compaction ownership |
| 2026-08-16 | `81e5897` | Handle leading batched Enter so continuation syntax remains correct under real pty event coalescing |

### Batch 13 — structured headless output (2026-08-17)

SER-011 runs in child session `session-20260817-011454108`. The Host's first planning launch,
`bg-5927f1f9-1bdf-47b7-8bc0-11ca426a87a5`, failed deterministically before any session, model call
or usage record because it passed an extra `--`. Planning then succeeded in
`bg-1469d76f-3003-4935-8e70-2b4dbbe7c790`; implementation and the feature commit ran in
`bg-47edad5c-778c-41b0-b263-efa8c5f3e12d`; the Host's acceptance-driven path correction ran in
`bg-62b735bb-87de-4986-b287-67322e70c6f8`. Repository work is tracked in
`08-17-structured-headless-output`.

The delivered `--output-format json|stream-json` protocols are explicit version-1 projections over
the existing one-shot runtime. Final JSON writes one terminal document; JSONL emits monotonic
session/run/turn, completed post-redaction assistant-message, permission, tool and diagnostic
records before one authoritative terminal result. Durable success still means the turn, strict
runtime cleanup and resume-pointer write all succeeded. Unknown usage stays absent rather than
becoming zero. The projector never serializes raw SDK events, model reasoning, signatures,
redacted content, tool payloads, metrics, traces or live agent state. V1 deliberately does not
stream token deltas: provider guardrails can expose blocked output before aggregation, so public
assistant text starts at the SDK's completed post-redaction message boundary. The established text
stdout/stderr protocol remains the byte-compatible default.

The implementation worker ran exactly two authorized low-token live Bedrock calls in disposable
HOME/project state with Haiku 4.5, low effort, 128 max tokens and prompt caching disabled. JSON
exited 0 with empty stderr and one sequence-1 success containing `OK`; stream-json exited 0 with
empty stderr and five parseable records, sequences 1–5, one session id and one terminal success
containing `STREAM-OK`. The Host confirmed those commands and result fields in the append-only child
trajectory rather than accepting the summary alone.

Host acceptance read the implementation diff and found one blocker before accepting it:
`process.cwd()` had moved from `src/cli.ts` into the extracted runner, violating the repository's
explicit path boundary. The child corrected this in the same session: the entry point now passes an
explicit `projectRoot`, the runner forwards exactly that value, and the fixture rejects a mismatch.
The Host then independently re-ran `pnpm typecheck`; all 30 fast suites; focused headless (68
passed), structured headless (8), trajectory (257) and max-token recovery (20); `pnpm build`;
Trellis validation (only the known large SDK-spec injection warnings); `git diff --check`;
`git show --check` for both commits; the explicit cwd-location check; Host-owned-path checks; and
clean-tree verification. All passed.

Token spend: planning `input=66 output=86,605 cacheRead=5,691,673 cacheWrite=335,535`;
implementation `input=338 output=53,844 cacheRead=66,285,504 cacheWrite=476,107`; correction
`input=46 output=4,767 cacheRead=11,375,021 cacheWrite=45,234`; aggregate `input=450
output=145,216 cacheRead=83,352,198 cacheWrite=856,876`. The failed first launch emitted no usage
line and spent no recorded model tokens.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-17 | `58a20b5` | Add versioned final JSON and safe live JSONL one-shot output while preserving the text protocol and durability gates |
| 2026-08-17 | `ebd4796` | Keep project-root resolution in the CLI entry and pin explicit propagation to runtime construction |

### Batch 14 — official SDK Agent Skills (2026-08-17)

SER-012 ran in child session `session-20260817-025133040`. Planning ran as
`bg-5f05811b-72e5-4ac7-a7e8-33a62fc7bd50`; implementation and the authorized single low-token
live skills smoke ran as `bg-2f26ad22-052f-4310-8a9a-db49cf76abef`. Host acceptance then drove five
offline correction turns in the same persisted conversation:
`bg-e7db77f6-3eb2-4071-8d69-6bb8c787938b`,
`bg-b312cbc0-248c-4796-808a-09e478b94b1e`,
`bg-65e0a01a-a9f2-482e-9541-6d37daa16e64`,
`bg-9fc7b60a-f7d6-413d-bdb7-615d0c69ffb6`, and
`bg-2f789754-82a5-48f0-94c9-0859e7cb80af`. All seven managed tasks succeeded. Repository work is
recorded in the archived Trellis task `08-17-official-sdk-agent-skills`.

The migration adopts SDK 1.12.0 `AgentSkills` and `Skill` while retaining one safe model-facing
`load_skill({name})` compatibility tool and Darwin's required-built-in, project-over-global and
slash-command policy. Host review rejected broad legacy-prompt regexes, preflight-only filesystem
validation, opening-tag boundary guesses and cached ambiguity fallback. The accepted shape now
recognizes only the exact historical catalogue/context suffix, preserves project bytes, refuses
ambiguous cached and uncached prompts unchanged, and guards SDK resource listing both before and at
traversal time. SDK 1.12.0 has no public identity-preserving sandbox override, so the Agent proxy
residual is documented honestly: Skill-instance activation falls back to the same base catalogue
while forwarded `appState` remains on the original Agent.

Final Host acceptance inspected the correction diffs and independently re-ran: the focused real
Agent/SessionManager skills suite (69 passed); adversarial cached and uncached ambiguity probes;
`pnpm typecheck`; `pnpm test` (31 suite summaries, all zero failures); `pnpm build` plus both bundled
skill assets; the free completion pty scenario (25 passed); archived Trellis validation (only the
known large-spec injection warnings); `git diff --check`; protected-history/research hashes; and
`git show --check` for every accepted commit. No additional live, network, provider or real-model
call was made during correction or final Host acceptance. A final auxiliary read-only review request
was blocked by the platform's safety filter, so it was not counted as acceptance evidence.

Token spend by managed task: planning `input=118 output=110,844 cacheRead=13,847,269
cacheWrite=319,179`; implementation `input=486 output=77,624 cacheRead=107,681,522
cacheWrite=538,899`; first correction `input=464 output=64,382 cacheRead=147,111,386
cacheWrite=695,883`; project-instruction correction `input=114 output=19,230 cacheRead=40,967,737
cacheWrite=36,676`; traversal-time correction `input=98 output=9,106 cacheRead=36,702,015
cacheWrite=28,753`; historical-boundary correction `input=88 output=12,145 cacheRead=34,112,345
cacheWrite=23,155`; cached-ambiguity correction `input=44 output=3,111 cacheRead=17,397,285
cacheWrite=10,562`. Aggregate: `input=1,412 output=296,442 cacheRead=397,819,559
cacheWrite=1,653,107`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-17 | `53105b0` | Replace Darwin's custom skills core with the official SDK plugin behind one compatible `load_skill` tool |
| 2026-08-17 | `02dbcb2` | Archive the completed official-Agent-Skills Trellis task |
| 2026-08-17 | `6fc919a` | Close offline-model, legacy-resume, resource, cache-shape and startup-unwind gaps found by Host acceptance |
| 2026-08-17 | `906c400` | Preserve complete project instructions during cached and uncached legacy catalogue migration |
| 2026-08-17 | `06ef164` | Enforce symlink and outside-root resource safety at official traversal time, including post-preflight swaps |
| 2026-08-17 | `16cee9a` | Recognize exact historical prompt boundaries and refuse ambiguous legacy suffixes |
| 2026-08-17 | `d5b0d68` | Refuse cached legacy ambiguity before the generic known-block parser can retain stale content |

### Batch — `/clear`: leave a session without losing it (2026-08-17)

One managed child task in child session `session-20260817-152525893` (`bg-11f24340`, exit 0), run
`--yolo --context-offload` with no model-call ceiling. The user fixed both product decisions up
front: `/clear` does reset the visible screen, and the session being left stays fully on disk and
resumable by id. No correction turn was needed — Host acceptance passed on the first pass.

The accepted shape builds a *successor* `AgentRuntime` through the same `create()` factory rather
than swapping a `SessionManager`: SDK session identity is fixed at construction (snapshot hooks are
registered in `initialize()` with no removal path), so a swap would let the retired manager overwrite
the previous session's `snapshot_latest.json` with the cleared conversation — destroying the one
thing the command exists to protect. Process-scoped resources (live `AppConfig`, connected MCP
clients, the background-job manager) are handed over; everything session-scoped is rebuilt, which is
why the header, `/usage`, `/context` and `/trajectory` cannot report the old session's numbers
afterwards. The resume pointer deliberately does not move: an empty session has no snapshot, so the
successor claims it on its first finished turn. The one-shot `clearTerminal` is paired with a
`<Static>` remount, without which Ink replays the cleared transcript from `fullStaticOutput` at the
next whole-screen redraw.

Host acceptance independently inspected the full commit diff and re-ran: `pnpm typecheck` (exit 0);
`pnpm tsx spike/verify-clear-session.ts` (33 passed, 0 failed); `pnpm tsx spike/verify-tui.ts clear`
(19 passed, 0 failed, no model call); `pnpm tsx spike/verify-tui.ts completion` (28 passed, all ten
built-ins listed); and `pnpm test` (exit 0, 1846 assertions, 0 failed, new suite registered).
Working tree clean. No live, network or provider call was made during Host acceptance.

Token spend, single managed task: `input=402 output=105,181 cacheRead=33,817,168 cacheWrite=285,224`
— also the batch aggregate.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-17 | `d4a32d1` | Add `/clear`: start a new session mid-run, leaving the previous one saved and resumable |

### Batch 16 — the permission mode becomes live session state (2026-08-18)

One managed child task in child session `session-20260818-012951871`
(`bg-0f0062ef-94aa-4a92-9508-c7153cb9bf4d`, exit 0), run `--yolo --context-offload` with no
model-call ceiling. Host acceptance passed on the first pass — no correction turn was needed. This
is `SER-013`, the first direction of the batch from
[`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md) (rolled `peer` path):
Claude Code (`Shift+Tab` + mode indicator), Codex (`/permissions`, `/status`) and OpenCode
(command-palette auto-approve toggle + muted indicator) all treat the approval policy as live
session state, while Darwin fixed it at `Agent` construction and its own plan denial could only be
obeyed by killing the process.

The accepted shape moves the mode out of `PermissionGateOptions` and into the gate as live state
(`PermissionGate.mode` / `setMode`), so the one instance the parent and every child share answers
for all of them with no extra plumbing, and `AgentRuntime.changePermissionMode` stays *synchronous*
— the new policy has to be in force before the very next gate decision, and there is nothing to
await. Nothing is persisted, deliberately unlike `/effort` and `/model`: this changes *enforcement*,
and a widening that outlived the process is exactly what the allow-rule exemptions exist to prevent.
`/clear` now carries the *live* mode into its successor rather than restoring a possibly wider
startup policy. The in-flight rule is one rule for every transition instead of a table of benign
ones: `beforeToolCall` became a bounded re-decision loop (`MAX_MODE_CHANGE_RESTARTS = 16`, then a
fail-closed deny that says why) around a single-pass `decideOnce`, everything awaited goes through
`raceWithdrawal`, which re-checks `aborted` **after** the promise settles — so a verdict that lands
in the same tick as the switch is discarded too — and `AssessedPermissionRequest.withdrawn` lets the
Ink `PermissionQueue` drop a question asked under a policy no longer in force, wherever it sits in
the queue. `MAX_COMPLETIONS` went 10 → 11 because a built-in nobody can see is a built-in nobody
uses.

Host acceptance independently read the full 23-file diff (both commits), then re-ran: `pnpm
typecheck` (exit 0); `pnpm test` (exit 0, 37 suite summaries, all `0 failed`, no `FAIL`); the new
`spike/verify-permission-mode-switch.ts` (100 passed) plus `verify-permission-modes` (101),
`verify-tool-hooks` (44), `verify-subagents` (68), `verify-config` (205), `verify-headless` (80),
`verify-prompt-editor` (28), `verify-clear-session` (37); the free pty scenarios `mode` (25),
`completion` (29, `/mode` visible by name and description), `clear` (19) and `plan` (4); `git diff
--check`, `git show --check` on both commits, Trellis validation (only the pre-existing >32 KB spec
injection warnings) and a clean tree. The required live `verify-tui.ts approve` (real Bedrock,
120×50) passed 23/23 on **6 of 7** Host runs; the one failure asserted 23/23 and then timed out
waiting for exit because the model volunteered an extra exploratory `bash ls`, whose permission box
swallows `/exit`. The Host did not take that on trust: a separate worktree at the pre-change commit
`31a5880` failed **identically** on 1 of 5 runs, so the flake is pre-existing model nondeterminism,
not a regression — and it was left alone rather than "fixed" by rewriting a required acceptance
check under the feature it guards. The Host also ran its own live-free end-to-end in a throwaway
`HOME`: `default → plan → yolo → bogus → default` each reported with the previous mode named, the
invalid argument changing nothing and listing the valid modes, `config.json` byte-identical by
sha256 before and after (`b66e97e6…`), and a fresh process starting from the configured policy
again.

Token spend, single managed task: `input=324 output=100,605 cacheRead=24,886,871 cacheWrite=251,526`
— also the batch aggregate so far.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `ff0a9f5` | Switch the approval mode inside a running session, user-only and session-scoped, withdrawing any decision the old mode was still holding |
| 2026-08-18 | `eeb32a2` | Record the live approval-mode contract in the SDK-contracts, live-frame and architecture docs |

### Batch 17 — `@` completes workspace paths, and only paths (2026-08-18)

One managed child task in child session `session-20260818-022510423`
(`bg-4c6db950-a46e-4cd4-9085-386dfa17931b`, exit 0), run `--yolo --context-offload` with no
model-call ceiling, launched from repository source at `9e00301` — the revision the previous
direction produced. Host acceptance passed on the first pass. This is `SER-014`, the second
direction of the `peer`-path batch in
[`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md).

Claude Code, Codex and OpenCode all offer `@` in the composer and disagree about what follows:
Codex inserts the path, OpenCode inlines the file's bytes. Darwin takes the Codex shape
deliberately, and that is the whole product argument of this direction — inserting *text* keeps

every byte of file content flowing through the gated, classified, trajectory-recorded `fileEditor`
read, while inlining would be a second ungated route into the model's context. So `src/tui/path-completion.ts`
opens no file at all: it reads directory entries (`opendir`/dirent/`realpath`) and nothing else.

The accepted shape splits pure from asynchronous the way `computeCompletions` already is:
`pathCompletionQuery` (trigger), `matchWorkspacePaths` (two-tier prefix match, never fuzzy) and
`applyPathCompletion` (string → string) are per-keystroke and pure, while `scanWorkspacePaths` is
bounded (8000 entries, 8 levels, 4000 candidates, 21 excluded directory names), breadth-first,
never-throwing, and cached behind a 5 s TTL that a keystroke never awaits. A trigger is an `@`
reached from the cursor without crossing whitespace whose own predecessor is whitespace or the start
of the draft — so `user@example.com` never triggers — and a trigger that matches no path opens no
menu, which is what makes `@someone` in prose a no-op rather than a hijacked keyboard. Accepting a
directory keeps the marker (`@src/`) so the next keystroke completes one level down. The bounded-scan
statement rides on the menu's existing title row, never a new one.

Host acceptance independently read the full 16-file diff (both commits) and re-ran: `pnpm typecheck`
(exit 0); `pnpm test` (exit 0, 38 suite summaries, all `0 failed`, no `FAIL`); the new
`spike/verify-path-completion.ts` (59), `verify-frame-budget` (54, now including a path menu in the
"never taller than its grant" matrix), `verify-prompt-editor` (28); the free pty scenarios
`pathCompletion` (18), `completion` (29, every built-in still listed), `cursor` (5), `multiline` (9),
`mode` (25, the previous direction still working), `clear` (19), `tallDraft` (8); `git diff --check`,
`git show --check` on both commits, Trellis validation and a clean tree. No live model call was
needed for this direction's Host acceptance.

The Host also wrote its own probe rather than trusting the safety claims, and all 15 assertions
passed: a canary string inside a completed file appears **nowhere** in the reading or in the accepted
draft, `node_modules` and `.git` are neither offered nor walked, a symlink pointing outside the
project root is not offered while one pointing inside is, no candidate is absolute or `..`-relative,
`@` inside a word is not a trigger while `@` after whitespace is, and a 9,000-entry directory is
bounded and says so. Its measurements reproduce the child's: **31 ms** for the bounded 9,000-entry
scan (4,000 candidates, 4,001 entries seen), **893 candidates from 898 entries** for this repository
because the dependency tree is never walked, and a worst per-keystroke match of **0.63 ms**.

Token spend, single managed task: `input=216 output=81,016 cacheRead=13,906,719 cacheWrite=208,374`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `70d3655` | Complete workspace paths from `@` in the prompt editor, inserting the path and never the content |
| 2026-08-18 | `279121b` | Record the prompt-completion contract and its frame-budget consequences |

### Batch 18 — `Up`/`Down` recall prompts from the record darwin already keeps (2026-08-18)

One managed child task in child session `session-20260818-025938746`
(`bg-a81befde-394b-4214-9b14-2b2ef2378581`, exit 0), run `--yolo --context-offload` with no
model-call ceiling, launched from repository source at `9d3b4cc` — the revision the previous
direction produced. Host acceptance passed on the first pass. This is `SER-015`, the third and last
direction of the `peer`-path batch in
[`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md), and it closes that
batch.

Claude Code documents the semantics worth copying (history per working directory, recall reaching
past sessions of the same project, consecutive duplicates collapsed, `Ctrl+R` reverse search) and
Codex confirms `Up`/`Down` plus `Ctrl+R`. The point of interest here is that Darwin needed **no
store**: every prompt a session sent is already a `userInput` line in the trajectory record, so
`src/trajectory/prompt-history.ts` is a *reader* over bytes that exist — it reads 256 KiB **tails**
of at most 20 records ordered by mtime, keeps 100 entries newest-first with consecutive duplicates
collapsed, drops the half-line a byte-offset window begins with, and counts everything it did not
show. `src/tui/prompt-recall.ts` is the pure walk over a snapshot of those entries, so a re-read
landing mid-walk cannot renumber it.

The binding is the risk this direction had to retire, and it is enforced **by position rather than by
a predicate**: `App.tsx` already gives `Up`/`Down` to the completion menu whenever one is open — now
both `/` and `@` — so recall is unreachable there by construction; recall then fires only from an
empty draft, or from the first visual row of a draft that is already a walk, and everything else
falls through to `moveVertical`. That is what makes recall *incapable* of replacing typed text, which
is why no stashed draft exists. Two smaller decisions are worth keeping: history is what was *sent*
(local commands never reached `send`, so they are absent with no filtering), and an expanded skill
body is excluded by a 4000-code-point cap set deliberately **below** the record's own 8000-code-point
field cap, so a prompt the recorder truncated can never be silently re-sent. The child declined
`Ctrl+R` — explicitly optional in the requirement — because a second focus-owning input mode would
have cost exactly the key-ownership and frame-row risk the direction was told to avoid.

Host acceptance independently read the full 20-file diff (both commits) and re-ran: `pnpm typecheck`
(exit 0); `pnpm test` (exit 0, **39** suite summaries, all `0 failed`, no `FAIL`); the new
`spike/verify-prompt-recall.ts` (61), `verify-frame-budget` (61), `verify-trajectory` (257),
`verify-path-completion` (59), `verify-prompt-editor` (28); the free pty scenarios `recall` (20),
`recallEmpty` (4), `completion` (29), `pathCompletion` (18), `cursor` (5), `multiline` (9), `mode`
(25), `clear` (19), `tallDraft` (8); `git diff --check`, `git show --check` on both commits, Trellis
validation and a clean tree. No live model call was needed for this direction — the pty scenarios seed
history straight into trajectory records.

The Host again wrote its own probe rather than trusting the read-only claim, and all 12 assertions
passed: the newest prompt comes first, consecutive duplicates collapse, recall reaches a prompt from
an **earlier session of the same project**, every seeded record is **byte-identical by sha256** after
the read, no resume pointer is created, the read still works with `AWS_REGION`, endpoint and profile
sabotaged (so no network and no model), a project with no records reads as "no history" rather than an
error, a corrupt line and a half-written trailing line are tolerated and not repaired, and an
over-long prompt is skipped, counted and stated. Measured 1.9 ms for two records.

Token spend, single managed task: `input=394 output=126,238 cacheRead=35,947,553 cacheWrite=302,338`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `13e8968` | Recall previous prompts from the trajectory record, without taking a key that already had a meaning |
| 2026-08-18 | `7abc916` | Record the prompt-recall contract and its bounds |


### Batch 19 — cohesive TUI visual language (2026-08-18)

One managed child task in child session `session-20260818-061057110`
(`bg-f42e105b-399c-44e0-9107-651af1226311`, exit 0), run `--yolo --context-offload` with no
model-call ceiling and launched from repository source at `eec27a7`. No correction turn was needed.
This is `SER-016`, the only direction in the user-directed `tui`-path research batch recorded in
[`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md).

The implementation adds one dependency-free semantic vocabulary in `src/tui/visual-language.ts`
and applies it across the header, transcript, composer/completion menu, active/completed tools,
notices, and permission modal. Critical states now have stable text markers (`you>`, `darwin>`,
`tool ·`, severity markers, `❯`, and the permission heading), so ANSI colour reinforces rather than
creates meaning. The header leads with live status, retains model/session/cache/effort and exactly
one mode row, and replaces long skill/command/agent/MCP inventories with counts; the deterministic
80-column fixture proves it does not exceed the previous eight-row baseline. The frame budget,
stream-to-`<Static>` ownership, `AnswerPart` margins, cursor geometry, key ownership, permission
content, and no-queue busy-submit behavior were left intact. README and the frontend specs now pin
the accepted appearance and constraints.

Host acceptance independently read the full 22-file commit and re-ran: `pnpm typecheck`; `pnpm test`
(40 suite summaries, all `0 failed`); `verify-visual-language` (22), `verify-frame-budget` (61),
`verify-stream-into-static` (58); the free pty scenarios `completion` (29), `pathCompletion` (18),
`recall` (20), `cursor` (5), `multiline` (9), `mode` (25), `plan` (4), `clear` (19), and `tallDraft`
(8); and the real Bedrock 120x50 `approve` scenario (23/23), which retained provenance, bounded
details, risk, rule offers, and the reachable decision row. Trellis validation, `git diff --check`,
`git show --check`, and clean-tree verification also passed.

Token spend, single managed task: `input=300 output=34,754 cacheRead=12,965,635 cacheWrite=144,231`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `ab71a8c` | Unify the TUI around a compact, terminal-safe semantic visual language |

### Batch 20 — in-session permission-rule audit and revocation (2026-08-18)

One managed child task in child session `session-20260818-093028503`
(`bg-02b125c3-b033-47e2-b6ec-438b8074465a`, exit 0), run `--yolo --context-offload` with no
model-call ceiling and launched from repository source at `ada6581`. No correction turn was needed.
This is `SER-017`, the first direction of the rolled `peer`-path research batch recorded in
[`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md) (run `09:15:03Z`).

The implementation makes allow-rules auditable and retractable without leaving the session: the
gate tracks per-rule provenance (`configured` from the project's `permission-rules.json`,
`session` for prompt-time grants) behind a side table so the decision path stays untouched, gains
a removal-only `removeAllowRule`, and `/permissions` lists numbered rules with origins while
`revoke <n|rule|all>` takes effect on the live gate synchronously — the next matching call prompts
again — with persistence written as the grant flow writes: reported, not awaited, a failed write
costing the file and stating that the rule returns next process. There is no add form; persistence
is filter-only (the loaded file set minus exactly the revoked rules), so no code path can widen.
The twelfth built-in grew `MAX_COMPLETIONS` so the completion menu still shows every command.

Host acceptance independently read the full 17-file commit and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 41 suite summaries, all `0 failed`); the new `verify-permissions-command.ts`
(42); the free pty scenarios `completion` (30, `/permissions` row asserted), `pathCompletion` (18),
`recall` (20), and `mode` (25); Trellis validation; `git diff --check` / `git show --check`; and a
14-assertion Host-written probe in a throwaway HOME over the real gate, config seam and command
handler: configured/session origins distinguished, revoke removes from the live list and returns
false thereafter, the file round-trip does not resurrect a revoked rule, an untouched rule survives
as the widening canary, revoking a rule absent from the file adds nothing (filter-only proof), an
unknown subcommand degrades to usage without adding anything, and the handler revocation empties
the gate. No live model call was needed: the permission modal itself is unchanged.

Token spend, single managed task: `input=160 output=49,146 cacheRead=8,014,158 cacheWrite=151,595`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `8d120dd` | List and revoke permission allow-rules in-session with `/permissions` |

### Batch 21 — in-session MCP server inspection (2026-08-18)

One managed child task in child session `session-20260818-100731833`
(`bg-f67fc62b-4ce7-4cf0-8ebb-c7707f72d2cd`, exit 0), run `--yolo --context-offload` with no
model-call ceiling and launched from repository source at `55f71f5`. No correction turn was needed.
This is `SER-018`, the second direction of the rolled `peer`-path research batch recorded in
[`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md) (run `09:15:03Z`).

The implementation answers "which external tools can the model call right now, and is the server
up" without a model call: `/mcp` (13th built-in, available mid-turn) names every configured server
with its connection state, a bounded tool listing (`MAX_MCP_TOOL_NAMES = 8`, explicit `… N more`),
and config provenance — contributing files with global/project labels, project-over-global
overrides, and an ignored root `.mcp.json`. A failed server is stated as failed and contributing
no tools, never omitted; zero servers reads as a normal notice naming the three files darwin looked
for. Reading never mutates: `listTools()` connects lazily, so the report never calls it — state
comes from the public `connectionState` getter and tool names from the SDK's own
`_registeredToolNames` on the established private-field precedent, guarded to degrade to
"unavailable". `reconnect` was deliberately not shipped: the SDK's `connect(true)` flips state
without re-registering tools into the agent's registry, so it would advertise a "connected" server
whose tools the model cannot call — recorded in the PRD and `strands-sdk-contracts.md` § MCP.

Host acceptance independently read the full 18-file commit and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 42 suite summaries, all `0 failed`); the new `verify-mcp-command.ts` (33); the
new free pty `mcp` scenario (9); `completion` (31, `/mcp` visible); `pathCompletion` (18); Trellis
validation; `git diff --check` / `git show --check`; and an 11-assertion Host-written probe in a
throwaway HOME running the acceptance scenario against real MCP servers: a healthy fixture and a
broken command both named, the broken one stated rather than omitted, bounded tool names, config
and ignored-file provenance stated, connection states byte-identical before and after the read,
and an unconfigured project degrading to the candidate-file notice. No live model call was needed.

Token spend, single managed task: `input=200 output=52,109 cacheRead=10,652,629 cacheWrite=165,195`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `a443981` | Inspect MCP servers, states, tools and config provenance with `/mcp` |

### Batch 22 — in-session transcript export (2026-08-18)

One managed child task in child session `session-20260818-104704270`
(`bg-d5b3a70c-ed8a-427e-84be-5f12bd119c95`, exit 0), run `--yolo --context-offload` with no
model-call ceiling and launched from repository source at `c6f5628`. No correction turn was needed.
This is `SER-019`, the third and final direction of the rolled `peer`-path research batch recorded
in [`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md) (run `09:15:03Z`).

The implementation is a fifth reader over the record the session is already writing:
`/export <path>` (14th built-in) projects the current session's trajectory through the same
`replayRead`/`formatReplay` pipeline `darwin trajectory replay` prints — a commented header names
the record, and the body below it is byte-identical to a replay, so the two can never disagree.
`src/trajectory/export.ts` imports no `Agent`, no `Model` and nothing from Ink; the record is never
opened for writing and the resume pointer never moves. Path discipline: relative targets resolve
against the project root, an existing target is refused atomically via `wx` rather than checked
first, targets inside `~/.darwin/sessions/` are refused (a transcript there would look like a
record to every scanner), and an unwritable path costs one error notice. Absence is an answer:
`trajectory: false`, a record-less session and a zero-turn record each read as "nothing to export"
with no file written. Clipboard and `$EDITOR` integration were deliberately excluded as
environment-dependent and SSH-hostile.

Host acceptance independently read the full 13-file commit and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 43 suite summaries, all `0 failed`); the new `verify-export-command.ts` (32);
the free pty `completion` (35, `/export` row asserted), `mcp` (9) and `recall` (20); Trellis
validation; `git diff --check`; and a 12-assertion Host-written probe against a real recorded
session of this project: record and resume pointer byte-identical by sha256 after the export, body
byte-identical to `formatReplay`, overwrite refusal leaving the target byte-identical, the
sessions-directory guard, both absence readings writing no file, usage on a missing argument, and
an unwritable directory degrading to one error notice. No live model call was needed.

Token spend, single managed task: `input=166 output=39,371 cacheRead=7,563,025 cacheWrite=137,870`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `dd08f8f` | Export the current session's transcript to a file with `/export` |

### Batch 23 — file edits rendered as coloured line diffs (2026-08-18)

Two managed child tasks in child session `session-20260818-123849412`, run `--yolo
--context-offload` with no model-call ceiling and launched from repository source at `4023e93`.
The first task (`bg-6a49b177-9e1f-4c4e-af83-7f4b10a132b9`, exit 1) died in a transient provider
stream timeout (`Stream timed out because of no activity for 180000 ms`) during initial research
with nothing written; per the retry rule the same session was continued once
(`bg-c0253f1f-3660-4704-9755-3a6d35b56fc6`, exit 0), which completed the whole task with no
correction turn. This is `SER-020`, the first direction of the user-directed `tui`-path research
batch recorded in [`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md)
(run `12:30:29Z`).

The implementation finally consumes the seam the gate has exposed since the beginning
(`PermissionRequest.input`, "for a UI that wants to show or diff it itself"): a pure,
dependency-free `src/tui/edit-diff.ts` computes a line diff from the strings already in a
`fileEditor` write input (`str_replace` diffs `old_str` against `new_str`; `create`/`insert` are
all additions; no file is ever read), with plain-text `- `/`+ `/`  ` markers so the distinction
survives ANSI stripping, and hands it to the existing bounded presentation surfaces — the
permission box collapses only the `editContent`-tagged blocks into one `Diff:` block (Path,
Operation, At line, Classifier stay stated; unrecognized shapes keep raw blocks), and the
active/finished tool panels reuse the same projection. Equivalence is structural: stripping the
two-character marker recovers both sides exactly, and deleting matched text stays distinguishable
from replacing it with the empty string. Tone travels on the counted row (no second height
calculation), is scoped to fileEditor so a bash command starting with `- ` never turns red, and
the hand-rolled LCS falls back to remove-all/add-all above 40k cells so a pathological input costs
alignment quality, never a stall.

Host acceptance independently read the full 20-file commit and re-ran: a purity grep (zero
file-reading APIs in `edit-diff.ts`, its one import a type); `pnpm typecheck` (exit 0); `pnpm
test` (exit 0, 44 suite summaries, all `0 failed`, no `FAIL`); the new `verify-edit-diff.ts` (62)
and extended `verify-visual-language.tsx` (36); the live 120×50 `verify-tui.ts approve` with real
model calls (26/26, exit 0 — diff `- `/`+ ` rows, truncation marker, source label and the complete
decision row in one settled frame, and the approved edit applied exactly); `git diff --check` /
`git show --check`; Trellis validation (`✓`); protected docs untouched by the child commit; and a
9-assertion Host-written probe: old and new recovered byte-exactly from the markers (Unicode
intact), delete vs empty-replacement distinguishable, create all-added, unknown shapes degrading
to `undefined`, and a 3,000×3,000-line pathological diff equivalent and fast (measured 6ms).

Token spend across both managed tasks: `input=196 output=84,135 cacheRead=11,879,551
cacheWrite=188,939` (failed first task `36/9,905/911,932/81,805` + retry
`160/74,230/10,967,619/107,134`; both tasks reported all four fields).

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `dfbab04` | File edits rendered as bounded coloured line diffs at approval and in tool results |

### Batch 24 — assistant answers styled as markdown (2026-08-18)

One managed child task in child session `session-20260818-134215605`
(`bg-9da6e671-16cc-4d91-bd99-03afa8a514e3`, exit 0), run `--yolo --context-offload` with no
model-call ceiling and launched from repository source at `b2bdbeb` — the revision the previous
direction produced. No correction turn was needed. This is `SER-021`, the second direction of the
user-directed `tui`-path research batch recorded in
[`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md) (run `12:30:29Z`).

The styling is a pure projection over text nothing else stops owning: `src/tui/markdown.ts`
(dependency-free, line-oriented, zero imports) classifies lines (`text|heading|fence|code|rule`)
and splits prose into inline spans whose concatenation is the input verbatim — markers like `**`
and fences are de-emphasized in place, never stripped, so ANSI-stripped output, the trajectory
record, `/export` and replay are untouched by construction. Because `<Static>` pieces are never
redrawn, the one piece of cross-piece state — inside or outside a fenced code block — is a boolean
decided at push time: each assistant history entry carries `codeOpen = fenceOpenAfter(committed
prefix)` and the live region derives its state with the same function over the same string, so
live and committed rendering cannot disagree. A history piece renders as ONE `<Text>` of nested
spans (measured: an empty per-line `<Text>` renders zero rows and would swallow committed
paragraph breaks); live rows keep exactly the row count `liveTextView` granted. `_underscore_`
emphasis is deliberately unrecognized (snake_case is common in answers) and language-aware
highlighting is deliberately out of scope.

Host acceptance independently read the full 22-file commit and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 45 suite summaries, all `0 failed`, no `FAIL`); the new `verify-markdown.tsx`
(49) and extended `verify-visual-language.tsx` (41); free pty `completion` (35), `recall` (20),
`multiline` (9), `clear` (19); the live 120×50 `verify-tui.ts approve` (26/26, exit 0); `git diff
--check` / `git show --check`; Trellis validation (`✓`); protected docs untouched. Plus two
Host-written probes: a 16-assertion reassembly/fence probe (joined spans byte-equal the input on
adversarial cases incl. unclosed bold, snake_case, CJK+emoji; fence state deterministic across
piece boundaries; carried `codeOpen` classifies a middle piece as code), and an independent
byte-stability proof the child's stash comparison could not give — two git worktrees at `b2bdbeb`
(pre) and `0b9adea` (post) replaying the same copied 96,740-byte real record with 427
markdown-bearing lines: `cmp` byte-identical.

Token spend, single managed task: `input=206 output=77,862 cacheRead=11,586,921 cacheWrite=169,525`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `0b9adea` | Assistant answers styled as markdown at render time, byte-stable everywhere else |

### Batch 25 — live elapsed and token readout on the busy rows (2026-08-18)

One managed child task in child session `session-20260818-142206509`
(`bg-c8b08209-8de9-4936-bfd7-1b5d55547711`, exit 0), run `--yolo --context-offload` with no
model-call ceiling and launched from repository source at `34513ea` — the revision the previous
direction produced. No correction turn was needed. This is `SER-022`, the third and final
direction of the user-directed `tui`-path research batch recorded in
[`docs/research/research_2026-08-18.md`](./research/research_2026-08-18.md) (run `12:30:29Z`).

The `working…`/`thinking…` rows now carry a live suffix (` · 12s · ↑1.2k ↓318 tokens`;
`thinking…` elapsed-only by recorded PRD decision, since both rows can be on screen at once).
Every constraint keeps it a suffix: the rows stay one truncated `<Text>` each so no width wraps
them into an uncounted second row, the readout sits ahead of the static command hints so narrow
terminals truncate the part that never changes, the only clock is the spinner interval that
already ticks the frame, and the meter read is the synchronous `runtime.usage` getter wrapped
cannot-throw (a failed read degrades to elapsed-only). The numbers are honest rather than fresh:
the SDK accumulator counts a model call when it finishes — the same lagging reading `/usage`
explains — and the `usageBuckets` rule holds: an unreported metric is absent, never rendered as
zero, while a measured zero is shown. One pre-existing failure was fixed in passing and verified
as pre-existing by the Host at `34513ea`: the `usage` scenario's header assertion still expected
the pre-SER-016 line `/usage for token counts`, which `ab71a8c` had removed — the scenario had
been failing on main since that unification.

Host acceptance independently read the full 11-file commit and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 46 suite summaries, all `0 failed`, no `FAIL`); the new `verify-busy-suffix.ts`
(13); the live `verify-tui.ts usage` (22/22 — including the two new assertions that the readout
appears mid-turn and *ticks* across two distinct elapsed readings); the live 120×50 `approve`
(26/26); free `completion` (35); `git diff --check` / `git show --check`; Trellis validation
(`✓`); protected docs untouched. Plus a 6-assertion Host probe of the projection's honesty rules:
unknown spend renders no token arrows, an unreported bucket is absent (never `↑0`), a measured
zero shows as zero, unit formatting floors rather than rounding up, big counts stay bounded, and
the suffix is one line.

Token spend, single managed task: `input=152 output=46,401 cacheRead=6,828,903 cacheWrite=146,196`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `72966f4` | Busy rows tick with live elapsed time and honest token spend |

### Batch 26 — every file edit visible as a vivid bounded diff (2026-08-18)

Origin: `docs/research/research_2026-08-18.md`, run `16:03:24Z` — a **user-directed** `tui`-path
run ("优化TUI，当coding agent在编辑文件时，能以diff显示在TUI界面上，要求酷炫一点"), recorded as
`path-source: override (user-directed)`. The headline ask (a red/green edit diff) had shipped
hours earlier as SER-020; the repository evidence pass found the real gap: `turn-state.ts:332-335`
stored `inputPreview: ''` in default compact mode, so an auto-approved edit left **no diff at all**
in the transcript, no surface stated the edit's size, and replaced lines carried no intraline
emphasis. One direction, SER-023 (Score 13), was queued; old-side absolute line numbers (would
break SER-020's no-file-read purity), syntax highlighting and side-by-side layout were gated out
(4/3/3 < 6).

Child session `session-20260818-161103916`, managed task `bg-b660155d` (exit 0, no correction
turn), launched from source at `9c29f2b`. Delivered in `7405d44` (+ task-record close `578cc2d`):
compact rows now carry `compactEditDiff` — a bounded excerpt (8 lines / 1,600 code points) that
skips leading unchanged context with an explicit `… N earlier lines` row and bounds the tail
through the existing `boundText` vocabulary, absence of a marker meaning nothing withheld; a
`+N -N` stat (`diffStat`, counted from the untruncated diff's own markers) spliced into the
finished summary row *before* the path (the row truncates end-first — a suffix stat is exactly
what the approve scenario's huge path ate, measured live) and onto the permission `Diff (+N -N):`
label; and intraline emphasis (`diffLineEmphasis`) bolding the common-prefix/suffix-trimmed span
of equal-count replaced pairs as an `emphasis` range on the same counted `BoundedContentRow`.
The stat travels as an optional history field, never inside `summary`, because `formatReplay`
prints summaries verbatim.

Host acceptance independently read the full 17-file diff and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 46 suite summaries, all `0 failed`, no `FAIL`); `verify-edit-diff.ts`
(98, up from 62); `verify-visual-language.tsx` (47); free pty `completion` (35); the live 120×50
`verify-tui.ts approve` — 29/29 on the clean run, including the three new SER-023 assertions
(`Diff (+1 -1):` on the permission label, the stat riding the finished `✓` summary row, and the
compact `- `/`+ ` excerpt rows in the transcript); two earlier attempts asserted 28–29 PASS and
then timed out on the documented pre-existing model nondeterminism (an extra exploratory `bash`
whose permission box swallows `/exit`, first recorded in SER-013's acceptance at pre-change
commits); purity re-grep (`edit-diff.ts`'s sole import is a type); `git diff --check` /
`git show --check` on both commits; Trellis task validation (`✓ All validations passed`);
protected docs untouched. Plus a 20-assertion Host probe (stat counts across
create/insert/delete/empty-replacement/unknown shapes, excerpt bounded ≤ 9 rows with the window
landing on the first change, no-marker-means-nothing-withheld, non-fileEditor gets no excerpt,
emphasis identity slicing, astral-safe Unicode spans, unrelated pairs and unequal runs get none,
old/new still reconstruct byte-exactly from stripped markers) and an independent replay
byte-stability proof: a real 9.4 MB trajectory of this project replayed at `9c29f2b` (worktree)
vs `7405d44` — 825,149 bytes, `cmp` byte-identical. The child's one open decision — the compact
excerpt also shows for `denied`/`error` results, marked by the existing `⊘`/`✗` icons — was
accepted as shipped: showing what was *attempted* is information over silence.

Token spend, single managed task: `input=278 output=100,516 cacheRead=19,246,585 cacheWrite=223,158`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-18 | `7405d44` | Every file edit shows a vivid bounded diff: compact excerpt, `+N -N` stat, intraline emphasis |

### Batch 27 — `!` runs a user shell command from the prompt (2026-08-19)

Origin: `docs/research/research_2026-08-19.md`, run `01:20:26Z` — a rolled `peer` run (18 of 20
half-units) that found `!` shell passthrough to be the one tri-peer interactive affordance darwin
still lacked: Claude Code runs it without approval and adds output to conversation context, Codex
applies its approval/sandbox settings, OpenCode injects a tool result. The peers' two
disagreements (policy, context shape) were left as explicit design decisions for the child.
SER-024 (Score 11) led the three-direction batch queued by that run.

Child session `session-20260819-020346651`; first managed task `bg-2f7904c7` died in a transient
stream timeout (`no activity for 180000 ms`) after its research phase, retry task `bg-c29768de`
(same session, exit 0) carried the work to commit with no correction turn. Delivered in
`d0fb23f`: `!` at the start of the draft runs one bounded one-shot `bash -c` in its own process
group (TERM→KILL on 120 s timeout, Ctrl+C, or unmount — deliberately not the runtime's serialized
persistent shell), streams a live tail through the existing tool panel (counted by the shared
`toolDetailsVisible` predicate — no new frame surface), and states one SER-009-bounded projection
on three surfaces that cannot disagree: the finished transcript row, a new `shellCommand`
trajectory record (never a `userInput` line, so prompt recall never offers it; replay prints it
through the same reducer action), and a `<user-shell-command>` report held and prepended to the
next model-bound prompt (never injected into `agent.messages`, dropped by `/clear`). Policy
decision recorded in PRD and specs: user-typed means user-authorized — the gate's subject is
model tool calls, so `!` runs in every mode including plan. Mid-turn submission stays retained,
never queued (SER-010), and the child also fixed a real retention gap its scenario exposed: a
batched `text+Enter` stdin event previously bypassed the editor mirror, so a busy refusal
silently dropped the draft.

Host acceptance independently read the full 22-file diff and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 47 suite summaries, all `0 failed`, no `FAIL`, incl. the new
`verify-shell-command.ts` 56/56); the new free pty `bang` (16/16 — live output, plan-mode run,
busy retention, Ctrl+C kill, record shape, no `userInput` line, no model call); free
`completion` 35, `pathCompletion` 18, `recall` 20, `recallEmpty` 4, `mode` 25, `clear` 19,
`multiline` 9, `chunkedEnter` 4, `cursor` 5, `mcp` 9; the live 120×50 `verify-tui.ts approve`
29/29 (no added frame row); `git show --check` clean; Trellis task validation (`✓`); protected
docs untouched; AGENTS.md at 16.4 KiB, under the preload cap. Host's own probes: a 13-assertion
module probe (prefix rules, exit codes, sub-5s timeout kill, marker honesty on a 200k-point
firehose stating true totals, report shape, summary flattening) plus a clean tagged orphan probe
that disproved the one initial FAIL as pgrep matching its own command line — group reaping is
real; and an independent replay byte-stability proof: a real 332,818-byte trajectory of this
project replayed at `bd5cc96` (pre-change worktree code, repo cwd) vs `d0fb23f` — `cmp`
byte-identical.

Token spend, two managed tasks: `input=134 output=36,954 cacheRead=6,044,092 cacheWrite=154,399`
(timed-out first attempt) + `input=188 output=79,611 cacheRead=21,537,230 cacheWrite=285,283`
(retry to completion) = `input=322 output=116,565 cacheRead=27,581,322 cacheWrite=439,682`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `d0fb23f` | `!` runs a user-typed shell command directly: bounded live output, honest record, report to the next prompt |

### Batch 28 — `darwin sessions` lists, `--resume <id>` chooses (2026-08-19)

Origin: `docs/research/research_2026-08-19.md`, run `01:20:26Z` (rolled `peer`). Codex reopens a
recent chat from the current repository or searches local chats; OpenCode lists and switches with
`/sessions`. Darwin could recover only the `last-session.json` pointer's session, and
`--session <id>` demanded an id copied by hand from the store. SER-025 (Score 11) was the batch's
second direction; an in-session switcher was deliberately out of scope.

Child session `session-20260819-032859311`, managed task `bg-2343dc6a` (exit 0, no correction
turn). Delivered in `33d5bb0` (+ task archive `9656b5b`): a new `argv[0]`-routed
`darwin sessions` subcommand (`src/cli-sessions.ts`, on the `cli-trajectory.ts` precedent —
imports nothing from the SDK and contains no write API, both grep-asserted) listing this
project's resumable sessions newest-first by snapshot mtime with age, bounded first prompt from
the trajectory's first `userInput` (degrading to `(not recorded)` per the prompt-recall absence
rule) and a `(last)` marker; sessions without a restorable snapshot are skipped and the skip
stated. `--resume <id>` joins the flag grammar additively — only a non-flag token is consumed, so
bare `--resume` and `--resume --flag` parse exactly as before; combining with `--session` or
repeating is a usage error. A typo'd id now refuses in one plain line via a named
`SessionNotFoundError` caught beside `ConfigError` — which also fixed the pre-existing
`--session <bogus>` TUI stack-trace crash — and never falls back to another session. Pointer
semantics stated, not left emergent: `markResumable()` is unchanged, so the resumed session owns
the pointer only after it finishes a turn.

Host acceptance independently read the full 11-file diff and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 48 suite summaries, all `0 failed`, incl. the new
`verify-sessions-command.ts` 42/42); free pty `clear` 19, `completion` 35, `bang` 16;
`git show --check` on both commits; Trellis archive validation (`✓`); AGENTS.md 17,031 B under
the preload cap; protected docs untouched. Host's own probe ran against the **real** project
store: the listing printed 30+ sessions newest-first with `(last)` on the live child's session,
bounded prompts and one stated skip, while all 121 store files hashed byte-identical before and
after; `--resume session-does-not-exist-0000` refused in one line (exit 1, zero stack frames);
`sessions extra` exited 2 with usage; `--resume --session abc -p x` kept bare `--resume`'s
meaning and refused the named `abc` rather than falling back. No model call was needed.

Token spend, single managed task: `input=192 output=49,596 cacheRead=8,869,967 cacheWrite=139,896`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `33d5bb0` | `darwin sessions` lists this project's resumable sessions; `--resume <id>` reopens one by choice |

### Batch 29 — `/status` answers "what is this session running as" in one block (2026-08-19)

Origin: `docs/research/research_2026-08-19.md`, run `01:20:26Z` (rolled `peer`). Codex documents
`/status` as "show current session configuration"; darwin spread the answer over the header plus
six partial commands (`/usage`, `/context`, `/mode`, `/permissions`, `/mcp`, `/effort`). SER-026
(Score 10) was the batch's third direction — importance honestly low (nothing was unknowable),
which is why it ranked last.

Child session `session-20260819-035915969`; first managed task `bg-d1f5f1ce` died in a transient
`Stream ended without completing a message` during research with nothing written, retry task
`bg-e368eec6` (same session, exit 0) carried the work to commit with no correction turn.
Delivered in `799a072` (+ task archive `9058224`): `/status` renders one aligned transcript block
— model/provider with the header's own cache and effort suffixes, session id with `(resumed)`,
mode in the header's wording plus the live allow-rule count, MCP server states in `/mcp`'s
vocabulary (a failed server stated as failed, never omitted), bounded skill names, trajectory and
diagnostics state, process token spend through `usageBuckets` (`not reported`, never 0) with the
resumed/in-flight caveats, and the `/context` estimate degrading to one `unavailable — <reason>`
line. Anti-divergence by construction: `formatPromptCache`/`formatThinking` *moved* out of
`App.tsx` into `status-format.ts` and the header now imports them, so header and `/status` cannot
describe cache or effort differently; `/context`'s value rendering was likewise extracted and
shared. Every `StatusFacts` field documents the pre-existing accessor it reads — the diff touches
no `runtime.ts` line, which is the "formatter, never a new information channel" contract made
visible. `MAX_COMPLETIONS` grew 14→15 with the new built-in, and the new spike pins
`MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length`.

Host acceptance independently read the full 11-file diff and re-ran: `pnpm typecheck` (exit 0);
`pnpm test` (exit 0, 49 suite summaries, all `0 failed`, incl. the new
`verify-status-command.ts` 40/40); free pty `completion` 47 (the `/status` menu row, a live
render with no MCP configured, and `/status extra` degradation all asserted), `mcp` 13 (all nine
original assertions unchanged plus the failed-server-in-`/status` ones), `pathCompletion` 18,
`bang` 16, `recall` 20, `mode` 25; `git show --check` on both commits; Trellis archive validation
(`✓`); AGENTS.md 17,532 B under the preload cap; protected docs untouched. Host's own
7-assertion formatter probe passed: failed server named and stated, unknown cache buckets read
`not reported` and never 0, nine skills bounded to six names plus `… 3 more`, context failure
costs one line and never the report, `(resumed)` and the in-flight caveat appear exactly when
true. One caveat carried from the child's report, verified against `runtime.ts` docs: `/status`
awaits the same `contextEstimate()` `/context` uses, whose first native-count attempt per model
may make one cheap non-generating CountTokens call — no model turn is ever started, and the free
pty scenarios prove the report answers without one.

Token spend, two managed tasks: `input=62 output=5,631 cacheRead=1,359,509 cacheWrite=70,064`
(failed first attempt) + `input=172 output=51,038 cacheRead=10,505,241 cacheWrite=163,645`
(retry to completion) = `input=234 output=56,669 cacheRead=11,864,750 cacheWrite=233,709`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `799a072` | `/status` consolidates the live session's configuration and state into one honest read-only report |

### Batch 30 — prompts typed while a turn runs now queue (2026-08-19)

Origin: `docs/research/research_2026-08-19.md`, **addendum `02:01:06Z`** — SER-027 was reopened
by explicit user product decision ("add queue-while-working in backlog") after the same day's
`01:20:26Z` run had declined to score it against SER-010's shipped no-queue contract. The
supersession is the point: every spec, comment and suite that pinned "retained, never queued"
was updated to say what replaced it and why, never worked around.

Child session `session-20260819-051836979`; first managed task `bg-b60fda98` died in a transient

`Stream ended without completing a message` with nothing written, retry task `bg-8a19690e` (same
session, exit 0) carried the work to commit with no correction turn. Delivered in `b39cd30`: a
submission while a turn streams or a `!` command runs leaves the editor, joins a FIFO listed
above the input box (`queued ·` rows, one truncated `<Text>` each, a fourth counted frame-budget
claim ranked after the tool panel with `… n more queued` for cuts) and is counted on the busy
hint (`· N queued`) so nothing invisible accumulates. At idle the queue drains one entry per
cycle through the ordinary submit path — its own turn for a prompt, its own run for a `!`, its
own `userInput` recorded at send time and not before. `Up` from the draft's first visual row
takes the whole queue back ahead of typed text, joining the fixed key chain (menu → take-back →
recall → cursor) without eating either neighbour; Ctrl+C or a failed turn returns the queue to
the editor unsent (auto-resending into an error is how retry loops start); a permission prompt
holds the queue untouched and visible; `/clear` drops it with the conversation. Two deliberate
SER-010 remnants, stated in every spec: compaction still owns the keyboard, and
`/clear`/`/compact`/`/model`/`/exit`/`/quit` refuse to queue with the draft retained — running a
session-replacing command minutes later, unprompted, is worse than a second Enter. Local report
commands still answer mid-turn immediately.

Host acceptance independently read the full 17-file diff — checking specifically that the
`usage` and `bang` scenarios' SER-010 assertions were flipped 1:1 into queue assertions, not
deleted, and that the `approve` change is an anchored wait per `tui-testing.md`, not a weakened
assertion — and re-ran: `pnpm typecheck` (exit 0); `pnpm test` (exit 0, 50 suite summaries, all
`0 failed`, incl. the new `verify-prompt-queue.ts` 28/28); the new free pty `queue` 17/17
(listing, take-back ordering, cancel return, refusal, recall untouched, no `userInput` record);
`bang` 19/19; `completion` 47, `pathCompletion` 18, `recall` 20, `recallEmpty` 4, `mode` 25,
`clear` 19, `multiline` 9, `chunkedEnter` 4, `cursor` 5, `tallDraft` 8, `mcp` 13; the live
120×50 `approve` 29/29 and live `usage` 23/23 — the queued prompt listed, off the editor,
counted, then auto-sent as its own turn and recorded at send time; `git show --check` clean;
Trellis validation (`✓`); AGENTS.md 18,510 B under the preload cap; protected docs untouched.
Host's own 12-assertion module probe passed: the refusal set is exactly the five stated commands,
take-back composes queue-ahead-of-draft, rows flatten to one line behind an ANSI-strippable
marker, and a zero count is silent.

Token spend, two managed tasks: `input=26 output=2,843 cacheRead=424,639 cacheWrite=49,164`
(failed first attempt) + `input=336 output=120,802 cacheRead=30,339,130 cacheWrite=283,861`
(retry to completion) = `input=362 output=123,645 cacheRead=30,763,769 cacheWrite=333,025`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `b39cd30` | Prompts and `!` commands typed while a turn runs queue visibly, drain at idle, and come back unsent on cancel |

### Batch 31 — bounded continuation after a transient stream interruption (2026-08-19)

Origin: `docs/reflections/reflection_2026-08-19_session-20260819-075248263.md`. The reflected
session lost its first 678,954 ms turn after 20 model calls to `ModelError: Stream ended without
completing a message`; a human `continue` recovered it, but headless developer workers have no
human available. SRF-001 (Score 10) therefore required one visible successor turn for only that
exact interruption, outside the SDK loop, while preserving the first failed trajectory turn.

Child session `session-20260819-094850274`. The first launch task
`bg-9208b779-c721-4b70-bb73-b5277a2732d2` failed deterministically before a model/session/usage
record because the Host accidentally passed an extra `--`. The actual managed implementation task
`bg-1d888c94-5b14-4236-81d3-142732e794f5` exited 0 with no correction turn. Delivered in
`6978780`: a shared driver-level policy recognizes only the exact SDK `ModelError`, runs one bounded
anti-repeat continuation prompt through the ordinary TUI/headless turn seam, leaves the original
failed turn append-only, never retries a second failure, and exposes continuation explicitly in
text, JSON, and JSONL without leaking original prompt text. Generic/auth/validation model errors,
max-token/context errors, cancellation, and non-model failures retain their old behavior.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck`; `pnpm
test` (37 suite summaries, all `0 failed`, no `FAIL`); `spike/verify-stream-resumption.ts` (16);
`spike/verify-headless-structured.ts` (10); `spike/verify-prompt-queue.ts` (28); `git show --check`;
clean-tree verification; and the AGENTS.md preload-size check (19,063 bytes < 32 KiB). No provider
call was needed for acceptance. The archived Trellis task carries the child check report.

Token spend: the deterministic first launch reported no usage line; the implementation task
reported `input=310 output=37,913 cacheRead=17,999,381 cacheWrite=164,037`. Aggregate reported spend
is therefore the implementation task's four buckets; the failed launch has unknown/unreported
spend rather than an invented zero.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `6978780` | Continue one exact transient model-stream interruption as a visible, separately recorded successor turn |

### Batch 32 — tolerate redundant bash management commands (2026-08-19)

Origin: `docs/reflections/reflection_2026-08-19_session-20260819-075248263.md`. The subject
trajectory showed one correctly targeted background `status` call rejected because it also carried
a copied `command`; the corrected call cost another model round. SRF-002 (Score 10) was independent
of SRF-001 but followed it in the reflection batch's persisted priority order.

Child session `session-20260819-100420866`, managed task
`bg-3349e788-4903-4e37-a0a7-7e3c555a4d48` (exit 0, no correction turn). Delivered in `bb89b53`:
`status`, `output`, and `stop` accept but ignore a redundant `command`, continue to require and
forward only `taskId`, and return the same manager result with or without the extra field. `list`
still rejects `command`; forbidden timeout/taskId combinations, missing task ids, foreground
execution, permission classification, hooks, and process lifecycle remain unchanged. The schema is
also explicitly strict against arbitrary unknown fields.

Host acceptance inspected the focused diff and independently re-ran
`spike/verify-background-bash.ts` (72/72), `pnpm typecheck`, and `pnpm test` (51 suite summaries,
all `0 failed`, no `FAIL`), plus `git show --check`, clean-tree verification, and AGENTS.md size
(19,063 bytes < 32 KiB). No provider call was needed.

Token spend, single managed task: `input=98 output=14,409 cacheRead=2,577,832 cacheWrite=80,093`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `bb89b53` | Bash `status`/`output`/`stop` ignore redundant `command` while remaining taskId-authoritative |

### Batch 33 — bounded background-task wait with incremental output (2026-08-19)

Origin: `docs/reflections/reflection_2026-08-19_session-20260819-094621980.md`. The reflected
supervision turn spent 322 model-visible calls alternating `status` and `output` for two successful
children. SRF-003 (Score 11) required one finite state-change wait that returns incremental output
while preserving the existing cursor, cancellation and process-reaping contracts.

Child session `session-20260819-112756566`. One deterministic pre-launch task
`bg-67f2df1b-442a-4b71-9f1b-a1e37fe2d3aa` failed before a session or usage record because the
Host passed an extra `--`. The managed implementation task
`bg-f7b55c75-38ef-4d92-b505-95f41657656a` exited 0 with no correction turn. Delivered in
`0f65591` (+ Trellis archive `3ca6851`): `bash wait` requires a 1–30,000 ms bound and returns one
status-plus-output result on new complete UTF-8 output, a competing cursor change, terminal state,
timeout, caller cancellation or manager shutdown. It consumes through the existing serialized
cursor, is read-safe, cannot execute a command, does not stop a task when its observer is cancelled,
and leaves shutdown's TERM→KILL group reaping intact.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck` (exit 0),
`pnpm test` (exit 0, 51 suite summaries all `0 failed`), and the real-process
`spike/verify-background-bash.ts` (96 passed, 0 failed), plus `git show --check` on both commits,
clean-tree verification, and the AGENTS.md preload-size check (19,239 bytes < 32 KiB). No provider
call was needed for acceptance.

Token spend: the deterministic failed launch reported no usage line; the implementation task
reported `input=212 output=34,259 cacheRead=8,384,186 cacheWrite=112,848`. Aggregate reported spend
is therefore those four buckets; the failed launch has unknown/unreported spend rather than an
invented zero.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `0f65591` | Wait once for bounded background-task output or state change while preserving the shared cursor and reaping guarantees |

### Batch 34 — recover clean foreground shell exits (2026-08-19)

Origin: `docs/reflections/reflection_2026-08-19_session-20260819-094621980.md`. Five green
acceptance commands in the reflected turn were surfaced as `Bash process exited unexpectedly with
code 0`, forcing redundant log recovery. SRF-004 (Score 11) required clean exit 0 to remain success
with a restart notice while nonzero/signal failures and every process-lifecycle invariant remain
honest.

Child session `session-20260819-114507345`, managed task
`bg-dc3dfa27-b104-4645-ad9e-0bf278221c7a` (exit 0, no correction turn). Delivered in `cb3efc3`
(+ archive `c650cd3`). The child reproduced the root cause in the installed SDK: concurrent
foreground invocations for one Agent attached listeners to the same persistent shell and sentinel,
so output crossed call boundaries and one `exit 0` rejected every listener. The existing pinned SDK
patch now serializes foreground execute/restart operations per Agent, waits for both stdout and
stderr boundaries, preserves each invocation's output, treats clean exit 0 as success with a visible
restart notice and lazily creates a replacement shell. Nonzero and signalled exits remain typed
failures with exit code, signal, stdout and stderr metadata. Separate Agents remain independent.

Host acceptance inspected the pinned SDK patch and independently re-ran `pnpm typecheck` (exit 0),
`pnpm test` (51 suite summaries, all green), `spike/verify-background-bash.ts` (108 passed),
`spike/probe-cancel-exit.ts`, `spike/verify-clear-session.ts` (37), and free pty `bashExit` (3) plus
`cancelThenContinue` (5). `git show --check` passed for both commits, AGENTS.md remained 19,210
bytes under the 32 KiB preload cap, and the tree was clean. No provider call was needed. The patch is
version-pinned and explicitly marked for review on the next SDK upgrade.

Token spend, single managed task: `input=294 output=42,007 cacheRead=12,724,122
cacheWrite=137,203`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `cb3efc3` | Serialize per-Agent foreground bash calls and recover clean shell exits without losing output or failure metadata |

### Batch 35 — clamp oversized fileEditor view ends (2026-08-19)

Origin: `docs/reflections/reflection_2026-08-19_session-20260819-094621980.md`. One otherwise
valid `[1,100]` view of a 41-line file failed and forced an immediate `[1,-1]` retry. SRF-005
(Score 11) required only an oversized positive end to clamp to EOF while preserving every other
validation and output contract.

Child session `session-20260819-120322968`, managed task
`bg-443daddc-a9fe-4017-9723-93d4c919a377` (exit 0, no correction turn). Delivered in `9d6524e`:
the existing pinned SDK patch now normalizes an otherwise-valid positive end beyond EOF inside the
SDK-private range helper for non-empty regular text files. Runtime assembly, provider schema,
numbered output, `-1` sentinel and in-range slices remain unchanged; starts beyond EOF, invalid
zero/negative ends, ordering, empty-file, directory, missing, decoder and 1 MiB size behavior remain
explicit errors or their existing projections.

Host acceptance inspected the pinned SDK patch and independently re-ran `pnpm typecheck` (exit 0),
`pnpm test` (52 suite summaries, all green), and the new provider-facing real-file
`spike/verify-file-editor.ts` (37 passed), plus patched-SDK syntax, `git show --check`, and
clean-tree verification. The focused suite also proved no sandbox write, byte mutation, metadata
mutation, duplicate row or omitted EOF row. No provider call was needed. The behavior is
version-pinned and must be revalidated on the next SDK upgrade.

Token spend, single managed task: `input=114 output=29,222 cacheRead=4,060,975
cacheWrite=105,224`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `9d6524e` | Clamp only oversized positive fileEditor view ends to EOF while preserving schema, output and every other error boundary |

### Batch 36 — resumed-session human recap (2026-08-19)

Origin: `docs/research/research_2026-08-19.md`, run `2026-08-19T14:12:37Z`, rolled
`peer`. SER-028 (Score 13) required an interactively resumed session to restore human orientation
from the existing trajectory without a model call, synthetic model message, or mutation of session
state.

Child session `session-20260819-141551448`. The managed implementation task
`bg-73ccfd59-e064-4c23-8cec-72a8dbe09df4` exited 0 and delivered `977b2db` (+ task archive
`1a74b16`). Host inspection found an archive trailing-blank warning; focused correction task
`bg-72b35248-c8b5-40fd-ad8f-811ef19bdbbf` exited 0 and delivered `578cc04`. The implementation
loads only the exact resumed session's tolerant trajectory reader, replays the last completed turn
through the ordinary reducer, bounds request and answer independently, and places the result in
startup `<Static>` history. Missing, disabled, damaged, truncated and incomplete records are stated;
fresh/headless sessions remain unchanged.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck` (exit 0),
`pnpm test` (all fast suites green, including `verify-resume-recap.ts` 20/20), the focused
`spike/verify-resume-recap.ts` (20), the free 120×50 pty `spike/verify-tui.ts resume` (12),
`spike/verify-trajectory.ts` (257), `spike/verify-sessions-command.ts` (42), and
`spike/verify-clear-session.ts` (37), plus Trellis archive validation, range/HEAD whitespace checks,
and AGENTS.md size (19,746 bytes < 32 KiB). The pty scenario used a real SDK snapshot and proved
trajectory, snapshot and resume pointer hashes byte-identical after startup, with no model turn.

Token spend: implementation task `input=258 output=61,611 cacheRead=18,963,325
cacheWrite=207,279`; correction task `input=27,894 output=9,577 cacheRead=258,480
cacheWrite=30,569`. Aggregate: `input=28,152 output=71,188 cacheRead=19,221,805
cacheWrite=237,848`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-19 | `977b2db` | Show bounded read-only last-turn context before the prompt when a TUI session resumes |
| 2026-08-19 | `578cc04` | Remove the archive trailing-blank warning found during Host acceptance |

### Batch 37 — visible completion overflow selection (2026-08-20)

Origin: `docs/research/research_2026-08-20.md`, run `2026-08-20T01:05:09Z`, rolled
`tui`. SER-029 (Score 13) fixed a repository-observed mismatch: keyboard navigation and acceptance
used the full completion array while the bounded menu rendered only its prefix, allowing Tab or
Enter to accept a row with no visible `❯`.

Child session `session-20260820-011013386`. One deterministic pre-launch task
`bg-2cf91b41-8050-42fe-a108-3c585b8d5fd5` failed before a session or usage record because the
Host passed an extra `--`. The managed implementation task
`bg-4f672d5b-2702-4c23-b13a-52fafe646a3a` exited 0 with no correction turn. Delivered in
`91ce096` (+ task archive `18ebbcc`): the existing bounded slash/path menu now renders a contiguous
window around the unchanged full-list selected index, keeps exactly one visible `❯`, and spends the
existing overflow row on truthful above/below omission counts. Immediate editor/selection mirrors
and acceptance-time candidate derivation keep batched arrows plus Tab/Enter aligned without changing
command/path precedence, keyboard ownership, path scanning, `MAX_COMPLETIONS`, or frame grants.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck` (exit 0),
`pnpm test` (all fast suites green), `spike/verify-frame-budget.ts` (75), and free pty
`completion` (52), `pathCompletion` (23), `cursor` (5), `recall` (20), `recallEmpty` (4), and
`queue` (17), plus `git show --check`, `git diff --check`, and clean-tree verification. No provider
call was needed for acceptance.

Token spend: the deterministic failed launch reported no usage line; the implementation task
reported `input=262 output=36,717 cacheRead=12,984,949 cacheWrite=158,115`. Aggregate reported
spend is therefore those four buckets; the failed launch has unknown/unreported spend rather than
an invented zero.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-20 | `91ce096` | Keep overflowing slash and path completion selection visible and make acceptance match the marked row |

### Batch 38 — bounded in-session help (2026-08-20)

Origin: `docs/research/research_2026-08-20.md`, run `2026-08-20T01:05:09Z`, rolled
`tui`. SER-030 (Score 12) followed the accepted completion-window repair and addressed a
repository-observed discoverability gap: shipped multiline, completion, recall/queue, readline and
tool-detail controls were mostly absent from the live reference, while README still claimed input
was single-line and multiline paste submitted at its first newline.

Child session `session-20260820-012939115`, managed task
`bg-7003a2f0-5a99-49a1-af34-64a9f88e724b` (exit 0, no correction turn). Delivered in `124bb8d`
(+ task archive `18b3ae5`): `/help` is a canonical, explicitly bounded projection of the existing
built-in command metadata and fixed input controls. It uses only the existing transcript notice
surface, remains local while idle or during an offline busy `!` command, rejects arguments locally,
and neither calls the model nor touches the prompt queue. `MAX_COMPLETIONS` grew to 16, and README
now states actual multiline/editor behavior instead of the stale limitation.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck` (exit 0),
`pnpm test` (all fast suites green), `spike/verify-help-command.ts` (23),
`spike/verify-frame-budget.ts` (75), and free pty `completion` (61), `pathCompletion` (23),
`recall` (20), `queue` (17), `toolDetails` (6), `multiline` (9), and `cursor` (5), plus
`git show --check`, `git diff --check`, clean-tree verification, and AGENTS.md size (20,116 bytes <
32 KiB). No provider call was needed for acceptance.

Token spend, single managed task: `input=244 output=42,378 cacheRead=16,665,342
cacheWrite=202,521`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-20 | `124bb8d` | Add bounded local `/help` from canonical command metadata and document the shipped prompt controls |

### Batch 39 — terminal-focused background wait (2026-08-20)

Origin: `docs/reflections/reflection_2026-08-20_session-20260820-010254692.md`. SRF-006
(Score 13) extends SRF-003 with an opt-in wait shape for supervisors that need terminal completion
rather than a wakeup on every output fragment.

Child session `session-20260820-155011267`, managed task
`bg-33033cd0-06d3-4072-ae21-80c85087a045` (exit 0, no correction turn). Delivered in `6350c8f`
(+ task archive `2860cf2`): `bash wait` accepts provider-visible `wakeOnOutput: false`, retains a
bounded contiguous UTF-8-safe output range, and returns only for terminal state, cancellation,
shutdown, or finite timeout. Output beyond the 64 KiB cap and ranges consumed concurrently remain
on the shared cursor without duplication; omitted/true behavior remains output-sensitive.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm
test` (all fast suites green), and `spike/verify-background-bash.ts` (116/116), plus commit/diff
checks, Trellis archive validation, AGENTS.md size (20,158 bytes < 32 KiB), and clean-tree
verification. No provider call was needed for acceptance.

Token spend, single managed task: `input=170 output=30,426 cacheRead=7,883,618
cacheWrite=127,572`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-20 | `6350c8f` | Add bounded terminal-focused background waiting while preserving the shared output cursor |

### Batch 40 — harmless background-start timeout (2026-08-20)

Origin: `docs/reflections/reflection_2026-08-20_session-20260820-010254692.md`. SRF-007
(Score 12) removes a deterministic provider-schema launch trap while preserving background process
lifetime and the raw input observed by permission and hook policy.

Child session `session-20260820-160436215`, managed task
`bg-ce978c9e-ec41-4a1d-bb32-9ff0ff788a90` (exit 0, no correction turn). Delivered in `44d5078`
(+ task archive `647c375`): positive numeric `start.timeout` is accepted, retained in raw permission
and Pre/Post hook input, omitted from permission presentation, and never forwarded to
`manager.start(command)` or interpreted as a process lifetime. Execute/restart compatibility and
non-start lifecycle rejection remain unchanged.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm
test` (all fast suites green), and `spike/verify-background-bash.ts` (118/118), plus commit/diff,
archive, AGENTS.md-size and clean-tree checks. No provider call was needed for acceptance.

Token spend, single managed task: `input=120 output=18,932 cacheRead=3,244,652
cacheWrite=78,868`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-20 | `44d5078` | Accept but ignore redundant timeout on background start without changing policy or lifetime |

### Batch 41 — leading CLI argument separator (2026-08-20)

Origin: `docs/reflections/reflection_2026-08-20_session-20260820-010254692.md`. SRF-008
(Score 11) fixes the deterministic `pnpm start -- --yolo…` launch failure while keeping every
non-leading separator and unknown argument strict.

Child session `session-20260820-161536842`, managed task
`bg-21f1211c-bac3-4cc5-a40d-a665b2156d37` (exit 0, no correction turn). Delivered in `262c3f5`:
`cli.ts` removes exactly one argv-leading standalone `--` before trajectory/sessions routing or
ordinary TUI/headless parsing. A second or later separator remains an error, separator values keep
their option-specific errors, unknown flags stay strict, and bare `--resume` remains pointer-based.
The Trellis task is archived in the same commit.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm
test` (all fast suites green), and `spike/verify-cli-args.ts` (11/11), plus direct process/parser
negative cases, task archive validation, commit/diff and clean-tree checks. A manual pnpm check
confirmed identical Darwin stdout and exit status for `pnpm start sessions` and `pnpm start --
sessions`; pnpm itself naturally echoes the two different wrapper command lines on stderr before
Darwin starts. No provider call was needed for acceptance.

Token spend, single managed task: `input=110 output=21,103 cacheRead=3,090,906
cacheWrite=80,899`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-20 | `262c3f5` | Normalize one leading CLI transport separator while preserving strict argument grammar |


### Batch 42 — active-turn input durable before invocation (2026-08-21)

Origin: `docs/reflections/reflection_2026-08-21_session-20260821-054705633.md`. SRF-009
(Score 13) fixes the race that left an offline reflection locator one prompt behind even though the
current `userInput` had already been observed in memory.

Child session `session-20260821-085909241`, managed task
`bg-0b77d586-5d9a-4f94-b4d8-5757cb68dc64` (exit 0, no correction turn). Delivered in `019ac58`:
`AgentRuntime.send` now waits through a 2-second fail-open recorder barrier after buffering the
current input and before calling `Agent.stream()`. Ordinary stream events remain synchronous and
non-awaitable. Write failure or timeout latches the existing trajectory problem and invocation
continues; a timed-out append chain is detached so shutdown does not inherit an unbounded wait.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm
test` (all fast suites green), `spike/verify-trajectory.ts` (267/267),
`spike/verify-stream-resumption.ts` (16/16), `spike/verify-clear-session.ts` (37/37), `pnpm build`,
Trellis task validation, and commit/diff checks. The real offline `AgentRuntime` probe read the
current input during model invocation and also proved prefix byte identity, contiguous sequence
numbers, ordinary turn closure, fail-open write/timeout behavior and bounded shutdown. No provider
call was needed for Host acceptance.

Token spend, single managed task: `input=190 output=39,681 cacheRead=7,521,728
cacheWrite=122,495`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-21 | `019ac58` | Persist the current trajectory input before provider/tool invocation with a bounded fail-open barrier |


### Batch 43 — bounded context-pressure guidance (2026-08-21)

Origin: `docs/reflections/reflection_2026-08-21_session-20260821-054705633.md`. SRF-010
(Score 10) turns the existing generic context warning into actionable, user-controlled guidance
before another broad implementation or verification turn.

Child session `session-20260821-091623784`, managed task
`bg-f8cb1052-0aeb-4598-9a8b-b912fa1f81d2` (exit 0, no correction turn). Delivered in `e5f77a6`:
the existing `contextWarnRatio`, estimate seam, session latch and transcript notice remain the only
threshold/channel. The bounded one-line notice recommends `/compact`; custom/default/disabled
thresholds, one-shot behavior, known-below re-arm, unknown-window silence and fresh `/clear` state
remain intact. Compaction stays explicit and no live-frame row or timer was added.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck`, `pnpm
test` (all fast suites green), `verify-context-format.ts` (22/22), `verify-compact.ts` (13/13),
`verify-status-command.ts` (40/40), `verify-frame-budget.ts` (75/75),
`verify-clear-session.ts` (37/37), `pnpm build`, Trellis archive validation and commit/diff checks.
No provider call was needed for Host acceptance.

Token spend, single managed task: `input=128 output=22,436 cacheRead=5,070,455
cacheWrite=111,250`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-21 | `e5f77a6` | Recommend user-controlled `/compact` through the existing bounded context-pressure notice |


### Batch 44 — exact file-edit misses return bounded recovery context (2026-08-21)

Origin: `docs/reflections/reflection_2026-08-21_session-20260821-054705633.md`. SRF-011
(Score 10) addresses a stale exact `old_str` miss that otherwise required another read/retry round,
without weakening exact mutation semantics.

Child session `session-20260821-093212243`, managed task
`bg-9f32138b-22dc-43fe-b9db-4b4e1d34f5af` (exit 0, no correction turn). Delivered in `3ce5e46`:
the version-pinned SDK-private `fileEditor` miss path now selects advisory context through capped
exact query seeds. Misses remain errors before any sandbox write; output is capped to five numbered
lines and 240 Unicode code points per line, with explicit omission, line truncation and no-safe-match
wording. Ambiguity is deterministic, oversized queries are refused early, and exact success plus all
unrelated validation/view behavior remains SDK-owned and unchanged.

Host acceptance inspected the SDK patch and independently re-ran `pnpm typecheck`, `pnpm test`
(all fast suites green), `spike/verify-file-editor.ts` (63/63), `pnpm build`, installed patched-SDK
syntax checking, Trellis archive validation, and commit/diff checks. The child's first full-gate run
hit the existing three-second background-bash exit timeout; its unchanged rerun and the Host run
passed. No provider call was needed for Host acceptance.

Token spend, single managed task: `input=272 output=43,705 cacheRead=11,210,830
cacheWrite=124,535`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-21 | `3ce5e46` | Return deterministic bounded current context after an exact `fileEditor str_replace` miss without fuzzy mutation |



### Batch 45 — distilled project memory foundation (2026-08-22)

Origin: `docs/research/research_2026-08-22.md` run `2026-08-22T03:02:03Z`. SER-031
(Score 10) replaces the explicitly rejected raw model-facing trajectory search with an opt-in,
project-scoped derived Markdown store and a bounded ambient index.

Child session `session-20260822-032546109`, managed task
`bg-370b6138-44ac-405e-8501-0a581ed85a7e` (exit 0, no correction turn). Delivered in
`73bc11b` (+ task archive `f955c54`, journal `a90489d`): eligible durable successful turns
rebuild bounded provenance-bearing Markdown topics and one index under Darwin's project-keyed
user state. Secret, instruction-like, code and tool-dump candidates are conservatively dropped;
extraction is delayed, coalesced, timeout-bounded and fail-open. Fresh, resumed and `/clear`
runtimes load only one labelled fallible index after official skills and before working context and
the final cache point. No model tool, vector/embedding index, dependency or SDK-loop fork was
added.

Host acceptance inspected the implementation and independently re-ran `spike/verify-memory.ts`
(34/34), `spike/verify-clear-session.ts` (40/40), `pnpm typecheck`, full `pnpm test`, and
`pnpm build`; plus Trellis archive validation, `git diff --check`, `git show --check` for all three
commits, structural no-search/vector/dependency/extra-Agent checks, and AGENTS.md size
(21,904 bytes < 32 KiB). All passed. No provider call was needed for Host acceptance.

Token spend, single managed task: `input=444 output=51,068 cacheRead=33,037,575
cacheWrite=219,154`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-22 | `73bc11b` | Distill eligible durable trajectory turns into bounded project memory and load one fallible index through the normal runtime factory |



### Batch 46 — local project-memory controls (2026-08-22)

Origin: `docs/research/research_2026-08-22.md` run `2026-08-22T03:02:03Z`. SER-032
(Score 12) adds human control over the accepted SER-031 store without creating a model-facing
persistence path.

Child session `session-20260822-040134487`, managed task
`bg-e1396eab-d9a8-479a-bef3-695c487cb43c` (exit 0, no correction turn). Delivered in
`06873a5` (+ task archive `b2c565f`, journal `ae00a9f`): strict local `/memory`
list/show/remember/forget commands operate on a versioned project-bound manifest. Generated and
user-authored entries report provenance, honest `unvalidated` freshness and heuristic sensitivity
state. Remember is bounded and screened; generated-ID suppressions survive deterministic rebuilds;
every successful mutation atomically updates disk and synchronously refreshes the verified live
prompt before returning. Completion and `/help` remain canonical and bounded.

Host acceptance inspected the implementation and independently re-ran
`spike/verify-memory-command.ts` (21/21), `spike/verify-memory.ts` (34/34),
`spike/verify-clear-session.ts` (42/42), free pty `spike/verify-tui.ts completion` (62/62),
`pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation,
`git diff --check`, `git show --check` for all three commits, structural no-dependency/model-tool
checks, and AGENTS.md size (21,994 bytes < 32 KiB). All passed. No provider call was needed for
Host acceptance.

Token spend, single managed task: `input=284 output=49,161 cacheRead=16,408,131
cacheWrite=173,166`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-22 | `06873a5` | Add bounded user-only `/memory` inspection, screened notes, durable forgetting and synchronous live-prompt narrowing |



### Batch 47 — generated-memory validation and aging (2026-08-22)

Origin: `docs/research/research_2026-08-22.md` run `2026-08-22T03:02:03Z`. SER-033
(Score 10) prevents generated context from silently outliving the code evidence that made it true.

Child session `session-20260822-042916698`, managed task
`bg-574c2443-8b57-4252-9dbc-b7d18c263fb3` (exit 0, no correction turn). Delivered in
`64989d6` (+ task archive `0b53fb4`, journal `dc9244f`): generated facts carry bounded exact
project-relative line/hash anchors where safely derivable and are classified `valid`, `invalid`,
`expired` or `unknown`. Only valid non-expired generated facts enter ambient context; explicit user
notes never auto-expire. A strict top-level `memoryHorizonDays` defaults to 28, accepts integer
0–365, and uses 0 to disable expiry only. Startup, pre-request refresh, `/clear` and `/memory` share
one validation projection; v1 generated state migrates unknown and stays omitted.

Host acceptance inspected the implementation and independently re-ran
`spike/verify-memory-validation.ts` (15/15), `spike/verify-memory-command.ts` (21/21),
`spike/verify-config.ts` (216/216), `spike/verify-clear-session.ts` (42/42), `pnpm typecheck`, full
`pnpm test`, and `pnpm build`; plus Trellis archive validation, `git diff --check`,
`git show --check` for all three commits, structural no-vector/model-tool/dependency checks, and
AGENTS.md size (22,058 bytes < 32 KiB). All passed. No provider call was needed for Host
acceptance.

Token spend, single managed task: `input=334 output=46,615 cacheRead=16,940,622
cacheWrite=159,384`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-22 | `64989d6` | Validate generated memory against bounded exact worktree anchors and expire it on a configurable conservative horizon |



### Batch 48 — readable informational transcript reports (2026-08-22)

Origin: `docs/research/research_2026-08-22.md` run `2026-08-22T06:37:01Z`, a user-directed
`tui` self-review. SER-034 (Score 17) addressed the reproduced low-contrast `/memory` and `/mcp`
reports: the shared notice renderer applied both gray foreground and terminal dim intensity to every
informational marker and body.

Child session `session-20260822-104129517`. The initial managed task
`bg-d54a0aa6-48fb-4ce9-afa1-4d1f8c3c9710` exited 0 after producing the Trellis plan; the same
session continued in managed task `bg-57f117eb-932d-409f-8d44-88d4cd88575b` (exit 0, no acceptance
correction) and delivered `af84a03` (+ task archive `7c49cd9`, journal `4c135e5`). The shared visual
vocabulary now gives informational notices a cyan semantic role, while `MessageList` accents only
the durable `info ·` marker and renders exact report bodies at normal intensity. Warning/error
styling, ANSI-stripped text, `<Static>` ownership, margins and row geometry remain unchanged.

Host acceptance inspected the implementation and independently re-ran `pnpm typecheck`, full
`pnpm test`, `spike/verify-visual-language.tsx` (53/53, including a forced-color child fixture), and
free pty `completion` (62/62) plus `mcp` (13/13), followed by `pnpm build`. Trellis archive
validation, `git diff --check`, `git show --check` for all three commits, clean-tree verification,
and AGENTS.md size (22,213 bytes < 32 KiB) also passed. No provider call was needed for Host
acceptance.

Token spend: planning task `input=24 output=6,432 cacheRead=318,958 cacheWrite=44,937`;
implementation task `input=80 output=12,459 cacheRead=2,713,677 cacheWrite=86,189`. Aggregate:
`input=104 output=18,891 cacheRead=3,032,635 cacheWrite=131,126`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-22 | `af84a03` | Accent the durable informational marker while keeping transcript report bodies at normal readable intensity |



### Batch 49 — animated initialization-bound startup (2026-08-22)

Origin: `docs/research/research_2026-08-22.md` run `2026-08-22T06:37:01Z`, the same
user-directed `tui` batch as SER-034. SER-035 (Score 9) addressed the blank terminal before
`AgentRuntime.create()` and resumed recap loading completed.

Child session `session-20260822-105247940`. Managed implementation task
`bg-8c72301c-49bb-4de2-86eb-2f973eef9835` exited 0 and delivered `53d806f` (+ task archive
`5548a0d`, journal `dc37b9b`): one Ink instance now renders a bounded Darwin evolution motif before
runtime creation, moves to an honest `restoring session` phase only while recap loading is pending,
and immediately rerenders the ordinary `App` when the awaited work settles. It adds no fixed delay,
input hook, raw terminal write, transcript item, provider call, permanent timer, or settled-frame row.
Known startup errors unmount before stderr; recap/import failure also shuts down the acquired runtime.

Host acceptance found one defect in the new verification: the focused startup pty suite expected an
exact two restored messages, but the full runner produced a valid four-message SDK restoration and
timed out. Focused correction task `bg-505f0da9-136a-4936-97ba-8661254e1bb8` (same child session,
exit 0) delivered `1526090` (+ archive `7ce38dd`, journal `e9e9705`): unique suite-owned HOME/project
storage plus semantic positive-count/request/answer assertions. The Host accepted only after
independently re-running `pnpm typecheck`, full `pnpm test`, startup component 17/17, startup pty
19/19, frame budget 75/75, visual language 53/53, and free pty `completion`/`clear`/`resume`
62/19/12, followed by `pnpm build`; Trellis archive validation, commit/diff/clean-tree checks and
AGENTS.md size (22,213 bytes < 32 KiB) also passed. No provider call was needed.

Token spend: implementation task `input=196 output=32,760 cacheRead=8,820,625 cacheWrite=132,646`;
correction task `input=60 output=7,925 cacheRead=4,501,524 cacheWrite=28,550`. Aggregate:
`input=256 output=40,685 cacheRead=13,322,149 cacheWrite=161,196`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-22 | `53d806f` | Render bounded honest startup motion immediately and atomically hand one Ink terminal to the ready App |
| 2026-08-22 | `1526090` | Make resumed-startup verification suite-owned and semantic rather than dependent on SDK message-count metadata |



### Batch 50 — parent structured progress checklist (2026-08-23)

Origin: `docs/research/research_2026-08-23.md` run `2026-08-23T14:00:33Z`, rolled `peer` path. SER-036 (Score 11) addresses the absence of a bounded, user-visible statement of work progress during long multi-tool turns.

Child session `session-20260823-140856961`. Managed implementation task `bg-20e52254-2bac-406c-b58a-2b9c53549e1b` exited 0 and delivered `1de577d` (+ task archive `20af308`, journal `6b5f0d7`): a parent-only `update_plan` tool accepts strict whole-list replacement (1–20 unique items, 200 code points/item, 2,000 total), is statically safe in every permission mode, and reaches neither child agents nor disk/config/session state. Successful ordinary tool events drive one transient row-budgeted live projection; turn end commits one bounded Static projection and clears live state. Ordinary call/result events remain the sole trajectory/replay evidence.

Host inspection found one load-bearing defect before acceptance: each model-authored plan item was one logical `<Text>` but could wrap into several visual rows, exceeding its frame grant on a narrow terminal. Same-session focused correction task `bg-bb251cf6-5ccb-44c4-8e7c-a940d845b10e` exited 0 and delivered `6f9c1c7` (+ task archive `ae16f98`, journal `542462e`), applying explicit `truncate-end` to both live and final Static rows and adding adversarial 12-column long-item rendered-height checks.

Host acceptance inspected both source diffs and independently re-ran `spike/verify-update-plan.tsx` (31/31), `spike/verify-frame-budget.ts` (77/77), `spike/verify-trajectory.ts` (267/267), `spike/verify-subagents.ts` (69/69), free pty `spike/verify-tui.ts updatePlan` (6/6), `pnpm typecheck`, full `pnpm test` (52 suite summaries, all green), and `pnpm build`; plus `git diff --check`, `git show --check`, clean-tree verification, and AGENTS.md size (22,816 bytes < 32 KiB). The first Host full-gate attempt hit the pre-existing high-load `verify-background-bash.ts` 3-second probe timeout; no bash implementation/test file changed, and the final complete gate passed its 118 checks. No provider call was needed for Host acceptance.

Token spend: implementation task `input=360 output=37,164 cacheRead=19,887,937 cacheWrite=180,190`; correction task `input=56 output=6,547 cacheRead=5,187,829 cacheWrite=201,094`. Aggregate: `input=416 output=43,711 cacheRead=25,075,766 cacheWrite=381,284`.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-23 | `1de577d` | Add a strict parent-only progress tool with bounded live and final projections over ordinary SDK events |
| 2026-08-23 | `6f9c1c7` | Make every checklist row structurally single-height and prove narrow-terminal row bounds |


## Batch 51 — SER-037 Escape prompt-UI dismissal

- Child session: `session-20260823-144935764`
- Managed task: `bg-4ec8d509-fdb8-4af6-9e02-fffb58dc46da` (succeeded, exit 0; no correction turn)
- Child token spend: `input=330 output=53,684 cacheRead=20,828,775 cacheWrite=190,092`

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-037 | `635c712` implementation, `3082945` task archive, `34d0e28` journal | Host inspected the implementation and independently passed `verify-prompt-completion.ts` (11), `verify-help-command.ts` (25), `verify-frame-budget.ts` (77), free pty `completion` (66), `pathCompletion` (27), `recall` (22), `recallEmpty` (4), `compacting` (5), `permissionEscape` (3), `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, `git diff --check`, `git show --check` for all three commits, clean-tree verification, and AGENTS.md size (22,816 bytes < 32 KiB). |



## Batch 52 — SER-038 lifecycle observation hooks

- Origin: `docs/research/research_2026-08-24.md`, run `2026-08-24T01:30:51Z` (rolled `peer` path).
- Child session: `session-20260824-013615973`
- Managed tasks: `bg-07db22aa-f364-453d-8ddc-cdba3c44bd92` (implementation, succeeded, exit 0) and `bg-65b30294-3a97-42c0-9bfa-19375f167f2f` (same-session focused correction, succeeded, exit 0).
- Token spend: implementation `input=410 output=55,568 cacheRead=24,411,849 cacheWrite=184,885`; correction `input=46 output=11,288 cacheRead=721,554 cacheWrite=41,551`; aggregate `input=456 output=66,856 cacheRead=25,133,403 cacheWrite=226,436`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-038 | `8ae7855` implementation, `b673cd5` verification correction, `1ac2894` task archive | Host inspected the source/docs/test diff and found the initial focused lifecycle assertion was completion-order-dependent: 17/19 passed. The same child session corrected only that assertion to use per-command sinks; Host then independently passed `verify-lifecycle-hooks.ts` (20/20), `verify-config.ts` (231/231), `verify-state-layers.ts` (37/37), `verify-tool-hooks.ts` (44/44), `verify-permission-mode-switch.ts` (100/100), `verify-subagents.ts` (69/69), `verify-headless.ts` (80/80), `verify-headless-structured.ts` (11/11), `verify-clear-session.ts` (44/44), `verify-trajectory.ts` (267/267), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation, `git diff --check`, `git show --check`, clean-tree verification, and AGENTS.md size (23,321 bytes < 32 KiB). No provider call was needed for Host acceptance. |


## Batch 53 — SRF-012 closed reflection cutoff

- Origin: `docs/reflections/reflection_2026-08-24_session-20260824-105238516.md`.
- Child session: `session-20260824-110019745`.
- Managed task: `bg-c273c723-f9f6-4d51-83e2-f39e70cbddfb` (succeeded, exit 0; no correction turn).
- Child token spend: `input=144 output=25,502 cacheRead=5,157,670 cacheWrite=107,218`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-012 | `e527320` | Host inspected the implementation and independently passed `spike/verify-self-reflection.ts` (12/12), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis task validation, source/dist asset identity, `git diff --check`, `git show --check`, clean-tree verification, and AGENTS.md size below 32 KiB. The locator now hands reflection workers an inclusive latest-`turnEnded` cutoff and refuses current or named records with no closed turn without falling back or mutating session state. |


## Batch 54 — SRF-013 bounded completion guard

- Origin: `docs/reflections/reflection_2026-08-24_session-20260824-111655828.md`.
- Child session: `session-20260824-135926608`.
- Managed task: `bg-5fbc46bf-e0fe-4a32-8505-1cc83160fa18` (succeeded, exit 0; no correction turn).
- Child token spend: `input=348 output=81,150 cacheRead=16,555,590 cacheWrite=147,905`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-013 | `989e36c` implementation, `41571a3` task archive, `78b01ba` journal | Host inspected the source/spec/test diff and independently passed `verify-completion-guard.ts` (24/24), `verify-stream-resumption.ts` (16/16), `verify-max-tokens-recovery.ts` (20/20), `verify-headless-structured.ts` (11/11), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation, `git diff --check`, `git show --check`, and AGENTS.md size below 32 KiB. Matched successful internal notes are withheld from TUI/text/JSON/JSONL and trajectory/replay payloads, while tool-bearing candidates fail open and a second match, failure, or cancellation never loops. |


## Batch 55 — SRF-014 persistent foreground cwd preflight

- Origin: `docs/reflections/reflection_2026-08-24_session-20260824-111655828.md`.
- Child session: `session-20260824-143558666`.
- Managed tasks: `bg-c1dfd213-fcad-4835-bad4-b40d3cf0dcd9` and `bg-de388247-4298-4251-a6e7-29e41e30b0ec` (both completed the requested implementation/check work but the completion guard ended each process without a final result).
- Child token spend: first task `input=290 output=51,870 cacheRead=14,375,319 cacheWrite=149,320`; second task `input=44 output=3,975 cacheRead=736,855 cacheWrite=45,421`; aggregate `input=334 output=55,845 cacheRead=15,112,174 cacheWrite=194,741`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-014 | `3f4c27a` implementation, `aad5ac8` task archive, `f5b4704` journal | Host inspected the source/pinned-patch/spec/test diff and independently passed `verify-background-bash.ts` (134/134), `verify-clear-session.ts` (44/44), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation, `git diff --check`, `git show --check`, restricted `process.cwd()` grep, and AGENTS.md size below 32 KiB. Foreground execute/restart now reports effective cwd and conservatively refuses only simple relative paths absent under cwd but present under project root before launch. |


## Batch 56 — SRF-015 subagent heartbeats and targeted cancellation

- Origin: `docs/reflections/reflection_2026-08-24_session-20260824-111655828.md`.
- Child session: `session-20260824-150312114`.
- Managed tasks: `bg-fce09961-82f3-436c-af02-cd647dd17b30` and `bg-74634550-c667-4220-a0a2-51b16a13ace5` (both ended without final prose after committing the requested implementation/corrections).
- Child token spend: first task `input=308 output=48,397 cacheRead=15,823,870 cacheWrite=156,195`; second task `input=90 output=6,693 cacheRead=1,635,254 cacheWrite=51,973`; aggregate `input=398 output=55,090 cacheRead=17,459,124 cacheWrite=208,168`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-015 | `e6ae0f2` implementation, `e3ac4db` transient-heartbeat correction, `0363101` headless fixture correction, `4b88b29` task archive | Host inspected the source/spec/test diff and independently passed `verify-subagent-heartbeats.ts` (21/21), `verify-subagents.ts` (69/69), `verify-frame-budget.ts` (77/77), `verify-trajectory.ts` (267/267), `verify-headless-structured.ts` (11/11), `verify-completion-guard.ts` (24/24), free pty `completion` (66/66), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation, `git diff --check`, `git show --check`, and AGENTS.md size below 32 KiB. Heartbeats reuse existing TUI/headless surfaces, carry only closed bounded metadata, clear before settlement, and `/agents cancel <id>` remains user-only and child-specific. |


## Batch 57 — SRF-016 bounded repeated-failure guard

- Origin: `docs/reflections/reflection_2026-08-25_session-20260825-023511752.md`.
- Child session: `session-20260826-043541334`.
- Managed tasks: `bg-cf9b6d41-1e2e-486d-b789-04bdacec30d4` (implemented and committed, then exited 1 without final prose) and same-session completion/correction `bg-f4462f87-296a-456d-8402-b75e182b42e1` (succeeded, exit 0).
- Token spend: first task `input=396 output=77,598 cacheRead=23,317,316 cacheWrite=183,707`; second task `input=24 output=2,419 cacheRead=2,260,393 cacheWrite=9,648`; aggregate `input=420 output=80,017 cacheRead=25,577,709 cacheWrite=193,355`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-016 | `b5133d3` implementation, `7511778` correction, `7c8e3c8` task archive, `3762301` and `919d5be` journals | Host inspected the source, pinned-SDK patch, specs and focused real-Agent verification, then independently passed `spike/verify-retry-guard.ts` (15/15), `spike/verify-background-bash.ts` (135/135), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation, `git diff --check`, `git show --check`, clean-tree-shape verification and AGENTS.md size (24,927 bytes < 32 KiB). The guard preserves the first three original same-signature failures, injects bounded hypothesis/stop guidance, denies later calls before hooks/permission/body, resets per invocation, isolates Agents, and covers structured bash failures without touching user `!` commands. |


## Batch 58 — SRF-017 CodeGraph availability preflight

- Origin: `docs/reflections/reflection_2026-08-25_session-20260825-023511752.md`.
- Child session: `session-20260826-051104786`.
- Managed task: `bg-ff49fca8-ebcd-4b2f-8b93-2a0b0cf59128` (succeeded, exit 0; no correction turn).
- Child token spend: `input=248 output=38,461 cacheRead=11,727,867 cacheWrite=139,810`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-017 | `117103e` implementation, `d01d041` task archive, `8647a20` journal | Host inspected the source/spec/test diff and independently passed `verify-codegraph-preflight.ts` (14/14), `verify-mcp-command.ts` (33/33), `verify-subagents.ts` (71/71), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation, commit/diff checks, clean-tree verification, and AGENTS.md size (25,333 bytes < 32 KiB). Unavailable or unsafe targets now return one bounded successful shell/file fallback without invoking CodeGraph, while initialized targets delegate unchanged and parent/child catalogues share the policy. |


## Batch 59 — SRF-018 successful empty web-search results

- Origin: `docs/reflections/reflection_2026-08-25_session-20260825-023511752.md`.
- Child session: `session-20260826-070659337`.
- Managed task: `bg-08473b8f-5249-4951-9d9d-20d553d3e190` (succeeded, exit 0; no correction turn).
- Child token spend: `input=166 output=23,943 cacheRead=6,192,451 cacheWrite=117,896`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-018 | `7dda590` implementation, `7c7c718` task archive, `d1dddfd` journal | Host inspected the source/spec/test diff and independently passed `verify-web-search-empty-results.ts` (8/8), `verify-retry-guard.ts` (15/15), `verify-tool-hooks.ts` (44/44), `verify-subagents.ts` (71/71), `verify-codegraph-preflight.ts` (14/14), `verify-mcp-command.ts` (33/33), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation, commit/diff checks and AGENTS.md size (25,730 bytes < 32 KiB). Only the exact external provider's verified MCP no-results signature becomes successful query-preserving empty JSON; non-empty results and true failures remain unchanged. |



## Batch 60 — SER-039 bounded reverse prompt-history search

- Origin: `docs/research/research_2026-08-26.md`, run `2026-08-26T11:43:24Z` (rolled `peer` path).
- Child session: `session-20260826-115313304`.
- Managed task: `bg-7136ab3f-6aeb-4861-a88c-59870aafa8e0` (succeeded, exit 0; no correction turn).
- Child token spend: `input=310 output=39,330 cacheRead=16,770,648 cacheWrite=163,026`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-039 | `9cdbffc` | Host inspected the 24-file source/spec/test/task diff and independently passed `verify-prompt-history-search.ts` (19/19), `verify-frame-budget.ts` (80/80), `verify-help-command.ts` (26/26), `verify-prompt-recall.ts` (61/61), free pty `historySearch` (11/11), `compacting` (5/5), `cursor` (5/5), `completion` (66/66), `pathCompletion` (27/27), `recall` (22/22), `recallEmpty` (4/4), and `permissionEscape` (3/3), plus `pnpm typecheck`, full `pnpm test`, `pnpm build`, Trellis archive validation, structural no-I/O/model/network grep, `git diff --check`, `git show --check`, clean-tree verification, and AGENTS.md size (25,897 bytes < 32 KiB). The free pty `queue` scenario timed out twice after its unchanged batched multi-row draft-clear chord left `!sleep 30` to enter the model path; the same scenario exited 1 at pre-change parent `315cb71`, so this was recorded as pre-existing PTY fixture nondeterminism rather than repaired outside SER-039. Search remains a project-only in-memory projection over the existing bounded trajectory reader, with exact Escape restoration and counted live-frame rows. |


## Batch 61 — SER-040 conversation-only rewind

- Origin: `docs/research/research_2026-08-26.md`, run `2026-08-26T12:29:54Z` (rolled `peer` path).
- Child session: `session-20260826-123525049`.
- Managed tasks: `bg-f64d9202-996c-4274-bac3-980df3cc0f9d`, `bg-5d688c44-6ec3-4061-ac2f-9c0ccb51c85c`, and Host-focused correction `bg-4b27036a-3d7d-4770-84be-9f8099a557e9` (all succeeded, exit 0).
- Token spend: first task `input=410 output=85,350 cacheRead=29,296,248 cacheWrite=218,454`; continuation `input=246 output=33,173 cacheRead=11,249,010 cacheWrite=151,164`; retention correction `input=158 output=26,395 cacheRead=14,611,386 cacheWrite=214,799`; aggregate `input=814 output=144,918 cacheRead=55,156,644 cacheWrite=584,417`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-040 | `db57a87` implementation, `a27b3cd` research/task record, Host-found correction `9ef6cc0`, correction record `8121110` | Host inspected the source/spec/test diff and rejected the initial implementation because failed/cancelled turns and a full catalogue could grow SDK immutable history without bound. Acceptance followed only after a serialized hard 100-snapshot cap using bounded public SDK listings. Host independently passed `verify-rewind.ts` (20/20), `verify-rewind-search.ts` (7/7), free pty `rewind` (7/7), `completion` (67/67), `verify-frame-budget.ts` (80/80), `verify-help-command.ts` (26/26), `verify-prompt-queue.ts` (28/28), `pnpm typecheck`, full `pnpm test`, and `pnpm build`; plus Trellis archive validation, `git diff --check`, `git show --check`, clean-tree verification, and AGENTS.md size (26,616 bytes < 32 KiB). `/rewind` branches authoritative SDK conversation state into a fresh successor, leaves the source/pointer/workspace unchanged, returns the selected prompt unsent, and explicitly disclaims workspace and side-effect rollback. |

### 2026-08-27 — long-silent TUI OOM investigation

- Child session: `session-20260827-065500019`

| Milestone | Accepted commit | Host acceptance |
| --- | --- | --- |
| Diagnose and fix provider-silent interactive heap growth | not committed (working-tree review requested) | `pnpm typecheck`; `pnpm tsx spike/verify-react-production-memory.ts`; `pnpm tsx spike/verify-startup-screen.tsx`; `pnpm tsx spike/verify-startup-pty.ts`; `pnpm test` |

## Batch 62 — SER-041 clipboard image prompt input

- Origin: `docs/research/research_2026-08-27.md`, run `2026-08-27T12:45:27Z` (rolled `peer` path).
- Child session: `session-20260827-125133864`.
- Managed tasks: `bg-28198ab5-9ffc-4dc1-8932-c30a5287b5d0` (implementation, succeeded, exit 0) and `bg-90e4820b-b04f-496e-896a-8813be8cd12d` (same-session Host-focused provider-rejection correction, succeeded, exit 0).
- Token spend: implementation `input=522 output=59,088 cacheRead=36,976,101 cacheWrite=225,097`; correction `input=68 output=7,706 cacheRead=8,114,753 cacheWrite=21,641`; aggregate `input=590 output=66,794 cacheRead=45,090,854 cacheWrite=246,738`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-041 | `2b04e59` implementation, `152aa7d` task archive, `20b39e3` journal, Host-found correction `f4645d1` | Host inspected the source/spec/test diff and rejected the initial result because an unsupported multimodal provider consumed the only in-memory image. Acceptance followed only after the exact literal prompt and same image were restored for retry/removal without another clipboard read or model call. Host independently passed `verify-runtime-image-input.ts` (5/5), `verify-clipboard-image.ts` (8/8), `verify-image-viewer.ts` (34/34), `verify-prompt-queue.ts` (31/31), free pty `clipboardImage` (14/14), `queue` (17/17), `permissionEscape` (3/3), `compacting` (5/5), `completion` (67/67), `recall` (22/22), `historySearch` (14/14), stream-resumption and help suites, `pnpm typecheck`, full `pnpm test` after Host backlog closure, and `pnpm build`; plus commit/diff checks, clean-tree verification, and AGENTS.md size (28,097 bytes < 32 KiB). The feature uses one ordinary SDK text-plus-`ImageBlock` invocation, shares the bounded path-image decoder, preserves one-image queue ownership, and keeps all durable text records free of image bytes, base64, clipboard contents, and fabricated paths. |


## Batch 63 — SDK HTTP request vended tool

- Origin: direct user request to vend the Strands TypeScript SDK HTTP request tool.
- Child session: `session-20260827-142402874`.
- Managed task: `bg-a1fdcfd9-9b35-462c-bf6a-0c711b816edc` (implementation, workflow records, and commits; succeeded, exit 0).
- Token spend: `input=96 output=15,413 cacheRead=2,764,664 cacheWrite=85,906`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SDK HTTP request vended tool | `ce68299` implementation, `e5ff287` task archive, `b5e6869` journal | Host inspected the source, offline regression, SDK contract, architecture record, and dependency diff; independently passed `spike/verify-http-request-tool.ts` (7/7), full `pnpm test`, `pnpm typecheck`, and `pnpm build`; plus archived Trellis validation, commit whitespace checks, clean-tree verification, and AGENTS.md size (28,548 bytes < 32 KiB). The parent runtime registers the exact SDK `httpRequest` singleton (`http_request`) in its ordinary tool list, leaves it fail-closed as `execute`, blocks it before prompting in plan mode, and does not expose it to children or add another network path. |

## Batch 64 — SER-042 word-wise composer editing

- Origin: `docs/research/research_2026-08-28.md`, run `2026-08-28T13:03:31Z` (rolled `tui` path).
- Child session: `session-20260828-133204010`.
- Managed task: `bg-b260775b-2125-4863-be93-c6e808e24113` (implementation, workflow records, and commits; succeeded, exit 0).
- Token spend: `input=140 output=56,250 cacheRead=7,413,648 cacheWrite=162,421`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-042 | `c32e5f6` implementation, `6c3c7b1` task archive, `bf71a13` journal | Host inspected the source/spec/test diff: `src/tui/prompt-editor.ts` gained pure grapheme-aware word primitives only (`moveWordHorizontal`, `deleteWordAfter`, shared boundary helpers with Ctrl+W's `deleteWordBefore`), and the Alt/Ctrl+Arrow, Alt+B/F, Alt+Backspace/Alt+Delete and Alt+D chords sit after every existing key owner and before the generic ctrl/meta ignore, leaving plain-arrow and unmodified backspace/delete branches byte-identical. Host independently passed `verify-prompt-editor.ts` (43/43), free pty `wordNav` (11/11), `cursor` (5/5), `multiline` (9/9), `completion` (67/67), `recall` (22/22), `recallEmpty` (4/4), `queue` (17/17), `historySearch` (11/11), `pnpm typecheck`, full `pnpm test` (exit 0), and `pnpm build`; plus `git diff --check`/`git show --check`, clean-tree verification, and AGENTS.md size (29,452 bytes < 32 KiB, free-scenario list grown to twelve with `wordNav`). |

## Batch 65 — SER-043 terminal attention bell

- Origin: `docs/research/research_2026-08-28.md`, run `2026-08-28T13:03:31Z` (rolled `tui` path).
- Child session: `session-20260828-140438963`.
- Managed task: `bg-618777c4-abc6-48d8-9e91-2553d9a91f95` (implementation, workflow records, and commits; succeeded, exit 0).
- Token spend: `input=204 output=62,931 cacheRead=12,760,721 cacheWrite=189,449`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-043 | `94909b8` implementation, `e8376df` task archive, `8c379cf` journal | Host inspected the source/spec/test diff: `src/tui/terminal-bell.ts` is the sole BEL writer (enabled writes exactly one raw `\x07` to real stdout, disabled writes nothing, broken stdout swallowed), wired only at the consolidated `cli.ts` permission-publication observer (shared by `/clear`/rewind successors) and `App.tsx` `runTurn` `finally` beside the interactive `TurnComplete` publication; new session-scoped `terminalBell` key defaults `false` with `ConfigError` refusal on non-boolean. Host independently passed `verify-terminal-bell.ts` (14/14 — raw pty holds exactly one BEL per permission publication and per completed turn when enabled, zero when disabled), `verify-config.ts` (248/248), `pnpm typecheck`, full `pnpm test` (exit 0), and `pnpm build`; plus grep proof (no `\x07` outside `terminal-bell.ts`, no tui import from headless/dev-repl/agents), `git diff --check`/`git show --check`, and clean-tree verification. |

## Batch 66 — SER-044 bounded composer undo

- Origin: `docs/research/research_2026-08-28.md`, run `2026-08-28T13:03:31Z` (rolled `tui` path).
- Child session: `session-20260828-144128660`.
- Managed task: `bg-aa391bed-8fe7-4443-bb8f-376022df838a` (implementation, workflow records, and commits; succeeded, exit 0).
- Token spend: `input=222 output=85,804 cacheRead=13,580,240 cacheWrite=196,534`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-044 | `a22d72d` implementation, `fc3351b` task archive, `6e20949` journal | Host inspected the source/spec/test diff: pure bounded primitives (`UNDO_CAP = 16`, `UndoStack`, `pushUndo`, `popUndo`) in `src/tui/prompt-editor.ts`; `App.tsx` snapshots via `applyDestructive` only when a kill/word-delete chord actually changes text, pops on Ctrl+_ (legacy 0x1f byte and kitty ctrl chord, consumed even when empty), and clears the stack at submit, queue take-back/return, recall acceptance, history-search accept, and rewind accept, leaving search/recall snapshot-restore untouched. Host independently passed `verify-prompt-editor.ts` (48/48), free pty `undo` (7/7), `cursor` (5/5), `multiline` (9/9), `wordNav` (11/11), `completion` (67/67), `recall` (22/22), `recallEmpty` (4/4), `queue` (17/17), `historySearch` (11/11), `pnpm typecheck`, and `pnpm build`; plus `git diff --check`/`git show --check`, clean-tree verification, and AGENTS.md size (29,618 bytes < 32 KiB, free-scenario list grown to thirteen with `undo`). The one full-`pnpm test` failure was the documented pre-existing `verify-subagent-heartbeats` timing flake — it passed 21/21 in isolation immediately after and had also flaked at the pre-batch HEAD (`51a051c`'s parent), so it is not attributed to this change. |

## Batch 67 — SER-045 workflow DAG tool on the SDK Graph

- Origin: `docs/research/research_2026-08-30.md`, run `2026-08-30T08:21:38Z` (`sdk` path, `path-source: override (user-directed)`).
- Child session: `session-20260830-083601272`.
- Managed task: `bg-ef70bc59-8467-4efb-8208-c606857695e0` (implementation, workflow records, and commits; succeeded, exit 0).
- Token spend: `input=182 output=88,696 cacheRead=13,198,114 cacheWrite=198,638`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-045 | `cbd2863` implementation, `94d63a9` task archive, `109a956` journal | Host inspected the diff: `src/agents/child-recipe.ts` extracts the one child-construction recipe (`buildRecipeChild` + `stopBashSession`) consumed by both `SubagentTool` (behavior unchanged) and the new `src/agents/workflow-tool.ts` — a parent-only data-only DAG tool (`MAX_WORKFLOW_NODES = 8`, `MAX_WORKFLOW_EDGES = 28`, Kahn cycle refusal and bounded validation errors before any dispatch/model/child exists), executed by the installed SDK `Graph` (`maxSteps = nodeCount`, AND scheduling, dependency merge — never reimplemented) with the parent cancel signal forwarded through one owned `AbortController` into `graph.invoke`, a `finally` sweep settling unstarted dispatches `cancelled`, and only terminus content returned; `runtime.ts` registers it after the child-catalogue capture (parent-only by construction) and `permission.ts` classifies it `read` on the `subagent` precedent with a bounded node listing. Host independently passed `pnpm typecheck`, full `pnpm test` (exit 0, no FAIL lines — `verify-subagent-heartbeats` green in the full run), `spike/verify-workflow-tool.ts` in isolation (32/32: refusals with zero construction, diamond-DAG dependency order and SDK merge, per-node dispatches with heartbeat/provenance/distinct ids, terminus-only result, failure sweep, parent cancellation aborting the unstarted node, registration-order proof, no `toolExecutor`), `pnpm build`, `git diff --check`/`git show --check`, and AGENTS.md size (30,278 bytes < 32 KiB, new Workflow DAG tool row). Documented deviation accepted: no whole-graph `timeout` knob — the run is bounded by the node cap, `maxSteps`, and cancellation, matching every other delegation path. |

## Batch 68 — SRF-019 untrimmed memory quotes with reasoned rejections

- Origin: `docs/reflections/reflection_2026-08-31_session-20260831-011450426.md` (self-reflection run on a harbor-project session).
- Child session: `session-20260831-031847766`.
- Managed tasks: `bg-789ac43e-68bf-4f84-aaf5-4af764216774` (failed on a transient provider error after read-only exploration; `usage: input=16 output=8294 cacheRead=411394 cacheWrite=45120`), retry `bg-7dd4296b-c4e9-43e5-86b7-9c0f5a34e7e1` (same session, implementation, workflow records, and commits; succeeded, exit 0; `usage: input=76 output=23780 cacheRead=4073557 cacheWrite=52220`).
- Token spend (aggregate): `input=92 output=32,074 cacheRead=4,484,951 cacheWrite=97,340`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-019 | `f6d750a` implementation, `e95a15d` task archive | Host inspected the diff: `boundedUntrimmed(max)` in `src/memory/tools.ts` applied only to `evidence.quote`/`userQuote` (other fields keep the trimmed schema); `resolveExactSourceAnchor` returns `{ok:true, anchor}` or `{ok:false, failure}` over a closed six-reason set with every safety check kept in the same order and effect; the controller replaces the single generic rejection with a per-reason message map plus a distinct revalidation message. Host independently re-ran `verify-memory-validation.ts` (20/20), `verify-memory-tools.ts` (15/15), `pnpm typecheck`, full `pnpm test` (zero FAIL lines), `pnpm build`, and a direct `resolveExactSourceAnchor` probe proving an indented unique line anchors while its trimmed variant fails with `no-matching-line`. Pre-batch note: one full-suite flake at HEAD before delegation (and one in the child's first full run, `verify-subagent-heartbeats` timing) matched the documented pre-existing flake and passed in isolation and on clean re-runs. |

## Batch 69 — SER-046 composer chords stated in `/help` and the READMEs

- Origin: `docs/research/research_2026-09-01.md` (run `14:47:59Z`, rolled `tui` self-review path).
- Child session: `session-20260901-150906982`.
- Managed tasks: `bg-2e619bcc-514d-4faf-9ae8-d539e9dfedf0` (implementation, workflow records and commit; succeeded, exit 0; `usage: input=76 output=19780 cacheRead=2319146 cacheWrite=81862`).
- Token spend (aggregate): `input=76 output=19,853 cacheRead=2,319,146 cacheWrite=81,862`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-046 | `1d57aae` implementation | Host inspected the whole diff: `src/tui/help-format.ts` gains exactly two fixed rows naming the shipped SER-042 word chords (Alt/Ctrl+Left/Right, Alt+B/F, Alt+Backspace/Alt+D) and SER-044's Ctrl+_ / Ctrl+- undo, and `MAX_HELP_LINES` becomes the derived `MAX_HELP_COMMANDS + HELP_FIXED_LINES` (24 + 21 = 45, 39 rows emitted) instead of a hand-picked 40 that four more built-in commands would have overrun; `src/tui/App.tsx` is untouched, so no runtime behavior, config key, command or frame surface changed. Both READMEs' input paragraphs and both `docs/user-guide/reference*.md` keyboard tables state the same chords, and the changed contract is recorded in `.trellis/spec/frontend/live-frame.md` plus the `/help` bullet in `tui-testing.md`. Host independently re-ran `spike/verify-help-command.ts` (34/34, up from 27, including the new fixed-line and worst-case-cap assertions), `spike/verify-tui.ts completion` (68/68), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines — the pre-existing `verify-subagent-heartbeats` timing flake seen at HEAD before delegation did not recur), `pnpm build`, and `git status --porcelain` (clean). Documented gap accepted: README↔`help-format.ts` consistency is enforced by a spec obligation and grep, not by the suite, because `verify-help-command.ts` is contractually I/O-free. |

## Batch 70 — SER-047 markdown block vocabulary for lists, quotes and tables

- Origin: `docs/research/research_2026-09-01.md` (run `14:47:59Z`, rolled `tui` self-review path).
- Child session: `session-20260901-152613977`.
- Managed tasks: `bg-382e53bf-387d-4cfe-89fb-c8ff8965eff3` (implementation, workflow records and commit; succeeded, exit 0; `usage: input=92 output=33735 cacheRead=3753299 cacheWrite=81295`).
- Token spend (aggregate): `input=92 output=33,735 cacheRead=3,753,299 cacheWrite=81,295`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-047 | `ff21afd` implementation | Host inspected the whole diff: `src/tui/markdown.ts` adds `list`/`quote`/`table` kinds whose leading structure becomes one dim `marker` span, placed after the fence/code, heading and rule branches so existing winners are untouched; `LIST_ITEM` demands whitespace after the marker, `QUOTE` marks the whole `>`-run, and `TABLE_ROW` requires a row to start *and* end with `|` — the any-pipe heuristic was deliberately dropped (recorded in the commit body, PRD and spec) because it would dim shell pipelines. `MarkdownText.tsx` adds no `spanProps` branch and only extends the `liveRowText` inline rule through `INLINE_KINDS`, keeping the wrapped-row fallback and the boolean `fenceOpenAfter`. Host independently re-ran `spike/verify-markdown.tsx` (129/129, up from 96, including span round-trip, ANSI-strip byte identity and a `formatReplay` byte-identity case over a 17-line structured answer), `spike/verify-visual-language.tsx` (69/69), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build`, `git status --porcelain` (clean), and an own 25-case probe over `markdownLines`: expected kind for every case (`\t- tab` list, `>>x` quote, `|  |` table, `|only`/`x |` prose, `# > t` heading, `-----`/`   ---` rule, `-fast`/`1.2.3` prose), zero span round-trip failures, and fence-internal bullet/quote/table lines all still `code`. Child-reported out-of-scope finding carried forward, not fixed: an empty live row renders as zero Ink rows, so a live block containing a blank line draws one row fewer than `liveTextView` counts (reproducible with plain prose, pre-existing, unrelated to classification) — a candidate for its own direction. |

## Batch 71 — SER-048 CLI `--help`/`--version` and the `--help` hint on usage errors

- Origin: `docs/research/research_2026-09-02.md` (run `02:29:40Z`, rolled `open` self-review path).
- Child session: `session-20260902-024725444`.
- Managed tasks: `bg-42f5b885-0858-465e-8679-3af93420d7e4` (implementation, workflow records and commit; succeeded, exit 0; `usage: input=76 output=31530 cacheRead=3398594 cacheWrite=87958`).
- Token spend (aggregate): `input=76 output=31,530 cacheRead=3,398,594 cacheWrite=87,958`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-048 | `ca7aa7c` implementation; `7c9e5bd` Trellis task archive | Host inspected the whole diff: `src/cli-usage.ts` (new, imports only `version.ts`) owns `CLI_USAGE`, `CLI_HELP_HINT` and `localCliAnswer`; `src/cli.ts` answers help/version before the `sessions`/`trajectory` routes and before `parseCliArgs`, and routes all three `CliUsageError` handlers through one `reportUsageError` (exact message + one hint line + exit 2); the parser and its pinned messages are unchanged. Host independently re-ran `spike/verify-cli-args.ts` (43/43), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build`, `node dist/src/cli.js --help`/`-V`/`--bogus` (grammar exit 0 / `darwin 0.0.1` exit 0 / message+hint exit 2), `git status --porcelain` (clean). Accepted product choice: help/version anywhere in argv wins, including after a subcommand. Child-reported process finding, not a defect in the commit: parallel `str_replace` edits to one file in a single message corrupted `src/cli.ts` once; the child restored it from git and re-applied sequentially before any check ran. Host also notes one pre-delegation flake: the first full `pnpm test` at HEAD `49d7eec` reported `verify-subagent-heartbeats.ts` 35/1, not reproducible alone (36/36) nor on the full rerun (exit 0). |

## Batch 72 — SER-049 unknown config keys refused with a did-you-mean hint

- Origin: `docs/research/research_2026-09-02.md` (run `02:29:40Z`, rolled `open` self-review path).
- Child session: `session-20260902-030515467`.
- Managed tasks: `bg-f45d1e13-5bb5-486d-bd60-b1e1a260bb0a` (implementation, workflow records and commit; succeeded, exit 0; `usage: input=198 output=51400 cacheRead=11707500 cacheWrite=137896`).
- Token spend (aggregate): `input=198 output=51,400 cacheRead=11,707,500 cacheWrite=137,896`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-049 | `8481bab` implementation; `68b4027` Trellis task archive | Host inspected the whole diff: `refuseUnknownKeys()` runs last in `validate()` (after type checks and the misplaced-half refusals, whose messages stay byte-identical), reports every unknown root/entry key in one bounded `ConfigError` with location and an OSA-distance-2 case-insensitive "did you mean", exports `MODEL_KEYS`/`SESSION_KEYS` read-only for the doc walk, and leaves the writers untouched. Host independently re-ran `spike/verify-config.ts` (300/300), `pnpm typecheck`, full `pnpm test` twice (first run: one failure, the pre-existing `verify-subagent-heartbeats` "increasing elapsed heartbeats" wall-clock flake also seen at HEAD `49d7eec` before this direction; confirming run exit 0, zero FAIL lines; suite 3/3 green alone), `pnpm build`, a private-HOME `dist` probe (`thinkingEfort` + `regoin` both named with suggestions, exit 1; valid file loads, effort `high`), `git status --porcelain` (clean). Drift fixed on the way: `terminalBell` documented in neither user-guide table; three suites' forward-compat unknown-key fixtures switched to known keys. Recurring finding for a future run: the heartbeat suite's wall-clock assertion flakes under full-suite load (seen twice this run, plus in Batches 62/68/69 per the child) — a test-stability candidate, not a product defect. |

## Batch 73 — SER-050 piped stdin appended to the `-p` prompt

- Origin: `docs/research/research_2026-09-02.md` (run `02:29:40Z`, rolled `open` self-review path).
- Child session: `session-20260902-034134274`.
- Managed tasks: `bg-8164618f-a90f-4664-b879-8aa12f54276c` (implementation, workflow records and commit; succeeded, exit 0; `usage: input=140 output=55198 cacheRead=8246748 cacheWrite=140811`).
- Token spend (aggregate): `input=140 output=55,198 cacheRead=8,246,748 cacheWrite=140,811`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-050 | `5ca7772` implementation; `1b5059c` Trellis task archive | Host inspected the whole diff: `src/headless-stdin.ts` (pure functions over an injected source; TTY never iterated; empty/whitespace → `undefined`; 256 KiB cap refuses and stops the read; UTF-8/NUL refusal), the runner's injectable `readPipedStdin` in the pre-protocol slot so refusals are plain usage errors in every format, one shared `usageErrorText()`, one added `CLI_USAGE` line mirrored in both reference docs. Host independently re-ran `spike/verify-headless.ts` (182/182), `spike/verify-cli-args.ts` (43/43), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines, no flake this run), `pnpm build`, then live `dist` probes in a throwaway project with `--max-model-calls 1`: piped `alpha beta` appears once in replay inside the fence and in exactly one `userInput` record (model echoed it; `usage: input=4 output=7 cacheRead=0 cacheWrite=17478`); `< /dev/null` produced zero `piped stdin` lines; a 300 000-byte pipe was refused with the cap message + `--help` hint, exit 2; probe state removed. Recorded decision accepted by the Host: refuse over cap rather than truncate. |

## Batch 74 — SER-051 optional focus on `/compact`

- Origin: `docs/research/research_2026-09-02.md` (run `02:29:40Z`, rolled `open` self-review path).
- Child session: `session-20260902-040942462`.
- Managed tasks: `bg-2aeba1f8-6a52-429c-97fc-006179332dfe` (implementation, workflow records and commit; succeeded, exit 0; `usage: input=166 output=48647 cacheRead=10007632 cacheWrite=151162`).
- Token spend (aggregate): `input=166 output=48,647 cacheRead=10,007,632 cacheWrite=151,162`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-051 | `bd050d2` implementation; `4db9405` Trellis task archive | Host inspected the whole diff: two new hunks in the pinned SDK patch re-export `DEFAULT_SUMMARIZATION_PROMPT` from the package root (no deep import, no copied string; lockfile hash updated), `createCompactionManager` builds the manager per call with a two-key unfocused config identical to the old process-lifetime one, focus trimmed/capped at 400 code points and appended under one fixed heading after the SDK default, over-cap refused before hook or model call, `runtime.compact(focus?)`, `App.tsx` local notice, hook payloads unchanged. Host independently re-ran `spike/verify-compact.ts` (52/52), `spike/verify-help-command.ts` (34/34), `spike/verify-tui.ts completion` (68/68), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build`, verified the re-export in the installed `dist/src/index.js`, `git status --porcelain` clean, AGENTS.md 31,537 B. **Acceptance-listed live `verify-tui.ts compacting` did not pass and is recorded as pre-existing, not a regression:** child reproduced the identical 240 s timeout at pre-change `49dd197`; Host proved the cause with a deterministic fake model — `compactConversation` with `preserveRecentMessages: 0` on 2 messages loops forever (SDK summarizes 1 message and splices 1 summary back; 26 summarizer calls before a Host bail-out) and, because `reduce()` is called without `error`, the SDK swallowed the bail-out failure and darwin still returned `compacted: true`. Latent since `780ec93`, masked until `f4e3271`. Queued as SER-052 (Priority 71, Score 14) in this run's report and worked next in the same batch. |

## Batch 75 — SER-052 `/compact` terminates and reports honestly

- Origin: `docs/research/research_2026-09-02.md` (run `02:29:40Z`, rolled `open` self-review path; Host-found during SER-051 acceptance).
- Child session: `session-20260902-044757342`.
- Managed tasks: `bg-37875105-4e7a-489e-a957-249ede571346` (implementation, break-loop analysis, workflow records and commit; succeeded, exit 0; `usage: input=112 output=75136 cacheRead=6158146 cacheWrite=146583`).
- Token spend (aggregate): `input=112 output=75,136 cacheRead=6,158,146 cacheWrite=146,583`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-052 | `618f771` implementation; `87ef668` Trellis task archive | Host inspected the whole diff: no-shrink guard (undo one pass from a shallow snapshot, stop, honest `compacted`), swallowed-`false` treated as failure through the existing restore path, both in the shared loop so focused/unfocused/`--compact-before` inherit them; `compacting` scenario re-seeded to a real `4 → 2` one-pass compaction with a state-exclusive assertion. Host independently re-ran `spike/verify-compact.ts` (70/70), `spike/verify-headless.ts` (182/182), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build`, live `verify-tui.ts compacting` (5/5, 15 s), `git status --porcelain` clean, and an own fake-model probe (2/0: 1 call, no-op; 16/0: 3 calls → 2; 16/10: 1 call → 11; summarizer failure on call 1 or 2: reject + restore). Accepted recorded decisions: preserve-0 floors at two messages; detection over a sentinel `error` (the SDK would overwrite `.cause` with a fabricated overflow that `failureFromError` reads). |

## Batch 76 — SRF-020 same-path `fileEditor` edits applied in call order

- Origin: `docs/reflections/reflection_2026-09-02_session-20260902-054329719.md` (self-reflection on the anthropic base-url session; the six-edit clobber of `src/config.ts`).
- Child session: `session-20260902-084626799`.
- Managed tasks: `bg-e298944d-c2dc-4a4e-bbe0-477b6bf82c18` (implementation, Trellis task, spec/doc/AGENTS.md updates, commit and archive; succeeded, exit 0; `usage: input=128 output=44779 cacheRead=7147548 cacheWrite=143441`, `model-calls: calls=63`).
- Token spend (aggregate): `input=128 output=44,779 cacheRead=7,147,548 cacheWrite=143,441`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-020 | `960885e` implementation; `31d858d` Trellis task archive | Host inspected the whole diff: `src/tools/file-editor-serial.ts` (`SerializedFileEditorTool` — same `name`/`description`/`toolSpec` object, `yield*` of the SDK `stream()`, per-Agent `WeakMap` chains keyed by `context.agent`, `mutationKey` = `create`/`str_replace`/`insert` on an absolute `path.resolve`d path, `finally` release + settled-tail delete), substituted in the `tools:` list in `runtime.ts` so `childTools` carries the wrapper to every child, `toolExecutor` untouched; Host confirmed the SDK executor's `generator.return()` on cancel (`executors/executor.js:28`, `concurrent.js:109`) reaches the `finally`, so an abandoned edit cannot wedge a path. Host independently re-ran `spike/verify-file-editor-serial.ts` (45/45; unwrapped control keeps 1/6 edits while reporting six successes), `spike/verify-file-editor.ts` (63/63, unchanged), `spike/verify-edit-diff.ts` (96/96), `spike/verify-codegraph-preflight.ts` (14/14), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build` (wrapper present in `dist/src/agent/runtime.js`), AGENTS.md 32,412 B, then a live `dist` probe in a throwaway project (`--yolo --max-model-calls 2`): six `str_replace` calls on one file in one message, **6/6 landed** (`ALPHA-1 … ZETA-6`), turn 19 s, `spend input=6 output=1026 cacheRead=17781 cacheWrite=19810`; probe state removed. Observed on the way, not a defect of this commit: the probe process spent ~2.5 min before `runStarted` starting the global `~/.darwin/mcp.json` servers in a project with none of its own. Child-reported process slip: PRD checkboxes flipped via a `python3` heredoc rather than `fileEditor` — the exact habit SRF-021 (next in this batch) targets. |

## Batch 77 — SRF-021 system-prompt rule 8 states the same-message edit contract

- Origin: `docs/reflections/reflection_2026-09-02_session-20260902-054329719.md` (F2/F3: the six-edit clobber that followed the old rule 8 verbatim, then heredoc/inline-Python writes with no edit diff or `fileEditor` record).
- Child session: `session-20260902-091357310`.
- Managed tasks: `bg-6ef97d35-be06-4125-bd36-307e112049f3` (implementation, PRD-only Trellis task, doc note, commit and archive; succeeded, exit 0; `usage: input=66 output=19595 cacheRead=2132219 cacheWrite=70151`, `model-calls: calls=32`).
- Token spend (aggregate): `input=66 output=19,595 cacheRead=2,132,219 cacheWrite=70,151`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SRF-021 | `21b8e6c` implementation; `44f8529` Trellis task archive | Host inspected the whole diff: one hunk in `src/agent/system-prompt.ts` (rule 8 only, `@@ -91,5 +91,11 @@`; rules 1–7 and all other lines byte-identical), stating call-order same-file edits, overlapping = one edit, verification never in the edit message, `fileEditor` over heredocs/`sed -i`/inline Python/`tee`, and `create`-refuses-existing → `view` then `str_replace`; `spike/verify-working-context.ts` `workingMethodRules()` (9 assertions incl. exact eight-rule count and old-phrase absence); one paragraph in `load-bearing-decisions.md` § System prompt composition; AGENTS.md/spec untouched (Host grep: old sentence absent from all three). Host independently re-ran `spike/verify-working-context.ts` (54/54), `spike/verify-system-prompt.ts` (43/43), `pnpm typecheck`, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build` (new text present in `dist/src/agent/system-prompt.js`), live `spike/verify-prompt-cache-live.ts` (8/8: turn 1 write 16006/read 0, turn 2 read 16006), `git status --porcelain` clean apart from the Host-owned backlog page. Accepted soft-budget decision: rule 8 is 10 lines (was 4). Process note: the child followed the rewritten rule while writing it (fileEditor-only mutations, `view` then `str_replace` on the scaffolded PRD, verification in its own message). |

## Batch 78 — SER-053 mutating options on whitelisted bash commands are no longer "read-only"

- Origin: `docs/research/research_2026-09-02.md` run `09:37:20Z` (user-directed `peer` path: Claude Code tools reference; offline probe showed `find … -delete`, `find … -exec rm {} \;`, `git branch -D/-m`, `git diff/log --output=` classified `safe` and running unprompted in `default`/`auto`).
- Child session: `session-20260902-095357955`.
- Managed tasks: `bg-7edbe478-2380-4ce8-9414-debb1d43d9e5` (implementation, Trellis task, spec/docs, commit and archive; succeeded, exit 0; `usage: input=48 output=19567 cacheRead=1592920 cacheWrite=78013`, `model-calls: calls=23`).
- Token spend (aggregate): `input=48 output=19,567 cacheRead=1,592,920 cacheWrite=78,013`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-053 | `14378bc` implementation; `c5dcd39` Trellis task archive | Host read the whole `src/agent/permission.ts` diff: three option sets (`MUTATING_FIND_OPTIONS`, `MUTATING_GIT_BRANCH_SHORT_FLAGS`/`_LONG_OPTIONS`, `GIT_OUTPUT_SUBCOMMANDS`) and `mutatingGitOption()`; `assessBashRisk` scans every token of a whitelisted segment after the first-word check, combined short flags char-by-char, `--opt=value` on the part before `=`; the two whitelist sets, the metacharacter check, `permission-rules.ts` (0 lines in the diff), the `auto` classifier and `plan` denial are untouched. Host independently re-ran its own 25-command `classify`+`assessRisk` probe (six original escapes plus `-Df`/`-fD`/`--set-upstream-to=`/`-u`/bare `find -delete`/piped and `&&`-chained segments all `dangerous` with the option named; `ls -la`, `rg foo \| head -5`, `git branch --show-current`/`-a`/`-avv`, `git diff --stat`, `git show HEAD --stat`, `find . -name "*.ts"`, `git log --oneline -5` still `safe`), `spike/verify-permission-modes.ts` (154/154, was 109), `pnpm typecheck` (exit 0), full `pnpm test` (exit 0, zero FAIL lines), `pnpm build` (exit 0, `MUTATING_FIND_OPTIONS` present in `dist/src/agent/permission.js`), `git status --porcelain` clean; docs: `permissions.md`/`.zh-CN` static-safety row, spec `#### Static bash safety`, one sentence in load-bearing § Permissions; AGENTS.md unchanged (32,412 B). Child self-reported a rule-8 slip (PRD checkboxes ticked via `python3 - <<EOF`); result correct, noted. Follow-up candidate recorded by the child, out of this direction's scope: bare `git branch <name>` (positional create) and `git branch -t <name>` still classify `safe`. |

## Batch 79 — SER-054 a foreground bash timeout keeps the captured output and states the shell's state

- Origin: `docs/research/research_2026-09-02.md` run `09:37:20Z` (user-directed `peer` path: Claude Code tools reference; the pinned bash session rejected a timeout with a one-line message, discarding captured stdout/stderr and killing the shell silently).
- Child session: `session-20260902-101002155`.
- Managed tasks: `bg-ca0ec822-9eba-48b8-991e-80e741653b7c` (implementation via `pnpm patch`/`patch-commit`, spike, spec/docs, Trellis task, commits and archive; succeeded, exit 0; `usage: input=114 output=43099 cacheRead=6091600 cacheWrite=132193`, `model-calls: calls=56`).
- Token spend (aggregate): `input=114 output=43,099 cacheRead=6,091,600 cacheWrite=132,193`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-054 | `0255368` implementation; `772187e` Trellis task archive; `fdab9c2` journal | Host read the whole patch diff: `TIMEOUT_TAIL_LIMIT` (64 KiB, stated as mirroring `OUTPUT_LIMIT`), multi-byte-safe `boundedTail`, `describeTail` with the background projection's `hasMore: true` vocabulary, the timeout handler building `BashTimeoutError` with `output`/`error`/`cwd`/`timeoutSeconds` and the ordered message, `stop()` resetting the tracked cwd to the initial cwd, and the four declared fields in `types.d.ts`; `src/` untouched (the SDK's `createErrorResult` turns the message into the tool result verbatim, no second channel); `pnpm-lock.yaml` patch hash updated. Host independently ran a throwaway probe through `createForegroundBashTool` (`cd /tmp && echo before-out; echo before-err 1>&2; sleep 5`, `timeout: 1`): `BashTimeoutError` with `output "before-out"`, `error "before-err"`, `cwd` = project root, `timeoutSeconds 1`, message in the required order, and the very next `pwd; echo ok` ran in the project root with exit 0; `TIMEOUT_TAIL_LIMIT` present in the installed `bash.js`; `spike/verify-background-bash.ts` 157/157 (was 142); `pnpm typecheck` exit 0; full `pnpm test` exit 0, zero FAIL lines; `pnpm build` exit 0; `git status --porcelain` clean. Spec: timeout paragraph + matrix row + required-assertion list in `strands-sdk-contracts.md`, `error-handling.md` row no longer says "not our code path", one sentence in load-bearing § Process exit; AGENTS.md unchanged (32,412 B). Accepted addition beyond the letter: `stop()` cwd reset, so the wrong-root preflight of the first post-timeout command judges against the shell that will run it. Not run: live `tui bashExit`/`cancelThenContinue` (kill path unchanged apart from message and cwd reset). |

## Batch 80 — SER-056 parent-only `web_fetch`: a bounded readable projection of a web page

- Origin: `docs/research/research_2026-09-02.md` run `09:37:20Z` (user-directed `peer` path: Claude Code `WebFetch`; the same run's `http_request` fetch of the tools-reference page returned 656 KB of raw HTML and needed a second round to read).
- Child session: `session-20260902-103415340`.
- Managed tasks: `bg-e4bf96cd-e1ee-4393-9715-332c8448ef30` (implementation, new suite, spec/docs, Trellis task, commits, archive and build; succeeded, exit 0; `usage: input=124 output=75459 cacheRead=7686325 cacheWrite=165771`, `model-calls: calls=61`).
- Token spend (aggregate): `input=124 output=75,459 cacheRead=7,686,325 cacheWrite=165,771`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-056 | `d14b27c` implementation; `980fc6c` journal; `58965f8` Trellis task archive | Host read the diff: new `src/tools/web-fetch.ts` (`tool()` factory; `normalizeWebFetchUrl`, `fetchWebPage` with `redirect: 'manual'`, same-host follow ≤ 5 hops, cross-host reported; `htmlToText`, `decodeEntities`, `boundCodePoints`; ceiling 40 000 code points, 4 MiB download cap, 30 s timeout, own `AbortSignal.any([timeout, cancelSignal])`; never imports `httpRequest`); `src/agent/runtime.ts` registers `webFetch` after `httpRequest` and promotes the child filter to `PARENT_ONLY_TOOL_NAMES = {retrieve_offloaded_content, http_request, web_fetch}`; `spike/verify-web-fetch.ts` (73 assertions, local `http.createServer` fixture, no external network) listed in `run-tests.ts`; `permission.ts`, `verify-http-request-tool.ts`, `package.json`, `pnpm-lock.yaml` untouched (0-line diffs). Host independently ran two real-network probes through `fetchWebPage`: `http://code.claude.com/docs/en/tools-reference` with `maxChars: 3000` → upgraded to https, `text/markdown` via content negotiation, `[truncated: 3000 of 105823 code points]`; `https://example.com/` → readable text with the lossy notice; `https://github.com/xiehust/strands-darwin/raw/main/README.md` → 302 reported, not followed (`raw.githubusercontent.com` differs). Re-ran `verify-web-fetch.ts` 73/73, `verify-http-request-tool.ts` 7/7, `pnpm typecheck` exit 0, full `pnpm test` exit 0 with zero FAIL lines, `pnpm build` exit 0 (`dist/src/tools/web-fetch.js`), tree clean. Docs: `reference.md`/`.zh-CN` "Web access tools" section, spec `web_fetch` contract beside `http_request`, load-bearing section, AGENTS.md row extended by one clause (32,578 B, under the 32 KiB cap; 190 B headroom). **Accepted spec/code repair found by the child:** `childTools` filtered only `retrieve_offloaded_content`, so children had been receiving `http_request` despite AGENTS.md, the load-bearing doc and the spec matrix all stating parent-only; the set now enforces the documented invariant — a project agent definition naming `http_request` in `tools` would surface in `agentProblems` (none in this repo or the user's global dirs do). Not run: a live TUI prompt for `web_fetch` (classification proven offline as `execute` with the URL in details). |

## Batch 81 — SER-055 optional `replace_all` on `fileEditor str_replace`

- Origin: `docs/research/research_2026-09-02.md` run `09:37:20Z` (user-directed `peer` path: Claude Code `Edit` `replace_all: true`; darwin's `str_replace` refused multiple occurrences and rule 8 forbids `sed -i`, so bulk renames were N gated calls).
- Child session: `session-20260902-110209882`.
- Managed tasks: `bg-8d0298ff-9e5b-4151-b769-2b815d59f029` (implementation via `pnpm patch`/`patch-commit`, four spikes, spec/docs, Trellis task, commits, archive and build; succeeded, exit 0; `usage: input=150 output=58126 cacheRead=11238714 cacheWrite=232664`, `model-calls: calls=74`).
- Token spend (aggregate): `input=150 output=58,126 cacheRead=11,238,714 cacheWrite=232,664`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-055 | `4c40426` implementation; `8af72c6` journal; `23a56ce` Trellis task archive | Host read the diff: patched `file-editor.js` schema gains `replace_all: z.boolean().optional()` (str_replace only), `handleStrReplace`/`buildStrReplaceResult` take `replaceAll`, the uniqueness throw is skipped only when set, all non-overlapping `findOccurrences` hits are spliced in one pass and one write, the result names count and pre-edit line numbers plus one snippet; `types.d.ts` `replace_all?`; `src/tui/edit-diff.ts` `REPLACE_ALL_ROW = 'replace_all: every occurrence'` as an input-derived header row (stat and markers untouched, `fileEditorReplaceAll()` exported), `tool-detail-presentation.ts` prepends it to the compact finished row, `permission.ts` adds a `Replace all: every occurrence` detail after `Operation` (kind/summary unchanged); `pnpm-lock.yaml` patch hash only. Host independently ran a throwaway probe through `SerializedFileEditorTool.stream()` on a real temp file with three `foo`s: without the flag → today's exact `Multiple occurrences of old_str \`foo\` in lines [1,3,4]` error; `replace_all: true` → success naming `3 occurrences … at lines [1,3,4]` and the file reads `qux one\nbar\nqux two\nbaz qux\n`; `replace_all: true` miss → today's exact miss advisory; `classify` details carry `Replace all: every occurrence`; projection prints the header row above the one `- qux`/`+ foo` pair. Re-ran `verify-file-editor.ts` 89/89, `verify-file-editor-serial.ts` 50/50, `verify-edit-diff.ts` 112/112, `verify-visual-language.tsx` 74/74, `verify-export-command.ts` 32/32, `pnpm typecheck` exit 0, full `pnpm test` exit 0 with zero FAIL lines, `pnpm build` exit 0 (`replace_all` in `dist/src/tui/edit-diff.js`), tree clean. Docs: spec SER-055 contract + two corrected sentences, `tui-testing.md` diff contract, load-bearing File-edit diffs/Same-path sections, `reference.md`/`.zh-CN` "File edits", AGENTS.md FileEditor row +1 clause (32,667 B — 101 B under the 32 KiB cap; the next AGENTS.md row must go to the load-bearing doc). Child self-reported one rule-8 slip (journal whitespace trim via `python3`). Follow-up recorded by the child, out of scope: `validatePortableToolInput` (`src/hooks/tool-hooks.ts`) does not list `replace_all`, so a Codex `PreToolUse updatedInput` carrying it is refused fail-closed. |

## Batch 82 — SER-057 `/copy` the last completed answer to the clipboard

- Origin: `docs/research/research_2026-09-02.md` run `14:43:25Z` (rolled `peer` path: Codex `/copy` and Gemini CLI `/copy` with OSC 52 over SSH; darwin read the clipboard for images but never wrote it, and selecting text out of a wrapped Ink transcript over SSH was the friction).
- Child session: `session-20260902-151008260`.
- Managed tasks: `bg-ff85a637-c79a-4578-acbc-f72e37c3854e` (first worker; created the Trellis task dir and read the TUI sources, then failed with a transient provider `ModelError: terminated`, exit 1; `usage: input=66 output=18746 cacheRead=2777085 cacheWrite=132005`, `model-calls: calls=32`); `bg-f3c55c0f-dac5-4a2b-b02f-f93d1de7f40f` (same-session retry of the same turn; implementation, unit suite, pty scenario, docs/specs, Trellis task, three commits, archive and build; succeeded, exit 0; `usage: input=114 output=40428 cacheRead=10456352 cacheWrite=87900`, `model-calls: calls=56`). No correction turn.
- Token spend (aggregate): `input=180 output=59,174 cacheRead=13,233,437 cacheWrite=219,905`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-057 | `00c5b90` implementation; `9ab77a8` journal; `5d5ac85` Trellis task archive | Host read the 18-file diff: new `src/tui/copy-command.ts` (`latestCompletedAnswer` over `AnswerPart` pieces joined like `formatReplay`, in-progress answers skipped; `boundCopyPayload` at `MAX_COPY_BYTES = 262_144` on a code-point boundary with `copied N of M bytes`; `osc52Sequence`; `clipboardCopyCommand` only for macOS/`WAYLAND_DISPLAY`/`DISPLAY`; `writeClipboardCommand` 5 s timeout, never rejects), `/copy` handled in `App.tsx` above the busy guard through a render-time `historyRef` and Ink's own `writeToTerminal`, `copy` in `BUILTIN_COMMAND_NAMES`, `MAX_COMPLETIONS` 21, `HELP_FIXED_LINES` 22, `verify-frame-budget.ts` fixture now derived from the cap. Re-ran at `5d5ac85`: `pnpm typecheck` (exit 0), full `pnpm test` (exit 0, no `FAIL` line), free pty `copy` (16), `completion` (69), `pathCompletion` (27), `spike/verify-copy-command.ts` (41), `spike/verify-help-command.ts` (35), `pnpm build` (exit 0), `git show --check` clean on all three commits, tree clean, AGENTS.md untouched at 32,667 B. No model call needed for acceptance. |

## Batch 83 — SER-058 `darwin doctor`, an offline read-only diagnostics verb

- Origin: `docs/research/research_2026-09-02.md` run `14:43:25Z` (rolled `peer` path: `claude doctor` "read-only … without starting a session", `codex doctor`, DeepSeek `dsh --dump-config`; darwin surfaced config/MCP/skills/hooks problems only by starting a session).
- Child session: `session-20260902-154331847`.
- Managed tasks: `bg-77134106-0a2a-463d-b787-59a6078a2231` (implementation, two loader refactors, spike suite, docs/specs, Trellis task, three commits, archive and build; succeeded, exit 0; `usage: input=234 output=75649 cacheRead=16452422 cacheWrite=186902`, `model-calls: calls=115`). No retry, no correction turn.
- Token spend (aggregate): `input=234 output=75,649 cacheRead=16,452,422 cacheWrite=186,902`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-058 | `b68851f` implementation; `ac59842` journal; `7b680bb` Trellis task archive | Host read the 17-file diff: new `src/cli-doctor.ts` (nine sections, `! ` problem lines totalled, exit 0/1, `lookupOnPath` instead of any spawn), dispatch in `cli.ts` before the runtime path, `CLI_USAGE` row; `config.ts` pure `configFilePath()` so readers stop `mkdirSync`-ing `~/.darwin` (writers keep `configPath()`), `mcp/registry.ts` `readMcpServerConfigs` extracted with `loadMcpClients` rebuilt on it. Re-ran at `7b680bb`: `pnpm typecheck` (exit 0), full `pnpm test` (exit 0, 86 suites, 0 `FAIL`), `spike/verify-doctor-command.ts` (71), `spike/verify-cli-args.ts` (43), free pty `mode` (25) and `completion` (69), `pnpm build` (exit 0), `git show --check` clean on all three commits, tree clean, AGENTS.md untouched at 32,667 B. Host's own probe: `HOME=$(mktemp -d) pnpm tsx src/cli.ts doctor` → exit 0, HOME left empty; grepped every `~/.darwin` writer (`session.ts`, `trajectory/writer.ts`, `memory/state.ts`, `diagnostics.ts`) — all `mkdir recursive`, so the dropped read-side mkdir cannot break a fresh HOME. `node dist/src/cli.js doctor` in this repo: exit 0, `no problems found`. No model call needed for acceptance. |

## Batch 84 — SER-059 Esc Esc on an idle composer opens the `/rewind` chooser

- Origin: `docs/research/research_2026-09-02.md` run `14:43:25Z` (rolled `peer` path: Codex "Press Esc twice with an empty composer to edit the previous user message", Gemini CLI `/rewind` "Press Esc twice as a shortcut"; darwin's Escape did nothing visible on an empty idle composer and `/rewind` was reachable only by typing it).
- Child session: `session-20260902-162118803`.
- Managed tasks: `bg-9ccfafad-ae61-43f6-b768-642031831b2a` (implementation, `escRewind` pty scenario, help row, docs/specs, Trellis task, three commits, archive and build; succeeded, exit 0; `usage: input=140 output=54819 cacheRead=9108835 cacheWrite=158621`, `model-calls: calls=69`). No retry, no correction turn.
- Token spend (aggregate): `input=140 output=54,819 cacheRead=9,108,835 cacheWrite=158,621`.

| Direction | Accepted commits | Host acceptance |
|---|---|---|
| SER-059 | `5eea0e4` implementation; `23b0c26` journal; `a915f03` Trellis task archive | Host read the 17-file diff: `ESCAPE_REWIND_CHORD_MS = 500` in `rewind-search.ts`; `/rewind` body extracted into one `openRewindChooser()` that the command and the chord both call; a `useRef` armed timestamp cleared at the top of `useInput` by every key and re-armed only by the composer's Escape branch when idle, queue empty and draft empty; `key.meta` treats two ESC bytes in one chunk as both presses; adjacent fix — a refused `/rewind` now clears its draft (pinned by `a refused /rewind leaves an empty draft`); `HELP_FIXED_LINES` 23 with the window interpolated. Re-ran at `a915f03`: `pnpm typecheck` (exit 0), full `pnpm test` (exit 0, 86 suites, 0 `FAIL`), free pty `escRewind` (20), `rewind` (7), `completion` (69), `recall` (22), `historySearch` (11), `undo` (7), `wordNav` (11), `spike/verify-help-command.ts` (36), `pnpm build` (exit 0), `git show --check` clean on the feature commit (journal commit: one cosmetic blank line at EOF), tree clean, AGENTS.md untouched at 32,667 B. No model call needed for acceptance. |
