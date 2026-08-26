# Structured Headless Output

> Public automation protocol for one-shot `-p/--print` runs, established by SER-011.

## Scenario: opt-in structured one-shot protocol

### 1. Scope / Trigger

Use this contract whenever `-p/--print` output modes, headless lifecycle ordering, public JSON
fields, SDK stream projection, or structured-output tests change. It is a cross-layer CLI/runtime/
SDK boundary: a locally reasonable change in any one layer can corrupt the public protocol.

### 2. Signatures

```text
darwin -p|--print <message>
  [--output-format text|json|stream-json]
  [--continue|--resume|--session <id>]
  [--permission-mode default|auto|plan|yolo|--yolo]
  [--max-model-calls <positive integer>] [--context-offload] [--compact-before]
```

`text` is the default and its stdout/stderr bytes and ordering are the pre-SER-011 protocol.
`--output-format` is a single value flag valid only with `-p/--print`. Missing, repeated or unknown
values, and structured use without a prompt, are CLI usage errors before runtime/model construction:
human stderr, empty stdout, exit 2.

Once a structured invocation parses, stdout is exclusively the structured protocol and ordinary
stderr is empty. MCP subprocess banners stay suppressed. SIGKILL and stdout failure such as EPIPE are
outside the caught protocol and cannot guarantee a terminal record.

The production entry reads cwd and calls the runner with an explicit `projectRoot`; the runner passes
that exact value to `AgentRuntime.create`. No module below `src/cli.ts` may recover cwd ambiently.
Fixture drivers likewise name their root explicitly, and focused tests make runtime creation reject a
mismatch.
The optional token-efficiency controls are prepared before the public turn boundary. Runtime
creation receives the model-call ceiling and process-only offload override. `--compact-before`
awaits reversible persisted compaction after restore and `run.started`; only then may JSONL emit
`turn.started` and call `send`. A compaction failure is a runtime-stage terminal failure with no
turn/result, while text mode keeps its atomic empty-stdout failure contract.

### 3. Contracts

#### Version 1 envelope

Every object contains:

```typescript
{
  schemaVersion: 1;
  type: string;
  sequence: number;       // one process-output order, starts at 1
  timestamp: string;      // ISO 8601 observation time
  sessionId: string | null;
}
```

Final-only JSON emits one `result`, therefore sequence 1. JSONL increments the same counter across
all events. An explicit id is carried immediately; generated/continued ids are installed by runtime
resolution. `null` means failure preceded resolution, not an unknown id after a run started.

#### Terminal result

`result.outcome` is `success`, `failure`, or `cancelled`. Only success carries the complete assistant
`result`. It may additionally carry effective `permissionMode`, `resumed`, `usage`, ordered `errors`
and `warnings`.

Error stages are `runtime`, `turn`, `cleanup`, and `persistence`; entries retain observation order and
contain bounded class/message/cause-class, never stacks. Warning sources are `sdk`, `trajectory`, and
`diagnostics`. Cancellation is not a provider error and remains exit 1.

Usage fields are the mutually exclusive cost buckets `input`, `output`, `cacheRead`, `cacheWrite`.
A provider-unreported value is an absent key. A provider-reported zero is numeric `0`. Runtime
failure before a meter exists omits `usage`.

Success is a durability statement, not merely a model stop reason. Order is:

1. consume the SDK turn;
2. strict `runtime.shutdown({ throwOnError: true })`;
3. `runtime.markResumable()`;
4. emit terminal success.

A turn, cleanup, cancellation, or pointer failure cannot leak a successful terminal result. JSONL may
already have honest live events; its final `result` is authoritative. Observer failures are warnings
and remain nonfatal, matching their existing domain contract.

#### JSONL event taxonomy

| Type | Public fields | Meaning |
|---|---|---|
| `session.resolved` | envelope | Effective id became known |
| `run.started` | `permissionMode`, `resumed`, optional bounded `diagnosticsFile` | Full runtime constructed |
| `turn.started` | envelope | The one SDK turn is about to stream |
| `assistant.message` | `messageIndex`, `part`, `parts`, `text` | One bounded part of safe completed assistant text |
| `permission.denied` | bounded `toolName`, `kind`, `summary`, projected `source` | Headless bridge immediately denied a promptable call |
| `tool.started` | bounded `toolUseId`, `name`, classification `summary` | A tool call began; raw input is absent |
| `tool.completed` | bounded `toolUseId`, `name`, `status` | `success`, `failure`, or `denied`; raw result is absent |
| `diagnostic` | source, level, bounded message | SDK warning/error observed live |
| `subagent.progress` | bounded `dispatchId`, `agentName`, integer `elapsedMs`, closed `phase`, optional bounded `toolName` | Stream-JSON only; periodic long-dispatch heartbeat, never task/prompt/reasoning/tool payload/result/transcript |
| `result` | terminal contract above | Exactly one authoritative terminal record |


Session/run/turn lifecycle ensures a stream is live before a normal turn completes.

#### Privacy and redaction boundary

The public projector switches over typed SDK events and copies allowlisted scalars. It never invokes
SDK event `toJSON()` and never exposes raw SDK objects. Specifically absent: `Agent`, invocation
state, whole messages, raw tool input/results, metrics/traces/checkpoints, reasoning text,
reasoning signatures, reasoning `redactedContent`, and guardrail
`modelRedactionEvent.outputRedaction.redactedContent`.

