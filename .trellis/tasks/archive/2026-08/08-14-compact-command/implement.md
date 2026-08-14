# Implementation Plan: `/compact`

1. Add runtime compaction contract and operation.
   - Retain the constructed SDK summarizer/session manager.
   - Count full context before and after.
   - Repeatedly reduce to a rolling summary plus the recent window.
   - Save latest snapshot and resume pointer.
   - Roll back messages on every failure.
2. Add `/compact` TUI dispatch and report formatting.
   - Advertise it in built-in completion.
   - Run only while idle with a dedicated busy hint.
   - Surface no-op, success, and failure without entering the agent loop.
3. Add a deterministic offline spike and wire it into `pnpm test`.
   - Real SDK agent/conversation/session components, fake model only.
   - Verify preserved messages, context-count inputs, follow-up, resume, and rollback.
   - Extend the cheap pty completion assertion for `/compact`.
4. Run focused checks, `pnpm typecheck`, `pnpm test`, and relevant free TUI scenarios.
5. Update backend SDK/session and error-handling specs.
6. Review diff, run Trellis check, commit, archive task, and push `main`.

## Risky Files / Rollback Points

- `src/agent/runtime.ts`: live message mutation and persistence boundary. Keep all rollback logic here.
- `src/tui/App.tsx`: command ordering and busy-state behavior. Avoid touching normal turn/cancel flow.
- `spike/verify-compact.ts`: must prove behavior through public SDK APIs rather than mirroring implementation.

## Validation Commands

```bash
pnpm tsx spike/verify-compact.ts
pnpm typecheck
pnpm test
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts completion
```

The last command is expected to make no model call; use the actual scenario key exposed by `verify-tui.ts`.
