# Architecture — the load-bearing decisions (full rationale)
## `.agents` extension layering

Darwin keeps one execution model while widening discovery. Named skills, agents, and commands reserve built-ins first, then select the highest valid definition from project `.darwin`, project `.agents`, global `.darwin`, and global `.agents`; invalid entries claim no name. Native command hooks aggregate lexical `hooks/*.json` sources in global `.agents` → global `.darwin` → project `.agents` → project `.darwin` Pre and lifecycle-observation order, with reverse source order only for Post. Direct global/project `.agents/hooks.json` files are an explicit second, Codex-shaped dialect ordered before each `.agents` native directory; `.codex` is never read. Dialect identity is retained through regex/glob matching, payloads, output semantics, diagnostics and process ownership. Portable context changes only the affected invocation; plan/retry/permission, direct streaming, trajectory literals and child privacy remain authoritative. Darwin legacy hook files/config are fallback-only and shadowing is reported. Hook paths are executable policy and remain dangerous and un-ruleable.

For the native Darwin dialect, `TurnComplete` and `PermissionRequest` are the only lifecycle events. They are driver/visible-prompt observations, not SDK interventions: each matching command receives one bounded closed JSON object, starts without blocking its owner, and has no output or feedback channel into terminal rendering, model context, permissions, tools, or trajectory. Session-scoped detached process groups are cancelled/reaped on turn cancel, `/clear` retirement, startup unwind, and shutdown. Keeping publication at `App.runTurn`, the headless driver, and `PermissionQueue` preserves the invariant that `runtime.ts` alone constructs `Agent` and no Darwin code forks or intercepts the SDK loop.

This is the long-form companion to the "Architecture — the load-bearing decisions" index table
in `AGENTS.md`. AGENTS.md is preloaded into darwin's own system prompt on every request and is
capped at 32 KiB (`MAX_INSTRUCTIONS_BYTES` in `src/agent/instructions.ts`), so it carries only
the index; each table row's "Decision" names the matching `##` heading here, and the complete
reasoning for each decision lives under it, verbatim. When a paragraph cites a `.trellis/spec/`
document, that spec is the authoritative contract — this file is the narrative.

## SDK reuse — the agent loop is never forked

**Everything reuses the SDK; the agent loop is never forked.** `src/agent/runtime.ts` is the
only place that constructs `Agent`, and it stays a thin assembly. All customization goes
through SDK extension points: interventions (permissions), plugins (skills), conversation
manager. If a change seems to require intercepting the loop itself, check
`.trellis/spec/backend/strands-sdk-contracts.md` first — every non-obvious SDK behavior this
project relies on (and the runnable script that proves it) is recorded there.

## SDK HTTP request — parent-only ordinary gated tool

**HTTP access is an ordinary parent tool, not a side channel.** The parent runtime directly adds
the installed SDK `httpRequest` singleton (`http_request`) to the same `Agent.tools` list as its
other vended tools. The existing composed intervention therefore runs retry policy, configured
Pre hooks, permission classification, the SDK callback, and Post hooks in their established
order. `http_request` deliberately has no safe classifier special case: unknown tools fail closed
as `execute`, so default/auto modes require the ordinary decision and plan mode denies before the
callback. Child catalogues do not include it; widening their capabilities requires a separate
design decision. Authoritative contract: `.trellis/spec/backend/strands-sdk-contracts.md`.
Required offline check: `spike/verify-http-request-tool.ts` (in `pnpm test`).

## `web_fetch` — a bounded readable projection, a sibling of `http_request`, never a wrapper

**Reading a web page is a second ordinary parent tool with a stated budget, not a change to the
raw one.** `http_request` returns the raw body unbounded, so a documentation page arrives as
hundreds of KB of HTML and is only bounded by the context offloader. `web_fetch({ url, maxChars? })`
(`src/tools/web-fetch.ts`) performs one GET with `Accept` preferring markdown, upgrades `http://`
to `https://`, follows same-host redirects (bounded hops) and *reports* cross-host ones instead of
following them, converts HTML to readable text with a dependency-free projection (headings, `- `
items, `> ` quotes, fenced `pre`, `text (url)` links, `[image: alt]`, entities decoded; `script`/
`style`/`noscript`/`template`/`svg`/`nav`/`header`/`footer`/`aside` dropped), keeps every other
text type verbatim, refuses binary bodies with type and length, stops the download at 4 MiB and
caps the body at 40 000 code points — `maxChars` may lower that ceiling, never raise it — with the
shared `[truncated: N of M code points]` notice. The result states every lossy step in `notice`.
The module builds its own `AbortSignal.any([timeout, context.cancelSignal])`; it never imports,
calls or wraps `httpRequest`, whose bytes and tests stay untouched. Classification deliberately
stays the unknown-tool fail-closed `execute` path (the URL is visible in the `Input` detail), so
`default` asks, `plan` denies before any request and allow-rules may cover it. Registration is the
parent `tools:` list next to `httpRequest`; the one `PARENT_ONLY_TOOL_NAMES` filter that already
kept `retrieve_offloaded_content` out of `childTools` now also names `http_request` and
`web_fetch` — the child-catalogue exclusion the spec and this document always stated for
`http_request` is enforced by the same mechanism instead of assumed. Authoritative contract:
`.trellis/spec/backend/strands-sdk-contracts.md`. Required offline check:
`spike/verify-web-fetch.ts` (in `pnpm test`).

## Repeated tool failures — bounded intervention guard

**One model invocation may execute three materially equivalent failed tool variants, not an unbounded sequence.** The composed SDK intervention observes original `ToolResultBlock`s after configured Post hooks without rewriting them, normalizes a bounded failure class/signature, and denies a later call to that tool before Pre hooks, permission, or body once one signature reaches the limit. A second failure injects bounded evidence-backed-hypothesis guidance before the next model call; the third says to stop, report the blocker and collected artifacts, and ask the user. A new SDK invocation replaces the state. One shared guard remains isolated by Agent, so concurrent children cannot poison each other. Explicit numeric/failed bash status is covered; user-authored `!` commands never enter this model-tool intervention. The pinned foreground bash result exposes its real command `exitCode` for this purpose without changing shell execution or output. Authoritative contract: `.trellis/spec/backend/strands-sdk-contracts.md`. Required check: `spike/verify-retry-guard.ts` (in `pnpm test`).

## Stream interruption — one driver-owned continuation

**A retryable broken provider stream becomes one visible successor turn, never an SDK-loop retry.**
`AgentRuntime.send` still exposes the original `ModelError` unchanged through `recordStream`, which
closes and appends the failed trajectory turn. The TUI and headless drivers compose
`runWithStreamResumption` around their ordinary one-turn consumers; only the exact measured
`Stream ended without completing a message` `ModelError` qualifies, and the helper can invoke one
bounded anti-repeat continuation prompt once. Because the original user request is not resent, a
model is directed to inspect retained conversation and work before acting, reducing duplicate side
effects. The busy/queue owner spans both attempts, while every attempt still gets ordinary SDK,
permission, usage, cancellation, and trajectory semantics. Headless protocols disclose that recovery
occurred without exposing the private control prompt. Authoritative contracts:
`backend/strands-sdk-contracts.md`, `backend/session-trajectory.md`, and
`backend/structured-headless-output.md`. Required checks: `spike/verify-stream-resumption.ts` and
`spike/verify-headless-structured.ts` (both in `pnpm test`).


## Clipboard image input — one transient SDK content-block invocation

**Clipboard images are live interactive input, never durable transcript content.** `Ctrl+O` reads one bounded PNG through platform clipboard helpers and the exact decoder/normalizer shared with the path-based `imageViewer` tool. The pending image is a counted one-row chip and travels with its draft or queue entry until explicit removal or actual queue/send ownership. `AgentRuntime.send` supplies text plus `ImageBlock` to the existing SDK `Agent.stream()` once; unsupported providers fail through the ordinary visible turn-error path, with no capability probe, second call, Agent construction, or loop interception.

