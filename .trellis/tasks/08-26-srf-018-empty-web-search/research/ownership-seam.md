# SRF-018 ownership and API seam

## Evidence

- Darwin loads `~/.darwin/mcp.json`; the active entry is named `web-search` and runs external package `kiro-web-search` through `uvx`. There is no Darwin-owned search provider under `src/`.
- The reflected trajectory records `web-search_search` with input query `site:docs.aws.amazon.com/bedrock-agentcore/latest/devguide "minimum" "recommendation" sessions` and an SDK `ToolResultBlock` with `status: "error"` and text `Error calling tool 'search': Upstream error: {'code': -32602, 'message': 'Tool returned no results'}`.
- Cached `kiro-web-search` 0.1.3 source confirms the provider forwards upstream `error` responses as `UpstreamError`; malformed input is separately rejected and HTTP/URL/invalid-payload failures have distinct messages.
- The Strands SDK owns MCP conversion: `McpTool.stream()` calls `McpClient.callTool()`, maps an MCP result's `isError` bit to `ToolResultBlock.status`, and converts thrown MCP errors through `createErrorResult`.
- Darwin already has an honest post-registration seam in `AgentRuntime.create`: after `agent.initialize()` discovers MCP tools, runtime policy may replace selected registered tools. `CodeGraphPreflight` proves this seam and decorates the SDK's tools-changed callback. The resulting `agent.tools` array is captured once as `childTools` and supplied to every `SubagentTool` child.

## Conclusion

The premise holds without owning or changing the external provider. At the post-registration seam Darwin can wrap only the configured client named `web-search` and its server-side tool named `search`. The wrapper can delegate first, then normalize only the exact provider no-hit error signature (`status: error`, no attached thrown error, one text block matching the recorded MCP error). All successful payloads, other provider errors, transport/auth/timeout errors, malformed-input errors, yielded events, permissions, hooks, trajectory and MCP lifecycle remain untouched.

This is necessarily provider-specific compatibility policy, not generic error weakening. The successful replacement should be deterministic JSON preserving the original query, e.g. `{ "query": ..., "results": [], "totalResults": 0 }`.