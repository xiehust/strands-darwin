# AGENTS.md

This file provides guidance to Agent when working with code in this repository.

## What this is

**darwin** — a TUI coding agent built on `@strands-agents/sdk` (Strands TypeScript SDK) and Ink.
It runs inside a target repository and resolves all project state against its **working
directory**: `~/.darwin/config.json` (model/provider), `~/.darwin/skills/` plus project `.darwin/skills/`, globally stored project-keyed sessions,
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
pnpm start            # run the TUI here; --resume reopens the last session, --resume <id>/--session <id> a named one
pnpm dev-repl         # readline fallback driver for debugging without Ink
pnpm tsx src/cli.ts sessions             # resumable sessions: id, age, first prompt; read-only, no model call
pnpm tsx src/cli.ts trajectory list      # recorded sessions; search|replay|fork read them, no model call
```

Model-calling suites are run individually (they hit Bedrock via the EC2 instance role; use
inference-profile model ids, never bare `anthropic.*`):

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts            # full pty-driven TUI suite
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve    # single scenario (approve|deny|alwaysAllow|completion|agents|bashExit|cancelThenContinue|agentsMd|usage|effort|mode|model|longAnswer)
AWS_REGION=us-west-2 pnpm tsx spike/acceptance-e2e.ts        # end-to-end: real git repo, fix a bug, prove it
AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts       # agent core / permissions / resume
AWS_REGION=us-west-2 pnpm tsx spike/verify-prompt-cache-live.ts  # cache tokens written on turn 1, read on turn 2
AWS_REGION=us-west-2 pnpm tsx spike/verify-thinking-live.ts   # effort levels the service really accepts, and that high reasons
pnpm tsx spike/verify-mantle-live.ts                          # openai.* over Bedrock Mantle: tool calls, multi-turn, live /effort
pnpm tsx spike/probe-mantle-catalog.ts us-east-1 us-west-2    # which models Mantle actually serves, per region
pnpm tsx spike/verify-model-command.ts --live                  # /model: switch provider mid-session, conversation intact
pnpm tsx spike/probe-model-switch.ts                          # what survives handing a conversation to another provider
pnpm tsx spike/probe-live-frame-overflow.tsx [--bounded]       # what an over-tall live frame costs: whole-screen clears per render
```

`spike/verify-model-command.ts` without `--live`, `spike/verify-tui.ts model`,
`spike/verify-tui.ts mode`, `spike/verify-tui.ts clear`, `spike/verify-tui.ts completion`,
`spike/verify-tui.ts pathCompletion`, `spike/verify-tui.ts recall`,
`spike/verify-tui.ts recallEmpty`, `spike/verify-tui.ts bang`, `spike/verify-tui.ts queue` and
`spike/verify-tui.ts mcp` make no model calls at all, so all eleven are free to run;
`completion` is the scenario to re-run after touching the built-in slash commands, since the menu row
count (`MAX_COMPLETIONS`) has to keep every built-in visible, `pathCompletion` is its `@`
counterpart, `recall` is the one that keeps `Up`/`Down` shared between the menu, the cursor and
prompt history (its history is seeded straight into a trajectory record, which is why it costs
nothing), `bang` proves a real `!` command runs, streams and records without the model, `queue`
proves the SER-027 prompt queue (listing, `Up` take-back, cancel return, `/clear`-family refusal)
against a `!` busy state, and `mcp`
proves the `/mcp` report over a real broken-plus-healthy server pair with in-repo fixtures only.

There is no mock-based test layer: verification is real pty sessions, real files, real model
calls. `spike/` is the test suite, not scratch space.

## Architecture — the load-bearing decisions

Index only. Each row is the invariant you must not break; the full rationale for every entry
lives in `docs/architecture/load-bearing-decisions.md` under a heading of the same name, and a
cited spec (paths relative to `.trellis/spec/`) is the authoritative contract — **read the doc
section and spec before changing that area**. In the checks column, `tui <name>` means
`spike/verify-tui.ts <name>` and a bare filename lives under `spike/`; `†` marks suites already
in `pnpm test`. All checks listed here are free (no model call) unless marked *live*.

