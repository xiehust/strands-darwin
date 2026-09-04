# Implementation plan — SRF-017 CodeGraph preflight

1. Add a narrow CodeGraph MCP tool preflight module with bounded path parsing, read-only SQLite structure validation, per-target caching, deterministic fallback, and transparent usable-path delegation.
2. Integrate it after `Agent.initialize()` and before the child tool catalogue is captured, replacing only known semantic tools belonging to the exact configured `codegraph` client.
3. Add a network/model-free focused suite over real SDK Agent and in-memory MCP tools. Cover current/explicit targets, repeated fallback, unsafe paths, invalid state, pass-through identity, unrelated tools, child catalogue reuse, and filesystem immutability.
4. Run focused suite, `verify-mcp-command.ts`, and `verify-subagents.ts`; fix any failures.
5. Document the invariant in backend contracts, architecture rationale, and AGENTS index.
6. Run `pnpm typecheck`, one full `pnpm test`, and `pnpm build`; archive/journal and commit all task work except the Host-owned backlog marker.
