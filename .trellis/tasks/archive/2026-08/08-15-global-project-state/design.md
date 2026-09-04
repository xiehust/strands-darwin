# Design

## Path ownership

`src/paths.ts` owns project and user-global paths. `userDarwinDir()` derives `~/.darwin`; `projectKey()` realpaths the cwd, sanitizes/truncates a readable prefix, and appends SHA-256; project permission and session paths derive from it.

## Configuration and policy

`src/config.ts` loads only global application config. `permissionRules` is invalid there. Separate policy loaders validate project permission rules and layered hooks while reusing existing validation. Legacy project/global config fields are read only as fallback when the primary policy file is absent.

Permission rules use primary user state, then legacy project config. Persistence merges the effective rules into primary user state without touching the repository.

Hooks are represented as existing `ToolHooksConfig`. Effective ordering is global Pre then project Pre; Post is project then global. One shared `ToolHookGate` still wraps parent and children.

## Layered named resources

Skills: built-in > project > global. Agents: built-in general > project > global. Commands reserve built-ins and all skill names, then project > global. Each loader validates a layer independently before collision resolution so invalid high-precedence entries cannot hide valid lower entries. Optional directory/entry failures are surfaced and isolated.

## MCP

Parse global plus one selected project file. Merge server maps global-first/project-second, apply prefixes once, then call the SDK loader. Record contributing, ignored, and overridden sources for diagnostics.

## Sessions

`sessionPaths(projectRoot)` targets `~/.darwin/sessions/<project-key>`. Snapshot/pointer/background paths all reuse it. For continue/id selection, absent global state probes legacy project state and copies the selected session directory and pointer as needed; legacy data is never removed or rewritten.

## Security

Centralized sensitive paths feed both static risk assessment and wildcard exemptions. Protected paths are global config/hooks, project hooks/legacy config, and scoped permission rules. Existing `.env*`/`.git` behavior remains.

## Compatibility

- Project model config becomes inert with no automatic migration.
- Legacy project permission rules and hooks remain fallback sources.
- Legacy global config hooks remain fallback until `~/.darwin/hooks.json` exists.
- Legacy sessions migrate lazily and copy-only.
- Existing project MCP fallback, AGENTS.md, and system-prompt behavior remain.

## Failure isolation

Malformed application config, active policy files, and participating MCP files block startup with source paths. Invalid optional resource entries are skipped and surfaced. Broken MCP servers continue to degrade individually. Shadowed legacy files are not parsed.
