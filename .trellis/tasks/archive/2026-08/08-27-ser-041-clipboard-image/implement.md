# Implementation plan

1. Extract shared byte-backed image decode/normalize entry point without changing path tool behavior; extend image-viewer focused checks.
2. Add bounded clipboard helper adapter and offline checks for success/failure/resource limits.
3. Extend `AgentRuntime.send` to construct one SDK content-block invocation while preserving all text observer inputs; add a deterministic capture-model check.
4. Model editor/queue image ownership, add `Ctrl+O`, bounded chip/removal/error UX, and account for the chip in frame budgeting.
5. Extend free pty queue/composer scenarios and focused pure tests for association and paste/search/permission ownership.
6. Update executable specs, load-bearing decision docs/AGENTS, task journal and archive records.
7. Run focused checks while editing, then typecheck, complete `pnpm test` once, and build. Review and commit.
