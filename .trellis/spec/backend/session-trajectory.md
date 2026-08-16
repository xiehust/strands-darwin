# Session Trajectory (append-only record, search, fork, replay)

> The durable record of what a session *did*, as opposed to the snapshot of what a session *is*.
> Established 2026-08-16 (backlog direction `SER-003`). Every rule here is asserted by
> `spike/verify-trajectory.ts`, which makes no model calls and needs no network.

---

## 1. Why a second file at all

`SessionManager` already persists a snapshot, and `--resume` restores it. A snapshot is the **end
state** of a conversation: the messages that survived summarization, as the model will next see them.
It cannot answer "what did the agent run in that session", it is rewritten on every turn, and
reading it tells you nothing about tool calls whose results were later compacted away.

The trajectory is the complement: **append-only**, **observational**, and never authoritative. The
snapshot remains the only thing `resume` and `fork` restore from. Nothing in darwin reads the
trajectory to build context, and the model never sees it.

## 2. Where it lives

```
~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl
```

`trajectoryPath(projectRoot, sessionId)` in `src/agent/session.ts` derives it — the same file that
owns `sessionPaths()`, and the same per-session sibling convention already used by
`<session-id>/background/` (`BackgroundBashManager`) and `<session-id>/offload/` (the context
offloader). `process.cwd()` is read only in the entry points; everything here takes `projectRoot`.

The file is created **lazily, on the first recorded turn of a process**. A session that starts and
exits without a turn leaves nothing behind, exactly as `markResumable()` writes no pointer until a
turn completes.

Recording is on by default and switched off with `trajectory: false` in `~/.darwin/config.json`. It
is a session key (`SESSION_KEYS`), so `/model` preserves it and a `models` entry carrying it is
rejected. Unlike `contextOffload` this changes nothing the model sees, which is why it defaults on
while that one defaults off.

## 3. Record format

JSONL: one JSON object per line, UTF-8, LF-terminated, opened `'a'`. Every record carries the
envelope `{"v":1,"seq":<n>,"t":"<ISO>","turn":<n>,"type":"<t>"}`.

| `type` | Payload |
|---|---|
| `runStarted` | `session`, `agentId`, `darwinVersion`, `provider`, `model`, `permissionMode`, `thinkingEffort`, `resumed`, `restoredMessages`, `pid` |
| `userInput` | `text` — the string actually handed to `agent.stream()`, so a slash command appears **expanded**, because that is what the model received |
| `contentBlockEvent` | the SDK event's own `toJSON()`, capped. `reasoningBlock` is recorded as presence only |
| `beforeToolCallEvent` | `toolUse` (id, name, input), capped |
| `afterToolCallEvent` | `toolUse` plus `result` (status, content), capped |
| `agentResultEvent` | the SDK event's own `toJSON()`: `stopReason` plus `lastMessage`. Carries **no** `metrics` — see the contract below |
| `turnEnded` | `stopReason`, `ms`, `recorded` per type, `dropped` per type, `partialText` when the turn ended with unflushed assistant text, `failure` when the turn's stream **threw**, and `spend` when the token meter could be read |
| `forkedFrom` | `session`, `seq`, `bytes` — the first line appended to a **fork**, never to the source |
| `recordingStopped` | `reason`: `budget` or `error` |

### Contract: the event vocabulary is the SDK's, and `toJSON()` is the seam

Records reuse the SDK's own `event.type` strings and its own `toJSON()` projection. Measured on
`@strands-agents/sdk@1.12.0`: every stream event class declares
`toJSON(): Pick<Event, 'type' | …>` and **excludes `agent` and `invocationState`** — so
`JSON.stringify(event)` cannot drag the live `Agent`, its whole message list, or arbitrary
per-invocation objects into the file. Do not hand-roll a projection from event fields; that would
have to be re-audited every SDK upgrade.

### Contract: the record is deliberately lossy, and says so

