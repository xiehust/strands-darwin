# Custom slash commands — design

## Architecture

Add a small `src/commands/` module responsible only for project command discovery and expansion. `AgentRuntime` owns the loaded command registry alongside `SkillsPlugin`; the TUI consumes command names from `RuntimeInfo` and calls the existing `expandSlashCommand()` boundary.

## Discovery and collision flow

1. Load skills first so their case-insensitive names are reserved.
2. Scan only direct entries in `<projectRoot>/.darwin/commands/` whose directory entry is a regular file and whose extension is `.md` case-insensitively.
3. Reserve all built-in command names plus the `/quit` alias before accepting files.
4. Sort candidates deterministically by filename, accept the first unique case-insensitive name, and record later duplicates/collisions as command problems.
5. Treat an absent commands directory as empty. Isolate per-entry metadata/read failures as problems; do not fail runtime creation.

The loader reads and stores command bodies at startup. This makes an unreadable entry diagnosable before it appears in completion and keeps the accepted registry immutable for the session; file watching and hot reload remain out of scope.

## Expansion contract

Parse slash name and trailing arguments using the existing skill command shape. Skill expansion remains first. If no skill matches, expand a custom command by replacing every literal `$ARGUMENTS` with the trimmed trailing argument string. Content without the placeholder is sent unchanged. Unknown slash input returns `null` and passes through.

Return a discriminated expansion result (`kind: skill | command`) so the TUI can report the right loaded notice without inspecting optional fields.

## UI and diagnostics

Completion order is built-ins, accepted custom commands, then skills. Rejected names never enter completion. `RuntimeInfo` carries command names/problems; the header renders command problems using the same yellow skipped-warning convention as skills.

## Compatibility and rollback

No persisted format or dependency changes. Removing the commands module and its runtime/TUI wiring restores current behavior. Existing built-ins, skill expansion, prompt caching, and SDK agent-loop behavior remain unchanged.
