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
| `agentResultEvent` | `stopReason` and the result's usage summary |
| `turnEnded` | `stopReason`, `ms`, `recorded` per type, `dropped` per type, `partialText` when the turn ended with unflushed assistant text, and `failure` when the turn's stream **threw** |
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
8. **Usage and metrics** beyond what `agentResultEvent` itself carried.
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

Run `pnpm typecheck`, `pnpm test`, and — because `/trajectory` adds a completion row —
`pnpm tsx spike/verify-tui.ts completion`.
