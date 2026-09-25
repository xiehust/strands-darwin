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

- Status: `done`
- Priority: 123
- Score: 11
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Accepted `55469cb` (`feat(session): lease each session to one live process`), fresh child `session-20260915-143744191`, task `bg-ba57106f-6af3-4333-be89-e006d1cfe306` exit 0, drained. `src/agent/session.ts` — `lease.json` (`{ pid, hostname, startedAt }`) under `sessionStateDir`, `wx` acquisition in `resolveSession`, `classifyLease`/`pidAlive` (same host: `kill(pid, 0)`, `EPERM` alive; foreign host: live for `FOREIGN_LEASE_STALE_AFTER_MS` = 24 h), `SessionInUseError` (sibling of `SessionNotFoundError`), `SessionLease.release()` (only while the file names this pid), `inspectLease` for the listing; `AgentRuntime` holds the lease, releases in `shutdown()`/`retire()` and on a failed `create()`, exposes `info.leaseNotice`; `cli-main.ts` refuses `SessionInUseError` beside `SessionNotFoundError` and seeds the fresh-session notice as startup history; resume recap carries a takeover notice; headless writes one `lease:` line (structured warning `source: "session"`); `cli-sessions.ts` marks a live row `(open in pid N)`. Host read the session/runtime/cli-main/cli-sessions diff and the child's evidence note, ran `darwin sessions` against this project (read-only, no write), then `pnpm typecheck && pnpm test && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts resume && pnpm build && git diff --check && git status --short` (task `bg-a0503fc1-a84f-4116-9362-aa348d08b718`, exit 0, 8,981 PASS lines, 0 FAIL; log `/tmp/darwin-ser091-host-acceptance.log`). New `spike/verify-session-lease.ts` (381 lines, in `pnpm test`, real `cli.ts` runs through the `startup-cli` fixture), `verify-sessions-command.ts` marker + byte-identical store, `tui resume` extended. Docs: `sessions-and-state*.md`, `reference*.md`, decisions heading "Session lease — one live process per session"; AGENTS.md row omitted (32,763 bytes, five under cap). Iteration-log Batch 134.

Recorded risks (child, agreed by Host): same-process re-open of one id is refused too (darwin never does it; in-process tests must `shutdown()` first); the 24 h foreign-host bound is a stated guess without a heartbeat; two launches classifying one stale lease at the same instant leave a microsecond takeover race plain fs cannot close.

### Notes / blockers / abandonment reason

Requirement: `src/agent/session.ts` gains a lease under the session's state directory (`~/.darwin/sessions/<key>/session/<id>/lease.json` or the equivalent existing session dir) written with `wx` when a session is selected (fresh, `--resume`, `--session`, `/clear` successor). A lease whose pid is alive on the same host is *live*: explicit `--resume <id>`/`--session <id>` then refuses in the `SessionNotFoundError` shape ("session `<id>` is open in pid N since <time>"), exit 1, never a fallback; bare `--resume` starts a fresh session and states why on the recap header. A lease whose pid is dead (or foreign host and older than a stated bound) is stale: taken over, one notice. Released in `runtime.shutdown()`; the unref'd exit fallback and process death leave a stale lease that the next launch takes over — there is never a manual unlock file. `darwin sessions` (read-only) marks a leased row `(open in pid N)` without touching it. Trajectory/snapshot bytes unchanged. Sources S5 (kiro "Sessions can only be active in one process at a time to prevent conversation corruption"), S2b (Codex 0.154.0 read-only transcript when open elsewhere). Darwin evidence: `resolveSession` has no lock; SDK `SessionManager` snapshot is last-writer-wins; `trajectory/writer.ts` appends from both processes. Risk is the stale path: pid liveness (`process.kill(pid, 0)`) must decide, and the lease must never lock a user out. Checks: a new `spike/verify-session-lease.ts` in `pnpm test`, `verify-sessions-command.ts`, `tui resume`.

## SER-092 — Resume hint on exit: after Ink releases the terminal, print one line `session <id> · resume: darwin --resume <id>` when the session completed at least one turn; nothing for headless, nothing when no turn ran

