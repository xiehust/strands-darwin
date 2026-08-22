# Fix SER-035 startup resume fixture isolation

## Goal

Remove order/environment sensitivity from the startup pty resume assertion and isolate its filesystem fixtures.

## Requirements

- Make `verify-startup-pty.ts` own unique temporary HOME and project-root directories so standalone, repeated, and full-runner executions cannot reuse stale snapshots or configuration.
- Prove the resumed recap and ready-App handoff semantically without assuming an exact SDK-restored message count.
- Preserve all existing startup production code and unrelated tests.
- Record the test-isolation lesson in the existing startup pty specification.

## Acceptance Criteria

- [x] The focused startup pty suite passes with a recap title matching a positive restored-message count, the seeded request/answer, ready header, prompt, and complete startup removal.
- [x] Fixture cleanup is process-owned and cannot target a shared fixed `/tmp` tree.
- [x] `pnpm typecheck` passes.
- [x] One final full `pnpm test` passes after the correction.
