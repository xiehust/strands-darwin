# Darwin self-evolution backlog — priorities 161–180

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-121 — Parent-visible subagent reports omit child reasoning blocks

- Status: `not-started`
- Priority: 161
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-10.md`](../research_2026-10-10.md) (run `05:32:26Z`)

### Implementation / acceptance evidence

(none yet)

### Notes / blockers / abandonment reason

`SubagentTool` turns a successful child into the parent tool result with `projectChildReport(withRetainedMaxTokensText(result.toString(), …))`. Installed `@strands-agents/sdk@1.18.0` `AgentResult.toString` appends every `reasoningBlock` as a `💭 Reasoning:` section ahead of or beside the answer. That text enters parent context. `docs/architecture/sub-agents.md` (Context and result isolation) and `docs/user-guide/development.md` already name the leak and place the fix in `SubagentTool`: the trajectory must record what the parent actually received, not a second hidden copy.

The failure path already refuses this. `failed-child-text.ts` `textOf` keeps `textBlock` text only. `workflow-tool.ts` `terminusText` does the same. The exception is `withRetainedResult`, which rewrites via `toString()` when max-tokens partials are retained and can therefore fold reasoning into a text block that `terminusText` will later keep.

Build the success report from assistant `textBlock` text plus `citationsBlock` text, in block order, joined the way `toString` joins parts, then run the existing max-tokens retention and `projectChildReport` unchanged. Do not delete or rewrite lines inside `projectChildReport`: its contract is that a clean report is byte-identical and imitation lines are escaped, never removed. A reasoning-only result becomes the same empty string a text-less result already becomes; do not invent a substitute sentence. Apply the same extraction inside `withRetainedResult` so a retained partial cannot reintroduce reasoning. Do not change dispatch records, heartbeats, the failure wrapper, or child transcripts.

Acceptance: a fixture result with a reasoning block and a text block yields only the text at the subagent success seam and at the workflow rewrite seam; citation text is kept; a clean text report is unchanged by `projectChildReport`; reasoning-only is empty. Existing `verify-report-projection`, `verify-failed-child-text` and subagent/workflow suites stay green. `pnpm typecheck`, `pnpm test`, `pnpm build`. Update the subagent architecture sentence and the known-limitation line so they describe the new behavior. No SDK patch and no new dependency.
