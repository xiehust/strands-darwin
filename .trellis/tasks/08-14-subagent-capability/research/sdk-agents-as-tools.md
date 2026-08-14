# SDK agents-as-tools research

Verified against installed `@strands-agents/sdk` 1.12.0 and the Strands documentation on 2026-08-14.

## Available SDK pattern

The SDK accepts `Agent` in another agent’s `tools` array or exposes `agent.asTool()` with custom name/description and `preserveContext`. The default resets child state between calls.

## Why darwin needs a custom wrapper

Installed `AgentAsTool.stream()` iterates the child `agent.stream()` and forwards every non-tool-stream child event as a parent `ToolStreamEvent` before returning the final text. That is useful for progress UIs but violates darwin’s requirement that child reasoning, messages, and intermediate tool activity not enter the main context/rendering path.

A custom SDK `Tool` should instead consume the child invocation privately and return only `AgentResult.toString()` (or text from `lastMessage`) as its result.

## Permission contract

`Agent` accepts `interventions` independently of its tool list. Attaching the same `PermissionGate` instance to every child preserves live allow-rules and the existing permission bridge. Tool allowlists are only capability filters; interventions remain the authorization boundary.

## Lifecycle facts

- `printer: false` is required for every child.
- No child `SessionManager` means fresh, non-persisted context.
- Each child model should be separately constructed from the current config to avoid parent/child mutable model state sharing.
- `Agent.cancel()` is cooperative and active tools must cooperate or finish; child tracking is therefore needed for parent cancellation.
- The vended bash tool owns a persistent session per agent after first use and must be directly restarted during child cleanup.
- MCP tool instances/clients may be shared, but only the main runtime should disconnect the clients.

## Sources

- Strands docs: `https://strandsagents.com/docs/user-guide/concepts/multi-agent/agents-as-tools/`
- Installed declarations/source: `node_modules/@strands-agents/sdk/dist/src/agent/agent-as-tool.{d.ts,js}`
- Installed agent/tool contracts: `node_modules/@strands-agents/sdk/dist/src/agent/agent.d.ts`, `tools/tool.d.ts`, `registry/tool-registry.d.ts`
