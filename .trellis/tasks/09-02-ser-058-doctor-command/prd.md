# SER-058 `darwin doctor` — offline, read-only diagnostics

## Goal

A `darwin doctor` CLI verb that prints one bounded plain-text report composed from the loaders
that already exist — config, system prompt, project instructions, MCP config, skills, hooks and
policy, permission rules, sessions store, versions — without starting a session, calling a model,
spawning or connecting an MCP server, touching the network, or creating/moving any file, directory
or pointer anywhere (including `~/.darwin` and the project `.darwin`). Every problem is a marked
line (`! `), totalled at the end; exit 0 when none, 1 when at least one, 2 for a usage error.

Backlog record: `docs/research/backlog/directions-061-080.md` § SER-058 (Priority 79). Peer
evidence: `claude doctor` (S1), `codex doctor` (S2), DeepSeek `dsh --dump-config` (S3).

## Requirements

- R1. **Routing.** `src/cli-doctor.ts` on the `cli-sessions.ts` model: `DOCTOR_COMMAND`,
  `DOCTOR_USAGE`, `isDoctorInvocation`, `parseDoctorArgs` (any argument → `CliUsageError`, exit 2
  through `usageErrorText`), a `DoctorIo` seam, `runDoctorCommand(io) → exit code`. Dispatched in
  `cli.ts` beside `sessions`, before `parseCliArgs`. Added to `CLI_USAGE`; quoted verbatim in
  `docs/user-guide/reference.md` (+ zh-CN) — `spike/verify-cli-args.ts` pins the text.
- R2. **Config.** `loadConfig` result; a `ConfigError` (or any throw) is one `! config:` problem
  line carrying the loader's message (which names the file) — never a throw or an exit before the
  report. On success: provider, model id, region (bedrock / Mantle) or base URL (anthropic),
  `apiKeyEnv` name + set/unset (never the value), effort, prompt cache on/off, context offload,
  trajectory / memory / diagnostics flags, permission mode. Absent file → "absent — built-in
  defaults".
- R3. **Side-effect-free readers.** `loadConfig` and `loadProjectPolicy` currently reach
  `configPath()`, which `mkdirSync`s `~/.darwin`. A new pure `configFilePath()` serves the two
  readers; `configPath()` keeps its mkdir for the spikes that write fixtures through it. MCP
  server parsing is extracted from `loadMcpClients` into `readMcpServerConfigs` (same
  `ConfigError`, same override/ignored derivation) so the doctor can read the servers without
  the SDK loader that spawns them. Both refactors are behaviour-preserving for the runtime.
- R4. **System prompt / instructions.** `loadSystemPrompt` source (`built-in default` / `config
  systemPrompt` / `file <path>`) and its `problem`; `loadProjectInstructions`: absent, or path +
  bytes against `MAX_INSTRUCTIONS_BYTES`, truncation stated as a problem, read problem as a
  problem.
- R5. **MCP.** `mcpConfigCandidates`: which of global / preferred / fallback exist, which is
  read, which is ignored (fallback shadowed by preferred); overridden server names. Per server:
  disabled → stated; `url` (or `transport` sse/streamable-http) → the URL and `not connected
  (doctor never connects)`; `command` → a plain PATH lookup (`X_OK` on each `PATH` entry, or on
  the path itself when it contains a separator) → `found at <path>` / `! … not found on PATH`;
  a `${VAR}` placeholder is stated as not checked. Never spawn. Never print `env`, `headers` or
  `args` (they may carry tokens).
- R6. **Skills.** `scanSkills(projectRoot)`: counts per layer (built-in, project `.darwin`,
  project `.agents`, global `.darwin`, global `.agents`, attributed by `skill.path` prefix),
  every `problems[]` entry as `! skill skipped <dir>: <reason>`, required built-ins listed; a
  thrown scan error (broken built-in) is a problem line, not a crash.
- R7. **Hooks and policy.** `loadProjectPolicy`: each `toolHookLayers` file with dialect
  (`native` / `codex`), shadow notices, legacy-rules notice; a `ConfigError` is a problem line.
- R8. **Permission rules.** `permissionRulesPath` exists / absent, rule count from the loaded
  policy, `count unavailable` when policy failed.
- R9. **Sessions.** `sessionPaths(...).sessionsDir` path, exists / absent, `listSessionIds`
  count, pointer target via `readLastSessionId` (both read-only).
- R10. **Versions.** `darwin <DARWIN_VERSION>`, `node <process.version>`, platform/arch/release.
- R11. **Bounds.** Each report line is cut at `MAX_DOCTOR_LINE_CHARS` code points with `…`;
  per-section lists are capped at `MAX_DOCTOR_LIST` entries with `… N more` (the extra entries
  still count towards the problem total when they are problems).
- R12. **Docs/spec.** `docs/user-guide/reference.md` (+ zh-CN): CLI block row, `CLI_USAGE` quote,
  a short `darwin doctor` paragraph. `.trellis/spec/backend/error-handling.md`: degradation
  rows (doctor reports, never refuses; doctor never connects/spawns/writes).
  `docs/architecture/load-bearing-decisions.md`: one heading. AGENTS.md untouched (32,667 B).

