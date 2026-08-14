# AGENTS.md

This file provides guidance to Agent when working with code in this repository.

## What this is

**darwin** — a TUI coding agent built on `@strands-agents/sdk` (Strands TypeScript SDK) and Ink.
It runs inside a target repository and resolves all project state against its **working
directory**: `.darwin/config.json` (model/provider), `.darwin/skills/`, `.darwin/sessions/`,
`.darwin/mcp.json` (falls back to root `.mcp.json`, Claude Code format), plus an `AGENTS.md`
preloaded into the system prompt.

This is an experimental project in self-hosted AI development.

**v0.0.1 — the [baseline release](../../releases/tag/v0.0.1) — was built entirely with
[Claude Code](https://claude.com/claude-code).** From this point on, darwin develops
itself: every subsequent feature, fix, and release is made by running darwin inside its
own repository (the Trellis task history under `.trellis/` is the paper trail). The name
is the thesis — evolution by iteration, with the tool as its own selection pressure. The
baseline exists so there is always a fixed point to measure that evolution against.


## Commands

```bash
pnpm typecheck        # tsc --noEmit — the quality gate (no lint is configured)
pnpm test             # fast suites only, no model calls, no network
pnpm start            # run the TUI here; --resume reopens the last session
pnpm dev-repl         # readline fallback driver for debugging without Ink
```

Model-calling suites are run individually (they hit Bedrock via the EC2 instance role; use
inference-profile model ids, never bare `anthropic.*`):

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts            # full pty-driven TUI suite
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve    # single scenario (approve|deny|alwaysAllow|completion|bashExit|cancelThenContinue|agentsMd|usage|effort)
AWS_REGION=us-west-2 pnpm tsx spike/acceptance-e2e.ts        # end-to-end: real git repo, fix a bug, prove it
AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts       # agent core / permissions / resume
AWS_REGION=us-west-2 pnpm tsx spike/verify-prompt-cache-live.ts  # cache tokens written on turn 1, read on turn 2
AWS_REGION=us-west-2 pnpm tsx spike/verify-thinking-live.ts   # effort levels the service really accepts, and that high reasons
```

There is no mock-based test layer: verification is real pty sessions, real files, real model
calls. `spike/` is the test suite, not scratch space.

## Architecture — the load-bearing decisions

**Everything reuses the SDK; the agent loop is never forked.** `src/agent/runtime.ts` is the
only place that constructs `Agent`, and it stays a thin assembly. All customization goes
through SDK extension points: interventions (permissions), plugins (skills), conversation
manager. If a change seems to require intercepting the loop itself, check
`.trellis/spec/backend/strands-sdk-contracts.md` first — every non-obvious SDK behavior this
project relies on (and the runnable script that proves it) is recorded there.

**Permissions** (`src/agent/permission.ts`): a `PermissionGate extends InterventionHandler`
classifies each tool call by `(toolName, input)` — not name alone, because `fileEditor` spans
read and write in one tool — and unknown tools (all MCP tools) fail closed as `execute`.
Denial uses `InterventionActions.deny(...)`, never `confirm()`. The UI side is a
`PermissionBridge` (async request → `PermissionDecision`): the Ink `PermissionQueue`
implements it today; `allowAllBridge` exists for non-interactive runs. On turn cancel,
release prompts with `denyPending()` — `close()` latches shut and silently denies everything
afterward.

**Wildcard allow-rules** (`src/agent/permission-rules.ts`) are the only thing that turns a
prompt into silence: a decision may carry a rule (`bash:pnpm *`, `fileEditor:src/**`, or a
bare tool name), the gate honours it from that moment on, and the *UI* persists it to
`permissionRules.allow` in `.darwin/config.json` — so a failed write costs the file, not the
session, and can be reported where the renderer is. Rules are consulted after the static
`safe` check and before the `auto` classifier (a written-down rule should save the model call
too). Three constraints are load-bearing, not incidental: a bash pattern must match every
chained segment and never matches redirection/substitution; no rule may ever cover a write to
`.darwin/config.json` or `.env*` (else the agent can widen its own permissions); and an exempt
call is offered no rule at all, because an offer that could never apply is a lie told in a
security prompt.


**Skills** (`src/skills/`): the one self-built module — the TS SDK has no Skills support yet.
It's an SDK `Plugin` mirroring Python's `AgentSkills`: `load_skill` tool + progressive
disclosure (`<available-skills>` names/descriptions in the prompt), plus `/skill-name` slash
expansion in the TUI. When the SDK ships official skills, this module is designed to be
deleted.

**System prompt composition order is fixed**: base prompt → `<project-instructions>`
(AGENTS.md, `src/agent/instructions.ts`) → `<available-skills>` (skills plugin during
`agent.initialize()`). Composition is all string concatenation — the skills plugin refuses a
block-array prompt — and only after `initialize()` does `src/agent/prompt-cache.ts` wrap the
finished string as `[TextBlock, CachePointBlock]`. The base is the only user-replaceable part
(`src/agent/system-prompt.ts`: `config.systemPrompt` > `.darwin/system-prompt.md` >
`DEFAULT_SYSTEM_PROMPT`), so the project's own instructions stay additive on top of whichever
base is in effect.

**Prompt caching is on by default** (`src/agent/prompt-cache.ts`, `promptCache` /
`promptCacheTtl` in config): tools and conversation through `BedrockModel.cacheConfig`, the
system prompt through a cache point placed after `initialize()`. Claude only, and the gate is
deliberate — `strategy: 'auto'` on a model that cannot cache makes the SDK `console.warn` into
the Ink frame. The header states it on the model line, never a line of its own: the header
shares the live frame with the permission box, and one extra line pushes the box off a 50-row
terminal (`spike/verify-tui.ts approve` catches it).

**Thinking effort** (`src/agent/thinking.ts`, `thinkingEffort` in config, `/effort` at
runtime): Claude 4.6+ *adaptive* thinking, steered by Anthropic's own ladder
(`low`/`medium`/`high`/`xhigh`/`max`, default `high`) and sent as
`{ thinking: { type: 'adaptive' }, output_config: { effort } }` — `effort` nested inside
`thinking` is a `ValidationException`, not a warning. Three things are load-bearing. The mode
is *always* `adaptive`, never `enabled`+`budget_tokens`: the newest models reject the old form,
and switching modes invalidates the conversation cache breakpoint, which is what makes
`/effort` free mid-session. A level the model cannot serve is **clamped and reported**, never
sent — the service rejects it per-request, so one unsupported level breaks every turn; the
acceptance matrix is measured rather than read, because the AWS page is wrong about it (Sonnet
4.6 takes `max` and refuses only `xhigh`) and lives in
`.trellis/spec/backend/strands-sdk-contracts.md`. And `/effort` reconfigures the live model via
`Model.updateConfig()` rather than rebuilding the agent — the conversation must survive a change
of thinking depth — with the config write reported, not awaited, exactly like an accepted
allow-rule.

**Paths** (`src/paths.ts`): every `.darwin/` location is derived here from the CLI's cwd.
`process.cwd()` is read only in the two entry points (`cli.ts`, `dev-repl.ts`); everything
else takes an explicit `projectRoot`.

**Process exit is engineered, not assumed.** Two SDK leaks would otherwise hang the process:
the vended bash tool's persistent shell (reaped in `runtime.shutdown()` via a direct
`restart` invoke) and a cancelled model stream's socket (no public cleanup exists — `cli.ts`
arms an unref'd 500ms `process.exit` fallback *after* shutdown completes). Don't remove
either without re-running `spike/probe-cancel-exit.ts` and the `bashExit` /
`cancelThenContinue` TUI scenarios.

**TUI** (`src/tui/`): Ink 7 + React 19. The Agent must be constructed with `printer: false`
or the SDK writes to stdout and fights Ink. Completed history renders through `<Static>`;
stream events map per the table in the archived MVP task's `research/spike-results.md`.

## Project conventions worth knowing before editing

- Deep documentation lives in `.trellis/spec/` — `backend/strands-sdk-contracts.md` (SDK
  contracts), `backend/error-handling.md` (`ConfigError` boundary + per-domain degradation
  table: what refuses to start vs. what skips-and-surfaces), `frontend/tui-testing.md` (how
  to write pty tests: anchored waits, idle detection, state-exclusive assertion strings,
  `exitedWithin` not `exited`). Read the relevant one before changing that area.
- This repo is Trellis-managed (see `AGENTS.md`): non-trivial work goes through a task under
  `.trellis/tasks/` with PRD → implement → check → spec update → commit.
- Keep `devEngines` out of `package.json` — it makes every `npx`-launched MCP server die
  with an opaque `Connection closed`.
- pnpm's `minimumReleaseAge` may hold back very fresh `@strands-agents/sdk` releases; don't
  bypass it.
- Running darwin in this repo dogfoods it: the Trellis `AGENTS.md` gets preloaded and
  `.darwin/skills/commit-message` is a live sample skill.
<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->