Only the allowlist above is recorded. Dropped: `modelStreamUpdateEvent` (thousands of token deltas
per turn, superseded by the assembled `contentBlockEvent`), `messageAddedEvent` (duplicates already
recorded content), `before/afterModelCallEvent`, `before/afterToolsEvent`, `beforeInvocationEvent`,
`toolStreamUpdateEvent`, `interruptEvent`. Every dropped event is **counted by type** into
`turnEnded.dropped`, so a reader can always see what the file does not contain. A record that hid
its own omissions would be worse than no record.

Because deltas are not recorded, the recorder accumulates assistant text deltas itself (bounded) and
writes `turnEnded.partialText` when a turn ends with text that never reached an assembled block —
that is exactly what `flushLiveText` in `src/tui/turn-state.ts` puts in live history for a cancelled
turn.

Reasoning content is **never** recorded, at any effort level: only the fact that a reasoning block
occurred. The reply is the record; the model's private deliberation is not.

### Contract: how a turn ended is readable from its closing line alone

`recordStream` closes every turn from a `finally`, so a turn that threw is closed too. What that
line says has to be enough on its own — a reader with only the file must not have to guess:

| Outcome | Signature on `turnEnded` |
|---|---|
| `clean` | `stopReason` is a string other than `'cancelled'` (`'endTurn'`, `'toolUse'`, …) |
| `cancelled` | `stopReason: 'cancelled'`, no `failure` |
| `failed` | `failure` present |
| `abandoned` | neither — the consumer stopped reading before a result arrived |

`turnOutcome()` in `src/trajectory/record.ts` is the **one** implementation of that reading;
`list`, `replay` and the tests all use it, so they cannot drift into three answers.

`failure` is `{ name, message, cause? }`, every string capped like any other field with the
truncation recorded on the same record:

```json
"failure":{"name":"ModelError","message":"Authentication failed: …","cause":"AccessDeniedException"}
```

Three decisions inside that shape are load-bearing:

- **`stopReason` stays `undefined` on a failed turn** rather than being set to `'failed'`. A thrown
  turn never emits `agentResultEvent`, and `stopReason`'s contract is the SDK's own stop reason;
  inventing a value no provider produced would put a fiction in the field a reader trusts most.
  The presence of `failure` is what makes a failed turn a failed turn.
- **`cause` exists because the SDK wraps.** `Model.streamAggregated` rethrows a `ModelError`
  untouched but wraps anything else in `new ModelError(message, { cause })`, and `BedrockModel`
  passes AWS service exceptions through — so a real provider rejection arrives as `ModelError`
  with the provider's class only on `.cause`. Without `cause`, every live provider failure in the
  file would read as an indistinguishable `ModelError`. The cause's *message* is not stored: the
  wrapper copied it, so the class is the only fact wrapping loses.
- **A consumer-side error is recorded as `abandoned`, not `failed`.** If the `for await` body
  throws (a renderer bug, say), JavaScript delivers that to the generator as a `return` completion:
  the `finally` runs, the `catch` does not, and the turn is recorded as abandoned. That is what it
  is — the turn did not fail, the reader left — and pretending otherwise would blame the provider
  for darwin's own bug.

No stack traces, ever: a trace names local paths and build layout, and the class plus the message
is what identifies a failure.

The failure is **not** a second notice in the TUI. `runTurn` already shows `turn failed: <message>`
live; the record exists so the same fact survives the process, and `replay` reconstructs that
notice rather than inventing a second rendering of it.

### Contract: what a turn cost is on the line that closes it, and unknown is never zero

`turnEnded.spend` is the turn's token spend, in the four mutually exclusive buckets
`src/agent/usage.ts` defines, plus the provider and model that incurred them:

```json
"spend":{"provider":"bedrock","model":"global.anthropic.claude-opus-5","input":412,"output":1350,"cacheRead":130961,"cacheWrite":398}
```

