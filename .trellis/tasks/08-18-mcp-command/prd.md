# /mcp — inspect configured MCP servers in-session

Backlog direction SER-018 (docs/research/research_2026-08-18.md, run 2026-08-18T09:15:03Z).

## Problem

MCP servers are configured across up to three files (`~/.darwin/mcp.json`,
`.darwin/mcp.json`, root `.mcp.json`), loaded with `continueOnError`, and reported only as
a count in the header. A server that fails to spawn logs once at SDK level and then
contributes zero tools silently — the user experiences missing tools with no way to ask
darwin what it thinks its MCP world looks like. Peers treat this as table stakes: Claude
Code `/mcp` shows per-server status, Codex `/mcp` lists the tools callable this session,
OpenCode warns about the context cost of tool listings.

## Decision

A thirteenth built-in, `/mcp`, prints a **local report**: every configured server with its
connection state, a bounded list of its registered tool names with the total count, and
the config source(s) in effect — including overridden server names and an ignored root
`.mcp.json`. No model call; available mid-turn like `/tasks`.

### Reading state must not mutate state

`McpClient.listTools()` connects lazily (verified: `client.js` `listTools` begins with
`await this.connect()`), so the report never calls it. Instead:

- `connectionState` is a public getter (`'disconnected' | 'connected' | 'failed'`).
- Tool names are read from the client's `_registeredToolNames` — the set the SDK itself
  populated when `agent.initialize()` called `listTools()` and registered the tools. This
  is a narrow private-field read with existing precedent (`loadServersQuietly` reaches
  `_transport._serverParams` the same way), guarded so a future SDK shape change degrades
  to "names unavailable", never to a crash or a connection attempt.
- A `disconnected` server is stated as `not connected` honestly instead of connecting to
  count its tools; a `failed` one is stated as failed and "contributing no tools".

### Reconnect is NOT shipped (scope decision 2 exercised)

`connect(true)` alone would flip the state to `connected` but the agent's tool registry —
populated once during `initialize()` — would still hold zero tools from that server, so
the report would claim a working server whose tools the model cannot call. Making the
tools real needs `listTools()` + `toolRegistry.addOrReplace(...)` mid-session, which is
new lifecycle surface next to paths fenced by verify-background-bash / probe-cancel-exit,
and `connect(true)` itself has no timeout to bound the await. That risk is not boundable
inside this task, so inspection ships alone and the report states that a failed server
needs a restart to retry.

## Shape

- `src/mcp/registry.ts`: `mcpServerStatuses(clients)` → `{ name, state, toolNames }[]`
  (projection only: names, counts, states — constraint 4).
- `src/agent/runtime.ts`: `listMcpServers()` reading the private `McpLoadResult` live.
- `src/tui/mcp-format.ts`: `formatMcpReport(servers, sources)` — pure, exported for the
  free spike. Tool names capped at 8 per server with an explicit `… N more` remainder.
  Zero servers → `no MCP servers configured`, naming the candidate files darwin looked
  for. Sources block names every contributing path, project overrides, and an ignored
  root `.mcp.json`.
- `src/tui/App.tsx`: handler above the busy check (with /tasks); `/mcp <anything>`
  degrades to a usage notice. Report is a notice through `<Static>`; header unchanged.
- `src/commands/custom-commands.ts`: 13th built-in + description;
  `MAX_COMPLETIONS` grows to 13 (verify-tui.ts completion asserts every built-in).

## Acceptance Criteria

- [x] One healthy + one broken server: both named; broken stated `failed`, not omitted;
      healthy shows bounded tool names/count.
- [x] Config lines name the file(s) in effect, incl. ignored root `.mcp.json` when both exist.
- [x] `/mcp extra` → usage notice; no model call anywhere.
- [x] The report never changes any client's `connectionState` (asserted in the spike).
- [x] `pnpm typecheck`, `pnpm test` green; free suite `spike/verify-mcp-command.ts` added
      (in-process `InMemoryTransport` fixture from `@modelcontextprotocol/sdk` — already a
      direct dependency, no new dep).
