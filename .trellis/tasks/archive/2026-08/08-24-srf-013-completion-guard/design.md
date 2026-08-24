# Design — SRF-013 bounded completion guard

## Boundary

The guard belongs above `AgentRuntime.send`, beside stream resumption, because it is driver-owned policy over a completed ordinary SDK turn. `runtime.ts` remains the only `Agent` constructor and the SDK loop is unchanged.

## Candidate transaction

Each ordinary driver buffers one candidate turn's events in memory until a terminal `agentResultEvent`. A shared bounded classifier inspects only a successful `endTurn` candidate's authoritative final assistant text. The candidate is then either:

1. **accepted** — flush its events unchanged to the existing TUI/headless consumer and trajectory recorder; or
2. **suppressed** — discard all candidate events, close its deferred trajectory turn without public records, and run one ordinary continuation with a fixed private prompt.

Deferring trajectory observation is necessary: filtering only display events would leave the note in trajectory/replay and `agentResultEvent.lastMessage`. The runtime exposes a narrow deferred-turn seam which still crosses the durable user-input barrier before provider/tool work, but buffers records until the driver accepts or suppresses the candidate. Suppression records neither the private input nor candidate events; the accepted continuation is one honest visible trajectory turn. Tool calls are never eligible for suppression: a candidate that emitted tool events is accepted, preventing hidden side effects.

## Detection

The classifier is deliberately bounded and conservative: inspect at most a small code-point cap, require a short line/word count, reject user-facing sentence punctuation/formatting, and match closed internal-action prefixes/imperatives (`need`, `todo`, `update plan`, `continue tools`, etc.). It is not a semantic judge for long answers.

## Continuation

A shared orchestrator runs the candidate once and, on one match only, invokes the same ordinary-turn callback with a fixed bounded anti-repeat prompt. The prompt contains no suppressed text or original user text. The continuation result is always accepted as terminal—even if it also matches—and failures/cancellation propagate normally. This composes outside exact stream interruption: each candidate invocation may still use the existing one-shot stream-resumption helper, but completion continuation itself is never recursively guarded.

## Output compatibility

- TUI commits only accepted buffered events through the existing reducer, preserving `<Static>` semantics after acceptance.
- Text headless computes accepted reply/tool progress from buffered events.
- Structured headless emits accepted assistant/tool events only; sequence remains gap-free.
- Candidate buffering is bounded by event count and text size; overflow fails open (accepts unchanged) rather than hiding an unclassified turn.
- Queue ownership, cancellation, lifecycle publication, resumability, and session transitions remain at the existing outer driver turn.