Trajectory, replay/export, prompt recall, rewind labels, memory evidence and shell records remain text-only: image bytes, base64, clipboard contents and fabricated paths never enter them. Multimodal trajectory input is the literal user prompt, while model-only expansion/shell reports remain in the SDK content block. The authoritative contracts and free checks are `.trellis/spec/backend/strands-sdk-contracts.md`, `.trellis/spec/frontend/tui-testing.md`, `spike/verify-runtime-image-input.ts`, `spike/verify-clipboard-image.ts`, and `spike/verify-tui.ts clipboardImage`.

## Direct driver streaming

**Successful turns are public as their ordinary SDK events arrive; there is no whole-turn output
transaction.** The TUI dispatches each `AgentRuntime.send()` event directly through `streamEvent`,
so completed tools, successful `update_plan` replacements, and assistant deltas can render before
the terminal result. Text headless consumes the same stream directly, and structured headless emits
only completed post-aggregation `modelMessageEvent` text so output guardrail redaction remains the
privacy boundary. `turnEnded` alone finalizes the TUI-only checklist and clears live state. An
unfinished checklist is advisory state, not permission to start another model invocation. Exact
stream interruption remains the one bounded driver-owned continuation; max-token recovery remains
invocation-scoped. Authoritative contracts: `backend/strands-sdk-contracts.md`,
`backend/structured-headless-output.md`, and `frontend/live-frame.md`. Required checks:
`spike/verify-stream-resumption.ts`, `spike/verify-headless-structured.ts`,
`spike/verify-update-plan.tsx`, and free pty `spike/verify-tui.ts updatePlan`.

## `/clear` — a successor runtime, never a reset

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

## Durable context offload — default-on for main runtimes

**Every main `AgentRuntime` installs the SDK `ContextOffloader` unless effective config explicitly sets `contextOffload: false`.** The plugin keeps its SDK threshold and preview defaults, session-scoped `LocalFileStorage`, safe retrieval tool, and `evictAfterCycles: null`, so references remain resolvable after resume at the cost of retained session disk. `maxResultTokens` validates against that effective default: omission or explicit `true` accepts it, explicit `false` rejects the contradictory threshold. Headless `--context-offload` remains a compatible process-only force-on override and never rewrites persistent config. Child Agents keep their separate bounded final-result contract and do not inherit parent offload storage or retrieval capability.

The pinned SDK patch additionally repairs restored legacy oversized successful tool results exactly once, on the first `BeforeModelCallEvent`: after restore, before provider request cloning, through the same durable store/preview/reference code as a new result. It preserves message identity/order and tool pairing, derives delegation/retrieval exclusions from historical tool-use identity plus the live registry, verifies marker shape, tool-use-bound references, and durable entries rather than trusting spoofable marker text, leaves the original unpublished on count/store failure, and best-effort deletes successful unified-storage siblings from a failed multi-block write. Invocation autosave makes the next restore bounded. If context still overflows, all drivers use one bounded actionable projection (`/compact`, narrower retry, or `/clear`) without rewriting trajectory or structured schema v1. Required checks: `spike/verify-config.ts`, `spike/verify-context-offload.ts`, `spike/verify-context-overflow.ts`, headless parser/protocol suites, and `spike/verify-skills.ts`.

## `/rewind` — an SDK checkpoint branch, never workspace rollback

**A rewind branches authoritative conversation state into a fresh Agent; it never rewrites the source or compensates external effects.** Before editor-eligible invocations, the runtime uses bounded public SDK listings to enforce a hard 100-snapshot rewind capacity, then creates a Strands immutable snapshot only while room remains. Failed/cancelled captures consume capacity; a full cap skips later capture without blocking the ordinary turn, deleting history or hiding existing selectable points. A bounded catalogue makes only successfully completed captured prompt boundaries selectable. Acceptance revalidates the source row, creates a successor through the one `AgentRuntime.create()` factory, restores the source snapshot before dropping any historical ambient-memory block and refreshing current working context/cache, and retires the predecessor only after success. The selected prompt returns to the editor unsent, and the resume pointer stays on the source until the successor completes a turn.

Trajectory remains optional observation and is never used to reconstruct messages. Source latest/immutable snapshots, catalogue and trajectory stay byte-identical. Process-owned live permission mode, MCP clients and background jobs transfer like `/clear`; workspace files, shell and `!` effects, hooks, MCP writes, subagents, background jobs and learned-memory files are explicitly *not* rewound. This omission is part of the notice, not documentation fine print. Checks: `verify-rewind.ts`, `verify-rewind-search.ts`, and free `tui rewind`.

**Esc Esc is a second key for the same opener, never a second opener (SER-059).** Codex and Gemini CLI both bind a double Escape on an empty composer to "go back to an earlier prompt", so darwin binds it to the `/rewind` chooser — but the chooser has exactly one way to open, `openRewindChooser()` in `App.tsx`, which is the `/rewind` command body moved into a callback that the command and the chord both call. Duplicating even the three notices would have let the two surfaces drift, and the pty scenario asserts the shared path by anchoring on the command's own capacity warning and refusal wording. The chord is deliberately narrow: only an Escape that no owner consumed (permission denial, the two search modes, the completion menu and recall all sit earlier and keep their key) and that lands on an empty draft, `status === 'idle'`, an empty queue and no pending permission arms a timestamp; the key handler clears that timestamp on every key before dispatching and only the composer branch re-arms it, so nothing typed, running, queued or pending can be straddled by the chord, and two Escapes further apart than `ESCAPE_REWIND_CHORD_MS` simply start over. It is a `Date.now()` comparison rather than a `setTimeout` because the frame has no place for a "press Esc again" hint and a timer that fires with nothing to draw is a channel with no consumer. Spec: `frontend/prompt-recall.md` § `/rewind` chooser. Checks: `verify-help-command.ts`, free `tui escRewind`.

## `/compact <focus>` — the SDK default prompt plus one bounded section, built per call

**The `/compact` manager is built per call, and an unfocused call is configured exactly as before the focus existed.** `SummarizingConversationManagerConfig.summarizationSystemPrompt` is constructor-only in the SDK, so `AgentRuntime.compact(focus?)` asks `createCompactionManager(preserveRecentMessages, focus)` (`src/agent/compact.ts`) for a fresh manager every time instead of holding one for the process. Without a focus the config has the two keys it always had — `summaryRatio: 0.8` and `preserveRecentMessages` — and the SDK applies its own `DEFAULT_SUMMARIZATION_PROMPT`; the request is byte-identical to a pre-SER-051 `/compact`, and headless `--compact-before` only ever takes this path. With a focus (trimmed, at most 400 code points; longer is a local notice and nothing runs — no hook, no model call, no `compacting` state), the system prompt is the SDK default verbatim, a blank line, one fixed heading, and the focus as plain text. The focus is never parsed as a sub-command, never added to `PreCompact`/`PostCompact` payloads (`trigger: manual` unchanged), and the reasoning-block scrub inside the patched `generateSummary` covers focused and unfocused summaries alike.

The default prompt is reached only through the package root: the SDK declares it in a module its `exports` map does not expose, so the pinned `patches/@strands-agents__sdk@1.16.0.patch` gains one re-export line in `dist/src/index.js` and one in `dist/src/index.d.ts`. A copied prompt string would drift from what the SDK sends unfocused, and a deep import is unresolvable — both are refused by `spike/verify-compact.ts`, which asserts over the source. The TUI records `/compact <focus>` as it records `/compact` (one `userInput` transcript action, never `AgentRuntime.send`) and the busy refusal still matches on the first word. Spec: `backend/strands-sdk-contracts.md` § `/compact` per-call manager. Checks: `verify-compact.ts`, `verify-help-command.ts`, free `tui completion`, live `tui compacting`; after any patch change, `pnpm install --frozen-lockfile` + `pnpm typecheck`.

