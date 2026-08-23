# Implementation plan

1. Add a pure completion query/dismissal identity helper with focused command/path tests.
2. Wire mirrored dismissal state into `App` rendering, acceptance, and input precedence; `Escape` dismisses completion first and recall otherwise without editor mutation.
3. Extend render/frame and real-pty scenarios for slash/path dismissal, re-arming, recall exit, second-Escape inertness, and modal ownership.
4. Update `/help`, English/Chinese user references, and frontend completion/recall/testing specs.
5. Run focused suites and free pty scenarios, then `pnpm typecheck`, one complete `pnpm test`, and `pnpm build`.
6. Run Trellis quality review, record the session, archive the task, and commit all accepted changes without closing the research backlog row.