| Decision (doc §) | Load-bearing invariant | Code | Spec / checks |
| --- | --- | --- | --- |
| SDK reuse — the agent loop is never forked | Only `runtime.ts` constructs `Agent`, as a thin assembly; customize via SDK extension points (interventions, plugins, conversation manager), never by intercepting the loop | `src/agent/runtime.ts` | `backend/strands-sdk-contracts.md` |
| Stream interruption — one driver-owned continuation | Only exact `ModelError: Stream ended without completing a message` gets one visible successor turn; original error/failed record stay intact, continuation uses bounded private anti-repeat input through ordinary orchestration, never runtime/SDK-loop retry | `src/agent/stream-resumption.ts`, TUI/headless drivers | `backend/strands-sdk-contracts.md`, `backend/session-trajectory.md`, `backend/structured-headless-output.md`; `verify-stream-resumption.ts`†, `verify-headless-structured.ts`† |
| `/clear` — a successor runtime, never a reset | Successor via the same `create()` factory; predecessor retired, not shut down (process-owned state handed over, session-scoped state rebuilt); disk and resume pointer untouched until the new session finishes a turn | `AgentRuntime.startNewSession` | `verify-clear-session.ts`†, `tui clear` |
| Permissions — the gate | Classifies by `(toolName, input)`, unknown tools fail closed as `execute`; `plan` denies writes before everything else; `deny(...)`, never `confirm()`; the same intervention protects child agents; cancel = `denyPending()`, `close()` latches shut | `src/agent/permission.ts` | `backend/strands-sdk-contracts.md` |
| Permission mode — live session state | User-only, never persisted; `/clear` inherits the live mode; on switch, in-flight prompts/verdicts are withdrawn and re-decided from the top (bounded at 16); `mode:` stated once in the existing header row | `PermissionGate.setMode` | `tui mode`, `tui approve` (*live*) |
| Wildcard allow-rules and `/permissions` | Rules sit after `safe`, before the `auto` classifier; a bash pattern must match every chained segment, never redirection/substitution; no rule may cover `~/.darwin/config.json` or `.env*`; `/permissions` only narrows — revoke is synchronous, additions stay with the prompt | `src/agent/permission-rules.ts` | `verify-permissions-command.ts`†, `tui completion` |
| `/mcp` — a read-only projection | Never calls `listTools()` (names come from `_registeredToolNames`, degrade to "unavailable"); no reconnect verb; names, counts, states and paths only — never a second path for tool output into context | `src/mcp/registry.ts`, `src/tui/mcp-format.ts` | `verify-mcp-command.ts`†, `tui mcp` |
| `/export` — the replay projection | Body is `formatReplay(replayRead(...))` byte for byte, never a second formatter; observer rules (no repair, no pointer moves); refuses existing targets (`wx`) and `~/.darwin/sessions/`; nothing-to-export is a notice, never an error | `src/trajectory/export.ts` | `verify-export-command.ts`†, `tui completion` |
| `/status` — the consolidated projection | A formatter over existing accessors, never a new information channel: byte-zero mutation (no connect, no write, no pointer move); unknown metrics `not reported`, never 0 (`usageBuckets`); lists bounded at `MAX_STATUS_NAMES` + `… N more`; header's own cache/effort/mode renderers shared, so the surfaces cannot diverge; transcript history only — no new frame row | `src/tui/status-format.ts` | `verify-status-command.ts`†, `tui completion` / `mcp` |
| `/help` — bounded local discoverability | Pure projection of canonical built-in names/descriptions plus fixed prompt/key facts; handled before busy queueing, rejects arguments locally; one bounded transcript notice, never model/tool/network/config/session work or a new live-frame surface | `src/tui/help-format.ts` | `verify-help-command.ts`†, `tui completion` |
| Context pressure — advise, never auto-compact | Post-turn only, through `contextEstimate()` + the existing configurable `contextWarnRatio` latch and `<Static>` notice; one bounded `/compact` recommendation per known-window crossing, re-arm only after a known drop, fresh on `/clear`; unknown/failed estimates are silent; no second threshold, mutation, timer/channel or live row | `src/tui/context-format.ts`, `src/tui/App.tsx` | `backend/strands-sdk-contracts.md`, `frontend/live-frame.md`; `verify-context-format.ts`† |
| `darwin sessions` and `--resume <id>` — resume by choice | Listing is a read-only projection of the snapshot store (no SDK import, no write API, store byte-identical); rows are only what `--resume <id>` can reopen — absence reads `(not recorded)`, skips are stated; a bogus/other-project id is a refusal, never a fallback; bare `--resume` grammar unchanged | `src/cli-sessions.ts`, `src/agent/session.ts` | `backend/strands-sdk-contracts.md` § Sessions; `verify-sessions-command.ts`† |
| Resumed-session human recap | Restored interactive sessions read the exact trajectory and show only a bounded last-completed request/answer as startup `<Static>` history; missing/disabled/damaged/omitted state is explicit; no model call, synthetic message, file mutation or pointer move; fresh/headless unchanged | `src/trajectory/resume-recap.ts`, `src/cli.ts`, `src/tui/App.tsx` | `backend/session-trajectory.md`, `backend/strands-sdk-contracts.md` § Sessions, `frontend/live-frame.md`; `verify-resume-recap.ts`†, `tui resume` |
| Extension layers | Skills/agents/commands: built-in reservation → project `.darwin` → project `.agents` → global `.darwin` → global `.agents`; hooks merge global-to-project Pre and exact reverse Post; active hook files fail closed and hook paths are un-ruleable | `src/paths.ts`, resource loaders, `src/config.ts` | `backend/strands-sdk-contracts.md`, `backend/error-handling.md` |
| Skills | Official `AgentSkills` core + thin policy adapter; the native `skills()` tool stays private; root/nested symlinks are allowed only within the resolved real skill root, with the 200-entry preflight and use-time recheck | `src/skills/` | doc § |
| System prompt composition | Fixed order: base → `<project-instructions>` → `<available_skills>` → `<working-context>` → cache point; catalogue reordered and never duplicated; working context re-derived every run — a resumed run never states a stale date | `src/agent/system-prompt.ts`, `src/agent/working-context.ts` | doc § |
| Prompt caching | On by default, Claude only (the gate avoids SDK `console.warn` into the Ink frame); stated on the model line, never a header line of its own | `src/agent/prompt-cache.ts` | `tui approve` (*live*) |
| Thinking effort | Always `adaptive` (`output_config.effort`, never nested in `thinking`, never `budget_tokens`); unsupported levels clamped and reported, never sent; `/effort` uses `Model.updateConfig()` — the conversation survives | `src/agent/thinking.ts` | acceptance matrix in `backend/strands-sdk-contracts.md`; `verify-thinking-live.ts` (*live*) |
| Subagents | Never set `toolExecutor` (SDK already races one message's calls); every permission request carries `source`, rendered on the existing summary line; records never carry child transcript; parallelism is for **reads** — concurrent write delegation is documented unsafe | `src/agents/subagent-tool.ts`, `src/agents/dispatch-registry.ts` | `verify-subagents.ts` (*live*) |
| Session trajectory | Observer, never participant: bounded `userInput` barrier is durable before invocation and degrades open; later `recordStream` observation stays synchronous/no-I/O/non-throwing; stream errors remain identical; caps stated, bytes never rewritten; CLI readers make no model call/network; no subagent event recorded | `src/trajectory/`, `AgentRuntime.send` | `backend/session-trajectory.md`, `backend/strands-sdk-contracts.md`; `verify-trajectory.ts`† |
| Session diagnostics | Opt-in; off is indistinguishable from before the feature existed (SDK's literal `() => {}` installed, no file created); a firehose drops diagnostic lines (counted), never stream events | `src/agent/diagnostics.ts` | `backend/session-diagnostics.md` |
| FileEditor recovery | Exact `str_replace` miss stays an error and zero-write; SDK-private bounded exact-seed search may return only advisory current context (≤5 numbered rows, ≤240 code points/row), deterministic earliest tie, explicit absence/cap, never fuzzy mutation | pinned SDK patch, `spike/verify-file-editor.ts` | `backend/strands-sdk-contracts.md` |
| Paths | Every `.darwin/` location derived from the CLI's cwd here; `process.cwd()` only in `cli.ts` / `dev-repl.ts` | `src/paths.ts` | doc § |
| Process exit | Each runtime reaps its own persistent shell (`retire()` on `/clear`); foreground calls serialize per Agent, exit 0 returns captured output + restart notice, nonzero/signal stays failure; background jobs reaped as process groups (TERM→KILL); bounded `wait` shares the cursor, with opt-in terminal-focused aggregation; unref'd 500ms exit fallback | `runtime.shutdown()`, SDK patch, `cli.ts` | `verify-background-bash.ts`, `probe-cancel-exit.ts`, `verify-clear-session.ts`†, `tui bashExit` / `cancelThenContinue` (*live*) |
| TUI — the frame budget | `printer: false`; whatever is redrawn must fit the terminal; one budget in fixed priority with a share ceiling and a `modal` exemption; only the header is measured, everything else *counts* its visual rows; what is not shown is stated; one `<Text>` per counted row | `src/tui/frame-budget.ts` | `frontend/live-frame.md`, `frontend/tui-testing.md` |
| The busy rows | Elapsed + token suffix on the existing one-`<Text>` truncate-end rows — no new row, tick source, or channel; unreported metric absent, never 0; readout stops with the turn | `src/tui/busy-suffix.ts` | `frontend/live-frame.md`; `verify-busy-suffix.ts`†, `tui usage` (*live*) |
| File-edit diffs | Diff of the tool *input*, never read from disk; `- `/`+ `/`  ` markers survive ANSI stripping and reconstruct old/new exactly; approving writes the untruncated input; tone scoped to `fileEditor`; finished rows (`<Static>`, written once) show the complete diff in both modes — only live surfaces (active panel, permission box) stay bounded; `+N -N` stat and intraline bold are marker-derived enhancements — never in `summary`, which replay prints verbatim | `src/tui/edit-diff.ts` | `frontend/tui-testing.md`; `verify-edit-diff.ts`†, `verify-visual-language.tsx`† |
| Streaming answers into `<Static>` | Complete lines committed while the turn runs; last non-blank + trailing blanks held back; the authoritative `contentBlockEvent` reconciles, divergence is stated; `AnswerPart` decides labels at push time and `formatReplay` respects the same flags | `src/tui/turn-state.ts` | doc § |
| Markdown styling | A projection, never a rewrite: every character kept, markers dimmed in place; ANSI-stripped output *is* the committed text and `/export` stays byte-identical; fence state is one boolean decided at push time; answers only | `src/tui/markdown.ts`, `src/tui/MarkdownText.tsx` | `frontend/live-frame.md`; `verify-markdown.tsx`†, `verify-visual-language.tsx`† |
| `@` path completion | Inserts the path text, never file content — the module opens no file (grepped for read APIs); bounded, exclusion-first, cached async scan never awaited by a keystroke; no-match draws no menu; `computeCompletions` wins when it has candidates | `src/tui/path-completion.ts` | `frontend/prompt-completion.md`; `verify-path-completion.ts`†, `tui pathCompletion` |
| Prompt recall | A reader over the session's `userInput` trajectory lines — no history store, ever; fires only from an empty draft (or an open walk's first row), after the menu and the queue take-back (SER-027) have passed, everything else falls through; only *sent* prompts, entries over 4000 code points excluded; absence is an answer | `src/trajectory/prompt-history.ts`, `src/tui/prompt-recall.ts` | `frontend/prompt-recall.md`; `verify-prompt-recall.ts`†, `tui recall` / `recallEmpty` |
| `!` shell commands | User-authorized, never through the gate (its subject is model tool calls) — runs in every mode including plan; one-shot `bash -c` process group with TERM→KILL timeout/cancel, never the runtime's persistent shell; one bounded projection (SER-009 vocabulary, under the record's field cap) feeds transcript row, `shellCommand` record and the report prepended to the *next* prompt; mid-turn it queues like a prompt (SER-027) and runs at drain time; live output borrows the tool panel — no new frame surface; never a `userInput` line, so recall never offers it; replay prints it via the same reducer | `src/tui/shell-command.ts` | `frontend/live-frame.md`, `backend/session-trajectory.md`; `verify-shell-command.ts`†, `tui bang` |
| The prompt queue | Supersedes SER-010 by explicit user decision (2026-08-19): busy submissions queue — listed as counted budget rows (after tools, floor 0), counted on the busy hint; drained one entry per idle through the ordinary `submit()` path (next-turn-only, never mid-stream injection); `/clear`/`/compact`/`/model`/`/exit`/`/quit` refuse instead; `Up` from the first draft row takes the queue back (menu > take-back > recall); cancel/failure returns it unsent, permission pending holds it, `/clear` drops it; recorded only at send time | `src/tui/prompt-queue.ts`, `src/tui/QueuedMessages.tsx` | `frontend/live-frame.md`, `frontend/prompt-recall.md`; `verify-prompt-queue.ts`†, `tui queue` / `bang`, `tui usage` (*live*) |