**The reduce loop terminates on evidence and treats a swallowed failure as failure (SER-052).** `compactConversation` used to loop `while (messages.length > preserveRecentMessages + 1)` on `reduce()`, assuming every `true` shrank the list; but the SDK summarizes at most 80% of the list (`summaryRatio` clamped to `[0.1, 0.8]`), so a 2-message history can only ever become "a summary of the oldest message plus the newest" — same count, less fidelity, forever (a Host probe made 26 paid, uncancellable summarizer calls). Now every pass keeps a shallow snapshot; a pass that returns `true` without lowering the count is undone (identity kept) and ends the loop, so `compacted` is true only when the count really dropped. The guard is observational rather than a copy of the SDK's split arithmetic, so it stays right if the SDK changes; the recorded consequence is that with `preserveRecentMessages: 0` the floor is two messages and finding it costs one summarizer call, and 2 messages / preserve 0 is an honest `already compact` after exactly one call. Separately, darwin calls `reduce()` without `error`, so the SDK's proactive path swallows any summarization error and returns `false`; inside the loop the SDK has no other `false`, so it is thrown as `SWALLOWED_SUMMARIZATION_FAILURE` and everything is restored — never `compacted: true` from an earlier pass, never a partial result. A sentinel `error` was rejected because it must be a `ContextWindowOverflowError`, the SDK writes it into the thrown error's `.cause`, and `failureFromError` would print that fabricated cause in structured headless output; the real cause already reaches the user through the routed `sdk warn` line. The bug was masked from `780ec93` until `f4e3271` scrubbed reasoning blocks from the summary: the provider rejection that used to fail the second pass had been terminating the loop by accident. Spec: `backend/strands-sdk-contracts.md` § explicit `/compact` scenario, `backend/error-handling.md`. Checks: `verify-compact.ts` (2 messages / preserve 0 → one call, no-op; 16 / preserve 0 → three calls, pass 3 undone; second- and first-pass failure reject and restore; focused manager shares both), live `tui compacting` (seeds two turns, `preserveRecentMessages: 1`, waits for a real `4 → 2`).


## Permissions — the gate

**Permissions** (`src/agent/permission.ts`): a `PermissionGate extends InterventionHandler`
classifies each tool call by `(toolName, input)` — not name alone, because `fileEditor` spans
read and write in one tool — and unknown tools (all MCP tools) fail closed as `execute`. Static
bash safety is a whitelist on the first word of every segment *and* on its arguments: a
whitelisted `find`/`git branch`/`git log|diff|show` carrying a known mutating option
(`-delete`, `-exec…`, `-D`, `--move`, `--output=…`, …) is `dangerous` with the option named
(spec: `backend/strands-sdk-contracts.md` § Static bash safety).
`plan` mode is enforced before risk, allow rules, classifier, bridge, and configured Pre hooks:
reads proceed, while writes/executes deterministically deny. The same composed intervention
protects child agents. Denial uses `InterventionActions.deny(...)`, never `confirm()`. The UI
side is a `PermissionBridge` (async request → `PermissionDecision`): the Ink `PermissionQueue`
implements it today; `allowAllBridge` exists for non-interactive runs. On turn cancel,
release prompts with `denyPending()` — `close()` latches shut and silently denies everything
afterward.

## Permission mode — live session state

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

## Wildcard allow-rules and `/permissions`

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

## `/mcp` — a read-only projection

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


## CodeGraph MCP preflight — existing indexes only

CodeGraph's semantic readers fail predictably when a target has no usable `.codegraph/codegraph.db`,
so Darwin narrows that known local failure before the remote body rather than teaching the agent to
retry it. `src/mcp/codegraph-preflight.ts` wraps only known semantic tools owned by the exact
configured `codegraph` client, after SDK discovery and before child-catalogue capture. It validates
the current root once and each safe explicit absolute target once, requiring a non-symlink regular
SQLite database whose bounded read-only bytes contain the SQLite header and CodeGraph schema
records. Unavailable targets return one bounded successful instruction to use ordinary shell/file
inspection; usable targets `yield*` the original tool unchanged. The existing SDK refresh callback is
decorated so later tool-list changes receive the same wrapping without replacing old-name removal.
This is neither an intervention nor an alternate MCP lifecycle: all
other clients/tools, permissions, startup/disconnect, `/mcp`, and parent/child policy remain as they
were. Required check: `spike/verify-codegraph-preflight.ts` (in `pnpm test`).

## Web-search zero hits — normalize only the verified provider signature

The externally supplied `web-search` MCP provider reports a completed search with no hits as an
MCP `-32602` error, making ordinary absence look like a recoverable tool failure. Darwin does not
own or replace that search service; `src/mcp/web-search-empty-results.ts` uses the runtime-owned
post-registration seam instead. It wraps only server tool `search` from the exact configured client
`web-search`, delegates first, and changes only the recorded no-results signature into successful
compact JSON preserving the query with an empty result list and zero total. Everything else —
non-empty bytes, stream events, malformed input, transport/auth/timeout and other provider errors —
passes through unchanged. Applying before child-catalogue capture and decorating the SDK refresh
callback gives parent and child agents one policy without changing permissions, hooks, retry logic,
trajectory, output, or MCP lifecycle. Required check: `spike/verify-web-search-empty-results.ts`
(in `pnpm test`).


## `/export` — the replay projection

**`/export <path>` writes this session's transcript, and the transcript is the replay projection —
never a second formatter** (`src/trajectory/export.ts`, spec: `backend/session-trajectory.md` § a
fifth reader): the body below a small commented header is `formatReplay(replayRead(...))` byte for
byte, so an export can never disagree with `darwin trajectory replay` of the same record. It is a
reader under the trajectory's observer rules — never writes to, repairs or reorders the record,
never moves the resume pointer, tolerates (and states) a partial trailing line mid-turn — and
absence is an answer on prompt recall's terms: recording off, no record file yet (no turn has
begun) and zero turns each earn a "nothing to export" notice, never an error
and never an empty file. Path handling is deliberate: relative targets resolve against the project
root, an existing target is refused atomically (`flag: 'wx'`, no `--force` — name another path),
a target inside `~/.darwin/sessions/` is refused because a transcript planted among the records
would be read by every scanner of that tree, and the one small local write is awaited with a failure
costing the export only. Clipboard and `$EDITOR` are out of scope on purpose (SSH-hostile) — the
clipboard has its own command, `/copy` below, whose transport is chosen *for* SSH. The
fourteenth built-in grew `MAX_COMPLETIONS` again; the free checks are
`spike/verify-export-command.ts` (in `pnpm test`) and `spike/verify-tui.ts completion`.

## `/copy` — OSC 52 first, the platform tool second

**`/copy` puts the last *completed* answer's committed transcript text on the clipboard, and the
terminal is the first transport, not the fallback** (`src/tui/copy-command.ts`, SER-057; spec:
`frontend/live-frame.md` § `/copy`). The text is `latestCompletedAnswer(history)`: the newest
answer whose closing `AnswerPart` (`whole` or `last`) is in `<Static>` history, its pieces joined by
newlines with empty closing pieces contributing nothing — the same rule `formatReplay` applies, so
what lands on the clipboard is the plain text the transcript shows and `/export` writes (the Markdown
projection never rewrites a character, so the ANSI-stripped answer *is* this text). An answer still
streaming has no `last` piece yet, so a mid-turn `/copy` copies the previous completed answer; before
the first one, or right after `/clear`/`/rewind` (both empty history), the result is one bounded
`nothing to copy` info notice, never an error. Transport order is the decision: darwin is normally
driven over SSH, where no `DISPLAY` exists, so one OSC 52 sequence (`ESC ] 52 ; c ; base64 BEL`)
goes out through Ink's own stdout writer (`useStdout().write`, the path `/clear`'s screen clear
already uses) *first*, unconditionally; only when `WAYLAND_DISPLAY`/`DISPLAY` is set or the host is
macOS does a dependency-free helper (spawn, stdin pipe, bounded timeout, non-throwing — the
`clipboard-image.ts` shape) additionally run `wl-copy`, `xclip -selection clipboard` or `pbcopy`,
and its failure is a clause of the same notice, never a throw or a second notice. The payload is
bounded by the named `MAX_COPY_BYTES`, cut on a code-point boundary, and an over-cap copy is stated
as `copied N of M bytes` — never a silent partial copy. Like `/help`, it sits above the busy guard,
takes no arguments (a local usage notice otherwise), calls no runtime accessor, model or tool, and
records nothing: the trajectory keeps one path in, and the clipboard is not a second one. The
twentieth built-in grew `MAX_COMPLETIONS` to 21 and added one fixed `/help` row; the free checks are
`spike/verify-copy-command.ts` (in `pnpm test`), `spike/verify-help-command.ts`, and
`spike/verify-tui.ts copy` / `completion`.