- Status: `done`
- Priority: 124
- Score: 11
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 2
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Accepted `7be168f` (`feat(cli): print the resume hint when the tui exits`), fresh child `session-20260915-153718965`, task `bg-11c1252d-3c64-497d-a90d-bbb664247d5a` exit 0, drained. `src/cli-usage.ts` `resumeHintLine(id)` (plain text, one `\n`); `runInteractive` writes it after the `try/finally` that awaits `waitUntilExit()` and `shutdown()` (lease released, writers settled), for `current.info.sessionId` (the `/clear`/`/rewind` successor when one exists), gated on `AgentRuntime.messageCount > 0` — the existing accessor; the SDK saves the snapshot `--resume <id>` reads on `AfterInvocationEvent`, so "has messages" is exactly "reopenable". Consequence accepted by the Host: a *resumed* session that exits without a new turn still prints the line (its id does reopen); a fresh session with no prompt prints nothing; refusal paths return earlier; `-p` never reaches it. Host read the `cli-main.ts`/`cli-usage.ts` diff and ran `pnpm typecheck && pnpm test && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts resumeHint && pnpm build && git diff --check && git status --short` (task `bg-3a95b23f-a34e-4873-ac98-67206a827d9d`, exit 0, 8,974 PASS lines, 0 FAIL; log `/tmp/darwin-ser092-host-acceptance.log`). New free pty scenario `resumeHint` (offline `startup-cli` fixture: no-turn `/exit` silent; turn → `/clear` → turn → `/exit` ends with the successor's exact line, once); `verify-headless.ts`/`verify-headless-structured.ts` each pin the line's absence in `-p` output. Docs: one sentence each in `sessions-and-state*.md` and `reference*.md`, one paragraph under the existing "`darwin sessions` and `--resume <id>`" decisions heading; README and AGENTS.md untouched. Iteration-log Batch 135.

### Notes / blockers / abandonment reason

Requirement: in `src/cli-main.ts` `runInteractive`, after `waitUntilExit()` and `shutdown()` (so any lease from SER-091 is released first), write exactly one stdout line for a session that recorded at least one completed turn (`runtime` already knows its session id and turn count; the `/clear` successor's id is the one printed). No line for a session with no completed turn, for headless, or for an error exit that already printed a refusal. Source S5 (kiro prints the id and the resume command on exit; `/session-id` on demand — darwin's `/status` already shows the id). Darwin evidence: `cli-main.ts` prints nothing after unmount. Check: `tui` scenario asserting the last stdout line after `/exit`; `pnpm test`.

## SER-093 — Agent definitions may omit project instructions: optional frontmatter `projectInstructions: false` (default unchanged) skips `<project-instructions>` in that child's system prompt; `/agents` states it; invalid values use the loader's bounded skip reason; built-in `general` unchanged

- Status: `done`
- Priority: 125
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Accepted `d8c6ab2` (`feat(agents): let a definition omit project instructions`), fresh child `session-20260915-161532664`, task `bg-e512f8c7-b5ea-434c-9a08-849814b58c2d` exit 0, drained. `src/agents/loader.ts`: `AgentDefinition.projectInstructions: boolean` (built-in `general` `true`), frontmatter key read after `tools` — absent means `true`, any non-boolean (including YAML `null`) skips with `frontmatter "projectInstructions" must be a boolean`; exported `catalogueEntry(definition)` appends ` (no project instructions)` for opted-out definitions. `buildRecipeChild` passes `undefined` to `composeSystemPrompt` for such a definition (the recipe is the only child prompt composer, so `subagent` and `workflow` both honour it). Discoverability correction accepted by the Host: `/agents` lists dispatches, not definitions, so the flag is stated on the `Available agents:` catalogue line of both tool descriptions instead — no new command. Host read the loader/recipe/tool diff and ran `pnpm typecheck && pnpm test && pnpm build && git diff --check && git status --short` (task `bg-a4fe0721-a02d-409f-b294-234b70fe21b5`, exit 0, 8,978 PASS lines, 0 FAIL; log `/tmp/darwin-ser093-host-acceptance.log`). `spike/verify-subagents.ts` +70 lines (flag loads; `"no"` skipped with the reason; absent → `true`; offline recipe child without `<project-instructions>` while `general` keeps it; both descriptions mark only the opted-out agent); twelve offline definition literals in other suites gained the required field. Docs: `sub-agents.md`, `extensions.md` EN/zh-CN, one sentence in the decisions doc; README/AGENTS.md untouched. Iteration-log Batch 136.

### Notes / blockers / abandonment reason

Requirement: `src/agents/loader.ts` accepts one optional boolean frontmatter key `projectInstructions` (absent = `true`); a non-boolean value skips the definition with the same bounded reason shape as `tools`. `buildRecipeChild` (`src/agents/child-recipe.ts`) passes `undefined` project instructions to `composeSystemPrompt` for a definition with `false`, so the child's prompt has no `<project-instructions>` block; `subagent`/`workflow` both honour it since both use the recipe. `/agents` listing states `no project instructions` on that row. `docs/architecture/sub-agents.md` "the definition prompt plus the project's `AGENTS.md` instructions" is updated to state the opt-out. Sources S1e (Claude Code 2.1.271 `omitClaudeMd`), S1f (built-in Explore/Plan skip CLAUDE.md "to keep research fast and inexpensive"). Darwin evidence: `child-recipe.ts:69` composes unconditionally; `MAX_INSTRUCTIONS_BYTES` = 32 KiB per dispatch. Checks: `verify-subagents.ts`, `verify-workflow-tool.ts`, a loader case in `pnpm test`.

## SER-094 — Environment marker in spawned processes: every process darwin spawns (model `bash` foreground/background, `!` commands, native and Codex hook commands, stdio MCP servers) receives `DARWIN=1` through the existing env seams; never overrides a user-set `DARWIN`; documented in one sentence

- Status: `done`
- Priority: 126
- Score: 10
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 1
- Risk: 2
- Origin report: [`research_2026-09-15.md`](../research_2026-09-15.md) (run `12:43:40Z`)

### Implementation / acceptance evidence

Accepted `1625bec` (`feat(shell-env): mark every spawned process with DARWIN=1`), fresh child `session-20260915-164853870`, task `bg-baefa03b-c33c-4a5b-988e-934834f9fc68` exit 0, drained. `src/tools/shell-env.ts` `withDarwinMarker(env)` (+ `DARWIN_MARKER_NAME`/`_VALUE`): copies defined values and adds `DARWIN=1` only when absent — a preset value survives byte-identical; applied to the scrubbed env for the foreground shell and background jobs (parent and child bash, `runtime.ts`), `!` (`shell-command.ts`), native tool hooks (`tool-hooks.ts`), lifecycle hooks (`lifecycle-hooks.ts`), Codex-dialect hooks (`hook-process.ts`), and stdio MCP servers via `withStdioDarwinMarker` composed with `withDefaultPrefixes` in `loadMcpClients` (stdio detected as the SDK does; http/sse byte-identical; config `env.DARWIN` wins). SDK finding recorded: the stdio transport spawns with `{ ...getDefaultEnvironment(), ...env }` — a fixed whitelist, never `process.env` — so the config `env` is the only path into a server. Scrub, `ALWAYS_SURVIVE_NAMES`, passthrough, `shell-env:` notice and `/status` row unchanged. Host read the seven-file source diff, ran the built helper directly (`{PATH,DARWIN:"1"}` / preset `custom` preserved) and `pnpm typecheck && pnpm test && pnpm build && git diff --check && git status --short` (task `bg-18a16932-7e63-4560-8e9a-bd95fd70112a`, exit 0, 9,014 PASS lines, 0 FAIL; log `/tmp/darwin-ser094-host-acceptance.log`). Six suites extended: `verify-shell-env.ts` (helper contracts + real offline `AgentRuntime` foreground/background `echo "[$DARWIN]"` → `[1]`), `verify-shell-command.ts`, `verify-tool-hooks.ts`, `verify-lifecycle-hooks.ts`, `verify-codex-hooks.ts`, `verify-mcp-config.ts` (real `sh -c` stdio server observes `1`; config `env.DARWIN` wins). Docs: README EN/zh-CN one sentence, `reference.md` EN/zh-CN `!command` row, one paragraph under the SER-082 shell-env decisions heading; `/help` unchanged (describes no shell environment); AGENTS.md untouched at 32,763 bytes. Iteration-log Batch 137.

Note from the child, confirmed as pre-existing: `spike/verify-mcp-config.ts` run standalone under the real `HOME` fails 8 assertions at HEAD before this change too (this machine's global `~/.darwin/mcp.json` adds servers); under the private `HOME` `pnpm test` gives it, it is green.

### Notes / blockers / abandonment reason

Requirement: one pure helper (in `src/tools/shell-env.ts`) adds `DARWIN=1` to a spawn environment unless the name is already set; applied to the `scrubShellEnv` result used by the model's `bash` (foreground persistent shell and background jobs), to `src/tui/shell-command.ts` for `!`, to `src/hooks/hook-process.ts`/`src/hooks/lifecycle-hooks.ts` for hook commands, and to stdio MCP server `env` at `loadMcpClients`. Nothing else is added; the credential scrub, `ALWAYS_SURVIVE_NAMES` and passthrough are unchanged; trajectory, `/export` and headless output unchanged. README input docs and `/help` mention it in one sentence. Sources S1d (`CLAUDECODE=1` in Bash, hooks, stdio MCP subprocesses), S7 (`GEMINI_CLI=1` for `!`/shell). Darwin evidence: `shell-env.ts` adds nothing; `shell-command.ts:223` passes raw `process.env`. Checks: `verify-shell-env.ts` (or the suite that pins the scrub), `verify-background-bash.ts`, `verify-shell-command.ts`, `verify-lifecycle-hooks.ts`, `pnpm test`.


## SER-095 — Model-stream idle watchdog: a per-stream timer (default 120 s, config `streamIdleTimeoutSeconds`, `0` disables) fails the turn visibly with a bounded `stream idle for Ns` notice when no stream event arrives; a new terminal failure class, never routed into the one-continuation stream-resumption path; cancel wins the race and stays a cancel; headless writes one `stream:` stderr line

- Status: `done`
- Priority: 127
- Score: 11
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-09-18.md`](../research_2026-09-18.md) (run `09:23:56Z`)

### Implementation / acceptance evidence

Accepted 2026-09-19 in `246bdbd75df82fc582d22d889b91be12a9085c21`, fresh child `session-20260919-015608498`. Host reviewed all 17 changed files and independently ran `pnpm typecheck && pnpm test && pnpm build && git diff --check && test -z "$(git status --porcelain)"` (task `bg-a1c23e94-d65d-423a-aa16-ffc56965eec9`, exit 0, 9,054 PASS lines). Full gate includes new `verify-stream-idle.ts`, config, stream-resumption, model-retry and structured-headless regressions. Real runtime and local HTTP/1 OpenAI/Anthropic, HTTP/2 Bedrock, text/JSON/JSONL and production TUI checks prove silent first/later reads fail, thinking resets, cancellation wins, transport closes, no retry/continuation/late tools and subsequent invocation works. Timer is confined to parent provider reads through `InvokeModelStage`, excluding tools/permissions/backoff/background/children; custom providers ignoring abort must settle before cleanup returns (documented limitation, never detached). Bilingual README/configuration/reference/usage and architecture synced; AGENTS 32,710 bytes. See iteration-log Batch 138. Earlier partial work remains preserved in stash `faa1c61`, not applied.

### Notes / blockers / abandonment reason

Source S5 (kiro-cli changelog 2-19: stream idle watchdog, retries with backoff, 60-minute streaming timeout). Darwin evidence: `src/agent/stream-resumption.ts` resumes only an *ended* stream (exact `ModelError: Stream ended without completing a message`); `src/agent/model-retry.ts` retries only throttle-class errors — a silently hung stream hangs the turn forever. The watchdog counts *any* stream event (thinking deltas included), so long thinking pauses never trip it. It must not become a second continuation path: the idle failure is terminal for the turn, recorded in the trajectory like any other failure. Checks: `pnpm typecheck`, `pnpm test`, the new suite the child adds, `verify-stream-resumption.ts` (unchanged behavior for the exact-match path).

## SER-096 — Permission-rule dry-run: `darwin permissions test <rule>` (CLI) and `/permissions test <rule>` (TUI) evaluate a candidate rule against the existing matcher and print the parse result, which already-seen `(toolName, input)` pairs from the trajectory it would have matched, and whether an existing deny rule beats it; read-only, never writes config, never touches live gate state

- Status: `done`
- Priority: 128
- Score: 11
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-18.md`](../research_2026-09-18.md) (run `09:23:56Z`)

### Implementation / acceptance evidence

Accepted 2026-09-19 in `5d31ad543d85666d04d84d98e40a41e3cccc0a8a`, fresh child `session-20260919-024010300`. Host reviewed the 19-file diff and independently ran `pnpm typecheck && pnpm test && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts completion && pnpm build && git diff --check && test -z "$(git status --porcelain)"` (task `bg-b7db9ae8-77de-46a0-babc-443f758a9df1`, exit 0, 9,212 PASS lines including completion75). `verify-permissions-test.ts`83 covers real CLI and busy pty, canonical parse/match/deny, no SDK import graph, byte-identical policy/session state, exact whitespace, sensitive exemptions and lossy/missing/symlinked evidence. Existing permission42/deny95/CLI-doc43 regressions included. CLI scopes current project, TUI current persisted session/live deny snapshot; bounded 20 sessions, 2 MiB/file, 8 MiB total, 20 displayed pairs/240-cp cells. Unknown evidence is never execution approval. README/permissions narratives/reference EN/zh and architecture synchronized; AGENTS 32,742 bytes, dist refreshed. See iteration-log Batch 139.

### Notes / blockers / abandonment reason

Source S2c (Codex exec-policy `prefix_rule` ships inline `match`/`not_match` unit tests; most-restrictive-wins). Darwin evidence: `src/agent/permission-rules.ts` matcher is pure and already suite-tested; `src/trajectory/reader.ts` is the read-only record source; `darwin sessions` is the read-only-projection precedent. The dry run is a projection over the existing matcher plus the trajectory reader — no new write path, no gate mutation. Checks: `pnpm test`, `verify-permissions-command.ts`, `verify-deny-rules.ts`.

## SER-097 — Suggest the exact allow rule at the permission prompt: answering "always" shows the exact rule text before it is persisted (derived from the exact `(toolName, input)`, e.g. the bounded bash wildcard for the command's stable prefix), and the post-write notice names the rule so `/permissions` can revoke it; no grammar or auto-approval change

- Status: `done`
- Priority: 129
- Score: 9
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 3
- Origin report: [`research_2026-09-18.md`](../research_2026-09-18.md) (run `09:23:56Z`)

### Implementation / acceptance evidence

Accepted 2026-09-19 in `c526522e96c6dc301cbf182f8c94ca3582468ba0`, child `session-20260919-032104114` (one provider-server-error retry in the same session, not an acceptance correction). Host reviewed 16 changed files and independently passed `pnpm typecheck`, full `pnpm test` (preview210 plus existing permission/mode/deny/dry-run/frame/visual regressions), live `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve`29 and `alwaysAllow`9, free `completion`75 and `mode`25, `pnpm build`, diff/clean-tree checks; task `bg-51780e01-8360-4e46-8841-6f69584cca52`, exit 0, 9,485 PASS lines. a/A selects unchanged suggestion for exact reversible ASCII-JSON review in existing modal; Enter pages then saves only a flushed last page, b back/y once/n-Esc deny, resize restarts, stale request refuses. Existing saved/session-only notice and revocation reused; generator/matcher/grammar unchanged. Small terminal cannot save until enlarged. README/permissions/reference EN/zh and architecture synchronized; AGENTS32,761 bytes, dist built. See iteration-log Batch 140.

### Notes / blockers / abandonment reason

Source S2c ("When Smart approvals are enabled (the default), Codex may propose a `prefix_rule` for you during escalation requests"). Darwin evidence: the permission prompt already persists allow rules (`src/agent/permission.ts`, `src/tui/PermissionPrompt.tsx`); the delta is transparency of *what* is persisted. The suggested rule must obey the existing constraints: never covers `~/.darwin/config.json` or `.env*`, a bash rule must match every chained segment and never a redirection/substitution. Checks: `pnpm test`, `tui approve` (live), `verify-permissions-command.ts`.

## SER-098 — `/agents` overview gains a settled-dispatch summary line: counts by terminal state (succeeded/failed/cancelled) for the session's dispatches on the existing panel, from the dispatch registry's own records; no persistence, no deletion, no new surface

- Status: `done`
- Priority: 130
- Score: 11
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 1
- Risk: 1
- Origin report: [`research_2026-09-18.md`](../research_2026-09-18.md) (run `09:23:56Z`)

### Implementation / acceptance evidence

Accepted 2026-09-19 in `56c25c79cc25ad215d152bd7d2de8ca5cc931a0a`, fresh child `session-20260919-041026304`. Five production lines in `formatDispatchesReport` append `settled — this run: succeeded N · failed N · cancelled N`; empty unchanged, running excluded, all supplied registry snapshots counted without stored counters. Host reviewed eight changed files and independently ran `pnpm typecheck && pnpm test && pnpm build && git diff --check && test -z "$(git status --porcelain)"`, task `bg-9da5211f-830f-40ce-8658-6224578a5a9a`, exit0, 9,361 PASS lines. Subagent-format57 covers real registry transitions, cancel-request versus settlement, continuations/workflow/colliding IDs, immutable snapshots, old row bytes and Static reducer/source-route evidence. No new live pty scenario claimed; App/registry unchanged. EN/zh extensions/reference and both subagent architecture docs synchronized; README/using-darwin accurate, AGENTS unchanged. Dist rebuilt. See iteration-log Batch141.

### Notes / blockers / abandonment reason

Source S2 (Codex v0.155.0 "Added task hiding, archiving, and deletion in the agents overview"). Darwin evidence: `src/agents/dispatch-registry.ts` tracks terminal states in-session; `/agents` (`src/tui/subagent-format.ts`) is the existing panel. Deliberately excludes archiving/deletion — dispatch records are session-scoped and ephemeral by design. Zero dispatches shows no summary line. Checks: `pnpm test`, the `/agents` format suite.

## SER-099 — `darwin import --from claude-code`: read-only scan of `~/.claude/` and project `.claude/`/`CLAUDE.md` printing a bounded migration plan; `--apply` copies prompt-content layers only (skills, agents, CLAUDE.md → AGENTS.md section) and prints the exact `mcp.json`/permission-rule snippets for the user to paste; executable config (hooks, MCP) is never armed by the import itself

- Status: `done`
- Priority: 131
- Score: 6
- Importance: 3
- Architecture fit: 3
- Evidence confidence: 3
- Difficulty: 3
- Risk: 3
- Origin report: [`research_2026-09-18.md`](../research_2026-09-18.md) (run `09:23:56Z`)

### Implementation / acceptance evidence

Accepted 2026-09-19 in `84151059ae870776e96f8d5a887de3c562b4d457`, fresh child `session-20260919-044344757`. Host reviewed 19-file diff and independently ran `pnpm typecheck && pnpm test && pnpm build && git diff --check && test -z "$(git status --porcelain)"`, task `bg-d283f7ae-e885-40b2-ba51-f31058e000b1`, exit0, 9,465 PASS lines including import104/CLI-doc43 and existing loaders/trust regressions. Private-HOME real CLI/files and actual loaders prove no-write scan, scoped supported prompt copy, preserved restrictions, AGENTS append/repeat/cap, collisions, symlink/hardlink/special-file refusal, changed-since-scan refusal, bounded output, valid manual snippets and no executable policy/trust/session startup. Safe importer currently requires Linux descriptor-relative no-follow access; other hosts remain manual. Only plain name/description/body skills and agents (optional empty tools array) auto-map; nonempty tool restrictions/other frontmatter/global instructions remain explicit manual migration. MCP credentials/arbitrary shapes and ~/.claude.json are not exposed; snippets are candidates, not equivalent policy. Apply is nontransactional and reports partial I/O failure without rollback. No import ran against real HOME/repository. README/getting-started/extensions/permissions/reference EN/zh and architecture synchronized, AGENTS unchanged32,761 bytes; dist rebuilt. See iteration-log Batch142.

### Notes / blockers / abandonment reason

Source S2d (Codex `/import` "Import Claude Code or Cursor setup, projects, and chats"). Darwin evidence: darwin already reads Claude-format `.mcp.json` (root fallback) and `.agents/` layers, so the migration delta is small; workspace trust (SER-090) already governs arming executable config, and the import must stay consistent with it — hooks/MCP are printed as snippets, never armed. Risk is path handling across two tools' stores; the scan is read-only and bounded. Checks: `pnpm test`, the new CLI suite the child adds.


## SER-100 — Keep completion labels and accepted composer drafts terminal-safe at presentation: one counted menu row for hostile filename controls, exact raw path insertion, and display-cell/source-offset cursor mapping without rewriting draft bytes

- Status: `done`
- Priority: 132
- Score: 11
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-09-20.md`](../research_2026-09-20.md)

### Implementation / acceptance evidence

Accepted `7c96669` after independent Host review of all ten changed files. Host `pnpm typecheck && pnpm test && pnpm build && git diff --check` plus clean-tree assertion passed (task `bg-f98f94e5-46b4-4209-9595-2d3f787e534c`, exit 0; 9,443 PASS lines). Full gate includes new real-file/Ink/editor checks (16) and real CLI pty checks (6), covering exact insertion, all control classes, CRLF/graphemes, display widths, cursor/delete/undo mapping, menu grants/omissions and no model call. Separately Host reran `spike/verify-tui.ts completion` (75), `pathCompletion` (27), `wordNav` (11), `undo` (7), all exit 0. Independent original reproduction now returns 4 menu rows instead of 16; ANSI displays literally in menu and accepted draft, raw insertion unchanged, cursor column 36 matches projected width. Source changes confined to `InputBox` and `prompt-editor`; English/Chinese using-darwin/reference and architecture synced, README remains accurate. See iteration-log Batch 143. Child `session-20260920-114354682`, one successful managed task; no correction needed.

### Notes / blockers / abandonment reason

Score 11 passes gate 6. Pure presentation fix at `InputBox` and `prompt-editor` seams, informed by `searchPreview`; preserve `scanWorkspacePaths`/`applyPathCompletion` raw identity, matching/order and path-only/no-file-content contract. Cover C0/DEL/C1, CRLF, ANSI/OSC and Unicode separators in single-row labels; preserve ordinary Unicode, draft LF/tab behavior and exact source offsets while displaying non-layout controls safely after insertion. Menu-only remediation is incomplete. No global transcript sanitizer, new store/row/timer, dependency, permission change or SDK loop fork. Acceptance requires real names/Ink renders plus CLI pty selection/editing, exact raw insertion, safe display and cursor/delete/undo mapping; full gates, free completion/pathCompletion/wordNav/undo pty checks, and build. Sync English/Chinese user docs and relevant architecture. One-direction batch, no dependency.


## SRF-033 — Recognize SDK-enveloped bash list results in terminal-delivery suppression so a completed list prevents redundant queued job wakes

- Status: `done`
- Priority: 133
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-09-24_session-20260924-010948157.md`](../../reflections/reflection_2026-09-24_session-20260924-010948157.md)

