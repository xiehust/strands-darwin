# Darwin self-evolution backlog — priorities 121–140

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-089 — Route bracketed paste to the active history or rewind search owner before the composer: filter through existing bounded query updates, never mutate or submit the underlying draft, and retain permission/compaction ownership

- Status: `done`
- Priority: 121
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-13.md`](../research_2026-09-13.md) (run `06:21:23Z`)

### Implementation / acceptance evidence

Accepted `63e8cc0` (`fix(tui): route paste to the active search owner`), fresh child `session-20260913-065841818`, task `bg-622f8525-9e8b-449d-9816-db2bfbb33c0e` exit 0, fully drained. Ten production lines in `App.usePaste` route normalized text through immediate rewind/history refs and existing bounded updates, leaving permission/compaction guard and composer fallback unchanged. Host reviewed all 8 changed files and ran `pnpm typecheck && pnpm test && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts historySearch && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts rewind && pnpm build && git diff --check && git status --short`, task `bg-c279a3d3-b5b2-4bae-a1a0-baa4772400f8`, exit 0. Full gate 8,599 PASS lines includes new registered search-paste26, history-search161, rewind-search157, frame-budget80 and composer coverage; extra historySearch12/rewind9. New suite uses private HOME/cwd, real CLI/SDK local transport, exact 256-code-point cap, Unicode/multiline/control/repeated/same-write paste, exact cancellation cursors, no filter-time durable bytes/model requests, explicit Enter/Tab acceptance, permission/compaction blocking and bounded frames. EN/zh-CN narrative/reference and architecture synced; README still accurate, AGENTS untouched. Clean tree, dist rebuilt. Log `/tmp/darwin-ser089-host-acceptance.log`; iteration-log Batch 132.

### Notes / blockers / abandonment reason

Depends on SER-088: multiline query presentation must be safe before paste is routed to it. Sources R4–R6 in origin run; `App.usePaste` ignores search refs, while `useInput` routes rewind then history. Installed Ink explicitly separates paste from keyboard channels. Reuse `normalizeDraftText`, immediate search refs and existing query transitions; do not synthesize Enter/Tab or broaden keyboard semantics. No dependency, new key/row/timer/store, SDK loop, runtime or permission policy change. Host owns research/backlog/log; developer child owns focused implementation/tests and necessary EN/zh-CN docs, independently accepted before closure.

## SER-090 — Workspace trust for repository-supplied executable configuration: hold project hook commands, project MCP servers and legacy project allow rules until the user accepts one bounded modal that lists exactly what the checkout would arm; store the decision in the user-owned `~/.darwin/projects/<key>/trust.json`; headless never asks — it holds them back and states so

- Status: `done`
- Priority: 122
- Score: 13
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Accepted `effb8ba` (`feat(trust): gate repository-supplied hooks, mcp and rules`), fresh child `session-20260915-131504369`, task `bg-3bafb509-1882-4196-bb40-c7c109ffe361` exit 0, drained. New pure `src/agent/workspace-trust.ts` (inventory shares the loaders' own parse; decision store `~/.darwin/projects/<key>/trust.json`, nothing under the project root ever read as a decision), `src/tui/trust-format.ts` + `WorkspaceTrustPrompt.tsx` (bounded modal, one `<Text>` per row), `RuntimeOptions.workspaceTrust` → `loadProjectPolicy({ projectLayers: 'held' })` / `loadMcpClients({ projectLayer: 'held' })` skip rather than fail, rule writers carry the same option, `/status`/`/mcp` held rows, headless `trust:` stderr line + additive `run.started.trust`. Host read the module, the runtime/cli-main diff, the decisions heading and the marker assertions in `spike/verify-workspace-trust.ts` (401 lines, registered in `run-tests.ts`), then ran `pnpm typecheck && pnpm test && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts trust && … mcp && … completion && pnpm build && git diff --check && git status --short` (task `bg-4983452e-e0b0-4275-b5ca-252bcc178860`, exit 0, 8,997 PASS lines, no FAIL; log `/tmp/darwin-ser090-host-acceptance.log`). Docs: README EN/zh-CN, `permissions.md`/`reference.md` EN/zh-CN, load-bearing heading "Workspace trust"; no AGENTS.md row (32,763 bytes, five under cap — stated in the doc). Iteration-log Batch 133.

### Notes / blockers / abandonment reason

Requirement: on the first interactive launch in a project whose checkout declares hook commands (`.darwin/hooks.json`, `.darwin/hooks/*.json`, `.agents/hooks.json`, `.agents/hooks/*.json`), MCP servers (`.darwin/mcp.json` or root `.mcp.json`) or legacy `.darwin/config.json` `permissionRules`, darwin shows one bounded modal *before* any of it is armed — before `loadProjectPolicy` activates those layers and before `loadMcpClients` spawns a server — listing what would run or grant: each file, hook event counts, MCP server names with their commands, allow/deny rule counts. Accept stores `{trusted: true, decidedAt}` in `~/.darwin/projects/<key>/trust.json` (outside the repository, so a clone cannot self-approve); decline stores `{trusted: false, decidedAt}`, the session runs without those project layers, and one transcript notice states the omission (`/mcp` and `/status` show the held servers/hooks as `held (untrusted project)`). Headless (`-p`) never shows a dialog: with no stored decision it holds the layers back, writes one `trust:` stderr line and carries `run.started.trust` in structured output; a stored acceptance applies. User-global layers (`~/.darwin`, `~/.agents`), skills, custom commands and instruction files (prompt content, not execution) are unaffected. Projects declaring none of these files see nothing new. Sources S1/S1b/S1c (Claude Code trust dialog listing what the folder grants; `.mcp.json` "Pending approval"; hooks held until trust), S2 (Codex project config "only when you trust the project"), S5b/S5c (kiro first-open trust prompt; per-user workspace rules "so a cloned repo cannot inject permission rules"). Darwin evidence: `src/config.ts` `loadProjectPolicy`/`loadHookLayer`, `src/mcp/registry.ts` `loadMcpClients` called from `AgentRuntime.create`, `src/paths.ts` `sensitiveDarwinPaths` already enumerates the exact files. Extension points: a pure `src/agent/workspace-trust.ts` (inventory + decision store), `runInteractive` (`StartupScreen` already owns the terminal before `create()`), a `trust` option on `AgentRuntime.create`, existing `/status` and `/mcp` formatters. Do not gate on git status, do not add a second permission channel, do not touch the model-facing sensitive-path classification. This repository's own `.mcp.json` means every pty suite must run with a stored acceptance for its temp project or an explicit decision; the suite must show that the marker command of an untrusted `.mcp.json` server never runs.

## SER-091 — Single live process per session: a per-session lease (`lease.json`: pid, hostname, startedAt) acquired in `resolveSession` with `wx`; a live lease refuses explicit `--resume <id>`/`--session <id>` naming pid and start time and makes bare `--resume` start fresh with one notice; a stale lease (dead pid) is taken over and stated; released at shutdown; `darwin sessions` marks a leased row

- Status: `in-progress`
- Priority: 123
- Score: 11
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Implemented (worker run, awaiting Host acceptance): `src/agent/session.ts` — `lease.json`
(`{ pid, hostname, startedAt }`) under `sessionStateDir`, `wx` acquisition in `resolveSession`,
`classifyLease`/`pidAlive` (same host: `kill(pid, 0)`, `EPERM` alive; foreign host: live for
`FOREIGN_LEASE_STALE_AFTER_MS` = 24 h), `SessionInUseError` (sibling of `SessionNotFoundError`),
`SessionLease.release()` (only while the file names this pid; `rmdir`s an emptied state dir),
`inspectLease` for the listing; `AgentRuntime` holds the lease, releases in `shutdown()`/`retire()`
and on a failed `create()`, exposes `info.leaseNotice`; `cli-main.ts` catches `SessionInUseError`
beside `SessionNotFoundError` and seeds the fresh-session notice as startup history; resume recap
carries a takeover notice after its title; headless writes one `lease:` line (`source: "session"`
warning structured); `cli-sessions.ts` marks a live row `(open in pid N)`. Checks:
`spike/verify-session-lease.ts` (new, in `pnpm test`, 71 assertions incl. real `cli.ts` runs through
the `startup-cli` fixture), `spike/verify-sessions-command.ts` (marker + byte-identical store with
leases present), `spike/verify-tui.ts resume` (bare `--resume` against a live lease). Docs:
`docs/user-guide/sessions-and-state*.md`, `reference*.md`, decisions doc heading "Session lease —
one live process per session"; AGENTS.md row omitted (5 bytes under the preload cap).

### Notes / blockers / abandonment reason

Requirement: `src/agent/session.ts` gains a lease under the session's state directory (`~/.darwin/sessions/<key>/session/<id>/lease.json` or the equivalent existing session dir) written with `wx` when a session is selected (fresh, `--resume`, `--session`, `/clear` successor). A lease whose pid is alive on the same host is *live*: explicit `--resume <id>`/`--session <id>` then refuses in the `SessionNotFoundError` shape ("session `<id>` is open in pid N since <time>"), exit 1, never a fallback; bare `--resume` starts a fresh session and states why on the recap header. A lease whose pid is dead (or foreign host and older than a stated bound) is stale: taken over, one notice. Released in `runtime.shutdown()`; the unref'd exit fallback and process death leave a stale lease that the next launch takes over — there is never a manual unlock file. `darwin sessions` (read-only) marks a leased row `(open in pid N)` without touching it. Trajectory/snapshot bytes unchanged. Sources S5 (kiro "Sessions can only be active in one process at a time to prevent conversation corruption"), S2b (Codex 0.154.0 read-only transcript when open elsewhere). Darwin evidence: `resolveSession` has no lock; SDK `SessionManager` snapshot is last-writer-wins; `trajectory/writer.ts` appends from both processes. Risk is the stale path: pid liveness (`process.kill(pid, 0)`) must decide, and the lease must never lock a user out. Checks: a new `spike/verify-session-lease.ts` in `pnpm test`, `verify-sessions-command.ts`, `tui resume`.

## SER-092 — Resume hint on exit: after Ink releases the terminal, print one line `session <id> · resume: darwin --resume <id>` when the session completed at least one turn; nothing for headless, nothing when no turn ran

- Status: `not-started`
- Priority: 124
- Score: 11
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 2
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

Requirement: in `src/cli-main.ts` `runInteractive`, after `waitUntilExit()` and `shutdown()` (so any lease from SER-091 is released first), write exactly one stdout line for a session that recorded at least one completed turn (`runtime` already knows its session id and turn count; the `/clear` successor's id is the one printed). No line for a session with no completed turn, for headless, or for an error exit that already printed a refusal. Source S5 (kiro prints the id and the resume command on exit; `/session-id` on demand — darwin's `/status` already shows the id). Darwin evidence: `cli-main.ts` prints nothing after unmount. Check: `tui` scenario asserting the last stdout line after `/exit`; `pnpm test`.

## SER-093 — Agent definitions may omit project instructions: optional frontmatter `projectInstructions: false` (default unchanged) skips `<project-instructions>` in that child's system prompt; `/agents` states it; invalid values use the loader's bounded skip reason; built-in `general` unchanged

- Status: `not-started`
- Priority: 125
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

Requirement: `src/agents/loader.ts` accepts one optional boolean frontmatter key `projectInstructions` (absent = `true`); a non-boolean value skips the definition with the same bounded reason shape as `tools`. `buildRecipeChild` (`src/agents/child-recipe.ts`) passes `undefined` project instructions to `composeSystemPrompt` for a definition with `false`, so the child's prompt has no `<project-instructions>` block; `subagent`/`workflow` both honour it since both use the recipe. `/agents` listing states `no project instructions` on that row. `docs/architecture/sub-agents.md` "the definition prompt plus the project's `AGENTS.md` instructions" is updated to state the opt-out. Sources S1e (Claude Code 2.1.271 `omitClaudeMd`), S1f (built-in Explore/Plan skip CLAUDE.md "to keep research fast and inexpensive"). Darwin evidence: `child-recipe.ts:69` composes unconditionally; `MAX_INSTRUCTIONS_BYTES` = 32 KiB per dispatch. Checks: `verify-subagents.ts`, `verify-workflow-tool.ts`, a loader case in `pnpm test`.

## SER-094 — Environment marker in spawned processes: every process darwin spawns (model `bash` foreground/background, `!` commands, native and Codex hook commands, stdio MCP servers) receives `DARWIN=1` through the existing env seams; never overrides a user-set `DARWIN`; documented in one sentence

- Status: `not-started`
- Priority: 126
- Score: 10
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 1
- Risk: 2
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

Requirement: one pure helper (in `src/tools/shell-env.ts`) adds `DARWIN=1` to a spawn environment unless the name is already set; applied to the `scrubShellEnv` result used by the model's `bash` (foreground persistent shell and background jobs), to `src/tui/shell-command.ts` for `!`, to `src/hooks/hook-process.ts`/`src/hooks/lifecycle-hooks.ts` for hook commands, and to stdio MCP server `env` at `loadMcpClients`. Nothing else is added; the credential scrub, `ALWAYS_SURVIVE_NAMES` and passthrough are unchanged; trajectory, `/export` and headless output unchanged. README input docs and `/help` mention it in one sentence. Sources S1d (`CLAUDECODE=1` in Bash, hooks, stdio MCP subprocesses), S7 (`GEMINI_CLI=1` for `!`/shell). Darwin evidence: `shell-env.ts` adds nothing; `shell-command.ts:223` passes raw `process.env`. Checks: `verify-shell-env.ts` (or the suite that pins the scrub), `verify-background-bash.ts`, `verify-shell-command.ts`, `verify-lifecycle-hooks.ts`, `pnpm test`.

