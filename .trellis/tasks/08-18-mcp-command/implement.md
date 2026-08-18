# Implementation notes — /mcp

## What landed

- `src/mcp/registry.ts`: `McpServerStatus`, `mcpServerStatuses()` (read-only projection;
  guarded private read of `_registeredToolNames`, never `listTools()` which connects
  lazily), `mcpConfigCandidates()` (single derivation of the three config locations, now
  also used inside `loadMcpClients`).
- `src/agent/runtime.ts`: `listMcpServers()` next to `listAllowRules()`.
- `src/tui/mcp-format.ts` (new): `formatMcpReport()`, `MAX_MCP_TOOL_NAMES = 8`,
  `McpConfigSources`. Pure; exported for the free spike.
- `src/tui/App.tsx`: `/mcp` handler above the busy check (with /tasks); argument form
  degrades to `/mcp takes no arguments`; report is a notice through `<Static>`.
- `src/commands/custom-commands.ts`: 13th built-in `mcp` + description;
  `MAX_COMPLETIONS` 12 → 13 in `src/tui/InputBox.tsx`.
- Spikes: `spike/verify-mcp-command.ts` (free, in `pnpm test`; 33 asserts over real
  SDK clients — InMemoryTransport healthy fixture, loadServers broken fixture, mutation
  check, formatter bounds); `spike/verify-tui.ts mcp` scenario (free pty acceptance:
  healthy fixture `spike/fixtures/tools-mcp.mjs` + broken command + ignored root
  `.mcp.json`, 9 asserts); completion scenario asserts the new row.

## Scope decision 2 (reconnect): NOT shipped

`connect(true)` flips `connectionState` without re-registering tools — the agent registry
is populated once in `initialize()` — so a reconnect verb would report a "connected"
server whose tools the model cannot call, and the await has no timeout to bound. Recorded
in the PRD, AGENTS.md and `.trellis/spec/backend/strands-sdk-contracts.md` § MCP.

## Verification

- `pnpm tsx spike/verify-mcp-command.ts` — 33 passed.
- `pnpm tsx spike/verify-tui.ts mcp` — 9 passed. `completion` — 31 passed.
- `pnpm typecheck` green; `pnpm test` — 42 suites, 0 failures.
- No model-calling suite run (none of the touched paths are fenced by one).

## Gotcha for future sessions

Two `fileEditor.str_replace` calls to the *same file* issued in one parallel batch
clobber each other (each starts from the same snapshot; the second write wins). Both
`custom-commands.ts` and `App.tsx` lost their first edit that way — caught by typecheck.
Edit one file sequentially.
