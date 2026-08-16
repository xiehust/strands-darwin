# Session Diagnostics (opt-in `debug`/`info` log)

> The channel for what darwin otherwise throws away: the SDK's `debug`/`info` output and darwin's own
> notices, in one per-session file, for whoever is debugging that session — and for nobody else.
> Established 2026-08-16 (backlog direction `SER-008`). Every rule here is asserted by
> `spike/verify-diagnostics.ts`, which makes no model calls and needs no network.

---

## 1. Why a third artifact

Three sinks already exist and none of them can answer "why was that turn slow":

- The **snapshot** is the conversation's end state. It says nothing about how it got there.
- The **trajectory** (`session-trajectory.md`) records what the agent *did* — prompts, assembled
  replies, tool calls, per-turn outcome and spend. It is an event record, not a log, and by design it
  contains nothing the SDK said about itself.
- **Transcript notices** and the headless stderr records say things once, to whoever is watching.
  A notice lives in Ink's scrollback and dies with the frame; stderr is gone unless the caller
  captured it.

Meanwhile the SDK says several things *only* at `debug`: that a request was throttled, where it
placed its cache points, that native token counting fell back to estimation, that an MCP tool was
renamed (measured list in `strands-sdk-contracts.md`). `src/agent/sdk-logging.ts` wired `debug` and
`info` to `() => {}` with no way to route them anywhere, so a session that was slow because the
provider throttled it left **no evidence at all**.

This is the second, opt-in sink for that. It replaces nothing: notices still render, headless still
writes every stderr record it wrote before, and the trajectory is untouched.

## 2. Off by default, and off means untouched

`diagnostics` is a boolean in `SESSION_KEYS` (`src/config.ts`), absent by default.

Off by default for the same reason as `contextOffload`: the SDK's debug lines interpolate provider
payloads (`error=<${error}>`, a rejected request echoed back), so they can carry
conversation-derived material. Whoever switches it on is debugging and has decided that is
acceptable. That decision may not be made for them.

**With the field off, nothing about a run changes.** `sdk-logging.ts` installs the *literal*
`() => {}` the SDK itself ships for `debug`/`info` — not a closure that checks whether a sink
exists — `AgentRuntime` builds no log, no line is formatted, no directory is created, and
`withNoticeDiagnostics` hands the reducer's own dispatch straight back so not one of the ~50 notice
sites in `App.tsx` pays anything. "Off is off" is asserted behaviourally, by running a real
tool-calling `Agent` turn with no tap and finding no file: the SDK's export map exposes
`configureLogging` only, so there is no logger binding a test could inspect instead.

**A boolean, not a level.** Every fact worth turning this on for is at `debug`, so an `info` setting
would produce a file that exists and is silent about exactly the evidence this feature was built
for — a knob whose lower position cannot answer the question is a trap. Volume is bounded by bytes
(§5) rather than by asking the user to guess a level, and privacy is not level-separable anyway:
`debug` and `warn` both interpolate provider payloads, so a level would imply a redaction it does
not perform. A later `diagnosticsLevel` remains additive if someone actually wants filtering.

There is deliberately **no CLI flag** and **no `/diagnostics` command**: a flag would add an override
path and a startup fact for a workflow the config field already serves, and a new built-in command
would cost a completion row for a capability the startup notice already gives.

## 3. Where it lives

```
~/.darwin/sessions/<project-key>/<session-id>/diagnostics.log
```

`diagnosticsPath(projectRoot, sessionId)` in `src/agent/session.ts` derives it, beside
`trajectoryPath` — the same per-session sibling convention as `<session-id>/background/` and
`<session-id>/offload/`. Never in the project working tree.

Created **lazily, by the first line that is written**, so a session that starts and exits without
logging leaves nothing behind — the rule the trajectory and the resume pointer already follow. The
first line is buffered by the constructor, so in practice a run that reaches `AgentRuntime.create`
with the feature on does create the file.

Nothing evicts it, exactly like `offload/`: there is no session GC in darwin, so the bound is the
byte budget below plus deleting the session directory.

## 4. Line format

