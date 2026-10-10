# Darwin self-evolution backlog — priorities 161–180

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-121 — Parent-visible subagent reports omit child reasoning blocks

- Status: `done`
- Priority: 161
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-10.md`](../research_2026-10-10.md) (run `05:32:26Z`)

### Implementation / acceptance evidence

Accepted 2026-10-10 at `ad96efcd2afe6d7a577b1d128a300fbca0f5adfe`. Child session `session-20261010-080517770`, task `bg-3d8c0618-ccb5-421a-bc35-2cb1a7e38ce2`, exit 0. Host gate `bg-dbac56f0-f70b-49a9-ada1-c501ba909e86`, exit 0: child-result-text 30/0, report-projection 49/0, failed-child-text 43/0, subagents 88/0, workflow 38/0, typecheck, full tests, build, no FAIL lines, clean tree. See `docs/iteration-log.md` Batch 174.

### Notes / blockers / abandonment reason

`SubagentTool` turns a successful child into the parent tool result with `projectChildReport(withRetainedMaxTokensText(result.toString(), …))`. Installed `@strands-agents/sdk@1.18.0` `AgentResult.toString` appends every `reasoningBlock` as a `💭 Reasoning:` section ahead of or beside the answer. That text enters parent context. `docs/architecture/sub-agents.md` (Context and result isolation) and `docs/user-guide/development.md` already name the leak and place the fix in `SubagentTool`: the trajectory must record what the parent actually received, not a second hidden copy.

The failure path already refuses this. `failed-child-text.ts` `textOf` keeps `textBlock` text only. `workflow-tool.ts` `terminusText` does the same. The exception is `withRetainedResult`, which rewrites via `toString()` when max-tokens partials are retained and can therefore fold reasoning into a text block that `terminusText` will later keep.

Build the success report from assistant `textBlock` text plus `citationsBlock` text, in block order, joined the way `toString` joins parts, then run the existing max-tokens retention and `projectChildReport` unchanged. Do not delete or rewrite lines inside `projectChildReport`: its contract is that a clean report is byte-identical and imitation lines are escaped, never removed. A reasoning-only result becomes the same empty string a text-less result already becomes; do not invent a substitute sentence. Apply the same extraction inside `withRetainedResult` so a retained partial cannot reintroduce reasoning. Do not change dispatch records, heartbeats, the failure wrapper, or child transcripts.

Acceptance: a fixture result with a reasoning block and a text block yields only the text at the subagent success seam and at the workflow rewrite seam; citation text is kept; a clean text report is unchanged by `projectChildReport`; reasoning-only is empty. Existing `verify-report-projection`, `verify-failed-child-text` and subagent/workflow suites stay green. `pnpm typecheck`, `pnpm test`, `pnpm build`. Update the subagent architecture sentence and the known-limitation line so they describe the new behavior. No SDK patch and no new dependency.

## SER-122 — Upgrade the pinned Strands SDK to 1.20.0 while preserving Darwin's patched contracts and MCP compatibility

- Status: `not-started`
- Priority: 162
- Score: 12
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 4
- Origin report: [`research_2026-10-10.md`](../research_2026-10-10.md) (run `13:46:11Z`)

### Implementation / acceptance evidence

Not implemented. Acceptance requires exact installed/manifest/workspace/lock 1.20.0, rebased patch and generated npm patch, Host typecheck/full tests/build and real registry install verification. Re-verify all load-bearing pinned-patch contracts, MCP OAuth/prompts/wrappers, usage and reasoning. Record exact commands/outcomes and accepted commit here.

### Notes / blockers / abandonment reason

User explicitly requested latest SDK. Official [1.20.0 release](https://github.com/strands-agents/harness-sdk/releases/tag/typescript%2Fv1.20.0) published 2026-10-08; npm latest confirmed 2026-10-10. See report S1–S3/R1–R5. Upgrade `patches/@strands-agents__sdk@1.18.0.patch` to the target version with the existing pnpm patch workflow; preserve still-needed fixes and new upstream behavior. Review SER-101 provenance hunks against upstream before porting; do not duplicate a shipped equivalent. SDK MCP client 2.x is a compatibility risk requiring explicit verification. `pnpm build` regenerates `dist/patches/`. Respect `minimumReleaseAge`; wait if held, never bypass. No automatic migration to experimental contextManager, vended subagent/router or Agent.shutdown. Dependency first: SER-123 follows this accepted upgrade. No implementation acceptance yet.

## SER-123 — Adopt the SDK public MCP tool owner accessor in CodeGraph and web-search wrappers

- Status: `not-started`
- Priority: 163
- Score: 12
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-10.md`](../research_2026-10-10.md) (run `13:46:11Z`)

### Implementation / acceptance evidence

Not implemented. Acceptance: public typed `McpTool.mcpClient` owner checks replace both private-field casts; real discovered tools and refreshed tools retain exact-client wrapping, foreign and non-MCP tools unchanged, no extra list/connect. Run CodeGraph/web-search suites with negative controls, Host typecheck/full tests/build. Record accepted commit and exact evidence here.

### Notes / blockers / abandonment reason

Depends on accepted SER-122. Upstream [PR #4863](https://github.com/strands-agents/harness-sdk/pull/4863) exposes a read-only getter for the original client without connecting. `src/mcp/codegraph-preflight.ts` and `src/mcp/web-search-empty-results.ts` currently use `mcpOwner` with `as unknown as { mcpClient?: unknown }`; this is the exact cast upstream replaced. Preserve existing wrapper behavior, streaming bytes/events, permission gates, parent/child and refresh lifecycle; do not widen server matching or introduce discovery. Follow the two load-bearing architecture sections. No product UX change is intended.
