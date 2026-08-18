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
pnpm start            # run the TUI here; --resume reopens the last session, --session <id> names one
pnpm dev-repl         # readline fallback driver for debugging without Ink
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
`spike/verify-tui.ts recallEmpty` and `spike/verify-tui.ts mcp` make no model calls at all, so all
nine are free to run;
`completion` is the scenario to re-run after touching the built-in slash commands, since the menu row
count (`MAX_COMPLETIONS`) has to keep every built-in visible, `pathCompletion` is its `@`
counterpart, `recall` is the one that keeps `Up`/`Down` shared between the menu, the cursor and
prompt history (its history is seeded straight into a trajectory record, which is why it costs
nothing), and `mcp` proves the `/mcp` report over a real broken-plus-healthy server pair with
in-repo fixtures only.

There is no mock-based test layer: verification is real pty sessions, real files, real model
calls. `spike/` is the test suite, not scratch space.

## Architecture — the load-bearing decisions

**Everything reuses the SDK; the agent loop is never forked.** `src/agent/runtime.ts` is the
only place that constructs `Agent`, and it stays a thin assembly. All customization goes
through SDK extension points: interventions (permissions), plugins (skills), conversation
manager. If a change seems to require intercepting the loop itself, check
`.trellis/spec/backend/strands-sdk-contracts.md` first — every non-obvious SDK behavior this
project relies on (and the runnable script that proves it) is recorded there.

**A session's identity is fixed at `Agent` construction, so `/clear` builds a successor rather
than resetting anything** (`AgentRuntime.startNewSession`, spec:
`backend/strands-sdk-contracts.md` + `backend/session-trajectory.md`): `SessionManager` is an SDK
plugin whose snapshot hooks are registered during `initialize()` with no removal path, so a second
manager on the same `Agent` would let the retired one overwrite the *previous* session's snapshot
with the cleared conversation. The successor therefore goes through the same `create()` factory
(`session: { kind: 'new' }`) and the predecessor is *retired*, not shut down — the split is the
contract: the live config, the connected MCP clients and the `BackgroundBashManager` are handed
over because they belong to the process, while the session manager, trajectory recorder,
diagnostics log, offload storage, skills plugin, permission gate, dispatch registry, usage meter
and message history are all rebuilt, which is what stops the old session's numbers leaking into
the new one. Nothing on disk is deleted, moved or rewritten and the resume pointer is deliberately
*not* moved: an empty session has no snapshot to resume, so `markResumable()`'s invariant (an
unused session never displaces a useful one) keeps `--resume` on the conversation the user just set
aside until the new one has finished a turn. `cli.ts` still owns lifecycle — it tracks the live
runtime so exit reaps exactly one. Required checks: `spike/verify-clear-session.ts` (in `pnpm
test`) and `spike/verify-tui.ts clear`, both free.

**Permissions** (`src/agent/permission.ts`): a `PermissionGate extends InterventionHandler`
classifies each tool call by `(toolName, input)` — not name alone, because `fileEditor` spans
read and write in one tool — and unknown tools (all MCP tools) fail closed as `execute`.
`plan` mode is enforced before risk, allow rules, classifier, bridge, and configured Pre hooks:
reads proceed, while writes/executes deterministically deny. The same composed intervention
protects child agents. Denial uses `InterventionActions.deny(...)`, never `confirm()`. The UI
side is a `PermissionBridge` (async request → `PermissionDecision`): the Ink `PermissionQueue`
implements it today; `allowAllBridge` exists for non-interactive runs. On turn cancel,
release prompts with `denyPending()` — `close()` latches shut and silently denies everything
afterward.

