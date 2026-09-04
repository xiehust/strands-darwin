# Restore direct streaming by removing the completion guard

## Goal

Restore real-time interactive output for tool results, progress checklists, and assistant text by removing the driver-owned completion guard and its whole-turn transaction.

## Background

- The reported TUI displays active tool names while a turn runs, but completed tool output and assistant text appear only when the whole turn ends.
- `App.runTurn()` currently collects every public event through `collectCompletionCandidate()` and dispatches one `turnCompleted` action after `runWithCompletionGuard()` settles. This deliberately disables ordinary streaming for every interactive turn.
- The guard was introduced from one reflected session with two consecutive internal-note `endTurn`s. A scan of 181 locally retained trajectories found zero `completionGuardSuppressed` terminals after deployment, while six private unfinished-plan continuations occurred and often returned to a user decision boundary rather than completing work.
- The transaction has already required an overflow-loss correction and now spans TUI, headless protocols, runtime, trajectory recording, reducers, tests, and architecture contracts.
- The user explicitly chose removal over further transactional refinements.

## Requirements

1. Remove internal-note classification/suppression and unfinished-plan automatic continuation, including the currently uncommitted future-promise classifier expansion.
2. Restore the interactive driver to dispatch ordinary SDK events as they arrive through `streamEvent`; tool completion, successful `update_plan`, and assistant text deltas must become visible before terminal `agentResultEvent` / turn completion.
3. Keep `update_plan` itself unchanged: successful events still replace the transient live checklist, and ordinary turn end still appends one bounded final checklist and clears live state. It must not start another model turn.
4. Restore text and structured headless drivers to ordinary streaming consumption while preserving their existing exact stream-interruption and max-token recovery semantics and output/privacy contracts.
5. Remove guard-only runtime, trajectory, reducer, schema, test, and documentation surfaces. Existing historical trajectory lines containing `completionGuardSuppressed` may remain readable as unknown extra JSON fields under schema v1; no migration or rewrite is allowed.
6. Add a free deterministic pty timing regression proving tool result/checklist and assistant output are public while the fixture model turn is deliberately still open, then prove the final transcript contains each output once.
7. Keep prompt guidance as the only defense against internal TODO/future-action prose; do not add post-turn retry or another completion classifier in this task.

## Acceptance Criteria

- [x] Interactive tool result and plan state are observable before the scripted turn reaches its terminal event.
- [x] A complete assistant line enters the TUI before the scripted turn reaches its terminal event, with no duplicate final text.
- [x] Ordinary no-tool answers still stream and finish normally.
- [x] An unfinished checklist ends the turn without a private continuation or extra model invocation.
- [x] `src/agent/completion-guard.ts`, its focused suite registration, `turnCompleted`, `AgentRuntime.beginCompletionGuardTurn`, deferred trajectory methods/field, and completion-guard contracts are removed.
- [x] Stream-resumption, max-token, structured-headless, update-plan, stream/static, TUI timing, trajectory, full test, typecheck, build, and diff checks pass.

## Out of Scope

- A replacement post-turn recovery mechanism.
- Changes to the SDK agent loop, models, providers, permission queue, or prompt queue.
- Rewriting historical trajectory files.
- Visual redesign of tool, plan, or assistant rows.
