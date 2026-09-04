# Design — `.agents` extension layers

## Architecture and boundaries

Add shared path helpers for project/global `.agents` roots and ordered extension source descriptors. The runtime remains the sole assembler: existing skills, commands, subagents, and `ToolHookGate` execution paths stay intact; only their discovery inputs widen.

### Skills, agents, and commands

Each existing loader scans these layers in precedence order after built-in reservations:

1. project `.darwin`
2. project `.agents`
3. global `.darwin`
4. global `.agents`

Within one layer, entries are lexical. Validation occurs before claiming a case-insensitive name, so an invalid higher entry cannot hide a valid lower entry. A valid lower duplicate is skipped and reported against the owning source. Final user-facing catalogues retain their existing deterministic name order.

Skills keep the official `Skill` parser and `AgentSkills` activation path. Agents keep the existing Markdown/frontmatter parser and child permission gate. Commands keep the current expansion and completion path.

### Hooks

Every extension root may contain direct `hooks/*.json` files using the existing `PreToolUse` / `PostToolUse` object schema. Files are read lexically and fail closed through `ConfigError` on read, parse, symlink, or schema errors.

Hook groups merge as nested wrappers:

- Pre: global `.agents`, global `.darwin`, project `.agents`, project `.darwin`.
- Post: exact reverse, with each directory's files and each file's groups reversed at the layer/file boundary as needed to produce the exact inverse of Pre ownership order while preserving group order inside one source contract.

For each `.darwin` layer only, no directory JSON means the current `hooks.json` fallback, then existing config-embedded fallback. One or more directory JSON files make the directory authoritative. If a legacy source also exists, runtime metadata carries one shadow notice for TUI/dev REPL; no automatic write or migration occurs.

`RuntimeInfo.hookSources` lists every active source in Pre policy order. A separate bounded notice list carries legacy-shadow facts rather than overloading active sources.

### Symlinks and skill resource safety

Discovery accepts a skill entry that is a directory or symlink resolving to a directory. The resolved root becomes the skill's safety root. Resource preflight and the sandbox wrapper allow symlinks at any nested depth only when each final realpath remains within that root. Broken links, cycles, and escapes fail activation visibly. Traversal keeps the 200-entry cap and revalidates realpaths during SDK `listFiles` use to retain the existing TOCTOU defense.

Direct agent, command, and hook JSON entries may be symlinks resolving to regular files. Agent/command link failures become ordinary skipped-entry problems; hook link failures are `ConfigError`. Diagnostics/problems retain the discovered source and identify the resolved target where useful.

### Permission boundary

Replace exact sensitive-hook-file checks with containment-aware executable-policy checks covering:

- global/project `.darwin/hooks/`
- global/project `.agents/hooks/`
- existing legacy hook/config files

Writes to any contained hook path are dangerous, and wildcard allow-rules cannot cover them. This is applied through the shared path policy used by both static classification and rule exemption.

## Compatibility

- Existing `.darwin` skill/agent/command sources keep working and remain higher priority than the corresponding `.agents` source in the same scope.
- Legacy Darwin hooks remain read-only fallback inputs.
- `.agents` absence is silent.
- MCP, application config, permission rules, sessions, prompt instructions, and other state do not gain `.agents` sources.
- No hot reload is introduced; discovery remains startup-only.

## Failure and rollback

Optional skill/agent/command failures stay isolated and visible. Hook failures refuse startup because hooks are executable policy. Rollback is removal of the new path layers and directory-hook aggregation; legacy hook fallback remains independently testable throughout implementation.
