# SER-026 — `/status`: one consolidated read-only session report

## Problem

Every fact about the live session — model, cache, effort, permission mode, allow-rules,
MCP server states, skills, session id, trajectory/diagnostics state, token spend, context
size — is answerable today, but scattered across the header (which scrolls away) and six
separate slash commands. Codex documents `/status` as "show current session configuration";
darwin has the accessors but no consolidated projection.

## Requirement (backlog SER-026)

One consolidated read-only `/status` report: model/provider, cache and effort, permission
mode and live allow-rule count, MCP server states, skills count, session id,
trajectory/diagnostics state, process token spend and context estimate — composed from
existing state only, on the `/mcp` read-only-projection precedent.

## Binding constraints

1. **Read-only**: byte-zero mutation — no pointer moves, no config writes, no MCP
   reconnects. Connection states reported as they are; a failed server stated as failed
   exactly like `/mcp`.
2. **Unknown metrics stay unknown, never 0** (the `usageBuckets` rule from
   SER-007/SER-022): `formatUsageValue` renders `not reported`, and the report uses
   `usageBuckets` directly, never the bedrock `?? 0` projection of `usageRows`.
3. Built-in slash command: `MAX_COMPLETIONS` grows with it (14 → 15) and the free
   `verify-tui.ts completion` scenario asserts the `/status` row.
4. **Bounded report**: long lists (rules, servers, skills) are counted with representative
   names bounded by the existing truncation vocabulary (`… N more`), never dumped.
5. The report may restate what the header shows (a scrolled-away header is the use case)
   but the live frame gains no new row — output is transcript history like `/mcp`'s.
6. `/status` takes no arguments; anything else degrades to a usage notice.

## Design

- **New formatter** `src/tui/status-format.ts`: `formatStatusReport(facts: StatusFacts)`.
  `StatusFacts` is plain data drawn from existing accessors only:
  `runtime.config` (live provider/model), `runtime.info.sessionId` / `resumed`,
  `runtime.promptCache`, `runtime.thinking`, `runtime.permissionMode`,
  `runtime.allowRuleCount`, `runtime.listMcpServers()`, `runtime.info.skillNames`,
  `runtime.trajectoryStatus`, `runtime.diagnosticsStatus` (+ `info.diagnosticsFile`),
  `runtime.usage`, and the awaited `runtime.contextEstimate()` (failure degrades to an
  `unavailable — <reason>` line, never a failed report).
- The model line reuses the header's own suffix renderers: `formatPromptCache` and
  `formatThinking` **move** from `App.tsx` into `status-format.ts` (exported) so the
  header and `/status` cannot diverge. The context line reuses the `/context` value via a
  new exported `formatContextValue` in `context-format.ts` that `formatContextReport`
  itself now calls — one source, per the `/export`-reuses-`formatReplay` precedent.
- Mode wording mirrors the header's three states (`yolo — every tool call runs without
  confirmation`, `plan — read-only; …`, plain mode + rule count).
- `MAX_STATUS_NAMES = 6` bounds server and skill name listings.
- **Handler** in `App.tsx` sits with the other local reports *above* the busy check
  (available mid-turn like `/mcp`); tokens line carries the `/usage` honesty caveats
  (this-run scope, resumed caveat, turn-in-flight not counted).
- `BUILTIN_COMMAND_NAMES` gains `status` ("session configuration and state");
  `MAX_COMPLETIONS` 14 → 15.

## Acceptance Criteria

- [ ] `spike/verify-status-command.ts` (free, in `pnpm test`): every fact present from
      real fixture facts; unknown cache metrics render `not reported`, never 0; bounded
      server and skill lists; failed MCP server stated as failed; no-MCP and no-skills
      states; context-unavailable degradation; mode wordings.
- [ ] `spike/verify-tui.ts completion` (free): `/status` completion row asserted;
      `/status` submitted in a project with no MCP configured — report renders without a
      model call; `/status extra` degrades to a usage notice.
- [ ] `spike/verify-tui.ts mcp` (free): re-run proving `/mcp` unchanged; extended with one
      `/status` submit proving the failed server is stated there too.
- [ ] `pnpm typecheck`; `pnpm test` all suites 0 failed.
- [ ] README built-in command table gains `/status`; AGENTS.md checks updated if needed.
