# Architecture — the load-bearing decisions (full rationale)
## `.agents` extension layering

Darwin keeps one execution model while widening discovery. Named skills, agents, and commands reserve built-ins first, then select the highest valid definition from project `.darwin`, project `.agents`, global `.darwin`, and global `.agents`; invalid entries claim no name. Native command hooks aggregate lexical `hooks/*.json` sources in global `.agents` → global `.darwin` → project `.agents` → project `.darwin` Pre and lifecycle-observation order, with reverse source order only for Post. Direct global/project `.agents/hooks.json` files are an explicit second, Codex-shaped dialect ordered before each `.agents` native directory; `.codex` is never read. Dialect identity is retained through regex/glob matching, payloads, output semantics, diagnostics and process ownership. Portable context changes only the affected invocation; plan/retry/permission, direct streaming, trajectory literals and child privacy remain authoritative. Darwin legacy hook files/config are fallback-only and shadowing is reported. Hook paths are executable policy and remain dangerous and un-ruleable.

Custom Markdown commands keep the loaded template bytes. `expandCustomCommand` trims only the argument string: when literal `$ARGUMENTS` is absent and arguments are nonempty, the message is exactly `content + '\n\n' + args`; otherwise the existing `replaceAll` branch or unchanged placeholder-free content applies. Replacement remains all-occurrence, nonrecursive, with its existing JavaScript replacement-string semantics. This intentionally supersedes dropping arguments from plain templates: a supplied target must not silently disappear. There is no positional parsing, shell interpolation, additional file read, or execution channel. `AgentRuntime.expandSlashCommand` remains the shared TUI/dev-repl/text/structured-headless seam; drivers send the expanded message but retain literal input for trajectory. `spike/verify-custom-commands.ts` covers exact bytes, real loading, expansion after source removal, and ordinary runtime/headless turns with a local capture model.

For the native Darwin dialect, `TurnComplete` and `PermissionRequest` are the only lifecycle events. They are driver/visible-prompt observations, not SDK interventions: each matching command receives one bounded closed JSON object, starts without blocking its owner, and has no output or feedback channel into terminal rendering, model context, permissions, tools, or trajectory. Session-scoped detached process groups are cancelled/reaped on turn cancel, `/clear` retirement, startup unwind, and shutdown. Keeping publication at `App.runTurn`, the headless driver, and `PermissionQueue` preserves the invariant that `runtime.ts` alone constructs `Agent` and no Darwin code forks or intercepts the SDK loop.

This is the long-form companion to the "Architecture — the load-bearing decisions" index table
in `AGENTS.md`. AGENTS.md is preloaded into darwin's own system prompt on every request and is
capped at 32 KiB (`MAX_INSTRUCTIONS_BYTES` in `src/agent/instructions.ts`), so it carries only
the index; each table row's "Decision" names the matching `##` heading here, and the complete
reasoning for each decision lives under it, verbatim. This file is the authoritative narrative;
the `spike/` suites named in each section are the executable contract.

## Setup import — offline prompt copies, never executable policy

SER-099 adds exactly `darwin import --from claude-code [--apply]`, dispatched by the bootstrap before `cli-main.ts`, retaining patch preflight and local help/version precedence. The route imports no SDK, config loader, runtime, hook, trust or session code. `import-claude.ts` builds a bounded plan; `import-claude-files.ts` owns its file boundary; `import-claude-snippets.ts` has closed manual-only mappings. It is not a migration wizard, provider switch, history importer or TUI command.

Prompt destinations derive from `extensionRoots`, global scope from `userDarwinDir`, and the manual project permission target from `userProjectDir`. Existing names across all four layers and built-ins are conservatively reserved, even when a source could otherwise take precedence. Skills accept only name/description/body; agents additionally allow an explicit empty tools array. Omitting tools preserves the source's unrestricted inheritance, while nonempty Claude tool names, unsupported frontmatter and dynamic substitution require manual migration. Do not discard restrictions to manufacture a loadable definition. The existing gray-matter YAML parser is used only after verifying the exact plain YAML opener: its executable JavaScript engine must never be selected. Loader discovery is proved with the official installed skill loader and the actual agent loader, not by creating an Agent.

Project root and `.claude/CLAUDE.md` content may append clearly marked sections to `AGENTS.md`; its existing bytes are never rewritten, identical bodies/sections are no-ops, changed sections are manual, and the complete addition must fit `MAX_INSTRUCTIONS_BYTES`. Global CLAUDE instructions have no equivalent global Darwin layer and are reported as manual instead of being silently scoped to the current project. Root CLAUDE fallback remains unchanged and no `@` imports are expanded.

The fixed source allowlist excludes credential/history/session stores and `~/.claude.json`, whose MCP declarations share a file with unrelated user/project state. MCP snippets therefore come only from project `.mcp.json`; settings snippets come from global/project settings and project local settings. Only closed non-secret-bearing shapes produce JSON, using the installed Darwin transport and permission grammars; sensitive-bearing/unknown fields omit the whole MCP entry, never substitute a redacted runnable value. Hook command values are not printed. Snippets are candidates, not policy equivalence: global permissions lose global scope if pasted into the named project store, source disabled/ask/deny restrictions still need review, and a new preferred MCP file can hide fallback servers. Neither scan nor apply writes executable config or consent. Workspace trust and root MCP fallback remain owned by their existing startup paths.

Reads are capped at 400 enumerated entries plus one overflow probe, 256 KiB/file and 4 MiB per scan pass; resources at depth 6 and 100 files, MCP entries and each rule array at 100; rendered output at 32 KiB, with reserved room for the apply outcome and no partial JSON. A capped display refuses apply. The Linux-only file boundary uses no-follow directory descriptors and `/proc/self/fd` paths; `O_PATH` checks regular single-link inodes before opening file data, avoiding symlink/special-file reads. Other hosts fail closed, not through a weaker portable TOCTOU fallback. Source files, destination bytes and listings are revalidated before mutation; new files use exclusive creation, existing instructions are rechecked on their pinned file before append. This is not a filesystem transaction or protection from a cooperating user's concurrent in-place writes/renames: users must not edit setup during apply. An I/O failure stops and reports the completed count and potentially partial current file; nothing is deleted or rolled back. Skill resources are written before `SKILL.md`, so a failed resource write does not activate an incomplete new skill. Scripts are copied with ordinary non-executable file permissions and never run.

Primary format references: [Claude Code skills](https://code.claude.com/docs/en/skills), [subagents](https://code.claude.com/docs/en/sub-agents), [settings](https://code.claude.com/docs/en/settings), [permissions](https://code.claude.com/docs/en/permissions), [MCP](https://code.claude.com/docs/en/mcp), consulted 2026-09-19. Exact supported subsets and omissions live in the bilingual extensions guide. Free verification: `verify-import-command.ts` uses only private HOME/project fixtures, real CLI processes and files, source/target digests, installed loaders, hostile paths, changed-since-scan inputs, failed writes, strict usage and the SDK-free import graph; `verify-cli-args.ts` pins both reference grammars. No import is run against this repository or the real HOME.

## SDK reuse — the agent loop is never forked

**Everything reuses the SDK; the agent loop is never forked.** `src/agent/runtime.ts` is the
only place that constructs `Agent`, and it stays a thin assembly. All customization goes
through SDK extension points: interventions (permissions), plugins (skills), conversation
manager, hooks and `InvokeModelStage` middleware (model retry). If a change seems to require intercepting the loop itself, check the relevant section
below and its `spike/` script first — every non-obvious SDK behavior this project relies on has
a runnable script that proves it.

The pinned SDK is `1.18.0`. Darwin continues to pass `conversationManager` with
`SummarizingConversationManager` and its existing `ContextOffloader` plugin; it does not
select the experimental `contextManager` or the upstream `web_fetch`. The patch still
carries all 15 file changes: upstream has not replaced any of these fixes. Its new root
exports and Responses adapter session-metadata forwarding are preserved when rebasing.
SDK 1.17 removed the QMD optional dependency (it remains an optional peer), so the workspace
no longer needs `ignoredOptionalDependencies` for `@tobilu/qmd`. Checks:
`verify-context-offload.ts`, `verify-web-fetch.ts`, `verify-npm-patch-format.ts`, and the
standalone registry install suite `verify-npm-package.ts`.

## SDK HTTP request — parent-only ordinary gated tool

**HTTP access is an ordinary parent tool, not a side channel.** The parent runtime directly adds
the installed SDK `httpRequest` singleton (`http_request`) to the same `Agent.tools` list as its
other vended tools. The existing composed intervention therefore runs retry policy, configured
Pre hooks, permission classification, the SDK callback, and Post hooks in their established
order. `http_request` deliberately has no safe classifier special case: unknown tools fail closed
as `execute`, so default/auto modes require the ordinary decision and plan mode denies before the
callback. Child catalogues do not include it; widening their capabilities requires a separate
design decision.
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
`web_fetch` — the child-catalogue exclusion this document always stated for
`http_request` is enforced by the same mechanism instead of assumed. Required offline check:
`spike/verify-web-fetch.ts` (in `pnpm test`).

## Repeated tool failures — bounded intervention guard

**One model invocation may execute three materially equivalent failed tool variants, not an unbounded sequence.** The composed SDK intervention observes original `ToolResultBlock`s after configured Post hooks without rewriting them, normalizes a bounded failure class/signature, and denies a later call to that tool before Pre hooks, permission, or body once one signature reaches the limit. A second failure injects bounded evidence-backed-hypothesis guidance before the next model call; the third says to stop, report the blocker and collected artifacts, and ask the user. A new SDK invocation replaces the state. One shared guard remains isolated by Agent, so concurrent children cannot poison each other. Explicit numeric/failed bash status is covered; user-authored `!` commands never enter this model-tool intervention. The pinned foreground bash result exposes its real command `exitCode` for this purpose without changing shell execution or output. The guard counts SDK tool results only, never iterations inside a process the model launched: failures a generated script logs within one successful result stay invisible to it by design (no log parsing, no automatic process stop). Working-method rule 5 of the default base prompt covers that side instead (SRF-035): unattended side-effect code bounds deterministic rejections and pauses with a stated reason, retries transient limits with bounded server-honouring backoff, and reconciles or uses an idempotency key before replaying an ambiguous write; `spike/verify-system-prompt.ts` pins that wording, which is guidance, not enforcement. Required check: `spike/verify-retry-guard.ts` (in `pnpm test`).

## Stream interruption — one driver-owned continuation

**A retryable broken provider stream becomes one visible successor turn, never an SDK-loop retry.**
`AgentRuntime.send` still exposes the original `ModelError` unchanged through `recordStream`, which
closes and appends the failed trajectory turn. The TUI and headless drivers compose
`runWithStreamResumption` around their ordinary one-turn consumers; only the exact measured
`Stream ended without completing a message` `ModelError` qualifies, and the helper can invoke one
bounded anti-repeat continuation prompt once. Because the original user request is not resent, a
model is directed to inspect retained conversation and work before acting, reducing duplicate side
effects. The prompt's last clause (SRF-032) names the one cause a continuation cannot outlive on its
own: when the stream died while a tool call was being emitted, that call was too large for the
stream, and re-emitting the same payload dies the same way (measured twice on one whole-document
`fileEditor create`, `$5.88` and ~20 minutes for zero files written), so the model is told to
re-issue it as several smaller calls — skeleton plus per-section edits — never as one; the
predicate, the single continuation and the second-failure rethrow are unchanged, only what the
model is told. The busy/queue owner spans both attempts, while every attempt still gets ordinary SDK,
permission, usage, cancellation, and trajectory semantics. Headless protocols disclose that recovery
occurred without exposing the private control prompt. A `subagent` child gets the same single
continuation (SRF-026), owned by `SubagentTool` at its `invoke` call site with the same predicate and
the same prompt — on the live child, never inside the SDK loop, the recipe or the runtime; see
§ Subagents. The parent's own `runWithStreamResumption` and `workflow` nodes are unchanged.
Authoritative contracts:
`backend/strands-sdk-contracts.md`, `backend/session-trajectory.md`, and
`backend/structured-headless-output.md`. Required checks: `spike/verify-stream-resumption.ts`,
`spike/verify-headless-structured.ts` and `spike/verify-subagent-continuation.ts` (all in `pnpm test`).

## Model-stream idle watchdog — parent provider reads only

**SER-095 bounds silence, not a turn or agent loop.** `installStreamIdleWatchdog` registers an `InvokeModelStage` wrap after `installModelRetry` (first registered wrap is outermost). It supplies a per-call model facade through the SDK's replaceable `context.model`, delegating all methods to the original provider except `streamAggregated`. The facade advances the provider's original SDK aggregator directly, preserving events, parsing, metadata, model state and guardrail behavior. Each pending `next()` gets a timer, default 120 seconds from root `streamIdleTimeoutSeconds`, finite 0–2147483 seconds including fractions (upper bound avoids Node timer overflow); zero allocates no timer. Every yielded SDK model-stream event, including thinking/signature/metadata, grants a new allowance. The first event and final close are covered. Raw transport keepalives that the provider does not expose as SDK events are not activity.

The timer is absent during downstream consumer backpressure and hooks, permission/tool execution, background completion, token counting and deliberate retry backoff. Children and explicit compaction do not install it. This leaves `send`, `backgroundDelegation.observe`, `recordStream` and the driver streaming order untouched. Bedrock's existing byte-level `requestTimeoutMs` remains independent; disabling this watchdog does not disable transport timeouts.

Timeout aborts a **local provider** controller, never `agent.cancel()` (which would mislabel the failure as user cancellation). The pending read is awaited and the aggregator closed before any failure escapes; late results cannot reach aggregation consumers or launch tools. Middleware `finally` also closes the facade when the SDK's between-yield cancel check stops consumption. User signal wins before expiry and throughout cleanup; the SDK maps its abort to its ordinary cancelled result. No detached iterator race, scheduler or SDK loop fork exists. Supported providers honor abort; a custom provider ignoring cancellation is not detached and can delay cleanup indefinitely. That limitation is intentional: prompt settlement cannot justify a still-running chain that might mutate state.

The pinned direct Anthropic adapter drops `StreamOptions.cancelSignal`, unlike Bedrock/OpenAI. Its official client middleware receives an async-local signal entered only during a parent provider read and forwards it to the HTTP request and public request options (the latter prevents the client's pre-header abort retry). Outside that scope it delegates unchanged; no global fetch, private provider field or dependency patch. `StreamIdleError` is a distinct `Error`, not `ModelError`, so neither throttle retry nor exact interrupted-stream continuation classifies it. The identical object reaches the failed model event, `recordStream` and caller; trajectory keeps `turnEnded.failure`. TUI reuses the ordinary failure notice. Headless text/JSON/JSONL each print exactly one `stream: stream idle for Ns` stderr line; structured output retains ordinary terminal `result.errors` with `stage: turn`, no schema/new event or continuation marker.

Required offline check: `spike/verify-stream-idle.ts` (real runtime fixtures; local HTTP/1 OpenAI/Anthropic and HTTP/2 Bedrock pre-header/body abort; all headless formats including user cancellation; production-CLI pty failure and reuse). Regression checks: `verify-config.ts`, `verify-model-retry.ts`, `verify-stream-resumption.ts`, `verify-headless-structured.ts` and full `pnpm test`.

## Model retry — darwin-owned cancellable wait

**Darwin owns model-call retry through two SDK extension points on the same Agent, keeps the
SDK's schedule, and never sleeps where the driver cannot see or the user cannot cancel.** The
pinned SDK's `DefaultModelRetryStrategy` sleeps inside its `AfterModelCallEvent` callback, and
`Agent._streamCore` runs hook callbacks *before* yielding the event, so a throttled attempt reached
the driver only after its whole backoff, `cancel()` during the sleep was dead until it ended and
then cost one more model call, and a Bedrock pre-stream `ThrottlingException` (a plain `ModelError`
with that exception as `cause`) was never retried at all. `AgentRuntime.create` and
`buildRecipeChild` therefore pass `retryStrategy: null` (the documented opt-out; the SDK's duplicate
warning has nothing to warn about with an empty list) and call `installModelRetry`
(`src/agent/model-retry.ts`) once per Agent — parent, subagent child and workflow node alike, each
with private state.

The installer splits the wait so it is visible and cancellable without touching the loop: the
`AfterModelCallEvent` hook only *decides* — it acts when `event.error` is set and no hook already set
`event.retry`, never once `event.agent.cancelSignal` is aborted, classifies through
`isRetryableModelError` (`ModelThrottledError`, plus a `ModelError` whose `cause` is an `Error`
named `ThrottlingException`; never `ContextWindowOverflowError`, `MaxTokensError`, the exact
stream-interruption `ModelError` owned by `stream-resumption.ts`, or anything else), computes the
delay with the SDK's own exported `ExponentialBackoff` (6 attempts, 4 s base, 240 s cap, full jitter
— the default's numbers, resetting per budget when `attemptCount === 1`), publishes one frozen
`RetryWaitState` (`attempt`, `maxAttempts`, `waitMs`, `until`, `reason` ≤ 200 code points) and sets
`event.retry = true` at once. So the failed event reaches `send()`'s consumer within milliseconds of
the failure. The wait itself runs in an `InvokeModelStage` wrap middleware — the SDK's designed
interception point around one model call — before `next()`: a timer racing the agent's
`cancelSignal`, cleared on both paths. On abort the middleware rethrows the failed attempt's own
error without invoking the provider; the loop's ordinary catch yields the `AfterModelCallEvent` for
it, the hook declines because the signal is aborted, and the turn ends with that error and no
further model call. A true `stopReason: 'cancelled'` is not produced here on purpose: the SDK only
settles it after a provider call reports the abort, and the alternatives are one more model call or
a hook throwing control-flow errors. The TUI already reads an error after Esc as a cancelled
outcome (`turnAborted`); headless reports the error as the turn's failure.

`AgentRuntime.retryWait()` exposes the parent's state for the driver's existing tick; it is cleared
when the wait ends, when the next model call actually begins, and at `AfterInvocationEvent`. A
child's state stays behind its own installer. Trajectory records are unchanged: failed attempts
remain visible only as `modelCall.attempt` gaps and `turnEnded.failure` carries the last attempt's
original error at the cap. No config key tunes this. The schedule's only seam is
`setModelRetryScheduleForTest`, used by the offline suite; production never sets it. Required
check: `spike/verify-model-retry.ts` (in `pnpm test`) — failures delivered before the wait, cancel
settling in milliseconds with no further call, the Bedrock cause retried and another cause not,
exactly `maxAttempts` calls at the cap with the failure recorded, the state accessor populated then
cleared, and a recipe child behaving the same under `dispatches.cancel`.

**Rendering (SER-067) reads that state and adds no row, tick source or channel.** Every surface
names the *attempt about to be made* (`retryNextAttempt`, `state.attempt + 1` of `maxAttempts`) —
"retry 3/6" is the third call of six — and never the provider's `reason` on a live row. The TUI
busy rows (`working…` hint and `thinking…`) append one phrase through the existing `busySuffix`
(`src/tui/busy-suffix.ts`): ` · throttled, retry 3/6 in 12s`, seconds left from `until` against
now rounded up and floored at 0, read on the spinner tick already there (`liveRetryWait`, a
cannot-throw read like `liveSpend`); with no wait the suffix is byte-identical. Headless emits one
additive `model.retrying` event per wait (`attempt`, `maxAttempts`, `waitMs`, `reason` under the
tool-field cap) where the failed `afterModelCallEvent` arrives, deduped on the frozen state object
— the same object is readable on a repeated event and announced once — and text mode writes one
`model throttled, retry 3/6 in 12s — <reason>` stderr line on the channel the tool lines use;
`HeadlessRuntime.retryWait` is optional so doubles built from `send` alone emit nothing new. A
recipe child's wait is published only as the closed dispatch phase `waiting-on-model`
(`attempt`, `maxAttempts` as bounded integers) through the same `setPhase` every other phase uses,
wired from inside `buildRecipeChild` by the installer's `ModelRetryObserver` (`waitStarted` /
`waitEnded`) — never read from the parent: `After*` hooks run in reverse registration order and
`BeforeModelCallEvent` precedes the waiting middleware, so the observer sets the phase and the
`BeforeModelCallEvent` hook leaves it alone while `retryWait()` is defined; a completed wait
returns to `model`, a cancelled one falls to `starting` through the ordinary failed event. The
heartbeat row and `subagent.progress` render it as `waiting on model, retry 3/6`. A failed turn
names how retry ended from `retryOutcome()` (`{ kind: 'exhausted', attempts }` set when the cap
is reached, `{ kind: 'cancelled', attempt, maxAttempts }` set by the middleware on abort, cleared at
`BeforeInvocationEvent`), through the one shared `retryFailureNotice`: `turn failed after 6
attempts: <message>` / `cancelled during retry wait (attempt 2/6): <message>`, plain `turn failed:`
otherwise. Headless text mode adds one `notice: <heading>` line before its unchanged `error:` line;
the structured turn-stage failure gains an additive optional `retry` object; `turn.failed`,
`turnEnded.failure`, `/export` and `formatReplay` are untouched. Required checks:
`spike/verify-busy-suffix.ts`, `spike/verify-headless-structured.ts`,
`spike/verify-subagent-heartbeats.ts` and `spike/verify-model-retry.ts` (all in `pnpm test`), plus
the free pty scenario `spike/verify-tui.ts modelRetry` (one row carries the phrase, ctrl+c inside
the wait yields the cancelled notice with no further call, the cap yields the attempts-made notice).


## Clipboard image input — one transient SDK content-block invocation

**Clipboard images are live interactive input, never durable transcript content.** `Ctrl+O` reads one bounded PNG through platform clipboard helpers and the exact decoder/normalizer shared with the path-based `imageViewer` tool. The pending image is a counted one-row chip and travels with its draft or queue entry until explicit removal or actual queue/send ownership. `AgentRuntime.send` supplies text plus `ImageBlock` to the existing SDK `Agent.stream()` once; unsupported providers fail through the ordinary visible turn-error path, with no capability probe, second call, Agent construction, or loop interception.

Trajectory, replay/export, prompt recall, rewind labels, memory evidence and shell records remain text-only: image bytes, base64, clipboard contents and fabricated paths never enter them. Multimodal trajectory input is the literal user prompt, while model-only expansion/shell reports remain in the SDK content block. The free checks are `spike/verify-runtime-image-input.ts`, `spike/verify-clipboard-image.ts`, and `spike/verify-tui.ts clipboardImage`.

The explicit Ctrl+S stash counts as an image owner too (SER-085): draft, queue,
in-flight invocation and stash share one-image exclusivity. A stashed image blocks
clipboard acquisition, both transfers invalidate `clipboardReadGeneration`, and an
ambiguous conflicting transfer refuses without changing either owner. No notice
contains image bytes. `verify-composer-stash.ts` drives delayed real clipboard helpers
and queue/in-flight handoffs through the production CLI; `verify-draft-stash.ts`
pins exact image object identity and defensive conflicts.

**The shared normalizer caps every image at 2000px on either edge, not the 8000px single-image limit.** Anthropic applies the stricter per-image limit to every image in a request that carries more than 20 image blocks, and tool-result images from earlier turns are resent with each request — so a session that keeps calling `imageViewer` eventually crosses 20 and, with one 8000px-era image in history, fails every later turn (`image dimensions exceed max allowed size for many-image requests: 2000 pixels`). Anything past the cap becomes a ≤2000px WebP; 2000px itself passes through byte-identical. Because snapshots saved under the old cap still hold oversized bytes, `create()` runs `normalizeRestoredImages(agent.messages)` right after the reasoning repair: the same decoder/normalizer, applied in memory to `ImageBlock`s in user content and `toolResultBlock` content, compliant and undecodable blocks left as they are, block order and message identity preserved; the next ordinary save persists it and the trajectory is never rewritten. Required check: `spike/verify-image-viewer.ts` (in `pnpm test`).

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

**A refusal is a class of three SDK stop reasons, named as received, never one provider's word**
(SRF-029, `src/agent/refusal.ts`). Claude's safety classifiers end a turn *successfully* from the
SDK's point of view — a non-`toolUse` stop, an `AgentResult` whose text may be empty — so the
drivers are the only place the outcome can be named. The direct Anthropic provider passes the API's
`refusal` through; the Bedrock provider's `STOP_REASON_MAP` spells the same classifier block
`contentFiltered` and a configured Guardrail `guardrailIntervened`; session
`session-20260908-095403918` lost three turns to the second word while only the first was matched
(one visible character, then nothing, and no notice). `REFUSAL_STOP_REASONS` is exactly that frozen
triple — `maxTokens`, `stopSequence`, `cancelled`, `interrupt`, `checkpoint`, `endTurn` never
qualify — and every notice, the headless empty-reply error and the child-failure note are functions
of the stop reason received, so a classifier block and a Guardrail stay distinguishable and the
`refusal` texts are byte-identical to before. The loop is untouched: no retry, no message removal.
Replay is the one deliberate live/replay difference: the live TUI shows the warn notice with its
moment-bound remedy (since SRF-030 the `refusalNoticeWithRewind` variant — base line plus the
`/rewind` clause the now-catalogued prompt makes true, see § `/rewind`; headless keeps the base
line), while `replayRecords` dispatches a replay-only `refusalStop` reducer action
from the recorded `agentResultEvent.stopReason` — the reducer composes the bounded answer-slot
line `(model declined this request — stop_reason: <reason>)` after whatever text the turn streamed,
so `trajectory replay`, `/export` (`formatReplay(replayRead(...))`) and the resume recap inherit it
from one projection and a record without a refusal-class stop replays byte for byte as before.
Checks: `spike/verify-headless.ts`, `spike/verify-headless-structured.ts`,
`spike/verify-failed-child-text.ts`, `spike/verify-trajectory.ts`.

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

**Offloaded `json` results are searched through a line-preserving projection, never through their stored bytes (SRF-023).** The SDK stores a `JsonBlock` as `JSON.stringify(json, null, 2)`, so darwin's `bash`/`wait` result `{cwd, error, exitCode, output}` is a six-line document in which a 300-line command output is one escaped line — `pattern` found nothing or one 10,000-character "line", `line_range` was "beyond content length (6 lines)", and every miss cost a disk re-read at full prompt size. The pinned patch's retrieval callback now parses `application/json` content when `pattern`, `line_range` or `context_lines` is supplied and searches a deterministic projection: pretty JSON with the stored key order, except that a string containing `\n` renders `<indent>"key":` (array items `<indent>[index]:`) on its own line followed by its lines verbatim at column 0, so `^`-anchored patterns written for the command's own output match as grep would and line numbers from one call stay valid in the next. Non-JSON bytes under that content type fall back to the raw text; `text/plain` is never projected. The projection is built per call from the stored bytes and never persisted: `_storeBlock`, the on-disk bytes, the marker preview, the reference format, eviction and the restored-history repair are byte-identical, and a call without `pattern`/`line_range`/`context_lines` still returns the parsed JSON through `decodeStoredContent`. The tool description states the projection in one sentence. Check: `spike/verify-context-offload.ts`.

**`load_skill` results are never offloaded (SRF-024).** A skill body must reach the model whole in one round: the 1,000-token preview is not the skill — a model that trusts it acts on a truncated procedure — and the retrieval round that follows replays the entire context, so offloading a skill saved nothing and cost one full round (`session-20260904-111433119` seq 308/312). The pinned patch adds one bounded constructor option, `excludeTools?: readonly string[]` (validated as non-empty strings, default none, held as a `Set`); `_handleToolResult` returns early for a listed name after the existing error/delegation/retrieval checks, and the restored-history repair skips those tool-use ids exactly like the delegation/retrieval ones, so a historical skill body is left alone on resume. `src/agent/runtime.ts` passes exactly `['load_skill']`; no other tool is excluded, skill size stays bounded by the skills layer's own caps, children construct no offloader and are unaffected, and the preview, marker, storage, eviction, retrieval tool and json projection are untouched. Check: `spike/verify-context-offload.ts`.

**Observers that need a result's structure read it before the offloader, never instead of it (SRF-036).** The offloader's replacement is the model-visible truth, so the trajectory and every driver keep recording the preview; only an observer that must know what the *original* carried registers at `HookOrder.SDK_FIRST` on `AfterToolCallEvent` (lower order runs first for After events too), where it reads without mutating — the precedent is the cloud-memory `uploadObserver.after`, and the second is the background-task wake's `TerminalDeliveryLedger.install()` (see § "Background-task wake"), which commits an original's terminal id only where the replacement text names it. `bash` is not added to `excludeTools`, the offloader is not reordered or reimplemented, the preview is never parsed for state, and children are unchanged. Check: `spike/verify-task-wake.ts` (a real `ContextOffloader` at `maxResultTokens` just above the preview).

## `/rewind` — an SDK checkpoint branch, never workspace rollback

**A rewind branches authoritative conversation state into a fresh Agent; it never rewrites the source or compensates external effects.** Before editor-eligible invocations, the runtime uses bounded public SDK listings to enforce a hard 100-snapshot rewind capacity, then creates a Strands immutable snapshot only while room remains. Failed/cancelled captures consume capacity; a full cap skips later capture without blocking the ordinary turn, deleting history or hiding existing selectable points. A bounded catalogue makes only SDK-completed captured prompt boundaries selectable — a turn that ended `endTurn` or with a refusal-class stop (SRF-030, the `isRefusalStop` predicate over the same `agentResultEvent`). Both mean the SDK loop ran to its end and appended the prompt and the assistant message, so the snapshot taken before the prompt is a valid boundary; a failed or cancelled turn did not complete the exchange and stays uncatalogued. For a refusal this is the one remedy darwin offers: the declined reply stays in the conversation (the loop is never edited, nothing is retried), and a session whose later prompts kept being refused because of that tail can now cut it out at the refused prompt instead of losing an earlier good answer or the whole context. `completed` keeps meaning `endTurn` for memory sealing and terminal delivery; only the catalogue call reads `refused`. The TUI's refusal notice appends the remedy through `refusalNoticeWithRewind` (composed from the shared `refusalNotice`, so headless stderr keeps the base line byte for byte). Acceptance revalidates the source row, creates a successor through the one `AgentRuntime.create()` factory, restores the source snapshot before dropping any historical ambient-memory block and refreshing current working context/cache, and retires the predecessor only after success. The selected prompt returns to the editor unsent, and the resume pointer stays on the source until the successor completes a turn.

Trajectory remains optional observation and is never used to reconstruct messages. Source latest/immutable snapshots, catalogue and trajectory stay byte-identical. The successor's own record names its origin (SRF-028): its `runStarted` carries `rewindFrom: { session, snapshotId }` — the exact ids `startRewind` handed `create()`, each a non-empty string of at most `MAX_REWIND_ORIGIN_CHARS` (128, the catalogue's snapshot-id bound) or the key is absent, never truncated — while `resumed: false` / `restoredMessages` keep their meaning, so a fresh run that starts with 188 messages is no longer unexplainable from the file; `trajectory replay` prints it as one clause on the existing run header (`· rewound from <session> snapshot <id>`) and the resume recap's title repeats that clause, both through the one `rewindOriginOf` validator, and no other session (fresh, `--resume`, `/clear`) writes the key. Process-owned live permission mode, MCP clients and background jobs transfer like `/clear`; workspace files, shell and `!` effects, hooks, MCP writes, subagents, background jobs and learned-memory files are explicitly *not* rewound. This omission is part of the notice, not documentation fine print. Checks: `verify-rewind.ts`, `verify-rewind-search.ts`, and free `tui rewind`.

