# Global and project Darwin state layers

## Goal

Move personal Darwin state out of repositories while preserving project-scoped policy and adding predictable global-plus-project resource layers. Normal model changes, permission decisions, and sessions must no longer dirty a repository.

## Requirements

1. `~/.darwin/config.json` is the sole active application config for provider/model/runtime settings. Project `.darwin/config.json` model settings are inert. `/model` and `/effort` persist globally without dropping unknown keys.
2. Permission allow rules are project-scoped user state at `~/.darwin/projects/<project-key>/permission-rules.json`, never global. Legacy rules in project `.darwin/config.json` are a read-only fallback until promoted by the next accepted rule.
3. Hooks support global `~/.darwin/hooks.json` and project `<repo>/.darwin/hooks.json`. Global and project Pre hooks run before permission; project and global Post hooks run after the tool in reverse nesting order. Legacy `hooks` fields are per-layer fallbacks only when the corresponding primary file is absent.
4. Agents, commands, and skills load built-ins plus global and project layers. Built-ins retain reserved names; valid project entries override valid global entries case-insensitively; invalid project entries do not hide valid global entries; optional failures are isolated and surfaced.
5. MCP merges `~/.darwin/mcp.json` with one project source: `<repo>/.darwin/mcp.json`, otherwise `<repo>/.mcp.json`. Project server names override global collisions. Malformed participating files fail startup; individual server failures remain isolated.
6. Sessions, resume pointers, SDK snapshots, and background logs live under `~/.darwin/sessions/<project-key>/`. Project keys use canonical physical paths, a readable bounded slug, and a SHA-256 suffix. Legacy project sessions migrate lazily and copy-only when selected.
7. Global config, global/project hooks, project permission rules, and legacy project policy config remain dangerous writes and exempt from wildcard rules.
8. Keep project `AGENTS.md` and `.darwin/system-prompt.md` behavior unchanged. Global inline `systemPrompt` continues to outrank the project file.
9. Do not modify or migrate real user `~/.darwin` data. Tests must isolate `HOME`.
10. Preserve all pre-existing unrelated working-tree changes and make conflict-aware edits in shared dirty files.
11. Update documentation, AGENTS/CLAUDE guidance, backend specs, diagnostics, and existing test fixtures for the new paths and precedence.

## Acceptance Criteria

- [ ] Startup loads only global application config; project model config cannot control startup.
- [ ] `/model` and `/effort` write only global config and preserve unknown keys.
- [ ] Rules accepted in project A persist only in A's user-state file and are unavailable in project B.
- [ ] Legacy project rules load without repository writes and promote copy-only on the next accepted rule.
- [ ] Global and project hook order and short-circuit behavior are tested, including legacy source fallback.
- [ ] Global resources appear across projects; project resources stay local; project collision precedence and invalid-entry fallback are tested for skills, commands, and agents.
- [ ] Global and project MCP servers are unioned, project collisions win, and project `.darwin/mcp.json` still shadows root `.mcp.json`.
- [ ] New session snapshots, pointers, and background logs are globally stored under distinct project keys; symlink aliases coalesce; collision-prone and long paths remain distinct and bounded.
- [ ] Selected legacy sessions are copied and resumed globally while legacy data remains unchanged.
- [ ] Sensitive global/project policy paths are dangerous and wildcard-exempt.
- [ ] Tests use isolated homes and do not touch real user global Darwin data.
- [ ] Focused suites, `pnpm typecheck`, `pnpm test`, and `git diff --check` pass.

## Out of Scope

- Automatic migration of project model/provider configuration into the global config.
- Deleting legacy project config or session data.
- Changing AGENTS.md discovery, system-prompt composition order, provider APIs, or the SDK agent loop.
- Committing changes.

## Constraints

- Implementation is directly authorized with `--yolo` only for this repository and requirement.
- No delegation or nested Darwin process.
- Existing dirty files must not be reverted or overwritten.
