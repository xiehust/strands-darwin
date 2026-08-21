# Load agents directory extensions

## Goal

Allow darwin to discover reusable agent extensions from both the user's home and the active project through the conventional `.agents/` directory.

## Background

Darwin already loads skills, child-agent definitions, custom commands, and executable tool hooks from `.darwin` layers. The portable `.agents/skills` convention is also present in this repository and in the user's home, including symlink-installed skills, but Darwin does not currently discover it.

## Requirements

- Load skills, agents, commands, and hooks from both `~/.agents/` and `<working-directory>/.agents/` while preserving Darwin's existing extension schemas and execution paths.
- Preserve Darwin's working-directory path invariant for every project-local source.
- Use one deterministic precedence contract across skills, agents, and commands.
- Invalid skill, agent, or command entries degrade visibly according to the repository's existing policy. Any unreadable, invalid-JSON, or structurally invalid hook file fails startup with a `ConfigError` naming the file/field because executable policy must fail closed.
- Keep existing `~/.darwin/skills/`, `<working-directory>/.darwin/skills/`, built-in skills, MCP configuration, and built-in commands compatible unless explicitly superseded by the new layer.
- Treat all new hook directories and files as executable policy for permission classification and wildcard allow-rule exemptions.

## Acceptance Criteria

- [ ] Valid global and project `.agents` skills appear in `load_skill` and slash activation; agents are dispatchable; commands expand and complete; hooks execute around parent and child tool calls.
- [ ] Same-name resources resolve, highest first, as built-in reservation → project `.darwin` → project `.agents` → global `.darwin` → global `.agents`; an invalid higher definition does not hide a valid lower one, and skipped duplicates are visible.
- [ ] Hook JSON files execute in lexical order inside each directory; Pre layer order is global `.agents` → global `.darwin` → project `.agents` → project `.darwin`, and Post is the exact reverse.
- [ ] A `.darwin` layer uses legacy hooks only when its `hooks/` directory has no JSON files; directory hooks shadow legacy inputs once, surface that fact in TUI/dev REPL, and never duplicate execution.
- [ ] Invalid skill/agent/command entries are skipped and surfaced; any invalid hook file refuses startup with its exact source identified.
- [ ] Root and nested skill symlinks work when nested targets remain inside the resolved skill root; broken/cyclic/escaping links are rejected visibly within the 200-entry bound and rechecked at use time. Direct symlinked agent/command files degrade visibly, while direct symlinked hook failures refuse startup.
- [ ] Hook directory/file writes are classified as dangerous and cannot be covered by wildcard allow-rules.
- [ ] Existing `.darwin` sources continue to work, and absence of every `.agents` directory is silent.
- [ ] Offline loader/runtime tests plus the free TUI completion scenario cover discovery, precedence, hook execution, malformed input, symlinks, legacy fallback/shadowing, startup notices, and completion visibility.

## Out of Scope

- New skill, agent, command, or hook schemas.
- Recursive discovery below the existing direct-child contracts.
- Automatic migration or rewriting of legacy hook files/config.
- Loading MCP, application config, permission rules, sessions, or other Darwin state from `.agents/`.

## Product Decisions

- Reuse Darwin's existing skill, agent, command, and hook contracts rather than adding a second execution model.
- Resource precedence, highest first: built-in reserved names, project `.darwin/`, project `.agents/`, `~/.darwin/`, `~/.agents/`.
- For skills, agents, and commands, the highest-priority valid same-name definition wins; an invalid higher layer claims nothing, so a lower valid definition remains usable. Skipped duplicates are surfaced as problems.
- Hooks use direct, lexically sorted `hooks/*.json` files in every global/project `.agents/` and `.darwin/` layer. Each file uses the current Darwin `PreToolUse` / `PostToolUse` object contract.
- Hook files merge rather than override. Within each directory, filename order is deterministic. Across layers, Pre order is `~/.agents` → `~/.darwin` → project `.agents` → project `.darwin`; Post order is the exact reverse, so teardown wraps setup symmetrically.
- Preserve existing Darwin hook inputs as read-only migration fallbacks: for a `.darwin` layer with no `hooks/*.json`, load its current single-file `hooks.json`, then its existing config-embedded hooks fallback. Never migrate or rewrite user files.
- If a `.darwin` layer has one or more `hooks/*.json`, that directory is authoritative for the layer; do not also execute legacy hooks. Surface a startup notice when an existing legacy hook input is shadowed by the directory form.
- Change the skill safety contract to allow a skill root symlink and arbitrary nested symlinks. Resolve the root first and treat its real target as the safety root; every nested link's final target must remain inside that real root. Reject broken links, cycles, and escapes visibly, retain the 200-entry bound, and re-check containment at resource-use time.
- Allow direct agent, command, and hook JSON files to be symlinks when their final target is a regular file; discovery remains direct-child/non-recursive. Broken/cyclic agent or command links are skipped visibly, while broken/cyclic hook links fail startup. A project-local file link may target outside the project because the link is explicit user configuration; diagnostics identify the resolved source.


