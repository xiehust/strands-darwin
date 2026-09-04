# Implementation plan

1. Extend `TrajectoryRecorder`/`TurnRecording` with the bounded no-throw input-durability barrier while retaining the existing append chain for ordinary records.
2. Reorder `AgentRuntime.send` so the barrier completes before `Agent.stream(input)` is invoked; add narrow resettable test seams for a real offline runtime.
3. Extend `spike/verify-trajectory.ts` for concurrent offline visibility, prefix/order, provider event/error identity, write failure, and timeout/non-hanging cleanup.
4. Run focused trajectory checks while editing, then stream-resumption and clear-session regressions.
5. Update session-trajectory and SDK contracts plus the AGENTS.md load-bearing invariant.
6. Run typecheck and exactly one complete `pnpm test` after source settles. Review the diff, preserve the Host-owned backlog edit unstaged, then commit task/source/test/spec artifacts.