## `/status` — the consolidated projection

**`/status` is a formatter over accessors the runtime already exposes — never a new information
channel** (`src/tui/status-format.ts`, on the `/mcp` precedent): model/provider and session id
(`runtime.config`, `runtime.info`), cache and effort (the *live* plans, rendered by the very
functions the header's model line uses — `formatPromptCache`/`formatThinking` live in
`status-format.ts` so the two surfaces cannot diverge), permission mode and live allow-rule count
(the header's own three-state wording), MCP server states (`runtime.listMcpServers()`, a failed
server stated as failed exactly as `/mcp` words it), skills, trajectory/diagnostics state, process
token spend and the `/context` estimate (`formatContextValue`, shared with `formatContextReport`).
Four things are load-bearing. It is read-only to the byte: no config write, no pointer move, no
connection attempt — states are reported as they are, and the awaited `contextEstimate()` is the
same mid-turn-safe read `/context` performs, degraded to an `unavailable — <reason>` line on
failure. Unknown metrics stay unknown, never 0: spend comes from `usageBuckets` +
`formatUsageValue` directly (`not reported`), never the bedrock `?? 0` projection of `usageRows`.
The report is bounded by construction: server and skill lists cap at `MAX_STATUS_NAMES`
representative names with an explicit `… N more`, and per-server tool listings stay with `/mcp`
(the report says `details: /mcp` instead of duplicating them). And it is transcript history only —
the live frame gains no row; restating what the header shows is the point, because a scrolled-away
header is the use case. The fifteenth built-in grew `MAX_COMPLETIONS` again; the free checks are
`spike/verify-status-command.ts` (in `pnpm test`) and `spike/verify-tui.ts completion` / `mcp`.

## `/context` — a measured base plus a one-turn tail

**The context estimate anchors on what the provider said the last request cost, and estimates only
what has been appended since** (`src/agent/context-anchor.ts`, `AgentRuntime.contextEstimate`,
`src/tui/context-format.ts`; spec: `backend/strands-sdk-contracts.md` § `/context` counting).
darwin sets `useNativeTokenCount: true`, but Bedrock's `CountTokens` refuses the inference-profile
ids darwin requires, so the SDK caches the model as skipped and every count is
`estimateTokensHeuristic` — `chars/4` text, `chars/2` tool-spec JSON. Meanwhile the provider has
been reporting the real prompt size of every call all along, and `AgentRuntime` already observed
those counters for `/usage`. The anchor is the one hop that was missing: on each
`afterModelCallEvent` with `stopData`, `requestInputTokens` (shared with `/usage`'s per-call
average, so the two cannot disagree) yields that call's submitted total — uncached input plus cache
read and write, because a cached prefix still occupies the window — and it is stored with
`agent.messages.length` and the boundary message *by reference*. `/context` then reports
`measured base + countTokens(tail)`, which turns the largest and most heuristic-hostile part of a
request (system prompt plus every `toolSpec`) into a measured number and bounds the estimated part
to one call's worth of tail instead of a whole session's accumulation.

Every way the base can stop being true ends in absence, never in a repair: `resolveAnchor` requires
both that the history has only grown and that the same object still sits on the boundary, so a
`/compact` rewrite (shorter, or same length with different objects) drops it; `/clear` and `/rewind`
build successor runtimes through `create()` and start without one; `changeModel()` clears it
explicitly, because a measurement made by another tokenizer with another prompt overhead describes a
request this model would not have sent; and a resumed session reports the plain heuristic line until
its first metered call. A call that measures nothing — failed attempt, unreported counters, an
OpenAI-Responses split that cannot be made honestly — installs nothing and invalidates nothing: the
previous measurement is still the best available. The observer has its own `try/catch` and its own
broken latch beside the call-stats one, on the trajectory observer's terms: it sits between
`stream()` and `yield`, so a malformed payload costs the anchor, never the turn. A failed tail count
keeps the base and says `tail unknown` rather than discarding the measurement it was refining.

The presentation follows the `usageBuckets` honesty rule. With a measurement the line names its
basis — `context — ~128,431 tokens (measured 126,900 + ~1,531 new) · 64% of 200,000 window` —
because "measured 126,900 plus an estimate" and "~128,431" are different claims; without one it is
the pre-anchor wording, byte for byte. `/status` renders the same value through the same
`formatContextValue`, and the context-pressure latch consumes the same estimate, so it gets more
accurate without gaining a second threshold.

Rejected, and recorded so it is not re-proposed: fitting a `measured / heuristic` correction factor
and scaling future heuristics by it. That trades one unknown for another — the ratio is provider-,
tokenizer- and content-dependent (images, reasoning blocks and JSON tool specs each carry their own
error), it needs a smoothing window and clamps nobody can justify, and a wrong ratio silently scales
everything downstream, including the pressure advisory. The anchor form has no fitted parameter.
Free coverage: `spike/verify-context-anchor.ts` (pure state plus a real offline runtime) and
`spike/verify-context-format.ts`; `verify-status-command.ts` pins the shared row.

## Context pressure — advise once, never compact implicitly

**High context pressure is a transcript advisory over the existing estimate and configurable latch,
not another compaction mechanism** (`src/tui/context-format.ts`, `src/tui/App.tsx`; specs:
`backend/strands-sdk-contracts.md` § `/context` counting and `frontend/live-frame.md` § context
pressure). After a completed turn, the App asks `AgentRuntime.contextEstimate()` and checks the same
`contextWarnRatio` that has always controlled context warnings (default `0.8`, custom values
preserved, `0` disables). There is deliberately no SRF-010-specific second threshold: crossing emits
one bounded `<Static>` transcript notice that recommends the user consider `/compact` before the next
broad implementation or verification turn. Remaining above does not repeat it; only a later known
below-threshold estimate re-arms it, and `/clear` installs a fresh latch with the successor session.
An unknown/invalid model window or failed estimate is absence, never pressure. The notice neither
calls `/compact` nor mutates messages, and adds no timer, channel or live-frame row. Free coverage:
`spike/verify-context-format.ts`; unchanged gates include `verify-compact.ts`,
`verify-status-command.ts`, `verify-frame-budget.ts`, `verify-prompt-queue.ts`,
`verify-resume-recap.ts`, and `verify-clear-session.ts`.




## `darwin sessions` and `--resume <id>` — resume by choice

**The listing is a read-only projection of the snapshot store, and a named resume is a refusal
before it is ever a fallback** (`src/cli-sessions.ts`, `src/agent/session.ts`, spec:
`backend/strands-sdk-contracts.md` § Sessions). `darwin sessions` shows only what
`--resume <id>` can actually reopen: each row is a session with a restorable snapshot — id, age
from the snapshot's mtime (activity, so a hand-named `--session my-experiment` sorts in its real
place), the first recorded `userInput` where the trajectory has one, and `(last)` on the
pointer's target. It runs before argument parsing on the `trajectory` routing precedent, makes no
model call and no network access, imports nothing from the SDK, and contains no write API at all —
the store is proved byte-identical by hashing every file before and after. Absence is an answer on
prompt recall's terms: recording off reads `(not recorded)`, an empty project is a notice with
exit 0, and directories without a restorable snapshot are skipped with the skip stated (they stay
visible in `darwin trajectory list`). The `--resume <id>` grammar is additive: a plain token after
`--resume` is an id (validated against the session-id alphabet, resolved through the same strict
`{ kind: 'id' }` path as `--session`, combining the two is a usage error), while bare `--resume` —
end of argv or followed by another flag — keeps its exact pointer-following meaning, so every
pre-existing invocation parses unchanged. A bogus or other-project id raises
`SessionNotFoundError`, which `cli.ts` catches beside `ConfigError`: one plain line, exit 1, never
a stack trace and never the pointer's session instead. Pointer semantics stay the unchanged
`markResumable()` rule — after the resumed session finishes a turn, `last-session.json` points at
it; quitting without a turn moves nothing. Free check: `spike/verify-sessions-command.ts` (in
`pnpm test`).