**Rewind restores human scrollback as well as model state.** The shared `/rewind` and `/tangent` adoption path re-seeds `<Static>` with `replayRecords` of the source prefix before the selected prompt, after the predecessor's recording append has settled. Optional catalogue `trajectoryTurn` records the actual opening turn ordinal (not catalogue position); it is display-only and never needed to restore an SDK snapshot. Legacy catalogues without that association produce an explicit unavailable notice: even a unique literal prompt may belong to a different turn than the checkpoint's expanded prompt. Missing/ambiguous/disabled/damaged observations likewise produce a visible notice, never fabricated model messages. Repeated branches and resumed branch startup prepend the same read-only ancestor projection through validated project-local `rewindFrom` links, with cycle detection and a 32-session traversal cap. Nothing is copied into a successor's trajectory and `/export` stays the exact single-record replay. `/clear` still empties history. Checks: `verify-rewind-history.ts`, `verify-resume-recap.ts`, and free `tui rewind` / `resume` / `tangent`.

**Esc Esc is a second key for the same opener, never a second opener (SER-059).** Codex and Gemini CLI both bind a double Escape on an empty composer to "go back to an earlier prompt", so darwin binds it to the `/rewind` chooser — but the chooser has exactly one way to open, `openRewindChooser()` in `App.tsx`, which is the `/rewind` command body moved into a callback that the command and the chord both call. Duplicating even the three notices would have let the two surfaces drift, and the pty scenario asserts the shared path by anchoring on the command's own capacity warning and refusal wording. The chord is deliberately narrow: only an Escape that no owner consumed (permission denial, the two search modes, the completion menu and recall all sit earlier and keep their key) and that lands on an empty draft, `status === 'idle'`, an empty queue and no pending permission arms a timestamp; the key handler clears that timestamp on every key before dispatching and only the composer branch re-arms it, so nothing typed, running, queued or pending can be straddled by the chord, and two Escapes further apart than `ESCAPE_REWIND_CHORD_MS` simply start over. It is a `Date.now()` comparison rather than a `setTimeout` because the frame has no place for a "press Esc again" hint and a timer that fires with nothing to draw is a channel with no consumer. Spec: `frontend/prompt-recall.md` § `/rewind` chooser. Checks: `verify-help-command.ts`, free `tui escRewind`.

**`/tangent` is a bookmark over the same path, never a second branch mechanism (SER-083).** kiro-cli's tangent ("a side conversation that inherits your conversation so far; `/tangent` again goes back") maps onto what rewind already has: the return point *is* the checkpoint `send()` captures before the first prompt sent after arming, read back from the runtime's own catalogue (`captureReturnPoint` in `src/tui/tangent.ts` takes the `listRewindCheckpoints()` projection and remembers its newest row plus the catalogue baseline), and the return *is* `startRewind(returnPoint)` adopted through the one successor path `/rewind` acceptance uses (`adoptBranchSuccessor` in `App.tsx`) — same fresh runtime, same omission notice, same stale-row refusal, same live-delegation and busy refusals. No snapshot is taken by the TUI, no second listing shape exists, and `startRewind`'s contract is untouched; the only branch-time difference is `rewindDraftAfterBranch`: `/rewind` hands the selected prompt back unsent, a tangent return hands back nothing, because the user asked to return, not to resend. Scope is one level, unnamed and picker-free — the picker is `/rewind`. *Prompt N* is the 1-based catalogue ordinal, and `N prompt(s) discarded` is the catalogue delta since arming with the return prompt included (A, B, C inside the tangent read `3 prompts discarded`); a first prompt that catalogued nothing (image, background-task wake, failed/cancelled, capacity, over the editor bound) ends the tangent at once with its reason rather than leaving a return that cannot be kept. The state is live TUI session state exactly like the permission mode — never persisted, never in the trajectory, not offered by headless or the dev REPL (`/tangent is a TUI command`), dropped by `/clear` and by a `/rewind` acceptance with one `tangent ended by …` notice, absent in a resumed session — and it is shown on existing surfaces only: a suffix on the header's state word, one optional `/status` row that leaves the report byte-identical when absent. Checks: `verify-tangent.ts` (pure state machine plus a real-runtime arm → A, B, C → return proof in the `verify-rewind.ts` style), `verify-status-command.ts`, `verify-prompt-queue.ts`, free `tui completion`.

## `/compact <focus>` — the SDK default prompt plus one bounded section, built per call

**The `/compact` manager is built per call, and an unfocused call is configured exactly as before the focus existed.** `SummarizingConversationManagerConfig.summarizationSystemPrompt` is constructor-only in the SDK, so `AgentRuntime.compact(focus?)` asks `createCompactionManager(preserveRecentMessages, focus)` (`src/agent/compact.ts`) for a fresh manager every time instead of holding one for the process. Without a focus the config has the two keys it always had — `summaryRatio: 0.8` and `preserveRecentMessages` — and the SDK applies its own `DEFAULT_SUMMARIZATION_PROMPT`; the request is byte-identical to a pre-SER-051 `/compact`, and headless `--compact-before` only ever takes this path. With a focus (trimmed, at most 400 code points; longer is a local notice and nothing runs — no hook, no model call, no `compacting` state), the system prompt is the SDK default verbatim, a blank line, one fixed heading, and the focus as plain text. The focus is never parsed as a sub-command, never added to `PreCompact`/`PostCompact` payloads (`trigger: manual` unchanged), and the reasoning-block scrub inside the patched `generateSummary` covers focused and unfocused summaries alike.

The default prompt is reached only through the package root: the SDK declares it in a module its `exports` map does not expose, so the pinned `patches/@strands-agents__sdk@1.18.0.patch` gains one re-export line in `dist/src/index.js` and one in `dist/src/index.d.ts`. A copied prompt string would drift from what the SDK sends unfocused, and a deep import is unresolvable — both are refused by `spike/verify-compact.ts`, which asserts over the source. The TUI records `/compact <focus>` as it records `/compact` (one `userInput` transcript action, never `AgentRuntime.send`) and the busy refusal still matches on the first word. Spec: `backend/strands-sdk-contracts.md` § `/compact` per-call manager. Checks: `verify-compact.ts`, `verify-help-command.ts`, free `tui completion`, live `tui compacting`; after any patch change, `pnpm install --frozen-lockfile` + `pnpm typecheck`.

**The reduce loop terminates on evidence and treats a swallowed failure as failure (SER-052).** `compactConversation` used to loop `while (messages.length > preserveRecentMessages + 1)` on `reduce()`, assuming every `true` shrank the list; but the SDK summarizes at most 80% of the list (`summaryRatio` clamped to `[0.1, 0.8]`), so a 2-message history can only ever become "a summary of the oldest message plus the newest" — same count, less fidelity, forever (a Host probe made 26 paid, uncancellable summarizer calls). Now every pass keeps a shallow snapshot; a pass that returns `true` without lowering the count is undone (identity kept) and ends the loop, so `compacted` is true only when the count really dropped. The guard is observational rather than a copy of the SDK's split arithmetic, so it stays right if the SDK changes; the recorded consequence is that with `preserveRecentMessages: 0` the floor is two messages and finding it costs one summarizer call, and 2 messages / preserve 0 is an honest `already compact` after exactly one call. Separately, darwin calls `reduce()` without `error`, so the SDK's proactive path swallows any summarization error and returns `false`; inside the loop the SDK has no other `false`, so it is thrown as `SWALLOWED_SUMMARIZATION_FAILURE` and everything is restored — never `compacted: true` from an earlier pass, never a partial result. A sentinel `error` was rejected because it must be a `ContextWindowOverflowError`, the SDK writes it into the thrown error's `.cause`, and `failureFromError` would print that fabricated cause in structured headless output; the real cause already reaches the user through the routed `sdk warn` line. The bug was masked from `780ec93` until `f4e3271` scrubbed reasoning blocks from the summary: the provider rejection that used to fail the second pass had been terminating the loop by accident. Spec: `backend/strands-sdk-contracts.md` § explicit `/compact` scenario, `backend/error-handling.md`. Checks: `verify-compact.ts` (2 messages / preserve 0 → one call, no-op; 16 / preserve 0 → three calls, pass 3 undone; second- and first-pass failure reject and restore; focused manager shares both), live `tui compacting` (seeds two turns, `preserveRecentMessages: 1`, waits for a real `4 → 2`).

**A shrinking compaction leaves one trajectory record, and the drivers share its composer (SRF-027).**
Both `/compact` in the TUI and headless `--compact-before` run `compactAndRecord` (`src/agent/compact.ts`)
rather than `AgentRuntime.compact()` directly: it reads `contextEstimate()` best-effort first (the
anchor is gone once the history is rewritten), runs the compaction, and on `compacted: true` — never on a
no-shrink pass, never on a rolled-back failure — hands `AgentRuntime.recordContextCompacted` the message
counts, that estimate when known, and whether a focus was given. The summary and the focus text never
reach the recorder. What the record is, how replay prints it and why `spend.ts` treats it as an anchor
drop is § Session trajectory. Checks: `verify-compact.ts` (scripted host + real recorder: three
shrinking compactions → three lines, no-shrink and failure → none, bytes free of focus/summary text, both
driver sources go through the helper).


## Permissions — the gate

**Permissions** (`src/agent/permission.ts`): a `PermissionGate extends InterventionHandler`
classifies each tool call by `(toolName, input)` — not name alone, because `fileEditor` spans
read and write in one tool — and unknown tools (all MCP tools) fail closed as `execute`. Static
bash safety is a whitelist on the first word of every segment *and* on its arguments: a
whitelisted `find`/`git branch`/`git log|diff|show` carrying a known mutating option
(`-delete`, `-exec…`, `-D`, `--move`, `--output=…`, …) is `dangerous` with the option named
(spec: `backend/strands-sdk-contracts.md` § Static bash safety).
**Reads are not exempt from the whitelist** (SER-071, `sensitiveReadPath` in
`src/agent/permission-rules.ts`): the `path` of `fileEditor view` and every non-option argument of
a whitelisted bash reader (`cat`, `head`, `tail`, `grep`, `rg`, `find`, `ls`, `wc` — not `echo`,
which with `<` and `$(` already refused can only print its arguments) are resolved (`~`, `~/`,
`$HOME`, `${HOME}`, relative and absolute forms, `..` normalised), and a target in the fixed
sensitive set — anything under `~/.ssh/`, `~/.aws/`, `~/.gnupg/` (the directory itself included,
a listing names the keys); `~/.netrc`, `~/.kube/config`, `~/.docker/config.json`, `/etc/shadow`;
any `.env` / `.env.*` basename anywhere; every path `isSensitiveDarwinPath` already protects on
the write side — is `dangerous` with the path named as the model wrote it (`reads a sensitive
path: …`), exempt from every allow-rule through the same `isRuleExempt` that guards `.env*` and
config writes, and offered no rule; every other read stays `safe` with its old reason byte for
byte. Two boundaries were set at acceptance: `auto` never consults the classifier for a sensitive
read — the request carries `sensitiveRead: true` and goes straight to the prompt, with no
`Classifier` row, because consent to a credential path is not a harmlessness verdict a model can
give (scoped to this flag: `.env*`/config writes and `memory_save` keep the ordinary auto flow);
and for the two recursive *content* readers `grep` and `rg` only, a start path that is an ancestor
of a credential location (`~`, `/home/<user>`, `/`, `/etc`, `~/.kube`, `~/.docker`) counts as
reading it — `reads a sensitive path: ~ (searches above ~/.ssh)` — since `grep -r AKIA ~` reads
`~/.aws/credentials` without naming it; `.env*` basenames are excluded from that ancestor rule (or
`grep -r foo .` would prompt in every project with a `.env`) and `cat`/`head`/`tail`/`wc` read one
named file while `find`/`ls -R` reveal names only, never contents. The criterion is a fixed set,
not the peer's "outside the working directory": darwin
legitimately reads `/tmp`, `/etc/os-release` and the global skill roots, and a set is explainable
in one prompt line. The check changes the *risk*, never the `kind`, so `plan` mode — whose guard
runs on kind alone — lets a sensitive `fileEditor view` reach the prompt rather than denying it
(command-bearing bash is an `execute` and stays plan-denied as before): the honest
cost of a credential path is a prompt every time, not a hard block and not a silent read whose
bytes then enter the provider request *and* the trajectory record on disk. Headless has nobody to
answer, so its bridge denies it like every other prompt; children share the gate; the user's `!`
shell is untouched because its subject is user commands, not model tool calls. Free check:
`spike/verify-permission-modes.ts` (in `pnpm test`).
`plan` mode is enforced before risk, allow rules, classifier, bridge, and configured Pre hooks:
reads proceed, while writes/executes deterministically deny. The same composed intervention
protects child agents. Denial uses `InterventionActions.deny(...)`, never `confirm()`. The UI
side is a `PermissionBridge` (async request → `PermissionDecision`): the Ink `PermissionQueue`
implements it today; `allowAllBridge` exists for non-interactive runs. On turn cancel,
release prompts with `denyPending()` — `close()` latches shut and silently denies everything
afterward.