### Implementation / acceptance evidence

Accepted `48c1b8c` (`fix(wake): count sdk-enveloped bash list results as delivered`), child `session-20260925-084720722`. `sdkArrayEnvelope` in `src/agent/task-terminal-delivery.ts` unwraps exactly one level of an object whose sole own key is `$value` holding an array (the shape at installed SDK `function-tool.js:233–238`, Host-verified), then applies the unchanged per-item terminal snapshot check; bare arrays, direct snapshots and `wait` results unchanged; extra keys, non-array `$value`, nested envelopes, other tools and non-success results yield nothing; commit still waits for `endTurn`. `spike/verify-task-wake.ts` adds a real-SDK section (real bash tool through real `Agent`s, scripted model) and a sixth pty session (`start-list-complete`/`-fail`/`-cancel` fixture verbs). Host acceptance: `pnpm typecheck && pnpm test` (9,484 PASS lines, no failing suite), `spike/verify-task-wake.ts` 106 passed / 0 failed, `pnpm build`, `git diff --check` — task `bg-0e48aba4-a7e6-43f5-9671-63d68e8f735c`, exit 0. Negative control: source restored to pre-fix `f3c2550` gives 96 passed / 10 failed (all pty suppression assertions), task `bg-61edeeb3-accb-4392-9111-b9d7974c085b`; file restored after. Architecture rationale synced in the accepted commit; Host synced `using-darwin` EN/zh (`wait`/`status`/`list`).