## `darwin doctor` — reports, never refuses; reads, never creates

**The doctor is the startup loaders composed into one report, with exactly one rule changed: a
loader that would refuse to start becomes a marked line** (`src/cli-doctor.ts`; spec:
`backend/error-handling.md` degradation table). It calls the same `loadConfig`,
`loadSystemPrompt`, `loadProjectInstructions`, `scanSkills` and `loadProjectPolicy` a session
runs, so it says what a session *would* load rather than what a second parser thinks; a
`ConfigError` (or a thrown skills scan) is one `! `-prefixed line carrying the loader's own
message, the report always completes, problems are totalled and decide the exit code (0 / 1; 2 for
any argument after the verb). Two loaders had to grow a side-effect-free half for this to be
honest: `configPath()` created `~/.darwin` on the way to a *read*, so the two readers now derive
the path through `configFilePath()` and only writers keep the mkdir; and `loadMcpClients` spawned
servers as it parsed, so its declarative half is `readMcpServerConfigs` — the doctor reads servers
from it and checks a stdio `command` with a plain `X_OK` PATH lookup (`lookupOnPath`), states an
`http`/`sse` server as `not connected (doctor never connects)`, and never prints `args`, `env` or
`headers`, which may carry tokens (the config's `apiKeyEnv` is reported as set/unset, never its
value). It routes in `cli.ts` beside `sessions`, before argument parsing; its module closure
reaches no runtime, headless, TUI, Ink or React module and imports no `Agent`. Free check:
`spike/verify-doctor-command.ts` (in `pnpm test`): a marker-writing fixture command is found on
PATH and never runs, a pristine HOME and the fixture project are snapshotted (path, kind, size,
mtime) before and after the real process run and compared byte for byte. AGENTS.md has no row for
this decision on purpose — it sits 101 bytes under its preload cap.

## Resumed-session full transcript — restore the human, not a second model history

**A resumed TUI gets the full replayed session transcript as read-only startup scrollback**
(`src/trajectory/resume-recap.ts`, `src/cli.ts`, `src/tui/App.tsx`; specs:
`backend/session-trajectory.md`, `backend/strands-sdk-contracts.md` § Sessions,
`frontend/live-frame.md`). Runtime remains the only Agent constructor and the snapshot remains the
only model-context authority. After it restores messages, interactive startup reads the exact
session trajectory, replays the whole record through the ordinary reducer (`replayRecords` — the
same one projection `/export` and `trajectory replay` use, never a second formatter), and seeds only
display history: a recap header notice first, then every run's user rows, tool rows, answers and `!`
shell rows in record order, with honest degradation notices (missing/disabled/damage/dropped/
truncation) after the body. There is deliberately no size cap — measured at 1.2 MiB / 2,801 records
the replay takes ~12 ms and the rows are written once to `<Static>` — so startup scrollback length
equals session length (user decision 2026-08-28, superseding the earlier bounded last-turn recap).
Seeded item ids come from the same process-local counter the live session uses, so later live rows
cannot collide. It makes no model/network call, creates no synthetic model message, writes no file
and does not move resumability state. Fresh/headless sessions skip it;
missing/pre-recording/disabled/damaged records say what is unavailable. The transcript is `<Static>`
startup history, not header/frame furniture, and `/clear` removes it. Free checks:
`verify-resume-recap.ts` (in `pnpm test`) and `verify-tui.ts resume` at 120x50 over a multi-turn
fixture with hashes over the trajectory, snapshot and pointer.



## Skills

**Skills** (`src/skills/`): Darwin uses the official SDK `AgentSkills`/`Skill` core. A thin
adapter preserves product policy the SDK does not own: required/reserved built-ins, project-over-
global precedence, optional problem reporting, case-insensitive `/skill-name`, and the observable
safe `load_skill({name})` contract. The native `skills({skill_name})` tool stays private so the
model never sees two ways to load the same capability. Official activation owns appState and the
resource listing, explicitly capped at 20 files and three recursive levels. Before official
activation, Darwin rejects resource symlinks/outside-root resolution and caps host preflight at
200 entries because the SDK's host sandbox follows directory symlinks before applying its file cap.

## System prompt composition

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

**Working-method rule 8 states the real same-message execution contract** (SRF-021). Until
2026-09-02 it told the model that "several edits to the same file belong in consecutive calls of
one message only when they touch non-overlapping regions" — advice that, under the SDK's
concurrent tool executor, lost 4 of 6 disjoint `str_replace` calls in
session-20260902-054329719 and then pushed the model into `python3 - <<'EOF'` / `cat >` writes
with no edit diff, no permission classification and no `fileEditor` trajectory record
(`docs/reflections/reflection_2026-09-02_session-20260902-054329719.md`, F2/F3). With SRF-020's
same-path ordering (`src/tools/file-editor-serial.ts`) the rule now says: tool calls in one
message run concurrently, but `fileEditor` edits to the same file are applied in call order, so
disjoint edits to one file may share a message; overlapping fixes to one region are one edit; a
verification command never shares a message with the edits it checks (it would read an unknown
state); file mutations go through `fileEditor`, not heredocs/`sed -i`/inline Python/`tee`; and
`create` refusing an existing file means `view` then `str_replace`, not a shell fallback. The
rule count and every other line of the base prompt are unchanged, so the cached prefix shape is
the same; `spike/verify-working-context.ts` pins the phrases and the eight-rule count.


## Agent-managed project memory

**Project memory is default-on, parent-only, and on demand** (`src/memory/`). Effective `memory: false`,
including the implicit opt-out from `trajectory: false`, registers neither model-facing tool and creates no
state. When enabled, `memory_recall` is a statically safe local read over strict validated state, while
`memory_save` is an ordinary dangerous write that follows default/auto/plan/yolo permission behavior and can
never be covered by an allow rule. Both are registered only after the child catalogue is fixed, so subagents
cannot retrieve or save parent memory.

A save validates one atomic fact and stages it in the active foreground turn. Project claims require one
unique exact current project-relative UTF-8 source line; preferences and non-secret account identity require
one exact unique quote from the current user input. Darwin derives hashes, line numbers, session, turn,
closing sequence and time itself. The controller commits only after both an exact successful `endTurn` seal
and the matching closing trajectory append settlement arrive; failure, cancellation, partial output,
consumer abandonment, recorder degradation, or `/clear` before acceptance discards staging. Once accepted,
serialized cleanup may finish the commit without changing the completed turn.

`state.json` version 3 is authoritative under the existing project-keyed private directory. Entries have a
stable namespaced key, closed category, one fact, host-owned provenance, evidence and validation. IDs derive
deterministically from normalized key plus fact; duplicates collapse and a newer validated fact supersedes
an older generated fact with the same key, never a user note. Generated suppressions, age expiry, strict
no-follow parsing, `0700` directories, `0600` atomic files and `/memory list|show|forget|remember` remain.
Version-1/2 state is read through a deterministic atomizing migration; only currently revalidated anchored
facts survive an authorized mutation, and trajectories are never rescanned or backfilled.

Recall performs bounded deterministic lexical ranking, revalidates generated entries with `persist: false`,
and returns explicitly fallible data rather than instructions or policy. It makes no model, network,
embedding or vector call, writes nothing, and never injects the full archive into the system prompt. The
optional bounded `index.md` is a human projection only; legacy topic projections are removed on authorized
mutation. Free checks: `verify-memory-validation.ts`, `verify-memory-tools.ts`, `verify-memory-command.ts`,
`verify-memory.ts`, and `verify-clear-session.ts`.

## Prompt caching