**The mode is live session state, and only the user moves it** (`/mode`, `PermissionGate.setMode`,
`AgentRuntime.changePermissionMode`, spec: `backend/strands-sdk-contracts.md` § switching the
permission mode): every decision reads `gate.mode`, never the construction option, so plan entered
mid-session guards the very next call with its whole ordering intact. Three things are load-bearing.
It is **never persisted** — unlike `/effort` and `/model` this changes *enforcement*, so a widening
that outlived the process would defeat the rule that no allow-rule may cover `~/.darwin/config.json`;
a fresh process starts from configured/CLI policy, while `/clear`'s successor inherits the *live*
mode because restoring a wider startup policy is a widening nobody asked for. **No decision already
in flight is resolved under a mode that would not have asked for it**: a pending `auto` classifier
verdict is discarded and a prompt on screen or queued is withdrawn (`request.withdrawn`, an
`AbortSignal` the `PermissionQueue` honours by dropping the entry), and the call is re-decided from
the top — the race re-checks `aborted` *after* the awaited promise settles, so an answer landing in
the same tick is discarded too, and the loop is bounded at 16 restarts rather than by an argument
about human behaviour. And the header states it in **the row it already has**: `mode:` appears
exactly once, the transition and the withdrawal count go to a notice, and `spike/verify-tui.ts mode`
(free) plus `approve` are what keep the permission box on a 50-row screen.

**Wildcard allow-rules** (`src/agent/permission-rules.ts`) are the only thing that turns a
prompt into silence: a decision may carry a rule (`bash:pnpm *`, `fileEditor:src/**`, or a
bare tool name), the gate honours it from that moment on, and the *UI* persists it to
project-scoped `permissionRules.allow` in `~/.darwin/projects/<project-key>/permission-rules.json` — so a failed write costs the file, not the
session, and can be reported where the renderer is. Rules are consulted after the static
`safe` check and before the `auto` classifier (a written-down rule should save the model call
too). Three constraints are load-bearing, not incidental: a bash pattern must match every
chained segment and never matches redirection/substitution; no rule may ever cover a write to
`~/.darwin/config.json` or `.env*` (else the agent can widen its own permissions); and an exempt
call is offered no rule at all, because an offer that could never apply is a lie told in a
security prompt. **`/permissions` is the narrowing half of that lifecycle, and only ever
narrows**: it lists every live rule with its origin (`configured` from the rules file vs
`granted this session`, tracked per rule in the gate) and `revoke <n|rule|all>` removes it from
the gate *synchronously* — the live rule list is the enforcement surface, so the very next
matching call prompts again — with the file write filter-only (`removeAllowRules` writes the
loaded set minus exactly the revoked rules, so a session-granted rule that was persisted comes
out of the file too) and reported, not awaited, on the grant flow's degradation terms. It is
user-only like `/mode` (handled before the agent, above the busy check because revoking
mid-turn is the point) and has no add form at all — additions stay exclusively with the
permission prompt. Adding the twelfth built-in grew `MAX_COMPLETIONS` with it; the free checks
are `spike/verify-permissions-command.ts` (in `pnpm test`) and `spike/verify-tui.ts completion`.

**`/mcp` is a read-only projection of the MCP clients the runtime already holds, and reading
state never mutates state** (`src/mcp/registry.ts` `mcpServerStatuses`, `src/tui/mcp-format.ts`):
servers load with `continueOnError`, so one that fails to spawn contributes zero tools silently —
the report exists to *name* that, stating every configured server with its `connectionState`
(a failed one as `failed`, never omitted), a bounded tool listing (`MAX_MCP_TOOL_NAMES`, then
`… N more` — an unbounded dump is exactly the context cost peers warn about) and the config
source(s) in effect, including project-over-global overrides and an ignored root `.mcp.json`.
Two things are load-bearing. The report never calls `listTools()`, because the SDK connects
lazily inside it: tool names come from the client's `_registeredToolNames` — the set the SDK
itself populated when `agent.initialize()` registered the tools — read on `loadServersQuietly`'s
narrow private-field terms and guarded to degrade to "unavailable", never to a probe or a crash.
And there is deliberately no reconnect verb: `connect(true)` would flip the state to `connected`
while the agent's tool registry, populated once at `initialize()`, still holds nothing from that
server — a report that then said "connected" would be a lie, so a failed server is told to
restart instead. Names, counts, states and paths only — the projection must never become a
second path for tool results or server output into parent context. The thirteenth built-in grew
`MAX_COMPLETIONS` again; the free checks are `spike/verify-mcp-command.ts` (in `pnpm test`) and
`spike/verify-tui.ts mcp` / `completion`.


