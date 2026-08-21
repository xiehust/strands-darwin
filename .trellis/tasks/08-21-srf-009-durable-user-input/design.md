# Design — durable active-turn userInput

## Boundary

Keep the change at the existing runtime/trajectory seam. `AgentRuntime.send` opens a `TurnRecording`, awaits one recorder-owned input-durability barrier, and only then creates/iterates `Agent.stream(input)`. The SDK Agent loop remains untouched.

## Recorder protocol

`TurnRecording` already synchronously observes and bounds `userInput` in its constructor. Add `inputDurable(): Promise<void>` which asks `TrajectoryRecorder` to:

1. move the pending `userInput` into the existing serialized append chain;
2. wait for that chain only up to a fixed production timeout;
3. return normally after success, write failure, or timeout.

The normal end-of-turn flush still appends all later events and `turnEnded` as a second batch. Sequence assignment remains append-time and existing bytes are never rewritten.

On timeout, latch the existing `problem`/`active: false` status and detach the timed-out chain so `close()`, `retire()`, and `shutdown()` cannot wait forever. No later recorder append is accepted. The abandoned operation may settle later, but it cannot gate or fail the Agent turn.

## Verification seam

Follow the existing runtime startup-checkpoint precedent with narrow test-only setters for model construction and trajectory-recorder options. This allows `spike/verify-trajectory.ts` to create a complete production `AgentRuntime` with a deterministic offline model and injected failing/hanging file handles, then reset both seams in `finally`.

## Compatibility

- No per-event await or recorder data enters model context.
- Provider events/errors continue through `recordStream`; error identity is untouched.
- Sessions with no turn still create no trajectory file.
- Split append batches preserve replay because record order remains `userInput`, events, `turnEnded`.
- Existing status formatting exposes the latched problem without a new UI channel.
