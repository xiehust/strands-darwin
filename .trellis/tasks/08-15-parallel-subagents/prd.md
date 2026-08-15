# Parallel inspectable subagents with source-labelled approvals

Self-evolution direction **SER-002** (`docs/research/backlog_index.md`). Peer reference: Codex
subagents — parallel specialized agents, inspectable agent threads, approvals labelled with
their source thread.

## Goal

Make subagent work parallel *and* inspectable: concurrent read-heavy delegation, permission
prompts that say which agent asked, and per-dispatch state observable from the runtime and the
TUI — without child transcripts ever entering parent conversation context, and without forking
or intercepting the SDK agent loop.

## Measured SDK behaviour (decided before designing)

Probed offline with scripted models against `@strands-agents/sdk@1.12.0`:

1. `resolveToolExecutor(undefined)` returns `ConcurrentToolExecutor`, and darwin never sets
   `toolExecutor`. Two `subagent` blocks in one assistant message, each child model sleeping
   300 ms: children started at 13 ms and 14 ms, whole turn 317 ms (not ~600 ms). **Parallel
   dispatch already works**; nothing in `SubagentTool` needs restructuring.
2. Hook callbacks — hence `InterventionHandler.beforeToolCall`, hence `PermissionGate` — are
   dispatched one event at a time by the single `Agent._streamCore` loop. Two gated parent
   calls in one message ask strictly in sequence (measured 10 ms then 213 ms with a 200 ms
   handler). So darwin gets **parallel execution, never parallel prompting**, and a *gated*
   parent tool call serializes later `tool_use` blocks of the same message.
3. Each child Agent runs its own stream/hook loop, so several children can have requests
   pending at once (measured 2). `BeforeToolCallEvent.agent` carries the identity: parent
   `id='darwin'`, child `id='darwin-subagent-<name>-<uuid>'`, `name=<definition name>`.

## Requirements

- **R1 Concurrency.** Two dispatches requested in one assistant turn run concurrently. No
  runtime change: prove it with an offline regression test and document the executor facts,
  including that `toolExecutor` must never be set to `'sequential'`.
- **R2 Approval provenance.** Every permission request carries its originating agent (parent,
  or the named child plus its dispatch identity) and the TUI renders that label — always,
  including `[parent]`. No new frame row: the label rides the existing summary line.
- **R3 Observability.** Per-dispatch state (agent name, bounded task summary, state, elapsed)
  is observable from the runtime and surfaced in the TUI, following the accepted
  background-task shape: runtime-exposed manager, observer-only subscription, bounded
  presentation-time projection. Child transcripts still never enter parent context.
- **R4 Read-heavy first.** No attempt to make concurrent write delegation safe. The limitation
  is explicit in code comments, docs and specs; no new denial path is added.

## Constraints

- `AgentRuntime` stays the only SDK `Agent` assembly and stays thin: extend through
  interventions/plugins/tools. The dispatch registry is constructed *before* the gate and only a
  narrow resolver is injected.
- `AssessedPermissionRequest.source` is required; `classify()` / `PermissionRequest` stay
  untouched so unrelated callers (`turn-state.ts`, hooks, tests) do not churn.
- `src/headless.ts` stderr records are not modified.
- `docs/research/*` is Host-owned this run and must not be edited.
- No new dependencies.

## Acceptance Criteria

- [ ] Two child dispatches in one turn overlap in time, proven without model calls.
- [ ] Every permission request carries a `source`; the prompt renders `[parent]` or
      `[<agent>#<dispatch>]`, and `allow?` plus the details block still render on a 50-row pty.
- [ ] `runtime.listSubagentDispatches()` and `runtime.subscribeToSubagentDispatches()` expose
      per-dispatch state; `/agents` reports it and terminal dispatches append a notice.
- [ ] The parent transcript still contains no child tool ids or child transcript text.
- [ ] `spike/verify-subagents.ts`, `verify-tui.ts cancelThenContinue`, `verify-tui.ts bashExit`
      still pass unchanged in behaviour.
- [ ] New `spike/verify-subagent-format.ts` registered in `spike/run-tests.ts`; new
      `verify-tui.ts agents` scenario (zero model calls); `verify-tui.ts approve` extended with
      the label assertions.
- [ ] `pnpm typecheck`, `pnpm test`, `git diff --check` pass; specs + AGENTS.md updated.

## Notes

- `/agents` reports dispatch *runs*; `runtime.info.agentNames` lists *definitions*. Different
  things, different paths — the empty state says `subagent dispatches — none in this run` so it
  cannot be mistaken for the catalogue.
- Dispatch identity is the parent `tool_use` id (short form), so the live row, the `/agents`
  report, the permission label and the completion notice all key on the same visible id.
