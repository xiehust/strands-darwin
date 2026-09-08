# Sub-agent architecture

Darwin exposes delegation as an ordinary `subagent` tool on the main Strands Agent. Every valid
call creates a fresh child `Agent`, gives it an independent conversation and an explicit tool
catalogue, waits for it to settle, and returns its rendered terminal result to the parent.

```text
user request
  → parent Agent calls subagent({ task, agent? })
  → SubagentTool resolves a definition and records the dispatch
  → a fresh model and child Agent are created
  → child.invoke(task) runs an independent SDK agent loop
  → AgentResult.toString() becomes the parent tool result
  → the parent Agent continues its turn
```

This is SDK composition rather than a fork of the SDK loop. The implementation is split across:

- `src/agents/loader.ts` — built-in, project, and user agent definitions;
- `src/agents/subagent-tool.ts` — delegation, child lifecycle, and result boundary;
- `src/agents/dispatch-registry.ts` — dispatch state and permission provenance;
- `src/agent/runtime.ts` — parent assembly and registration order;
- `src/agent/permission.ts` — shared permission enforcement;
- `src/tui/subagent-format.ts` — bounded tool rows, `/agents`, and completion notices.

## Definitions and discovery

The built-in `general` agent is always available. Darwin also reads direct Markdown files from:

```text
<project>/.darwin/agents/*.md
~/.darwin/agents/*.md
```

Project definitions are considered before user-global definitions, so a global file with the same
case-insensitive name is reported as a conflict rather than replacing the project definition.
`general` is reserved by the built-in.

A definition is Markdown with YAML frontmatter:

```markdown
---
name: explorer
description: Searches a code area and returns an evidence-based map.
tools:
  - bash
  - fileEditor
---

You are a repository exploration specialist. Trace the requested behavior, cite files and
symbols, and finish with a concise report for the parent agent.
```

`name`, `description`, and a non-empty Markdown body are required. Names match
`[a-zA-Z0-9_-]{1,64}` and are selected case-insensitively. The body becomes the child's base system
prompt. The optional `tools` field is an exact, case-sensitive capability filter:

- omitted: every child-eligible tool;
- `[]`: no tools;
- a list: only those registered tool names.

Invalid YAML, bad names, missing fields, empty bodies, unreadable files, duplicate names, and
unknown tool names skip only that definition and are surfaced as startup problems. Other valid
definitions remain usable. Definitions are loaded once during runtime startup.

## Runtime assembly and recursion boundary

Registration order is part of the architecture:

1. Construct and initialize the main Agent.
2. Let MCP clients and plugins finish registering their tools.
3. Snapshot `mainAgent.tools` as the child-eligible catalogue.
4. Validate agent definitions against those final tool names.
5. Construct `SubagentTool` with the catalogue and the shared intervention.
6. Register `subagent` on the parent only.

Waiting until initialization means MCP and plugin tools have their final names before definition
validation. Capturing the catalogue before registering `subagent` prevents recursive delegation: a
child cannot create a grandchild.

The parent-facing contract is:

```typescript
subagent({
  task: string,    // a complete, self-contained delegated task
  agent?: string, // defaults to "general"
}): Promise<string>
```

An unknown requested name returns the available names as an ordinary tool result and creates no
dispatch record.

## Per-dispatch child lifecycle

A valid call starts a registry record in `running` state, snapshots the current model configuration,
then creates a fresh model and child:

```typescript
new Agent({
  id: `darwin-subagent-${definition.name}-${randomUUID()}`,
  name: definition.name,
  description: definition.description,
  model,
  systemPrompt: composeSystemPrompt(definition.systemPrompt, projectInstructions),
  tools: toolsFor(definition),
  interventions: [sharedIntervention],
  printer: false,
})
```

Every dispatch therefore gets:

- a new model instance and Agent id;
- a fresh message history;
- no parent messages or conversation summary;
- no `SessionManager` and no resumable child session;
- the definition prompt plus the project's `AGENTS.md` instructions;
- its selected tools and the same permission intervention as the parent;
- no `subagent` tool.

A `/model` change updates the factory for future dispatches. An active child keeps the model from
its dispatch-time configuration snapshot.

