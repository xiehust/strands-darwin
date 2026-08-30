# PRD — SER-045: parent-only `workflow` tool (bounded declarative DAG of subagents via SDK `Graph`)

## Problem

darwin can delegate one task per `subagent` call, and parallelism only happens when the model
emits several `subagent` blocks in one assistant message. There is no way to declare a
multi-step delegation whose intermediate results flow worker-to-worker without round-tripping
through the parent context. The Strands SDK ships a `Graph` orchestrator (declarative
`{nodes, edges}`, AND-semantics scheduling, dependency-merged node inputs, `maxConcurrency`,
`cancelSignal`) that the repo does not use anywhere.

Origin: `docs/research/backlog/directions-061-080.md` § SER-045 (Priority 63);
`docs/research/research_2026-08-30.md` § Recommendation. Those two documents are the
authoritative requirement; this PRD records the concrete design decisions.

## Contract

New ordinary gated tool `workflow`, **parent-only** (registered after the child tool
catalogue is captured, exactly like `update_plan` and `subagent` — children can never see it).

### Input — data, never code

```
{
  nodes: [{ id, agent?, task }],   // 1..8 nodes; id 1..64 chars; task non-blank
  edges?: [[source, target]],      // plain string pairs only, 0..28; no handlers, no conditions
  maxConcurrency?: 1..8            // default: node count
}
```

Validation happens **before any child is constructed**; each refusal is one bounded error
string (a thrown `Error`, so the model sees an error tool result):