**Why the record needed this at all**, stated precisely because the imprecise version is easy to
repeat: some token counts already reached disk before this field existed. `AgentResult.toJSON()`
drops `metrics` by design, but `Message.toJSON()` keeps `metadata`, so a recorded `agentResultEvent`
contains `result.lastMessage.metadata.usage` — the provider's counters for the **final model call**
of the turn. What no file could answer was anything *turn-scoped*: a multi-cycle turn's earlier
calls (the events carrying them are dropped by the allowlist), and any spend at all for a **failed
or cancelled** turn, neither of which emits `agentResultEvent`. Hence a turn-scoped field, and hence
its name: `spend`, not `usage`, so that two different numbers in one file are not both called usage.

Five rules hold, and each of them is a way of not lying:

- **An unreported metric is an absent key.** Never `0`. The SDK leaves `cacheReadInputTokens` /
  `cacheWriteInputTokens` `undefined` until a provider reports them, and OpenAI Responses cannot
  split uncached `input` when either subset is missing. A **reported** zero stays present as `0`:
  "the provider did not report this" and "this was zero" are different facts, and both reach the
  report intact (`-` versus `0`). `input`/`output` are always reported by every provider the SDK
  supports, so a `0` there is a measurement — what a turn whose first call was rejected really was
  billed.
- **A whole absent `spend` is unknown**, and there are exactly three ways to get one: a record
  written before the field existed, a session recorded with `trajectory: false` (no record at all),
  and a meter that could not be read. No reader may turn any of them into a zero-cost turn.
- **A failed turn carries `spend` *and* `failure`.** The tokens of the calls that completed were
  billed whether or not the turn finished. So does a cancelled turn.
- **Attribution is per turn, on the same line.** `provider`/`model` come from the config in effect
  for that turn, so a `/model` switch mid-session cannot leave one total silently averaging two
  price lists. It is exact rather than approximate: `/model` is gated behind the TUI's busy check,
  so a switch cannot land inside a turn. `model` is capped like any other configuration-controlled
  string, with the cut recorded in the same record's `trunc[]`.
- **`spend` means "what the SDK's meter attributed to this turn", not "what the provider billed".**
  Summarization — overflow reduction and `/compact` — calls `model.streamAggregated` directly,
  bypassing `Agent._invokeModel`, so its tokens never enter `agent.metrics` and therefore appear in
  neither the record nor `/usage`. A pre-existing property of the meter, written down here rather
  than papered over; a second metering path is its own decision, not a detail of this one.

**Duration is already there.** `turnEnded.ms` is how long the turn took, so nothing new is needed
for it. Model latency (`AgentMetrics.accumulatedMetrics.latencyMs`) is deliberately **not** recorded:
it is an accumulator that starts at zero and only grows when a provider reports latency, so a
recorded `latencyMs: 0` would mean both "no model call completed" and "the provider said nothing" —
exactly the ambiguity every other rule in this section exists to remove.

**Where the number comes from, and when.** `startTurnSpend` (`src/agent/usage.ts`) captures the
meter before the turn and projects `deltaUsage` through `usageBuckets`; `AgentRuntime.send` hands
that one meter to `beginTurn`, and `TurnRecording.end()` reads it while composing the closing
record. The ordering is the reason: `recordStream`'s `finally` closes and buffers `turnEnded`
**before** `send`'s `finally` runs, so a number produced in `send` after the stream would always be
one step too late for the record — and a *write* there would sit on the error path, where a throw
would replace the provider's error object with the recorder's. The same `before` snapshot feeds
`lastTurnDelta`, so the record and `/usage` cannot become two readings of one turn.

Reading the meter is subject to the observer contract like everything else: `read()` cannot throw
(and `end()` guards it anyway), a meter that fails costs the spend field only — not the turn, not
the rest of the record, and not the session's recording — and the failure is not surfaced as a
notice, because the record already says what it knows by saying nothing.