**The gate publishes every settled decision, and publication is all it does (SER-079,
`PermissionGateOptions.onDecision`).** One frozen `PermissionDecisionRecord` per tool call the
gate judged — `toolUseId`, `toolName`, `kind`, `risk`, the `mode` in force when it settled, the
`source` label (`parent` or `<agent>#<dispatchId>`; children share the gate, so their decisions
are published with their label), the `outcome` (ten names, one per `proceed`/`deny` return:
`write-scope-denied`, `deny-rule`, `plan-denied`, `yolo`, `safe`, `allow-rule`, `classifier`,
`user-approved`, `user-denied`, `restart-limit-denied`), the matched or granted `rule` when one
exists, and `promptedUser` — true only when the bridge was actually invoked for the call, a
withdrawn prompt included. **Never the tool input**: the recorded `beforeToolCallEvent` under the
same `toolUseId` already carries it, so an audit line that repeated a command would be a second
copy of the one thing the record already bounds. A `WITHDRAWN` restart is not an outcome; only the
final settled decision is published, after it is final. A throwing observer is swallowed and
changes neither the action nor its wording (measured against a twin gate with a quiet observer).
The one-record-per-call guarantee rests on where the hook wrapper enters: `ToolHookGate` runs the
deny-rule and plan guards ahead of any `PreToolUse` shell through one gate method,
`guardBeforeHooks(event)`, which publishes the denial itself and returns it — so the gate's
`beforeToolCall` never sees that call; a call that passes there and is denied by the same guards
inside `beforeToolCall` (the mode moved to `plan` while Pre hooks ran) is published there
instead. `denyRuleGuard`/`planGuard` stay pure and publish nothing. The runtime is the only
consumer; it adapts the object to the trajectory's structural record (below). Free check:
`spike/verify-permission-audit.ts` (in `pnpm test`).

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

**Exact approval-time rule review (SER-097).** `a`/`A` select the existing
`suggestRules` result (narrow/whole-tool), never its clipped label, and open review
in the permission region's existing modal frame grant. The full rule is an ASCII
JSON string: reversible escapes keep controls, bidi, combining characters and
surrogates visible instead of letting the terminal reinterpret them; spaces are
escaped too because Ink trims row-edge whitespace. One counted
`Text` per row, no content truncation; Enter traverses each page and only the last
page can save. A too-small grant disables saving, resize resets traversal, `b`
returns without answering, `y` stays once-only, `n`/Esc deny and Ctrl+C cancels.
Ink-flushed page identity prevents a batched key from confirming an unseen
page; request identity and the queue's current/withdrawn checks prevent a stale
review from answering or persisting for a successor. The existing `answerPermission`
save flow and success/session-only failure notices remain the grant lifecycle;
`/permissions` remains its narrowing counterpart. No matcher, generator, exemption,
deny order or automatic approval changes. Free check:
`spike/verify-permission-rule-preview.tsx` (Ink + real App pty + real files, in
`pnpm test`); live checks: `tui approve` and `tui alwaysAllow`.

**Deny-rules (SER-076) are the one permission expression the allow side cannot make: a
prohibition the user writes down once and that holds with nobody watching.** They live in the
same project-scoped file as a second array, `permissionRules.deny`, in exactly the allow grammar
(`bash:git push --force*`, `fileEditor:dist/**`, a bare tool name), validated at load by the same
parser (an invalid entry is a `ConfigError` naming the entry and the field; the global config keeps
refusing `permissionRules` whole), and an absent `deny` is byte-identical to before — the two
session writers (`appendAllowRule`, `removeAllowRules`) carry the loaded `deny` through and omit the
key when it is empty. Four things are load-bearing. **Stage order**: `PermissionGate.decideOnce`
judges deny-rules right after the `workflow` write-scope guard and *before* the plan guard, `yolo`,
the static `safe` check, allow-rules and the classifier — it is the one stage a user-written rule
can *fail*, so nothing that widens (a mode, a matching allow rule, a verdict, an approval) may run
first; a deny therefore holds in every mode, `yolo` included, and binds every child sharing the
gate identically, and a deny wins over any matching allow rule, configured or granted this session.
The hook wrapper (`ToolHookGate`) hoists the same public `denyRuleGuard` ahead of `PreToolUse`
exactly as it hoists `planGuard`, so a forbidden call runs no policy hook shell either.
**Inverted conservatism** (`matchesAnyDenyRule` beside the untouched allow matcher): a bash deny
matches when *any* segment matches, the segments are cut more finely than for allow (also at `$(`,
backticks, parentheses, `&` and redirection), shell metacharacters never exempt it, `isRuleExempt`
does not apply (the exemptions exist so a rule cannot widen; a deny only narrows, so `.env*`,
darwin's own policy files and `memory_save` can be denied), and a file pattern covers every
`fileEditor` call on the path, `view` included. **One bounded model-facing reason**:
`InterventionActions.deny(...)` naming the rule (`blocked by deny rule <rule>`, rule text clipped)
and saying not to retry or route around it and to tell the user — the same `DENIED:` tool result
shape as every other denial, so headless drivers print nothing new. **Configured only**: the gate's
list is frozen, no prompt offers a deny, the session never grants one, `/permissions` lists them
unnumbered as `deny (configured)` and *refuses* `revoke` by name (revocation would widen — the
notice says so and names the file), so "only narrows" is intact; `/status` and the header mode row
(one shared `describeMode`) count deny-rules apart from allow-rules in every mode, `yolo` included,
because they are what `yolo` still refuses. Free checks: `spike/verify-deny-rules.ts` (in
`pnpm test`), plus the status and config suites.

**Permission-rule dry-run (SER-096) is an observer, never a second gate.**
`src/permissions-test.ts` uses `parseRule`, `matchesAnyRule` and `matchesAnyDenyRule` unchanged;
`darwin permissions test <rule>` routes in the bootstrap before `cli-main` imports the SDK,
and `/permissions test <rule>` is a bounded Static notice above busy queueing. Neither
route invokes a tool, hook, model or network, writes policy/session state, or mutates the
gate. CLI reads the current user-owned project rules file only (no global/legacy config
loader); TUI snapshots its current deny list. Missing/damaged CLI policy means unknown,
not no deny. CLI scope is current-project trajectory directories, reverse-lexical ids,
20 sessions; TUI is current session only. Both state that scope and that matcher outcomes
are not safe/plan/yolo/hook execution promises. Candidate grammar is canonical, with a
2,000-code-point command budget; argv requires one quoted argument, TUI keeps the remainder.

The tolerant trajectory reader has an optional bounded read (2 MiB/file, 8 MiB aggregate
here); normal readers are unchanged. The projection understands the SDK's nested wire
ToolUseBlock in before-call and content-block events, collapses exact duplicate pairs
within a session, and never tries to recover a redacted input from another channel.
Truncation, depth/reasoning removal and redaction placeholders make a pair unknown; damage,
missing/stopped recording, unmatched permission decisions and skipped files/entries are
stated. Buffered busy events, children and disabled periods prevent any complete-history
claim. At most 20 pair rows, 240 code points per escaped cell and eight evidence notices
are shown, with omission counts; only display is clipped, not matcher inputs. Symlinked
paths are refused rather than following another project's record. No second history store,
recorder flush, live transcript read, session initialization or resume-pointer movement.
Checks: `verify-permissions-test.ts` (real SDK-projected files, real CLI with invalid global
config, import graph, byte-identical state and busy pty), existing permissions/deny suites,
CLI usage/docs and TUI completion.

## Workspace trust — repository-supplied executable configuration is held until consented to

**A checkout is untrusted input, and nothing it carries may execute or pre-authorize at launch
before the user has seen exactly what it is** (SER-090; `src/agent/workspace-trust.ts`,
`src/tui/trust-format.ts`, `src/tui/WorkspaceTrustPrompt.tsx`). Three things a repository can
commit used to be armed silently by `AgentRuntime.create`: project hook command files
(`.darwin/hooks.json`, `.darwin/hooks/*.json`, `.agents/hooks.json` in the Codex dialect,
`.agents/hooks/*.json`, and the `hooks` key of a committed `.darwin/config.json`) through
`loadProjectPolicy`, project MCP servers (`.darwin/mcp.json` or the root `.mcp.json` — every stdio
entry a process spawned before the first prompt) through `loadMcpClients`, and the legacy
`permissionRules` fallback of a committed `.darwin/config.json`, which granted allow rules on
exactly the fresh clone where the user-owned `permission-rules.json` does not yet exist. The
existing sensitive-path classification protects these files from the *model*; this decision
protects the user from the *checkout*, and it is a separate concern on purpose —
`isSensitiveDarwinPath` is untouched and no second permission channel exists.

The gate has three load-bearing boundaries. **One grammar.** The inventory
(`inventoryWorkspace`) is not a second parser: `inventoryProjectPolicy` in `config.ts` runs the
very `loadHookLayer` the policy activates from, over the project roots only, and
`inventoryProjectMcpServers` in `mcp/registry.ts` reuses the declarative reader `darwin doctor`
already used — so a file the modal lists is exactly a file startup would arm, an unparseable one
is listed as `unreadable` with the loader's own message (a checkout carrying it still carries
executable configuration), and nothing is constructed, registered or spawned by listing. **A
user-owned store.** The decision is `~/.darwin/projects/<key>/trust.json`
(`{ trusted, decidedAt }`, `userProjectDir` like every other user-owned project fact), keyed on
the project root like every other darwin path — never on git state — and nothing under the
project root is ever read as a decision, so a committed `.darwin/trust.json` counts for nothing.
A malformed store reads as "no decision" with a bounded notice: the safe direction is to hold and
ask again, never to grant. **One carried option.** The drivers resolve trust *before* the runtime
exists — `runInteractive` renders the modal in the startup renderer's place, `runHeadlessProcess`
and the dev REPL read the store — and hand the result to `AgentRuntime.create` as
`workspaceTrust`; the runtime stays a thin assembly that passes `projectLayers: 'held'` to
`loadProjectPolicy` and `projectLayer: 'held'` to `loadMcpClients`, which *skip* the project
files rather than fail on them (a held layer was declined, not broken — an unparseable held
file cannot stop startup either), and the same option flows to `appendAllowRule`/`removeAllowRules`
so an "always allow" answer in an untrusted session cannot promote the committed legacy rules
into the user-owned file. Only an explicit `trusted` arms the layers: `undecided` (headless with
no store, the interactive Escape) holds exactly like a stored refusal, because "no answer yet" is
not consent. An absent option means the caller vouches for the checkout — the pre-trust behaviour,
kept for programmatic embedding and the spike fixtures that construct runtimes directly; all
three product drivers always pass it, and `/clear`/`/rewind` successors inherit it through
`createOptions`. User-global layers (`~/.darwin`, `~/.agents`, `~/.darwin/mcp.json`, the user's
own `permission-rules.json`) are never held, and skills, custom commands and instruction files
are prompt content, not execution, so they are not inventoried: a project declaring none of the
three sees nothing new, and a trusted project's hooks and MCP semantics are byte-identical to
before.

What the user sees is bounded and stated everywhere. The modal (frame-budget `modal` exemption;
one `<Text>` per counted row; `trustPromptRows` keeps four fixed rows and gives the items what the
terminal has left, ending with `… N more`) names the root, each hook file with dialect and
per-event command counts, each MCP server with its command and arguments or URL and declaring file
(never `env` or `headers`), and the legacy rule counts; `y`/Enter accepts, `n` declines, Escape
declines for this session only and stores nothing. A held session prints one transcript notice
(`trust: … — held back: hooks: …, mcp: …, rules: …, unreadable: …`) from the same `heldLabels`
vocabulary the headless `trust:` stderr line and the additive `run.started.trust`
(`{ state, held, problem? }`) use, so the three cannot disagree; `/status` appends
` · N held (untrusted project): …` to its existing `mcp` and `hooks` rows and `/mcp` lists each
held server as `held (untrusted project) — declared in <file>; not spawned, no connection
attempted` — stated, never omitted, never probed, exactly the failed-server rule. Headless never
shows a dialog. Free checks: `spike/verify-workspace-trust.ts` (in `pnpm test`: marker commands
in an untrusted checkout never run through inventory, runtime creation, `/clear` succession or a
real `-p` run, and run exactly once trusted), `spike/verify-headless-structured.ts` (the
`run.started.trust` field), `spike/verify-status-command.ts` / `verify-mcp-command.ts` (the
rows), and `spike/verify-tui.ts trust` (the modal, decline/escape/accept/remembered, through a
real pty). AGENTS.md has no row for this decision: the file sits 5 bytes under its preload cap.

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
server stated as failed exactly as `/mcp` words it), skills, hooks, trajectory/diagnostics state, process
token spend and the `/context` estimate (`formatContextValue`, shared with `formatContextReport`).
The `hooks` row (SER-072) is a projection of `RuntimeInfo.hookSources` — the active hook source
files `loadProjectPolicy` already loads, shown project-relative or `~`-abbreviated under the skills
row's own `MAX_STATUS_NAMES` bound, plus the `hookShadowNotices` count — because hooks run commands
on tool and lifecycle events and were previously visible only at startup and in `darwin doctor`.
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

**The breakdown under the total line is computed on demand, by `/context` alone, and never feeds the
estimate** (SER-077; `src/agent/context-breakdown.ts`, `AgentRuntime.contextBreakdown()`,
`formatContextBreakdown`). The total says how big the request is; the breakdown says what it is made
of, so the user can tell a 30-tool MCP catalogue from a long AGENTS.md from accumulated tool
results before reaching for `/compact`. It counts one component at a time through the same
`model.countTokens` the total uses: the system prompt by section as Darwin composes it — base prompt,
`<project-instructions>`, the official `<available_skills>` catalogue, `<working-context>` — with
the base/instructions split taken from the composition seam strings the runtime keeps
(`RuntimeInfo.promptSections`) and the catalogue/working-context blocks read from the live prompt
array through the same conservative parser that orders them (`knownPromptSections`, never a re-split
of joined text; a restored prompt that no longer equals the current composition is counted whole and
labelled `restored`, a foreign shape is counted whole); tool specs grouped by origin — darwin's own
tools as one group, then one row per MCP server attributed by `mcpServerStatuses`' registered names
(never `listTools()`), a server whose names cannot be read getting `not reported` while the built-in
row admits the unattributed tools; and the conversation by role over whole messages. The rows are
labelled an *estimate over the current request shape*: the anchor-measured total above them stays the
authoritative line, and the two are not reconciled. Presentation follows `usageBuckets`: a component
whose count failed reads `not reported`, never 0; a catalogue not yet injected is a stated absence;
MCP-server rows are capped at `/mcp`'s own `MAX_MCP_TOOL_NAMES` with `… N more servers`; the share
is present only when the window is known. It is a separate accessor, not an option on
`contextEstimate()`, on purpose: the estimate is read after every turn by the pressure latch and by
`/status` and must stay at most one `countTokens` call, whereas the breakdown makes one call per
component and a provider-native counter may reach the provider's counting API. `/context` is its
only caller, the total line and `formatContextValue` are byte-identical with and without it, and a
failed breakdown costs the rows, never the line. Free coverage: `spike/verify-context-format.ts`
(rows, bounds, measurement over an injected counter) and `spike/verify-context-anchor.ts` (the
default estimate stays one call before and after a breakdown; `App.tsx` asks exactly once, inside
the `/context` handler).

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
An unknown/invalid model window or failed estimate is absence, never pressure. The latch consumes
`contextEstimate()` only — the SER-077 breakdown is never computed here, so the advisory adds no
per-component counting to the end of a turn. The notice neither
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

The exit hint (SER-092, kiro-cli precedent) is a projection of the same store, from the other end:
`runInteractive` writes exactly one plain stdout line, `session <id> · resume: darwin --resume <id>`
(`resumeHintLine` in `src/cli-usage.ts`), after `waitUntilExit()` *and* after `current.shutdown()`
has settled — the lease is released and no writer is live, so the line is the last thing the process
prints and touches no trajectory, snapshot or pointer. `<id>` is the runtime live at exit (a
`/clear`/`/rewind` successor names itself, never its predecessor), and the gate is
`current.messageCount > 0` rather than a new counter: the SDK `SessionManager` saves the snapshot
`--resume <id>` reads whenever a message was added (`AfterInvocationEvent` fires even on error or
cancel), so "has messages" is exactly "reopenable" — a fresh session left without a prompt prints
nothing, a resumed session still does. The refusal paths (`ConfigError`, `SessionNotFoundError`,
`SessionInUseError`) return before it and `-p` never reaches it; a non-TTY stdout is not a reason to
suppress it. Free checks: `spike/verify-tui.ts resumeHint` (real `cli.ts` through the offline
`startup-cli` fixture), and the headless suites pin its absence from `-p` output.

## Session lease — one live process per session