**Skills** (`src/skills/`): Darwin uses the official SDK `AgentSkills`/`Skill` core. A thin
adapter preserves product policy the SDK does not own: required/reserved built-ins, project-over-
global precedence, optional problem reporting, case-insensitive `/skill-name`, and the observable
safe `load_skill({name})` contract. The native `skills({skill_name})` tool stays private so the
model never sees two ways to load the same capability. Official activation owns appState and the
resource listing, explicitly capped at 20 files and three recursive levels. Before official
activation, Darwin rejects resource symlinks/outside-root resolution and caps host preflight at
200 entries because the SDK's host sandbox follows directory symlinks before applying its file cap.

**System prompt composition order is fixed** on every actual model request: base prompt →
`<project-instructions>` (AGENTS.md, `src/agent/instructions.ts`) → official
`<available_skills>` → `<working-context>` (`src/agent/working-context.ts`) → final cache point.
Official AgentSkills injects before each invocation; Darwin registers a later hook that moves that
exact catalogue TextBlock ahead of current working context and cache. Repeated/resumed invocations
remove the previous official block via persisted appState before reordering, so the catalogue is
never duplicated. The working context is the one fragment
that describes *now* rather than rules (cwd, OS, date, one-level directory listing), so it is
re-derived every run and *replaces* the known working-context TextBlock after restore. Current
snapshots carry separate base/catalogue/context blocks plus the final cache point; pre-migration
`[TextBlock, CachePointBlock]` snapshots are recognized, their stale Darwin catalogue is dropped,
and official AgentSkills injects one current catalogue on the resumed invocation. A resumed run
must never state the creating run's date as today's. The base is the only user-replaceable part
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

**Subagents are parallel, labelled, and read-heavy by design** (`src/agents/subagent-tool.ts`,
`src/agents/dispatch-registry.ts`): the SDK's default `ConcurrentToolExecutor` already races the
tool calls of one assistant message, so two dispatches in one turn overlap (measured 303ms for
two 300ms children in `spike/verify-subagents.ts`) — never set `toolExecutor`. What darwin adds
is *legibility*, because approvals cannot be parallel: hook callbacks are dispatched one at a
time by the single SDK stream loop, so prompts queue. Every `AssessedPermissionRequest` therefore
carries a required `source` resolved from `BeforeToolCallEvent.agent.id` through a narrow
resolver injected into the gate (the registry is built *before* the gate for exactly this
reason), and the prompt renders `[parent]` or `[<agent>#<dispatch>]` on the existing summary
line — a label of its own would cost the frame row the header contract forbids. Per-dispatch
state follows the accepted background-task shape (runtime-exposed manager, observer-only
subscription, bounded presentation-time projection): `listSubagentDispatches`,
`subscribeToSubagentDispatches`, `/agents`. Records hold name, task, state and timestamps only —
observability must never become a second path for child transcript into parent context. And the
parallelism is scoped to **reads**: concurrent children share one working tree with no isolation
or conflict detection, so concurrent write delegation is *not* made safe, deliberately and
documented rather than guarded.