`/usage` stays **process-scoped** and must not start reading the record. The live meter may not
depend on an observational artifact, and one report mixing "this process" with "this file" would
mislead about both.

## 4. Caps

| Cap | Value | Why |
|---|---|---|
| per string field | 8,000 code points | A long assistant answer (~2k tokens) survives whole; a whole-file `fileEditor view` result or a 100k-line log does not |
| per record | 64 KiB serialized | The bound background `bash output` already uses. A record still over it after field capping keeps its envelope and replaces the payload with `{"dropped":"record-too-large","bytes":<n>}` |
| per file | 64 MiB | There is no session GC in darwin (see `contextOffload` in `src/config.ts`), so a per-conversation hard bound is the only real disk bound. On exceeding it, one `recordingStopped` record is appended, recording stops for that session, and the problem is surfaced |

Caps are measured in **code points, not bytes** — the `headlessField` convention, and the reason the
U+FFFD truncation mistake in `error-handling.md` cannot recur here.

Every truncation is recorded on the record that suffered it:

```json
"trunc":[{"path":"toolUse.input.command","chars":41230,"kept":8000}]
```

"This is all there was" and "this was cut" must never be indistinguishable.

## 5. Append-only mechanics

- Bytes already written are **never** rewritten, truncated, reordered or re-read-and-rewritten.
- **Newline guard**: if the file does not already end in `\n`, the first append of a run prefixes
  one. An interrupted write then stays *one* broken line instead of being glued onto the next valid
  record and corrupting it too.
- **Seq continuation**: on lazy open the writer reads at most the last 64 KiB, takes the last
  *complete* line's `seq`, and continues from `seq + 1`. Sequence numbers therefore continue across
  runs of the same session, and a gap means something was really lost.
- **Serialized appends**: all writes go through one promise chain. `O_APPEND` gives atomicity for a
  single write, not ordering between concurrent ones.
- **Turn buffering**: records are formatted synchronously as events arrive (no I/O between events)
  and flushed as one write at turn end, so recording adds no await to the streaming path.
- `AgentRuntime.shutdown()` awaits the pending append chain, so a turn's records are durable before
  the process exits.

### Contract: readers tolerate damage and report it

`readTrajectory` returns `{ records, partialTrailingLine, unreadableLines }`. A partial trailing line
(an interrupted final write) is dropped, not an error. An interior malformed line — the residue of an
interrupted write that later runs appended after — is skipped and counted. Both are **reported** by
every consumer; neither is silently swallowed, and neither is ever repaired in place.

## 6. Degradation

Recording is an observer. It may not become a second reason a turn dies.

- Formatting and buffering are synchronous and cannot throw into the stream.
- The first append failure latches a problem string, stops further writing for that session (no
  per-event error spam), and is surfaced **once**: a `warn` transcript notice in the TUI, read after
  the turn where the context-pressure check already lives; one bounded `trajectory:` stderr record in
  headless mode.
- A trajectory failure never changes a turn's outcome, its events, or the process exit status.
- This holds while recording a **turn failure** too: `TurnRecording.failed()` is synchronous and
  swallows its own problems, and `recordStream` rethrows the original error, so a caller of a failing
  turn receives the provider's error and never the recorder's. A broken recorder plus a failing
  provider must not turn into a mystery about which one broke.

## 7. The three primitives

### `search`

Case-insensitive **plain substring** matching — not regex: a user-supplied pattern must not be able
to backtrack catastrophically or need quoting. Matched against user input, assistant text, tool name,
tool input, tool result text, and a failed turn's `Name (cause Cause): message`. Scans this
project's sessions newest-first (session ids sort chronologically). Reports one bounded line per hit.

A failure is searchable for the same reason tool output is: it is content the record already holds,
and "which session hit this provider error" is the first question a failed overnight run produces.
`--type turnEnded` narrows a search to turn outcomes alone.

