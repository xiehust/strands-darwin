# Design — restore ordinary streaming

## Boundary

Remove the parent-driver completion policy rather than replacing it. `AgentRuntime.send()` remains the only ordinary stream seam and the SDK loop remains unchanged. Exact stream-interruption and max-token recovery continue to compose at the existing TUI/headless drivers.

## Interactive flow

`App.runTurn()` consumes `runtime.send()` through `runWithStreamResumption()` and dispatches every event immediately as `streamEvent`. `turnEnded` remains the sole terminal reducer action. This restores the pre-guard event order and lets the existing reducer own active tools, completed result rows, live/final plan projection, line-by-line Static answer commitment, cancellation, and final flushing.

No buffered `turnCompleted` action remains. An unfinished `update_plan` is ordinary advisory state: it is finalized once when the turn ends and cannot start another model invocation.

## Headless flow

Text headless consumes ordinary events during one streamed turn and writes tool progress as observed. Structured headless likewise projects post-aggregation `modelMessageEvent` output and tool lifecycle events while consuming the stream. Both stay inside `runWithStreamResumption()` so the exact interruption-only continuation remains unchanged.

## Runtime and trajectory

Delete `AgentRuntime.beginCompletionGuardTurn()` and the private-turn/deferred-recording API. `TurnRecording` returns to one behavior: durable `userInput` before invocation, synchronous no-I/O event observation, one append-only closing batch. Remove the guard-only `completionGuardSuppressed` writer/type surface. Reader tolerance for extra JSON fields keeps historical v1 records readable without migration.

## Compatibility and rollback

The user-visible behavior change is intentional: internal TODO/future-action prose is no longer hidden or retried. Existing prompt instructions remain the defense. If evidence later justifies recovery, it must be designed as a separate post-turn feature that does not transactionally buffer ordinary output.

Rollback is the task commit itself; no state migration or dependency change is involved.