**A session is open in one process at a time, decided by liveness and never by a flag**
(`src/agent/session.ts` `resolveSession`/`acquireLease`, `AgentRuntime.shutdown`/`retire`,
`src/cli-sessions.ts`; sources: kiro-cli "Sessions can only be active in one process at a time to
prevent conversation corruption", Codex 0.154.0's read-only transcript when the conversation is open
elsewhere). The hazard is concrete: the SDK `SessionManager` writes `snapshot_latest.json` after every
turn and `trajectory/writer.ts` appends, so two darwin processes on one id silently interleave — last
writer wins on both files and nothing warns. So selecting a session — fresh, `--resume`, `--session`,
the `/clear` and `/rewind` successor on its new id — writes `<sessionsDir>/<id>/lease.json`
(`{ pid, hostname, startedAt }`) with `wx`, in the session's *state* directory beside the trajectory:
never the SDK's `session/<id>` (its storage owns that tree and the `/rewind` fork copies it), never
under the project root. `wx` is the whole exclusion primitive: an existing file is read and
classified, live means refused, stale means the file is removed and the `wx` write tried once more,
so two launches racing over the same stale lease still end with one holder. Live is
`hostname` matches and `process.kill(pid, 0)` succeeds — `EPERM` (exists under another user) counts
as alive — and a foreign-host lease, whose pid cannot be probed, is live for
`FOREIGN_LEASE_STALE_AFTER_MS` (24 h) after `startedAt`; everything else, including a record that
does not parse, is stale. Three shapes, all decided before provider/model construction: an explicit
`--resume <id>`/`--session <id>` against a live lease is `SessionInUseError` — the sibling of
`SessionNotFoundError`, caught in the same `cli-main.ts` branch, one line naming pid and start time,
exit 1, never a fallback, headless refusing identically on stderr; bare `--resume`/`-p --continue`
is the forgiving selector and starts a *fresh* session with one `leaseNotice` (`RuntimeInfo`, the
recap header slot in the TUI, one `lease:` line or a `source: "session"` warning headless) — the
pointer is not moved by the refusal, the fresh session claims it on its first completed turn as any
session does; a stale lease is taken over, the rewrite stated in the same notice. A stale lease can
never lock anyone out, which is why there is no unlock file, flag or environment override
(`verify-session-lease.ts` greps the resolver for `process.env`/`process.argv`). Release is
`SessionLease.release()`: `shutdown()` and `retire()` call it last, after every writer has settled;
it removes the file only while it still names this pid and hostname (a later takeover is never undone
by a dead owner's belated cleanup) and then `rmdir`s the state directory if that left it empty, so an
aborted launch leaves no `<id>/` behind for `darwin sessions`/`trajectory list` to count; a failed
`create()` (bad config, failed assembly) releases too. Process death and the unref'd 500 ms exit
fallback leave a stale lease by design — the next launch takes it over and says so. `darwin sessions`
stays a read-only projection: `inspectLease` is one file read and one signal-0 probe, a live row gains
`(open in pid N)` (`(open on <host> in pid N)` elsewhere), a stale lease adds nothing and is *not*
taken over by the listing; the store hashes identically before and after with leases present.
Trajectory and snapshot bytes are untouched; nothing locks the trajectory file itself. Free checks:
`spike/verify-session-lease.ts` (in `pnpm test`: rule, `resolveSession` shapes, runtime hold/`/clear`/
shutdown/failed-create release, and the real `cli.ts` through the offline `startup-cli` fixture —
`-p --resume <id>`/`--session <id>` refused with the lease bytes intact, `-p --continue` fresh with one
`lease:` line, stale takeover released after exit), `spike/verify-sessions-command.ts` (marker and
byte-identical store), `spike/verify-tui.ts resume` (bare `--resume` against a live lease: fresh
session, notice on screen, held session's bytes and pointer untouched). AGENTS.md has no row for this
decision: the file sits five bytes under its preload cap and the rationale lives here.

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

`/setup-agentcore-memory` is both a required/reserved bundled skill and a canonical built-in
command name. The existing official activation expands its full guide inline for an ordinary
turn; no provisioning executor, new SDK loop, cloud call or config write occurs in expansion.
The catalogue carries metadata only; the sole agent-facing setup schema/workflow ships in
`src/skills/builtin/setup-agentcore-memory/SKILL.md`, not repository docs. Loader failures
(including empty bundled bodies) refuse startup; activation errors stop TUI submission rather
than sending unguided slash text. Failed input/images and later queued user entries return
unsent ahead of newer drafts via the ordinary queue return; notifications keep their disposition,
and held shell reports are untouched. Images are reserved across activation as well as send.
`verify-setup-recovery.ts` covers immediate/queued text/image failure and repaired retry.
Completion deduplicates the built-in/skill name. Busy queue
and literal trajectory semantics are unchanged. TUI/REPL and text/structured headless `-p`
all call the same expansion seam; headless missing answers end as questions, not guessed setup.
The guide first reads sensitive existing config through the ordinary gate, then reuses offline
`darwin doctor`, local `cloud-memory status` and bounded SDK `cloud-memory preferences` reads.
Healthy unchanged memory stops without actor/default questions or mutation/restart; empty reads
are connectivity, not extraction/write/topology proof. Missing/disabled setup asks questions;
invalid/denied/failed checks need targeted repair, never reset. Reconfiguration preserves the
saved health result and asks targeted consent. Doctor remains offline; no new production wizard.
Consent is guide policy plus ordinary tool gates, not a new sandbox: setup actor/default and
repair/change confirmation are required even in yolo; cloud upload/adoption remain user-only. Verification checklist:
`setup-agentcore-memory-verification.md`; offline suite `verify-setup-agentcore-memory.ts`.

## System prompt composition

**System prompt composition order is fixed** on every actual model request: base prompt →
`<project-instructions>` (AGENTS.md, `src/agent/instructions.ts`) → official
`<available_skills>` → `<working-context>` (`src/agent/working-context.ts`) → final cache point.
The instructions block is exactly one file from the run directory, never walked up to or merged:
`AGENTS.md`, or — only when no `AGENTS.md` exists at all — the fixed fallback `CLAUDE.md`
(`CLAUDE_FILENAME`); an unreadable `AGENTS.md` is reported and never falls through, both present
means `CLAUDE.md` is not opened, the block's `source="…"` attribute names the file actually loaded,
and the `CLAUDE.md` case carries one fixed line saying `@path` imports are not expanded.
Official AgentSkills injects before each invocation; Darwin registers a later hook that moves that
exact catalogue TextBlock ahead of current working context and cache. Repeated/resumed invocations
remove the previous official block via persisted appState before reordering, so the catalogue is
never duplicated. The working context is the one fragment
that describes *now* rather than rules (cwd, OS, date, one-level directory listing, and the
names of the tools this run registered), so it is
re-derived every run and *replaces* the known working-context TextBlock after restore. The tool
line is read from `agent.tools` after `initialize()` — MCP discovery and every parent-only
registration are complete by then — sorted, deduplicated, capped at `MAX_LISTED_TOOLS` with the
omission stated, and prefixed "names only — each tool's description is its contract". It exists
because the conditional tools (memory pair, cloud recall, MCP) are otherwise invisible to a model
that reads the base prompt and skims descriptions; it is *not* the hand-written catalogue
`279f864` retired, which drifted because it was authored beside the registry rather than read
from it. A caller with no registry (offline suites, the composition tests) omits the line rather
than stating an empty list; the base prompt still names no tool. Current
snapshots carry separate base/catalogue/context blocks plus the final cache point; pre-migration
`[TextBlock, CachePointBlock]` snapshots are recognized, their stale Darwin catalogue is dropped,
and official AgentSkills injects one current catalogue on the resumed invocation. A resumed run
must never state the creating run's date as today's. The base is the only user-replaceable part
(`src/agent/system-prompt.ts`: `config.systemPrompt` > `.darwin/system-prompt.md` >
`DEFAULT_SYSTEM_PROMPT`), so the project's own instructions stay additive on top of whichever
base is in effect. A driver may append one section to that base before project instructions
(`RuntimeOptions.systemPromptSuffix`): the headless runner passes `HEADLESS_AUTONOMY_SECTION`,
which overrides the interactive "ask before implementing a guess" rule for runs where no one can
answer; the TUI passes nothing, so the interactive prompt never carries it.

Custom-command expansion changes only the ordinary user message, not this system-prompt order or the instructions/catalogue. The `.agents` extension-layering section defines argument fallback and its literal trajectory boundary.

**`/review [focus]` is prompt guidance, not an enforced read-only mode (SER-087).**
`parseReviewCommand` (`src/commands/review-command.ts`) is pure and import-free, with the
same exact case-insensitive name grammar as `/init`; bare input is valid and only the
focus's surrounding whitespace is trimmed before literal insertion under `Focus:`.
The fixed prompt asks for repository instructions, staged/unstaged changes, relevant
untracked files and surrounding code; prioritized actionable bugs with file/line evidence
and impact; separate test gaps; no speculative/style-only findings; and honest no-findings
and unverified limits, including tests not run. It asks for no edits or commits unless
separately requested. That sentence never changes the gate: `/review` does not switch
permission mode, install a tool/executor, interpolate shell/templates, or start a child.
Only the subsequent ordinary model requests can call tools, through the existing gate.

`AgentRuntime.expandSlashCommand` checks it before skills and custom commands. Canonical
reservation and its one-line description feed help/completion; `MAX_HELP_COMMANDS` and
`MAX_COMPLETIONS` keep all built-ins offered. Existing custom `review.md` commands receive
the normal collision diagnostic; a same-name skill stays loadable by `load_skill` but loses the slash invocation.
Rename colliding extensions to an unreserved name such as `audit`. The TUI/dev-repl and
text/structured headless drivers use their ordinary send path: busy TUI submissions queue,
images retain their existing ownership, and trajectory input stays literal. Nothing enters
the system prompt or changes its composition order. Required offline checks:
`verify-review-command.ts` (parser/template, purity, collisions, real runtime/headless SDK
capture and gate denial/approval) and `verify-review-drivers.ts` (production TUI queue and
clipboard image plus dev-repl requests/trajectory); both in `pnpm test`. Real free
`spike/verify-tui.ts completion` proves discovery with the renamed custom fixture. These
checks verify transport and policy boundaries, not model review quality.

**The base prompt names no tool.** Tool descriptions are the contract the model reads; a
catalogue in the prompt shadowed the real registry in both directions (it listed the memory pair,
which is registered only when memory is on, and omitted `http_request`/`web_fetch`, which always
are) and carried bash mechanics that belong beside the schema. The bash `mode` requirement and
the tty-less-ssh hazard live in the bash tool's description and parameter text
(`src/tools/background-bash.ts`); `spike/verify-system-prompt.ts` pins both the absence and the
new home. The audit that produced this (2026-09-04, target Claude Fable 5.1) also re-baselined the
output-style bullet — lead with the outcome, readability over compression, say when user-facing
text is wanted, and state that the user does not see full tool output.

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


## AgentCore Memory — optional, scoped, user-authorized cloud data

`src/agentcore/` is separate from `src/memory/`. Disabled means no controller, tools,
network or cloud state. The validated host config fixes region/resource/actor/strategies;
project ID is independent and lowercase, explicit or derived from `projectKey`. No AWS
identity inference. Only parent `episodic_recall(intent,limit)` and
`reflection_recall(useCase,limit)` are ordinary network tools, fail-closed execute like
`http_request`; the child catalogue excludes both, and no SDK loop or trajectory schema
changes. Tool parameters cannot set scopes. Every returned namespace and strategy is
validated before content decoding. Stored episode/reflection JSON uses strict flat schemas:
episode strings `situation`, `intent`, `assessment`, `justification`, `reflection`, plus ≤64
ordered `turns` with string `situation`, `intent`, `action`, `thought`, `assessmentAssistant`,
`assessmentUser`; reflection strings `title`, `use_cases`, `hints`, `confidence`. Required
intent/assessment and use_cases/hints must be nonblank; unknown keys, wrong types, decoded
unsafe controls and malformed JSON fail closed. The existing 12,000-character cap precedes
parsing; accepted shapes have at most three nested levels and 455 values. JSON content is
returned as the exact original text, never reserialized/coerced or converted to XML; hashes
still bind original bytes. A leading `<` uses the unchanged bounded XML ordered-tree parser
(no DTD/attributes/entity expansion), with the original kind checks. No JSON-to-XML error
fallback or scope weakening. Preference parsing/adoption is unchanged. Reflection confidence
is preserved as evidence of usefulness, never converted to correctness probability.

User preferences are host-retrieved once per runtime before the first model request.
Later sends/compaction only reread local approval/revocation; explicit preferences/inspect
refresh cloud data, and successors reload. Remote edits are detected on refresh/new session,
not pushed. Denied preCompact runs before retrieval. Compact/multiline preference JSON is
bounded and validated (stored object or extraction array, optional language); original bytes
bind approval, generated context is not user quote evidence. Only a locally inspected and user-confirmed
content hash bound to resource/region/actor/record/strategy/namespace applies, as escaped
untrusted data nested in the refreshed working-context block, before the existing final
cache point. Callback replacement preserves literal dollar metacharacters; failed prompt
refresh blocks the next invocation. Separate inspection/adoption files prevent stale inspection
from resurrecting forgotten approval. Generated explicitness/citation claims never establish proof. Missing/edited
proof fails closed; a stored approved hash differing from the fetched record hash is counted
in bounded status as requiring inspect/confirm re-review after local context checks. This includes
CLI-to-SDK metadata timestamp formatting differences, not just remote content changes. No
hash weakening or automatic proof migration; byte-identical approvals survive. Forgetting
immediately drops approval and live context. No automatic
promotion or local-memory migration. Cloud deletion is a distinct user command with a
fresh scope check. Model provider and permission policy remain independent.

**`/cloud-memory list [kind] [after <token>]` is the user's read-only record panel, never a
retrieval channel.** Deleting a preference required knowing its id, and `preferences` only
surfaced the five best semantic hits — records the ranking never chose stayed invisible and
undeletable. `list` issues one `ListMemoryRecordsCommand` (a fifth transport
operation; same client, same byte/structure bounds) for one kind — `preferences` by default,
`episodes` (sessions prefix) or `reflections` (project namespace) — with the strategy filter
and a 32-row page, and prints id · time · a 120-code-point one-line preview per record. The
whole page passes `validateRecordScope` before any content is decoded, so a namespace or
strategy mismatch refuses the page like `recall`; unlike `recall`, a record whose content
fails its kind schema is still listed by id with the text withheld, because the user must be
able to see and delete what darwin cannot read. Other-kind records under the same prefix are
counted as omitted, never shown. Paging uses the service's opaque `nextToken`, bounded to the
400 characters the 500-character management line can carry; a longer token is reported as an
unfollowable next page rather than truncated. The listing is available to the read-only
standalone CLI, touches neither `approvedContext` nor proof files, writes nothing and reaches
no model: adoption still goes through `inspect` and `confirm`. Checked by
`verify-agentcore-memory.ts` and the grammar assertions in `verify-cloud-memory-storage.ts`.

Uploads require trajectory plus manual mode or project-authorized auto. New turns use `darwin-upload-v2`, not
trajectory reconstruction: a synchronous/no-I/O/nonthrowing bounded observer reads public
parent BeforeToolCallEvent (SDK_LAST) and AfterToolCallEvent (SDK_FIRST, before ContextOffloader).
The latter is labelled pre-after-hook execution evidence, not necessarily final model-visible
output: interventions may transform it. BeforeToolsEvent supplies bounded requested input
when batch cancellation skips individual calls; ToolResultEvent supplies an explicitly labelled
fallback for observed batch cancellation, generator errors or background acknowledgements.
Public fallback never overwrites an execution snapshot. A background acknowledgement is
stored separately from the final result. An open originating turn receives the original
completion; after seal, a late TOOL record carries the original turn/ordinal/invocation
reference in the next ordinary turn receiving the existing background forwarded After event.
Hook capture copies pre-after-hook evidence; forwarding consumes that copy once, never
traverses SDK synthetic history or child conversations, nor creates a USER goal/wake/upload
channel. Weak invocation keys plus at most 64 copied origins and 16 pending 8 KiB late
bodies survive between turns; capacity/cancellation losses are counted in status. Cancellation
revokes pending background correlations; shutdown and startup unwind close the collector.
No SDK loop/executor change, event mutation or trajectory schema/bytes/order change. The
existing durable closing-append settlement callback is required for detached local publication;
it joins the natural driver-completion seal described below, without observer I/O.
Disabled upload installs no hooks or collector. Failure/early return closes collection; failed
trajectory/pre-stream abort discards it, nondurable settlement consumes it, saturation refuses
and counts turns, successor/shutdown clears it. Invocation-state identity plus SDK tool-use ID
pairs results; local scope/attempt ordinals distinguish records. Reuse within one state lacks
a public attempt token, so later attribution is refused, never guessed. A bounded 512-key
identity/obligation ledger retains evicted-action tombstones independently of the 64 bodies
and 96 summaries. Monotonic semantic flags (`sourceUnavailable`, `identityAmbiguous`,
`resultUnavailable`) record detected faults before projection/fitting, never by searching
bounded explanatory strings. Unresolved obligations survive both retention windows; a safely
matched final result resolves one exactly once before seal, even after body AND summary eviction.
An acknowledgement never resolves it. Ledger exhaustion fails closed without dropping identity
proof; `finish()` freezes unresolved totals and releases correlation. An observed result updates
retained status/exitCode/failure; failure text can recover an action with explicitly absent input.
Summaries include invocationScope; results whose summaries were also evicted have a separate
counter, not a veto by themselves. Detection remains bounded, not complete source discovery:
deliberate media exclusion, traversal/text truncation and unknown original byte length are not
semantic faults. Excess identities are explicitly unmatched. Invocation-state identity rejects unrelated late results from another turn. No observer upload, model summary, extra model call, backfill, path reads,
child traversal or offload/archive hydration.

Every tool name and textual argument/result is eligible, including arbitrary MCP, public
subagent reports and memory tool output. No secret-word/path/name redaction: this can contain
secrets and is NOT a confidentiality guarantee. Assistant prose/reasoning and binary/media
blocks remain excluded; separate preference/local-memory publicProse policy is unchanged.
USER is literal submitted text (bounded exact head/tail); one TOOL is an ordinal/SDK identity
plus input and corresponding result; OTHER carries provenance, outcome and categorized loss.
SDK status and structured bash exitCode remain separate; missing results are explicit and
endTurn never means task success. Manual sends still require exact preview + hash authorization.

Bounds: 8 KiB per full action, **96 KiB for newly generated serialized CreateEvent** including
JSON escaping, 100 payload messages, 100,000 UTF-8 bytes/message. Legacy read/state/transport
limits remain 256 KiB; never lower acceptance bounds or regenerate old bytes/proofs. At most eight transient turns, each 64
full actions + 96 omitted-body summaries + an 8 KiB goal, and eight detached jobs. Collector
turn saturation and detached-job saturation have distinct omission counters/reasons. Reserve
goal/closing metadata; collector retains newest 16 plus priority history, while final upload
selection favors the final action, then failed/immediate recovery actions, then recent history.
Render chosen pairs in original chronology. Summaries spill into counted aggregates. Content truncation,
action bodies/summaries omitted, internal events, missing/unmatched results and source loss
are distinct. No goal and no action means no metadata-only candidate. Text ranges are exact
UTF-16 offsets at Unicode boundaries; retained/original bytes are UTF-8. Huge strings above
262,144 UTF-16 units explicitly leave original byte length unknown, avoiding unbounded scans.
Zero/empty text budgets retain exact empty ranges, including lone surrogates; clipping walks
bounded codepoints once rather than repeatedly encoding whole prefixes. Only genuine high/low
pairs affect boundaries. Generic textual JSON `type: image/audio` remains eligible; structured
SDK media sources and MCP data+mimeType payload shapes are excluded, not type strings alone.
Capture discovers bounded descriptors before byte allocation (no getters/toJSON), then shrinks
largest strings against the full serialized action including metadata/escaping; small sides
leave their space to the other side. Short complete collections stay intact; long arrays/SDK
content retain 16 prefix + 16 suffix entries with exact indices and omitted-middle metadata.
Known short object siblings and result endings survive large earlier values. JSON traversal
caps at depth 8 / 128 values / 32 entries per container, four detailed losses plus aggregate.
Discovery copies at most 8192 bytes per string; bounded temporary snapshots are pruned before
retention, without source references or unbounded source serialization. Engine object enumeration is not a hard real-time guarantee against hostile
Proxies; production SDK inputs are JSON. Upstream loss indicators are marked, not hydrated;
unmarked upstream loss cannot be recovered. See `agentcore-upload-projection-verification.md`. Immutable bounded outbox entries retain
session/turn/order and truthful failed/cancelled/incomplete states; endTurn is not task
success. Three durable reserved attempts maximum, stable CreateEvent clientToken/body
across restart; event acceptance never claims episode generation. No pending eviction.
User-only discard/clear-accepted free bodies after durable receipts; legacy 256-token ledgers
stay readable, new per-token partitioned receipts never evict proof. No-clobber publication links synced private temporary files; incomplete
staging cannot become an event/reservation. Cross-process outbox locks refuse in-flight work;
crash-held locks/legacy corrupt final entries need manual repair, never silent order skipping.
Standalone CLI permits only read-only status/preferences/inspect/pending/preview and reports
failure metadata as nonzero exit. Bootstrap routes this command before runtime imports
(the SDK bash module installs exit-zero signal handlers); cancellation therefore drains
and exits nonzero without modifying global handlers. No proof mutation via CLI or development REPL. TUI user
submissions own mutations; hashes bind content, not human origin. Arbitrary approved shell
is not a sandbox. Clear/rewind preserve external effects/outboxes, rebuild controllers and refresh
preferences. Management captures a fresh AbortSignal before its first await; publication
and SDK request launches check it, including after credential resolution. Shutdown cancels and tracks
management promises plus local work with a two-second drain cap; late cancelled work cannot
publish approval/start AWS, while already-issued effects and received acknowledgements stay
truthful. Runtime cancellation generation spans local context/proof reads through send/compact
invocation, without resetting the preference cache. Crash before candidate
persistence can omit a turn, deliberately without archive recovery.

**Prospective Memory session budget.** Each new v2 body carries
`memorySession: { version: 1, maxEvents: 1, maxBytes: 98304 }` and uses
`darwin-part-<existing clientToken>` as the transport session ID. The token remains the digest
of binding/Darwin session/turn/closingSeq; source provenance, auto proofs, session stops and
pending order remain keyed to the original Darwin session. The reader validates both mappings
and the new budget. One immutable event per derived session bounds accumulated unique input
without a mutable allocation ledger; retries reuse the same body/token/session and rely on
CreateEvent idempotency. Different closing sequences sharing a turn still get distinct sessions.
No numbered-turn bucket, archive scan, timer, model summary or new config is needed.

The 96 KiB serialized byte cap is conservative, not a measured tokenizer result or an AWS
rate guarantee. AWS documents **50,000 tokens/min per episodic session** (not adjustable) and
**150,000 tokens/min per account/Region** (adjustable); TPM is not a lifetime context limit.
Service prompt overhead and account-wide extraction remain outside this budget. See
[Memory quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html#agentcore-memory-service-quotas).
Cross-turn episodic grouping is intentionally traded for a strict unique-event byte bound;
project namespaces still group retrieval/reflections. Quality displays the byte budget explicitly.

Unpartitioned historical candidates are held manual before automatic attempt scheduling and
at auto launch, without body/proof migration or held-state writes. Concurrent user cleanup
is tolerated only when durable receipt/acceptance explains a failed new body read; unexplained
missing/corrupt state still fails closed. They stay readable and
explicitly preview/sendable at the original bounds, and still block later Darwin-session turns.
No extraction-job retry/backfill or real cloud cleanup accompanies the upgrade.
Tests: `verify-cloud-memory-partitions.ts`, upload and cloud-auto/storage regression suites.

**Project auto authority and storage.** `project-identity.ts` retains the existing explicit global
projectId-or-SHA256(projectKey(root)) cloud namespace/quota identity without importing config.
Override/consent identity is ALWAYS SHA256(projectKey(root)): symlink aliases share consent;
separate working trees, including git worktrees, never do merely by sharing a cloud namespace.
Status/doctor label `local key` separately from `cloud namespace`. `project-overrides.ts`
is a strict typed registry: defaults < global < matching project, in both file forms and live
model switches/successors. Only upload/daily limits and command-owned authorization are
registered; unknown/prototype/recursive/model/permission/identity overrides are refused.
The 1 MiB config and 1024-entry map bounds are independent of configurable daily quotas.
All global config writers fresh-read under one private cross-process lock, preserve unrelated
JSON, sync/atomically publish, reject symlinks and refuse overlap/crash locks. Root auto is
not authority: only an explicit matching canonical project auto entry with strict authorization
`{version: 2, epoch, at, scope, project}` authorizes requests. `project` is the canonical local key;
`scope` retains the legacy cloud binding hash. V1 authorization/provenance and old cloud-ID-keyed
entries remain readable but inactive, requiring user reconfirmation, never migration or backfill.
Manual v1/v2 event bytes, scope/body hashes and preview proofs remain unchanged.
The idle user TUI auto/manual path persists local policy without model/tool/conversation reset;
mode switches preserve collected evidence and manual proofs. Enabled manual/off controllers read
fresh local policy on new-turn/model/clear/rewind/status boundaries even without an old override;
malformed policy disables auto without failing the ordinary turn. Fully disabled runtimes stay
controller-free. No programmatic consent tool.

`begin` snapshots the active authorization for new turns, separately from immutable projection
bytes. A bounded eight-turn join waits for durable settlement and the driver's `sealTurn`
completion verdict, in either order, before detached publication. Auto requires a true verdict
from natural `AgentRuntime.send()` completion; a false verdict can only publish manual evidence.
A final SDK `agentResultEvent`/`endTurn` alone is not that seal. Abandonment/cancellation holds manual even
if settlement truthfully stored `endTurn`: never rewrite outcome, body, trajectory or errors to
manufacture a cancellation. Event publication precedes the separate hash/provenance record. Old
manual/legacy/pre-enable turns are never eligible, including after re-enable; all bounded copied
late-result origins must belong to the same epoch, independently of retained action bodies.
Closed failed tool work can qualify; no success inference. Cancel/incomplete/provider failure,
observer errors, semantic source/result unavailability, identity ambiguity and unresolved
obligations hold manual. Goal-only/ack-only management does not send; deliberate media exclusion,
bounded truncation/traversal and unknown source byte length do not veto. Existing public observer
hooks remain synchronous/nonthrowing/no I/O and SDK loop intact.

Clear/rewind first run the existing background-delegation refusal guard, then call
`stopAutoForSuccessor`: synchronous suspension/abort and false seals precede the first await.
Before policy refresh, checkpoint validation or successor construction, upload-enabled or
project-overridden controllers persist `${digest(session)}.session-stop.json` in the outbox,
under the same config lock as request launch. Final locked launch validation rereads this
marker, so peer senders cannot cross a completed stop. This origin-session marker bars stale
proofs from successor/restart drains without revoking project consent. A stale checkpoint or
construction failure conservatively leaves predecessor auto stopped, with a cloud-status notice;
conversation/tools remain usable and old-session work remains manual. Future successor sessions
inherit project auto for their new turns. Suspension stays visible across peer refresh and
reconsent (which explicitly requires a new session); restored origins reread their stop marker.
A session-stop refusal is not an epoch-wide transport stop. Guard refusals do not suspend auto. Already-issued
requests cannot be undone; received acknowledgements remain durable and truthful.

The manual sender core owns both gates, reservations, ordering, transport and acknowledgements.
Auto passes are detached, serial, at most eight candidates per pass, no daemon/model/tick.
New publications during an active pass coalesce into a finite followup; held/budget/order states
never reschedule themselves. Publication carries its originating turn's signal through delayed
settlement, never borrowing a later turn's signal. A fresh activity arriving during a cancelled
pass's late ACK owns a fresh-signal followup after old ownership releases. Same-process sessions queue behind the active outbox owner, with
per-controller cancellation checked before their pass; cross-process contention remains fail-fast
and needs later ordinary activity. Old epochs are excluded before candidate slot counting.
Accepted ACKs/receipts and discard tombstones are skipped before held/order/slot accounting,
both during proof collection and again while draining the snapshot. A raced manual ACK consumes
no request slot, cannot block its session and cannot starve unrelated sessions.
Publication has a separate bounded local lock so network work cannot block new event files;
sends and retention/manual cleanup share the original outbox lock. A body/pending-capacity
publication refusal still earns a finite expiry/drain pass under live uncancelled authorization.
The omitted candidate is not retried or backfilled; capacity/held/budget alone never creates a
self-rescheduling loop. Existing 4096-body/512-pending bounds and manual-data protection remain.
Earlier pending blocks only its session; other sessions retain request slots. Budget-paused
candidates resume only on later ordinary activity with the same active authorization. Every
attempt is reserved durably, counts exact Smithy wire-body UTF-8 bytes (including multibyte
JSON) against one UTC project ledger, and conservatively consumes quota on unknown ack/cancel.
Defaults 500 attempts/104857600 bytes; validated maxima 100000/107374182400. Outbox and quota
locks prevent process/restart bypass, including checkouts sharing explicit project identity. Three stable token/body attempts total; 250/500ms cancellable
backoff for network/429/5xx. Permanent transport/IAM failures persist an epoch-bound stop.
Fresh user reconsent resets the HTTP 403 stop latch (also when discovered through peer policy
refresh), not the held first token or same-session ordering barrier. Explicitly discard that held
token before later automatic drain; old stop bytes and manual bodies/proofs are not rewritten.
Launch linearization: after credentials/signing, stop reads and quota/attempt reservations, the
pre-HTTP handler acquires the SAME config-write lock used by native commands. Within it, read
fresh bounded local policy and the origin-session stop marker, validate v2 project/scope/epoch and cancellation, then synchronously
invoke the underlying request handler, with no intervening await. Return a boxed pending response
so the lock releases before awaiting network; response rejection is observed during release.
Native manual publication completed first bars launch; launch first is an already-issued effect.
Lock contention fails promptly, never waits on credentials/network or steals a crash lock. Arbitrary
noncooperating same-user file edits are not a security boundary. Shutdown/clear/cancel stop owned
requests and retain exact acknowledgements, with the existing two-second drain, not a daemon.

Auto acceptance retains a per-token receipt before any expiry. Only auto-accepted bodies expire
at seven days during later authorized activity; pending/manual/failure/cloud data never expires.
Body cap 4096, pending cap 512, directory cap 32768 suit seven days at default throughput;
capacity refuses new candidates visibly. Receipts use 256 prefix partitions, each ≤4096 files;
lookup is per-token plus bounded legacy ledger, never whole archive. Full partition stops before
network/removal, no proof eviction. `pending [accepted] [after <64hex>]` is a local read-only
projection: actionable (including held/interrupted discard cleanup) by default, accepted bodies
in a separate view; both counts, ≤64 rows/page and next cursor when needed. Strict lowercase
64-hex cursors use stable token ordering, not a snapshot: newly added earlier tokens require
restarting the listing. The standalone CLI uses the same grammar/projection without network,
file writes or proof creation. User-only `discard-legacy` previews ≤256 unaccepted non-v2 events
in this exact binding, then requires
manifest hash under the outbox lock; TOCTOU refuses, all tombstones precede deletion, committed
manifest allows restart-safe partial cleanup. Accepted/v2/foreign/cloud data never included.
Checks: `verify-cloud-memory-integrity.ts` (semantic obligations beyond both retention windows),
`verify-cloud-memory-lifecycle.ts` (natural seal/durable join, predecessor stop and ACK truth),
`verify-cloud-memory-storage.ts` (terminal skipping, capacity activity, pending cursor and 403
reconsent), plus `verify-cloud-memory-auto.ts`, `verify-cloud-memory-acceptance.ts` (isolation,
native linearization pauses, peer refresh and in-flight publication), existing
upload/memory/config/doctor/setup suites, free `tui cloudAuto` and `tui completion`.
Current versus historical verification status is recorded in `cloud-memory-auto-verification.md`.

Transport is the official `@aws-sdk/client-bedrock-agentcore@3.1127.0` data client with four
public Commands, never a generated Strands memory/session manager: automatic extraction upload
would bypass the manual outbox. One direct runtime dependency, no CLI/CDK/private imports.
CreateEvent inputs cap at 256 KiB serialized UTF-8 bytes; other inputs retain 32000 bytes.
Only immutable event files allow 257 KiB (request plus envelope), while proofs/receipts and
other state retain 64 KiB. Existing legacy body/hash/token/authorization bytes are never
regenerated; OTHER-only legacy refusal remains. The public runtime extension wraps the SDK HTTP handler,
checking cancellation immediately before launch and bounding streamed bodies before collection
and SDK parsing (256 KiB success, 8 KiB error). Successful JSON has a 16-depth/10000-node guard;
unknown structure fields that Smithy would drop are refused. One exact exception is the live
RetrieveMemoryRecords envelope `searchType`, absent from the pinned SDK model: require a nonempty
string of at most 64 UTF-16 code units, reject controls/format/surrogate/line separators, then
omit only that top-level hint before raw-versus-decoded checks. It is not record or policy data;
other operations and nested fields remain strict. SDK Dates normalize to ISO strings;
only the SDK top-level `$metadata` envelope is stripped, never memory metadata. Existing record,
XML and scope guards still decide trust. Get/Delete carry the fixed preference namespace IAM
condition, not new mutation authority.

`maxAttempts: 1` leaves finite retries to durable outbox reservations. A total deadline spans
credential resolution through body consumption. Cancel/deadline races the SDK promise so a
blocked credential provider cannot hold the caller; the per-request HTTP guard prevents late
credential completion from issuing a signed request. Credential-provider internal work may finish
later, but cannot start a memory request. Each controller cancels only its own requests; close
also destroys its client/handler. Already-issued effects are not undone, and already-received
acknowledgements still persist through the existing management cancellation windows. Errors
expose only bounded fixed text/HTTP status, never raw SDK messages, credentials or request IDs.

The standard credential chain uses an independent official client configuration/default-provider
factory and HTTP handler. Nested STS has no memory operation signal and returns XML, so it must
never inherit the memory guard; missing-signal memory requests are still refused. `role_arn` plus
`source_profile` is verified through actual STS XML and assumed-credential signing on loopback.
Nested credential clients receive `maxAttempts: 1` and `ignoreConfiguredEndpointUrls: true`,
with their normal profile/SSO region selection. Environment/profile/container credentials and
metadata disabling remain unchanged; container URIs, IMDS, SSO and credential processes are
trusted credential-source configuration, not arbitrary model endpoints. AgentCore region stays
host-fixed. Configured service endpoint URLs are excluded without process-global environment
mutation. Destroy closes both owned handlers; credential work may finish after cancel, but the
memory guard prevents late AgentCore requests. Legacy absolute `cliPath` is validated/accepted only for compatibility,
ignored with a bounded status/CLI notice, and omitted from new examples. No runtime subprocess,
stdin, capability skeleton or temporary request-file path remains. Existing private durable
outboxes, proofs, namespaces and actor identity are unchanged; no automatic migration or upload.
The infrastructure `agentcore` CLI is separate and optional. Existing-resource import is deferred:
its verified schema drops `namespaceKeys`, and import filters `{memoryStrategyId}` templates.
See `agentcore-cli-memory-plan.md`; no deployment/import/IAM changes belong to the runtime.

Hierarchical recall validates all scopes before omitting in-scope other-kind results with
underfill reporting; sibling-root XML fragments remain ordered. No live repository uploads or
credentials changes. Guide: `docs/user-guide/agentcore-memory.md` (and Chinese).
Checks: `verify-agentcore-memory.ts` (offline actual Agent/gates/files/SDK signing and loopback HTTP),
local memory/trajectory/clear/rewind/status/help/config suites, free `tui completion`.
`verify-agentcore-memory-live.ts` requires explicit disposable configuration and synthetic
upload consent; absent that, live transport/extraction remain unverified.

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
no-follow parsing, `0700` directories, `0600` atomic files and `/memory list|show|edit|forget|remember` remain.
Version-1/2 state is read through a deterministic atomizing migration; only currently revalidated anchored
facts survive an authorized mutation, and trajectories are never rescanned or backfilled.

**`/memory edit <id|number> <fact>` is the deterministic correction; a corrected key is user-owned.** Forget
plus remember lost the structure — key, category, title, anchor — and left the wrong fact free to return. An
edit of a user note rewrites it in place (fresh id, since ids derive from time plus text). An edit of a
generated fact passes the same content screening as a save, keeps key/category/title/provenance/evidence
anchor (the anchor still reports when the cited source moves; the horizon still counts from the original
commit), takes the new deterministic id, and carries the one optional v3 field `edited: { at, previousId }`
— unknown keys still fail closed. The predecessor id (and legacy ids) join the suppression list, so the
wrong fact cannot be re-saved; a correction whose own id was forgotten earlier is refused; an identical
correction changes nothing. Because the corrected text is user-authored, it gets the user-note protection:
`commitGeneratedMemory` refuses a different fact under that key, `stage()` refuses it with the reason (the
callback runs after the gate, so an approved call ends as one explicit tool error rather than a silent
post-turn commit failure), and a verbatim re-save keeps the stamp and provenance instead of laundering them
into model provenance. Only `/memory edit` or `/memory forget` may move it again. `show` prints the edit
line, `list` marks `user-edited`, `recall` exposes `edited`. Checked by `verify-memory-command.ts` and
`verify-memory-tools.ts`.

**Write timing is the tool description's contract, and the key merge is visible at stage time.** The base
prompt names no tool, so the three routes of the memory decision tree live in `MEMORY_SAVE_DESCRIPTION`:
changing state (progress, branch, diff, metrics, todo, workarounds) is never saved and is read live;
evidenced stable facts are saved; an inferred or uncertain fact is asked about in the reply and saved only
after the user confirms ("remember …" is confirmation). There is no low-risk auto-write path — the gate
stays the only confirmation step. `stage()` reads the same validated state `recall` reads and returns a
`consolidation` field: `add` (new key), `update` (existing key, different fact — the stored entry it
replaces is echoed with id/title/fact/time) or `unchanged` (identical id), plus up to `MEMORY_RELATED_MAX`
near-duplicates under other keys or user notes chosen by deterministic distinctive-word overlap
(`findRelatedMemory`). Stored facts are already screened, so echoing them is not a new channel; the
candidate's own fact and evidence line are still never echoed. A candidate whose id the user forgot is
refused at stage time with the reason instead of failing silently in the post-turn commit; an unreadable
archive reports `add` plus the problem and still stages. The permission prompt is unchanged — bounded
key/category/title/evidence path, never the fact — because `classify()` is synchronous and pure over the
tool input and the design keeps unscreened model text out of the live frame.

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

**One TTL on every checkpoint, including the ones the SDK places by itself.** The Bedrock
`cacheConfig` carries the shared `ttl` and all three section TTLs (`toolsTTL`,
`systemPromptTTL`, `messagesTTL`) at the same value. The per-section values alone were not
enough: the main agent's system prompt carries darwin's own hand-placed `1h` point, but any
request the SDK builds with a *string* system prompt — the summarizer behind `/compact`, recipe
children — gets an SDK auto-injected system cache point whose TTL is filled from
`systemPromptTTL`/`ttl`. Without them it stayed at Bedrock's `5m` default between a `1h` tools
point and a `1h` messages point, and Bedrock rejected the request (`a ttl='1h' cache_control
block must not come after a ttl='5m' cache_control block`), which surfaced as `/compact`
failing with "the summarizer made no reduction". `spike/verify-prompt-cache.ts` formats that
exact summarizer-shaped request through `BedrockModel` and asserts the three checkpoints agree.

**A cache miss gets a likely cause, never a remedy** (SER-074, `src/agent/cache-miss.ts`,
`AgentRuntime.cacheMissReport()` / `cacheWarmth()`). `/usage` and `/status` always showed cache
read/write counts and a hit ratio; nothing said *why* a call re-read the conversation uncached,
although darwin holds every input: the per-call provider counters `observeCallStats` already
folds, the invalidating events the session itself performed, the configured TTL, the wall clock
and the resume flag. The derivation is pure and advisory on the context-pressure row's terms — a
completed call that reads less than `CACHE_MISS_READ_FRACTION` (20%) of its request
(`requestInputTokens`, shared with `/context`) after a call that did read is a miss, and exactly
one cause is named in fixed precedence: `model switched` > `effort changed` (only when the level
actually sent changed) > `compacted` (only when `compacted: true`) > `idle past cache TTL (<ttl>)`
> `first request of a resumed session` > `unknown`. `/rewind` is deliberately not an invalidator:
it restores an earlier prefix of the same conversation, whose entries stay readable until they
expire — the same rule as file edits, permission-mode changes and skill loads, none of which touch
a cached section. Three silences are load-bearing: unreported counters are unknown, never a miss;
a fresh session's first call is expected cold and gets no verdict; and the tracker is silent
whenever the live plan places no Darwin-managed cache point (caching off, an unsupported model,
OpenAI's provider-managed cache), so those sessions' reports stay byte-identical to before. The
surfaces are the existing ones — one `cache misses` row and one `last miss` row on `/usage`, one
` · last miss:` clause on `/status`'s model row, only once a miss was observed — plus one notice
`/model <target>` and `/effort <level>` print *before* a switch on a warm cache (last call read,
less than the TTL ago), stating the uncached re-read and proceeding: no confirmation dialog, no
auto-compaction, no second threshold, no frame row, tick, channel, trajectory record or config
key. The tracker observes under the call-stats discipline (synchronous, non-throwing, its own
latch) and `/clear`'s successor starts empty. Free coverage: `spike/verify-cache-miss.ts`
(pure derivation plus a real offline runtime), `verify-usage.ts`, `verify-status-command.ts`.

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
4.6 takes `max` and refuses only `xhigh`) by `spike/verify-thinking-live.ts`. And `/effort`
reconfigures the live model via
`Model.updateConfig()` rather than rebuilding the agent — the conversation must survive a change
of thinking depth — with the config write reported, not awaited, exactly like an accepted
allow-rule. "Reported" has to hold on every driver, not just the ones with a header (issue #10):
`ThinkingPlan.problem` was read by the TUI header, `/status`, the dev REPL and `doctor`, while a
headless run — the one an evaluation harness uses, and the one that cannot look at a header —
clamped in silence, so a benchmark labelled `xhigh` could really be running `high` with no trace
in any artifact. Headless now treats the resolved plan as a run-scoped fact beside the permission
mode: text mode writes one `thinking: <problem>` stderr line after `permission-mode:` only when
intent and reality differ; `run.started` carries `thinking: { enabled, requested, effective?,
problem? }` unconditionally so a harness asserts `effective` instead of trusting its own request,
and the terminal record repeats the problem in `warnings` with `source: "thinking"`. The runtime
accessor is read guardedly (a test double without it adds no field), all additive, schema
version unchanged. Checks: `verify-headless-structured.ts` (clamped and disabled fixtures in all
three protocols, unclamped run adds nothing).

**Reasoning round-trips on the Responses path only to the model that produced it (SER-101).**
Thinking *params* are unchanged — the Responses form stays `{ reasoning: { effort } }` with no
`include`, because every Responses model measured returns what replay needs without it
(GPT-6-astra and Mantle `openai.gpt-5.6-sol` send `encrypted_content` unasked; Kimi K3 sends
plain `reasoning_text`). What changed is the *history*, inside the pinned SDK patch. The
Responses mapper now captures Bedrock's `response.reasoning.delta` (Kimi's name for
`response.reasoning_text.delta`, previously unmapped: no Kimi reasoning ever reached
`agent.messages`) and, on `response.output_item.done` of a `reasoning` item, closes the open
block and puts that item's `encrypted_content` in a block of its own, so GPT's several opaque
items per response never collapse into one. Every captured block carries
`darwin-responses:v1:<encodeURIComponent(modelId)>:<text|enc|sum>[:<blob>]` in `signature`,
because `ReasoningBlock.toJSON` persists nothing else (upstream harness-sdk#2014). The formatter
replays a block as a stateless input item (`{type:'reasoning', summary:[], encrypted_content}` or
`{…, content:[{type:'reasoning_text', text}]}`, no `id`, before that message's text and
`function_call` items) only when the tag's model id equals the live request's and the request is
stateless; `sum` (summary text) is display-only. Everything else — untagged, Claude-signed,
another model's, a different profile of the same model — is dropped exactly as before, with the
same SDK warning. The provenance rule is load-bearing, not tidiness: the origin report measured
400 `invalid encrypted reasoning` / `encrypted reasoning was created for a different account or
provider` for foreign blobs on both Responses models and `thinking.signature: Field required` /
`Invalid signature` on Claude, so an unscoped replay would turn `/model` into a session-breaking
command. Converse, Anthropic and Chat Completions drop any tagged block, and Converse also drops
signature-less, non-redacted reasoning when the model id names Claude (Kimi K3's Converse
reasoning has no signature; measured: the next Claude adaptive turn failed with
`messages.1.content.0.thinking.signature: Field required` before this). With no tagged block the
Claude, Converse, Anthropic and Chat request bodies are byte-identical to the unpatched SDK
(measured by formatting the same histories under both patches); the one intended difference is
that drop. The trajectory already reduces any reasoning block to bare presence, so replay and
`/export` are unchanged and neither tags nor blobs reach the record; the session snapshot keeps
them, which is what `--resume` restores. Out of scope and unchanged: Claude-signed reasoning
sent to Kimi on Converse is refused by Bedrock (`doesn't support the
reasoningContent.reasoningText.signature field`), exactly as without the patch. Checks:
`verify-responses-reasoning.ts` (offline, in `pnpm test`: capture, tag, replay order,
foreign/untagged/summary/stateful drop, the three other formatters, golden no-tag shapes,
snapshot round-trip, trajectory projection) and `verify-responses-reasoning-live.ts` (*live*:
two same-model turns per model, every `/model` hand-off, resume by id, Mantle sol).

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
documented rather than guarded. Fan-out itself is bounded by `maxConcurrentSubagents` (default 8,
the `workflow` node cap): `subagent` and `workflow` consult the registry's `running` count before
`createModel`/`begin()` and refuse with one fixed bounded error telling the model to wait for a
settlement rather than retry — no queue, timer or new state, the terminal transition is what frees
a slot (`src/agents/concurrency-limit.ts`, `spike/verify-subagent-limit.ts`). The report itself
crosses through one pure projection (`src/agents/report-projection.ts`, SER-062) at exactly the
`subagent` and `workflow`-terminus result seams: lines imitating darwin's own framing tags or
`Human:`/`Assistant:` roles gain one leading backslash and one bounded marker line names the matched
categories (permission-bypass vocabulary earns the marker alone) — never removed or reworded, clean
reports byte-identical, idempotent, and a report-level projection rather than a security boundary,
since any tool call it leads the parent to make still meets the gate
(`spike/verify-report-projection.ts`). A child that *fails* after producing text keeps that
evidence too (SER-063, `src/agents/failed-child-text.ts`): the rethrown error — still an error,
dispatch `failed`, retry guard counting, original kept as `cause` with its `name` — appends one fixed
cut-off note and the child's last assistant text, capped at 4000 code points and passed through the
same projection; a text-less failure is the unchanged error object and cancellation is never wrapped
(`spike/verify-failed-child-text.ts`).

**`/agents` settled counts are a projection of this run, not stored history** (SER-098).
`formatDispatchesReport` appends one `settled — this run` summary to a nonempty report, counting
`succeeded`/`failed`/`cancelled` across every supplied registry snapshot. Running entries never
count; continuation and workflow records count as ordinary dispatches, with no deduplication or
retention-window filter. An empty registry keeps the old none report without a summary. The
existing heading, bounded rows, usage and continuation suffixes stay byte-identical. Counts are
local to the formatter call, never persisted or recovered on resume; there is no deletion,
archive, new event/timer or live-frame row. `/agents` still sends one ordinary Static notice.
Required check: `spike/verify-subagent-format.ts` (in `pnpm test`) covers empty/running/mixed
counts, real registry transitions, immutable snapshots, old rows and the existing notice route.

**A child whose stream is interrupted gets the same one continuation the parent gets — on the live
child, at the tool's `invoke` seam, never in the loop** (SRF-026). One session lost ~21 minutes of two
children that died mid-stream with the bare `Stream ended without completing a message` after their
last tool result: neither had last text (the failed message is never stored), neither was continuable
(the conversation ended in a tool result), and the parent redid the work — while the parent's own
interruption in the same session was continued 49 ms later and delivered. So
`SubagentTool.invokeWithStreamContinuation` wraps exactly the `child.invoke(task)` call: when it rejects
with an error for which `isRetryableStreamInterruption` (the driver's own predicate, exported from
`src/agent/stream-resumption.ts`) is true and neither the child's `cancelSignal`, the parent's, nor the
dispatch's `cancellationRequested()` says cancelled, it publishes the closed phase
`continuing-after-stream-interruption` through the existing `setPhase` (the child's ordinary
`model`/`tool` phases take over as the continuation proceeds; rows and heartbeats render `continuing
after stream interruption`, `subagent.progress` carries the kind) and runs one
`child.invoke(STREAM_CONTINUATION_PROMPT)` on the *same live child* — its retained in-memory
conversation ends at the last tool result, so the bounded anti-repeat prompt is an ordinary user-role
message and the original task is not resent. A successful continuation's result flows through the
unchanged refusal check, `projectChildReport` and `withRetainedMaxTokensText` exactly like a
first-attempt result and settles `succeeded` (and is retained for `continue=<id>`). A second failure of
any class is rethrown as `continuationFailure(interruption, second)` — a new error whose `name` is the
interruption's and whose `cause` is the interruption object, message `<original>\n<fixed note>
<second message>` — through the unchanged `withFailedChildText`, so the retry guard's class and
`turnEnded.failure` keep their shape and the second failure's message is not lost; the dispatch settles
`failed`. A cancelled child is never continued and a continuation cancelled mid-turn is never wrapped
(the SDK converts a post-cancel provider error into `stopReason: 'cancelled'`, and the signal guards
cover the race); a non-interruption error is never continued; the continuation is attempted at most
once per dispatch — a `continue=<id>` follow-up is its own dispatch with its own single attempt;
`workflow` Graph nodes are untouched (they never pass through `SubagentTool.run`). Nothing lives in the
SDK loop, the model, `buildRecipeChild` or `runtime.ts`, and the parent's `runWithStreamResumption` is
not touched. The tool description spends one bounded clause on it
(`STREAM_CONTINUATION_DESCRIPTION_CLAUSE`). Required check: `spike/verify-subagent-continuation.ts`
(in `pnpm test`) — the fake model ends its stream without a stop event so the SDK's own aggregator
throws the exact `ModelError`; interrupted once then answers (report, `succeeded`, phase observed,
prompt byte-exact, three model calls), twice (original message, `cause`, `failed`, no third call),
another class after the continuation (chain preserved through the failed-child wrapper), cancel during
the first attempt (`cancelActive` and targeted registry cancel), cancel during the continuation,
non-interruption error, `continue=<id>` follow-up, and an interrupted `workflow` node.

**A settled child stays continuable — by its conversation, never by its process** (SER-075,
`src/agents/retained-children.ts`). `SubagentTool.run` still drops the child `Agent` in `finally` after
`stopBashSession`; what it keeps first, per tool and therefore per runtime, is a deep copy of the SDK
`Agent.messages` array plus the definition name and terminal state, for the last
`MAX_RETAINED_CHILDREN = 4` settled `subagent` dispatches, keyed by the dispatch id every surface
already shows and evicted oldest-first. The Agent object and its bash shell are *not* retained: the
conversation is what carries context, and a follow-up rebuilds a fresh Agent from it through the same
`buildRecipeChild` recipe (the SDK constructor's `messages` seed option), so no process outlives a
dispatch and a continuation runs with the current model, tools, gate and hooks. `succeeded` is retained;
`failed` only when the conversation ends in a complete assistant message with every `toolUse` answered
(a refusal stop qualifies, a stream that died after a tool result does not — a follow-up must never
extend a broken pair); `cancelled` never; `workflow` nodes never, because they are built by
`WorkflowTool` and never pass through `SubagentTool.run`. The parent-only `subagent` tool's optional
`continue: "<dispatch id>"` resolves the entry and refuses — before any model, record or child exists,
as one bounded error — an unknown, still-running, cancelled, evicted (named as evicted) or skipped id,
a `workflow` node, and an `agent` naming a different definition; otherwise the follow-up `task` runs
through the existing path unchanged: cap check first, a **new** dispatch record via `begin()` (new id,
`continuedFrom: <id>` — the only field the record gains, an id, rendered as ` — continues #<id>` on the
`/agents` row and absent byte-for-byte otherwise), heartbeats, permission `source`, report projection,
failed-child text, codex hook fork, background delegation. The continued dispatch is itself retained,
so a chain of follow-ups works inside the four-entry bound. The store is dropped by construction on
`/clear` and `/rewind` (both create a successor runtime and a new `SubagentTool`; the predecessor's
`retire()` also clears it through `subagents.shutdown()`) and on `shutdown()`; nothing is persisted,
nothing crosses into a record, `/agents` output or the trajectory (children remain unrecorded). Not
adopted: steering a *running* child, a mailbox or roster, retaining Agent objects or shells. Required
check: `spike/verify-continuable-children.ts` (in `pnpm test`; tool level and `/clear`/`/rewind`
successors at runtime level).

**Background delegation is the SDK's `backgroundTasks` plugin, never a darwin scheduler**
(SER-064, SER-070; `src/agent/background-delegation.ts`). The parent Agent — and only the parent;
children from `buildRecipeChild` never get the option — is constructed with `agentic: ['subagent',
'workflow']`, every ordinary tool plus `'*'` under `never`, `maxConcurrency` equal to the SER-061 cap,
and `waitForCompletion` chosen per runtime: `false` when the driver drains completion wakes
(`RuntimeOptions.backgroundCompletionWakes`, the TUI with `backgroundTaskWake` on), `true` otherwise.
The SDK adds the optional `_background_execution` flag to the two delegation specs, and its executor
honours `BeforeToolCallEvent` — the retry guard, the hooks and the permission gate — *before*
`routeToolCall`, so a background-marked call is gated exactly like a foreground one and a denial
leaves no task, ack or dispatch. **The invariant (SER-070): the ack ends the turn; the report arrives in
the next turn that runs, through the SDK's own delivery, started by a wake when the session is idle;
never a darwin copy of the report; `/clear` and `/rewind` refuse while a delegation is live.** In a
waking runtime the dispatching turn ends after the ack with the child still running and the user
keeps prompting. The SDK plugin delivers a finished task as one synthetic
`strands_background_task_result` tool-use/tool-result pair from two hooks — `_beforeModelCall` before
every model call and `_afterInvocation` at every invocation end (with `waitForCompletion: false` it
delivers only what is already terminal and lets the invocation end) — so a child that settles
*during* a later user turn is delivered in that turn and no wake is owed; a child that settles while
the session is idle would wait for the next prompt, and that is the one case the wake exists for:
the observer publishes the settlement (its `AfterToolCallEvent` hook fires once per background run,
exactly when the run's body returns — the dispatch registry fires per *child* and knows dispatch
ids, not task ids, so it is not the trigger), the App enqueues one SER-069 `taskNotification` entry
with `source: 'delegation'` whose text names the tool, task id, state and elapsed time and points at
the pair — never the report — and the wake turn's own first `BeforeModelCallEvent` attaches the pair
to that request. Exactly one wake per task: the App remembers every id it queued, the idle sweep
(`delegationWakeEntries`, run at settlement and whenever the session returns to idle, which closes
the microtask window between the run's hook and the engine marking the task terminal) never offers
a running or already-queued task, and the drain drops a wake whose task the SDK no longer tracks.
Headless drivers have no queue and no later turn, so they leave the option unset and keep
`waitForCompletion: true` — the whole result stays inside the one `run.*` cycle, with no darwin
waiter and no new event; children never receive the option. **Observation**: the background run's
`AfterToolCallEvent` reaches hook callbacks only, so `BackgroundDelegationObserver` forwards that
same SDK event object into `send()`'s stream ahead of the next SDK event; its ledger is not reset per
stream (a between-turns after-event is buffered and yielded at the next stream's start), so recorder
and drivers see exactly one before/after pair per delegation — before in the dispatching turn, after
in the turn that runs next — the trajectory gains no record type beyond `taskNotification`'s
discriminator, replay shows the delegation row with its report as for a foreground call, and the
live row (`… · background`) survives `turnEnded` until the forwarded after-event or the delivered
pair closes it as `… · background result`; the ack row (`… · delegated in background (task <id>)`)
is a `toolResultEvent` projection. The ledger (`listBackgroundDelegations()`: dispatched, not yet
delivered — the `messageAddedEvent` whose tool result carries the task id removes an entry, which is
also when the SDK stops tracking it) is what `/clear` and `/rewind` consult: the SDK's
`assertCanLoadSnapshot` throws while tasks are tracked and `retire()` would cancel the children
through `subagents.shutdown()`, so both are **local refusals** (`liveBackgroundDelegationRefusal`,
in the App before any work and in the runtime before any release) naming the task ids and the two
exits — `/agents cancel <id>` or wait for the completion wake — never a partial restore, never an
implicit cancel; `/exit`/`shutdown()` still cancels tracked children, and Esc still cancels every
active child with the turn (unchanged). `strands_manage_background_task` is parent-only
(`PARENT_ONLY_TOOL_NAMES`), `list`/`get` read, `cancel` fail-closed `execute`; `/agents cancel <id>`
stays the user-only path. The delegation tool descriptions state the per-runtime truth (next turn
for a waking runtime; the pre-SER-070 same-turn sentence byte for byte otherwise). Free checks:
`spike/verify-background-delegation.ts` (both runtimes, in `pnpm test`), `spike/verify-task-wake.ts`
(pty: the delegation session), `spike/verify-headless-structured.ts` (the headless decision).


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
fixes the write, not the executor: `SerializedFileEditorTool` takes the vended tool's place in the
runtime `tools:` list (static tool, so no discovery window and no `addOrReplace` dance) and is a
pure projection of what it wraps — same name, description and `toolSpec`, the SDK's own `stream()`
with the untouched context, so result and error bytes, permission classification, edit-diff rows and
trajectory records cannot differ. What it wraps is no longer the bare singleton but
`makeFileEditor({ description })` (SRF-032) — the singleton's own factory, hence the same schema and
the same patched `replace_all`/exact-miss behaviour — with `FILE_EDITOR_DESCRIPTION`: the SDK's
`DEFAULT_FILE_EDITOR_DESCRIPTION` first, then `FILE_EDITOR_PAYLOAD_GUIDANCE`, the bound that
`create`'s `file_text` and each `str_replace`/`insert` `new_str` stay within a few thousand words
and that a long document is a short skeleton filled section by section, never one whole-document
payload. The bound lives on the tool because two consecutive processes died mid-`create` on the
same oversized payload and the one automatic continuation re-emitted it (see § Stream interruption);
children get the parent's wrapper, so the guidance reaches a child whose prompt omits the
system-prompt rule. The wrapper's own description is never edited — that would break the
projection — and the pinned SDK patch is untouched. What the wrapper adds is *when*:
`create`/`str_replace`/`insert` on one
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
SER-045). The input is data, never code — node ids, agent names, task strings and plain
`[source, target]` edge pairs, capped at 8 nodes / 28 edges — and an invalid DAG (cycle,
duplicate/unknown id, unknown agent, blank task, over-cap count) is one bounded tool error before
any dispatch, model or child exists. Everything that schedules — AND-semantics dependency
resolution, dependency-merged node inputs, `maxConcurrency`, terminus resolution — is the SDK's:
darwin only wraps each node in a thin `InvokableAgent` adapter (node id outward, unique
`darwin-workflow-*` agent id inward) that prepends the node's own task to the SDK-provided input.
Each node is built by `buildRecipeChild`, the single child-construction recipe extracted from and
still used by `SubagentTool` — same composed prompt (a definition's `projectInstructions: false`
drops only the `<project-instructions>` block from that child, SER-093; the catalogue entry in both
tool descriptions says ` (no project instructions)`), tool filtering, shared gate with dispatch
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
tool, restates the bounds and the reads/writes rule, and embeds the task verbatim, then
flows down the ordinary submit path (busy submissions queue per SER-027); bare `/workflow` is a
local driver usage notice, never a model call. Required check: `spike/verify-workflow-tool.ts`
and `spike/verify-workflow-command.ts` (both in `pnpm test`).

**Declared write scopes make the reads-parallel/writes-serialized rule checkable, through the
existing gate (SER-065).** A node may declare `writeScopes` — one to eight project-relative path
prefixes, each the file or directory subtree at that path, normalized with `path.posix.normalize`
(leading `./` and trailing `/` stripped; absolute, empty/`.`, root-escaping and NUL entries are
bounded refusals naming the node and the entry, in the same validate-before-anything position).
Containment is by path segment (`src/tui` covers `src/tui/App.tsx`; `src/tu` does not), and two
scoped nodes whose scopes overlap are refused as a whole unless an edge path orders them in some
direction — reachability computed over the validated DAG for validation only. The normalized list
rides the node's dispatch record into `SubagentDispatchSource`, so `PermissionGate.sourceOf()` knows
the caller's scopes and `decideOnce` denies — `deny(...)`, before plan/yolo/safe/rules/classifier/
prompt, so no user is ever asked about it — a scoped child's `fileEditor` `create`/`str_replace`/
`insert` whose resolved path is outside every scope, with one bounded reason naming the dispatch
label, the path and the scopes. `view`, every other tool, unscoped nodes, `subagent` dispatches and
the parent are byte-identical to before; bash is deliberately not covered (its write set is not
statically knowable) and the description says so. Required check: `spike/verify-workflow-scopes.ts`
(in `pnpm test`).

## Session trajectory

**Session trajectory is an observer, never a participant** (`src/trajectory/`): every turn is appended to
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
repaired. Turn ordinals are unique within one file (SRF-031): the bounded tail read that recovers
the last `seq` also yields the highest well-formed `turn`, and the recorder's counter is seeded from
it — `runStarted` keeps `turn: 0`, a fresh file starts at 1, a tail with no readable record or no
numeric `turn` degrades to per-process numbering exactly as `seq` restarts — so a resumed run's
first prompt is `max + 1` and `replay --turn N` names one turn. The seed lands through one awaited
seam, `TrajectoryRecorder.open()` in `AgentRuntime.create()`, because `beginTurn` hands the ordinal
out synchronously (the memory controller and the buffered `userInput` consume it at once) while the
tail was only ever read on the first append; `open()` is read-only, bounded by the input-durability
timeout, creates nothing, and a recorder that was never opened numbers as before. Readers are
unchanged and carry no first-turn-is-1 assumption. `darwin trajectory list|search|replay|fork` reads it with **no model call and no
network** — `src/trajectory/**` constructs no `Agent` and no `Model` at all — and replay reuses
`turnReducer` so live rendering and replay cannot drift into two projections. `fork` copies bytes
(snapshot + `offload/` + the record as the fork's prefix) and never touches its source or the
resume pointer. Self-reflection is another strict reader: its locator runs before the managed child,
selects current-or-named without fallback, and hands off the inclusive turn/seq of the latest valid
`turnEnded`; a later open `userInput` may identify the Host but is never graded, and no closed turn is
a refusal. The locator and child never repair, append, or move session state. No subagent event is
recorded anywhere; child streams never pass through `send`.

**A successful `/compact` is recorded, as numbers only (SRF-027, `contextCompacted`).** The record
used to go silent across the one event that rewrites the history every later `modelCall.contextTokens`
is projected from: session `session-20260905-014347068` compacted between seq 1245 and 1246 with no
line between, and the next call's `contextTokens: 705408` was the SDK's stale baseline (its
`_estimateInputTokens` reads the last assistant message carrying usage metadata, and a preserved
recent message still carries its pre-compaction number) on a call that billed ≈44k. Now the driver
that ran the compaction appends one out-of-turn record on `shellCommand`'s terms — synchronous,
non-throwing, flushed on the ordinary append chain, `turn` = the last closed turn's ordinal — carrying
`before.messages`, `after.messages`, optional `before.estimatedTokens` (the driver's own
`AgentRuntime.contextEstimate()` read *before* the compaction, since the anchor drops with the
rewritten history; absent when unknown or 0, never 0) and the boolean `focused`. Never the summary,
never the focus text: `spike/verify-compact.ts` asserts over the bytes. The one composer is
`compactAndRecord` (`src/agent/compact.ts`), called by the TUI's `/compact` site and by headless
`--compact-before`; it records only under `compacted: true`, so a no-shrink pass or a rolled-back
failure leaves the file untouched. Both the writer and the reader (`contextCompactedOf`) accept a
count only as a non-negative safe integer (`boundedCount`): the writer refuses to write a line whose
message counts fail it, the reader rejects one it finds. Readers: `formatReplay` prints one notice
row in transcript order (`context compacted: 12 → 5 messages · ~705408 tokens before · focused`, the
optional parts only when present) through the ordinary reducer, so `/export` and the resume recap
show the same line; `spend.ts` treats a valid record as an **anchor drop** — the first `modelCall`
after it loses its `contextTokens` and prints `context: reset by compaction` (the chosen treatment:
say why rather than silently omit), the second is labelled normally; `searchableText` is empty
(there are no words to find); `fork` copies it as bytes; recall and `sessions` filter on
`userInput` and never see it. Files without the record render byte-identically. Checks:
`verify-trajectory.ts`, `verify-compact.ts`, `verify-export-command.ts`, `verify-resume-recap.ts`.

**Every settled permission decision is recorded, as the decision only (SER-079,
`permissionDecision`).** Before it, the record could show a tool call and its result but not
*why it ran*: a grader reading the file could not tell a prompt the user answered from a silent
`safe` approval, and a deny-rule refusal read like any other error result. Now the gate's observer
(`PermissionGateOptions.onDecision`, § Permissions — the gate) is pointed by `create()` at the
recorder, and each published decision becomes one record **inside the open turn**, buffered in
observation order like a stream event — synchronous, no I/O, non-throwing, flushed with the turn's
ordinary closing append. It lands just ahead of the `beforeToolCallEvent` it judged, because the
gate runs inside the SDK's hook dispatch before the stream yields that event, and it carries the
same `toolUseId`, so the two lines pair the way the DeepSeek harness pairs `approval/decided` to a
`callId`. Fields: `toolUseId`, `toolName`, `kind`, `risk`, `mode`, `source` (`parent`, or the
child's `<agent>#<dispatchId>` — children share the gate, so their decisions are recorded with
their label; no child transcript content is involved), `outcome`, optional `rule`, `promptedUser`.
**Never the input**: the call's own recorded event holds it, and the record's key set is asserted
over the bytes. Every string passes the field cap with its truncation written down. The shape is
spelled structurally in `record.ts` (`PermissionDecisionFields`, the ten outcome names as string
literals) and the runtime adapts the gate's object to it in one function — `src/trajectory/**`
still imports no `Agent`, `Model`, gate or hook module, and the structural scan in
`verify-trajectory.ts` now names `permission.js` and `hooks/` as forbidden imports. A decision that
arrives with no open turn (a background child working between turns) or with recording off or
latched off is dropped silently: inventing a turn ordinal would put a line in the file no
`userInput` explains. Readers: `permissionDecisionOf` is strict where the claim lives (an unknown
`outcome` or a missing `toolName` rejects the record — replay prints nothing, never a stage nobody
named) and fail-closed elsewhere (`kind`/`risk` outside their sets read `execute`/`dangerous`, a
non-boolean `promptedUser` reads `false`); `formatReplay` prints one bounded notice row, through
the ordinary reducer, **only for a prompted or denied decision** — `permission · bash · denied by
deny rule bash:git push --force*`, `permission · fileEditor · approved by user (rule granted
fileEditor:src/**)`, ` · <agent>#<dispatchId>` for a child, ` · prompted` when a silent outcome
is shown only because a withdrawn prompt preceded it — and **nothing for `yolo`, `safe`,
`allow-rule`, `classifier`**, so a session with no prompt and no denial renders byte-identically
to a file that predates the type (asserted). The same row reaches `/export` and the resumed-session
transcript because both read it through `replayRecords`; the live TUI draws nothing new, headless
drivers keep their `permission.denied`/stderr line, tool results and messages are untouched (the
real-runtime check asserts the audit vocabulary appears in no event the driver saw), and there is
no config key. `searchableText` is the tool name, the outcome and the rule — words the record
holds; `trajectory list`, `spend.ts`, recall and `sessions` never see it; `fork` copies it as
bytes. Checks: `verify-permission-audit.ts` (gate), `verify-trajectory.ts` (writer, reader,
replay, real offline runtime).

**A `/rewind` successor's `runStarted` names where its messages came from (SRF-028, `rewindFrom`).**
The header is composed from `session.restoreRequested` and `agent.messages.length`, so a successor —
created with `session: { kind: 'new' }` and then handed the source checkpoint — read as
`resumed: false, restoredMessages: 188`, a fresh run with a history nothing in the file explained.
`create()` now passes the `rewindRestore` ids into the recorder's run info, and the writer emits one
optional nested `rewindFrom: { session, snapshotId }` right before `pid` — only when the shared
`rewindOriginOf` accepts both as non-empty strings within `MAX_REWIND_ORIGIN_CHARS` (128 code points,
the catalogue's own snapshot-id bound); otherwise the key is absent, not `undefined`, and the line is
byte-identical to a pre-SRF-028 header. `resumed`/`restoredMessages` are untouched. Readers go through
the same validator: `replayRecords` exposes it on the run, `formatReplay` appends ` · rewound from
<session> snapshot <id>` after ` · resumed` on the one existing header line (so `/export` carries it),
and the resume recap's title notice repeats the clause via `formatRewindOrigin`; `searchableText`
stays empty for the record. Checks: `verify-trajectory.ts`, `verify-rewind.ts` (real offline
successor, source bytes unchanged, `--resume` and `/clear` headers without the key), `verify-resume-recap.ts`.

## Session diagnostics

**Session diagnostics are opt-in, and off means untouched** (`src/agent/diagnostics.ts`): the SDK says several things *only* at `debug` —
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

## The npm package — pinned pnpm patches, generated at build, SDK refused when missing

**`npm install -g strands-darwin` is the supported install; the pnpm patch stays the single
source.** The registry name is `strands-darwin` (bare `darwin` is taken); the command stays
`darwin` and `--version` still prints `darwin <version>`, with `src/version.ts` keyed on the
exported `DARWIN_PACKAGE_NAME`. `engines.node` is `>=22.0.0`, matching the pinned SDK's
Node minimum. The tarball is `npm pack` of a built tree: `files` whitelists `dist/src`, `dist/patches`
and `README.md` (npm adds every `README*` itself), so `dist/spike/`, `src/`, `spike/`, `docs/`,
`patches/` and `attachments/` never ship; `prepack` runs the build. Each patch exists once,
as the pnpm patch `pnpm patch-commit` writes and `pnpm-workspace.yaml` `patchedDependencies`
applies — the SDK patch and, since the terminal-narrowing redraw (see *TUI — the frame
budget*), `patches/ink@7.1.1.patch`; `pnpm build` ends with `node dist/src/npm-package/generate-patch.js`, which rewrites
every one of them into patch-package's dialect (`src/npm-package/patch-package-format.ts`: only the
`diff --git`/`---`/`+++` paths gain `node_modules/<package>/`, the file name becomes
`@strands-agents+sdk+1.18.0.patch` / `ink+7.1.1.patch`, idempotent) under `dist/patches/` — a gitignored build
artifact, never a second hand-maintained copy. `postinstall` is
`patch-package --patch-dir dist/patches`, and both edges of the developer path hold by
patch-package's own behaviour: an absent directory (fresh clone, `postinstall` runs before any
build) is "No patch files found", exit 0; the generated file against an SDK pnpm already
patched is "already applied", exit 0, nothing rewritten. `pnpm add -g` is unsupported and
documented so: pnpm blocks dependency build scripts by default and, allowed, its isolated
layout puts the SDK where patch-package cannot address it. The unpatched case is refused at
startup rather than crashing: ESM links an entry module's whole static import graph before
running a statement, and `cli-main.ts` → `agent/runtime.ts` → `agent/compact.ts` imports
`DEFAULT_SUMMARIZATION_PROMPT`, a name only the patch exports — so `cli.ts` is a bootstrap
whose static imports are node built-ins plus `sdk-patch-preflight.ts` (node built-ins plus
`version.ts`), reads two marker files next to the resolved SDK entry (`DEFAULT_SUMMARIZATION_PROMPT`
in `index.js`, `excludeTools` in `vended-plugins/context-offloader/plugin.js`), prints one
five-line refusal naming `patch-package`/`postinstall`, `--ignore-scripts`, `pnpm add -g` as
unsupported and `npm install -g strands-darwin` as the fix, exits 1, and only otherwise
`import()`s `cli-main.ts` (or the read-only AgentCore CLI before runtime signal handlers).
The check precedes even `--help`/`--version`; it evaluates no SDK
module and never wraps the loop. `spike/verify-npm-patch-format.ts` (in `pnpm test`, offline)
pins the conversion, the generator, the manifest facts, the notice and the import-graph
placement, and runs patch-package on both developer-path edges; `spike/verify-npm-package.ts`
(standalone: it needs the registry) builds, packs, asserts the entry list, installs into a
temporary prefix, checks the installed SDK markers, runs `--version`/`--help`/`doctor`, and
proves the `--ignore-scripts` refusal. Publishing is the Host's release step, never a suite's:
`.github/workflows/publish.yml` runs on a `v*` tag, repeats the whole gate plus the npm-package
suite on a fresh runner, refuses a tag whose version differs from `package.json`, publishes
through npm trusted publishing (OIDC, `NPM_TOKEN` secret as fallback) and creates the GitHub
release only when none exists; `workflow_dispatch` rehearses the gate without publishing.

**The SDK patch's reasoning hunks are an interim, to be dropped rather than rebased (SER-101).**
The Responses-path provenance round-trip (see *Thinking effort*) touches
`models/openai/responses-adapter.js`/`.d.ts`, `models/openai/model.js` (the stream state gets the
request's model id), `models/bedrock.js`, `models/anthropic.js` and `models/openai/chat-adapter.js`;
each hunk is marked `darwin patch (SER-101)`. It was regenerated with `pnpm patch` /
`pnpm patch-commit`, which left every earlier hunk byte-identical and `pnpm-workspace.yaml`
untouched (the lockfile's `patch_hash` changes, as it must). On any SDK upgrade, first check
whether upstream shipped a provenance-aware reasoning round-trip — harness-sdk#4598 (filed from
the origin report: the Bedrock event name plus cross-provider safety) or #3389 (the OpenAI
round-trip) — and if so delete these hunks instead of porting them; a duplicate would tag or
replay twice. SDK 1.19.0 was checked and does not cover it.

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
restarts at the initial cwd and points to `start` + `wait`. Each foreground command runs as a brace
group whose stdin is `/dev/null`: the shell's own stdin is the tool's command socket, and a child
that inherited it either hung on a prompt until the timeout or ate the sentinel lines and wedged
the shell for every later call — so prompts now get EOF at once and the rule is stated in the tool
description. The shell is spawned detached and `stop()` signals its whole process group
(TERM→KILL, same grace as background jobs), because killing bash alone left the timed-out child
running under pid 1. Detaching also takes the shell out of the terminal's process group, so the
foreground `execute` honours the SDK's `ToolContext.cancelSignal`: Esc in the TUI or Ctrl+C in
headless mode kills the running command's group at once and returns a bounded cancelled result,
instead of the command running on to its timeout with its result discarded. Serialization is also what keeps parallel
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
compatibility default; explicit `wakeOnOutput: false` accepts a finite 1–1800000 ms (thirty minutes,
so a supervised headless child that runs 20–30 minutes costs one wake, not six), advances and
retains up to the ordinary output cap, and waits only for terminal state, cancellation, shutdown, or
timeout. Only its still-running timeout adds bounded model-visible wait-again guidance; that sentence,
like the `bash` description's, is per runtime (`createBackgroundBashTool(..., { completionWakes })`
from `RuntimeOptions.backgroundCompletionWakes && config.backgroundTaskWake !== false`, set only by
the TUI driver): the parent TUI says one `<task-notification>` turn follows once idle, while headless,
the dev REPL, children and the key off keep the byte-identical "background completion does not
resume the agent" — the manager itself never continues or calls the model.
Neither form owns or delays process cleanup. A cancelled model stream's socket has no public cleanup,
so `cli.ts` arms an unref'd 500ms `process.exit` fallback *after* shutdown completes. Don't change these paths
without re-running `spike/verify-background-bash.ts`, `spike/probe-cancel-exit.ts`,
`spike/verify-clear-session.ts`, and the `bashExit` / `cancelThenContinue` TUI scenarios.

**The `/tasks` output tails read the log, never the cursor (SER-060).** The byte cursor behind
`bash output` and `wait` is the model's: every byte belongs to exactly one consumer, and the
offsets it reports are how the model knows what it has and has not seen. A user glancing at
`/tasks` must not become a hidden second consumer, so the three recent non-empty lines under each
job row come from `src/tools/background-tail.ts` — its own read-only `O_NOFOLLOW` open of at
most the last `TASK_TAIL_WINDOW_BYTES` of `outputPath`, split, ANSI-stripped, blank lines dropped —
and the manager's `readOutput`, `cursor`, `OUTPUT_LIMIT` accounting and any in-flight `wait` are
not touched: `startOffset`/`endOffset`/`output`/`hasMore` before and after a `/tasks` are
byte-identical (`spike/verify-tasks-tail.ts` proves it against control runs). The reader never
rejects — a missing or replaced log is `(output unavailable)`, a readable one without a non-empty
line `(no output yet)` — and every tail settles before the one `<Static>` notice is dispatched, so
the report stays a single bounded transcript block with no live row or timer.

**Model-spawned shells never inherit credential-shaped names (SER-082).** `assessRisk` is right
to call `echo $ANTHROPIC_API_KEY` and `cat /proc/self/environ` read-only, so the gate cannot be
the defence: in `default` mode the model printed darwin's own API key without a prompt and the
value landed in the tool result, the trajectory and `/export`. The defence is upstream of the
shell. `src/tools/shell-env.ts` is one pure decision — `scrubShellEnv(process.env, passthrough)`
drops every variable whose *name* matches the fixed case-insensitive
`KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL` pattern, keeps `PATH`/`HOME`/`USER`/`LOGNAME`/`SHELL`/
`TERM`/`LANG`/`LC_*`/`TMPDIR`/`TZ` and the proxy names unconditionally, restores what
`shellEnv.passthrough` names (exact or one trailing `*`, case-sensitive; the grammar is the
module's own `passthroughEntryProblem`, which config validation calls, so the loader cannot accept
what the scrub ignores) and returns the withheld *names*, sorted — never a value. `runtime.ts`
computes it exactly once per `create()` and hands the same map to both spawn seams: the pinned
patch's `CreateBashOptions.env`, threaded `createBash` → `BashSession` constructor → `spawn` (so
the shell after `restart` or an exit-0 replacement is scrubbed too, and an absent option is
byte-identical to before), and `BackgroundBashManager.start(command, env)` through the
`createBackgroundBashTool` `env` option. Children inherit it for free: `childBash` wraps the same
`foregroundBash` and manager. Nothing else is routed through it, by design — user `!` commands
(`shell-command.ts`), hooks (`src/hooks/*`) and MCP servers (`registry.ts`, env from config
interpolation) keep `process.env`, because their subject is the user's own authority, not the
model's. There is no off switch; the passthrough list is the only knob. What was withheld is
reported as names only: `RuntimeInfo.shellEnv`, one transcript notice at startup (TUI and dev
REPL, text-mode headless `shell-env:` beside `thinking:`; structured mode has no counterpart) and
the `/status` `shell env` row under `MAX_STATUS_NAMES`. The SDK `bash` tool stays the SDK's: an
option through the existing `createBash` seam, no execution wrapper, no `toolExecutor`. One
stated gap: a `start` job is `bash -lc`, so the user's own `~/.profile` may re-export a name — the
suite runs its background cases under an empty HOME for that reason. Checks:
`spike/verify-shell-env.ts` (pure rules, the real foreground shell and its replacements against a
`spawnSync` control and an option-less control, the `start` path, a real `SubagentTool` child),
`verify-config.ts` (`shellEnv` grammar), `verify-status-command.ts` (the row), and
`verify-npm-patch-format.ts` for the regenerated patch.

*Every process darwin spawns carries `DARWIN=1` (SER-094).* The counterpart of Claude Code's
`CLAUDECODE=1` and Gemini CLI's `GEMINI_CLI=1`: one pure helper in the same module,
`withDarwinMarker(env)`, returns a copy with `DARWIN=1` added **unless the name is already set**
(a user's `export DARWIN=custom` survives byte-identical; nothing else is added, the input is never
mutated), and every spawn seam darwin owns applies it — `runtime.ts` marks the *scrubbed* map
before handing it to `createForegroundBashTool`/`createBackgroundBashTool` (parent and `childBash`
alike, so the marker can never be a withheld name and the notice/`/status` row never mention it),
`shell-command.ts` marks `process.env` for `!`, the three hook spawns (`tool-hooks.ts` native tool
hooks, `lifecycle-hooks.ts`, `hook-process.ts` — the runner every Codex-dialect hook goes through)
do the same, and `registry.ts` (`withStdioDarwinMarker`, beside `withDefaultPrefixes`) adds
`env.DARWIN` to each *stdio* server entry without overriding a config `env.DARWIN`. The MCP seam
is the one that had to be verified rather than assumed: the SDK's `buildStdioConfig` hands
`{ ...getDefaultEnvironment(), ...interpolateRecord(env) }` to `StdioClientTransport`, whose spawn
env is again `{ ...getDefaultEnvironment(), ...env }` — a fixed whitelist (`HOME`, `LOGNAME`,
`PATH`, `SHELL`, `TERM`, `USER` on POSIX), never `process.env` — so the config `env` is the only
path into a server, a `DARWIN` exported in darwin's own shell never reached a server before and
still does not, and the marker written into the config does. The scrub, `ALWAYS_SURVIVE_NAMES`,
passthrough, trajectory, `/export` and headless output are unchanged; darwin's own platform helpers
(clipboard/copy commands) are not user or model programs and are left alone. Checks:
`verify-shell-env.ts` (helper contracts; a real offline `AgentRuntime` whose registered `bash`
prints `1` in the foreground shell and a `start` job, and passes a preset `DARWIN` through),
`verify-shell-command.ts`, `verify-tool-hooks.ts`, `verify-lifecycle-hooks.ts`,
`verify-codex-hooks.ts`, and `verify-mcp-config.ts` (a real `sh -c` stdio server writes what it
saw: `1` through the registry, the config value when set, nothing through the bare SDK).

## TUI — production React owns the long-turn memory bound

**The interactive React/Ink graph is first imported under the production condition**
(`src/tui/react-environment.ts`): React 19's
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
own window hides. Required checks: `spike/verify-frame-budget.ts` and the `spike/verify-tui.ts`
scenarios named above.

**A narrower terminal redraws the frame once from a cleared screen** (`patches/ink@7.1.1.patch`).
Ink's standard renderer repaints by erasing exactly the number of lines it wrote last time.
Reflowing terminals (tmux, iTerm2, Terminal.app, kitty, xterm.js and VS Code) rewrap the rows
of the frame already on screen when the window gets narrower, so the frame then occupies more
rows than that count, and stock Ink 7.1.1's `resized` handler only `log.clear()`s the stale
count: the top rows survive, once per resize event — in darwin the `◆ DARWIN · working` header
and the model line stacked up, each frozen at a different shimmer letter (the 90 ms spinner
tick meant several events during one drag). Widening does not reflow anything Ink drew (every
row ends in a hard newline) and a height-only change reflows nothing, so those paths are
untouched. The patch, applied by the same pnpm/patch-package pipeline as the SDK patch, makes
the first interactive frame after a width decrease take Ink's own overflow path —
`clearTerminal + fullStaticOutput + frame`, then `log.sync` — and cancels any throttled write of
the pre-resize frame that would otherwise land after the redraw at the old width. This is the
one whole-screen clear the frame budget otherwise exists to avoid, paid once per resize event
rather than per render, and never from darwin code: the App cannot see Ink's last output or
its static buffer, so an App-side erase would either leave the ghost rows or lose the
transcript from the viewport. `spike/verify-resize-redraw.ts` (in `pnpm test`) pins the byte
contract in a pty — one `clearTerminal` per width decrease, transcript before frame, the
incremental erase again afterwards, no clear on widening or height change — and its fixture's
header comment says how to watch the reflow itself in tmux.

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

**Out-of-frame sequences: BEL, OSC 52, OSC 2, OSC 9 — written only on transitions, never a tick.**
Four things darwin says to the terminal are not rows: the attention bell
(`src/tui/terminal-bell.ts`, `\x07`, `terminalBell`), the `/copy` clipboard write
(`src/tui/copy-command.ts`, `ESC ] 52 ; c ; base64 BEL`) and the window/tab title
(`src/tui/terminal-title.ts`, `ESC ] 2 ; darwin · <project basename> · <state> BEL`,
`terminalTitle`, SER-073), plus the attention notification described at the end of this section. All four are non-printing control sequences that go through the
one raw-write seam — the real `process.stdout` behind an injectable writer, never Ink's frame
render path — so they cost the budget nothing, never appear in ANSI-stripped pty assertions
(`stripAnsi` and `reconstructTerminalLines` skip OSC payloads), and leave `/export` and replay
byte-identical. The title is the strictest of the four because it is *state*, and state
invites polling: it is a fixed composition (state `idle`/`working`/`waiting for approval` —
a published permission prompt outranks a running turn, which outranks idle — plus ` · N queued`
while prompts wait, a suffix on whichever base holds rather than a competing state, because a
queue waiting behind a running turn is exactly what a user in another tab wants to see; derived
from the permission queue, `status` and the prompt queue the App already owns), a writer keeps
the last title and
writes only when the composed title *changes* — a streaming turn of hundreds of frames is two
writes — and there is deliberately no spinner, because a spinner is a tick and this section
forbids a new tick source. The title is an escape-sequence payload, so every control character
is stripped from the project name before it is embedded and the whole title is capped at
`MAX_TERMINAL_TITLE_CODE_POINTS`; it is written only when `process.stdout.isTTY` holds (a pipe
gets nothing, and headless drivers never reach the module), every exit path restores the bare
project name once through the App's unmount, and `/clear` — same tree, successor runtime —
simply continues. The xterm title stack (`CSI 22;0 t`/`CSI 23;0 t`) is not used: nothing
demonstrates every terminal without it ignores it harmlessly. The fourth out-of-frame sequence,
the terminal-mediated attention notification (`src/tui/terminal-notify.ts`,
`ESC ] 9 ; darwin · <project basename> · waiting for approval|turn complete ESC \`, `terminalNotify`,
SER-078), fires at exactly the bell's two driver moments through the same seam and guards (TTY only,
never headless/children/hooks, off performs no write), is ST-terminated so the bell count cannot see
it, is one OSC 9 rather than OSC 9 plus OSC 777 because every documented OSC 777 terminal but
rxvt-unicode also shows OSC 9 (two toasts otherwise), strips `;` as well as controls from the
project name so a directory cannot masquerade as a ConEmu `9;4` sub-command, and is wrapped in
tmux's passthrough DCS when `TMUX` is set — the module header records the sources. Checks: `verify-terminal-bell.ts`
(which counts BELs outside OSC sequences), `verify-copy-command.ts`, `verify-terminal-title.ts`
(exact bytes per state, change-only, TTY/config guards, restore; pty layer over the bell fixture
proves one write per transition and zero when disabled), `verify-terminal-notify.ts` (exact bytes,
sanitizer and cap, TTY/config guards, tmux wrapper, sole-writer grep; pty layer proves one
sequence per moment bare and wrapped, zero when disabled).


## Background activity in the header

The first live header row keeps the foreground state (`ready`, `working`, permission,
compaction or shell) and appends ` · ⠋ N task(s) running · /tasks` for running background
bash jobs only. Completed history is not counted. The one-cell spinner shares the tool
panel's frames and the App's existing 90 ms clock; running jobs keep it moving even when
the foreground is idle or awaiting permission. The clock stops when neither foreground
nor background activity needs animation. The active-colour label remains readable without
colour; narrow widths drop the hint, shorten to `N running`, then keep the count.
One `Text wrap="truncate-end"` prevents a second header row. There is no additional timer,
log read, output-cursor movement, model call or trajectory record.

`BackgroundBashManager.runningCount` projects its in-memory task states; a separate
`subscribeActivity` invalidation fires on registration and terminal transition, with
observer failures isolated. The terminal-snapshot subscription is unchanged: starts never
become completion notices or wake entries. The runtime forwards this read-only surface;
the App uses `useSyncExternalStore`, so starts from children, idle completions and runtime
handoffs update without polling. `/clear` inherits the process-owned manager and therefore
retains its running count. Tests: `verify-background-activity.ts` (real jobs and a real pty,
including resize, draft preservation and clear), `verify-visual-language.tsx`, and the
existing background-bash/task-wake suites.

## The busy rows

**The busy rows are alive, and stay exactly the rows they were** (`src/tui/busy-suffix.ts`): while a turn streams,
the `working…` hint and the `thinking…` row carry a live suffix — elapsed turn time plus the
session's reported token spend (` · 12s · ↑1.2k ↓318 tokens`; the `thinking…` row elapsed-only,
so the spend is never stated twice in one frame) — with no new frame row, no new tick source and
no new information channel. The suffix rides directly *behind* the busy word, ahead of the static
command hints: both rows are one `<Text wrap="truncate-end">`, so they can never wrap or grow a
row at any width and the tail that truncates on a narrow terminal is the part that never changes —
the hint's 2-row claim in `promptBoxWanted` and `thinkingRows = 1` stay correct untouched. The
only clock is the existing spinner interval (never a second one, no tick without activity) and the only
read is `runtime.usage`, the SDK's synchronous in-memory accumulator — which counts a model call
when it *finishes*, the same lagging reading mid-turn `/usage` reports as "not counted yet".
Honesty is the `usageBuckets` rule: an unreported metric is absent, never 0; a zero accumulator
renders `↑0 ↓0`; a meter read that throws degrades to elapsed-only. The per-turn start ref is
cleared in `runTurn`'s `finally`, so cancelled and failed turns stop the readout even if
background jobs keep the shared animation clock alive.
The second read the same tick makes is `runtime.retryWait()` (SER-067): a pending model-retry wait
appends ` · throttled, retry 3/6 in 12s` after the spend on both rows through the same `busySuffix`
(the rules above hold: no row, no tick, the reason never on the row, byte-identical without a wait —
see § Model retry). Free check: `spike/verify-busy-suffix.ts` (in `pnpm test`) and the free
`verify-tui.ts modelRetry` scenario (the phrase on the `working…` row and nowhere else); the live
`verify-tui.ts usage` scenario asserts the readout is present mid-turn and ticks while the turn runs.

## Cost accounting

**Cost is a projection over the token buckets, priced per model from a fetch-once cache — never a
new channel and never an invoice** (`src/pricing/cost.ts`, `src/agent/cost.ts`,
`src/pricing/model-prices.ts`, `src/trajectory/spend.ts`). The only arithmetic is Σ bucket × LiteLLM base
rate **per model**, in one module with no `Agent`/`Model`/config/I/O import so that both the live
surfaces (`/status`, `/usage`, the headless `cost:` record) and the offline readers (`trajectory
list`/`replay`) price through it and cannot disagree; every rendering carries its basis
(`≈ $0.0123 (base rates, LiteLLM)`) because the number is approximate by construction — base tier
only, summarization calls excluded because the meter excludes them. Per model is load-bearing: a
session that ran `/model` holds two price lists, so the runtime tallies each completed turn's meter
delta under the config that turn ran on (the same snapshot and config the trajectory's `spend`
uses) and attributes the remainder — the turn in flight — to the live model; the shares always sum
to the meter, a single-model session is one share (its reports byte-identical to before), and a
mixed session says `2 models` and, in `/usage` and `replay`, breaks the figure down. The
`usageBuckets` honesty rule carries over unchanged and gains a sibling: an unreported bucket is
excluded and *named* and the total becomes a floor (`≥`), never a smaller exact-looking figure and
never 0; a model the cache does not price is *unpriced* — its money unknown — and the total is a
floor that names it, never dropped; headless writes `total=-` the moment anything is unknown and
`model=<n>-models pricing=mixed` when it cannot name one model, since a floor in a `total=` field
would be read as the total. The supervisor skills (`developer`, `self-reflection`) capture that
record beside `usage:` on the same `-`-is-unknown rule. The price table is the feature's only I/O
and darwin's only non-tool network use, and it is fenced accordingly: `~/.darwin/model-prices.json`
stores only the resolved per-id mapping (with the LiteLLM key it came from, so it is auditable),
a priced id is never refetched. An unlisted id is recorded as `litellmKey: null`, but this
negative result expires after 24 hours (`MODEL_PRICES_NEGATIVE_TTL_MS`); an invalid/future
`fetchedAt` is expired too. Startup and `/model` may refresh missing/expired-negative ids,
at most once per process per id (concurrent callers share the attempt), never by timer.
A successful no-match renews `fetchedAt`; a newly published exact-model price replaces the
negative. The bounded 10 s / 8 MiB fetch fails without a write/warning/frame, retaining an
old `none` result or leaving an absent entry `unavailable`; the next process may retry.
Before publishing, the store rereads and preserves any price another process already saved.
This supersedes the original permanent-negative-cache rule after the 2026-09-13 stale-price
incident; priced entries and schema v1 remain unchanged. Reads — what `/status`, `/usage`
and the trajectory CLI do — never fetch or write, which is
what keeps `/status` byte-zero mutation and the readers as offline as replay; `/export` passes no
prices at all, so a transcript file depends on the record alone. Children never touch the store:
they report tokens, the parent prices them at its live rates and folds them into that model's
share. `DARWIN_MODEL_PRICES_FETCH=off` makes the store cache-only, which is how the free suites
keep their private HOMEs off the network. Free checks: `spike/verify-cost.ts`,
`spike/verify-model-prices.ts` (real loopback HTTP/files for negative TTL, recovery, failure,
read-only/offline guards and concurrent positive preservation; existing fetch contracts),
`spike/verify-model-shares.ts` (a real offline runtime across `/model`),
`spike/verify-trajectory-cost.ts` (hand-written records, unchanged cache mtime), and the
`/status`, `/usage`, headless suites (all in `pnpm test`).

## File-edit diffs

**A file edit is presented as the line diff of its own input — computed at presentation time,
never read from disk** (`src/tui/edit-diff.ts`): the gate has always exposed the raw tool input
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
(`src/tui/markdown.ts` pure and dependency-free, `src/tui/MarkdownText.tsx`): assistant answers — `<Static>` pieces
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

**Completion and accepted-draft controls are display-only (SER-100).** `InputBox` projects
completion names through `searchPreview` before Ink sees them: CRLF/LF/CR, VT/FF/NEL and
Unicode line/paragraph separators become ` ⏎ `, other C0/DEL/C1 bytes become literal
`\uXXXX`. `truncate-end` alone bounds width, not newlines or terminal styling. The raw
candidate array, ordering, matching and Tab/Enter acceptance remain untouched. The editor
separately projects non-layout controls (including CR and Unicode separators) as `\uXXXX`;
LF retains multiline layout and tabs retain four cells. Each escape is one display unit
with raw grapheme endpoints, measured before wrapping, never six editable source characters.
CRLF remains one source grapheme: the CR is visible but creates no caret stop between the
pair; the next stop is on the following logical row. Movement, deletion and undo continue to
operate on exact raw drafts. This is not a transcript sanitizer, input normalizer, file read
or second policy channel. No grant arithmetic, live row, timer or dependency changes.
`verify-input-controls.tsx` covers real mode-000 hostile filenames through bounded scanning,
exact insertion, real Ink grants at 24/100 columns, selected windows/omissions and source/cell
mapping. `verify-input-controls-pty.ts` drives the real CLI without a model call: Tab/Enter,
editing, destructive undo and deletion of every raw grapheme prove exact unsent text. Both
are in `pnpm test`; neighboring editor/path/frame/search suites and free TUI
`completion`, `pathCompletion`, `wordNav`, `undo` remain required regressions.

**`@` in the prompt completes a workspace path, and inserts the path text — never the file's
content** (`src/tui/path-completion.ts`). Three
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

**Explicit draft stash (SER-085) belongs only to the composer.** `draft-stash.ts`
provides a pure one-slot transition over exact `EditorValue` plus optional `ImageBlock`;
`App` owns its state and immediate ref, never the runtime. Ctrl+S stores/clears when
only the composer is occupied, restores/consumes when only the stash is occupied,
refuses both occupied, and is inert when both are empty. The text cap is 65,536 code
points, checked without truncation or mutation. Both transfers clear undo/lastCut,
recall, completion selection/dismissal and preferred column while preserving the
saved text/cursor affinity/image identity. It survives ordinary submissions, queue
transfers, recall, model switches and compaction; only successful clear/rewind/tangent
successors and exit drop it, with a content-free notice. Exit flushes that notice
before Ink unmounts. Modal permission/compaction/history/rewind handlers precede the
chord. No slash command, tool, SDK-loop change, automatic send, queue entry, disk or
trajectory/memory exposure exists. A fixed `stash: Ctrl+S` suffix uses the existing
busy InputBox hint or idle header hint, reserving suffix width in that same row,
never adding a component, row or timer. Raw TUI semantics
already disable software flow control: the real pty check sends Ctrl+S and proves
subsequent rendering without Ctrl+Q. Checks: `verify-draft-stash.ts` and
`verify-composer-stash.ts` (both in `pnpm test`); the latter's S1–S7 checklist covers
model-request/durable-file privacy, real clipboard callback races, key ownership,
lifetime transitions and narrow-frame behavior with local transport only.

**Composer cut/yank (SER-084) is draft-local, not recall or undo.** `App` keeps one
last-cut string beside SER-044's destructive-edit undo stack. `updateLastCut` in
`prompt-editor.ts` uses the deletion result's cursor offset and length loss to capture
the exact contiguous span, never a prefix/suffix diff that can misidentify repeated
text. Word-boundary scans segment once per operation so a cap-sized word cut is
usable, rather than re-segmenting the whole draft for each removed grapheme.
Ctrl+K/U/W and Alt word deletes feed it; nonempty cuts replace, no-op cuts retain,
and ordinary Backspace/Delete do not feed it. At most 65,536 code points survive: an
over-cap cut still deletes and pushes the original undo snapshot, but clears the slot
and emits one fixed bounded Static notice, never stale/truncated yank. Ctrl+Y calls
`insertAtCursor` at the current grapheme-safe cursor and retains the slot for repeat;
movement, typing and undo leave the slot alone. Yank is insertion, so it does not add
to the existing destructive-only undo stack. Every undo ownership reset also empties
the slot: submission/queue/local commands, queue take-back/cancel return, recall and
search acceptance, explicit stash/restore, clear and rewind successors. Search cancellation preserves it.
Permission/compaction/search handlers still precede composer chords; modified `y`/`Y`
are ignored, so Ctrl+Y cannot masquerade as plain `y`. No clipboard, runtime,
SDK, tool, record, network/file operation, timer or live-frame row is added. Free checks:
`verify-prompt-editor.ts`, `verify-composer-yank.ts` (real CLI pty with local model,
including reset seams and permission/search/compaction precedence), `verify-help-command.ts`
and `verify-frame-budget.ts`; neighboring pty `undo`, `wordNav`, `queue`, `historySearch`, `completion`.

**`Up`/`Down` recall previous prompts, read out of the record darwin already keeps — and they take no
key that already had a meaning** (`src/trajectory/prompt-history.ts`, `src/tui/prompt-recall.ts`). There is no history store and there must never be
one: every prompt a session sent is already a `userInput` line in
`~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl`, so this is a *reader* over bytes
that exist, proved read-only by hashing every record and the resume pointer before and after,
grepping the module for write APIs, and reading with the AWS environment sabotaged. Four things are
load-bearing. The **binding** is enforced by position, not by a predicate: the completion menu's
`Up`/`Down` branches run first (so recall is unreachable with a `/` or `@` menu open), recall then
fires only from an **empty draft** — or from the first visual row of a draft that *is* an open walk —
and everything else falls through to `moveVertical`, which is what makes it *incapable* of replacing
typed text. Explicit Ctrl+S stash is separate from this automatic recall walk. **History is what was sent**: local commands never reach
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

**Reverse-search previews are single counted visual rows (SER-088).** `promptHistorySearchView`
projects its title and candidates through `search-preview.ts`; the `/rewind` view shares only
that presentation helper. CRLF is one visible ` ⏎ ` break, as are CR/LF, VT/FF/NEL and Unicode
line/paragraph separators; remaining C0/DEL/C1 controls become literal `\uXXXX` text so ANSI,
OSC, tabs and backspaces cannot control the terminal. Ordinary printable text is unchanged.
Ink's `truncate-end` bounds width but does not collapse explicit newlines, so this projection
must happen before the one-`Text`-per-row render. Raw query/filtering, prompt/checkpoint identity,
acceptance and Escape's exact draft/cursor snapshot never pass through it. No paste routing,
frame grant arithmetic, history/trajectory bytes or model-content formatter changes. Checks:
`verify-prompt-history-search.ts` and `verify-rewind-search.ts` render real InputBox at 24/100
columns across zero/short/full grants, selected windows and omissions; `verify-frame-budget.ts`
and free `verify-tui.ts historySearch` cover the budget and interactive reader/keyboard path.

**Paste follows the active search owner (SER-089).** Ink delivers bracketed paste on a
separate channel from `useInput`, so `App.usePaste` must enforce ownership too. After the
unchanged permission/compaction block, it applies `normalizeDraftText`, then routes to
rewind first, history second, through their immediate refs and existing bounded query
updates; only the fallback inserts into the composer. This preserves the 256-code-point
query caps and makes same-event paste/key sequences see current state without synthesizing
keys: pasted Enter/Tab/control text never accepts, branches, submits or queues. Search
filtering leaves the underlying draft and Escape snapshot untouched; explicit Enter/Tab
keeps its existing acceptance semantics. SER-088 remains presentation-only. No new row,
timer, store, runtime or permission-policy path. `verify-search-paste.ts` (registered in
`pnpm test`) drives both owners in the real CLI with private HOME/cwd and a local SDK model,
checks exact cancellation cursors and unchanged durable bytes/model-call logs, and covers
permission/compaction blocking, composer fallback and narrow frames.

## `!` shell commands

**A draft starting with `!` runs as the user's own shell command — outside the permission gate,
inside every honesty channel** (`src/tui/shell-command.ts`, App submit path). The gate's subject is model tool calls, so the
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
(`src/tui/prompt-queue.ts`, `src/tui/QueuedMessages.tsx`, App state in `src/tui/App.tsx`). SER-027 **deliberately
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
`queued ·` row per user entry with the cut stated; settled-task notifications share one summary
row (see below). The busy hint counts user entries and pending notifications separately so a
fully cut listing still cannot accumulate invisibly. `Up` from the draft's first visual row takes the
whole queue back into the editor ahead of typed text — the gesture joins the key chain between the
completion menu and prompt recall. A **cancel or a
failed turn returns the queue to the editor unsent** (auto-resending into an error is how retry
loops start), a pending permission holds it untouched, and `/clear` drops it with the conversation.
Nothing is recorded at enqueue time: a drained entry becomes a `userInput` at send time, and an
entry taken back or dropped was never sent — trajectory honesty by construction, which is also why
prompt recall needed no change. Free checks: `spike/verify-prompt-queue.ts`,
`spike/verify-tui.ts queue` / `bang`; live: the `usage` scenario's mid-turn half.

## Background-task wake — one queued session-originated turn, never a second channel

**A finished `bash start` job wakes the agent through the prompt queue: exactly one bounded
`<task-notification>` entry per task, from the terminal snapshot only, drained at idle through the
ordinary `submit()` as one ordinary turn** (SER-069; `src/tui/task-wake.ts`, `src/tui/prompt-queue.ts`,
`src/agent/task-terminal-delivery.ts`, the App's subscription and drain effects, `taskNotification`
in `src/trajectory/record.ts`). Before this, `BackgroundBashManager.subscribe()`'s one immutable
terminal snapshot reached only the transcript (`formatTaskCompletion`): the user saw a job finish,
the model learned of it only by polling `wait` — SRF-025's evidence measured that gap at ten 300 s
waits and 1.9 M prompt tokens for 1.6 K output in one session. The peer design
(`docs/research/research_2026-09-06.md`, sources S1/S2/S4/S5) shows both the right shape and every
way it fails: notifications are just another entry of one command queue (kept), but the peer fires
on stdout and re-fires per turn end (#74982), keeps a `notified` flag race with an idle drain that
has no retry (#88742 — a lost reply or a permanent stall), and decouples the notification from
`TaskOutput` so a task the model already read produces a duplicate turn (#52786). Darwin writes
each failure into a constraint: **terminal state only** — the enqueue is the manager's single
terminal snapshot, never output activity, never a turn end; **exactly once** — the manager
publishes once, the App refuses a second entry for a queued id, and the ledger below refuses one
for a delivered id; **a dependency of the drain, not a side effect of a render** — the wake is an
entry of `queued`, which the SER-027 drain effect already depends on, so a wake enqueued while a
permission prompt owns the frame is held (`pendingPermission`) and sent when the prompt resolves
and the turn ends, with no separate timer or retry to lose; **suppressed when already known** —
the runtime's `TerminalDeliveryLedger` observes `afterToolCallEvent`s at the same synchronous,
non-throwing point the recorder does, remembers task ids whose non-running `state` a successful
`bash` `wait`/`status`/`stop`/`list` result carried, and commits them only when the turn reaches
`endTurn`; `list` reaches the model as the SDK `FunctionTool`'s ordinary-array envelope — the
tool returns `manager.list()`, and a non-content-block array becomes one `JsonBlock` whose json is
exactly `{ $value: [...] }` — so the ledger unwraps that one exact shape (sole own key `$value`,
holding an array), one level, and checks each item as a snapshot; a bare array still counts,
while extra keys, a non-array `$value`, envelopes nested in the array or in `$value`, other tools
and non-success results count for nothing (SRF-033: before this, a completed `list` of stopped
jobs left eight redundant wake turns behind it); an **offloaded** result is read before the
offloader replaces it (SRF-036) — the SDK `ContextOffloader` swaps an oversized result for its
`[Offloaded: …]` text preview at default hook order, so the stream carries no parseable state, and
the ledger's `install()` therefore registers one read-only `HookOrder.SDK_FIRST`
`AfterToolCallEvent` hook on the parent Agent that keeps the original successful `bash` result's
terminal ids as candidates keyed by `toolUseId`; the stream-side `observe` resolves them: an
unchanged result (same object) counts exactly as before, a replaced one commits a candidate id only
when the model-visible replacement is still a success whose text contains that exact id — so a
`list`/`status` snapshot cut off by the preview stays undelivered and still wakes. The preview is
searched for the literal id only, never parsed for state; candidates follow the same `endTurn`-only
commit, and `closeTurn` drops unresolved ones (before this, three offloaded terminal waits in one
completed turn woke three full-context turns); the drain drops a queued wake for a committed
id silently (a row may show for the rest
of the turn that consumed the state, then leaves without a notice — the conversation already holds
the fact). Suppression is decided at drain time because at snapshot time the turn holding the
`wait` has not completed. **Next-turn-only** stands (deliberate non-parity with the peer's mid-turn
fold): busy, the wake waits in the FIFO like a prompt. **Ownership**: a wake is not the user's
to edit — take-back and the post-cancel return (`partitionQueue`) move only typed entries into the
editor and leave wakes queued in order; a wake whose *own* turn was cancelled or failed is **not**
re-sent (the SER-027 rule against auto-resending into an error; one `not delivered` notice names
the job, whose output stays readable) — the record's "re-queued unless its turn completed" is read
as applying to wakes queued *behind* the interrupted turn, because re-queueing a wake after the
user's own Esc would redrain it at once and trap the user in a cancel loop; `/clear` drops pending
wakes with the queue (the one window is the successor's assembly, where the predecessor's
subscription still enqueues and `setQueued([])` then drops); a subscription that ended before its
tail read resolved drops the wake rather than handing a predecessor's job to the successor. **The
turn is ordinary**: `runTurn` → `AgentRuntime.send(text, text, undefined, origin)`, so hooks, the
permission gate, the trajectory barrier and `TurnComplete` fire as for a prompt; only what sits
*above* the model is skipped (no slash expansion, no `!`, no held `!` reports), so the recorded
text is exactly what the model received; no rewind checkpoint is catalogued (the chooser lists the
user's prompts) and memory gets no user quote. **The record is `taskNotification`, never
`userInput`** (precedent: `shellCommand`): opened where `userInput` would be, behind the same
durability barrier, carrying the job fields plus the literal text; `prompt-history.ts` selects
`userInput` only, so `Up` and `Ctrl+R` never offer a wake back, while `trajectory search` still
finds it; replay dispatches the same `taskNotification` reducer action the live send dispatched,
so `formatReplay` and `/export` print the one `task wake ·` notice row — never a `you>` row, because
nobody typed it. The same record carries a settled background delegation's wake (SER-070) behind one
discriminator, `source: 'delegation'` — absent means a `bash start` job, so SER-069 records read
unchanged — with the delegation label where a job's command sits, `null` exit metadata, `state` from
the run's tool result, and a text that names the pair and never repeats the report; the reducer
prints it as the `delegation wake ·` notice.
**Rendering adds no surface**: all pending notifications share one counted row in the existing
queue region: `notifications · N pending (F failed, S stopped, C succeeded) · after this turn · /tasks`.
Zero outcome counts are omitted, failures come first, and delegation notifications point to
`/agents` (mixed sources name both reports). This is a display-only summary above the user rows,
not FIFO reordering or delivery: enqueue, suppression, drain, take-back and trajectory remain
unchanged. The frame claim is user-entry count plus at most one notification row; a one-row grant
for a mixed queue states the omitted user count inline. The busy hint says ` · N notifications
pending` beside ` · N queued`, including when the listing is fully cut. Notifications never dump
commands or model-facing text into the live frame; existing `/tasks` and `/agents` reports retain
the details. The send-time transcript row remains the same `<Static>` notice. **One
config key**, `backgroundTaskWake` (session-scoped, default on, validated like `contextOffload`);
`false` leaves the notice-only behaviour byte-identical. Headless drivers have no queue and never
wake. **The model is told the truth per runtime**: the TUI driver sets
`RuntimeOptions.backgroundCompletionWakes` (the one promise "this driver drains completion wakes";
SER-070 reads the same option to make background delegation non-blocking — see § "Background
delegation …"), and with the key on the parent's `bash` wrapper
(`createBackgroundBashTool(..., { completionWakes: true })`) states in its description and in the
still-running `wait` timeout instruction that ending the turn is followed by one
`<task-notification>` turn once idle — every other runtime keeps the byte-identical "background
completion does not resume the agent". The record's premise that `start` is parent-only was wrong —
`bash` is in the child catalogue, so a child can `start` a job — and what actually holds is that only
the parent TUI's observer enqueues wakes: a child-started job's completion wakes the *parent* with
the command and tail, a child's own `wait` is not in the parent stream so it cannot suppress, and
the child catalogue's `bash` wrapper keeps the no-wake wording whatever the parent's says. Free checks:
`spike/verify-task-wake.ts` (pty, in `pnpm test`: idle, suppressed, mid-turn, `/clear` window,
permission-prompt race, config off, record and replay), `spike/verify-prompt-queue.ts`,
`spike/verify-prompt-recall.ts`, `spike/verify-prompt-history-search.ts`, `spike/verify-config.ts`.