**Prompt caching is on by default** (`src/agent/prompt-cache.ts`, `promptCache` /
`promptCacheTtl` in config): tools and conversation through `BedrockModel.cacheConfig`, the
system prompt through a cache point placed after `initialize()`. Claude only, and the gate is
deliberate — `strategy: 'auto'` on a model that cannot cache makes the SDK `console.warn` into
the Ink frame. The header states it on the model line, never a line of its own: the header
shares the live frame with the permission box, and one extra line pushes the box off a 50-row
terminal (`spike/verify-tui.ts approve` catches it).

## Thinking effort

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

## Subagents

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
`subscribeToSubagentDispatches`, `/agents`. Records hold name, task, closed phase, state,
timestamps and the child meter's usage counters (live while running, frozen at settlement) —
observability must never become a second path for child transcript or payloads
into parent context. And the
parallelism is scoped to **reads**: concurrent children share one working tree with no isolation
or conflict detection, so concurrent write delegation is *not* made safe, deliberately and
documented rather than guarded.


Long-running dispatch visibility stays inside that same observer boundary. The registry owns one
unref'd ≤30-second heartbeat per running child and publishes only stable id, bounded agent name,
elapsed time, and the closed phase `starting` / `model` / bounded tool name learned from SDK hooks.
It never reads child messages, reasoning, prompt, tool payload/result, final report, or transcript.
The TUI updates the existing granted live subagent row; text headless writes stderr and stream JSON
uses bounded `subagent.progress`; trajectory, lifecycle hooks, permissions, model context and final
JSON are unchanged. `/agents cancel <id>` is a user-only direct registry control: exact running ids
cancel one child, collision/unknown/terminal ids refuse locally, siblings and the parent turn remain
alive. Ctrl+C still cancels every child plus the parent. Settlement clears timers/cancellers before
completion publication. Required check: `spike/verify-subagent-heartbeats.ts` (in `pnpm test`).

## Same-path fileEditor ordering — serialize the mutation, never the executor

The SDK's vended `fileEditor` writes with `readText → compute → writeText` and no lock, and the
concurrent executor above races every tool call of one assistant message. So six `str_replace`
calls on one file in one message each read the original and the last write wins — while all six
report `success` (measured 1/6 surviving unwrapped; session-20260902-054329719 lost 4/6 on
`src/config.ts` and spent 13 % of the turn re-applying them). `src/tools/file-editor-serial.ts`
fixes the write, not the executor: `SerializedFileEditorTool` takes the singleton's place in the
runtime `tools:` list (static tool, so no discovery window and no `addOrReplace` dance) and is a
pure projection — same name, description and `toolSpec`, the SDK's own `stream()` with the
untouched context, so result and error bytes, permission classification, edit-diff rows and
trajectory records cannot differ. What it adds is *when*: `create`/`str_replace`/`insert` on one
resolved absolute path await the previous mutation on that path for the same Agent
(`WeakMap<Agent, Map<path, chain>>` off `context.agent`, the vended bash tool's precedent), so each
call reads what the previous one wrote and an `insert_line` means the updated file. `view`,
distinct paths, pathless input, every other tool and every other Agent stay concurrent — a child
built from the parent's catalogue has its own chains, and `/clear`'s successor starts empty.
Entries only resolve (a failed edit releases the chain) and a settled tail deletes its key, so the
map is bounded by in-flight calls. `toolExecutor` stays unset and the pinned patch untouched.
Required check: `spike/verify-file-editor-serial.ts` (in `pnpm test`), with
`spike/verify-file-editor.ts` unchanged by the wrapper. The pinned patch's own `str_replace`
extension (SER-055 `replace_all: true` — every non-overlapping occurrence in one write, count and
pre-edit line numbers in the result; absent/`false` byte-identical to before) passes through the
wrapper untouched, since it never reads the input beyond `command` and `path`.


## Workflow DAG tool

**`workflow` is a parent-only bounded declarative DAG whose execution is the installed SDK
`Graph`, never a darwin scheduler** (`src/agents/workflow-tool.ts`, `src/agents/child-recipe.ts`;
contract in `.trellis/spec/backend/strands-sdk-contracts.md` § "bounded declarative workflow DAG
(SER-045)"). The input is data, never code — node ids, agent names, task strings and plain
`[source, target]` edge pairs, capped at 8 nodes / 28 edges — and an invalid DAG (cycle,
duplicate/unknown id, unknown agent, blank task, over-cap count) is one bounded tool error before
any dispatch, model or child exists. Everything that schedules — AND-semantics dependency
resolution, dependency-merged node inputs, `maxConcurrency`, terminus resolution — is the SDK's:
darwin only wraps each node in a thin `InvokableAgent` adapter (node id outward, unique
`darwin-workflow-*` agent id inward) that prepends the node's own task to the SDK-provided input.
Each node is built by `buildRecipeChild`, the single child-construction recipe extracted from and
still used by `SubagentTool` — same composed prompt, tool filtering, shared gate with dispatch
`source` provenance, registry heartbeats and targeted `/agents cancel`, codex-hook fork,
max-tokens recovery, bash reaping — so the two delegation surfaces cannot drift; neither may
construct a child `Agent` directly. Only the graph's terminus content returns to the parent;
child transcripts stay private, no child event reaches the trajectory, and nodes appear through
the existing dispatch-registry rows (each with its own random dispatch id — deriving from the
shared parent `tool_use` id would make targeted cancel ambiguous). One owned `AbortController`
forwards the parent's cancel signal into `graph.invoke`, so cancellation stops running children
and unstarted nodes alike, and a `finally` sweep settles leftover dispatches as `cancelled`.
Registered strictly after the child-catalogue capture, so children can never orchestrate; the
tool description pins reads-parallel/writes-serialized because concurrent nodes share one working
tree. The `/workflow <task>` built-in is a prompt-style trigger onto this same tool, never a
second execution channel: `parseWorkflowCommand` (`src/commands/workflow-command.ts`, pure, never
imports `WorkflowTool`) expands in `expandSlashCommand` — checked before skills and custom
commands so no extension can shadow the reserved name — into one fixed template that names the
tool, restates the bounds and the reads/writes rule, and embeds the description verbatim, then
flows down the ordinary submit path (busy submissions queue per SER-027); bare `/workflow` is a
local driver usage notice, never a model call. Required check: `spike/verify-workflow-tool.ts`
and `spike/verify-workflow-command.ts` (both in `pnpm test`).

## Session trajectory

**Session trajectory is an observer, never a participant** (`src/trajectory/`, spec:
`.trellis/spec/backend/session-trajectory.md`): every turn is appended to
`~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl` — a sibling of `background/`
and `offload/`, on by default, `trajectory: false` to switch off. The whole layer hangs off one
seam in `AgentRuntime.send`: it first waits on one bounded, no-throw append of the already-observed
`userInput`, so concurrent offline readers see the active request before `agent.stream()` can invoke
a provider or tool. Failure/timeout latches ordinary trajectory status and invocation still proceeds.
After that, `recordStream` sits between `agent.stream()` and the `yield` and observes every event
**synchronously, without I/O, and without being able to throw**, so recording cannot reorder an event
or fail a turn (both boundaries are measured over a real offline runtime, not assumed). A turn whose
stream *throws* is observed there too and its error rethrown **as the
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
resume pointer. Self-reflection is another strict reader: its locator runs before the managed child,
selects current-or-named without fallback, and hands off the inclusive turn/seq of the latest valid
`turnEnded`; a later open `userInput` may identify the Host but is never graded, and no closed turn is
a refusal. The locator and child never repair, append, or move session state. No subagent event is
recorded anywhere; child streams never pass through `send`.

## Session diagnostics

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

## Paths

**Paths** (`src/paths.ts`): every `.darwin/` location is derived here from the CLI's cwd.
`process.cwd()` is read only in the two entry points (`cli.ts`, `dev-repl.ts`); everything
else takes an explicit `projectRoot`.

## Process exit

**Process exit is engineered, not assumed.** The vended bash tool's persistent shell is
reaped in `runtime.shutdown()` via direct `restart` — the tool keys shells per `Agent` in a
`WeakMap`, so a runtime retired by `/clear` has to reap its *own* shell (`retire()`) or that one
is never released and exit takes ~15s longer. The pinned SDK patch serializes foreground
execute/restart per Agent: a numeric exit 0 with no signal returns that command's captured
stdout/stderr plus a restart notice and the next call starts a replacement shell; nonzero and
signalled exits remain metadata-bearing failures. A foreground timeout still kills the shell (it
cannot detach a running command, so there is no move-to-background), but its error result keeps
the ≤ 64 KiB tails of captured stdout/stderr, names the timeout figure, states that the shell
restarts at the initial cwd and points to `start` + `wait`. Serialization is also what keeps parallel
foreground calls from sharing listeners and attributing one command's output to another.
Session-owned background bash jobs are reaped as whole process groups with bounded TERM→KILL
cleanup plus a synchronous `exit` fallback. Darwin configures the foreground tool from the
runtime's verified project root; every execute projects the serialized shell's effective cwd.
Before a shell write, only a plain whole-command `cd <relative>` or slash-containing relative
command path may be refused when absent under cwd but present under project root; complex shell
syntax fails open, and the diagnostic is non-mutating and names both locations. A redundant
provider `timeout` on `start` is ignored after policy observation and never becomes a background
lifetime. Their provider-facing `wait` observes cancellation and shutdown and consumes output
only through the existing serialized byte cursor. Output-sensitive wakeup stays bounded at 1–30000 ms and is the
compatibility default; explicit `wakeOnOutput: false` accepts a finite 1–300000 ms, advances and
retains up to the ordinary output cap, and waits only for terminal state, cancellation, shutdown, or
timeout. Only its still-running timeout adds bounded model-visible wait-again guidance stating that
background completion does not resume the agent; it never continues or calls the model itself.
Neither form owns or delays process cleanup. A cancelled model stream's socket has no public cleanup,
so `cli.ts` arms an unref'd 500ms `process.exit` fallback *after* shutdown completes. Don't change these paths
without re-running `spike/verify-background-bash.ts`, `spike/probe-cancel-exit.ts`,
`spike/verify-clear-session.ts`, and the `bashExit` / `cancelThenContinue` TUI scenarios.

## TUI — production React owns the long-turn memory bound

**The interactive React/Ink graph is first imported under the production condition**
(`src/tui/react-environment.ts`, spec: `.trellis/spec/frontend/live-frame.md`): React 19's
development reconciler emits retained Node User Timing measures on every component commit. The
existing 90 ms busy tick can therefore grow heap throughout a provider-silent turn without any
model or trajectory event. `cli.ts` applies one narrow `NODE_ENV=production` override around the
first React/Ink/TUI dynamic imports and restores the ambient value before runtime assembly; local
read-only and headless commands remain outside it. This keeps the tick, direct streaming and frame
budget unchanged. Required check: `spike/verify-react-production-memory.ts`.

## TUI — the frame budget

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

The ready-state brand is deliberately outside that budget: `WelcomeHeader` is the first
presentation-only item in `MessageList`'s existing `<Static>` owner (adjacent Static owners do not
commit independently), written once when the interactive App takes ownership. Its
pure responsive layout chooses a complete five-line, three-line, or compact `◆ DARWIN` identity
before rendering and is captured once at App mount, so resize cannot mutate committed Static output;
it is never trajectory/replay/model content or measured frame furniture. App is not remounted by
`/clear`; the successor transcript changes epoch and omits the presentation item, so the process
welcome cannot repeat. The semantic palette likewise has one cyan non-state accent;
green/yellow/red remain success/warning/error meanings, muted text uses dimmed default foreground for
light/dark terminal compatibility, and composer/completion focus uses text plus bold rather than
inverse backgrounds. Checks: `verify-startup-screen.tsx`, `verify-startup-pty.ts`,
`verify-visual-language.tsx`, and `verify-frame-budget.ts`.


## The busy rows

**The busy rows are alive, and stay exactly the rows they were** (`src/tui/busy-suffix.ts`,
contract: `.trellis/spec/frontend/live-frame.md` § the busy rows are alive): while a turn streams,
the `working…` hint and the `thinking…` row carry a live suffix — elapsed turn time plus the
session's reported token spend (` · 12s · ↑1.2k ↓318 tokens`; the `thinking…` row elapsed-only,
so the spend is never stated twice in one frame) — with no new frame row, no new tick source and
no new information channel. The suffix rides directly *behind* the busy word, ahead of the static
command hints: both rows are one `<Text wrap="truncate-end">`, so they can never wrap or grow a
row at any width and the tail that truncates on a narrow terminal is the part that never changes —
the hint's 2-row claim in `promptBoxWanted` and `thinkingRows = 1` stay correct untouched. The
only clock is the existing spinner interval (never a second one, no tick while idle) and the only
read is `runtime.usage`, the SDK's synchronous in-memory accumulator — which counts a model call
when it *finishes*, the same lagging reading mid-turn `/usage` reports as "not counted yet".
Honesty is the `usageBuckets` rule: an unreported metric is absent, never 0; a zero accumulator
renders `↑0 ↓0`; a meter read that throws degrades to elapsed-only. The per-turn start ref is
cleared in `runTurn`'s `finally`, so cancelled and failed turns stop the readout with the tick.
Free check: `spike/verify-busy-suffix.ts` (in `pnpm test`); the live `verify-tui.ts usage`
scenario asserts the readout is present mid-turn and ticks while the turn runs.

