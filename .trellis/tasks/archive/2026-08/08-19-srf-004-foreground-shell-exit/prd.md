# SRF-004 foreground shell exit recovery

## Goal

Make a foreground command that intentionally closes its persistent bash shell with exit code 0 a successful tool call, preserving that command's captured stdout/stderr and clearly reporting that a replacement shell will be used.

## Requirements

- Reproduce the repository evidence: parallel foreground `bash execute` calls share one SDK session, attach concurrent listeners, and can all observe the shell close after a command ends with `exit 0`.
- Treat only a real shell close with numeric exit code 0 and no signal as success. Return the exiting call's captured stdout/stderr plus a visible, non-fatal restart notice.
- Ensure the next foreground command starts a healthy replacement persistent shell.
- Preserve nonzero and signalled exits as `BashSessionError` failures carrying the true exit code/signal metadata and captured stdout/stderr.
- Serialize foreground calls per Agent so output cannot be duplicated or attributed to a different concurrent invocation. Keep different Agents independent.
- Keep normal execute/restart compatibility and the existing foreground delegation seam in `src/tools/background-bash.ts`.
- Preserve runtime-owned persistent-shell cleanup and all background process-group TERM-to-KILL and `wait` invariants from SRF-003.
- Use the repository's existing pinned SDK patch mechanism; do not fork the SDK loop, add dependencies, or invent a second foreground execution backend.

## Acceptance Criteria

- [x] A real `printf`/stderr/`exit 0` foreground command resolves with exactly its output plus a restart notice, and a subsequent command succeeds in a replacement shell.
- [x] Real nonzero and signalled exits reject with their true metadata and captured output; neither is converted to success.
- [x] Parallel foreground calls on one Agent complete in invocation order with disjoint output, including one exit-0 call; no listener race duplicates the first call's result.
- [x] Normal persistent state, explicit restart, per-Agent isolation, runtime cleanup, background wait, and process-group reaping remain covered.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm tsx spike/verify-background-bash.ts`, `pnpm tsx spike/probe-cancel-exit.ts`, `pnpm tsx spike/verify-clear-session.ts`, and the free `bashExit`/`cancelThenContinue` TUI scenarios pass.
- [x] SDK contracts and Process exit architecture documentation describe the exit/restart and serialization behavior.

## Evidence and constraints

- Authoritative evidence: `docs/reflections/reflection_2026-08-19_session-20260819-094621980.md` F2 / SRF-004 and the in-progress SRF-004 row in `docs/research/backlog_index.md`.
- The installed SDK's `BashSession.run()` rejects every close before returning captured buffers and permits concurrent calls to attach listeners to the same streams/sentinel. The repository already pins SDK corrections in `patches/@strands-agents__sdk@1.12.0.patch`.
- The Host owns backlog acceptance closure and `docs/iteration-log.md`; this task must not edit either.
