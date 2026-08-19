# Design

## Seam

Add a small pure orchestration module beside `AgentRuntime` which owns only classification, the bounded continuation prompt, and a two-attempt async generator. It calls a supplied ordinary-turn function once for the original input and, only for the exact SDK stream-interruption `ModelError`, once for the internal continuation input. It never constructs an `Agent`, catches inside `AgentRuntime.send`, or observes SDK internals.

Both TUI and headless drivers use this helper at their existing submit/turn seams. Each attempt therefore invokes `runtime.send` independently and receives normal trajectory, permissions, usage, cancellation, and stream behavior.

## Classification

A retryable failure must satisfy both:

1. `error instanceof ModelError`; and
2. normalized `error.message` exactly equals `Stream ended without completing a message`, allowing terminal punctuation only.

Subclass exclusions (`MaxTokensError`, `ContextWindowOverflowError`) and auth/validation/generic errors follow from exact message matching, with explicit tests to lock the matrix.

## Visibility and privacy

The helper emits an in-process `continuing` boundary containing no prompt. TUI records a warning notice between failed and continuation attempts. Legacy text writes one bounded stderr notice. Stream JSON emits `turn.failed`, `turn.continuing`, and another `turn.started`; final JSON remains one terminal result and includes a bounded warning rather than changing schema outcome semantics. No public event contains the continuation prompt.

## Queue and cancellation

The TUI's one `runTurn` call remains busy across both attempts. It sets `turnAborted` only after the helper ultimately throws, so queued entries neither drain nor return during the internal continuation. Cancellation still ends through the SDK's ordinary cancelled result, which is not a thrown retryable error.

## Headless result

Headless answer accumulation resets per attempt. Partial assistant text from the failed attempt remains in trajectory but is not concatenated into the successful continuation result. Cleanup and pointer persistence still occur once after orchestration settles.
