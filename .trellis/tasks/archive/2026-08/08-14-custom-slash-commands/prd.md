# Custom slash commands

## Goal

Let a project define reusable prompt shortcuts as Markdown files under `.darwin/commands/`, invoke them from darwin with `/name [arguments]`, and discover them through the existing slash-completion menu without changing built-in or skill command behavior.

## Background

- The TUI currently completes built-ins first, then skills from `.darwin/skills/` (`src/tui/App.tsx:87-92`).
- `AgentRuntime.expandSlashCommand()` currently delegates only to skill expansion (`src/agent/runtime.ts:463-470`).
- Skill names are matched case-insensitively, and unknown slash input is sent as ordinary model input (`src/skills/plugin.ts:126-158`).
- The existing zero-model-call pty completion scenario is `spike/verify-tui.ts:473-522`; loader and expansion regressions live in `spike/verify-skills.ts`.
- Prior session history listed this feature as the next queued request but recorded no additional product decisions.

## Requirements

1. Discover regular `.md` files directly under `<projectRoot>/.darwin/commands/`; the filename stem is the slash command name.
2. Invoking `/name` sends the file body to the model instead of the literal slash command.
3. Invoking `/name some text` replaces every literal `$ARGUMENTS` placeholder in the file body with `some text`; with no arguments, replacement is the empty string.
4. Command lookup is case-insensitive, matching existing skill lookup behavior.
5. Custom command names appear in the existing slash-completion menu after built-ins and before skills.
6. Built-in commands, including the unadvertised `/quit` alias, retain their existing semantics and cannot be shadowed; colliding custom commands are skipped with a startup warning.
7. Skill slash expansion retains its existing semantics and takes precedence over custom commands; a custom command colliding case-insensitively with a skill is skipped with a startup warning.
8. Missing `.darwin/commands/` is normal and silent. A bad command entry is isolated so other valid commands remain usable, with an actionable startup warning consistent with skill degradation.
9. Unknown slash commands continue to pass through as ordinary model input.
10. The implementation adds no dependency and keeps all paths rooted in the CLI working directory.

## Acceptance Criteria

- [x] A fixture command `.darwin/commands/review.md` is discovered as `review`; non-Markdown entries and nested files are not commands.
- [x] `/review` expands to the Markdown body and replaces `$ARGUMENTS` with an empty string.
- [x] `/review focus on auth` replaces all `$ARGUMENTS` occurrences with `focus on auth` and sends no literal `/review` command to the model.
- [x] `/REVIEW ...` resolves the same command.
- [x] `/` completion shows built-ins first, then an unambiguous custom command, and still shows skills.
- [x] `/compact`, `/effort`, `/exit`, `/model`, `/usage`, and `/quit` retain current behavior even if a colliding Markdown filename exists.
- [x] A custom command colliding case-insensitively with a skill is skipped with a startup warning; the skill remains slash-invokable.
- [x] Invalid or unreadable command entries do not prevent startup or hide valid commands, and the skipped entry is surfaced.
- [x] Unknown slash input remains unchanged.
- [x] `pnpm typecheck`, `pnpm test`, and the relevant zero-cost TUI completion scenario pass.

## Out of Scope

- User-global command directories, namespaced commands, nested command directories, file watching/hot reload, command descriptions/frontmatter, positional placeholders such as `$1`, shell interpolation, and command execution without a model turn.
- Changes to skill discovery, skill prompt formatting, or built-in command UX beyond collision protection.

## Key Decisions

- Skill names take precedence over custom command names. A colliding custom command is skipped and surfaced as a startup warning rather than silently changing existing `/skill` behavior.
- Built-in names and the `/quit` alias are reserved under the same case-insensitive collision rule.