V1 does **not** stream token deltas. The SDK passes provider text deltas before aggregation, while an
output guardrail can reveal blocked output there and only later replace the completed message.
`assistant.message` therefore comes from `modelMessageEvent.message` `TextBlock`s after aggregation
and output redaction. Reasoning blocks contribute nothing. For the existing one-shot max-token
recovery only, retained partial assistant `TextBlock`s are read from `MaxTokensError.partialMessage`
(the post-aggregation message the SDK preserves), emitted once, then joined with the completed retry.

Tool ids/names/summaries retain the 240-code-point headless bound. Error and diagnostic strings are
capped at 8,000 Unicode code points with `truncated: true`. Completed messages longer than that are
split into numbered parts, so streaming never silently loses assistant text. JSON escaping means an
embedded newline remains inside one physical JSONL record. The terminal success result is deliberately
unbounded and complete, matching text mode's atomic complete-answer contract.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing/repeated/unknown output value, or output mode without `-p` | Human stderr usage error; empty stdout; exit 2; no runtime |
| Runtime fails before session resolution | One failure result with `sessionId: null`, no usage |
| Explicit id or generated id is known before later startup failure | Terminal envelope retains that id |
| Turn throws | Ordered `stage: "turn"` error; strict cleanup still runs; no pointer/result |
| SDK returns cancelled | `outcome: "cancelled"`; strict cleanup; no pointer/result; exit 1 |
| Cleanup also fails | Add ordered `stage: "cleanup"` error; cancellation remains cancellation |
| Pointer write fails after a good turn/cleanup | `stage: "persistence"`; terminal failure; no assistant result |
| Observer or SDK logger degrades | Warning/diagnostic; does not fail an otherwise durable success |
| Usage key unreported | Omit key; do not write zero |
| Output pipe fails or process receives SIGKILL | Terminal record is not guaranteed |

### 5. Good / Base / Bad Cases

- **Good:** `stream-json` emits resolved/run/turn events before model completion, safe completed text,
  tool lifecycle records, then one durable success with monotonic sequence numbers.
- **Base:** `json` emits no progress and exactly one sequence-1 success document after shutdown and
  pointer persistence.
- **Bad:** publishing raw model deltas or SDK `toJSON()` can expose pre-redaction output, reasoning,
  signatures, redacted content, and an unstable provider/SDK wire shape.
- **Bad:** emitting success before shutdown or pointer write turns a cleanup/persistence failure into
  a plausible result a supervisor cannot retract.

### 6. Tests Required

- Parser and subprocess/driver assertions for invalid pre-runtime use and exact text success,
  failure and SIGINT stdout/stderr ordering.
- JSON one-document tests for success, runtime, turn, cleanup, persistence and cancellation.
- JSONL monotonic/live/one-terminal tests.
- Real SDK scripted-model adversarial tests containing reasoning text/signature/redacted bytes,
  raw blocked text and guardrail original output; none may appear anywhere in the serialized stream.
- Unknown-versus-zero usage and max-token recovery regressions.
- Existing trajectory, max-token, typecheck, full fast suite and build gates.
- Two low-token real Bedrock calls, one per structured mode, in disposable user/project state.

### 7. Wrong vs Correct

```typescript
// WRONG: publishes provider text before a later guardrail redacts the completed message.
if (event.type === 'modelStreamUpdateEvent' && event.event.delta.type === 'textDelta') {
  writeJson(event.event.delta.text);
}

// CORRECT: publish allowlisted TextBlocks only from the post-aggregation message.
if (event.type === 'modelMessageEvent') {
  for (const block of event.message.content) {
    if (block.type === 'textBlock') writer.assistantMessage(index, block.text);
  }
}
```

```typescript
// WRONG: a plausible answer escapes before cleanup/pointer failure is known.
process.stdout.write(reply);
await runtime.shutdown({ throwOnError: true });
await runtime.markResumable();

// CORRECT: durable success is the final operation exposed to the supervisor.
await runtime.shutdown({ throwOnError: true });
await runtime.markResumable();
writer.terminal({ outcome: 'success', result: reply });
```

## Scenario: SRF-001 continuation protocol

A recognized stream interruption is two ordinary turns inside one headless process lifecycle.
Legacy text writes one bounded stderr line beginning `notice: model stream interrupted`, emits only
the successful continuation reply on stdout, and otherwise keeps the established ordering. Final
JSON stays one terminal document and sets `continued: true`; it never emits the internal prompt or
the original prompt as continuation metadata. Stream JSON emits, in order, the first `turn.started`,
`turn.failed` with a bounded structured failure, `turn.continuing` with reason
`model_stream_interrupted`, and the second `turn.started`; terminal `result` is authoritative and
sets `continued: true` after successful recovery. A second interruption ends in ordinary failure and
never emits another `turn.continuing`.

Privacy rule: `turn.continuing`, terminal JSON, stderr, and assistant output contain no internal
continuation prompt, raw original request, stack, SDK Agent, invocation state, or partial failed
assistant text. `spike/verify-headless-structured.ts` drives all three protocols and asserts success,
second-failure bounds, ordering, parseability, and absence of private prompt text.

## Scenario: direct successful-turn streaming

Text and structured headless drivers consume ordinary `runtime.send()` events while the turn is
open. Text mode reports tool progress as observed. Stream JSON emits tool lifecycle events as
observed and safe assistant messages only from post-aggregation `modelMessageEvent`, preserving the
redaction boundary; final JSON remains atomic at process durability. There is no successful-turn
candidate suppression or unfinished-plan continuation. Exact SRF-001 stream interruption and
max-token partial handling remain unchanged. `spike/verify-headless-structured.ts` covers all three
protocols offline.
