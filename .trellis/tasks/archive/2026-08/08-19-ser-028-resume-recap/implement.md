# Implementation plan — SER-028 resumed-session human recap

1. Add a focused read-only resume-recap projection beside trajectory replay, with deterministic
   selection, bounds and degradation notices.
2. Load it only on restored interactive startup and seed `App`'s existing reducer history; leave
   fresh/headless paths unchanged.
3. Add focused offline verification and a free real-pty resume scenario using a real SDK snapshot,
   exact trajectory and before/after hashes at 120x50.
4. Update session-trajectory, SDK/session, live-frame, TUI-testing and architecture contracts.
5. Run focused suites while editing, then typecheck; after source settles run full `pnpm test`
   exactly once, Trellis validation and `git diff --check`; update backlog/task records and commit.

## Verification outcome

- Focused projection: `verify-resume-recap.ts` — 20 passed.
- Free real-snapshot pty at 120x50: `verify-tui.ts resume` — 12 passed; trajectory,
  snapshot and pointer hashes unchanged; fresh session unchanged.
- Focused regression: `verify-trajectory.ts`, `verify-sessions-command.ts`,
  `verify-clear-session.ts` — all green.
- `pnpm typecheck` — exit 0.
- Final `pnpm test` — exit 0 (run once after source settled).
- Trellis validation — passed (only existing large-spec injection warnings).
- Final `git diff --check` — clean; the archived file has no trailing blank line.