## File-edit diffs

**A file edit is presented as the line diff of its own input — computed at presentation time,
never read from disk** (`src/tui/edit-diff.ts`, contract: `.trellis/spec/frontend/tui-testing.md`
§ file edits render as marker-stable line diffs): the gate has always exposed the raw tool input
"for a UI that wants to show or diff it itself", and this is that UI. A gated `fileEditor` write
(`str_replace`, `create`, `insert`) shows a `Diff` block at the permission prompt, and the same
projection (with `command:`/`path:` header lines) is the expanded tool input in the active panel
and the finished `<Static>` item — the model-visible tool content is untouched. Four things are
load-bearing. The vocabulary is three plain-text markers (`- ` removed, `+ ` added, `  ` context)
with colour as enhancement only, so the distinction survives ANSI stripping. Equivalence is
structural: stripping the two-character marker recovers the old value from `- `/`  ` lines and the
new from `+ `/`  ` lines, an absent `new_str` (removals only) stays distinguishable from an empty
one (one empty `+ ` line), and approving writes the exact untruncated input — the diff replaces
only the `editContent`-tagged blocks, everything else the box stated stays stated, and an input
the reader does not recognize keeps its raw blocks. Bounds and geometry are the existing ones:
the diff flows through `permissionDetail`/`expandedToolInput` budgets, and tone rides the counted
row (`BoundedContentRow`) so wrapped continuations stay coloured without a second height
calculation. And tone is scoped to `fileEditor`, so a bash command starting with `- ` never turns
red; dev-repl keeps the raw blocks. The hand-rolled LCS is deliberately dependency-free and falls
back to remove-all/add-all above 40k cells without losing equivalence. Free checks:
`spike/verify-edit-diff.ts` (in `pnpm test`) and the diff sections of
`spike/verify-visual-language.tsx`; the live `verify-tui.ts approve` scenario asserts the box.

SER-023 made the same projection visible and vivid without weakening any of the above, and a
follow-up (user-directed) removed the compact excerpt's bounds: a finished write's rows land in
`<Static>` scrollback — written once, never repainted — so `compactEditDiff` now returns the
**complete** diff and the expanded finished row keeps the complete labelled projection
(`fileEditorInputProjection`, unbounded). The frame budget governs what is *redrawn*; scrollback
length is the deliberate cost. Only the live surfaces stay bounded: the active tool panel
(`toolInputRows` → `expandedToolInput`) and the permission box (`permissionDetail`), both of
which repaint every frame and must fit the terminal. A `+N -N` stat (`diffStat`, counted from
the markers of the untruncated diff) rides existing surfaces only: spliced into the finished
summary row *before* the path —
the row truncates end-first and the path is its one unbounded part, so a suffix stat is exactly
what a long path eats — and into the permission block label (`Diff (+1 -1):`). It travels as an
optional history field, never inside `summary`, because `formatReplay` prints `summary`/`preview`
verbatim and `/export`/`trajectory replay` must stay byte-identical (proved against a real
938 KB record). Intraline emphasis pairs equal-count `- `/`+ ` runs, trims the common
code-point prefix/suffix, and bolds the changed span as an `emphasis` range on the same
`BoundedContentRow` the heights come from — enhancement layered exactly like tone, so
ANSI-stripped output is byte-identical to the plain diff and unrelated pairs (no shared edge),
unequal runs and tab-bearing lines simply get none.