Text, one line per event, `<ISO timestamp> <source> <level> — <message>`:

```
2026-08-16T12:00:00.123Z darwin info  — diagnostics started · session session-20260816-120000 · darwin 0.4.0 · bedrock/global.anthropic.claude-opus-5 · pid 12345 · budget 8388608 bytes
2026-08-16T12:00:01.004Z sdk    debug — event=<beforeToolCall> | dispatching to 1 handler(s)
2026-08-16T12:00:01.004Z sdk    debug — handler=<darwin:permission-gate>, event=<beforeToolCall> | evaluating
2026-08-16T12:00:03.881Z sdk    debug — msg_idx=<3> | added cache point to last user message
2026-08-16T12:00:31.256Z sdk    warn  — model_id=<…> | cache_config is enabled but this model does not support automatic caching
2026-08-16T12:00:44.010Z darwin warn  — trajectory: EACCES: permission denied, open '…'
```

- **Text, not JSONL**, unlike the trajectory: the reader is a person with `tail -f`, and these lines
  are already text the SDK formatted, so wrapping each in an object would add punctuation and no
  structure. There is no replay engine on this side to feed.
- `source` is `sdk` or `darwin`; `level` is one of the SDK's four. Both are padded to a fixed width,
  so the columns line up for a human and still split for a script. ` — ` (the delimiter headless
  already uses for `sdk warn — …`) separates the message.
- **One event is exactly one line.** The message is whitespace-collapsed, so a multi-line notice
  (the `/usage` table, say) cannot turn one event into several a reader or a `grep -c` would
  miscount, and `tail -f` never shows half an event.
- **The first line describes the run** — session, darwin version, provider/model, pid, and the byte
  budget — so the file explains itself without a reader having to know which run wrote it, and so
  the stop marker at the end of a full file is not the first mention of a bound.

### Contract: a warn is two lines on purpose, and the `source` column is why

An SDK warning that the TUI renders appears twice with the feature on:

```
… sdk    warn  — <message>                 the SDK said it
… darwin warn  — sdk warn: <message>       darwin showed the user a notice saying it
```

That is **deliberate, and must not be "fixed"**. They are two different true events — one is the
provider adapter's report, the other is what the transcript displayed — and the `source` column
already tells them apart. The alternatives are worse: a flag on `TurnAction` would put a logging
concern in the reducer's vocabulary (which `trajectory replay` also uses), and sniffing the notice
text for an `sdk ` prefix would be a string coupling between the renderer and the log. The headless
mirror does *not* re-log SDK warnings for the same reason it does not need to: the tap already wrote
them with `source: sdk`.

## 5. Bounds

| Bound | Value | At the bound |
|---|---|---|
| per line | 8,000 code points | truncate and append `… (truncated, <n> code points)`, `n` being the original length |
| per session file | 8 MiB | write the lines that fit, then one `diagnostics stopped: reached the <n>-byte per-session budget (nothing after this line was written)` line, latch logging off, surface the problem once |
| pending, unwritten | 1 MiB | drop arriving lines and count them; the next successful append writes `<n> line(s) dropped: the writer could not keep up` **before** the batch it interrupted |

Code points, not bytes, so a multi-byte message cannot be cut mid-sequence — the `headlessField`
convention, and the reason the U+FFFD mistake in `error-handling.md` cannot recur here.

**Why 8 MiB and not the record's 64 MiB.** A trajectory is the artifact you *keep*, so its bound has
to leave a long session's history intact. This is scratch for one debugging session, nothing ever
garbage-collects it, and 8 MiB is on the order of 80,000 lines — far past the point where a human
tailing a file is still reading. Whoever needs more than that needs a different tool.

**Why a pending bound exists here and not in the trajectory.** The recorder buffers one turn and
flushes at its end, so its memory is bounded by a turn. `logger.debug` is called *synchronously from
inside the SDK's stream loop*, continuously, so a long turn against a slow disk is a real
unbounded-growth path. Two things follow, and both are load-bearing:

- **Lines are left in the queue while an append is in flight** rather than each being handed to the
  promise chain on arrival. Draining on every arrival would move the unbounded growth from an array
  into a chain of queued batches instead of removing it, and the pending-byte bound would bound
  nothing.