### Notes / blockers / abandonment reason

Evidence: source session turn 2 / seq 625 cancels and correctly discards pending deliveries. Turn 4 / seq 635 then returns ten stopped jobs inside a `$value` envelope and seq 640 completes, yet eight further old-job wakes run at turns 5–12 / seq 641–682: 32.555 seconds, 1,180 output and 1,645,703 cache-read tokens. `createBackgroundBashTool` returns `manager.list()`; installed SDK `function-tool.js` wraps arrays, while the ledger recognizes only bare arrays/direct/wait snapshots. This is a specific SER-069 regression gap, not a duplicate wake feature or permission to commit cancelled-turn deliveries. Score = 2×4+5+5−2−2 = 14, above gate 6. No dependency; implement first. The two wakes preceding the completed list are not claimed as savings.

## SRF-034 — Extend default verification guidance to numeric reports: compute and reconcile totals, preserve quantity semantics, and label unsupported attribution explicitly

- Status: `done`
- Priority: 134
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 4
- Difficulty: 2
- Risk: 1
- Origin report: [`reflection_2026-09-24_session-20260924-010948157.md`](../../reflections/reflection_2026-09-24_session-20260924-010948157.md)

### Implementation / acceptance evidence

Accepted `3e6dbcd` (`feat(prompt): extend verification rule to numeric reports (SRF-034)`), child `session-20260925-093854218`. Working method rule 4 in `src/agent/system-prompt.ts` gains one five-line, domain-neutral clause naming no tool: compute summaries with an available local tool, reconcile components against the authoritative total/units/time window, keep requested vs executed and observed vs estimated/counterfactual apart, state missing evidence or an unexplained residual. `spike/verify-system-prompt.ts` pins the four parts inside the rule-4 slice, no tool name and no domain wording in it, rule 5 unchanged, no leak into a file override, and recomputes the seq-753 components (817,543 vs stated 817,643, residual 100) and the requested-quantity balance (3,077 vs observed 5,200.39933617). Host acceptance: `pnpm typecheck && pnpm test` (9,495 PASS lines, no failing suite), `verify-system-prompt.ts` 62/0, `pnpm build`, `git diff --check` — task `bg-0128ba4c-8100-4608-86b6-4d22ddd87080`, exit 0. Static checks verify the instruction contract only, not model compliance; no live run. No user doc quotes rule 4 (configuration's composition section summarizes only the load-bearing base rules), so no docs sync.

### Notes / blockers / abandonment reason

Evidence: turn 15 / seq 750 substitutes requested `quantity` when `filled_quantity` is absent; seq 751 implies a 3,077-unit balance including the opening gift, versus 5,200.39933617 observed at turn 13 / seq 708. Turn 15 / seq 753 displays components totaling 817,543 against a stated rounded 817,643, even after an unexplained −382 residual, and advances counterfactual interest/rank claims without an executable reconciliation. Official aggregate attribution at seq 744 remains valid. The default prompt currently specifies verification for code changes, not numeric-report reconciliation. Score = 2×4+5+4−2−1 = 14, above gate 6; confidence 4 acknowledges prompt-following uncertainty. No hard dependency; implement after SRF-033. This is not the abandoned generic evaluation-corpus direction SER-005.

## SRF-035 — Extend bounded retry guidance to generated side-effect automation, distinguishing deterministic rejection, transient limits and ambiguous writes

- Status: `done`
- Priority: 135
- Score: 13
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-09-24_session-20260924-010948157.md`](../../reflections/reflection_2026-09-24_session-20260924-010948157.md)

### Implementation / acceptance evidence

Accepted `15f80c8` (`feat(prompt): bound retries in generated side-effect automation (SRF-035)`), child `session-20260925-101514714`. Rule 5 of the default base prompt keeps its tool-retry text verbatim and gains a seven-line, domain-neutral, tool-free continuation for code written to run unattended with side effects: bounded identical deterministic rejections then pause with the reason stated until inputs/observed state change; bounded transient-limit retries with backoff honouring server-directed delay; reconcile state or use an idempotency key before replaying an ambiguous state-changing request; offline response-sequence checks before unattended launch when feasible. `spike/verify-system-prompt.ts` pins each part inside the rule-5 slice, ordering after the existing limits, no tool/domain wording, rule 6 intact and no leak into a file override. `src/agent/retry-guard.ts`, runtime and permission gate untouched; `load-bearing-decisions.md` (Repeated tool failures) now states the guard counts SDK tool results only and the prompt is guidance, not enforcement. Host acceptance: `pnpm typecheck && pnpm test` (9,507 PASS lines, no failing suite), `verify-system-prompt.ts` 74/0, `verify-retry-guard.ts` 15/0, `verify-working-context.ts` 63/0, `pnpm build` (clause present in `dist/src/agent/system-prompt.js`), `git diff --check` — task `bg-87964170-c200-450a-8d62-74ff7b714baa`, exit 0. Static prompt checks verify the guidance, not a universal behavioural guarantee; no live run.

### Notes / blockers / abandonment reason

Evidence: turn 2 / seq 388 contains eleven same-class HTTP 400 concentration rejections inside one successful bash wait before stop/repair at seq 397–410. Seq 236/258 show genuinely transient 409 borrow-cap failures; seq 544 records an uncertain POST timeout after the non-GET replay repair at seq 442. These require different retry policies. SRF-016 intentionally counts SDK tool results, not script iterations; this direction extends code-generation guidance without duplicating or widening that runtime guard. Score = 2×4+4+5−2−2 = 13, above gate 6. No hard functional dependency; implement after SRF-034 because both touch the same prompt/test region. Keep the wording domain-neutral and bounded.


## SER-101 — Provenance-scoped reasoning round-trip on the OpenAI Responses path: capture Bedrock `response.reasoning.delta` and opaque `encrypted_content` into tagged `ReasoningBlock`s, replay only same-model reasoning as stateless `reasoning` input items, and never send Responses-origin reasoning to another model or to Converse

- Status: `done`
- Priority: 136
- Score: 10
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 4
- Origin report: [`research_2026-09-25.md`](../research_2026-09-25.md)

### Implementation / acceptance evidence

Accepted 2026-09-25 as `bd47afd` (`feat(sdk-patch): replay responses reasoning to its own model only`). The work was implemented by child `session-20260925-125808372` (task `bg-9e42a846-333f-4544-9066-48a5ede39163`) and selected by user direction ahead of the SRF-036..039 batch. Base `4683fcf`; no foreign commits in `4683fcf..bd47afd`.

- **Tag and replay.** The pinned patch now tags captured Responses reasoning in `signature` as `darwin-responses:v1:<model>:<text|enc|sum>[:<blob>]`. It maps `response.reasoning.delta`, and each `output_item.done` reasoning item closes its block, with `encrypted_content` in its own block. Same-model tagged blocks are replayed as stateless `reasoning` items with no `id`, before that message's text and calls.
- **Drops.** The Converse, Anthropic and Chat Completions formatters drop tagged blocks. Converse also drops signature-less reasoning for a Claude id. The `openai/model.js` stream state carries the request model id.
- **Changed files.** Patch 15 → 19 files; `pnpm-lock.yaml` patch hash; `changeModel` doc comment; new offline `spike/verify-responses-reasoning.ts` (in `pnpm test`) and live `spike/verify-responses-reasoning-live.ts`; `verify-npm-package.ts` count; load-bearing § Thinking effort and § npm package; configuration EN/zh-CN; one AGENTS.md live-suite line (32,767 ≤ 32,768 bytes).

Host acceptance:

- **Diff review.** Both new Converse/Anthropic `undefined` returns are filtered by their callers.
- **Full gate** (task `bg-d7142f07-fdd5-495d-9077-f53919e702a1`, exit 0): `pnpm typecheck`; `pnpm test` (9,590 PASS lines, 0 FAIL); `verify-responses-reasoning.ts` 39/0; `verify-npm-patch-format.ts` 56/0; `verify-model-command.ts` 16/0; `pnpm build`; registry `verify-npm-package.ts` 49/0; `git diff --check`.
- **Negative control.** The base patch and lock from `4683fcf` were reinstalled offline: `verify-responses-reasoning.ts` gave 20 passed / 19 failed. After restore it gave 39/0 and the tree was clean.
- **Live suite, first run** (`bg-df0055b8-7ebe-4a62-a29c-09d90bfafc80`): 98/1. The only failure was the Kimi aggregate, because Kimi emitted no reasoning events on any call that run (`0d/0i`). This is the model's choice, as the suite header documents.
- **Live suite, second run** (`bg-3e110fb6-9d24-4a6a-9b9e-a58492015843`): 99/0. Kimi captured 222d/1i and 125d/1i, with replay 0→1→2. GPT replay 0→1→2→3 across resume. All seven hand-offs succeeded, and every Responses request returned 200.
- **Mantle.** `openai.gpt-5.6-sol` returned 2/2 reasoning items with `encrypted_content` and no `include`, so thinking params are unchanged.

Original plan: Implement in the pinned SDK patch (`patches/@strands-agents__sdk@1.18.0.patch`), which already edits `dist/src/models/openai/responses-adapter.js`; no loop fork, no `toolExecutor`, no new dependency. In `mapResponsesEventToSDK`: map `response.reasoning.delta` like `response.reasoning_text.delta`; on `response.output_item.done` of type `reasoning`, close the open reasoning block, and put an item's `encrypted_content` in its own block. In `formatResponsesMessages`: emit assistant reasoning as `{type:'reasoning', summary:[], encrypted_content}` or `{…, content:[{type:'reasoning_text', text}]}`, before that message's text and `function_call` items, with no `id`.

The report's prototype measured this on both models: Kimi 5/5 and GPT-6-astra 6/6 requests 200, with input tokens rising once reasoning is replayed. Unlike the prototype, every captured block carries a provenance tag inside `signature`, the only field `ReasoningBlock.toJSON` persists. Replay is only for a tag matching the live model id; every untagged or foreign block is dropped exactly as today. The Bedrock/Converse side must never emit a Responses-tagged block, and must be checked for signature-less Kimi Converse reasoning reaching a Claude adaptive model.

Acceptance, as in the report's Recommendation:
- live capture and same-model replay on Kimi K3 and GPT-6-astra;
- live `/model` hand-offs across Claude, GPT and Kimi in both directions;
- `--resume` persistence, with replay/export unchanged;
- no Mantle `openai.gpt-5.6-sol` regression, including the `include` question;
- `pnpm typecheck`, `pnpm test`, `verify-npm-patch-format.ts`, `pnpm build`, and registry `verify-npm-package.ts`.

### Notes / blockers / abandonment reason

Score = 2×4+4+5−3−4 = 10, above gate 6. Risk 4 is the reason for the provenance constraint: the report measured that untagged replay yields 400 `invalid encrypted reasoning` / `encrypted reasoning was created for a different account or provider` on the Responses models, and `thinking.signature: Field required` / `Invalid signature` on Claude Converse. `AgentRuntime.changeModel` currently relies on the adapter dropping reasoning (see its doc comment), so a replay without provenance would break `/model`.

The signature-tag codec is a workaround for the missing upstream field (harness-sdk #2014). Upstream #3389 covers the OpenAI round-trip but not the Bedrock event name or cross-provider safety; a new upstream issue was filed from this report ([harness-sdk#4598](https://github.com/strands-agents/harness-sdk/issues/4598)). On any SDK upgrade, drop these hunks if upstream covers them rather than rebasing a duplicate. SDK 1.19.0 was checked and does not.

Kimi K3 via Converse is out of scope except for the Claude hand-off check. The Kimi K3 model card (report source S1) documents a Converse multi-turn reasoning failure that was not reproduced; darwin configuration guidance for Kimi should point at `bedrockRuntime` + `responses` once this lands. No dependency on SRF-033…035; queued after them.

Residual risks the child recorded at acceptance:

- Kimi on Converse after Claude-signed reasoning is still refused (`doesn't support the reasoningContent.reasoningText.signature field`). This is pre-existing and byte-identical to the unpatched SDK, and outside this direction.
- The Converse unsigned-reasoning drop detects Claude with `/anthropic|claude/` on the model id, so a Claude application-inference-profile ARN would miss it.
- The Google and Vercel formatters do not check tags; darwin cannot configure either provider.
- AGENTS.md's live-suite block replaced the `probe-model-switch.ts` line (the file remains) to stay under the byte cap.

## SRF-036 — Let terminal-delivery suppression observe the pre-offload bash result, so an offloaded terminal `wait` stops a redundant task wake

- Status: `done`
- Priority: 137
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-09-25_session-20260925-083010463.md`](../../reflections/reflection_2026-09-25_session-20260925-083010463.md)

### Implementation / acceptance evidence

Accepted 2026-09-25 as `cf50fce` (`fix(task-wake): observe the pre-offload bash result`). It was implemented by child `session-20260925-140015939` (task `bg-3b9561b4-1f81-47c1-80f4-abb4da806096`) on base `e2a5cee`; `e2a5cee..cf50fce` holds only that commit.

What changed:

- **Ledger.** `TerminalDeliveryLedger.install(agent)` registers one read-only `AfterToolCallEvent` hook at `HookOrder.SDK_FIRST`. It records the original successful `bash` result's terminal ids by `toolUseId`.
- **Resolution.** `observe` counts an unchanged result as before. A replaced success result commits a candidate id only when its text blocks contain that exact id. `closeTurn` drops candidates.
- **Runtime.** The parent runtime builds and installs the ledger in `create()`; children are unchanged.
- **Tests and docs.** New non-pty and pty sections in `spike/verify-task-wake.ts`, with fixture verbs, and a synced `load-bearing-decisions.md` (Background-task wake, Durable context offload).

Host acceptance (task `bg-82e7fc2b-0a15-40a3-96be-9220ac648f61`, exit 0):

- **Gate.** `pnpm typecheck`; `pnpm test` (9,623 PASS lines, 0 FAIL); `verify-context-offload.ts` 51/0; `verify-task-wake.ts` 139/0; `pnpm build`; `git diff --check`.
- **Revert control.** `task-terminal-delivery.ts` and `runtime.ts` from `e2a5cee` against the new tests gave 112 passed / 9 failed. All nine failures are offload checks or call-count knock-ons: the offloaded wait woke, a request carried its notification, and the list-preview job woke. The source was restored and the tree was clean.

Original plan: In the parent runtime (`src/agent/runtime.ts`), register one `AfterToolCallEvent` hook at `HookOrder.SDK_FIRST`. It runs before the SDK `ContextOffloader`'s default-order hook, the same precedent as the cloud-memory `uploadObserver.after`. It hands the original successful `bash` result to `TerminalDeliveryLedger` (`src/agent/task-terminal-delivery.ts`) as candidate terminal task ids, keyed by `toolUseId`. The existing stream-side `observe` then resolves each candidate:

- a result that reached the stream unchanged counts exactly as today;
- a result the offloader replaced commits a candidate id only when the model-visible replacement text contains that exact task id, so `list`/`status` snapshots beyond the preview stay unsuppressed.

Pending state still commits only on `endTurn`; cancelled or failed turns forget it; observation stays synchronous and non-throwing, and child runtimes are unchanged. Do not add `bash` to `excludeTools`, do not parse preview prose for state, and do not reimplement or reorder the offloader.

Acceptance:

- In `spike/verify-task-wake.ts`, use a real `ContextOffloader` with a small `maxResultTokens`. A terminal `wait` whose result is offloaded, inside a completed turn, produces no later wake turn and no model request carrying its notification.
- Controls: a non-offloaded wait behaves as before; a cancelled turn still wakes; an offloaded `list` whose preview omits a job id still wakes for that job; an unrelated tool, `execute`, and error results contribute nothing.
- Revert control: restore the pre-change ledger at an explicit SHA and show the new offload checks fail.
- Run `pnpm typecheck`, `pnpm test`, `verify-context-offload.ts`, `verify-task-wake.ts` and `pnpm build`.
- Sync the "Background-task wake" and "Durable context offload" sections of `docs/architecture/load-bearing-decisions.md`, and the user-guide wake sentence if its wording changes.

### Notes / blockers / abandonment reason

Evidence: in source session `session-20260925-083010463`, nine `wait` calls returned `reason: "terminal"` in completed turn 1.

- The six that stayed a `json` block (seq 62, 171, 186, 203, 357, 451) never woke.
- The three that the offloader replaced with one `[Offloaded: …]` text block each woke once: seq 131 → wake seq 483, seq 329 → seq 489, seq 425 → seq 495. The waste was three full-context turns: 454,106 cacheRead, 1,225 output, 20,846 ms.
- Mechanism: `ContextOffloader._handleToolResult` assigns `event.result = replacement` at default hook order. The yielded event reaches `terminalDelivery.observe`, and `resultPayload`'s `JSON.parse` fails on the preview.
- Running the repository's `terminalTaskIdsInToolResult` on the stored originals under `offload/offloader/` returns each task id; on the recorded previews it returns `[]`.
- The previews do begin `"reason": "terminal"` plus the task id, so the model had seen the terminal fact. Suppression is semantically correct here.

This is distinct from SRF-033, whose `$value` fix does not touch offloaded results. Score = 2×4+5+5−2−2 = 14, above gate 6. No dependency; implement first.

Paused 2026-09-25: started as `9a386ac`; its child (`session-20260925-125304677`, task `bg-b3aba44c-47fc-4de1-86eb-a1a2490d2fdd`) was stopped during read-only exploration with no file change or commit, because the user directed SER-101 to be implemented first. Returned to `not-started`; resume after SER-101 closes.

Resumed 2026-09-25 after SER-101 was accepted (`bd47afd`, closure `5a1da2f`).

## SRF-037 — Order bounded metadata before unbounded log text in background-bash results, so an offload preview still shows state, exit code and `hasMore`

- Status: `in-progress`
- Priority: 138
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`reflection_2026-09-25_session-20260925-083010463.md`](../../reflections/reflection_2026-09-25_session-20260925-083010463.md)

### Implementation / acceptance evidence

Not implemented.

In `src/tools/background-bash.ts`, change only the order of object keys. Values, types and the tool schema stay the same.

- Every `wait` result becomes `{ reason, status, output, …instruction }`: the snapshot (`state`, `exitCode`, `signal`, …) comes before the aggregated output.
- Every output result (`readOutput`, `output` mode, and the `output` inside `wait`) becomes `taskId, startOffset, endOffset, hasMore, outputPath, output`.

Nothing is truncated or dropped, and the ledger and every consumer continue to read by key.

Acceptance:

- A real-tool test in `spike/verify-background-bash.ts`: a finished job whose log exceeds the offload threshold. `JSON.stringify(result, null, 2)` places `"state"`, `"exitCode"` and `"hasMore"` within the first 1,000 tokens' worth of characters.
- An SDK `ContextOffloader` preview of that result contains them.
- Existing assertions are updated only where they pinned key order.
- After SRF-036 lands, its offloaded-wait suppression checks still pass against the reordered payload.
- Run `pnpm typecheck`, `pnpm test`, `verify-background-bash.ts`, `verify-task-wake.ts` and `pnpm build`.

### Notes / blockers / abandonment reason

Evidence: in source session `session-20260925-083010463`, the three offloaded child waits (seq 131, 329, 425) show 4,500-character previews containing `reason`, `taskId` and the start of the log, but no `"state"` and no `exitCode`. The source confirms why: `finishTerminalWait` returns `{ reason, output, status }`, and `readOutput` puts `output` before `hasMore`.

After each wait the Host issued a `bash output` call that returned empty with `hasMore: false` (seq 136, 334, 430; seq 137: "The output is fully drained"). Those three rounds cost 302 output, 309,008 cacheRead and 7,438 cacheWrite tokens (modelCall seq 133, 331, 427). That the reads were caused by the hidden `hasMore`/state is inferred from the seq 137 text, hence Evidence 4.

Score = 2×3+4+4−2−2 = 10, above gate 6. It follows SRF-036 so SRF-036's coverage can prove suppression survives the reorder; there is no hard functional dependency.

## SRF-038 — Record a successful `/model` change in the trajectory, so a session's recorded model matches the model that actually ran

- Status: `not-started`
- Priority: 139
- Score: 9
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 3
- Risk: 2
- Origin report: [`reflection_2026-09-25_session-20260925-083010463.md`](../../reflections/reflection_2026-09-25_session-20260925-083010463.md)

### Implementation / acceptance evidence

Not implemented.

When `AgentRuntime.changeModel` succeeds, append one bounded observer record through the existing recorder: `type: 'modelChanged'` with `from: { provider, model }`, `to: { provider, model }` and optional effective thinking effort. Labels are capped exactly like `spend.provider/model`. The record carries turn 0 when written outside a turn, and otherwise the ordinal of the current idle position, following the SRF-027 `contextCompacted` pattern.

- Add the type to `TrajectoryRecordType` and the schema readers.
- `formatReplay`/`replayRecords` print one line for it.
- The spend/run labels that `spend.ts` derives from `runStarted` use the latest `modelChanged` for later records.
- A failed or refused switch writes nothing.
- `runStarted` stays byte-identical and existing files stay readable.
- No model call, network or SDK-loop change.

Acceptance:

- A free test that drives `changeModel` on a real runtime with a recorder: exactly one record with the right from/to, and replay shows it.
- A failed factory writes none.
- An old trajectory without the type replays unchanged.
- Label capping holds for hostile labels.
- Re-run `spike/verify-model-command.ts` (free mode), `verify-trajectory.ts`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
- Sync the "Session trajectory" decision section.

### Notes / blockers / abandonment reason

Evidence: in source session `session-20260925-083010463`, `runStarted` (seq 0, 08:30:13Z) records `openai / global.openai.gpt-6-astra`. All 77 `modelCall` records (from seq 5) and all four `turnEnded.spend` objects record `bedrock / global.anthropic.claude-opus-5-5`.

`AgentRuntime.create` writes `runStarted` from `config` at construction; `changeModel` swaps `agent.model` and writes no record; no record type exists for it. `~/.darwin/config.json` now enables only the `claude-opus-5.5` entry, which is what `/model` persists. A pre-prompt switch in the 28 s before seq 1 is the consistent explanation, but it is inferred, hence Evidence 4. Replay's run header and the reflection template's "model / provider from runStarted" both mislabel such a session.

SER-101 also edits `changeModel` (reasoning provenance). This observer write is orthogonal to it, and neither depends on the other. Score = 2×3+4+4−3−2 = 9, above gate 6.

## SRF-039 — Pin developer-skill negative controls to explicit commit SHAs and check for foreign commits first

- Status: `not-started`
- Priority: 140
- Score: 10
- Importance: 2
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 1
- Risk: 1
- Origin report: [`reflection_2026-09-25_session-20260925-083010463.md`](../../reflections/reflection_2026-09-25_session-20260925-083010463.md)

### Implementation / acceptance evidence

Not implemented.

Add one short rule to the acceptance guidance in `src/skills/builtin/developer/SKILL.md`, domain-neutral and without naming any specific suite:

- when a child is drained, resolve its base and result commits to explicit SHAs;
- before any revert/negative control or diff review, run `git log <base>..HEAD` and name any commit the child did not make;
- controls and diffs use those SHAs, never `HEAD~N` or bare `HEAD`.

Acceptance:

- One `spike/verify-skills.ts` assertion pins the rule text.
- Skill shape/size checks stay green.
- Run `pnpm typecheck`, `pnpm test` and `pnpm build`, so the installed built-in skill refreshes.

### Notes / blockers / abandonment reason

Evidence: in source session `session-20260925-083010463`, another writer's commit `4cf69f4` (09:20:21, SER-101 queueing) landed after the SRF-033 child's `48c1b8c` (09:16:29). The Host's control at seq 181 checked out `HEAD~1`, which was then the fix itself, and passed 106/0 (seq 186).

The Host noticed only via an incidental `git log` at seq 192, and reran with explicit SHAs (seq 198 → 203: `--- 96 passed, 10 failed ---`). It then checked for concurrent commits ad hoc (seq 341, 436). The skill currently contains neither "negative control" nor "concurrent". The observed cost was small (61 s, two rounds), but the failure mode is false acceptance evidence.

Score = 2×2+4+4−1−1 = 10, above gate 6. No dependency; queued last.
