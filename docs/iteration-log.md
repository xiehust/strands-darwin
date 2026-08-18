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