- **A full queue drops lines rather than blocking.** Blocking would delay the event the SDK was in
  the middle of, which the observer contract forbids outright. Dropping a *diagnostic line* is
  correct and is written down; dropping or delaying a *stream event* never happens.

The file bound is applied **before** writing, trimming the batch to what fits: one append can carry a
whole burst, so checking the total afterwards would let the file overshoot by the entire pending
bound, and a bound that can be exceeded by a megabyte is not the bound it claims to be.

## 6. Observer discipline

The same discipline the trajectory earned (`session-trajectory.md` §6), because the same rule
applies: an observer may not become a second reason a turn dies.

- `DiagnosticsLog.write` is **synchronous**, performs no I/O, and catches everything — including a
  line that cannot even be formatted. It formats a string, appends it to the queue and registers a
  continuation. Nothing on the streaming path awaits an append.
- It **never writes to the console.** The SDK's default `console.warn` tearing the Ink frame is the
  entire reason `sdk-logging.ts` exists; a diagnostics sink that fell back to the console would
  reintroduce exactly that.
- The tap **cannot touch the stream**: it is a logger sink, not a stream wrapper. Asserted anyway,
  by teeing a real `Agent.stream()` with the tap installed and checking the consumer received the
  identical event objects in order, and that the event sequence matches a run with no tap.
- The first failure **latches**: a problem string is recorded, logging stops for that session (no
  per-event error storm), and it is surfaced **once** — a `warn` transcript notice after the turn,
  where the context-pressure and trajectory checks already live, and one bounded `diagnostics:`
  stderr record in headless.
- A diagnostics failure never changes a turn's outcome, its events, or the process exit status.
- `close()` (called from `AgentRuntime.shutdown()`) flushes, waits, and then **latches the log shut**.
  A line offered afterwards would be queued onto a chain nobody awaits any more, so it might or might
  not reach the disk before the process exits; refusing it makes the file's end mean one thing —
  everything up to the session's shutdown. A closed log reports `active: false` with `problem`
  unset, which is how a reader tells a closed log from a broken one.

## 7. What reaches the file

| Source | What | How |
|---|---|---|
| `sdk` | `debug`, `info`, `warn`, `error` | `setSdkVerboseSink(log.sdkSink)` in `AgentRuntime.create`; `sdk-logging.ts` owns `configureLogging` |
| `darwin` | every transcript notice, with its severity | `withNoticeDiagnostics` wraps the reducer's dispatch in `App.tsx` |
| `darwin` | headless stderr records emitted while the runtime is alive | one `note(text, level)` helper in `runHeadless` |

`warn`/`error` reach the renderer **and** the file, so one file holds the whole story rather than the
half nobody was already shown. The renderer is called first: the user sees a problem before it is
written down, so the tap can never delay what is on screen.

### Contract: the log starts before the model, the MCP clients and the skills plugin

The log is built in `AgentRuntime.create` immediately after the session id and config are known, and
the tap is installed there — before `createModelFromConfig`, `loadMcpClients` and
`agent.initialize()`. All three log at `debug` while starting up (MCP tool renames, skill
discovery), and a diagnostics log that begins after startup cannot answer a question about startup.

### Contract: a subagent's SDK output is in the file, though the trajectory holds no child event

The SDK's `logger` is one process-global binding (`strands-sdk-contracts.md`), so installing the tap
routes the parent agent, **every subagent**, every model adapter and every MCP client at once. This
is a stated difference from the trajectory, not an oversight: `session-trajectory.md` §9 records *no*
child event, while this file will contain a child's throttle, its cache-point placement and its
provider warnings, labelled `sdk` like any other. There is no way to scope an SDK logger to one
agent, and for a debugging channel the wider scope is the useful one — a child's throttling is
exactly what makes a parent turn slow. It is also part of what the opt-in is consenting to: child
diagnostics can carry the child's task text in a provider message.

### What does *not* reach the file

- Anything before the session directory is known — the handful of statements `runHeadless` makes
  before `AgentRuntime.create` returns (`session: <id>`), which reach stderr only.
