# Design — subagent dispatch heartbeats and targeted cancellation

## Change boundary

The existing dispatch registry is the behavior owner: it already creates the stable id, records safe dispatch metadata, resolves permission provenance, and publishes terminal transitions. Extend it with running snapshots and progress subscriptions; do not create a second child-observation channel.

Expected source changes:

- `src/agents/dispatch-registry.ts`: own safe phase state, periodic per-dispatch heartbeat scheduling, progress snapshots, cancellation registration/result semantics, and cleanup.
- `src/agents/subagent-tool.ts`: bind one dispatch-specific child canceller and update the registry from closed SDK hook events only (`model` or child tool name). Preserve the return contract.
- `src/agent/runtime.ts`: expose list/subscription/targeted-cancel accessors and keep full cancellation unchanged.
- `src/tui/App.tsx`, `turn-state.ts`, `ToolCallPanel.tsx`, `subagent-format.ts`: project progress onto the existing active subagent tool row and add the user-only `/agents cancel <id>` command path. No heartbeat transcript notices.
- `src/headless-runner.ts`, `headless-protocol.ts`: subscribe while the run is active; text writes bounded stderr heartbeats, stream-JSON writes a bounded compatible event, final JSON remains terminal-only.
- `spike/verify-subagent-heartbeats.ts`: focused real-Agent offline contracts; package test registration.
- specs/docs/AGENTS: state the privacy, cancellation, timer, frame, and protocol contracts.

Explicitly out of scope: exposing child reasoning or payloads, recording progress in trajectory, changing lifecycle hooks, adding a model tool, changing the SDK executor, recursively delegating, or making concurrent writes safe.

## Registry event contract

A progress snapshot contains only existing dispatch identity/task/state/timestamps plus `elapsedMs` and a closed phase union:

- `starting`: model/Agent initialization before invocation;
- `model`: child model call active;
- `tool`: child tool call active, with only its bounded public tool name.

The registry publishes an immediate non-heartbeat update when safe phase changes so the TUI row can refresh, and interval heartbeats for visibility. Headless output consumes heartbeat events only. Each running record owns at most one interval, created on begin and cleared on terminal transition. The interval is injectable for tests and production-clamped to at most 30 seconds.

## Targeted cancellation

After child construction, `SubagentTool` registers `child.cancel()` on that dispatch record. `cancel(dispatchId)` resolves only one exact public id. Because short provider-derived ids can theoretically collide, a duplicate is refused as ambiguous rather than cancelling several children. A successful request latches cancellation, invokes only that child canceller, and returns a bounded local status. Before child construction, the latch prevents startup from continuing once model creation returns.

The child tool callback still resolves through the SDK exactly once with `Subagent task cancelled.` when targeted cancellation wins. This lets the parent SDK tool executor finish the one tool call and continue sibling calls/the parent turn. Ctrl+C still calls `cancelActive()` and parent `Agent.cancel()` as before.

## TUI and frame budget

Dispatch progress is reducer state attached to the already-active parent `subagent` tool row by matching the stable id derived from the parent tool-use id. The row suffix includes elapsed and safe phase. The existing one-row-per-active-tool plan and hidden-tools notice remain authoritative; no new panel or row claim is added. Progress clears with tool completion/turn end.

## Headless compatibility

Text mode writes a bounded `subagent … running …` line to stderr per heartbeat. Stream-JSON adds `subagent.progress` with bounded `dispatchId`, `agentName`, `phase`, optional `toolName`, and integer `elapsedMs`; no task/payload/transcript. Final JSON emits no progress because its stdout contract is one final object. Subscriptions are removed before cleanup terminalization.
