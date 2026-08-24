# SRF-015 subagent dispatch heartbeats and targeted cancellation

## Goal

Keep long blocking subagent dispatches visibly alive and let the user cancel one dispatch by its stable public id without cancelling sibling children or the parent turn.

## Requirements

- Publish a bounded heartbeat for every running subagent dispatch no later than every 30 seconds, with stable dispatch id, increasing elapsed time, and only a closed safe phase (`starting`, `model`, or bounded child tool name).
- The first heartbeat must not occur before its configured interval. Heartbeat timers/listeners must stop after success, failure, targeted cancellation, full parent cancellation, retirement, or shutdown.
- Never publish child reasoning, child messages/transcript, prompt text beyond the already-public bounded delegated-task summary, tool input/result, or child final result through progress.
- Reuse the existing dispatch registry and the TUI live tool row/frame budget. Heartbeats are visibility-only: no model message, trajectory event, permission decision, lifecycle-hook payload, or unbounded transcript notice.
- Add the smallest explicit user-only cancellation seam. Extend `/agents` with `/agents cancel <dispatch-id>`; do not expose a model-callable cancellation tool.
- Targeted cancellation must stop only the named running child and allow unrelated parallel children and the parent turn to continue. Unknown, ambiguous, already-requested, and terminal ids are harmless local refusals.
- Preserve existing Ctrl+C/full cancellation, SDK `Agent` construction ownership, concurrent SDK tool execution, final subagent result behavior, and parent/child conversation and trajectory isolation.
- Text headless output may show bounded progress on stderr; stream-JSON may add a compatible bounded progress event. Final-only JSON stdout remains one terminal object.
- Do not edit `docs/research/backlog_index.md`, `docs/iteration-log.md`, or the originating reflection.

## Acceptance Criteria

- [x] Real offline `Agent`/`SubagentTool` coverage proves no early heartbeat, periodic stable-id/increasing-elapsed progress, safe phase allowlisting, and canary absence.
- [x] Two concurrent children have distinct progress identities; cancelling one leaves the other running to one successful final report.
- [x] Unknown and terminal ids refuse locally; parent full cancellation still cancels all active children.
- [x] Success, failure, targeted cancellation, and full cancellation leave no later heartbeat/listener/timer activity.
- [x] TUI progress stays in existing granted tool rows with stated omission behavior; no frame overflow is introduced.
- [x] Text and stream-JSON headless visibility is bounded and clean; final-only JSON remains unchanged.
- [x] Child final report reaches the parent exactly once and no child transcript/trajectory event is introduced.
- [x] Focused suites plus existing subagent, frame-budget, trajectory, structured-headless, permission, and completion-guard checks pass, followed by typecheck, one full `pnpm test`, and build.
- [x] Architecture, backend/frontend specs, and AGENTS.md index record the new invariant.
