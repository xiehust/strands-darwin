# Implementation plan — SER-031 explicit project memory search

1. Extend the shared trajectory search options/outcome with optional active-session exclusion and bounded session enumeration, preserving default CLI behavior.
2. Add a trajectory-domain `search_memory` SDK tool adapter with fixed Unicode-safe query/hit/session/result bounds and an honest deterministic textual projection.
3. Assemble the tool for the parent before the existing child eligible-tool snapshot; classify it read-safe without weakening unknown-tool fallback.
4. Add focused offline acceptance coverage for real source files, hashes, bounds, provenance, damage/missing/omission states, no network/model/storage side effects, parent/child availability, permissions, and ordinary rendering structure.
5. Run focused suites while editing, then typecheck, then exactly one full `pnpm test`, then build and Trellis/git validations.
6. Update README, AGENTS load-bearing index, and the trajectory/SDK/error/TUI contracts; finish/archive the task and commit all authorized SER-031 changes using project convention.