- more than 8 nodes / more than 28 edges → zod cap message
- empty/blank `task` → refusal naming the node id
- duplicate node id → refusal naming the id
- edge endpoint that is not a declared node id → refusal
- duplicate edge → refusal
- cycle (self-edges included) → refusal (Kahn's algorithm over the declared edges;
  validation only — scheduling stays the SDK's)
- unknown `agent` name → refusal listing available agent names (unlike `subagent`, which
  returns a non-error string per dispatch, an invalid workflow must construct zero children)

### Execution — the installed SDK `Graph`, never a reimplementation

- `new Graph({ id, nodes, edges, maxConcurrency, maxSteps: nodeCount })` — declarative
  constructor; AND-semantics scheduling and dependency-merged node inputs are the SDK's.
  `maxSteps = nodeCount` bounds the run (a validated DAG executes each node at most once)
  and silences the SDK's unbounded-graph warning. No `timeout` knob: no other delegation
  path in darwin has a wall-clock policy, and the run is already bounded by the node cap,
  `maxSteps`, and cancellation (deviation from the backlog note's feature list, deliberate).
- `graph.invoke('', { cancelSignal })` where the signal is an owned `AbortController`
  forwarding the parent tool context's `cancelSignal` (and `cancelActive()`/`shutdown()`).
  Graph-level cancellation aborts running nodes and never schedules unstarted ones.
- Each node is wrapped in a thin `InvokableAgent` adapter whose `id` is the user's node id
  (so edges resolve and `[node: <id>]` dependency labels read as declared) and whose
  `stream()` prepends the node's own `task` (plus codex-hook context) to whatever input the
  SDK hands it — the graph-level input is `''`, dependency merge stays the SDK's, empty
  text blocks from the placeholder input are dropped. The real child `Agent` keeps a unique
  `darwin-workflow-<agent>-<uuid>` id so concurrent workflows can never collide in the
  dispatch registry.

### Each node is the existing subagent child recipe

`SubagentTool.run`'s child construction (config/model snapshot per dispatch,
`composeSystemPrompt`, per-definition tool filtering, shared permission intervention with
`source` provenance, `SubagentDispatchRegistry` heartbeats + targeted `/agents cancel`,
codex-hook fork, `installMaxTokensRecovery`, bash-session reaping) is extracted into a
shared factory `src/agents/child-recipe.ts` used by **both** `SubagentTool` and
`WorkflowTool`. `SubagentTool` observable behavior does not change (same agent id format,
same hook order, same cleanup).

Workflow-specific recipe decisions:

- One config snapshot per workflow invocation (that *is* the per-dispatch snapshot: the
  whole graph is one dispatch burst); each node gets its own `createModel(config)`.
- One dispatch registry entry per node, begun before models are constructed, with
  `toolUseId` omitted so every node gets a distinct random dispatch id (all nodes share the
  parent `tool_use` id; deriving from it would collide and make targeted cancel fail
  closed as `ambiguous`).
- Per-node private `invocationState` (the adapter ignores the graph's shared reference) so
  each node keeps its own one-shot max-tokens recovery allowance, and retained partial text
  is folded back into the node's final message (rebuilt `AgentResult`) so downstream nodes
  and the terminus content see it.
- Targeted `/agents cancel <id>` before a node starts → the adapter returns a synthetic
  cancelled result ("Workflow node cancelled.") without invoking the child.
- Cleanup (bash-session reaping, codex-hook close, dispatch sweep) runs once in the tool
  callback's `finally` after the graph settles; any dispatch still `running` (a node the
  graph never started) is finished `cancelled`.

### Result — bounded terminus content only

- COMPLETED → the SDK `MultiAgentResult.content` (terminus nodes' combined content), text
  blocks joined; child transcripts stay private; no trajectory record of child events
  (nothing new is recorded — children are not the runtime's observed agent).
- CANCELLED → `"Workflow cancelled."` (mirrors `"Subagent task cancelled."`).
- FAILED → thrown bounded error naming failed node ids and the first line of each error.

### Permission classification

`case 'workflow'` in `permission.ts`: `kind: 'read'`, following the `subagent` precedent —
the dispatch itself is a read; every child tool call is gated individually by the shared
intervention, with `source` provenance resolved through the same dispatch registry. Summary
`workflow: N nodes`, one bounded detail row listing `id(agent)` pairs.

### Visibility

No new TUI frame surface. Node dispatches appear through the existing registry: `/agents`
rows, terminal-transition notices, headless `subagentProgress` events and heartbeats all
work unchanged because the registry is shared. (The live `workflow` tool row does not get
the per-dispatch elapsed suffix — that enrichment matches one dispatch to one `subagent`
row by tool-use id, which cannot apply to N nodes in one call; deliberate non-goal.)

### Description

The tool description states: input is data (never code), available agent names, and the
reads-parallel/writes-serialized rule (concurrent nodes share one working tree; parallel
branches are for reads; writes are serialized by edges).

## Files

- `src/agents/child-recipe.ts` — new shared factory (`buildRecipeChild`, `stopBashSession`).
- `src/agents/subagent-tool.ts` — use the factory; behavior unchanged.
- `src/agents/workflow-tool.ts` — new `WorkflowTool` (`tool`, `updateConfig`,
  `cancelActive`, `shutdown`).
- `src/agent/runtime.ts` — thin assembly: construct/register after child catalogue capture;
  wire `updateConfig` (`/model`), `cancel()`, `retire()`/`shutdown()`.
- `src/agent/permission.ts` — `workflow` classification.
- `spike/verify-workflow-tool.ts` + entry in `spike/run-tests.ts` — free suite, stub models.
- Spec: `.trellis/spec/backend/strands-sdk-contracts.md` new scenario;
  `AGENTS.md` table row (kept under 32 KiB); `docs/architecture/load-bearing-decisions.md`
  long-form section.

## Acceptance Criteria (from the backlog/origin report; Host re-runs)

- [ ] `pnpm typecheck` and full `pnpm test` green.
- [ ] `spike/verify-workflow-tool.ts` (free, in `pnpm test`) proves: validation refusals
      (cycles, unknown agents, duplicate/unknown ids, over-cap, empty task) with bounded text
      and zero children constructed; diamond DAG runs in dependency order with d's input
      containing b's and c's reports via SDK dependency-merge; every node registers a dispatch
      (heartbeat/cancel surface, permission provenance); result is terminus content only;
      parent cancel aborts the run including unstarted nodes.
- [ ] `verify-subagent-heartbeats.ts` and subagent-related free suites stay green.
- [ ] `workflow` absent from child tool catalogues (assertions on built children + runtime
      registration order).
- [ ] Spec updated as listed above.
- [ ] Commits on main; `docs/research/` untouched (Host owns backlog status).