Honest misses are load-bearing: a session with no trajectory file says so and exits 1; an unknown
session id says that instead; zero matches prints `no matches` and exits 0, because the search
succeeded. "0 results" for a file that was never written is a lie.

### `fork`

1. Requires the source `snapshot_latest.json` to exist.
2. Mints a new timestamp session id.
3. Copies the snapshot **bytes verbatim** (`cp`, `errorOnExist: true`), so the fork restores exactly
   the source conversation.
4. Copies `offload/` when present, and **fails the fork if that copy fails**: a fork whose history
   cites offload references it cannot resolve is worse than the disk a shared directory would save.
5. Copies `trajectory.jsonl` as the fork's prefix and appends one `forkedFrom` record to the
   **fork** — shared past, divergent future, append-only preserved.
6. Does not copy `background/` (process control is explicitly not resumable across runs) and does
   **not** touch `last-session.json` (a fork must not hijack `--resume`).

The source directory is opened read-only. `fork` never mutates its source, and that is asserted by
hashing the source snapshot and trajectory before and after.

### `replay`

Reads the record, rebuilds `TurnAction`s, and feeds them through the **existing `turnReducer`** from
`src/tui/turn-state.ts`. Replay must never grow a second projection: one reducer means live
rendering and replay cannot drift apart.

Zero model calls by construction — `src/trajectory/**` and the subcommand path import no `Model`, no
`Agent`, and not `runtime.js`. This is asserted structurally (the import graph) as well as
functionally (replay is correct with a sabotaged AWS environment).

### Reporting a failed turn

A record that knows a turn failed is useless if no read path says so, so both say it, at the
verbosity their format affords:

- **`list`** appends `— <n> failed turn(s): turn <k> <Name> (cause <Cause>): <message>` to the
  session's row, naming at most the first three and counting the rest as `+N more`. Every part is
  bounded: each rendered failure passes through `formatTurnFailure`, which collapses whitespace and
  caps the whole `Name: message` line at `MAX_FAILURE_SUMMARY_CHARS` (120) code points. The bound
  covers the class name too, not just the message — both are provider-controlled, and a message
  sitting at the 8,000 code-point field cap must not widen a one-line-per-session listing.
- **`replay`** shows the failure twice on purpose, and each has a different job: the reconstructed
  history notice (`note turn failed: <message>` — the full recorded message, being what the TUI
  showed live) and one bounded `turn <k> failed: <Name> (cause <Cause>): <message>` line at the end,
  which is the only place the class appears, because the live notice never carried one.
- Neither is an error: a record that faithfully describes a failed turn was read **successfully**,
  so both exit 0. Only a record that cannot be read exits 1.

### Reporting spend

`src/trajectory/spend.ts` is the **one** aggregation and rendering both read paths use, for the same
reason `turnOutcome` is the one reading of an outcome. It imports nothing from `src/agent/**`:
reporting what a session cost stays as offline as replaying what it did.

- **`list`** appends one bounded clause to the session's row:
  `spend: input=… output=… cacheRead=… cacheWrite=… (<models>[, N turn(s) unknown])`. Field names
  and order are the headless `usage:` record's, so one convention covers both surfaces, `-` means
  unreported, and a metric only some turns reported renders `1234(+2 unreported)` rather than
  pretending the sum is complete. At most three model labels are named (each capped at
  `MAX_MODEL_LABEL_CHARS`), the rest counted; a file whose turns all predate the field reads
  `spend: unknown`.
- **`replay`** prints one bounded line per closed turn — including `turn <k> spend: unknown (not
  recorded)`, because quietly omitting an unmeasured turn would read as a cheaper session — then one
  `session spend: …` line, then a per-model breakdown **only** when more than one model contributed,
  since that is when a single total would otherwise mix two price lists. A `--turn <n>` replay
  reports the spend of the turn it replayed, matching the history it printed. `--json` still prints
  the reconstructed history and nothing else.
