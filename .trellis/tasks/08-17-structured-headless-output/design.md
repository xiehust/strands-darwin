# Design — structured one-shot output

## Boundary

`src/cli.ts` remains the only process driver and `src/agent/runtime.ts` remains the only main SDK
`Agent` constructor. One headless orchestration state machine owns turn, strict shutdown, pointer
persistence, usage and exit status; renderers only choose the external protocol.

## CLI and compatibility

`CliOptions.outputFormat` is `text | json | stream-json`, defaulting to `text`. Parsing rejects a
missing, repeated or unknown value and rejects any explicit output format without `-p/--print`.
The text branch retains every existing write and ordering. Structured modes suppress ordinary human
stderr and encode post-parse progress/failures on stdout.

## Protocol v1

All objects carry `{schemaVersion:1,type,sequence,timestamp,sessionId}`. Sequence is process-output
order from one. JSON buffers everything and emits only terminal `result` with sequence 1. JSONL emits
`session.resolved`, `run.started`, `turn.started`, completed `assistant.message`,
`permission.denied`, `tool.started`, `tool.completed`, `diagnostic`, then exactly one `result`.

The terminal result carries `outcome: success|failure|cancelled`, complete `result` only on success,
usage when readable, ordered errors, and nonfatal warnings. Error stages are runtime, turn, cleanup
and persistence. Session id is updated by explicit selection or resolution callback.

## Projection and privacy

The public projector switches over typed SDK events and copies allowlisted scalar fields only. It
never calls SDK `toJSON()`. Assistant public content is taken from `modelMessageEvent.message`
`TextBlock`s because this event is emitted after model aggregation has applied output redaction.
Raw model deltas are ignored: provider guardrails can reveal blocked output in deltas and only redact
after aggregation. Reasoning blocks/deltas, signatures, all redacted content, raw tool input/results,
traces, metrics, messages and agent/invocation state are absent.

Tool records expose bounded name/classification summary/id/status. Permission records expose bounded
summary, tool/kind and source. Errors/diagnostics are Unicode-safe bounded strings with a
`truncated: true` marker. Assistant JSONL messages are split into bounded parts. The successful
terminal result is complete, matching text mode.

Usage uses `usageBuckets`; missing metrics omit keys while reported zero remains zero.

## Lifecycle

Parse → install headless signals/log routing → resolve/create runtime → stream one turn → strict
shutdown → on provisional success write resume pointer → best-effort usage/observer status → terminal
result → restore handlers/log routing → preserve forced-exit fallback. Cancellation is detected from
the SDK terminal stop reason, remains exit 1, and does not write the pointer. Cleanup/persistence
failures invalidate provisional success. Ordered errors are retained rather than replaced.

CLI usage errors are the only human stderr path once structured output was requested. SIGKILL and a
broken stdout transport such as EPIPE cannot guarantee a terminal record.

## Test seam

Extract headless orchestration behind injected runtime creation, stdout/stderr writers and exit
hooks so scripted runtimes can prove every terminal stage without a provider. Keep a production
wrapper in `cli.ts`. Use a real SDK `Agent` plus scripted `Model` for event/redaction and max-token
projection tests. Subprocess tests lock the default text protocol and signal behavior.
