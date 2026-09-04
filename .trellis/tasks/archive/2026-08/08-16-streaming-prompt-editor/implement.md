# Implementation plan

1. Rename `InputBox`'s presentation contract from ambiguous `disabled` to explicit `editable`, preserving cursor/layout behavior for true and disabled styling for false.
2. Pass streaming as editable and compacting as non-editable from `App`; add compacting keyboard and paste guards after global/permission/display-only ownership.
3. Extend the pty driver with deterministic raw DEC cursor visibility observation.
4. Strengthen the model-driven usage scenario to prove mid-turn local reporting, cursor-position editing, visible cursor, exact no-queue draft retention, no automatic send after idle, and explicit successful second submission.
5. Strengthen the approve scenario so permission-time keyboard/paste cannot mutate a preexisting hidden draft without weakening SER-009 frame or disk assertions.
6. Add focused pty coverage that compaction ignores keyboard and paste input, while retaining the existing offline compact suite.
7. Update `.trellis/spec/frontend/tui-testing.md` with streaming editability, busy-submit, permission, cursor-observation, and compacting ownership contracts.
8. Run focused prompt/compact checks; pty cursor, multiline, chunkedEnter, completion, usage, approve and compacting scenarios; `pnpm typecheck`; `pnpm test`; `git diff --check`; and Trellis validation.
9. Inspect changed-file scope and commit the complete SER-010 implementation using repository convention.

## Review gates

- No local command moves below the busy guard.
- No queue, second send path, runtime, or permission semantic change.
- Streaming text is not dimmed or ARIA-disabled and owns a visible terminal cursor.
- Compacting keyboard and paste events leave the editor mirror unchanged.
- Permission acceptance retains all SER-009 latest-frame and exact-write checks.

## Risk and rollback points

- Ink emits hide/show controls during every repaint; cursor assertions must inspect the latest control state after a settled frame, not merely search for any show sequence.
- Model output timing is nondeterministic; all waits are anchored, deadline-bounded, and use an explicit quiet interval to prove absence of automatic submission.
- Permission frame height is safety-sensitive; add no prompt rows and keep assertions against `tui.frame`.
