# Subagent capability — design

## Architecture and boundaries

Add a self-contained `src/agents/` module with three responsibilities:

1. `loader.ts` discovers and validates project Markdown definitions and prepends the built-in `general` definition.
2. `subagent-tool.ts` exposes one SDK `Tool` named `subagent`, creates a fresh child per call, and returns only the final child result.
3. The existing `AgentRuntime` remains the composition root: it supplies model creation, assembled project instructions, child-eligible tools, the shared permission gate, cancellation, and cleanup ownership.

This follows the SDK agents-as-tools pattern without using `Agent.asTool()`. SDK 1.12.0’s adapter forwards child agent events as parent tool-stream events; the custom tool deliberately consumes those events privately so intermediate child context never reaches the main transcript.

## Definition format and discovery

Direct children of `.darwin/agents/` with a case-insensitive `.md` extension are candidates:

```markdown
---
name: explorer
description: Searches a large code area and reports evidence.
tools:
  - bash
  - fileEditor
---

You are a repository exploration specialist...
```

The filename is only the source identity; `name` and `description` are required frontmatter strings. The body, excluding frontmatter, is the system prompt. `tools` is optional; when present it must be an array of unique non-empty strings matching exact registered child-tool names. Validate after the main agent has initialized and MCP/plugin tools are known. Bad entries become `{ file, reason }` diagnostics and do not abort startup.

The reserved `general` definition is code-owned, appears first, and has unrestricted access to the child-eligible tool set. Project definitions are sorted by name after deterministic filename scanning.

## Tool catalogue and restrictions

The child-eligible catalogue is the main agent’s initialized environment tools excluding `subagent` itself. It therefore includes vended tools, MCP tools, and plugin tools such as `load_skill` without hand-maintaining a second list.

A definition with no `tools` key receives the whole catalogue. A definition with `tools: []` receives none. Otherwise the child receives only exact matches. This is capability reduction, not authorization: every child `Agent` is also configured with `interventions: [sharedPermissionGate]`.

`PermissionGate.classify()` treats `subagent` as a safe/read-like orchestration call so delegating does not ask twice. The child’s actual write, execute, and unknown/MCP calls still enter the same gate and existing `PermissionBridge`; accepted in-session rules immediately apply across parent and child.

## Child creation and result flow

For each `{ task, agent? }` call:

1. Resolve the requested definition case-insensitively; default to `general` and return a structured error for unknown names.
2. Call the runtime-provided model factory against the current `liveConfig`. This snapshots `/model` state at dispatch time and avoids sharing mutable model state between concurrent parent/child requests.
3. Create a fresh SDK `Agent` with a stable per-definition name, unique invocation id, definition prompt plus the project `AGENTS.md` fragment, restricted tool list, shared permission gate, and `printer: false`. Do not attach session/conversation persistence, skills prompt plugin, or `subagent`.
4. Initialize and invoke it with only the delegated task.
5. Consume all child events internally. Extract the final `AgentResult` text and return it as the parent tool result; do not yield child stream events.
6. In `finally`, remove the child from the active set and directly restart its registered bash tool with history recording disabled. Keep a best-effort tracked cleanup path for runtime shutdown.

The parent SDK records only its own `subagent` tool use/result pair. Child messages remain reachable only while the call is active and are then discarded.

## Prompt composition

A child prompt is definition body followed by the already-loaded project-instructions fragment. It does not inherit the replaceable main base prompt, main messages, session summary, skills catalogue, or main prompt cache block. The definition itself is the child’s base role; AGENTS.md remains additive because repository rules must apply to every agent that can touch the repository.

The built-in prompt tells `general` to work independently, use tools when evidence is needed, obey project instructions, avoid asking the end user directly, and finish with a concise report including findings, changes, verification, and blockers as applicable.

## Cancellation and lifecycle

`SubagentTool` tracks active child `Agent` instances. `AgentRuntime.cancel()` first calls `subagents.cancelActive()` and then cancels the parent. The existing TUI cancellation path denies pending queue entries before calling runtime cancellation, so a child blocked in the shared permission bridge is released.

`AgentRuntime.shutdown()` asks the subagent tool to cancel and clean all active children, reaps the parent bash session, then disconnects shared MCP clients. Cleanup uses `Promise.allSettled`; child cleanup failure cannot skip parent/MCP cleanup.

MCP clients are shared tool instances, not child-owned processes. Children never disconnect them. The main runtime remains their sole lifecycle owner.

## Diagnostics and UI

`RuntimeInfo` adds accepted `agentNames` and skipped `agentProblems`. Valid definitions do not consume header height. Invalid definitions use the same startup-warning pattern as skills and custom commands in both Ink and the dev REPL. The main `toolNames` list includes `subagent`.

No child progress is rendered. The existing parent tool panel shows one running `subagent` call and then its compact final result, matching the isolation requirement.

## Compatibility, risks, and rollback

- Existing main sessions can resume with a newly added tool schema; no stored format changes.
- `/model` changes `liveConfig`; new children use it, while an active child keeps the model object created at dispatch.
- Child models inherit provider-level cache configuration from the active model config, but no manual system-prompt cache point is added around a custom child prompt.
- Concurrent subagent calls may queue permission prompts through `PermissionQueue`; the queue already serializes them.
- Removing `src/agents/` plus the narrow runtime/diagnostic wiring restores prior behavior; no migration rollback is needed.