- Totals cover **what the file records**. A fork's trajectory begins with the bytes copied from its
  source, so those turns are genuinely in this file and genuinely in its total — and the `forkedFrom`
  record on the same file says where they came from. Excluding them would put a total on the same row
  as a record count and a byte count that describe a larger file.
- Turns are counted per **`turnEnded` record**, not per distinct `turn` ordinal: ordinals restart at
  1 in each process that appends to a session, so grouping by ordinal would merge two runs' turns and
  under-report the file.

## 8. Replay correctness

### What replay guarantees

For the records a file retains:

1. The same ordered `HistoryItem` sequence the live TUI produced — user inputs, assistant text
   blocks, and tool rows with name, summary, status and preview — modulo the module-counter `id`
   field, which is process-local by construction.
2. The same turn boundaries and the same recorded stop reasons.
3. The same truncation markers, in the same places.
4. Determinism: the same bytes produce the same output, every time, offline.
5. Tolerance of a partial trailing line and of interior malformed lines, both reported.
6. For a **failed** turn: the same `error` notice `runTurn` appended live, with the same text and in
   the same position (before the live-text flush), reconstructed from `turnEnded.failure`. That is
   why replay equals live history for failed turns as well, and why the failure is not rendered as
   some replay-only line.

### What replay explicitly does not reproduce

1. **Side effects.** No model call, no tool execution, no file or shell action is re-run. Replay is a
   reading of what happened, never a re-doing of it.
2. **Token-level timing.** Deltas, the `thinking…` indicator, the active-tool panel, the spinner and
   elapsed times are live-frame state, not history.
3. **Reasoning content.** Only its presence was recorded.
4. **Bytes a cap removed.** They are gone, and marked; replay never reconstructs or guesses them.
5. **Terminal rendering.** Replay reproduces history *content*, not ANSI/Ink-identical output.
6. **UI-local notices.** `/usage` reports, SDK warnings, "loaded skill …" — none of it is
   model-visible activity, so none of it is recorded or replayed.
7. **`agent.messages`.** The snapshot is the sole authority for resume and fork; replay does not
   produce a resumable agent and does not attempt to reconstruct conversation state.
