# SRF-017 CodeGraph preflight

## Goal

Prevent known CodeGraph semantic repository-read tools from making a doomed MCP tool invocation when their target project has no usable `.codegraph/codegraph.db`. Return one successful, bounded result that sends the agent directly to ordinary shell/file inspection while retaining byte-identical pass-through for usable targets.

## Requirements

- Attach policy at the existing MCP tool-registration boundary; do not fork the SDK loop, add a model call, initialize an index, or create another context/output channel.
- Identify only the configured `codegraph` MCP client and the server's known semantic read tool names. Unrelated MCP clients and unknown CodeGraph tools remain untouched.
- Inspect the current project once per runtime policy. Resolve and cache explicit absolute `projectPath` targets independently so another initialized project remains usable when the current project is not.
- Treat absent, unreadable, non-regular, symlinked, or structurally invalid index state conservatively as unavailable. Reject relative, traversal-bearing, non-string, NUL-bearing, and oversized explicit paths without filesystem traversal.
- On unavailable state, do not invoke the MCP tool. Return bounded deterministic success text naming the target/state and directing the agent to `bash`/`fileEditor` shell/file inspection.
- On available state, delegate the original MCP tool unchanged and preserve its stream/result bytes.
- Parent and child catalogues must share the wrapped tool policy. Existing permission/intervention ordering, MCP startup/disconnect, and `/mcp` status projection remain unchanged.
- Preserve the Host-owned `docs/research/backlog_index.md` change exactly and exclude it from commits. Do not edit `docs/iteration-log.md`.

## Acceptance Criteria

- [ ] A focused network/model-free suite using real SDK Agent/MCP-shaped tools proves uninitialized current target, repeated fallback, initialized current target, initialized/uninitialized explicit targets, unsafe paths, malformed/unreadable state, unrelated tools, and shared parent/child catalogue policy.
- [ ] The suite proves fallback calls do not reach the MCP server, pass-through results are byte-equivalent, and preflight creates/rewrites no project files.
- [ ] `spike/verify-mcp-command.ts` and `spike/verify-subagents.ts` pass.
- [ ] `pnpm typecheck`, one full `pnpm test`, and `pnpm build` pass.
- [ ] Backend contracts and the AGENTS load-bearing index document the invariant, with `AGENTS.md` remaining below 32 KiB.