**Session trajectory is an observer, never a participant** (`src/trajectory/`, spec:
`.trellis/spec/backend/session-trajectory.md`): every turn is appended to
`~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl` — a sibling of `background/`
and `offload/`, on by default, `trajectory: false` to switch off. The whole layer hangs off one
seam: `recordStream` sits between `agent.stream()` and the `yield` in `AgentRuntime.send`, and
records **synchronously, without I/O, and without being able to throw**, so a recording failure
cannot reorder an event or fail a turn (measured over a real stream with an identity tee, not
assumed). A turn whose stream *throws* is observed there too and its error rethrown **as the
identical object**: the record gains `turnEnded.failure` (`{ name, message, cause? }`, capped) while
the caller sees exactly what it would have with recording off, and `turnOutcome()` is the single
reading that keeps failed, cancelled, clean and abandoned turns distinguishable from the file alone —
`stopReason` is never invented for a turn the SDK gave none. Events are serialized through the SDK's
own `toJSON()` — the one projection that
cannot capture the live `Agent` — and read back through `contentBlockFromData`, because
`toJSON()` emits the *wire* shape, not the shape `turn-state.ts` reads. Three caps bound it
(8k code points per string, 64 KiB per record, 64 MiB per file) and every truncation is written
down; a failure latches, stops recording, and surfaces one notice after the turn. Bytes already
written are never rewritten: a partial trailing line is tolerated, counted and reported, never
repaired. `darwin trajectory list|search|replay|fork` reads it with **no model call and no
network** — `src/trajectory/**` constructs no `Agent` and no `Model` at all — and replay reuses
`turnReducer` so live rendering and replay cannot drift into two projections. `fork` copies bytes
(snapshot + `offload/` + the record as the fork's prefix) and never touches its source or the
resume pointer. No subagent event is recorded anywhere; child streams never pass through `send`.

**Session diagnostics are opt-in, and off means untouched** (`src/agent/diagnostics.ts`, spec:
`.trellis/spec/backend/session-diagnostics.md`): the SDK says several things *only* at `debug` —
that a request was throttled, where it placed its cache points, that native token counting fell
back to estimation — and `routeSdkLogs` discards that level. With `diagnostics: true` those lines,
plus `warn`/`error` (which still reach the renderer) and every darwin notice with its severity, are
appended to `~/.darwin/sessions/<project-key>/<session-id>/diagnostics.log`, one timestamped
`tail -f`-able line each. **Off is the default and must stay indistinguishable from before the
feature existed**: `sdk-logging.ts` installs the SDK's own literal `() => {}` for `debug`/`info`
when no tap is set (never a flag tested at 60 call sites), no log is built, no file is created, and
`withNoticeDiagnostics` returns the reducer's dispatch unwrapped. It is an observer under the
trajectory's rules plus one more: bounds are 8k code points per line, 8 MiB per session and 1 MiB of
*pending* bytes, because `logger.debug` is called synchronously from inside the SDK's stream loop —
so a firehose drops **diagnostic lines** (counted, and written into the file) and never blocks,
delays or drops a stream **event**. Reaching a bound, dropping lines and failing to write are all
stated in the file or surfaced once, never silent. Two things a later reader will otherwise get
wrong: an SDK warning appears twice on purpose (`sdk` said it, `darwin` showed it — the `source`
column is the distinction, and both dedupe mechanisms would be worse), and because the SDK's
`logger` is one process-global binding, a **subagent's** SDK output *is* in this file even though
the trajectory records no child event.

**Paths** (`src/paths.ts`): every `.darwin/` location is derived here from the CLI's cwd.
`process.cwd()` is read only in the two entry points (`cli.ts`, `dev-repl.ts`); everything
else takes an explicit `projectRoot`.

**Process exit is engineered, not assumed.** The vended bash tool's persistent shell is
reaped in `runtime.shutdown()` via direct `restart` — the tool keys shells per `Agent` in a
`WeakMap`, so a runtime retired by `/clear` has to reap its *own* shell (`retire()`) or that one
is never released and exit takes ~15s longer; session-owned background bash jobs are
reaped as whole process groups with bounded TERM→KILL cleanup plus a synchronous `exit`
fallback; and a cancelled model stream's socket has no public cleanup, so `cli.ts` arms an
unref'd 500ms `process.exit` fallback *after* shutdown completes. Don't change these paths
without re-running `spike/verify-background-bash.ts`, `spike/probe-cancel-exit.ts`,
`spike/verify-clear-session.ts`, and the `bashExit` / `cancelThenContinue` TUI scenarios.

**TUI** (`src/tui/`): Ink 7 + React 19. The Agent must be constructed with `printer: false`
or the SDK writes to stdout and fights Ink. Completed history renders through `<Static>`;
stream events map per the table in the archived MVP task's `research/spike-results.md`.
**Whatever is redrawn must fit the terminal**: Ink does not clip an over-tall live frame, it
switches to `clearTerminal` + a full transcript reprint *per render*, which is a strobing
screen and an erased scrollback (`spike/probe-live-frame-overflow.tsx` counts them: 43 clears
for a 60-line answer in 24 rows, 0 when bounded). This is a rule about *every* redrawn
participant, not just the answer: a 13-row draft in a 24-row terminal cost 2 clears per further
row with nothing streaming at all. So `src/tui/frame-budget.ts` hands out the rows — one
budget, `rows - 1 - header`, divided in a fixed priority order (prompt region, then tool panel,
then the still-arriving answer, which yields first because `<Static>` history is already
guaranteed to hold its text in full), with a share ceiling so the first served cannot take
everything and a `modal` exemption for the permission box, which blocks the loop and so is never
asked to share with the call it is asking about. Only the **header** is measured
(`useBoxMetrics`); measuring the boxes being bounded is what would oscillate. Everything else
states the rows it wants, counted — never estimated — through the same pure helpers the
components render from, because two calculations of one height is how the box lost the
`… truncated N code points` line the first time. Heights are counted in *visual rows at the
current width*: the content caps (`EXPANDED_INPUT_LINES`, `PERMISSION_DETAIL_LINES`) bound what
is read, and 4 capped logical lines measured 41 terminal rows. What is not shown is always
stated (`… N draft rows not shown`, `… N more input rows not shown`, the answer's
scrolled-out notice). Two Ink traps are load-bearing here: a row whose height must be known is
**one** `<Text>` with nested spans, never several `<Text>` children of a `<Box>` (Ink lays those
out as flex items and wraps them independently); and `useBoxMetrics` is *parent*-relative while
`useCursor` is frame-absolute, so `InputBox` is handed its parent's offset and adds the rows its
own window hides. Contract and required checks: `.trellis/spec/frontend/live-frame.md` (pty
mechanics stay in `frontend/tui-testing.md`).

**A finished answer line belongs to `<Static>`, not to the live frame** (`src/tui/turn-state.ts`):
answer text is committed to history *while the turn runs* — every complete line up to but not
including the last non-blank one — so a long answer scrolls into the terminal's own scrollback as
it arrives instead of landing in one write at the end. Measured cheaper, not dearer: 30,675 bytes
against 60,040 for a 120-line answer, because the alternative redraws the whole bounded tail on
every delta. Three things keep it honest. `<Static>` cannot be recalled, so the last non-blank
line and any trailing blank lines are held back — the assembled block trims its end, and
committing a trailing blank line made a clean answer report a divergence. The authoritative
`contentBlockEvent` still decides: it is reconciled against what was committed, a continuation
commits only the remainder, and a real disagreement is *stated* as a warning with the
authoritative text written in full (unreachable through an ordinary model, since the SDK's base
`Model.streamAggregated` assembles the block from the deltas it just yielded — so it is exercised
at the reducer). And because Ink fixes an entry's margin when it writes it, `AnswerPart`
(`whole | first | middle | last`) decides at push time which piece carries the `agent` label and
which carries the blank row below; `formatReplay` respects the same flags, or a replay prints one
`darwin>` per piece and is a different transcript from the session it replays. The tail still
matters for the shape with no finished lines — one unbroken paragraph.

**`@` in the prompt completes a workspace path, and inserts the path text — never the file's
content** (`src/tui/path-completion.ts`, spec: `.trellis/spec/frontend/prompt-completion.md`). Three
peers disagree here (Codex adds the path, OpenCode inlines the content, Claude Code autocompletes),
and taking the Codex shape is the whole security argument: with a path in the draft, file bytes still
reach the model through the gated, classified, trajectory-recorded `fileEditor` read, while inlining
would be a second route with none of that. So the module opens no file — it reads *directory
entries*, and `verify-path-completion.ts` greps it for every file-reading API to keep that true.
Four things are load-bearing. The **trigger** is one rule (an `@` reached from the cursor without
crossing whitespace, itself preceded by whitespace or the start of the draft), so `user@example.com`
never triggers; and a query matching no path draws **no menu at all**, which is what makes
`@someone` in prose harmless rather than a list of exceptions. The `@` is **scaffolding**: accepting
a file replaces the token with the plain path, accepting a directory keeps the marker (`@src/`) so
the next keystroke completes one level down. The **scan is bounded and exclusion-first** (8000
entries, 8 levels, 4000 candidates, `node_modules`/`dist`/`.git`-class names never walked, symlinks
never traversed and skipped when they leave the root — it *skips* where `resource-safety.ts`
throws, because fewer menu rows must never stop somebody typing), and it is **async, cached per
root, and never awaited by a keystroke**: measured 33ms per scan of this repository, 0.32ms per
keystroke of matching, 0.1ms worst event-loop lag during a scan. And the second source must not make
the first ambiguous: `computeCompletions` is untouched and wins whenever it has candidates, the menu
shares one `MAX_COMPLETIONS`, and a bounded or degraded scan is stated as a **suffix of the title
row the menu already has**.

**`Up`/`Down` recall previous prompts, read out of the record darwin already keeps — and they take no
key that already had a meaning** (`src/trajectory/prompt-history.ts`, `src/tui/prompt-recall.ts`,
spec: `.trellis/spec/frontend/prompt-recall.md`). There is no history store and there must never be
one: every prompt a session sent is already a `userInput` line in
`~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl`, so this is a *reader* over bytes
that exist, proved read-only by hashing every record and the resume pointer before and after,
grepping the module for write APIs, and reading with the AWS environment sabotaged. Four things are
load-bearing. The **binding** is enforced by position, not by a predicate: the completion menu's
`Up`/`Down` branches run first (so recall is unreachable with a `/` or `@` menu open), recall then
fires only from an **empty draft** — or from the first visual row of a draft that *is* an open walk —
and everything else falls through to `moveVertical`, which is what makes it *incapable* of replacing
typed text and why no stashed draft exists. **History is what was sent**: local commands never reach
`AgentRuntime.send` and so are absent, and a skill expansion (recorded expanded) is excluded by a
4000-code-point cap set deliberately *below* the record's own 8000 field cap, because offering back a
prompt this file truncated would mean silently re-sending a shortened one. The **read is bounded and
never awaited by a keystroke**: 256 KiB *tails* of at most 20 records ordered by mtime, 100 entries
kept, consecutive duplicates collapsed, started by the first `Up` and re-read when a turn ends —
measured 2.6ms for 20 records with 0.00ms worst event-loop lag. And **absence is an answer**:
`trajectory: false`, a damaged line and a first run each read as "no history" with a usable editor,
stated on the one row recall draws (`history 3/12 · ↑ older ↓ newer — newest 100 of 137`), which is
counted through `promptBoxWanted`/`planPromptBox` like every other row and never a header line. Free
checks: `spike/verify-prompt-recall.ts`, `spike/verify-tui.ts recall` / `recallEmpty`.

## Project conventions worth knowing before editing

- Deep documentation lives in `.trellis/spec/` — `backend/strands-sdk-contracts.md` (SDK
  contracts), `backend/error-handling.md` (`ConfigError` boundary + per-domain degradation
  table: what refuses to start vs. what skips-and-surfaces), `frontend/tui-testing.md` (how
  to write pty tests: anchored waits, idle detection, state-exclusive assertion strings,
  `exitedWithin` not `exited`). Read the relevant one before changing that area.
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

<!-- TRELLIS:END -->