8. **Usage and metrics beyond the two things the record keeps**: the turn-scoped `turnEnded.spend`,
   and whatever the recorded `agentResultEvent` itself carried (its `lastMessage.metadata.usage`, i.e.
   the turn's final model call). Per-cycle usage, tool-level metrics, traces and model latency are not
   recorded and are not reconstructed.
9. **Sessions or turns that predate recording.** Reported as "no record", never inferred from a
   snapshot.
10. **A failed turn's stack trace, or anything else about the error beyond class, message and wrapped
    class.** The record keeps what identifies the failure, not where in darwin it surfaced.

## 9. Child isolation

Subagent children are separate `Agent`s invoked privately by `SubagentTool`; their events never pass
through `AgentRuntime.send`, so **no child event is recorded, anywhere**. What the record contains is
the parent's own `subagent` tool call — its task input and the result string it returned — which is
exactly what already reaches parent context. No child-recording path exists to be misconfigured, and
`spike/verify-trajectory.ts` asserts that a marker a child produced internally but never returned
does not appear in the file.

## 10. Wrong vs correct

```typescript
// WRONG: a plugin/hook that re-emits, buffers or awaits inside the loop; an await between
// events; a hand-rolled event projection that can capture `agent`.
agent.hooks.addCallback(ContentBlockEvent, async (e) => { await appendFile(file, serialize(e)) })

// CORRECT: a synchronous observer between stream() and yield, flushed once per turn.
for await (const event of this.agent.stream(input)) {
  turn?.record(event)   // sync, cannot throw
  yield event           // untouched, in order
}
```

```typescript
// WRONG: rewrites history to "repair" a partial line, and loses the evidence.
const lines = (await readFile(file, 'utf8')).split('\n').filter(isValidJson)
await writeFile(file, lines.join('\n'))

// CORRECT: tolerate, count, report; never touch what is already on disk.
const { records, partialTrailingLine, unreadableLines } = await readTrajectory(file)
```

```typescript
// WRONG: swallows the failure, or hands the caller a different error than the one thrown,
// or invents a stop reason so the line "looks complete".
catch (error) { turn?.failed(error); throw new Error(`turn failed: ${error}`) }   // new object
catch (error) { turn?.failed(error) /* no rethrow */ }                            // silent success
this.stopReason = 'failed'                                                       // fiction

// CORRECT: observe, then rethrow the identical object; describe the failure in its own field.
catch (error) { turn?.failed(error); throw error }
```

```typescript
// WRONG: too late for the record (recordStream's finally already closed the turn), a write on
// the error path that can replace the caller's error, and a zero standing in for "unknown".
async *send(input) {
  try { yield* recordStream(this.agent.stream(input), this.trajectory?.beginTurn(input)) }
  finally { this.trajectory?.buffer({ type: 'turnSpend', input: delta.inputTokens ?? 0 }) }
}

// CORRECT: a meter injected into the turn, read synchronously while the closing record is
// composed, with unreported metrics simply absent.
yield* recordStream(
  this.agent.stream(input),
  this.trajectory?.beginTurn(input, startTurnSpend(before, () => this.usage, this.liveConfig)),
)
```

## 11. Tests required

`spike/verify-trajectory.ts` (network-free, owns its HOME, real SDK `Agent` + scripted `Model`, and a
real `AgentRuntime` wherever the claim is about `send`) must cover: two-turn append with byte-identical
prefix and continued `seq`; partial-line tolerance plus the newline guard; every cap with its recorded
truncation; an injected write failure degrading without throwing; pass-through event equality with
recording on and off, including a mid-stream `break`; a search hit and an honest miss; fork
byte-identity, usability and untouched pointer; replay equality against the live projection,
determinism, and no model call; and child isolation.

For a thrown turn specifically: one file holding a clean, a **really cancelled** (`agent.cancel()`
mid-stream, not a hand-written line) and a failed turn, whose three outcomes are read back from the
file alone; the thrown error reaching the caller as the identical object; the SDK's wrapping path with
its `cause` recorded; a recorder that fails while recording a failure still handing the caller the
provider's error; the failure message at the field cap, capped with its truncation recorded; the
earlier bytes byte-identical afterwards; live-versus-replay equality for a failed turn; a `v: 1`
record with no `failure` still parsing, replaying and reading as clean; and `list`/`replay`/`search`
reporting the failure — including that a failure message at the field cap cannot widen the `list` row.

For per-turn spend specifically, driven through a real `Agent` whose scripted model reports usage the
way a provider does (a `modelMetadataEvent`, so the numbers are accumulated by the SDK's own meter):
one turn of **two** model calls recording their sum and the next turn recording only its own;
**reconciliation** — the recorded turns summing, metric by metric, to
`agent.metrics.accumulatedUsage`; a provider reporting no cache counters leaving the keys absent and
the report showing `-`, next to a provider reporting `0` leaving them present and showing `0`; a
failed turn recording spend *and* `failure` while the thrown error still reaches the caller as the
identical object; a turn whose first call was rejected recording zeros rather than nothing; a
cancelled turn recording what completed before the cancel; a meter that **throws** costing the spend
field only, with the turn, the rest of the record and `status.active` intact; a model id at the field
cap capped with `spend.model` in `trunc[]` and a still-bounded rendered line; `list` and `replay`
reporting totals, the partial-metric marker, the per-model breakdown and a filtered replay; a
pre-spend `v: 1` file reading as `unknown` with no fabricated zero anywhere; a damaged `spend`
payload reading as unknown; and determinism over the same bytes.

Run `pnpm typecheck`, `pnpm test`, and — because `/trajectory` adds a completion row —
`pnpm tsx spike/verify-tui.ts completion`.
