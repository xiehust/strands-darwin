# SRF-009 durable active-turn userInput

## Goal

Make the active turn's already-observed `userInput` durably visible to concurrent offline trajectory readers before any provider or tool invocation begins.

## Requirements

- Open the trajectory turn and append its bounded `userInput` record before `Agent.stream()` can invoke the model or a tool.
- Use the recorder's existing serialized append order and sequence recovery. Existing file bytes must never be rewritten, and prior prefixes must remain byte-identical.
- Keep event observation synchronous and non-awaitable. Only the one pre-invocation user-input barrier may be awaited.
- Bound the barrier. A recorder write failure or timeout must latch a visible existing trajectory-status problem, stop recording safely, and allow the Agent turn to proceed.
- Recorder failure must never replace, wrap, or suppress a provider error, and recorded stream events must remain unchanged.
- Preserve lazy creation for sessions that never begin a turn, ordinary completed-turn/replay behavior, damage tolerance, stream resumption, `/clear` retirement, and shutdown.
- The trajectory remains observational: no model context is built from it and the SDK loop is neither forked nor intercepted.
- Do not modify or stage `docs/research/backlog_index.md`; its in-progress edit is Host-owned.

## Acceptance Criteria

- [x] A real `AgentRuntime` using a scripted offline model reads its trajectory from inside model invocation and sees the current turn's `userInput`, not only a prior turn.
- [x] A prior trajectory prefix remains byte-identical after the pre-invocation append and completed turn.
- [x] Sequence numbers and ordinary turn records remain ordered and valid across split appends and resumed files.
- [x] Stream events and thrown provider-error object identity remain unchanged.
- [x] Simulated write failure and bounded-barrier timeout both expose a trajectory status problem without preventing model invocation.
- [x] Recorder timeout cannot make retire/shutdown wait forever.
- [x] Focused trajectory, stream-resumption, and clear-session checks pass, followed by typecheck and exactly one complete `pnpm test` gate.
- [x] Session-trajectory and SDK contracts document the barrier and degradation semantics; the AGENTS.md load-bearing invariant is corrected if needed.
