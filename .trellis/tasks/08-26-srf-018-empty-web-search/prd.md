# SRF-018 successful empty web search results

## Goal

Verify the externally supplied web-search ownership seam; if controllable, normalize successful zero-hit responses without weakening true errors, cover parent/child catalogue behavior, update contracts, verify, and commit.

## Requirements

- Normalize only a completed zero-hit result from the configured `web-search` MCP client's server-side `search` tool into a successful deterministic empty-result payload that preserves the submitted query.
- Keep non-empty successes byte-equivalent and retain errors for malformed input, transport, authentication, timeout, and all provider/service failures other than the verified no-hit signature.
- Apply policy at Darwin's existing post-`Agent.initialize()` MCP registration seam and preserve it across SDK tool-list refreshes.
- Capture the wrapped catalogue for children so parent and child agents share behavior without changing permissions, hooks, retry accounting, trajectory, output protocols, or MCP lifecycle.
- Add no model call, network call, search implementation, dependency, hard-coded query/site, generic error rewrite, or SDK-loop fork.
- Preserve and exclude the Host-owned `docs/research/backlog_index.md` modification; do not edit `docs/iteration-log.md`.

## Acceptance Criteria

- [x] A network/model-free real MCP-shaped suite proves zero hits become success with query context, one/many hits pass through byte-equivalently, transport/provider and malformed-input failures remain errors, refreshes retain policy, and a real child receives the same wrapped catalogue.
- [x] The focused suite proves no project file mutation and is included in `pnpm test`.
- [x] Affected retry-guard/tool-hooks/subagent checks pass.
- [x] `pnpm typecheck`, one full `pnpm test`, and `pnpm build` pass in that order without repeating green checks.
- [x] The backend SDK contract, architecture rationale, and AGENTS load-bearing index document the new narrow invariant; `AGENTS.md` stays below 32 KiB.
- [x] Task artifacts are completed and ready for the authorized archive/journal/commit workflow without the Host-owned backlog marker.
