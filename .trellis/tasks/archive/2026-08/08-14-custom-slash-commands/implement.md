# Custom slash commands — implementation plan

1. Add command discovery/expansion types and pure logic under `src/commands/`.
2. Load commands in `AgentRuntime.create()` after skills, reserve built-in/alias and skill names, expose names/problems, and expand skills before commands.
3. Add custom names to TUI completion and render command-specific expansion notices and startup warnings.
4. Add a fast command fixture suite covering discovery, placeholders, case folding, unknown input, duplicate/reserved/skill collisions, missing directories, and unreadable entries; include it in `pnpm test`.
5. Extend the zero-model-call PTY completion scenario with a temporary project command and collision warning assertions.
6. Run targeted tests, `pnpm typecheck`, `pnpm test`, and `pnpm tsx spike/verify-tui.ts completion`.
7. Update the relevant frontend/error-handling specs, run Trellis quality review, commit, and push.

## Risk / rollback points

- Keep collision ownership in the loader; duplicating it in the TUI could advertise commands runtime expansion rejects.
- Keep skills first in expansion to preserve behavior even if a future caller constructs an unfiltered registry.
- Do not add header lines for valid commands; only rejected entries warn, limiting frame-height impact.