After `child.initialize()`, Darwin invokes the task with `child.invoke(task)`. If that call rejects with
the exact stream-interruption `ModelError` (`Stream ended without completing a message`) and the child is
not cancelled, `SubagentTool` runs exactly one `child.invoke(STREAM_CONTINUATION_PROMPT)` on the same live
child — the same predicate and prompt the parent's driver uses, publishing the closed phase
`continuing-after-stream-interruption` — and a second failure of any class is rethrown as the original
interruption (`name`/`cause` preserved, the second message appended) through the failed-child-text
wrapper. This lives at the tool's call site only, never in the SDK loop or the recipe; `workflow` nodes
are not continued. The dispatch settles
as `succeeded`, `failed`, or `cancelled`. Cleanup always removes the child from the active set and
restarts its persistent bash session if it used one. Shared MCP clients remain owned by the main
runtime and are disconnected only during runtime shutdown.

### Continuing a settled child

The Agent object is dropped at settlement, but its *conversation* is not lost at once. `SubagentTool`
keeps, in a private bounded store (`src/agents/retained-children.ts`), a deep copy of the child's
`Agent.messages` plus the definition name and terminal state for the last `MAX_RETAINED_CHILDREN = 4`
settled `subagent` dispatches, keyed by dispatch id and evicted oldest-first. `succeeded` dispatches are
retained; `failed` ones only when the conversation ends in a complete assistant message with every tool
use answered (a refusal stop qualifies; a stream that died after a tool result does not); `cancelled`
never; `workflow` nodes never (they are built by `WorkflowTool`, not `SubagentTool.run`).

The parent-only `subagent` tool accepts an optional `continue: "<dispatch id>"`. The follow-up `task`
is then sent into that conversation: a fresh child is built by the same recipe with the retained
messages as its `messages` seed, under a **new** dispatch record whose only extra field is
`continuedFrom` (shown on the `/agents` row as ` — continues #<id>`), through the ordinary path —
concurrency cap, heartbeats, permission source labels, report projection, failed-child text, hooks,
background delegation. The continued dispatch is itself retained, so follow-ups chain within the
four-entry bound. An unknown, still-running, cancelled, evicted or skipped id, a `workflow` node, or an
`agent` naming a different definition is one bounded tool error before any model or child exists.