SER-055 kept the projection input-derived when `str_replace` gained `replace_all`: the diff and
the `+N -N` stat stay the one pair the model sent, and the scope is one extra row read from the
input — `replace_all: every occurrence` above the diff (`REPLACE_ALL_ROW`, in
`fileEditorInputProjection` and `compactEditDiff`) and a `Replace all: every occurrence` detail
row from `classify()` in the permission box — so no surface ever opens the file to count
occurrences and `summary` is untouched.

## Streaming answers into `<Static>`

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

## Markdown styling

**Markdown styling is a projection over the committed answer text, never a rewrite of it**
(`src/tui/markdown.ts` pure and dependency-free, `src/tui/MarkdownText.tsx`, contract:
`.trellis/spec/frontend/live-frame.md` § markdown styling): assistant answers — `<Static>` pieces
and the live region — draw headings bold, `**bold**`/`*italic*` emphasized, inline and fenced code
in `markdownCodeColor`, and fence delimiters/rules/markers dim; syntax highlighting by language is
out of scope. The vocabulary also covers block structure (SER-047): a list bullet or `N.`/`N)`
marker with its indent, a blockquote's whole `>` run and every `|` of a pipe-fenced table row become
dim `marker` spans while the block's own text keeps prose tone — which is what gives a `* item` line
its marker, since `inlineSpans` refuses to read that `*` as emphasis. Order decides the ties: fenced
code beats everything, then heading, then `rule` (so `---`/`***` never becomes a list), then quote →
list → table → prose. A line merely *containing* `|` (`cmd | grep x`) stays prose on purpose: any-pipe
detection would dim the shell pipelines darwin's own answers are full of. Four things are
load-bearing. **Every character is kept** — markers are dimmed in
place, never stripped, so a line's spans concatenate back to the line byte for byte, ANSI-stripped
output *is* the committed plain text, and `formatReplay` / `/export` are byte-identical to before
the feature (proven against real recorded sessions); `turn-state.ts` still commits exact plain
lines and reconciles/diverges on plain strings. **Fence state across pieces is one boolean decided
at push time**: each assistant piece carries `codeOpen = fenceOpenAfter(committedAnswer)` and the
live region derives `liveCodeOpen` with the same function over the same string, so a live
re-render cannot disagree with what `<Static>` already wrote — which is also why the fence
classifier is a boolean toggle by design. **The Ink traps still bind**: a history piece is ONE
outer `<Text>` of nested spans and literal `'\n'` strings (an empty `<Text>` renders zero rows —
per-line `<Text>`s would swallow committed paragraph breaks), and a live row stays ONE
`<Text wrap="truncate-end">` whose count is exactly what `liveTextView` said, toned via the row's
`LiveRow.line` source index rather than a second wrap. And **scope is answers only** — user
messages, notices, tool output, the prompt editor and dev-repl are untouched, and `_underscore_`
emphasis is deliberately not recognized (snake_case is far more common in answers). Free checks:
`spike/verify-markdown.tsx` (force color first via `spike/force-color.ts`, or the "styling
happened" assertion passes vacuously on a pipe) and the markdown section of
`spike/verify-visual-language.tsx`, both in `pnpm test`.

## `@` path completion

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

## Prompt recall

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

## `!` shell commands

**A draft starting with `!` runs as the user's own shell command — outside the permission gate,
inside every honesty channel** (`src/tui/shell-command.ts`, App submit path; specs:
`.trellis/spec/frontend/live-frame.md`, `frontend/prompt-recall.md`,
`backend/session-trajectory.md` § `shellCommand`). The gate's subject is model tool calls, so the
user typing `!rm -rf build` is the user acting directly — no approval prompt, in **every** mode
including plan, which constrains the model's writes and not the user's hands. What the gate never
saw is stated three ways from **one bounded projection** (`projectShellOutput`: SER-009 `boundText`,
head kept, 4000 points / 80 lines — deliberately under the recorder's 8000 field cap): the finished
transcript row, the `shellCommand` trajectory record, and a `<user-shell-command>` report held in
the App and prepended to the **next** model-bound prompt — never injected into `agent.messages`
(Bedrock rejects consecutive user roles), never a turn of its own, dropped by `/clear` with the
conversation it was destined for. Execution is a **one-shot `bash -c` in its own process group**,
not the runtime's persistent shell: a hung `!` must not block the model's serialized shell or cost
its state, so timeout (2 min) and Ctrl+C both TERM→KILL the group and the busy state always ends —
the stated tradeoff is that `!cd` persists nowhere. The prefix triggers only at the start of the
trimmed draft; a mid-turn `!` queues like a prompt (SER-027 — see § the prompt queue; the Claude
Code shape: shell commands are held until the turn ends and run one at a time, each through this
same path at drain time); the live command borrows the existing tool panel (spinner, elapsed,
always-visible
tail rows counted through the same `toolDetailsVisible`/`toolInputRows` the panel draws with), so no
new frame surface exists. The record is **not** `userInput` — prompt recall never offers a `!` back —
and replay *prints* it through the same `turnReducer` action the live session dispatched, so live
and replayed transcripts are one projection. Free checks: `spike/verify-shell-command.ts`,
`spike/verify-tui.ts bang`.

## The prompt queue

**A submission while the session is busy queues, visibly, and is sent when the turn ends**
(`src/tui/prompt-queue.ts`, `src/tui/QueuedMessages.tsx`, App state in `src/tui/App.tsx`; contract:
`.trellis/spec/frontend/live-frame.md` § a busy submission queues). SER-027 **deliberately
supersedes SER-010's "retained, never queued" contract by explicit user product decision**
(2026-08-19, `docs/research/research_2026-08-19.md` addendum `02:01:06Z`) — the peer shape is
Claude Code's queue-while-working. Scope was decided with the reopening: **next-turn-only
delivery**, never injection into a running SDK stream. Delivery is **sequential** — when the
session returns to idle, a `useEffect` drains one entry at a time through the ordinary `submit()`
path, so a queued prompt is its own turn, a queued `!` its own run, and every entry keeps exactly
the meaning it would have had at idle; joined-as-one-prompt was rejected because a queue can hold a
mix of prompts, `!` commands and slash expansions, which no single string preserves. What refuses
instead of queueing is a closed set (`refusesToQueue`): `/clear`, `/compact`, `/model`, `/exit`,
`/quit` — session-replacing commands whose delayed, unprompted execution would be worse than a
second Enter; they keep SER-010's refusal-with-retained-draft shape, stated as the deliberate
exception. Local report commands stay above the busy check and keep answering mid-turn. The
listing is a fourth **frame-budget participant** (after tools, before the answer, floor 0), one
`queued ·` row per entry with the cut stated, and the busy hint carries ` · N queued` so a fully
cut listing still cannot accumulate invisibly. `Up` from the draft's first visual row takes the
whole queue back into the editor ahead of typed text — the gesture joins the key chain between the
completion menu and prompt recall (`.trellis/spec/frontend/prompt-recall.md`). A **cancel or a
failed turn returns the queue to the editor unsent** (auto-resending into an error is how retry
loops start), a pending permission holds it untouched, and `/clear` drops it with the conversation.
Nothing is recorded at enqueue time: a drained entry becomes a `userInput` at send time, and an
entry taken back or dropped was never sent — trajectory honesty by construction, which is also why
prompt recall needed no change. Free checks: `spike/verify-prompt-queue.ts`,
`spike/verify-tui.ts queue` / `bang`; live: the `usage` scenario's mid-turn half.
