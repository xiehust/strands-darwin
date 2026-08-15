# Implementation plan

1. Generate and commit a pnpm patch for the installed Strands SDK Responses adapter and declarations.
2. Make Darwin's raw usage cache fields optional and add a provider/API-aware shared projection.
3. Route TUI `/usage` and dev REPL usage output through the projection.
4. Add a focused offline suite using the real OpenAI Responses adapter with a fake stream; register it in the fast suite.
5. Update existing TUI usage acceptance for provider-specific rows without weakening Bedrock coverage.
6. Update `.trellis/spec/backend/strands-sdk-contracts.md`.
7. Review the complete diff and run:
   - `pnpm tsx spike/verify-usage.ts`
   - `pnpm typecheck`
   - `pnpm test`
   - `git diff --check`
8. Archive the completed Trellis task, commit all changes using project conventions, and push `main` to `origin/main`.

## Risk and rollback points

- Patch generation affects the lockfile and workspace patch metadata; inspect both before install/test.
- Optional values cross runtime and UI boundaries; search every `UsageTotals` consumer before changing the type.
- Keep provider semantics in one helper so TUI and dev REPL cannot drift.
- If the real-adapter fixture requires unsafe casts, constrain them to the fake client boundary and preserve production types.