Nothing about this survives the runtime: `/clear` and `/rewind` build a successor runtime with a new
`SubagentTool` (the predecessor's store is cleared through `subagents.shutdown()`), and `shutdown()`
clears it. No bash session or Agent is retained, and the retained messages never reach a dispatch
record, `/agents` output or the trajectory.

## Context and result isolation

Darwin deliberately does not use SDK `Agent.asTool()`, because that adapter forwards child stream
events through the parent tool stream. Calling `child.invoke()` privately keeps intermediate child
messages and tool events out of the parent stream and session trajectory. The dispatch registry
also stores no child output—only agent name, delegated task, state, and timestamps.

The parent receives:

```typescript
withRetainedMaxTokensText(result.toString(), invocationState)
```

This is one rendered terminal result rather than a live child transcript. A current SDK caveat is
important: `AgentResult.toString()` can include rendered child reasoning as `💭 Reasoning:` text.
That text then enters parent context as ordinary tool-result content. Removing it would require a
projection change in `SubagentTool`; trajectory recording must preserve what the parent actually
received rather than silently rewrite it.

## Parallel dispatch

`SubagentTool` is re-entrant. Darwin does not maintain a worker pool or custom scheduler; it leaves
the Strands SDK's default `ConcurrentToolExecutor` in place. When one parent assistant message
contains multiple `subagent` tool blocks, their callbacks and child loops run concurrently:

```text
parent assistant message
  ├─ subagent task A ── child A ── report A
  └─ subagent task B ── child B ── report B
```

The offline contract measures two 300 ms children completing in about 303 ms rather than 600 ms.
Setting the parent tool executor to sequential would intentionally change this behavior and must
not be done accidentally.

Parallelism is for read-heavy work. Children share one working tree with no filesystem isolation,
locking, transaction, merge, or conflict detection. Concurrent writes can interleave. Searches,
reads, and analysis may run in parallel; mutation should remain on one agent at a time.

Dispatches are concurrent but not detached background jobs by default. Each tool promise resolves
only after its child finishes, and the parent model receives the tool results before continuing its
turn. The one exception is a call the model marks `_background_execution: true` (SER-064/SER-070):
the SDK's `backgroundTasks` plugin returns an acknowledgement at once and, in the interactive TUI,
the dispatching turn ends with the child still running; the report reaches the model in the next turn
that runs — the SDK attaches it as a `strands_background_task_result` pair, and a completion wake
starts that turn when the session is idle. `/clear` and `/rewind` refuse while such a delegation is
tracked. Headless runs keep the SDK waiting inside the invocation, so their one run still contains the
report. See `docs/architecture/load-bearing-decisions.md` § "Background delegation …".

## Permissions and source attribution

Calling `subagent` is classified as read-only and safe because delegation itself does not mutate the
project. Every tool requested by the child still traverses the same composed intervention as the
parent, including hooks, permission mode, live allow-rules, and the interactive bridge. A
definition's `tools` field limits capability; it never grants permission.

The runtime constructs `SubagentDispatchRegistry` before `PermissionGate` and injects a narrow
source resolver:

```text
BeforeToolCallEvent.agent.id
  → dispatch registry lookup
  → parent, or <agent>#<dispatchId>
  → permission request source
```

The child's id is attached before initialization, so its first gated call is attributed correctly.
Parent prompts render `[parent]`; child prompts render labels such as
`[explorer#a1b2c3d4]`.

Several children can request permission concurrently, while `PermissionQueue` presents one prompt
at a time so a keystroke cannot answer multiple calls. Source labels make every queued request
attributable. `plan` mode is enforced by the same intervention: reads proceed, while writes and
executes are denied before rules, classifiers, prompts, or configured pre-hooks can bypass it.

## Dispatch observability

Each valid dispatch is recorded in start order:

```typescript
interface SubagentDispatchStatus {
  dispatchId: string;
  agentName: string;
  task: string;
  state: 'running' | 'succeeded' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
}
```

The display id is derived from the parent tool-use id and shortened to eight characters. The same
`<agent>#<dispatchId>` appears in the live tool row, permission prompt, local `/agents` report, and
terminal completion notice.

`/agents` reads the in-memory registry, makes no model call, and remains available during a turn.
Terminal transitions publish once to observers; an observer failure cannot affect the child result
or prevent delivery to other listeners. Presentation code bounds long labels and tasks without
truncating registry state.

This observability is metadata-only. It must never become another route for child messages, tool
results, or reasoning to enter parent context.

## Cancellation and shutdown

`AgentRuntime.cancel()` cooperatively cancels every active child and the parent. Each child also
listens to its parent tool context's abort signal. Darwin checks that signal again after asynchronous
model construction, preventing cancellation in that gap from launching an orphan Agent.

Runtime shutdown cancels active children and waits for all tracked dispatch promises to settle so
per-child cleanup completes before process exit. The permission queue denies pending requests on
turn cancellation and closes permanently during application shutdown, avoiding a loop left waiting
for an answer that can no longer arrive.

## Deliberate boundaries

The design intentionally does not provide:

- persistent or resumable child conversations beyond the in-session `continue` store (nothing is
  written to disk; a process restart, `/clear`, `/rewind` or eviction ends continuability);
- steering a child while it runs — continuation is offered only after settlement;
- recursive child-to-child delegation;
- a background scheduler or autonomous swarm;
- parent access to the child's live transcript or tool stream;
- filesystem isolation or safe concurrent mutation;
- restoration of dispatch records after process restart.

Changing one of these boundaries requires revisiting context isolation, permissions, cancellation,
process cleanup, and verification together.

## Verification

The executable contracts are concentrated in:

- `spike/verify-subagents.ts` — discovery, fresh histories, tool filters, permissions, lifecycle,
  cancellation, concurrency, provenance, and registry behavior;
- `spike/verify-subagent-format.ts` — dispatch ids and bounded display projections;
- `spike/verify-continuable-children.ts` — the retained-conversation store and `subagent continue`:
  seeding, new record with `continuedFrom`, refusals, eviction, `/clear`/`/rewind` successors;
- `spike/verify-permission-modes.ts` — parent/child provenance and plan-mode behavior;
- `spike/verify-subagents-live.ts` — real main-to-child delegation and shared permission bridge;
- `spike/verify-tui.ts agents` — `/agents` behavior without model calls;
- `spike/verify-tui.ts approve`, `cancelThenContinue`, and `bashExit` — permission-frame,
  cancellation, and process-lifecycle integration.

The SDK-specific measurements and invariants are maintained in
`load-bearing-decisions.md` under "Subagents" and proven by `spike/verify-subagents.ts`.
