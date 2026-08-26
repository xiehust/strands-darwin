# Design — SRF-017 CodeGraph preflight

## Boundary

The gap lives where the SDK converts an MCP client into registered `McpTool` instances. Today `Agent.initialize()` calls `McpClient.listTools()` and registers those tools unchanged, so interventions cannot return a successful synthetic result before the MCP body. Darwin will wrap only known semantic tools listed from the configured server named exactly `codegraph`, immediately after the existing initialize step and before the child catalogue is captured.

## State and validation

A runtime-owned `CodeGraphPreflight` receives the canonical project root. It checks that `<target>/.codegraph/codegraph.db` is a non-symlink regular file, opens it read-only with `O_NOFOLLOW`, and verifies the SQLite header plus CodeGraph's structural schema records (`files`, `nodes`, `edges`, `schema_versions`) in a bounded file read compatible with Darwin's Node 20 floor. It never initializes, writes, or calls the CodeGraph process. Results are cached by normalized absolute target; the current root is primed once during runtime assembly.

Explicit `projectPath` is accepted only as a bounded absolute lexical path without NUL or `.`/`..` segments. Symlink targets degrade unavailable rather than being followed. This makes target identity deterministic and avoids escape/alias ambiguity while preserving ordinary explicit absolute paths to another initialized project.

## Tool policy

Known semantic server tool names are `search`, `explore`, `node`, `callers`, `callees`, `impact`, and `files`; `status` remains an ordinary MCP call because it is a capability/status tool rather than a primary semantic reader. Prefixes do not matter because wrapping is scoped by the exact configured MCP client identity, and each listed `McpTool` carries its client.

The wrapper preserves name, description, and tool spec. For usable targets it delegates `yield*` to the original tool, preserving every event and the final `ToolResultBlock` object. For unavailable targets it returns one successful `ToolResultBlock` with bounded deterministic text naming the target/reason and directing use of `bash`/`fileEditor` shell/file inspection. No MCP call occurs.

The parent registry replaces tools before `agent.tools` is captured. The resulting wrapped objects are therefore also the child allowlist catalogue. MCP clients themselves remain owned by the existing load/disconnect path, and `/mcp` continues projecting the clients' registered names without listing or reconnecting.

## Expected files

- `src/mcp/codegraph-preflight.ts`: validator, wrapper, registry application.
- `src/agent/runtime.ts`: prime and apply policy after MCP discovery.
- `spike/verify-codegraph-preflight.ts`: focused real Agent/in-memory MCP suite.
- `spike/run-tests.ts`: include focused suite.
- `.trellis/spec/backend/strands-sdk-contracts.md`, `docs/architecture/load-bearing-decisions.md`, `AGENTS.md`: load-bearing contract.
- Trellis task artifacts/journal.

## Explicit non-goals

No SDK patch, MCP config mutation, server reconnect, auto-index, model/network call, permission change, special target path, tool-description rewrite, or `/mcp` output change.