## Project conventions worth knowing before editing

- Deep documentation lives in `.trellis/spec/` — `backend/strands-sdk-contracts.md` (SDK
  contracts), `backend/error-handling.md` (`ConfigError` boundary + per-domain degradation
  table: what refuses to start vs. what skips-and-surfaces), `frontend/tui-testing.md` (how
  to write pty tests: anchored waits, idle detection, state-exclusive assertion strings,
  `exitedWithin` not `exited`). Read the relevant one before changing that area.
- Adding a built-in slash command must grow `MAX_COMPLETIONS` with it, so the menu keeps every
  built-in visible — re-run `spike/verify-tui.ts completion` (free) after touching them.
- Keep this file under 32 KiB: darwin preloads only the first `MAX_INSTRUCTIONS_BYTES` of it
  into its own system prompt, so anything past the cap is silently invisible to the agent.
  Long-form architecture rationale goes to `docs/architecture/load-bearing-decisions.md`.
- This repo is Trellis-managed (see `AGENTS.md`): non-trivial work goes through a task under
  `.trellis/tasks/` with PRD → implement → check → spec update → commit.
- Every `/developer` (developer-skill) supervision run must append its batch record to
  `docs/iteration-log.md` before reporting completion — child session id, one milestone table
  row per accepted commit, and what the Host re-ran for acceptance. The log is part of the
  paper trail; README's "How darwin develops darwin" only points there.
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

