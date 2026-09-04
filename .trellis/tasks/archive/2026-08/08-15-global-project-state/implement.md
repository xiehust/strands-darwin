# Implementation Plan

1. Add centralized user-global, project-key, policy, and session paths.
2. Split global application config from permission and hook policy; preserve raw JSON persistence.
3. Update runtime assembly, permission persistence, hook composition, and diagnostics.
4. Add global/project layering to skills, commands, agents, and MCP.
5. Move sessions/background logs and add copy-only legacy migration.
6. Update sensitive-path risk and wildcard boundaries.
7. Convert all runtime/config tests to isolated HOME fixtures and add precedence/migration regressions.
8. Update README, AGENTS.md, CLAUDE.md, backend specs, comments, and messages.
9. Run focused suites, `pnpm typecheck`, `pnpm test`, and `git diff --check`.
10. Audit final diff against the initial dirty-file list; do not commit.

## Risk and rollback points

- Shared dirty files (`src/tui/App.tsx`, `src/cli.ts`, `spike/verify-tui.ts`) require narrow edits only.
- Session path changes affect snapshots, pointers, and background logs together; verify all consumers through `sessionPaths()`.
- Resource collision semantics must validate before precedence so broken project entries do not suppress global resources.
- Tests must set isolated HOME before path helpers run and must never inspect or mutate the real user Darwin directory.
