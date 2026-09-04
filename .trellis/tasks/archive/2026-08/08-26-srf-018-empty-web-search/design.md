# Design — SRF-018 successful empty web search

## Boundary

The behavior gap is not in search execution: `web-search` is an external `kiro-web-search` MCP server. It lives in Darwin's runtime-owned MCP catalogue after Strands discovers tools. Add one runtime-local compatibility policy that selects only client `web-search` plus server tool `search`, wraps the registered `Tool`, and decorates tools-changed refreshes exactly like the existing CodeGraph policy.

Expected source changes:

- `src/mcp/web-search-empty-results.ts`: selection, exact result classifier, successful empty payload, transparent delegation, and refresh preservation.
- `src/agent/runtime.ts`: apply policy after MCP initialization and before child catalogue capture.
- `spike/verify-web-search-empty-results.ts`: real in-memory MCP/Agent-shaped focused contract, including child catalogue and no-mutation proof.
- `spike/run-tests.ts`: include the focused suite in the fast gate.
- `.trellis/spec/backend/strands-sdk-contracts.md`, `docs/architecture/load-bearing-decisions.md`, `AGENTS.md`: record the narrow compatibility invariant.

No provider implementation, MCP config, SDK patch, permission/hook/retry logic, trajectory/output code, dependency, or external installation changes.

## Classification

Delegate to the original tool and inspect only its final `ToolResultBlock`. Normalize iff all are true:

1. the selected owner/tool identity matched during registration;
2. final status is `error`;
3. no attached thrown `error` exists;
4. content is exactly one text block;
5. text matches the recorded provider chain for MCP code `-32602` and message `Tool returned no results`.

The replacement is one success text block containing compact JSON with the original string `query`, `results: []`, and `totalResults: 0`. Missing/non-string queries cannot be normalized. Every yielded stream event and every non-match final result is returned unchanged.

## Shared catalogue and lifecycle

Apply after parent `initialize()` and before `const childTools = agent.tools`. Thus both parent and real children use the identical wrapper object. Decorate the SDK callback installed by `Agent.initialize()` so `tools/list_changed` cannot restore raw search tools, while retaining the SDK callback's removal/addition behavior. Do not reconnect, list tools again, or alter disconnect ownership.

## Verification

Use linked in-memory MCP transports and real `McpClient`, `McpServer`, `Agent`, `Tool`, and `SubagentTool` objects. A mode-driven server returns empty-error, one/many success, provider-error, malformed-input error, and throws a transport-shaped failure. Compare successful one/many calls before and after wrapping with `JSON.stringify`; prove exact errors retain status/content/error shape; trigger refresh; execute through a real child; hash a temporary directory before/after; use models that fail if the parent test calls one and a deterministic child-only tool-use model.