## Requirement → check

| Requirement | Check |
|---|---|
| R1 routing, usage error exit 2, `CLI_USAGE` row, docs quote | `spike/verify-doctor-command.ts` (process run `doctor extra`); `spike/verify-cli-args.ts` |
| R2 valid config → exit 0, provider/model named | `verify-doctor-command.ts` (a) |
| R2 unknown key → `!` line with file path, exit 1 | `verify-doctor-command.ts` (b) |
| R2 invalid JSON → `!` line, exit 1 | `verify-doctor-command.ts` (c) |
| R2 api key never printed | `verify-doctor-command.ts` (env var value absent from report) |
| R3 readers create nothing | `verify-doctor-command.ts` (f) snapshot with no `~/.darwin` in HOME; `verify-config.ts` stays green |
| R5 stdio command found / not found, marker never written, http not connected | `verify-doctor-command.ts` (d) |
| R6 skipped skill stated | `verify-doctor-command.ts` (e) |
| R7 hooks dialect / decode problem | `verify-doctor-command.ts` |
| R11 bounds | `verify-doctor-command.ts` (line cap) |
| Zero mutation of HOME + project | `verify-doctor-command.ts` (f) recursive snapshot (path, size, mtime) byte-identical |
| Import graph: no runtime / Ink / React / `Agent` in the closure | `verify-doctor-command.ts` (h) |
| Gate | `pnpm typecheck`, `pnpm test`, `pnpm build`, `node dist/src/cli.js doctor` here |

## Acceptance Criteria

- [x] AC1. `spike/verify-doctor-command.ts` in `pnpm test`, green: (a)–(h) above.
- [x] AC2. `spike/verify-cli-args.ts` green with the updated `CLI_USAGE`; both reference docs quote it.
- [x] AC3. `pnpm typecheck`, `pnpm test`, `pnpm build` exit 0; `node dist/src/cli.js doctor` in this
  repo exits 0 or every problem it names is true.
- [x] AC4. Commits follow the convention; journal + archive in their own commits; tree clean.

## Evidence (2026-09-02)

- `pnpm tsx spike/verify-doctor-command.ts`: 71 passed, 0 failed — (a) exit 0 naming
  `provider bedrock   model us.anthropic…`; (b) `! config: <HOME>/.darwin/config.json: unknown key
  "modle"`, exit 1; (c) invalid JSON → the config line *and* a hooks/policy line (the hook-layer
  loader reads the same global file for embedded legacy hooks), both naming the file, report
  completes; (d) `marker-writer` found on PATH, its `MARKER` file never appears, bogus command is
  the one problem, http/sse `not connected`, `${HOME}/tool` not checked, `args`/`headers` values
  absent; (e) reserved built-in name and missing description both stated with the loader's reason;
  hooks native/Codex dialects listed, undecodable `.agents/hooks.json` is a problem; over-cap
  `AGENTS.md` and a directory at `system-prompt.md` are problems; every line ≤ cap; (f) pristine
  HOME + fixture project snapshots identical, `~/.darwin` never created, process exit 0; (g)
  `doctor extra` exit 2 with the usage error and hint, separated form identical; (h) closure of
  local imports (config, registry, skills loader, …) has no runtime/headless/tui/cli entry, no
  Ink/React, no `Agent` import or construction.
- `pnpm tsx spike/verify-cli-args.ts`: 43 passed. `verify-config` 332, `verify-state-layers` 37,
  `verify-mcp-command` 33, `verify-sessions-command` 42 — the refactored loaders' own suites.
- `pnpm typecheck && pnpm test`: 86 suites, 0 failed. `pnpm build` exit 0.
- `node dist/src/cli.js doctor` in this repo: exit 0, `no problems found` (anthropic provider, 8
  models, 6 MCP servers — 4 stdio commands found on PATH, 1 http, 1 disabled — 27 skills across the
  five layers, one Codex-dialect hooks file, 229 sessions).
- AGENTS.md untouched: 32,667 B.

## Follow-ups noticed

- The `configPath()`/`configFilePath()` split leaves 49 spike call sites on the mkdir form; they
  write fixtures, so that is the right form for them, but a future cleanup could rename for clarity.

## Decisions

- Readers stop creating `~/.darwin` (R3) rather than the doctor re-implementing `loadConfig`:
  the doctor must report exactly what startup would load, so it has to call the real loader, and
  a loader that reads should not create directories anyway. Nothing in `src/` relied on the
  directory existing after `loadConfig` (grepped `userDarwinDir()` uses: all `mkdir recursive`
  or ENOENT-tolerant).
- MCP: the SDK's `${VAR}` interpolation is not re-implemented; a placeholder command is reported
  as not checked. `args`/`env`/`headers` are never printed.
- The report is transcript-style plain text (no ANSI): it is meant to be pasted into an issue.

## Out of scope

- Fixing anything (`doctor --fix`), connecting to servers, testing credentials against a provider.
- A `/doctor` slash command (the TUI's `/status` and `/mcp` already cover the live session).
