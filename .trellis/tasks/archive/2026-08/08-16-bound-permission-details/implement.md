# Implementation plan

1. Add marker-inclusive, Unicode-safe permission summary/detail projections in `src/tui/tool-detail-presentation.ts`.
2. Replace `PermissionPrompt`'s line-only clipper with those projections while leaving decision rendering and input ownership unchanged.
3. Add and register a focused pure projection suite.
4. Strengthen `spike/verify-tui.ts approve` with an oversized one-line replacement and settled newest-frame assertions, retaining exact post-approval disk verification.
5. Record the permission frame contract in `.trellis/spec/frontend/tui-testing.md`.
6. Run the focused suite, `pnpm typecheck`, `pnpm test`, `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve`, `git diff --check`, and task validation.
7. Inspect scope and commit the complete SER-009 change as one repository-style commit.

## Review gates

- No changes to permission gate/queue/keys/rules/raw input.
- Short projections compare exactly to source strings.
- Every truncated projection, including its marker, stays within both caps.
- The pty assertion reads the virtual terminal's current settled screen.