- Anything after `runtime.shutdown()`: the closing `usage:` record, a cleanup failure, and the
  `trajectory:`/`diagnostics:` problem records. They reach stderr, and the log is already closed by
  design (§6).
- The turn's events. This is not a second trajectory: it holds what the *SDK and darwin said*, never
  a projection of the conversation. Prompts, replies and tool results are the record's job.

## 8. Discoverability

- **TUI**: one transcript notice at startup, `diagnostics: recording SDK debug/info to <file>`, and
  one `warn` notice if it later stops. **No header row** — the header shares frame height with the
  permission box and the tool panel, which is the contract `spike/verify-tui.ts approve` enforces on
  a 50-row terminal — and no new slash command.
- **Headless**: one `diagnostics: <file>` stderr record beside the existing `session:` and
  `permission-mode:` startup facts, and one `diagnostics: <problem>` record at the end if it failed.
  Both appear only when the feature is on; a default run's stderr is unchanged.

### Contract: the headless stderr protocol does not change

The records `runHeadless` writes are the protocol a supervisor parses, so `note()` writes exactly the
text that was written before, in the same order, and the log only ever *gains* a copy. The mirror is
additive by construction: the stderr write is unconditional and happens first.

## 9. Wrong vs correct

```typescript
// WRONG: a branch on every one of the SDK's 60 debug call sites, so "off" is no longer
// the SDK's own behaviour; and a console fallback that tears the Ink frame.
debug: (...args) => { if (log !== undefined) log.write(...) }
warn:  (...args) => { console.warn(...args); log?.write(...) }

// CORRECT: install the literal no-op when nothing is listening, and re-install when
// something is.
debug: tap === undefined ? () => {} : (...args) => tap({ level: 'debug', message: flatten(args) })
```

```typescript
// WRONG: an await on the path the SDK is logging from, and unbounded growth behind it.
debug: async (...args) => { await appendFile(file, format(args)) }
private flush() { this.chain = this.chain.then(() => this.append(this.take())) }  // per line

// CORRECT: format synchronously, queue with a byte bound, and drain one batch at a time.
write(entry) { if (this.pendingBytes + size > this.max) { this.dropped += 1; return } … this.flush() }
private flush() { if (this.writing || this.pending.length === 0) return; … }
```

```typescript
// WRONG: a side effect inside the reducer, which `trajectory replay` also runs — replaying
// a record would write to a log, and React's strict mode would write every notice twice.
case 'notice': log?.notice(action.text); return { ...state, history: [...] }

// CORRECT: wrap the dispatch, outside the reducer, once.
const dispatch = withNoticeDiagnostics(recordAction, runtime.diagnostics)
```

## 10. Tests required

`spike/verify-diagnostics.ts` (network-free, model-call-free, owns its HOME, real SDK `Agent` +
`PermissionGate` + scripted tool-calling model) must cover: the path being a sibling of the record;
the line format, including a collapsed multi-line message, the code-point cap with its truncation
marker, and a multi-byte message cut on a boundary; **real** SDK `debug` output reaching the file
with a timestamp on every line and the self-describing first line; **off** writing no file at all
under the same real turn; a **real** SDK `warn` reaching the renderer with and without a tap, and the
file only when one is installed; notices with their severity, the identical action still reaching the
reducer, and the unwrapped dispatch when there is no log; an unwritable path latching one problem
without throwing, rendered as one bounded headless record; the byte budget stopping it with the
marker as the final line and the budget carried across runs of one session; a firehose dropping,
counting and writing down its drops; and the tap leaving a real stream's events identical in order,
including a line that cannot be formatted costing only the log.

Config validation lives with the other config rules in `spike/verify-config.ts`: absent by default,
both booleans accepted and distinguishable, a non-boolean refused with a `ConfigError` naming
`diagnostics`, and the key refused inside a `models` entry but preserved across a `/model` switch.

Run `pnpm typecheck`, `pnpm test`, and — because `App.tsx` changes — `pnpm tsx spike/verify-tui.ts
approve`, which is also what enforces that no frame row was added.
