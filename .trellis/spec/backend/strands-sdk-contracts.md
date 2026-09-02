# Strands TypeScript SDK Usage Contracts

> Hard-won, tested contracts for `@strands-agents/sdk` (verified on 1.12.0, 2026-08-13; pin moved to
> 1.16.0 on 2026-09-02 — every `†` suite and the patch-focused suites re-run green, see § SDK pin).
> Every rule here was validated by a runnable script under `spike/`; when upgrading the
> SDK, re-run the scripts named below before trusting these still hold.

---


## Clipboard image invocation (SER-041)

Interactive clipboard image input is one ordinary SDK invocation. `AgentRuntime.send(modelText, literalText, image)` passes `[new TextBlock(modelText), image]` to the existing `Agent.stream()` exactly once; it never constructs a second Agent, probes provider capability with another call, or intercepts the SDK loop. The provider's ordinary unsupported-image error remains unchanged and visible. The interactive driver restores the exact literal prompt plus same in-memory image after that failed invocation so retry/removal needs neither another provider call nor another clipboard read; text-only failure semantics stay unchanged. Image-bearing turns skip Darwin's text-only rewind catalogue because a prompt string cannot truthfully recreate the multimodal boundary.

The image bytes are live composer/queue state and SDK conversation content only. For a multimodal turn, trajectory and memory provenance receive the literal user prompt, not expanded command text, held shell reports, image bytes, base64, clipboard contents, a fabricated path, or synthetic attachment text. Replay/export/recall therefore remain text-only by construction. `spike/verify-runtime-image-input.ts` uses the runtime's existing offline model factory seam to prove one model call receives one user message containing text plus exact bytes and that the trajectory contains only literal text. `spike/verify-image-viewer.ts` proves clipboard decoding and path-based `imageViewer` share one bounded decode/normalization policy.

## Agent Assembly

## SER-040 conversation-only rewind

`/rewind` is an SDK-snapshot branch, never an Agent-loop fork or trajectory replay. Before an editor-eligible invocation (`<= 4000` Unicode code points), `AgentRuntime.send()` first calls public `SessionManager.listSnapshotIds({ target, limit: 100 })`. A per-runtime promise tail serializes that check/save/identify critical section so concurrent callers cannot both claim the final slot. Only while fewer than 100 rewind-owned immutable snapshots exist does it save one and identify it with a second public listing bounded to one row (`startAfter` the previous id). Failed, cancelled and abandoned turns consume this same capacity because their immutable snapshots cannot be deleted or reused; at capacity capture is omitted, while the ordinary invocation and mutable latest snapshot continue. Only a normal `agentResultEvent { stopReason: "endTurn" }` promotes a captured id plus bounded prompt text into `<session-state>/rewind-checkpoints.json`; failed, cancelled, abandoned, oversized, in-progress and post-capacity prompts are not selectable. Catalogue reads are strict and bounded at 100 entries / 512 KiB. Existing immutable snapshots are never deleted or rewritten.

Acceptance re-reads the current source catalogue, then creates a fresh Agent through `AgentRuntime.create()`. After `initialize()` has established the new session, a source `SessionManager.restoreSnapshot({ snapshotId })` loads the authoritative checkpoint; Darwin then drops any historical ambient-memory block, refreshes current working context and the final system-prompt cache point in the ordinary restore order before writing the successor's own `snapshot_latest`. The source latest/immutable snapshots, catalogue, trajectory and resume pointer are never copied, truncated or rewritten. The pointer still moves only through `markResumable()` after the successor completes a turn.

The predecessor transfers live permission mode, MCP clients and the process-owned background-task manager exactly as `/clear`, and retires only after successful successor assembly. On failure it stays live. The selected prompt returns to the editor unsent. The visible notice is required to state that the workspace is unchanged and that workspace files, shell and `!` effects, hooks, MCP writes, subagents, background jobs and learned-memory files were not rewound. Checks: `spike/verify-rewind.ts`, `spike/verify-rewind-search.ts`, and free `spike/verify-tui.ts rewind`.
## Context offload defaults

Every main `AgentRuntime` installs the SDK `ContextOffloader` unless effective config explicitly sets `contextOffload: false`. Omitted config therefore resolves to concrete `true`; `maxResultTokens` is valid with omitted/default-on or explicit `true` and invalid with explicit `false`. Keep session-scoped `LocalFileStorage`, the SDK default 2,500-token threshold and 1,000-token preview unless overridden, `retrieve_offloaded_content`, and `evictAfterCycles: null`, so references remain durable across resume. Headless `--context-offload` remains a process-only force-on override that does not mutate loaded or persisted config. Main-runtime successors rebuild the same policy through `AgentRuntime.create`; child Agents retain their existing separate conversation/result contract and receive neither parent offload storage nor the retrieval tool.

The pinned SDK offloader also scans restored messages exactly once on the Agent's first `BeforeModelCallEvent`, after `SessionManager` initialization restore and before provider request cloning. Oversized successful legacy `ToolResultBlock`s use the same count/store/preview/reference transformation as new results. The scan first resolves historical `ToolUseBlock` identities against the live tool registry, so delegated final answers and retrieval-tool results retain the normal-path exclusions; it accepts a prior `[Offloaded: …]` block only when its exact marker shape, tool-use-bound reference names, and current durable-storage entries all verify, never marker text alone. Replacement is in-place at the content-block slot, preserving the `Message` object and its tracking id/metadata/order plus tool-use id/status/pairing. Count/store failure leaves the original block intact, creates no published dangling reference, best-effort removes successful sibling unified-storage writes from a failed multi-block attempt, continues over the finite restored list, and cannot turn into a per-cycle retry. Invocation autosave persists any repair for the next restore.

An unrecovered `ContextWindowOverflowError` receives one bounded driver projection shared by interactive, text-headless, and structured-headless paths, recommending `/compact`, a narrower request, or `/clear`. It does not change the thrown object, trajectory failure observation, schema v1, stream-interruption exclusion, or ordinary errors.

Checks: `spike/verify-config.ts`, `spike/verify-context-offload.ts`, `spike/verify-context-overflow.ts`, `spike/verify-headless.ts`, `spike/verify-headless-structured.ts`, and `spike/verify-skills.ts`.




Only `src/agent/runtime.ts` constructs the SDK `Agent`. Keep it a thin assembly; all
customization goes through SDK extension points (interventions, plugins, conversation
manager), never by forking the agent loop.

## SRF-016 repeated-failure retry guard

- The guard is an SDK intervention composed with project hooks and permission, never an SDK-loop fork or driver retry. Within one invocation the order is plan guard → repeated-failure guard → `PreToolUse` → permission → tool body → `PostToolUse` → failure observation. A guard denial therefore executes none of Pre, permission, body, or Post; ordinary unknown-tool and child permission behavior is unchanged.
- Failure keys are tool name plus bounded deterministic Unicode-normalized failure class/signature. Retained tools/signatures, normalized text, and visible messages are capped. The first three outcomes for one signature remain original and visible; after the second, bounded pre-model guidance requires a materially new evidence-backed hypothesis. After the third, guidance and any later denial say to stop, report the blocker/artifacts, and ask the user before continuing.
- A different signature proceeds. A successful result clears that tool's retained failures. `BeforeInvocationEvent` replaces state even if a caller reuses its `invocationState`; the shared parent/child intervention additionally keys state by Agent, so concurrent children are isolated.
- `ToolResultBlock.status: error` is a failure. Bash also has explicit structured failure status: foreground execute carries the command's numeric `exitCode` from the pinned SDK patch, and background status/wait carries `state: failed`; arbitrary stderr on an exit-0 command is not reinterpreted. User-authored `!` commands do not use the Agent tool intervention and are outside the guard.
- Allowed tool results are never transformed, hidden, or replaced, and trajectory/output protocols remain observers of the ordinary SDK events. Default system guidance mirrors the runtime rule; inline/file system-prompt replacement remains exact.
- Contract check: `spike/verify-retry-guard.ts` is a network-free real-Agent suite in `pnpm test`; `spike/verify-tool-hooks.ts` and `spike/verify-background-bash.ts` retain the adjacent ordering and shell contracts.


## SER-031 agent-managed project-memory contract

`AgentRuntime.create` remains the only assembly boundary. Memory is enabled by default when trajectory
recording is available; root config `memory: false` opts out, omitted memory follows `trajectory: false`, and
explicit `memory: true` with `trajectory: false` is a startup `ConfigError`. Enabled runtimes register
`memory_recall` and `memory_save` only on the parent after the child catalogue is fixed. Recall is a statically
safe bounded local lexical read. Save is a dangerous, rule-exempt ordinary write: default asks, auto uses the
existing classifier, plan denies before side effects, and yolo proceeds. Neither tool constructs/intercepts an
Agent loop, invokes another tool, or makes a separate model/network/vector call.

Save accepts one atomic closed-category fact. Project claims require a unique exact current project-relative
line reopened and hashed by Darwin; preferences and non-secret identity require a unique exact quote from the
current user input. Quote fields (`evidence.quote`, `userQuote`) are bounded but never trimmed — the quote must
stay byte-identical to the full source line, including indentation and trailing whitespace, or to the literal
user input. Evidence rejection is reason-specific from a closed failure set: the controller distinguishes at
least a quote that is not one bounded line, an unsafe path, an oversized source, an unreadable/missing source,
no matching line, and multiple matching lines; the resolver's safety checks are unchanged in effect. A runtime
controller stages at most eight candidates in the active recorded turn, then
commits only after both exact successful `endTurn` sealing and matching durable closing-append settlement.
Failure, cancellation, partial/abandoned output, recorder degradation, resume, or `/clear` before acceptance
discards staging. Accepted commits serialize during orderly cleanup and cannot change the completed turn.

Strict project-bound `state.json` v3 is authoritative; generated IDs derive from normalized key plus fact,
duplicates collapse, newer validated same-key generated facts supersede older ones, and user notes remain
distinct. V1/v2 reads atomize only anchored facts and require current revalidation before authorized write;
suppressions, expiry and no-follow/private atomic file protections remain. Recall revalidates with
`persist: false` and labels output fallible data, not policy. The full archive is never ambient prompt input;
prompt order is base → project instructions → official skills → current working context → final cache point.


## SER-032 local project-memory management

- `/memory` is handled only by the interactive driver. It is not an SDK tool, intervention, hook, custom command expansion, or model invocation.
- Grammar is closed: bare/list, `show <safe-id|one-based-list-number>`, `forget <safe-id|one-based-list-number|all>`, and `remember <bounded-note>`. No path argument is ever opened.
- `memory/state.json` under the existing project-keyed user directory is the strict v3 authority. It carries the canonical project key; reads use bounded regular-file/no-follow checks, strict UTF-8, parent-directory checks, and exact schema validation. Malformed, oversized, wrong-project, forged, or symlinked state is refused.
- V1/v2 state is accepted only through deterministic in-memory atomization. Read-only list/show revalidate without writing; the first authorized mutation keeps only currently eligible anchored legacy facts, while preserving user notes and bounded suppression ids. Markdown and legacy topic files are never parsed back as authority.
- Generated entries expose stable id/key/category, one fact, host-owned turn provenance, exact evidence metadata, and current validation. Explicit user entries retain authored time and `explicit/unvalidated`; they are intentionally not code-validated or age-expired.
- Remember is explicit user input only and rejects secret-like, boundary-tag, control, dump, oversized, temporary, and policy-like text. The parent-only `memory_save` tool is the only generated write path.
- Forget records bounded generated-id/legacy-lineage suppression and removes user entries. A later save cannot restore the exact suppressed generated fact; a newly approved changed fact under the same key remains distinct.
- Model saves and management serialize on the same state lock. Authorized mutation atomically commits strict state, regenerates the optional human index, and removes only safely validated obsolete legacy topic projections. No operation mutates the live system prompt.
- List/show are byte-zero projections. Every operation leaves source/worktree, trajectory, snapshots, resume pointer, config and unrelated files untouched and uses only the existing transcript notice surface.


### Contract: `printer: false` is mandatory



The SDK's default printer writes tool banners and streamed text to stdout, which fights
Ink for the terminal. Every `new Agent({...})` in this project must pass `printer: false`.
(Verified: `spike/bedrock-stream.ts`.)

## SER-033 generated-memory validation and expiry

- Strict project-bound state is v3. V1/v2 generated topics are atomized into bounded single-fact legacy entries with deterministic keys/lineage, but stored validation metadata is never trusted. Missing or unsafe deterministic evidence is omitted, never guessed or backfilled from trajectory.
- `memory_save` validates current evidence before staging and repeats validation at durable commit. `memory_recall` and `/memory` list/show revalidate in memory with `persist: false`; fresh, resumed and `/clear` runtimes inject no archive and create no state merely by starting.
- Validation opens only canonical-root-contained regular files read-only/no-follow, with finite file/line/code-point/entry bounds and exact hashes. Traversal, symlink escape, changed/deleted evidence, binary/oversized/unreadable files all fail closed and generated entries are omitted from recall.
- `memoryHorizonDays` is one strict top-level session field, integer 0–365, default 28, preserved across model switches and `/clear`. Generated evidence is expired at the exact horizon boundary; 0 deliberately disables age expiry but never source validation.
- Generated preference/identity entries use only a host-created hash and length after an exact unique current-input quote check; the quoted input is not duplicated into state. Explicit `/memory remember` notes neither auto-expire nor undergo silent code validation.
- Validation never rewrites source, trajectory, snapshots, pointers, config, or unrelated state and adds no watcher, polling, timer, model/network work, vector store, or dependency.


### Contract: `await agent.initialize()` before anything else

The constructor defers initialization to the first invocation. Session restore, MCP tool
discovery, and plugin system-prompt injection all happen in `initialize()` — without the
explicit await, `--resume` silently restores nothing and MCP tools don't exist yet.
(Verified: `spike/verify-step-1-2.ts`.)

### Contract: stable `Agent.id`

Session snapshots live under `<sessionId>/scopes/agent/<agentId>/`. A changing agent id
hides all previous snapshots from resume. The id is the constant `AGENT_ID` in runtime.ts.

### Contract: a session id cannot be changed on a live `Agent` — a new session needs a new `Agent`

`SessionManager` is a `Plugin`. `Agent`'s constructor appends it to the `PluginRegistry`
(`agent.js`: `...(config?.sessionManager ? [config.sessionManager] : [])`) and `initialize()`
calls `PluginRegistry.initialize(this)`, which runs `SessionManager.initAgent(agent)` — that is
where its `AfterInvocationEvent` / `MessageAddedEvent` snapshot callbacks are registered. Three
facts make in-place session switching impossible:

- `_sessionId` is `private readonly`; there is no setter and no `updateConfig`.
- `PluginRegistry` exposes no removal, and the `HookCleanup` returned by each `addCallback` is
  kept inside the plugin. Nothing can un-register a manager's hooks.
- `agent.sessionManager` is a plain field, so *assigning* a second manager type-checks and
  silently leaves the first one live. At the end of the next turn **both** save: the retired
  manager overwrites the previous session's `snapshot_latest.json` with the new conversation.

So `/clear` constructs a successor `Agent` through `AgentRuntime.create()` and retires the
predecessor. Verified in `spike/verify-clear-session.ts`: the successor's snapshot lands under
its own session id and the previous session's snapshot file is byte-identical afterwards, still
holding only its own conversation.

### Contract: an `McpClient` may be shared with a second `Agent`; `onToolsChanged` is single-slot

`Agent.initialize()` does two things per client: `await client.listTools()` and
`client.onToolsChanged = …`. `McpClient.connect()` returns immediately unless the state is
`disconnected`, so handing the *same* client objects to a second `Agent` re-lists tools over the
live connection and spawns no second stdio server. But `onToolsChanged` is one assignable
property, not a listener list: the **last** `Agent` initialized owns tool-change updates. That is
only correct if the predecessor is retired straight away — which is what `startNewSession()` does,
and why `retire()` must *not* call `disconnectAll`.

### Contract: CodeGraph semantic MCP reads preflight an existing index

After `Agent.initialize()` discovers MCP tools, a runtime configured with the exact server name
`codegraph` replaces only its `search`, `explore`, `node`, `callers`, `callees`, `impact`, and
`files` tools before capturing the child catalogue. The parent and every child therefore share the
same wrapped tool objects; `status`, unknown CodeGraph tools, and every other MCP client remain
unchanged. The SDK's existing `tools/list_changed` callback is decorated, not replaced, so refreshed
semantic tools are wrapped while its ordinary old-name removal and registration lifecycle stays intact.

The runtime primes its project root once and caches each bounded explicit absolute `projectPath`
independently. Relative, traversal-bearing, non-string, NUL-bearing, and oversized explicit paths
are rejected before filesystem inspection. A target is usable only when it and its
`.codegraph/codegraph.db` route are non-symlink directories/files, the database is a readable
regular file, and a bounded read-only database-file inspection finds the SQLite header plus
CodeGraph's `files`, `nodes`, `edges`, and `schema_versions` schema records. Missing, unreadable,
malformed, symlinked, or structurally invalid state returns
one bounded successful result directing the agent to `bash` / `fileEditor`; the MCP body is not
called. A usable target delegates the original generator unchanged, preserving its events and final
result. This policy never initializes an index, writes project state, calls a model, or changes MCP
startup, disconnect, permissions, interventions, or `/mcp`. Verified network/model-free by
`spike/verify-codegraph-preflight.ts` in `pnpm test`.

### Contract: web-search zero hits are successful empty results

`web-search` is an external MCP provider, but Darwin owns the registered catalogue after
`Agent.initialize()`. For the exact configured client name `web-search`, Darwin replaces only the
server-side `search` tool before capturing the child catalogue and decorates the SDK's existing
`tools/list_changed` callback so refreshes retain the same policy. Parent and child agents therefore
share the same wrapped tool object without a second search implementation or MCP lifecycle.

The wrapper delegates first and normalizes only the verified provider no-hit result: an error-status
result with no attached thrown error and exactly the recorded MCP `-32602` / `Tool returned no
results` text. That outcome becomes compact successful JSON containing the original string `query`,
`results: []`, and `totalResults: 0`, so absence neither enters repeated-failure accounting nor asks
for recovery. Non-empty successes, yielded events, malformed inputs, transport/authentication/
timeout failures, and every other provider error pass through unchanged. Permissions, hooks,
trajectory and output protocols continue to observe the ordinary wrapped tool call. Verified by the
network/model-free real-MCP suite `spike/verify-web-search-empty-results.ts`; retry/hook/subagent
suites retain adjacent contracts.

### Contract: the vended bash tool keys and serializes its persistent shell per `Agent` instance

`vended-tools/bash` holds `sessions: WeakMap<Agent, BashSession>` off `context.agent`. Two
consequences: a new `Agent` always starts with a fresh shell (cwd and exported variables do not
survive `/clear`), and the *old* Agent's shell must be stopped explicitly via
`invoke({ mode: 'restart' })` — the SDK's `beforeExit` reaper never runs, and leaving it costs
~15 s of extra process exit time (measured with `retire()`'s `stopBashSession()` removed).

Darwin's pinned SDK patch also serializes `execute` and `restart` per Agent. The unpatched SDK
allows parallel calls to attach listeners for one process and sentinel, so each call can receive
the first command's output or reject on the same close. Distinct Agents retain independent
queues and shells. If a running command closes its shell with numeric code 0 and no signal, the
call succeeds with that invocation's captured stdout/stderr plus a visible restart notice; the
next queued call starts a replacement shell. Nonzero or signalled closes remain
`BashSessionError` and expose `exitCode`, `signal`, `output`, and `error`. A second stderr
sentinel keeps normal completion open until both streams have crossed the command boundary, so
stderr cannot leak into the next invocation.

A foreground `execute` that exceeds its timeout (SER-054) still kills the persistent shell — it
cannot detach a running command, so Darwin does **not** imitate Claude Code's move-to-background;
the kill stands and the next queued call starts a replacement shell at the initial cwd. What
changes is the evidence: the rejected `BashTimeoutError` carries `output` and `error` (the
trailing ≤ 64 KiB of each captured stream, never starting inside a multi-byte sequence), `cwd`
(the replacement shell's cwd) and `timeoutSeconds`, and its message — which the SDK's
`createErrorResult` turns verbatim into the `Error: …` tool result — states, in this order:
`Command did not complete within N seconds and was killed.`; `stdout captured before the
timeout (<n> bytes):` or `(last <kept> of <total> bytes; hasMore: true):` followed by the tail,
or `: (none)`; the same for stderr; `Persistent bash shell was killed with the command; it will
restart before the next command with cwd: <initial cwd> (…)`; and one pointer to `mode "start"`
plus `"wait"` instead of raising the timeout. The 64 KiB cap and the `hasMore` word are the
background `output`/`wait` projection's (`OUTPUT_LIMIT` in `src/tools/background-bash.ts`) — the
patch's `TIMEOUT_TAIL_LIMIT` must stay equal to it and no second cap or vocabulary may appear.
`stop()` also resets the tracked effective cwd to the initial cwd, so the wrong-root preflight of
the first post-timeout command judges against the shell that will actually run it. Everything
else — kill/exit semantics, `SHELL_RESTART_NOTICE`, exit-0 success, `BashSessionError`,
background modes, the `timeout` schema field, and the byte-exact result of a command that
finishes in time — is unchanged.

Darwin constructs the foreground tool with the already-verified `RuntimeOptions.projectRoot` as
both initial cwd and session project root. Each serialized execute appends a private `pwd -P`
probe in the same shell write, strips that marker, and returns `cwd`; configured restart returns
the reset cwd. Thus cwd cannot race another foreground invocation and no Darwin module reaches
for ambient `process.cwd()`. Before writing a command, the session may return a non-mutating
wrong-root diagnostic, but only for the SRF-014 evidence shapes: a whole simple `cd <relative>`
or a plain command-position relative path containing `/`. Quotes, escapes, newlines, operators,
redirection, substitution, glob syntax, options, absolute paths, bare PATH commands, and unrelated
arguments all fail open to bash. A candidate is refused only when absent under effective cwd and
present under the session project root; the diagnostic names cwd, both resolved locations, and a
root correction. Existing cwd-relative paths and paths missing in both locations execute normally.

#### Validation & error matrix

| Persistent foreground outcome | Required result |
|---|---|
| Sentinel appears on stdout and stderr | Return `{ output, error, cwd }` with no notice |
| Configured explicit restart | Return the restart message plus reset project-root cwd; replacement remains lazy |
| Eligible path absent under cwd but present under project root | Return `{ output: '', error: <diagnostic>, cwd }` before shell write; launch/mutate nothing |
| Eligible path exists under cwd or is absent in both places | Run unchanged and return ordinary shell output/error/cwd |
| Shell closes with `code === 0`, `signal === null` | Return captured buffers and last effective cwd; append the restart notice to `error`; next queued call starts a shell |
| Shell closes nonzero | Throw `BashSessionError` with exact `exitCode`, `signal: null`, `output`, `error`, and last effective `cwd` |
| Shell closes by signal | Throw `BashSessionError` with `exitCode: null`, exact `signal`, `output`, `error`, and last effective `cwd` |
| Foreground `execute` exceeds its timeout | Kill the shell (no detach, no auto-background); throw `BashTimeoutError` whose message states timeout figure → bounded stdout tail → bounded stderr tail → killed/restart-with-cwd → `start`+`wait` pointer, and whose `output`/`error`/`cwd`/`timeoutSeconds` fields carry the same; next queued call starts a shell at the initial cwd |
| Parallel executes on one Agent | Settle in invocation order with disjoint captured buffers |
| Execute/restart on different Agents | Remain independent; do not share a queue or shell |

Good: `Promise.all` of three same-Agent calls yields three command-owned results even when the
last command runs `exit 0`, then a fourth call succeeds in the replacement shell. Base: ordinary
commands preserve cwd/exported state and explicit restart clears it. Bad: matching the old error
message in Darwin cannot recover captured buffers or signal metadata and leaves the listener
race intact.

Required assertions live in `spike/verify-background-bash.ts`: real initial/persisted/restarted
cwd, conservative refusal and pass-through shapes, no-launch/no-mutation evidence, real parallel
invocations, stdout/stderr ownership, visible exit-0 notice, replacement health, nonzero/signal
metadata, queue recovery, normal persistence, raw permission/hook input, per-Agent isolation,
the timeout result (fields, ordered message, byte-identical in-time result, 64 KiB `hasMore`
tail, multi-byte-safe cut, post-timeout preflight cwd, queue continuation), and
all background TERM→KILL/exit cleanup cases. Also run `probe-cancel-exit.ts`,
`verify-clear-session.ts`, and the
`bashExit` / `cancelThenContinue` TUI scenarios after changing the patch.

### Contract: SDK HTTP request is a parent-only ordinary gated tool

#### Scope / trigger

When exposing the installed SDK HTTP request vended tool, import `httpRequest` from
`@strands-agents/sdk/vended-tools/http-request` and register that singleton directly in the parent
`AgentRuntime` tools list. Do not wrap its callback, add a second network path, construct another
Agent, or add it to child tool catalogues.

#### Signatures

The SDK-owned export is `httpRequest`; its provider tool name is `http_request`. Its request schema
accepts `method: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH'|'HEAD'|'OPTIONS'`, `url: string`, and optional
`headers: Record<string, string>`, `body: string`, and positive `timeout: number`. Darwin does not
copy or redefine this schema.

#### Contracts

The parent assembly passes the exact SDK singleton in `Agent({ tools: [...] })`. Consequently every
model-generated call traverses Darwin's existing composed intervention in retry → Pre hook →
permission → SDK callback → Post hook order. `classify('http_request', input)` intentionally uses
the unknown-tool fallback and returns `kind: 'execute'`; default/auto modes therefore cannot run it
without their ordinary decision, and plan mode denies it before prompting or calling `fetch`.
Children remain unchanged and do not receive the tool.

#### Validation & error matrix

| Case | Required behavior |
|---|---|
| Fresh parent runtime | Exactly one registered tool named `http_request`, identical to the SDK export |
| Default mode, user denies | Permission bridge sees parent `execute`; callback/network never runs |
| Plan mode | Denied before permission bridge and callback/network |
| Child catalogue | No `http_request` tool — enforced by the `PARENT_ONLY_TOOL_NAMES` filter that derives `childTools` in `runtime.ts` (a project agent definition whose `tools` allowlist names it is reported as an unknown tool) |
| Approved/yolo parent call | SDK owns input validation, cancellation, timeout, request, and result/error shape |

#### Good / base / bad cases

Good: add the imported SDK singleton to the existing parent tools array and let the composed
intervention gate it. Base: no model asks for HTTP, so startup only registers metadata and performs
no request. Bad: directly call `httpRequest.invoke()`, special-case it as `read`/safe, wrap `fetch`,
or append it in `SubagentTool.toolsFor()`.

#### Tests required

`spike/verify-http-request-tool.ts` must use a fake model and poisoned `globalThis.fetch` to prove
actual-name/identity registration, default denial classification/source, plan pre-prompt denial,
and zero fetch calls. It belongs in `pnpm test` and must make no real model or network call.

#### Wrong vs correct

Wrong: `tools: [...]; void httpRequest.invoke(input)` from a driver or helper, which bypasses the
Agent intervention. Correct: `tools: [..., httpRequest, ...mcp.clients]` only in the parent assembly,
with `http_request` left to the fail-closed permission fallback.

### Contract: `web_fetch` is a parent-only bounded readable projection, a sibling of `http_request` (SER-056)

#### Scope / trigger

When the model needs to *read* a web page rather than obtain its raw bytes, the parent runtime
offers `web_fetch` (`src/tools/web-fetch.ts`, built with the SDK `tool()` factory). It is
registered in the same parent `tools:` list directly after `httpRequest`. It never imports, calls,
wraps or reconfigures `httpRequest`: the SDK singleton stays byte-identical and its contract above
is unchanged.

#### Signatures

```ts
webFetch: InvokableTool<{ url: string; maxChars?: number }, WebFetchResult>   // name 'web_fetch'
interface WebFetchResult { url: string; status: number; contentType: string; body: string; notice: string[] }
normalizeWebFetchUrl(raw): { url: string; upgraded: boolean }   // throws before any request
htmlToText(html, baseUrl): string
boundCodePoints(text, budget): { body; shown; total }
fetchWebPage(input, { fetchImpl?, signal? })   // the callback body; fetchImpl defaults to globalThis.fetch per call
WEB_FETCH_MAX_CHARS = 40_000; WEB_FETCH_MAX_DOWNLOAD_BYTES = 4 MiB; WEB_FETCH_MAX_REDIRECTS = 5; WEB_FETCH_TIMEOUT_SECONDS = 30
WEB_FETCH_ACCEPT = 'text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1'
WEB_FETCH_TRUNCATION_NOTICE = '[truncated: N of M code points]'   // formatTruncationNotice(shown, total)
```

#### Contracts

- GET only, `Accept` = `WEB_FETCH_ACCEPT`, `User-Agent` names darwin. `http:` is upgraded to
  `https:` before the request and stated in `notice`; any other scheme or an unparsable URL is a
  bounded error before `fetch` runs.
- Redirects use `redirect: 'manual'`. A target whose `URL.host` (hostname and port) equals the
  current host is followed, at most `WEB_FETCH_MAX_REDIRECTS` hops (the next hop is a bounded
  error); each hop is re-normalized (upgraded if `http:`). A target on another host is **not**
  followed: the result is successful with the redirect `status`, the original `url`, an empty
  `body` and a `notice` naming both URLs. A 3xx without `Location` is reported the same way.
- Content: `text/html`/`application/xhtml+xml` — or an undeclared type whose first bytes sniff as
  HTML — becomes `htmlToText` output plus `WEB_FETCH_LOSSY_NOTICE`; `text/*`, JSON/XML/JS/YAML
  application types and `+json`/`+xml` are kept verbatim; a declared non-text type is a bounded
  error naming the type and the `Content-Length` (or "unknown length") without reading the body;
  an undeclared type containing NUL in its first KiB is refused after the bounded read. Non-2xx
  statuses keep the body and add an `HTTP <status>` notice.
- `htmlToText` is dependency-free and local per tag: `script`/`style`/`noscript`/`template`/
  `svg`/`nav`/`header`/`footer`/`aside` subtrees and comments dropped, `head` dropped except its
  `title` (rendered as the first `# ` line); `h1`–`h6` → `#`×N, block elements → line/paragraph
  breaks, `li` → `- `, `blockquote` → `> ` per line, `pre` → fenced with whitespace preserved,
  inline `code` → backticks, `a[href]` → `text (absolute url)`, `img` → `[image: alt]`, table
  cells joined with ` | `; named (common set) and numeric entities decoded; whitespace runs and
  blank-line runs collapsed. Malformed markup degrades to text, never throws.
- Bounds: the raw download stops at `WEB_FETCH_MAX_DOWNLOAD_BYTES` (stated); the body is cut at a
  code-point boundary to `min(maxChars, WEB_FETCH_MAX_CHARS)` — an over-ceiling `maxChars` is
  clamped and stated — and a cut appends `formatTruncationNotice(shown, total)` to `notice`.
- Cancellation: the callback composes `AbortSignal.any([AbortSignal.timeout(30 s),
  context.cancelSignal])` itself and maps `AbortError`/`TimeoutError` to a bounded
  `web_fetch: request cancelled|timed out …: GET <url>` error — the same composition as
  `http-request.js`, implemented locally.
- Permission: `classify('web_fetch', input)` is the unknown-tool fail-closed default — `execute`,
  summary `web_fetch (unrecognized tool — approval required)`, the JSON input (URL) in the `Input`
  detail. Do not add a `read`/safe case. `plan` denies before any request; `default` prompts;
  wildcard allow-rules may cover it.
- Registration: parent `tools:` only. `PARENT_ONLY_TOOL_NAMES` in `runtime.ts` (the filter that
  derives `childTools`) names `retrieve_offloaded_content`, `http_request` and `web_fetch`; a
  project agent definition whose `tools` allowlist names either network tool is reported as an
  unknown tool in `info.agentProblems`. Never append it in `SubagentTool`/`WorkflowTool` or the
  child recipe.

#### Validation & error matrix

| Case | Required behavior |
|---|---|
| `http://…` input | requested as `https://…`; `notice` states the upgrade |
| `ftp:`/`file:`/`javascript:`/garbage | bounded `web_fetch:` error, zero requests |
| `text/markdown` / other `text/*` / JSON | body verbatim, `notice` empty (unless truncated) |
| HTML (declared or sniffed) | readable projection + lossy notice |
| declared binary type | error naming type and length; body never read |
| body over budget | body = first `min(maxChars, 40 000)` code points + `[truncated: N of M code points]` |
| `maxChars` > ceiling | clamped to 40 000 and stated |
| > 4 MiB body | download capped and stated; then the code-point budget applies |
| same-host redirect | followed; `url` is the final URL |
| cross-host redirect | one request; `status` 3xx, original `url`, empty body, both URLs in `notice` |
| > 5 same-host hops | bounded error naming the hop limit |
| non-2xx | body kept, `HTTP <status>` notice |
| `cancelSignal` aborted | rejects with `web_fetch: request cancelled: GET <url>` |
| classification | `execute` via the default branch, URL in details; plan denies with zero requests |
| child catalogue | absent; allowlist naming it is an unknown-tool problem |

#### Good / base / bad cases

Good: `web_fetch({ url })` for documentation, changelogs, issue pages; `http_request` when the raw
body, a non-GET method or response headers are needed. Base: no page is fetched, startup registers
metadata only. Bad: wrapping `httpRequest` to post-process its body, classifying `web_fetch` as
`read`, following cross-host redirects silently, returning binary bytes, adding an HTML parser
dependency, or handing the tool to children.

#### Tests required

`spike/verify-web-fetch.ts` (in `pnpm test`) drives a local `http.createServer` fixture through an
injected `fetchImpl` that rewrites only the fixture origin from `https` to `http`, and proves every
row above plus the pure helpers; its runtime section reuses the fake-model/poisoned-`fetch`
technique of `verify-http-request-tool.ts`, which must stay green and unchanged.

#### Wrong vs correct

Wrong: `const page = await httpRequest.invoke({ method: 'GET', url }); return htmlToText(page.body)`
— calls and post-processes the SDK singleton. Correct: an independent `fetchWebPage` in
`web-fetch.ts` that owns its request, redirect, classification and bounding, registered next to
`httpRequest` and excluded from children by `PARENT_ONLY_TOOL_NAMES`.

### Contract: fileEditor clamps only oversized positive view ends

#### Scope / trigger

Darwin imports the SDK-vended `fileEditor` singleton directly in `src/agent/runtime.ts`; parent
and child agents therefore share its provider schema and implementation. SDK 1.12.0 rejects a
positive `view_range` end above the file's effective line count, which turns an otherwise safe
read into a failed tool call and immediate `-1` retry. Darwin's version-pinned SDK patch changes
only that range normalization inside `applyViewRange()`; do not wrap the tool, duplicate its
schema, rewrite returned text, or move this policy into permissions/TUI code.

#### Signature and request/response contract

The provider-facing input remains `view_range?: [number, number]`, 1-indexed, with `-1` as the
only EOF sentinel. For `command: "view"` on a non-empty regular text file, an otherwise-valid
positive `end > nLines` uses `effectiveEnd = nLines` and returns the ordinary numbered
``cat -n`` string. The supplied range is not rewritten in context, and the output shape, line
numbers, tab expansion, trailing newline, read/decoding path, and 1 MiB size check remain SDK
owned. No file write may occur.

#### Validation & error matrix

| `view_range` / target | Required result |
|---|---|
| `[1, 100]`, 41-line non-empty file | Success; exact same bytes as `[1, -1]`; exactly lines 1–41 once |
| `[start, end]`, positive in-range end | Existing exact slice/output |
| `[start, -1]` | Existing EOF-sentinel slice/output |
| start `< 1` or start `> nLines` | Explicit first-element error; never clamp start |
| effective positive end `< start` | Explicit ordering error |
| end `0` or `< -1` | Explicit ordering error; never treat as EOF |
| empty file with oversized positive end | Existing second-element error (empty-file behavior unchanged) |
| directory/missing/binary/oversized file | Existing listing/path/decoder/size behavior before range normalization |

Good: call the exported tool through `stream()` with `[1, 100]` and receive all 41 numbered rows
without any sandbox write. Base: `[7, 12]` and `[7, -1]` remain byte-compatible. Bad: clamping a
start beyond EOF, accepting `0`/`-2`, changing the public schema, or normalizing before the SDK's
path/directory/read/size checks.

Required assertions live in `spike/verify-file-editor.ts`: provider schema, real 41-line output,
source-row uniqueness/order, sentinel/in-range compatibility, write-call and file-byte/metadata
purity, invalid-bound errors, and unchanged empty/directory/missing/decoding/size behavior. Run it
when upgrading `@strands-agents/sdk` or changing the pinned patch.

Wrong: wrap `fileEditor` in Darwin to reproduce its mixed read/write schema or post-process an
error string. Correct: keep runtime assembly unchanged and patch the SDK-private range helper,
where the full content and all existing validation context already live. (The SRF-020 ordering
wrapper below is not this: it delegates the unchanged SDK `stream()` and touches neither schema
nor bytes — it only decides when a same-path mutation starts.)

### Contract: exact fileEditor str_replace misses include bounded advisory context

#### Scope / trigger

The same version-pinned SDK patch extends only `buildStrReplaceResult()` after exact occurrence
counting returns zero. The call remains an error and `handleStrReplace()` never reaches
`sandbox.writeText()`. Exact unique replacement, multiple-occurrence errors, required-field/path/
directory/read/size validation, provider schema, and all `view` behavior stay SDK-owned and
unchanged. Never use an advisory candidate to mutate, retry, read another path, or convert the miss
into success.

#### Deterministic bounded matching and output

The miss path searches current content only after the existing 1 MiB UTF-8 check. `old_str` is
accepted for advisory matching only through 8,192 Unicode code points (with a cheap 16,384 UTF-16
code-unit precheck). It derives at most 64 exact seed fragments, each 8–64 code points, and visits at
most 16 current occurrences per seed. Seed occurrences project candidate starts; candidates rank by
union of query code points covered, then seed count, then earliest current occurrence. A candidate
must cover at least `max(12, min(128, ceil(oldLength / 3)))` query code points. This is deliberately
not edit distance or fuzzy replacement: exact seed evidence chooses where to show current text only.
No qualifying candidate produces an explicit `No safe useful close textual match` reason instead of
an arbitrary excerpt.

The original exact-miss sentence comes first, with `old_str` projected through a 240-code-point cap.
A separate `Advisory context only; no fuzzy replacement was attempted` section then shows the
selected line plus at most two current lines on either side (five numbered rows total). Each row is
capped at 240 Unicode code points and carries `… [line truncated]`; omitted lines are counted. Every
slice uses code-point arrays, so advisory bounds cannot split a surrogate pair. The advisory is an
error projection only: file bytes, mtime/ctime, sandbox write count, and exact mutation semantics
remain unchanged.

#### Validation matrix

| Case | Required result |
|---|---|
| stale mostly-identical `old_str` | Error plus line-numbered current excerpt enabling an exact retry; zero writes |
| unrelated/short/weak text | Explicit no-safe-useful-match reason; no numbered arbitrary content |
| equally ranked candidates | Earliest current location, deterministically |
| `old_str` above 8,192 code points | Explicit cap reason, bounded/truncated error projection, no advisory scan |
| long/Unicode current line | At most 240 intact code points plus honest truncation marker |
| exact unique match | Existing success and exactly requested replacement bytes |
| multiple/missing/path/directory/size error | Existing error path without miss advisory |

Required assertions live in `spike/verify-file-editor.ts` and drive the exported singleton through
its provider-facing `stream()` path against real files. They cover bounded recovery, absence,
ambiguity, adversarial input, Unicode, zero writes and metadata purity, exact success, unrelated
errors, provider schema, the 1 MiB limit, and all view contracts. On SDK upgrade, regenerate the pnpm
patch from the pristine package, run `node --check` on installed `file-editor.js`, then run that
focused suite before the project gates.

### Contract: same-path fileEditor mutations apply in call order within one Agent (SRF-020)

#### Scope / trigger

The vended `handleCreate` / `handleStrReplace` / `handleInsert` are readText → compute →
writeText with no lock, and Darwin keeps the default `ConcurrentToolExecutor` (never
`toolExecutor`, see "Concurrency: parallel execution, never parallel prompting"). Unwrapped, N
same-path edits in one assistant message each read the original file and the last write wins
while every result reports `status: "success"` (measured: 1 of 6 disjoint `str_replace` survived;
session-20260902-054329719 lost 4 of 6 on `src/config.ts`). `src/tools/file-editor-serial.ts`
therefore substitutes `new SerializedFileEditorTool(fileEditor)` for the singleton in the runtime
`tools:` list — before `initialize()`, so the raw tool is never registered and `childTools` hands
every `buildRecipeChild` child the same wrapper. Not `addOrReplace`: the tool is static, so there
is no discovery window or refresh callback to decorate.

#### Contracts

- The wrapper is a projection: same `name`, `description` and `toolSpec` object as the SDK
  singleton; it `yield*`s the SDK tool's own `stream()` with the untouched `ToolContext`. Result
  and error bytes (including the SRF-011 miss advisory), permission classification, edit-diff
  rendering and trajectory records are byte-identical because input and callback never change.
- Serialized: `create`, `str_replace`, `insert` whose `path` is an absolute string, keyed by the
  resolved path exactly as the SDK writes it (trailing separators stripped, `path.resolve`
  normalized; `a/b/` and `a//b` share one chain). Each such call awaits the previous chain entry
  for the **same Agent** (`WeakMap<Agent, Map<path, Promise>>` off `context.agent`, the vended
  bash tool's precedent), so it reads what the previous call wrote and `insert_line` means the
  updated file's line numbers.
- Not serialized: `view`, distinct paths, calls without a usable absolute string path (the SDK
  rejects relative paths itself), every other tool, and calls from a different Agent — a child
  never shares the parent's chain; `/clear`'s successor starts empty.
- Entries only ever resolve: a failed or cancelled edit releases the chain in `finally`, and a
  settled last entry deletes its key, so the map cannot grow with the session.
- Never set `toolExecutor`; never change the pinned SDK patch or its error strings for this.

#### Validation & error matrix

| Case | Required result |
|---|---|
| N ≥ 4 disjoint `str_replace` on one path, one message | All N land, in call order; every result `success` |
| Dependent edits (each `old_str` is the previous `new_str`) | Every one succeeds — strict call order |
| `insert` after a length-changing `str_replace`, same path | Lands where the updated file's numbering says |
| Slow edit on A alongside edit on B and `view` on A | B's edit and the view finish without waiting (< 150 ms vs 300 ms) |
| `str_replace` miss then valid edit on the same path | Miss error bytes identical to the unwrapped tool; the valid edit is not blocked |
| Parent's slow edit on P in flight; child edits P | Child does not wait; parent's own second edit on P does |
| Batch settled | `pendingPaths(agent)` empty for every Agent |

Required assertions live in `spike/verify-file-editor-serial.ts` (in `pnpm test`): a real `Agent`
with a scripted model emitting one multi-tool-use message against real temp files, a slow fake
original for timing, `buildRecipeChild` for the child, and `AgentRuntime.create` for the
installation (`_toolExecutor instanceof ConcurrentToolExecutor`). `spike/verify-file-editor.ts`
must stay unchanged and green.


### Contract: `/compact` builds one `SummarizingConversationManager` per call, with an optional bounded focus (SER-051)

#### Scope / trigger

`AgentRuntime.compact(focus?)` is the only consumer of the `/compact` manager. It is built per
call by `createCompactionManager(preserveRecentMessages, focus)` in `src/agent/compact.ts`
because `SummarizingConversationManagerConfig.summarizationSystemPrompt` is constructor-only in
the SDK. Callers: the TUI `/compact [focus]` branch (`src/tui/App.tsx`) and headless
`--compact-before` (`src/headless-runner.ts`, always without a focus). SDK overflow recovery
keeps its own `conversationManager` with the configurable `summaryRatio`; nothing here touches it.

#### Signatures

- `normalizeCompactFocus(text) → string | undefined` — trimmed text; blank means "no focus".
- `compactFocusRefusal(focus) → string | undefined` — the notice when the focus exceeds
  `MAX_COMPACT_FOCUS_CODE_POINTS` (400 code points, `[...focus].length`), else undefined.
- `focusedSummarizationPrompt(focus)` = `DEFAULT_SUMMARIZATION_PROMPT + '\n\n' +
  COMPACT_FOCUS_HEADING + '\n' + focus`. The heading is one fixed line; the focus is plain text
  under it — never parsed, never a sub-command.
- `compactionManagerConfig(preserveRecentMessages, focus?)` — `{ summaryRatio: 0.8,
  preserveRecentMessages }` and, only when a focus is given, `summarizationSystemPrompt`. It
  throws the refusal notice for an over-cap focus before any manager exists.

#### Contracts

- Unfocused output never changes: without a focus the config carries exactly the two keys the
  former process-lifetime manager was built with, so the SDK applies `DEFAULT_SUMMARIZATION_PROMPT`
  itself and the summarizer request is byte-identical to a pre-SER-051 `/compact`. The summary
  stays one user-role message of non-reasoning blocks.
- `DEFAULT_SUMMARIZATION_PROMPT` is imported from the package root `'@strands-agents/sdk'`. The
  SDK declares it in `dist/src/conversation-manager/compression/context-compression.js`, which the
  package `exports` map does not expose; the pinned patch `patches/@strands-agents__sdk@1.16.0.patch`
  therefore adds one re-export line to `dist/src/index.js` and one to `dist/src/index.d.ts`. Never
  copy the prompt text into darwin (it would drift from what the SDK sends unfocused) and never
  deep-import it. On SDK upgrade, regenerate the patch and keep both hunks; if the SDK starts
  exporting the constant itself, drop the hunks and keep the root import.
- The over-cap refusal happens before the `PreCompact` codex hook and before any model call:
  `runtime.compact()` constructs the manager first. The TUI refuses locally with the same notice
  (no `compacting` state entered). `PreCompact`/`PostCompact` payloads are unchanged (`trigger:
  manual`, no focus field).
- The reasoning-block scrub lives inside the patched `generateSummary`, so it applies to focused
  and unfocused summaries alike.
- The TUI records `/compact <focus>` as it records `/compact`: one `userInput` transcript
  action; it never reaches `AgentRuntime.send`, so it is absent from recall and from the
  trajectory's `userInput` lines. Busy refusal matches the first word, so `/compact <focus>` still
  refuses to queue.

#### Tests required

`spike/verify-compact.ts` (free): unfocused requests carry exactly `DEFAULT_SUMMARIZATION_PROMPT`
and the two-key config; focused requests carry the default prompt once plus the focus once under
the fixed heading; trim/blank/cap/code-point counting; the reasoning scrub on a focused two-pass
compaction; the manager-before-hook order in `runtime.compact`; and a source assertion that
`compact.ts` root-imports the constant with no deep import and no copied prompt text.
`spike/verify-help-command.ts` and `spike/verify-tui.ts completion` (free) pin the description;
`spike/verify-tui.ts compacting` (live) pins keyboard ownership during a real `4 → 2` compaction.
After touching the patch: `pnpm install --frozen-lockfile` must reapply it and `pnpm typecheck`
must pass. The per-call manager runs through the one `compactConversation` loop, so the SER-052
termination and swallowed-failure rules (§ explicit `/compact` scenario) apply to focused and
unfocused compaction alike.

#### Wrong vs correct

Wrong: `const PROMPT = 'You are a conversation summarizer…'` in darwin, or
`import … from '@strands-agents/sdk/dist/src/conversation-manager/compression/context-compression.js'`.
Wrong: setting `summarizationSystemPrompt: DEFAULT_SUMMARIZATION_PROMPT` on the unfocused
manager "for symmetry" — it is equivalent today but makes the unfocused request depend on darwin's
import instead of the SDK's own default. Correct: two-key config unfocused, root import, one patch
hunk per `index.*` file.


## Observing the stream (what darwin measured to record it)

Darwin records an append-only trajectory of every turn. The *policy* — format, caps,
replay guarantees — is `.trellis/spec/backend/session-trajectory.md`; what follows is only
what was measured about the SDK to make that possible. All of it is asserted by
`spike/verify-trajectory.ts`, which makes no model call.

### Contract: `toJSON()` is the safe serialization seam — it excludes `agent` and `invocationState`

Every stream event class declares `toJSON(): Pick<Event, 'type' | …>`
(`hooks/events.d.ts`, verified on 1.12.0): `MessageAddedEvent` yields `type`/`message`,
`AfterToolCallEvent` yields `type`/`toolUse`/`result`, and **no** event yields `agent` or
`invocationState`. So `JSON.stringify(event)` cannot drag the live `Agent`, its whole message
list, or arbitrary per-invocation objects onto disk. Serialize events that way; a hand-rolled
field-by-field projection has to be re-audited on every SDK upgrade, and gets this wrong the
first time an event gains a field.

### Contract: the assembled `contentBlockEvent` is built from the deltas the model just yielded

`Model.streamAggregated` (`models/model.js`, measured on 1.12.0) is implemented in the SDK's
**base** class: it yields each `ModelStreamEvent` a subclass's `stream()` produces and accumulates
the finished `ContentBlock` from those same events (`accumulatedText` for `textDelta`, a
`CitationAccumulator` for citations). `Agent` then wraps whatever comes out as either
`ModelStreamUpdateEvent` or `ContentBlockEvent` (`agent/agent.js`).

Two things follow, and darwin depends on both:

- The authoritative text block **cannot disagree** with the concatenated text deltas for any model
  that implements `stream()` — including every offline test model. Code that reconciles the two
  (`src/tui/turn-state.ts`, which commits finished lines to `<Static>` before the block closes)
  therefore has a branch that no fake provider can reach: exercise it at the reducer with stated
  events, not by trying to build a model that lies.
- What *can* still differ is the `trim()` a consumer applies on close, citation text the deltas
  never carried, and a model that overrides `streamAggregated` itself — which is why that branch
  exists at all rather than being deleted as unreachable.

### Contract: `toJSON()` gives the *wire* shape, which is not the shape a reducer reads

Measured on 1.12.0, and the trap in this area:

| In memory | Serialized by `toJSON()` |
|---|---|
| `TextBlock` with `type: 'textBlock'` | `{"text":"…"}` — **no `type` discriminator** |
| `ToolResultBlock` with `.status`, `.content` | `{"toolResult":{"toolUseId":…,"status":"success","content":[{"text":…}]}}` |
| `ReasoningBlock` with `type: 'reasoningBlock'` | `{"reasoning":{"text":…,"signature":…}}` |

Two consequences. Anything that filters serialized events by `type === 'reasoningBlock'`
silently never matches — which is how reasoning text (and `redactedContent`, which *is* the
reasoning) leaks into a file that believes it strips it; match `'reasoning' in block` instead.
And feeding a serialized payload back to `src/tui/turn-state.ts` renders nothing and throws on
the tool result (`content` is one level deeper than it looks). Rehydrate with the SDK's own
`contentBlockFromData(...)` — the exported mirror of the `toJSON()` used to write it, and the
only version-proof way back. Measured: it accepts `{ reasoning: { text: '' } }`, so a
presence-only reasoning record still replays.

### Contract: `for await` + `yield` preserves what `yield*` gives darwin's consumers

`AgentRuntime.send` no longer delegates straight to `agent.stream()`, because a delegation
cannot be observed from inside. Before constructing/iterating that SDK stream it opens the
trajectory turn and awaits one bounded, no-throw `userInput` durability barrier. This ordering is
load-bearing: a scripted real `AgentRuntime` model that reads the file from inside invocation must
see the current request. A write failure or timeout latches trajectory status and then invocation
still starts; this is recorder setup, not an interception or retry of the SDK loop.

After that barrier, `recordStream` (`src/trajectory/stream.ts`) does
`for await (… of events) { observe; yield }` and `send` delegates to *that*. Measured with a
tee over a real `Agent.stream()`: the consumer receives the **identical event objects**, in the
same order, with nothing added or swallowed; a consumer that `break`s early still closes the
underlying stream and still reaches the wrapper's `finally`. Keep event observation synchronous —
an `await` between receiving an event and yielding it would change turn timing, and a throw
there would become a second way for a turn to fail. The opening durability barrier is the only
recorder await permitted in `send`.

### Contract: a thrown turn reaches the consumer as the identical error object, after `AfterInvocationEvent`

Measured over a real `Agent.stream()` with a model that throws mid-stream: the agent stores the
error, fires and **yields** its `AfterInvocationEvent`, and then rethrows *the same object* — same
class, same message, same `cause`. So an observer between `stream()` and the `yield` can read the
error and rethrow it without the caller being able to tell recording exists, which is exactly what
`recordStream`'s `catch` does. Two corollaries worth knowing: a failed turn still emits events
after the last content (so a record's event counts are not proof of success), and it emits **no**
`agentResultEvent`, which is why a failed turn has no `stopReason` and must be described some
other way.

### Contract: cancel does not throw to the consumer

`agent.cancel()` raises the SDK's internal `CancelledError`, which `stream()` converts into an
`AgentResult` with `stopReason: 'cancelled'` and delivers as an ordinary `agentResultEvent`.
Cancellation is checked once per model stream event, so cancelling from inside a `for await` body
ends that turn cleanly rather than throwing. Never treat cancel as an error path, and never infer
cancellation from a throw.

### Contract: `Model.streamAggregated` wraps any non-`ModelError` throw, keeping only the message

Measured on 1.12.0 (`models/model.js`): a `ModelError` (and its subclasses) is rethrown untouched;
anything else becomes `new ModelError(normalizeError(error).message, { cause: original })`. Since
`BedrockModel.stream` re-throws AWS service exceptions as-is, a real Bedrock rejection reaches
darwin as `ModelError` — the provider's *message* intact, its *class* only on `.cause`. Anything
that identifies a provider failure by class must therefore read the cause too; darwin's record
stores it as `turnEnded.failure.cause` for that reason. Proven live: an invalid Bedrock API key
recorded `{"name":"ModelError","message":"Authentication failed: Please make sure your API Key is
valid.","cause":"AccessDeniedException"}`.

### Contract: every SDK error class sets `name`, but nothing makes a subclass do it

`ModelError`, `ContextWindowOverflowError`, `MaxTokensError`, `ModelThrottledError`,
`SessionError`, `ToolNotFoundError` and the rest each assign `this.name` to their own class name
(`errors.js`, 1.12.0), and AWS SDK service exceptions do the same — so `error.name` is usually the
class. It is not guaranteed: a subclass that forgets it reports `'Error'` while the prototype
still knows the truth. Read the class from `error.constructor.name` and keep a disagreeing
`error.name` alongside it rather than choosing one silently
(`failureFromError` in `src/trajectory/record.ts`).

### Gotcha: a child's reasoning already reaches parent context through `AgentResult.toString()`

`SubagentTool` returns `result.toString()`, and that rendering **includes the child's reasoning**
as `💭 Reasoning:` text (measured). So a child's thinking enters the parent conversation as
ordinary tool-result text today, independently of any recording — while darwin's *own* model
reasoning is deliberately never recorded. Nothing in the trajectory layer changes this, and the
record contains exactly what parent context contains; if that pathway is ever considered wrong,
it has to be fixed in `SubagentTool`, not by filtering the record.

---

## Scenario: one-shot max-output-token recovery

`Model.streamAggregated()` throws `MaxTokensError` after it has already yielded the partial
content blocks, and the SDK does not append `error.partialMessage` to history. Darwin installs an
`AfterModelCallEvent` hook on the main Agent and every `SubagentTool` child to recover once without
forking `Agent.stream()`.

### Contracts

- Handle the exported `MaxTokensError` by class identity only. Do not retry transport errors,
  cancellation, context overflow, refusals, or other stop conditions.
- On the first max-token failure, append the exact `partialMessage` to `event.agent.messages`, add
  an internal user control message that says to continue from the exact cutoff without repeating,
  and set `event.retry = true`. Do not re-emit the partial: its stream events already reached TUI
  and headless consumers.
- Store the consumed allowance in `event.invocationState`, not `attemptCount`. Tool execution starts
  a later model-call sequence whose `attemptCount` returns to one, while invocation state remains
  shared for the whole fresh user turn.
- If a later call in the invocation also reaches max tokens, append that second partial but do not
  retry. Let `MaxTokensError` propagate; `AfterInvocationEvent` still lets the session manager
  snapshot all retained context for resume.
- Recovery must not mutate model configuration, `maxTokens`, or thinking effort. A successful
  streamed reply is the already-emitted partial followed by continuation content exactly once.
- `SubagentTool` uses `invoke()`, whose result contains only the last assistant message, so prepend
  the privately tracked retained partial text when forming the child tool result. This projection
  is consumer-only; conversation history remains separate messages for provider role validity.

### Tests Required

`spike/verify-max-tokens-recovery.ts` uses real SDK Agents with a scripted Model and covers ordinary
success, first-truncation recovery, second-truncation failure and persisted resume, cancellation,
non-max errors, invocation-wide allowance across a tool cycle, unchanged high-effort config,
stream de-duplication, invoke-only projection, and `SubagentTool` child coverage. Run it together
with `pnpm typecheck`, `pnpm test`, and `git diff --check`.

---
## Scenario: bounded stream-interruption continuation (SRF-001)

### 1. Scope / Trigger

Use this contract when a completed Darwin orchestration attempt receives the exact SDK `ModelError`
for `Stream ended without completing a message`. This is driver recovery after the SDK stream has
thrown, not an SDK-loop retry and not max-token recovery.

### 2. Signatures

```typescript
isRetryableStreamInterruption(error: unknown): error is ModelError
runWithStreamResumption<T>(
  input: string,
  runOrdinaryTurn: (turnInput: string) => Promise<T>,
  onContinuing: (error: ModelError) => void,
): Promise<T>
```

### 3. Contracts

- `AgentRuntime.send` and `recordStream` remain unchanged: the first attempt's error reaches the
  driver as the identical object and its failed `turnEnded` record is flushed append-only.
- A retryable failure is an exported SDK `ModelError` whose trimmed message exactly matches
  `Stream ended without completing a message`, allowing terminal `.`/`!` only. Class alone is never
  sufficient.
- The helper invokes the supplied ordinary-turn callback at most twice: original input, then one
  bounded internal continuation prompt. The second failure is never classified again.
- The continuation prompt contains no original user text. It orders the model to inspect retained
  conversation/work, verify state, continue from the interruption, and avoid replaying completed
  work or tool calls.
- TUI and headless drivers own visibility and lifecycle. Runtime owns neither retry policy nor a
  second stream loop.

### 4. Validation & Error Matrix

| Outcome | Continue? | Required behavior |
| --- | --- | --- |
| exact stream-interruption `ModelError` on original attempt | once | visible boundary, distinct ordinary turn |
| same error on continuation | no | throw second object unchanged |
| auth/authorization/validation/generic `ModelError` | no | throw unchanged |
| `MaxTokensError` / `ContextWindowOverflowError` | no | existing specialized/error path |
| cancellation (`agentResultEvent: cancelled`) | no | ordinary cancelled outcome |
| tool/application/non-`ModelError` failure | no | throw unchanged |

### 5. Good / Base / Bad Cases

- Good: failed turn 1 remains in trajectory; turn 2 uses the private anti-repeat prompt and succeeds.
- Base: an ordinary successful turn invokes no continuation hook and has unchanged behavior.
- Bad: resending the original request, retrying all `ModelError`s, or catching inside
  `AgentRuntime.send` can duplicate side effects and falsify the failed-turn record.

### 6. Tests Required

`spike/verify-stream-resumption.ts` must use a real SDK `Agent` and scripted model to prove error
identity, two distinct trajectory turns, one-at-most continuation, prompt bounds/privacy, and the
exclusion matrix. Run `spike/verify-headless-structured.ts` for text/JSON/JSONL visibility.


## Scenario: direct successful-turn streaming

### 1. Scope / Trigger

Use ordinary driver consumption for every successful parent turn. There is no successful-turn
classifier, candidate buffer, internal-note suppression, or unfinished-plan continuation.

### 2. Contracts

- `AgentRuntime.send()` remains the only ordinary stream seam. Interactive, text-headless, and
  structured-headless drivers consume it as events arrive.
- The TUI dispatches each event through `streamEvent`; completed tools, successful `update_plan`
  replacements, and complete assistant lines may become public before `agentResultEvent`.
- `turnEnded` is the sole terminal reducer action. It flushes remaining text, writes one bounded
  final checklist projection, and clears transient tool/plan state. An unfinished checklist ends
  normally and never starts another model call.
- Text headless reports tool progress while consuming the stream. Structured headless emits
  assistant text only from post-aggregation `modelMessageEvent`, preserving output-redaction privacy.
- Exact stream-interruption continuation and invocation-scoped max-token recovery compose unchanged.
  Do not add a second successful-turn retry or resend the original request.
- Internal TODO/future-action prose is handled by system-prompt guidance only. If it reaches a
  successful stream, it is ordinary public assistant output and honest trajectory evidence.

### 3. Tests Required

Run `spike/verify-update-plan.tsx`, free pty `spike/verify-tui.ts updatePlan`,
`spike/verify-stream-into-static.ts`, `spike/verify-stream-resumption.ts`,
`spike/verify-max-tokens-recovery.ts`, `spike/verify-headless-structured.ts`, and
`spike/verify-trajectory.ts`. The pty fixture must deliberately hold the model stream open after
publishing tool/checklist/text facts, prove those facts are visible while still busy, then release
the terminal event and prove the final transcript has no duplicate text or tool result and no extra
model invocation.

---


## Permission Gating (interventions)

### Wrong vs Correct

```typescript
// WRONG: agent.hooks.addCallback(...) — `agent.hooks` is undefined at runtime
//        (stale README example); and raw hooks lack deny semantics anyway.
// WRONG: InterventionActions.confirm(prompt, { response }) for denial — a rejected
//        confirm reaches the model as `CONFIRMATION_FAILED: <prompt>`, which models
//        misread as a system failure and retry.

// CORRECT: an InterventionHandler subclass passed via AgentConfig.interventions.
class PermissionGate extends InterventionHandler {
  override async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    if (!requiresApproval(event)) return InterventionActions.proceed();
    const ok = await this.ask(classify(event.toolUse.name, event.toolUse.input));
    return ok
      ? InterventionActions.proceed()
      : InterventionActions.deny('The user denied permission… Do not retry it.');
  }
}
```

- Intervention callbacks are awaited serially, so blocking on user input is safe.
- `deny(reason)` becomes an error `ToolResultBlock`; the loop continues and the model
  reads exactly your wording. (Verified: `spike/permission-hook.ts`, 16 assertions.)
- `InterventionAction` is not exported from the package root; derive it:
  `type InterventionAction = Awaited<ReturnType<InterventionHandler['beforeToolCall']>>`.

### Contract: classify by `(toolName, input)`, fail closed

`fileEditor` is one tool name spanning read (`view`) and write (`create`/`str_replace`/
`insert`); name-only matching cannot separate them (this is also why the SDK's vended
`HumanInTheLoop` is unusable here). Unknown tools — including everything from MCP servers —
must default to `execute` (gated) and are never statically safe. See `classify()` /
`assessRisk()` in `src/agent/permission.ts`.

#### Static bash safety: whitelisted first word *and* no mutating argument

`assessBashRisk` proves a bash command `safe` only when it has no shell metacharacters and
**every** `|`/`&&`/`||`/`;` segment (a) starts with a `SAFE_BASH_COMMANDS` word or a `git`
`SAFE_GIT_SUBCOMMANDS` subcommand and (b) carries none of that command's known mutating options.
The argument rule (SER-053) exists because the first word alone let `find … -delete`,
`find … -exec rm {} \;`, `git branch -D main`, `git branch -m a b` and
`git diff/log --output=<file>` run unprompted in `default`/`auto`:

| Whitelisted command | Mutating options → `dangerous`, reason names the option |
|---|---|
| `find` | `-delete`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprint0`, `-fprintf`, `-fls` |
| `git branch` | `-d`, `-D`, `-m`, `-M`, `-c`, `-C`, `-u` (any of them inside a combined short flag such as `-Df` / `-fD`), `--set-upstream-to` / `--set-upstream-to=…`, `--unset-upstream`, `--edit-description`, `--delete`, `--move`, `--copy` |
| `git log`, `git diff`, `git show` | `--output`, `--output=…` |

Rules of the rule: it is checked per segment, after the first-word check and before the
`safe` verdict; every token is scanned, including anything after a `--` separator (a miss costs a
prompt, never silent approval); it adds nothing to the two whitelist sets and does not touch
user-authored allow rules (`permission-rules.ts`), the `auto` classifier, or `plan` denial.
Read-only forms with arguments stay `safe` — `ls -la`, `rg foo | head -5`,
`git log --oneline -5`, `git branch --show-current` / `-a` / `--list`, `git diff --stat`,
`git show HEAD --stat`, `find . -name '*.ts'`, `find . -type f -newer x`. Verified offline in
`spike/verify-permission-modes.ts` (`staticRules()`), which is in `pnpm test`.

## Scenario: enforced read-only planning permission mode

### 1. Scope / Trigger

Use this contract for `permissionMode: "plan"` or `--permission-mode plan`. It is a permission
policy on the existing SDK intervention, not a planning prompt, sandbox, or separate agent loop.

### 2. Signatures

```text
ApprovalMode = default | auto | plan | yolo
PermissionGate.planGuard(toolName: string, input: unknown): InterventionAction | undefined
stderr: ^permission-mode: (default|auto|plan|yolo)$
TUI: mode: plan — read-only; write and execute calls are denied
```

### 3. Contracts

- Classify by `(toolName, input)`: `read` continues to the ordinary flow;
  `write`/`execute` deterministically deny.
- Run the plan guard before risk approval, wildcard rules, the `auto` classifier, and the
  permission bridge. Unknown/MCP tools remain `execute`; no rule can widen plan.
- The guard reads the **live** mode (`PermissionGate.mode`), never `options.mode`: every contract in
  this scenario has to hold identically when plan is entered mid-session. See the next scenario.
- The denial tells the model to continue with read-only inspection or ask the user to leave plan.
- `ToolHookGate` invokes only this narrow guard before `PreToolUse`. A blocked call causes no hook
  shell execution. Calls it does not deny, and every non-plan mode, retain
  Pre -> full permission -> body -> Post ordering.
- Parent and child agents receive the same composed intervention. `subagent` delegation itself is
  read-classified, but the child's writes/executes encounter the shared guard.
- TUI uses its existing mode row and marks loaded allow rules ignored. Headless startup writes the
  effective post-override mode once runtime construction succeeds.

### 4. Validation & Error Matrix

| Input/state | Result |
|---|---|
| `plan` + `fileEditor view`/other read | Proceed through the ordinary gate; no plan denial |
| `plan` + in-project write, even statically safe | Deny before risk/rules/bridge |
| `plan` + bash command, even read-like command/rule | Deny as `execute` before rules/classifier/bridge |
| `plan` + unknown/MCP tool | Deny as fail-closed `execute` |
| `plan` + configured Pre/Post hooks on blocked call | Run neither hook nor body |
| Child write/execute | Same denial as parent; no child-specific escape |
| CLI mode conflicts with configured mode | CLI value is effective; explicit `--yolo` keeps legacy precedence |

### 5. Good / Base / Bad Cases

- **Good:** plan delegates repository research; parent/child views run, mutation denies without a
  prompt, classifier cost, rule bypass, or hook side effect.
- **Base:** `default`, `auto`, and `yolo` retain their existing order and behavior.
- **Bad:** checking plan after static risk lets in-project writes through; checking after Pre hooks
  mutates external state before denying; removing child tools instead of sharing the intervention
  diverges parent/child enforcement and bypasses the SDK extension seam.

### 6. Tests Required

- `spike/verify-permission-modes.ts`: read proceeds; safe write, bash execute, and unknown tool
  deny; zero prompt/classifier calls; broad rules do not bypass; denial is actionable.
- `spike/verify-permission-mode-switch.ts`: the same assertions for plan **entered mid-session**.
- `spike/verify-tool-hooks.ts`: blocked call runs no Pre/Post/body while existing ordering tests
  stay green.
- `spike/verify-subagents.ts`: a child execute is denied without bridge or body execution.
- `spike/verify-config.ts` / `spike/verify-headless.ts`: configured/CLI selection, yolo precedence,
  and stable diagnostic formatting.
- `spike/verify-tui.ts plan`: network-free real-pty effective-header scenario with bounded exit.

### 7. Wrong vs Correct

```typescript
// WRONG: rules, classifier, prompt, or Pre hook can run before enforced planning.
await runPreHooks(event);
return permissionGate.beforeToolCall(event);

// CORRECT: only the narrow plan denial precedes Pre; every allowed call keeps old ordering.
const guarded = permissionGate.planGuard(event.toolUse.name, event.toolUse.input);
if (guarded !== undefined) return guarded;
await runPreHooks(event);
return permissionGate.beforeToolCall(event);
```


## Scenario: switching the permission mode inside a running session

### 1. Scope / Trigger

Use this contract for `/mode <name>` (TUI and dev REPL) and anything else that would move the
approval mode of a live session. It is a change of *enforcement*, which makes it different in kind
from `/effort` and `/model`.

### 2. Signatures

```text
PermissionGate.mode: ApprovalMode                        // live, never options.mode
PermissionGate.setMode(next): { mode, previous, withdrawn }
AgentRuntime.permissionMode: ApprovalMode                // live; info.permissionMode is the startup one
AgentRuntime.changePermissionMode(next): PermissionModeChange   // synchronous, persists nothing
AssessedPermissionRequest.withdrawn: AbortSignal         // fires when the mode changes under a pending request
TUI: /mode [default|auto|plan|yolo]  → the header's existing mode row
```

### 3. Contracts

- **User-only.** The gate is the only holder of the value and nothing re-reads it from a file after
  startup, so the model's channels (writing `~/.darwin/config.json`, relaunching darwin with a
  flag, calling a policy-sounding tool) change nothing and stay gated. `.darwin/config.json` remains
  `dangerous` and un-ruleable, so "always allow" is not a way in either.
- **Session-scoped.** Nothing is written to the config; `changePermissionMode` is synchronous and
  has no `saved` half. A fresh process starts from configured/CLI policy. `/clear`'s successor, by
  contrast, inherits the **live** mode — restoring a wider startup policy would be a widening the
  user never asked for.
- **The gate stays the single decision point**, so the intervention shared with children (and the
  `ToolHookGate` wrapper) sees the new value with no extra plumbing.
- **No in-flight decision is resolved under a mode that would not have asked for it.** A pending
  `auto` classifier verdict is *discarded*; a prompt on screen or queued is *withdrawn* through
  `request.withdrawn`; in both cases the call is re-decided **from the top** (plan guard first)
  under the new mode. One rule for every transition, not a table of benign ones.
- **The mode in force when a decision is applied is the mode that decided it**: the race re-checks
  `aborted` *after* the awaited promise settles, so an answer landing in the same tick as the switch
  is discarded too, and an allow-rule carried by such an answer is not remembered. A bridge that
  ignores the signal is not unsafe — only less legible.
- **The loop is bounded by construction** (16 restarts, then a deny naming the repeated changes),
  because "a human will stop eventually" is not a bound.
- **What a mid-session switch does not do:** stop a tool already executing, or un-run a `PreToolUse`
  hook that already ran under the previous mode. It guarantees the tool body does not run and that
  no further call gets past the guard.
- **The header states it in the row it already has** — no frame row is added, and `mode:` appears
  exactly once whatever the mode reads (`.trellis/spec/frontend/live-frame.md`). The notice reports
  the transition, the withdrawal count, and that nothing was persisted.
- **Discoverability follows the other built-ins:** `BUILTIN_COMMAND_NAMES` + a one-phrase
  description, with `MAX_COMPLETIONS` grown so every built-in still fits the menu. An unusable
  argument changes nothing, names the valid values, and never falls through to the model.
- Handled **before** the busy check (like `/effort`, unlike `/model`): it sends nothing and replaces
  no object, and mid-turn is exactly when enforcement needs changing. It is *not* reachable while a
  permission prompt is up, because that box owns the keyboard.
- Headless has no such surface on purpose: it is one-shot and non-interactive, so the only actor
  that could type is the model.

### 4. Validation & Error Matrix

| Input/state | Result |
|---|---|
| `/mode` | Reports the live mode and lists the valid ones; no turn |
| `/mode plan` while a write is pending on a prompt | Prompt withdrawn, call re-decided, denied |
| `/mode yolo` while an `auto` classifier call is in flight | Verdict discarded, call proceeds |
| `/mode default` while an `auto` classifier said "safe" | Verdict discarded, user is asked |
| `/mode <current>` | "already in <mode>", nothing withdrawn |
| `/mode bogus` | Unchanged, valid values named, no turn started |
| A model attempt (config write, relaunch flag, policy-shaped tool) | Mode unchanged; call gated |
| 16 mode changes under one pending call | Deny naming the repeated changes |
| `/clear` after a switch | Successor enforces the live mode; config untouched |

### 5. Good / Base / Bad Cases

- **Good:** plan → inspect → `/mode default` → apply the plan, in one session, with the header
  saying which policy is live at every point.
- **Base:** a session that never types `/mode` behaves exactly as before, including which decisions
  the gate takes synchronously.
- **Bad:** reading `options.mode` anywhere (plan stops guarding mid-session); persisting the new
  mode (a widening that outlives the process); applying a verdict or answer produced under the old
  mode; leaving a withdrawn prompt on screen; adding a header row for the mode.

### 6. Tests Required

- `spike/verify-permission-mode-switch.ts`: live value and guards; plan entered/left mid-session for
  parent and child; the composed `ToolHookGate` following the live mode; classifier-in-flight for
  every transition, including a verdict settling in the same tick; queue withdrawal (on screen and
  behind); a bridge that ignores the signal; the restart cap; model-driven attempts.
- `spike/verify-tui.ts mode` (free): report, switch, header follow, refusal, "already in", one
  `mode:` row, no extra frame row, and a byte-unchanged config.
- `spike/verify-tui.ts completion` (free): `/mode` still visible in the menu.
- `spike/verify-tui.ts approve` (live): the permission box still fits 50 rows.
- `spike/verify-clear-session.ts`: the successor inherits the live mode, not the configured one.

### 7. Wrong vs Correct

```typescript
// WRONG: the mode is read from construction options, so a switch does not reach the decision,
// and a verdict produced under the old mode is applied anyway.
if (this.options.mode === 'auto') {
  const verdict = await this.classifierVerdict(request);
  if (verdict.safe) return InterventionActions.proceed({ reason: `classifier: ${verdict.reason}` });
}

// CORRECT: live mode, and anything awaited is raced against withdrawal — a withdrawn pass is
// re-decided from the top rather than resolved.
if (this.currentMode === 'auto') {
  const verdict = await raceWithdrawal(this.classifierVerdict(request), withdrawn);
  if (verdict === WITHDRAWN) return WITHDRAWN;
  if (verdict.safe) return InterventionActions.proceed({ reason: `classifier: ${verdict.reason}` });
}
```

## Scenario: parent structured progress checklist (`SER-036`)

- `update_plan` is a normal SDK custom tool and each call supplies the complete replacement list:
  1–20 unique trimmed items, exact `item`/`status` keys, statuses `pending | in_progress |
  completed`, at most 200 Unicode code points per item and 2,000 total. Its callback performs no
  I/O and returns only a bounded acknowledgement.
- Runtime assembly deliberately snapshots `childTools` and loads child allowlists **before** adding
  `update_plan` to the initialized parent registry. Children never receive it, including a child
  definition without an explicit allowlist. Only `AgentRuntime.create()` owns this split.
- Permission classification is explicit `read`: the advisory tool does not prompt in
  default/auto/plan/yolo, while unknown tools remain fail-closed and configured hooks still observe
  ordinary tool calls.
- The SDK's ordinary `beforeToolCallEvent` / `afterToolCallEvent` pair is the only cross-layer seam.
  A successful after-event replaces transient TUI state; invalid or failed calls leave the last
  valid list intact. There is no plan store, config key, resume state or trajectory record kind.
- Required free checks: `spike/verify-update-plan.tsx` drives a real offline SDK Agent and the
  assembled runtime; `spike/verify-tui.ts updatePlan` drives the real TUI with a local model fixture.



## Scenario: read-only local image inspection

### 1. Scope / Trigger

When ordinary user text names a local PNG, JPEG, GIF, or WebP that the model needs to
inspect, the model may call the built-in `imageViewer({ path })` tool. TUI and headless remain
text-only drivers; there is no attachment parser or fork of the SDK loop.

### 2. SDK and Runtime Contracts

- SDK `FunctionTool` passes an `ImageBlock` callback result through as image content inside a
  successful `ToolResultBlock`. A callback throw becomes an error tool result and does not throw
  out of the agent loop. `spike/verify-image-viewer.ts` measures both behaviors through
  `Tool.stream()`, not only through the direct callback.
- Construct `ImageBlock` with raw `Uint8Array` bytes and one of `png | jpeg | gif | webp`.
  Normalize `.jpg` to `jpeg`; do not base64-wrap the bytes in prompt text.
- Sharp is an install-script dependency. Keep it in `pnpm-workspace.yaml`'s `allowBuilds`, and use
  a release compatible with the repository's Node runtime. Sharp 0.34.x requires Node 20.3+ on
  the Node 20 line, so the package engine floor must not claim support for earlier Node 20 builds.
- Register the tool before `agent.initialize()`. It then enters the parent catalogue and the
  `childTools` snapshot; an explicit project agent tool allowlist must still name `imageViewer`.
- Classify `imageViewer` as `read`. It proceeds without approval in default/auto/plan/headless,
  while the ordinary intervention composition still exposes it to configured Pre/Post hooks.
- Relative paths resolve from the explicit runtime `projectRoot`; absolute paths are used as
  given. No implementation below the entry points reads `process.cwd()`.

### 3. Image and Resource Contracts

- Bedrock Converse accepts at most 3.75 MiB (`3_932_160` bytes) and 8000 pixels on either edge
  per image. A compliant static input passes through byte-identically; do not spend CPU or lose
  detail by re-encoding it.
- Darwin additionally refuses source files over 50 MiB, reads through one open handle into an
  allocation capped at that budget plus one sentinel byte, and rejects files that change during
  the read. Sharp's decode paths carry a 100-megapixel input limit. These are local resource
  bounds, not provider limits.
- Parent and child agents share one tool instance, and it serializes Sharp decode/encode work. The
  SDK may run sibling tool calls concurrently, but a per-image pixel cap is not an aggregate native
  memory cap; image processing is deliberately the exception to read-heavy child parallelism.
- Sharp metadata is the content validator: decoded format must agree with the case-insensitive
  file extension. A renamed payload is an error, not a MIME claim based only on its suffix.
- Animated GIF input is intentionally flattened to page zero. Any animated input, byte-over-limit
  input, or dimension-over-limit input is auto-oriented, resized inside 8000×8000 without
  enlargement, and encoded as WebP.
- Tool paths are bounded to 4096 characters before filesystem work.
- Compression is bounded: quality `85, 75, 65, 55, 45, 35` over at most 17 resize rounds, using
  0.8 dimension steps. Stop with an actionable error rather than loop forever if no result fits
  before the largest edge would fall below 256 pixels.
- SDK session snapshots retain media through the SDK's serialization. Trajectory recording may
  observe base64 image data, but its existing field/record caps truncate and annotate it; never
  invent a second image persistence format.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Supported, compliant static image | Exact source bytes in a canonical-format `ImageBlock` |
| Image exceeds byte or dimension limit | Auto-orient, bounded resize/quality ladder, return compliant WebP |
| Animated GIF | Decode page zero and return one static WebP |
| Missing/unreadable/directory/empty | Error result naming the resolved path and reason |
| Unsupported extension or decoded-format mismatch | Error result listing supported formats or naming mismatch |
| Source > 50 MiB or decoded input > 100 MP | Reject before unbounded decode/work |
| Configured model has no vision support | Existing model-call/turn failure path; do not guess from arbitrary model ids |

### 5. Tests Required

Run `pnpm tsx spike/verify-image-viewer.ts`. It covers relative/absolute paths, all four
formats, exact pass-through, byte/dimension normalization, EXIF orientation, animated GIF page
zero, SDK tool-result wrapping, source/pixel limits, validation errors, and source immutability.
Also run `verify-permission-modes.ts`, typecheck, the fast suite, and build.


### Contract: one-shot model calls via `Model.streamAggregated()`

For a single classification-style call (no tools, no session, no agent loop) do NOT build
a throwaway `Agent` — call the model directly:

```typescript
const message = new Message({ role: 'user', content: [new TextBlock(question)] });
const generator = model.streamAggregated([message], { systemPrompt: SYSTEM_PROMPT });
let next = await generator.next();
while (!next.done) next = await generator.next();          // drain events
const text = next.value.message.content                     // aggregated final message
  .map((b) => (b instanceof TextBlock ? b.text : '')).join('');
```

`Message`, `TextBlock` are exported from the package root; the generator's *return value*
(`StreamAggregatedResult`) carries the complete message. Used by
`src/agent/safety-classifier.ts`; verified live by `spike/verify-classifier.ts`.

Caveat: the suffix-less `us.anthropic.claude-haiku-4-5` profile alias is rejected by
Bedrock (`ValidationException: The provided model identifier is invalid`); use the full
versioned id `us.anthropic.claude-haiku-4-5-20251001-v1:0`.

## Scenario: configured tool lifecycle hooks

### 1. Scope / Trigger

Use this contract when `.darwin/config.json` runs deterministic shell policy before a tool or follow-up automation after one. Keep it on the SDK intervention path; never intercept or fork the agent loop.

### 2. Signatures

```typescript
interface ToolHooksConfig {
  PreToolUse?: readonly ToolHookGroup[]
  PostToolUse?: readonly ToolHookGroup[]
}
interface ToolHookGroup {
  matcher: string                 // case-sensitive `*` / `?` glob
  hooks: readonly { type: 'command'; command: string }[]
}
runToolHookCommand(projectRoot, command, toolName, toolInput, signal?): Promise<ToolHookResult>
new ToolHookGate(projectRoot, hooks, permissionGate)
```

The stdin payload is exactly one newline-terminated JSON object:
`{"tool_name": <string>, "tool_input": <raw tool input>}`.

### 3. Contracts

- `hooks` is session-scoped config and must be in `SESSION_KEYS`, so `/model` preserves it and model entries cannot carry it.
- Match the complete tool name, case-sensitively: `*` is zero-or-more, `?` is exactly one, and regex characters are literal.
- Run matching commands sequentially in config order as `/bin/sh -c`, with project-root cwd, inherited environment, and piped stdout/stderr. Hook output must never reach Ink directly.
- Compose hooks and permissions in **one** `InterventionHandler`: Pre hooks → `PermissionGate` → tool body → Post hooks. Pass that same instance to main and child agents.
- First failed Pre command denies with stderr; empty stderr or launch failure gets an actionable fallback naming `.darwin/config.json`. Later Pre commands, permission evaluation, tool body, and Post hooks do not run.
- Post hooks observe only `{tool_name, tool_input}`. Run after success and tool-body errors; ignore their exit/output and continue later Post hooks without transforming the original result.
- SDK 1.12 emits `AfterToolCallEvent` for a cancelled Before call. Mark tool-use ids only after Pre and permission both proceed, and consume that mark in After; otherwise Post runs after denials.
- Cancellation must abort the active shell **process group**, escalate from SIGTERM to SIGKILL after a bounded grace period, and re-check `agent.cancelSignal` both before and after awaited permission evaluation. A hook that spawned `sleep`, a formatter, or a test must not orphan it or let the tool run after Ctrl+C.
- `spawn()` may throw synchronously for invalid arguments as well as emit asynchronous `error`; normalize both into `ToolHookResult`. Pre must deny and Post must preserve the original result in either case.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `hooks` absent | Register the existing `PermissionGate` directly; spawn nothing |
| Unknown event / non-array event | `ConfigError` naming the hook field |
| Non-object group, blank matcher, empty hooks | `ConfigError` at the exact array path |
| Unsupported type / blank command | `ConfigError`; only command hooks are supported |
| Pre exits nonzero with stderr | Deny; stderr reaches the model in the error tool result |
| Pre exits nonzero without stderr / cannot launch | Deny with actionable fallback |
| Permission denies after successful Pre | Body and Post do not run |
| Tool body throws | Original error result survives; Post still runs |
| Post exits nonzero / cannot launch | Preserve original result; continue remaining Post hooks |
| Turn cancelled during Pre/Post | Kill process group, return promptly, do not execute later stages |

### 5. Good / Base / Bad Cases

- **Good:** `file*` Pre policy validates `fileEditor`, permission approves, body runs, then every matching Post audit command runs.
- **Base:** no `hooks` key; runtime and subagents use the unchanged shared `PermissionGate`.
- **Bad:** registering hooks and permissions as separate handlers makes reverse After ordering ambiguous; treating every After event as execution runs Post after a denial; aborting only the shell leaves its children alive.

### 6. Tests Required

- `spike/verify-tool-hooks.ts`: exact payload/cwd/env capture, glob literals, sequential Pre short-circuit, denial wording, permission/body ordering, Post success/error isolation, synchronous and asynchronous launch failures, denied-call After behavior, and bounded Pre/Post cancellation.
- `spike/verify-config.ts`: absent/default, both config forms, `/model` preservation, misplaced session field, and every malformed nested shape.
- `spike/verify-subagents.ts`: a child tool traverses the same composed hook and permission instance.
- Always run `pnpm typecheck`, `pnpm test`, and `git diff --check`.

### 7. Wrong vs Correct

```typescript
// WRONG: separate handlers + no executed-call marker + no abort propagation.
interventions: [toolHooks, permissionGate]
await spawnHook(command)

// CORRECT: one shared lifecycle boundary with cancellable process ownership.
const intervention = config.hooks
  ? new ToolHookGate(projectRoot, config.hooks, permissionGate)
  : permissionGate
new Agent({ interventions: [intervention] })
```

---


## Scenario: portable Codex-compatible `.agents/hooks.json`

### 1. Scope / Trigger

Use this contract only for direct global/project `.agents/hooks.json`. Keep native `hooks/*.json`, legacy Darwin fallback, and the SDK loop unchanged. Never discover `.codex/hooks.json` implicitly.

### 2. Signatures

```typescript
const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact',
  'SubagentStart', 'SubagentStop', 'Stop',
] as const

decodeCodexHooks(value: unknown, source: string): CodexHooksConfig
new CodexHookRunner({ projectRoot, hooks, sessionId, config, permissionMode })
```

Codex groups use regex matchers; omitted, empty and `*` mean match all. Only synchronous command handlers are accepted: nonblank `command`, optional nonblank `commandWindows`, positive bounded `timeout`, inert string metadata, and non-negative integer `additionalContextLimit` converted to a conservative byte cap under the global context maximum.

### 3. Contracts

- Discovery/source order is global `.agents/hooks.json`, global native `.agents/hooks/*.json`, global Darwin native, project `.agents/hooks.json`, project native `.agents/hooks/*.json`, project Darwin native. Post reverses source granularity. Parse/schema/regex errors name the active direct source and field and fail startup. Every direct portable file is sensitive/un-ruleable executable policy.
- Commands run sequentially with project-root cwd, inherited environment, one bounded truthful JSON object, bounded output and timeout, and session/child-owned TERM→KILL process groups. Common payload fields are available `session_id`, `cwd`, exact `hook_event_name`, live `model`, and truthfully mappable `permission_mode`; never fabricate `turn_id` or a transcript path.
- `SessionStart` (`startup|resume|clear`), `UserPromptSubmit`, `PostCompact`, and matched `SubagentStart` may create bounded invocation-local context. Rewind emits no false session source. Parent injection changes only the model-facing text block; literal `userInput` remains trajectory/recall/memory evidence. Child injection changes only the selected child's task invocation.
- `UserPromptSubmit` block/exit 2 refuses before rewind capture, trajectory begin, provider or tool work. `PreToolUse` remains after plan/retry guards and before final permission classification; it may deny or apply a validated object `updatedInput`, after which later hooks and permission see the replacement. Alias matching never changes payload `tool_name`.
- `PostToolUse`, visible `PermissionRequest`, `SubagentStop`, driver-owned `Stop`, and orderly `SessionEnd` are observations/advisories. Their output cannot auto-allow, replace/retry/suppress a result, or continue a turn. Child stop payloads omit transcript paths and assistant text, so the ordinary bounded parent tool result remains the sole child-produced channel. Manual `/compact`/`--compact-before` alone emit `trigger: manual`; SDK overflow recovery is not exposed as false `auto` parity.
- Parent/child tool policy is shared. Child lifecycle processes are separately owned so targeted cancellation cannot cancel a sibling or parent hook. No hook event/output is appended to trajectory or rendered as a second transcript/live-frame channel.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Portable file absent | Silent; no runner/process |
| Unknown event, invalid regex/schema/timeout/context limit | `ConfigError` naming source and field |
| `mcp_tool`, `prompt`, `agent`, or `async:true` | Startup refusal; never silently weaken semantics |
| Context-producing handler fails | Drop its context, continue safely, report bounded problem through existing diagnostics |
| `UserPromptSubmit` block / exit 2 | Local refusal; no sent/recorded turn |
| Pre launch/timeout/invalid rewrite/nonzero other than 2 | Deny before permission/body |
| Post/lifecycle controlling output | Keep owning result/permission/outcome; report unsupported control through the bounded existing TUI/headless diagnostic projection, never raw stderr |
| Cancel, `/clear`, startup unwind, shutdown | TERM→KILL every owned command tree; one `SessionEnd` latch per runtime |

### 5. Good / Base / Bad Cases

- **Good:** this repository's `.agents/hooks.json` injects one Trellis workflow block into one parent invocation and one curated block only into a matching Trellis child.
- **Base:** native Darwin files continue using glob matching and native payloads with no Codex reinterpretation.
- **Bad:** reading identical `.codex/hooks.json` duplicates execution; converting regex to glob changes policy; injecting into stored messages corrupts literal trajectory/resume semantics; accepting `PermissionRequest allow` creates a second authorization path.

### 6. Tests Required

`spike/verify-codex-hooks.ts` covers all event names, decoder/source/path behavior, regex/match-all, command processes, payload/context/control bounds, runtime parent injection, local block and cleanup. Retain `verify-state-layers.ts`, `verify-tool-hooks.ts`, `verify-lifecycle-hooks.ts`, `verify-subagents.ts`, `verify-clear-session.ts`, `verify-trajectory.ts`, `verify-runtime-image-input.ts`, and `verify-headless-structured.ts`; finish with `pnpm typecheck`, `pnpm test`, and `git diff --check`.

### 7. Wrong vs Correct

```typescript
// WRONG: guess dialect, load Codex-owned duplicate policy, or rewrite durable input.
loadEveryJson('.agents', '.codex').map(asOneHookSchema)
trajectory.beginTurn(injectContext(userInput))

// CORRECT: source identifies dialect; only the model-facing invocation is decorated.
const portable = decodeCodexHooks(projectAgentsHooks, source)
const recording = trajectory.beginTurn(literalUserInput)
agent.stream(injectCodexContext(expandedModelInput, boundedContext))
```

---

## Scenario: observation-only lifecycle command hooks

### 1. Scope / Trigger

Use this contract only for configured `TurnComplete` and `PermissionRequest` commands. These are driver/visible-prompt observations, not SDK hooks, interventions, tools, messages, or trajectory facts. `AgentRuntime.create` remains the sole `Agent` assembly boundary and no lifecycle publication may intercept or fork the SDK loop.

### 2. Signatures and payloads

`ToolHooksConfig` additionally permits exactly `TurnComplete` and `PermissionRequest`, with the same strict matcher-group/command schema. Lifecycle matchers consume `event.source` using the existing complete case-sensitive `*`/`?` glob.

Each matching command receives exactly one newline-terminated JSON object no larger than `LIFECYCLE_HOOK_PAYLOAD_MAX_BYTES`:

```typescript
type LifecycleHookEvent =
  | { event: 'TurnComplete'; outcome: 'success' | 'failure' | 'cancelled'; source: 'interactive' | 'headless' }
  | { event: 'PermissionRequest'; source: string }
```

The permission source is the already-bounded `PermissionSource.label`: `parent` or `<agent>#<dispatchId>`. No prompt, answer, tool name/input/result, risk reason, path, session id, or error text enters either payload. An over-cap serialization is dropped whole; JSON is never truncated.

### 3. Ordering and publication

- Aggregate lifecycle groups in the same source order as Pre: global `.agents` → global `.darwin` → project `.agents` → project `.darwin`, lexical files inside each source. Never reverse them with Post wrappers.
- `PermissionGate.beforeToolCall` assigns one private `promptIdentity` object before its bounded mode-change restart loop. `PermissionQueue` weakly remembers that identity and publishes once when the logical request first becomes the visible current prompt. Queued requests publish on promotion; a request withdrawn before promotion never publishes; a gate re-decision never republishes it; closure publishes nothing. Replacing the observer for `/clear` resets the weak identity set because the successor lifecycle runner has a new session owner.
- The interactive driver's ordinary `runTurn` boundary publishes one final outcome with source `interactive`. The headless process boundary publishes one with source `headless`. Cancellation wins over failure when an interrupt caused termination. Stream continuation remains the driver's existing ordinary successor turn policy; lifecycle code does not retry or wrap `runtime.send`.
- Headless permission bridges publish the assessed source immediately before their existing local denial. No protocol event, stderr line, or model message is added.

### 4. Execution and ownership

- Lifecycle `publish()` is synchronous fire-and-observe: spawn matching `/bin/sh -c` commands and return without awaiting command completion.
- cwd is the project root; environment is inherited; stdin is the bounded payload; stdout/stderr are drained/discarded. Sync launch throws, async launch errors, nonzero exits, and command output are unobservable to the turn/permission/TUI/headless/trajectory owners.
- Every command is a detached process group owned by the session runner. Turn cancel calls TERM immediately; `/clear` retirement, startup unwind, and shutdown close the runner; after 500 ms, surviving groups receive KILL and cleanup waits only for bounded group disappearance.
- If neither lifecycle key is configured, construct no lifecycle runner and spawn nothing. Lifecycle-only config still registers the plain `PermissionGate`, not `ToolHookGate`.

### 5. Forbidden channels

Lifecycle commands cannot decide permissions, replace or deny tools, synthesize SDK tool events, append trajectory records, write terminal output, add model context, or transform driver outcomes. Do not expose command results, add an SDK callback, or generalize the event set beyond these two names.

### 6. Verification

`spike/verify-lifecycle-hooks.ts` covers bounded one-object payloads, matcher behavior, non-blocking publication, failure/output isolation, TERM→KILL, and permission current/queued/withdrawn exactly-once semantics. `verify-state-layers.ts`, `verify-config.ts`, `verify-clear-session.ts`, and `verify-headless-structured.ts` cover four-layer order, strict source errors, `/clear` ownership, and offline interactive/headless outcomes without provider calls.


---

## Scenario: isolated subagents as a tool

### 1. Scope / Trigger

Use this contract whenever the main agent delegates work to a fresh child Agent. The child may
use repository tools, but its working context must not become main-conversation context.

### 2. Signatures

```typescript
subagent({ task: string, agent?: string }): Promise<string>
loadAgentDefinitions(projectRoot, availableToolNames): Promise<AgentDefinitionRegistry>
new Agent({ model, systemPrompt, tools, interventions: [sharedGate], printer: false })
new SubagentDispatchRegistry()
registry.begin({ agentName, task, toolUseId? }): SubagentDispatchHandle  // attachAgent / finish
registry.list(): SubagentDispatchStatus[]          // start order, running and finished
registry.subscribe(listener): () => void           // one snapshot per terminal transition
registry.subscribeProgress(listener): () => void   // safe phase updates + ≤30 s heartbeats
registry.cancel(dispatchId): SubagentCancelResult  // exact-id, one child only
registry.sourceFor(agentId): SubagentDispatchSource | undefined
runtime.listSubagentDispatches() / runtime.subscribeToSubagentDispatches(listener)
runtime.subscribeToSubagentProgress(listener) / runtime.cancelSubagentDispatch(dispatchId)
shortDispatchId(toolUseId: string | undefined): string   // pure, id shown everywhere
```

Project definitions are direct `.darwin/agents/*.md` files. Frontmatter requires `name` and
`description`, accepts optional `tools: string[]`, and the non-empty Markdown body is the child
system prompt. `general` is built in and reserved. Dispatch states are
`running | succeeded | failed | cancelled`.

### 3. Contracts

- Every dispatch constructs a new model and Agent. No `SessionManager`, parent messages,
  existing conversation summary, or `subagent` tool reaches the child. Each child attaches its own
  `SummarizingConversationManager` with the live config's `summaryRatio` and
  `preserveRecentMessages`, matching the main Agent's overflow strategy without sharing history.
- Do **not** use SDK 1.12 `Agent.asTool()` for this boundary: `AgentAsTool.stream()` forwards
  child agent events as parent `ToolStreamEvent`s. Darwin consumes `child.invoke()` privately
  and returns only `AgentResult.toString()`.
- Build child-eligible tools from `mainAgent.tools` only after `await mainAgent.initialize()`;
  that is when MCP/plugin tools have their final names. Register `subagent` afterwards so it
  cannot enter the child catalogue.
- `tools` omitted means all eligible tools, `[]` means none, and a list is an exact,
  case-sensitive capability filter. It never grants permission.
- Attach the **same `PermissionGate` instance** to parent and child. This preserves the live
  permission bridge and in-session allow-rules; a copied config would diverge after the user
  accepts a rule.
- `/model` updates the subagent factory's config for future dispatches. Snapshot config before
  async model construction; an active child keeps its own model.
- Parent cancellation cancels tracked children. Re-check the parent's abort signal after async
  model construction so cancellation in that gap cannot launch an orphan child.
- Reap each child's bash session with direct `restart` in `finally`. Shared MCP clients remain
  owned and disconnected only by the main runtime.

#### Concurrency: parallel execution, never parallel prompting

Measured against `@strands-agents/sdk@1.12.0` with scripted models, no network:

- `resolveToolExecutor(undefined)` returns `ConcurrentToolExecutor`, which races the per-tool
  generators of one assistant message. Darwin must therefore **never set `toolExecutor`**, and
  in particular never `'sequential'`: two dispatches in one message would then serialize. Two
  300 ms children measured **303 ms total, both starting at +2 ms** (`spike/verify-subagents.ts`,
  scenario "two dispatches in one message run concurrently"); sequential would be ~600 ms.
- Hook callbacks — so `InterventionHandler.beforeToolCall`, so `PermissionGate` — are dispatched
  one event at a time by the single `Agent._streamCore` loop. Two *gated* parent calls in one
  message ask strictly in sequence (measured 10 ms then 213 ms with a 200 ms handler), so a
  pending prompt also blocks the later `tool_use` blocks of that same message. Parallel dispatch
  survives only because `classify('subagent', …)` is `read`/`safe` and never prompts; do not
  make delegation itself a gated call without re-measuring this.
- Each child Agent runs its own stream/hook loop, so several children can have requests pending
  at once (measured 2). One prompt is shown at a time and the rest queue — which is exactly why
  provenance is mandatory rather than cosmetic.
- Concurrency is scoped to **read-heavy** delegation. Children share one working tree with no
  isolation, locking or conflict detection, and nothing in darwin makes concurrent write
  delegation safe. This is a documented limitation, not a gap to be closed with a new denial
  path: the permission model does not change.

#### Provenance and per-dispatch observability

- `AssessedPermissionRequest.source` is **required** and carries `kind: 'parent' | 'child'`, a
  bounded ready-to-render `label`, and (children only) `dispatchId` / `agentName`.
  `PermissionRequest` and `classify()` stay unchanged, so stream-event consumers do not churn.
- The gate resolves provenance from `BeforeToolCallEvent.agent.id` through an injected
  `DispatchSourceResolver` — a narrow function, never the registry type: the permission layer
  must not depend on the delegation tool. An id the resolver does not know is the parent,
  because the runtime assembles exactly one `Agent` plus the dispatches the registry records.
  Absent a resolver every call reads as the parent's; it must never invent a child label.
- `AgentRuntime.create()` builds the registry **before** the gate (the gate must resolve
  children that do not exist yet) and passes the registry itself only to `SubagentTool`.
- Dispatch identity is `shortDispatchId(parent toolUseId)`: pure, so the TUI reducer computes
  the same id from a stream event without touching the registry, and one dispatch reads the same
  in the live row, `/agents`, the prompt label and the completion notice. A missing tool-use id
  (direct `.invoke()`) falls back to a random id, never a shared placeholder.
- A dispatch is recorded only once the requested agent name resolves: an unknown name never
  dispatched anything and must not appear as a failed run. Terminal state is published exactly
  once (`succeeded` / `failed` / `cancelled`, first call wins), listener failures are isolated,
  and a cancelled child settles as `cancelled` rather than `failed` or a permanent `running`.
- Records hold agent name, task text, closed phase, state, timestamps and the child meter's usage
  counters (live while running, frozen at the terminal transition; a cancelled or failed child
  keeps what it spent). Observability must
  never become a second path for child transcript or payloads to reach the parent — bound the task
  at presentation time, and never store anything the child produced.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `.darwin/agents/` absent | Built-in `general` only; no warning |
| Invalid YAML/name/description/body/tools | Skip that file and expose an agent problem |
| Case-insensitive duplicate or `general` | Keep first/built-in owner; skip later file |
| Unknown tool in allowlist | Skip definition; never silently drop the unknown entry |
| Unknown requested agent | Return available names as the tool result; record no dispatch |
| Child tool denied | Shared gate produces the normal denial result; tool does not run |
| Parent cancelled during model construction | Return cancelled result; do not create child; dispatch settles `cancelled` |
| Child invoke throws | Tool reports an error through SDK; dispatch settles `failed`; child bash cleanup still runs |
| Two dispatches in one assistant message | Both run concurrently; both dispatches observable while running |
| Two children ask for permission at once | Prompts queue one at a time, each labelled with its own dispatch |

#### Long-dispatch progress and targeted cancellation (`SRF-015`)

- Each running dispatch owns one unref'd heartbeat interval. Production heartbeats begin only
  after 30 seconds and recur no slower than every 30 seconds; the injectable shorter interval is
  test-only. Every terminal path clears the interval and drops the child canceller before
  publishing completion, so no success/failure/cancel heartbeat can arrive later.
- Progress is a closed privacy projection: bounded dispatch id and agent name, increasing elapsed
  milliseconds, and only `starting`, `model`, or `tool <bounded public tool name>`. SDK model/tool
  hooks supply those boundaries without reading child reasoning, messages, prompt, tool input/result,
  final report, or transcript. Progress is user visibility only: never a model message, trajectory
  event, permission decision, lifecycle-hook payload, or transcript notice.
- The TUI consumes every safe phase update into the existing active `subagent` tool row; periodic
  heartbeats keep that row current. Headless text emits heartbeat lines on stderr, stream JSON emits
  bounded `subagent.progress`, and final JSON remains one terminal object.
- `/agents cancel <dispatch-id>` is the only targeted control seam. It is parsed above busy queueing
  in the user input driver and calls the runtime registry directly; no model-callable tool exists.
  Exact running ids latch and invoke only that child's `Agent.cancel()`. Unknown, ambiguous,
  already-requested, and terminal ids refuse locally without changing the parent or siblings.
  Cancellation during model construction latches and prevents child startup when construction
  returns. The affected SDK tool call still returns its ordinary single cancellation result, so
  concurrent sibling calls and the parent turn can complete normally.
- Ctrl+C/full turn cancellation remains broader: `SubagentTool.cancelActive()` plus parent
  `Agent.cancel()` stops every active child exactly as before. Never set `toolExecutor`.

Required offline check: `spike/verify-subagent-heartbeats.ts` (real parent Agent/SubagentTool,
interval privacy and cleanup, parallel targeted/full cancellation, TUI grant projection, and
structured-protocol compatibility), plus `verify-subagents.ts`.

| Terminal dispatch listener throws | Other listeners still receive the snapshot; dispatch result unaffected |
| `finish()` called twice | First terminal state wins; one event only |
| Concurrent write delegation | Not made safe; documented limitation, no new denial path |

### 5. Good / Base / Bad Cases

- **Good:** parent delegates a broad search; child uses `fileEditor`/`bash`, then only its
  evidence-based final report appears in the parent tool result.
- **Good:** the model requests two read-heavy dispatches in one turn; they overlap, `/agents`
  shows both while they run, and each child's approval prompt names its own dispatch.
- **Base:** no project definitions; `general` handles the task with a fresh context.
- **Bad:** wrapping with `asTool()` forwards child stream events, or building a second gate lets
  a child miss an allow-rule the user just accepted.
- **Bad:** setting `toolExecutor: 'sequential'` (or serializing dispatch by awaiting one child
  before starting the next) silently halves throughput; storing child transcript on a dispatch
  record to make the UI richer breaks the isolation the whole scenario exists for; labelling only
  child prompts leaves the user guessing on the parent's.

### 6. Tests Required

- `spike/verify-subagents.ts`: discovery/errors, exact allowlists, fresh histories, parent
  transcript isolation, approval/denial, later-dispatch model config, concurrent overlap timings,
  parent-vs-child provenance, dispatch states (`succeeded`/`failed`/`cancelled`, unknown name
  recording nothing), and registry observer semantics (exactly once, listener isolation,
  unsubscribe).
- `spike/verify-subagent-format.ts`: dispatch-id purity and fallback, elapsed endpoints, the
  `/agents` report (empty wording, one row per dispatch, code-point-safe bounds), the completion
  notice, and the live delegation row.
- `spike/verify-permission-modes.ts`: gate-level provenance — parent label, resolver-provided
  child label, and an unresolved id staying parent instead of guessing.
- `spike/verify-subagents-live.ts`: real main → child delegation, safe repository read, and a
  child bash call reaching the shared permission bridge.
- `spike/verify-tui.ts completion`: invalid definition warning without a model call.
- `spike/verify-tui.ts agents`: zero-model `/agents` empty state, argument rejection, completion
  row, and bounded exit. `spike/verify-tui.ts approve`: the `[parent]` label with `allow?` and
  the details block still on screen (the label must not cost a frame row).
- Always run `pnpm typecheck` and `pnpm test`; cancellation/bash lifecycle changes additionally
  require the existing `cancelThenContinue` and `bashExit` scenarios.

### 7. Wrong vs Correct

```typescript
// WRONG: forwards child stream events and does not prove the child shares darwin's gate.
tools: [child.asTool()]

// WRONG: serializes delegation, and leaves a queued prompt unable to say whose call it is.
new Agent({ toolExecutor: 'sequential', interventions: [new PermissionGate({ mode, projectRoot, ask })] })

// CORRECT: private child invocation, reduced tools, shared intervention boundary.
const child = new Agent({
  model: await createModelFromConfig(liveConfig),
  tools: allowedTools,
  interventions: [permissionGate],
  printer: false,
})
const result = await child.invoke(task)
return result.toString()

// CORRECT: registry before gate; only the narrow resolver crosses into permissions.
const dispatches = new SubagentDispatchRegistry()
const gate = new PermissionGate({ mode, projectRoot, ask, dispatchSource: (id) => dispatches.sourceFor(id) })
const subagents = new SubagentTool({ /* … */ intervention: gate, dispatches })
```

---

## Scenario: bounded declarative workflow DAG (SER-045)

### 1. Scope / Trigger

Use this contract whenever the parent delegates a multi-step plan whose intermediate reports
must flow worker-to-worker without round-tripping through the parent context. One `workflow`
tool call runs one bounded DAG of subagent tasks on the installed SDK `Graph` orchestrator.

### 2. Signatures

```typescript
workflow({
  nodes: { id: string; agent?: string; task: string }[],  // 1..MAX_WORKFLOW_NODES (8)
  edges?: [source: string, target: string][],             // 0..MAX_WORKFLOW_EDGES (28)
  maxConcurrency?: number,                                 // 1..8; default: node count
}): Promise<string>
new WorkflowTool({ registry, tools, intervention, projectInstructions, config, createModel,
  dispatches?, codexHooks?, onChildInitialized? })         // src/agents/workflow-tool.ts
buildRecipeChild({ definition, config, model, tools, intervention, projectInstructions,
  idPrefix, dispatch }): Agent                             // src/agents/child-recipe.ts
new Graph({ id, nodes, edges, maxSteps: nodeCount, maxConcurrency })  // @strands-agents/sdk
graph.invoke('', { cancelSignal })                         // MultiAgentInvokeOptions
```

### 3. Contracts

- **Input is data, never code.** Node ids, agent names, task strings and plain
  `[source, target]` pairs; no edge handlers, no conditions, no callables. An invalid DAG is
  one bounded thrown error **before any child, model, or dispatch is constructed**: over-cap
  counts (zod), blank task, duplicate node id, unknown agent name (lists available agents),
  unknown edge endpoint, duplicate edge, and cycles (Kahn's algorithm — validation only).
- **Scheduling stays the SDK's.** AND-semantics dependency resolution, dependency-merged node
  inputs (`[node: <id>]` labels + upstream final content), `maxConcurrency` and terminus
  resolution are the installed `Graph`; darwin never reimplements or forks any of it.
  `maxSteps` equals the node count, which bounds the run and silences the SDK's
  unbounded-graph warning. No wall-clock `timeout` knob — no other delegation path has one;
  the run is bounded by the node cap, `maxSteps` and cancellation.
- **Every node is a recipe child.** `buildRecipeChild` is the single child-construction
  recipe shared with `SubagentTool` — composed system prompt, per-definition tool filtering,
  the same shared gate instance (so allow-rules keep applying and provenance carries
  `source`), dispatch phase hooks, `installMaxTokensRecovery`, `printer: false`. Neither
  caller may construct a child `Agent` directly. One config snapshot is taken per workflow
  invocation before async model construction; each node gets its own model.
- **Adapter seam, not a Graph subclass.** Each node enters the graph as a thin
  `InvokableAgent` whose `id` is the user's node id (edges and dependency labels read as
  declared) while the inner Agent id stays globally unique
  (`darwin-workflow-<agent>-<uuid>`) for the dispatch registry. The adapter's `stream()`
  prepends the node's own task (plus codex-hook context) to the SDK-provided input and drops
  the empty placeholder block from the graph-level `''` input; it also gives each node a
  private `invocationState` so max-tokens recovery stays per-child, folding retained partial
  text back into the node's final message via a rebuilt `AgentResult`.
- **One dispatch per node on the existing registry.** Begun before model construction with
  `toolUseId` omitted: all nodes share the parent `tool_use` id, and deriving dispatch ids
  from it would collide, making targeted `/agents cancel` fail closed as `ambiguous`. Nodes
  surface through the existing `/agents` rows, terminal notices, heartbeats and headless
  progress events — no new TUI frame surface. (The live `workflow` tool row does not get the
  per-dispatch elapsed suffix; that enrichment maps one dispatch to one `subagent` row.)
- **Terminus content only.** The tool result is the SDK `MultiAgentResult.content`
  (terminus nodes' combined content) projected to text; child transcripts stay private and
  no child event reaches the trajectory. CANCELLED → `"Workflow cancelled."`; FAILED → one
  bounded thrown error naming failed node ids with the first line of each node error.
- **Cancellation reaches unstarted nodes.** One owned `AbortController` forwards the parent
  tool context's `cancelSignal` (and `cancelActive()`/`shutdown()`) into
  `graph.invoke(…, { cancelSignal })`; the SDK aborts running nodes and never schedules
  pending ones. Targeted `/agents cancel` before a node starts returns a synthetic
  `"Workflow node cancelled."` result without invoking the child. The `finally` sweep
  settles every still-running dispatch as `cancelled`, reaps each child's bash session and
  closes each node's codex-hook fork.
- **Parent-only, like `update_plan` and `subagent`.** Constructed and registered strictly
  after the child tool catalogue is captured in `runtime.ts`, so no child catalogue can ever
  contain `workflow` (no recursive orchestration). Permission classification is `read` with
  a bounded node listing, following the `subagent` precedent: launching the DAG is a read;
  every tool call a node makes is gated individually. Never set `toolExecutor`.
- **Reads parallel, writes serialized.** Concurrent nodes share one working tree with no
  isolation; the tool description pins the rule (parallel branches are for reads, writes are
  serialized by edges) so the model sees it.
- **`/workflow <task>` is a prompt-style trigger, never a second execution channel.** The
  built-in expands (in `expandSlashCommand`, checked before skills and custom commands so no
  extension can shadow it) into one fixed-template prompt naming the `workflow` tool,
  restating the node bound and the reads-parallel/writes-serialized rule, and embedding the
  user's description verbatim — then flows down the ordinary submit path: the model still
  owns DAG decomposition and every node call is gated as usual. `parseWorkflowCommand`
  (`src/commands/workflow-command.ts`) stays pure and never imports `WorkflowTool`. Bare
  `/workflow` is the drivers' bounded local usage notice (TUI and dev-repl), never a model
  call; the runtime maps `'missing-task'` to null and never fabricates a turn. Busy
  submissions queue like any prompt (SER-027; it is not on the refuse list).

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Over-cap nodes/edges, blank task, dup/unknown ids, dup edges, cycle, unknown agent | Bounded tool error; zero models, children, dispatches constructed |
| Node model construction throws | Whole tool call errors; finally sweep settles remaining dispatches `cancelled` |
| Node child throws mid-run | Node dispatch `failed`; SDK marks node FAILED; dependants never start, swept `cancelled`; tool errors boundedly |
| Parent cancel mid-run | Running children cancelled, unstarted nodes never scheduled; all dispatches settle `cancelled` |
| Targeted `/agents cancel <node dispatch>` | Exactly that child stops; siblings and dependants continue with its synthetic report |
| COMPLETED with empty terminus text | `"Workflow completed with no terminus report."` notice, never an error |

Required offline check: `spike/verify-workflow-tool.ts` (validation refusals, diamond-DAG
order and SDK dependency merge, per-node dispatches with provenance, terminus-only result,
failure and cancellation sweeps, parent-only registration order), plus
`verify-subagent-heartbeats.ts` and `verify-subagents.ts` for the unchanged subagent recipe.
For the `/workflow` trigger: `spike/verify-workflow-command.ts` (parse, template, name
reservation) and `spike/verify-tui.ts completion` (every built-in still fits the menu).

---

## Scenario: session-owned background bash jobs

### 1. Scope / Trigger

Use this contract when a long shell command must outlive one agent turn but never outlive
darwin itself. Background work extends the existing `bash` tool; it is not a second tool or
a durable scheduler.

### 2. Signatures

```typescript
bash({ mode: 'start', command: string, timeout?: number }): Promise<{
  taskId: string; pid: number; outputPath: string
}>
bash({ mode: 'list' }): Promise<BackgroundTaskStatus[]>
bash({ mode: 'status', taskId: string, command?: string }): Promise<BackgroundTaskStatus>
bash({ mode: 'output', taskId: string, command?: string }): Promise<{
  taskId: string; output: string; startOffset: number; endOffset: number;
  hasMore: boolean; outputPath: string
}>
bash({
  mode: 'wait'; taskId: string; waitMs: number; command?: string;
  wakeOnOutput?: boolean
}): Promise<{
  reason: 'output' | 'changed' | 'terminal' | 'timeout' | 'cancelled' | 'shutdown';
  status: BackgroundTaskStatus; output: BackgroundOutputResult; instruction?: string
}>
bash({ mode: 'stop', taskId: string, command?: string }): Promise<BackgroundTaskStatus>
new BackgroundBashManager(projectRoot, sessionId)
```

Foreground `{ mode: 'execute'|'restart', ... }` keeps the SDK-vended signature. Normal return
values remain unchanged; an exit-0 shell close adds its restart notice to `BashOutput.error`.
Background states are `running | succeeded | failed | stopped`.

### 3. Contracts

- Runtime creates one manager and one wrapped `bash` tool. Main and child agents share the
  manager/task ids, while foreground calls delegate to SDK `bash.invoke(input, context)` so
  the SDK still keys persistent shells by the calling Agent.
- `start` spawns `/bin/bash -lc <command>` at project root with inherited environment,
  `detached: true`, and combined stdout/stderr at
  `.darwin/sessions/<sessionId>/background/<taskId>.log`. It resolves after the OS `spawn`
  event, not process completion. A supplied positive numeric `timeout` is preserved in the raw
  permission/hook input but is otherwise redundant: it does not alter classification or command
  presentation, and the wrapper still dispatches only `manager.start(command)`. It is never a
  background process lifetime or execution timeout.
- Task ids are runtime-unique UUIDs and map lookups are the only authority boundary; never
  derive a path from user-supplied `taskId`. Logs survive exit, but `--resume` restores
  neither registry nor cursor.
- `list` snapshots the insertion-ordered in-memory registry through each task's serialization
  queue. It needs no id and returns the full status contract; an empty registry returns `[]`.
- `subscribe(listener)` publishes one immutable snapshot after each first transition to
  `succeeded`, `failed`, or `stopped`. Publish from the manager's single terminal transition,
  isolate sync/async listener failures, and return an unsubscribe closure. Diagnostic log
  open/stat/close failure degrades to `outputBytes: null`; it must not suppress the event or
  create an unhandled rejection.
- `output` serializes per task, returns at most 64 KiB plus up to three bytes needed to
  complete the final UTF-8 character, and advances a byte cursor without duplicates. Hold
  an incomplete suffix while the file is growing; terminal malformed bytes may decode as
  replacement characters so the cursor cannot stall.
- `wait` probes at the manager's bounded 20 ms interval without holding the task serialization
  queue. With `wakeOnOutput` omitted or `true`, integer `waitMs` remains `[1, 30000]` and behavior
  stays output-sensitive: return `{ reason, status, output }` on consumable output, a
  concurrent consumer changing the cursor, terminal transition, timeout, caller cancellation,
  or manager shutdown. Its nested output is the ordinary single-consumer cursor read, so
  concurrent `wait`/`output` calls consume disjoint ordered byte ranges; a losing concurrent
  wait returns `changed`, not a full timeout.
- Explicit `wakeOnOutput: false` is terminal-focused and accepts integer `waitMs` in
  `[1, 300000]` (five minutes), a practical but finite build/test bound. It advances the same
  serialized cursor while polling, retains at most the ordinary 64 KiB output cap, and does not
  return merely for output or a concurrent cursor change. It returns retained contiguous output on terminal
  state, caller cancellation, manager shutdown, or timeout. A competing consumer may split the
  stream: every byte still belongs to exactly one consumer, retained offsets describe only the
  terminal-focused wait's contiguous range, and `hasMore` truthfully reports unread bytes when
  aggregation reaches its cap or cannot continue across another consumer's range. Only a
  terminal-focused `timeout` whose final status remains `running` adds one bounded `instruction`:
  when later work depends on completion, call `bash wait` again before ending the turn because
  background completion does not resume the agent. Terminal, cancelled, shutdown, and every
  output-sensitive result omit it. This is tool-result guidance only: no automatic continuation,
  model call, callback, or background-completion wake is added. Cancellation only releases the
  observer; it does not stop the task. Shutdown releases observers before
  entering the unchanged process-reaping path.
- `stop` owns the whole POSIX process group: SIGTERM, poll up to 500 ms, SIGKILL, poll up to
  500 ms. Natural leader exit performs the same descendant cleanup before terminal state.
  Explicit stop wins state races and settles as `stopped`.
- `start` is tracked before its first await. Shutdown latches closed, waits in-flight
  launches, then stops every running task with `Promise.allSettled`; no process may spawn
  after the cleanup snapshot.
- Keep every live/unconfirmed process group in one process-global registry. Remove it only
  after confirmed disappearance. One idempotent synchronous `process.on('exit')` handler
  sends SIGKILL to remaining groups; the SDK's SIGINT/SIGTERM handlers call `process.exit`,
  so `exit` is the reliable composition point.
- `start` is an execute permission and retains `input.command`, so existing
  `bash:<pattern>` rules and auto/default/yolo behavior apply. `list`, `status`, `output`,
  `wait`, `stop`, and `restart` are safe lifecycle calls. `status`, `output`, `wait`, and
  `stop` tolerate and ignore a redundant `command` field, but still require and dispatch
  only by `taskId`; only `wait` accepts `waitMs` and `wakeOnOutput`, and `list` remains strict.
  Existing Pre/Post hooks see each immediate outer `bash` call, not eventual background completion.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Blank `start.command` / malformed mode payload | Zod tool error; spawn nothing |
| Positive numeric `start.timeout` supplied | Accept but ignore after raw permission/hooks; dispatch only `manager.start(command)` and do not bound process lifetime |
| Invalid or unknown `taskId` | Clear error; never read or signal another path/process |
| Log deleted/unreadable | Status keeps process metadata with `outputBytes: null`; output errors with the owned path |
| Spawn fails | Reject start, close the parent log handle, kill/register-clean any exposed group |
| Repeated/concurrent output or wait | Serialized, disjoint cursor ranges |
| `waitMs` absent/non-integer/below 1, output-sensitive above 30000, or terminal-focused above 300000 | Zod tool error; manager also rejects direct invalid calls with the applicable finite bound |
| `wakeOnOutput` on a non-wait mode | Zod tool error; do not reinterpret the operation |
| Default wait sees no output/state change | Return `reason: timeout` within its declared bound with empty incremental output |
| Terminal-focused wait sees intermediate output | Retain/advance up to 64 KiB; do not return until terminal, cancellation, shutdown, or its finite five-minute maximum |
| Terminal-focused wait times out while still running | Preserve `reason: timeout`, status/output/cursor semantics, and add one bounded wait-again/no-auto-resume instruction; do not continue automatically |
| Terminal-focused wait races another cursor consumer | Return only its contiguous retained range; no duplicates; truthful `hasMore` |
| Wait caller cancels / manager shuts down | Return promptly with retained output; cancellation leaves task running, shutdown continues normal reaping |
| Repeated/concurrent stop | Share one termination operation and stable terminal state |
| Descendant ignores SIGTERM | Escalate to group SIGKILL within the bounded deadline |
| Shutdown races launch setup | Launch rejects before spawn or becomes visible and is stopped |
| Bounded cleanup cannot confirm disappearance | Keep group registered for synchronous exit cleanup |
| Child finishes after `start` | Child foreground `restart` must not stop manager-owned work |
| `list` carries `command`, `timeout`, or `taskId` | Zod tool error; do not reinterpret it as another mode |
| Terminal listener throws/rejects | Continue notifying other listeners; process state/cleanup remains authoritative |
| Terminal log snapshot cannot open/stat/close | Notify once with `outputBytes: null`; no unhandled rejection |


### 5. Good / Base / Bad Cases

- **Good:** a child starts a dev server, the parent waits with `wakeOnOutput: false`, and one
  bounded result returns aggregated progress when the process reaches terminal state.
- **Base:** omitted `wakeOnOutput` still wakes promptly on the first consumable output; an empty
  manager lists `[]`; `execute` and `restart` flow unchanged through the SDK persistent shell.
- **Bad:** polling status in each consumer duplicates transition logic; a terminal-focused wait
  that buffers without a cap can exhaust memory; notifying from both
  `close` and `stop` duplicates events; shell `&`, dropping the `ChildProcess`, or killing only
  the leader creates orphan descendants; persisting task metadata falsely promises resumable
  process control.

### 6. Tests Required

- `spike/verify-background-bash.ts`: foreground delegation/per-Agent persistence, real
  subagent sharing, permission modes/rules/hooks, empty/ordered list snapshots, exactly-once
  success/failure/stop events, unsubscribe/listener/log-snapshot failure isolation, delayed
  combined output, default and terminal-focused bounded waits, shared-cursor aggregation,
  split-UTF-8 reads, TERM→KILL stop, launch/shutdown races, and bounded cleanup.
- `spike/probe-background-bash-exit.ts`: direct exit, normal shutdown, CLI-style forced
  exit, SIGINT, and SIGTERM with SDK bash signal handlers loaded; leader and descendant must
  both disappear within deadlines.
- Run `pnpm typecheck`, `pnpm test`, and the PTY `bashExit` scenario when model access is
  available.

### 7. Wrong vs Correct

```typescript
// WRONG: bypasses the tool boundary, owns only the shell leader, and polls every fragment.
spawn('/bin/bash', ['-lc', `${command} &`])
while (running) await bash({ mode: 'output', taskId })
child.kill('SIGTERM')

// CORRECT: one wrapped bash tool, shared manager, bounded terminal-focused wait and cleanup.
const backgroundBash = new BackgroundBashManager(projectRoot, sessionId)
const bash = createBackgroundBashTool(backgroundBash)
const task = await bash({ mode: 'start', command })
const result = await bash({ mode: 'wait', taskId: task.taskId, waitMs: 300000, wakeOnOutput: false })
await backgroundBash.shutdown()
```

---


## Cancellation and Process Exit

Three independent process-lifecycle hazards are load-bearing:

1. **Vended bash session**: the persistent shell's stdio pipes are live handles, and the
   SDK's own `process.on('beforeExit', cleanup)` never fires because those very pipes keep
   the loop non-empty. `AgentRuntime.shutdown()` reaps it via the public API:
   `agent.tool['bash'].invoke({ mode: 'restart' }, { recordDirectToolCall: false })`
   (restart stops the running shell and only lazily creates a new one; the direct call
   bypasses interventions so no permission prompt appears at exit).
2. **Managed background process groups**: a background shell can leave descendants after
   its leader exits. `BackgroundBashManager` owns detached process groups, performs bounded
   TERM→KILL cleanup on stop/natural exit/runtime shutdown, and keeps unconfirmed groups in
   a synchronous `exit` fallback registry. Never replace this with leader-only `child.kill()`.
3. **Cancelled model stream**: `BedrockModel.stream()` sends its HTTP command without an
   abort signal; after `agent.cancel()` nothing destroys the socket, and the client is
   private — no public cleanup exists. `src/cli.ts` therefore arms an **unref'd** 500ms
   `process.exit` fallback *after* `await runtime.shutdown()` completes. Remove it once
   the SDK accepts an abort signal (re-check with `spike/probe-cancel-exit.ts`).

Regression coverage: `verify-background-bash.ts`, `probe-background-bash-exit.ts`, and
`verify-tui.ts` scenarios `bashExit` / `cancelThenContinue`.

Related: after a cancelled turn, release pending permission prompts with
`PermissionQueue.denyPending()`, never `close()` — `close()` latches shut and every later
tool call is silently denied with no prompt shown.

---

## Model Configuration (Bedrock)

- Model ids must be cross-region inference profiles (`us.` / `global.` prefix); bare
  `anthropic.*` ids are rejected by the API. Discover with
  `aws bedrock list-inference-profiles --region <r>`.
- Region fallback chain: `AWS_REGION → AWS_DEFAULT_REGION → 'us-west-2'`.
- Non-default providers (anthropic/openai) are **dynamic imports** inside
  `createModelFromConfig()` — their SDK packages are optional peer deps, and a static
  import would crash installs that only use Bedrock. Read the API key env var *before*
  the dynamic import so a missing key fails with `ConfigError`, not a module error.
  Both `openai` and `@anthropic-ai/sdk` are now direct dependencies (the latter pinned to the
  SDK's peer range `^0.109.1` — `pnpm peers check` must stay clean), so the `ConfigError`
  wrapper only fires on a pruned install.
- Context window: the window `/context`, `/status` and the pressure advice use is
  `model.getConfig().contextWindowLimit`, which the SDK fills from its static `CONTEXT_WINDOW_LIMITS`
  table (`models/defaults.js`, cross-region prefixes stripped) and darwin fills for `openai.`-prefixed
  Mantle ids from `OPENAI_CONTEXT_WINDOW_LIMITS`. The optional `contextWindowLimit` model key (whole
  tokens ≥ 1, every provider) is passed explicitly and wins over both tables; absent, nothing is passed
  so the lookup is untouched and an unknown id stays `window unknown` — never the SDK's 200,000
  utilization fallback. Coverage: `verify-config.ts` `contextWindowLimitField`.
- Anthropic base URL: `baseUrl` is an anthropic-only `MODEL_KEYS` entry validated as an
  `http(s)` URL; `resolveAnthropicBaseUrl()` decides `baseUrl → ANTHROPIC_BASE_URL → undefined`
  (client default) and the result reaches the SDK only as `clientConfig: { baseURL }` — never a
  pre-built `client` (which would need darwin to import `@anthropic-ai/sdk` itself). A missing
  credential (no `apiKeyEnv`, empty `ANTHROPIC_API_KEY`) is a `ConfigError` naming both, refused
  before the import. Offline coverage: `verify-config.ts` `providerSwitching`; live:
  `spike/verify-anthropic-live.ts`.
- Token usage lives at `result.lastMessage.toJSON().metadata.usage`, not
  `result.metrics` (which serialization drops — see "a serialized `AgentResult` carries
  no metrics" under Prompt Caching / usage below).
- `~/.darwin/config.json` is a closed schema: `MODEL_KEYS` and `SESSION_KEYS` (exported from
  `src/config.ts`) plus `models` at the root and `enable` in an entry are the only keys
  `loadConfig` accepts. Known keys are type-checked and misplaced known keys refused first (their
  messages are more specific), then every remaining unknown key is refused in one `ConfigError`
  with location and a `did you mean` within edit distance 2. Writers (`saveEnabledModel`,
  `saveThinkingEffort`) merge into the raw record and never validate. Adding a key means growing
  the list *and* the two `docs/user-guide/configuration*.md` tables — `spike/verify-config.ts`
  walks them against each other in both directions (`documentedKeys()`), and `unknownKeys()`
  pins the refusal, suggestion, precedence and the 10-key bound.

---

## MCP

- `McpClient.loadServers()` natively reads Claude Code's `.mcp.json` (it unwraps
  `mcpServers`, interpolates `${VAR}`, picks stdio/streamable-http/sse from the entry
  shape). Do not hand-roll config parsing; `src/mcp/registry.ts` only adds
  "missing file = no MCP" and `continueOnError: true`.
- A failed server (bad command, unset `${VAR}`) is skipped, not fatal: `listTools()`
  returns `[]` for it. Deliberate trade-off; the header's server count is the only
  *startup* signal — `/mcp` is the in-session one, naming the failed server outright.
- **`listTools()` connects lazily** — its first line is `await this.connect()` — so any
  status/inspection surface must never call it: on a `disconnected` client it would open a
  connection, and on a `failed` one with `continueOnError` it silently no-ops back to `[]`.
  Read `connectionState` (public: `'disconnected' | 'connected' | 'failed'`) and, for the
  registered tool names, the private `_registeredToolNames` set — populated by the SDK
  itself when `agent.initialize()` ran `listTools()` and registered the tools. That read
  follows the `loadServersQuietly` private-field precedent and must be guarded to degrade
  to "unavailable" (`mcpServerStatuses` in `src/mcp/registry.ts`; regression:
  `verify-mcp-command.ts`, in `pnpm test`).
- **`connect(true)` alone does not resurrect a failed server's tools**: the agent
  registers MCP tools once, in `initialize()` (`listTools()` → `toolRegistry.add`, plus an
  `onToolsChanged` refresh hook that only fires on server notifications). A forced
  reconnect flips `connectionState` to `connected` while the registry still holds nothing
  from that server — which is why `/mcp` ships no reconnect verb and tells the user to
  restart instead.
- stdio servers are child processes — `disconnectAll()` must run on every exit path. Their stderr
  is also outside both the Ink renderer and the bounded headless protocol, so every product entry
  point loads them through `loadServersQuietly()`; `spike/verify-tui.ts mcpStderr` proves a real
  server banner never reaches the interactive terminal.
- **Duplicate tool names are fatal**: the SDK's `ToolRegistry.add` throws
  `ToolValidationError` during `agent.initialize()` when two servers expose the same tool
  name (`browser_close` ships in several published servers) or a server shadows a built-in
  (`bash`). The registry therefore defaults every server's `prefix` to its config name
  (`withDefaultPrefixes`); the SDK renders agent-facing names as `<prefix>_<toolName>`, and
  an explicit `prefix: ""` opts a server back out. (Regression: `verify-mcp-config.ts`;
  live: `verify-mcp.ts` asserts `everything_get-sum`.)

> **Warning**: a `devEngines.packageManager` entry in package.json (written by `pnpm init`)
> makes every `npx`-launched MCP server die with `EBADDEVENGINES`, surfacing only as a
> generic `Connection closed`. Keep that field out of this repo.

---

## Sessions

- `SessionManager` + `LocalFileStorage` (`FileStorage` is deprecated), snapshots under
  `.darwin/sessions/` in the project root, `.darwin/last-session.json` as the `--resume`
  pointer. All project state resolves against `process.cwd()` via `src/paths.ts`.
- Write the pointer only after a turn completes (`markResumable()`), so an unused session
  never displaces a useful one.
- Per-session state is a sibling set under `<sessionsDir>/<sessionId>/`: `background/` logs,
  `offload/` files, and `trajectory.jsonl` (the append-only record). `src/agent/session.ts`
  owns every one of those paths; nothing else derives them.
- `darwin trajectory fork <id>` is the only other writer of `session/<id>/…`, and it writes by
  **copying bytes** — snapshot verbatim plus `offload/`, never through `SessionManager`, never
  touching the source or the resume pointer. See `session-trajectory.md` §7.
- `--session <id>` is valid interactively as well as headlessly. The id alphabet is checked in
  `cli-args.ts` and `resolveSession` still refuses an id with no persisted snapshot, so the old
  headless-only restriction protected nothing — and a fork, whose id exists only on stdout,
  would otherwise be impossible to open in the TUI. `--continue` remains headless-only.
- `--resume <id>` names the session to reopen (same strict `{ kind: 'id' }` path as
  `--session`); bare `--resume` — end of argv, or followed by another flag — keeps its original
  pointer-following meaning, so every pre-existing invocation parses unchanged. Combining an
  id-carrying `--resume` with `--session` is a usage error (two id sources). A named session
  with no restorable snapshot raises `SessionNotFoundError` (`src/agent/session.ts`), which
  `cli.ts` catches beside `ConfigError`: one plain line, exit 1, never a stack trace and never
  a fallback to the pointer's session.
- **Pointer semantics after resuming a named session are the unchanged `markResumable()` rule**:
  the pointer is written only after a turn completes, whatever selector opened the session. So
  once a `--resume <id>` (or `--session <id>`) session finishes a turn, `last-session.json`
  points at *that* session — it becomes the one bare `--resume` reopens. Opening a session and
  quitting without completing a turn moves nothing.
- `darwin sessions` (`src/cli-sessions.ts`, routed in `cli.ts` before argument parsing like
  `trajectory`) lists this project's resumable sessions, newest first *by snapshot mtime*: id,
  humanized age, first recorded `userInput` (via `readTrajectory`; `(not recorded)` where the
  trajectory is absent or damaged — absence is an answer), and `(last)` on the pointer's target.
  It is a read-only projection: no model, no network, no SDK import, no write API in the module
  at all — the store is byte-identical after a listing. Session directories without a
  restorable snapshot are skipped and the skip is stated with a count (they remain visible in
  `darwin trajectory list`). Verified in `spike/verify-sessions-command.ts` (free, in
  `pnpm test`), including a byte-level before/after hash of the store.

- **Interactive resume restores human context without changing model context (`SER-028`).** After
  `AgentRuntime.create()` has restored a non-empty snapshot, `cli.ts` reads that exact session's
  trajectory through `loadResumeRecap()` and passes the full replayed transcript as display-only
  `HistoryItem`s to `App` (`replayRecords` through the ordinary reducer — one projection, uncapped).
  The recap never enters `agent.messages`; `messageCount` before/after is therefore the SDK-restored
  count, with no synthetic user/assistant pair. It calls neither `Agent.stream()` nor a model, saves
  no snapshot, appends no trajectory record and moves no pointer. Quitting from the first prompt is
  byte-zero across all three files. Missing/pre-recording/disabled trajectories degrade visibly;
  fresh and headless paths do not load or render a recap. Verified by `spike/verify-resume-recap.ts`
  and free pty scenario `spike/verify-tui.ts resume` over a real `Agent`/`SessionManager` snapshot.


### Contract: restoring a session replays system prompt and official skill state

`takeSnapshot({ preset: 'session' })` includes both `systemPrompt` and `appState`, and restore runs
on `InitializedEvent` after constructor prompt/plugin setup. A resumed session therefore uses the
snapshot's base/project/catalogue rules and the official AgentSkills `lastInjectedXml` /
`activatedSkills`, not the freshly constructed values. Editing AGENTS.md still does not change an
existing session.

Current Darwin snapshots use explicit blocks: base/project text, one official
`<available_skills>` TextBlock, current `<working-context>` TextBlock, then the final
CachePointBlock. After restore, `applyWorkingContext` replaces only the known context block and
`applySystemPromptCachePoint` replaces the final cache point with this run's plan/TTL. On the next
invocation official AgentSkills removes its prior exact catalogue using restored appState and
appends one current copy; Darwin's later BeforeInvocation hook moves that copy back ahead of
working context/cache. Pre-migration `[TextBlock, CachePointBlock]` snapshots are recognized,
their stale `<available-skills>` catalogue is dropped, and official AgentSkills supplies one
current catalogue. Unknown arrays are refused rather than guessed at. Verified through a real
`Agent`/`SessionManager` in `spike/verify-agent-skills.ts` and helper cases in
`spike/verify-working-context.ts`.

## Scenario: headless one-shot CLI

### 1. Scope / Trigger

`darwin -p <message>` is the non-interactive boundary around the same `AgentRuntime.send()` loop
used by Ink. It exists for scripts: Ink is dynamically imported only on the interactive branch,
stdout is an atomic result channel, and stderr is bounded progress/diagnostics.

### 2. Signatures

```text
darwin -p|--print <message>
  [--output-format text|json|stream-json]
  [--continue|--resume [<id>]|--session <id>]
  [--permission-mode default|auto|plan|yolo|--yolo]
  [--max-model-calls <positive integer>] [--context-offload] [--compact-before]
  [< piped stdin]                                (SER-050: non-TTY stdin appended as one block, 256 KiB cap)

darwin sessions                                  (no model call, no network, no writes)
darwin trajectory <list|search|replay|fork> …    (no model call, no network)
darwin --help | -h                               (CLI_USAGE on stdout, exit 0; local, no writes)
darwin --version | -V                            (`darwin <DARWIN_VERSION>` on stdout, exit 0; local, no writes)

stderr: ^session: ([a-z0-9_-]+)$
stderr: ^permission-mode: (default|auto|plan|yolo)$
stderr: ^trajectory: .+$          (only when recording degraded)
exit: 0 success; 1 runtime/turn/persistence/cleanup/interruption; 2 CLI usage
stderr on exit 2: ^error: .+$ then exactly one `Run `darwin --help` for usage.` line
```

`--session` is strict and names an existing project-local snapshot. It takes precedence over
`--continue`/bare `--resume`; `--resume <id>` is the same strict path under the resume flag
(combining it with `--session` is a usage error); `--continue` follows `.darwin/last-session.json`
and retains the existing fresh-session fallback when no usable pointer exists.

The grammar text has one source: `CLI_USAGE` in `src/cli-usage.ts`. `darwin --help` prints it
byte for byte, the `cli.ts` header comment points at it instead of repeating it, and
`docs/user-guide/reference.md` / `reference.zh-CN.md` quote it verbatim; `spike/verify-cli-args.ts`
pins all three so they cannot drift. `--help`/`-h` and `--version`/`-V` are resolved by
`localCliAnswer(argv)` first of all — before `sessions`/`trajectory` routing and before
`parseCliArgs` — so either flag anywhere in argv wins over every subcommand and every other flag
(help before version; `darwin trajectory search --help` therefore prints the top-level grammar,
not a search). `src/cli-usage.ts` imports only `src/version.ts`, and neither imports the SDK,
runtime, config, Ink or React (asserted over the import graph); answering writes no file.
`parseCliArgs` itself stays unaware of the two flags and still reports them as `Unknown argument`,
so its pinned messages are unchanged. Every `CliUsageError` handler in `cli.ts` goes through one
`reportUsageError`: the parser's exact message on the `error:` line, then exactly one
`Run \`darwin --help\` for usage.` hint line, exit 2. There is no `help` subcommand and no
per-subcommand help page.

At the process boundary, `cli.ts` removes exactly one argv-leading standalone `--` before any
routing or parsing. This accepts the conventional package-script transport shape without weakening
the grammar: a second leading separator, any later separator, and a value equal to `--` still reach
the existing strict parsers unchanged. The `sessions` and `trajectory` subcommands are then routed
on `argv[0]` before `parseCliArgs` runs and have their own parsers (`src/cli-sessions.ts`,
`src/cli-trajectory.ts`), so `CliOptions` keeps exactly the shape every existing assertion in
`spike/verify-headless.ts` deep-equals. Its exit codes follow the same convention:
0 for a completed operation — including a search that legitimately found nothing — 1 for a
missing or unreadable record, 2 for usage.

### 3. Contracts

- Resolve/validate the session before provider construction; print exactly one `session: <id>`
  stderr record for every headless run whose arguments parse.
- Consume assembled `contentBlockEvent` text, not deltas. Buffer the complete reply; write stdout
  only after the turn, strict runtime shutdown, and resume-pointer write all succeed.
- Tool start/result and permission denial records go to stderr. Collapse whitespace and bound
  untrusted fields; MCP child stderr must not bypass that protocol.
- The headless permission bridge immediately returns `{ allowed: false }`. Gate-safe calls,
  persisted allow rules, auto classification, and yolo retain their normal semantics.
- A denied/failed tool does not determine process status: a model that handles its result and
  completes normally still succeeds.
- The SDK bash module installs SIGINT/SIGTERM listeners that call `process.exit(0)`. Headless mode
  must replace those handlers, keep its own handler installed through cleanup/persistence, cancel
  active work, and exit nonzero. Interactive mode keeps its established Ctrl+C policy.
- **Piped stdin (SER-050).** `readPipedStdin(process.stdin)` (`src/headless-stdin.ts`) runs
  only inside `runHeadlessProcess`, through the injectable
  `HeadlessRunnerDependencies.readPipedStdin`, in the same pre-protocol slot as argument
  parsing: before the SIGINT/SIGTERM swap, before any `session:` record, before the structured
  writer emits anything and before `createRuntime`. A TTY stdin is never iterated; `/dev/null`
  (`stdio: 'ignore'` — every existing harness and the developer skill's managed children),
  immediate EOF and whitespace-only bytes resolve to "no input", so the prompt argument reaches
  `send()` byte-identical to before. Otherwise the model-facing prompt is
  `composeHeadlessPrompt(argument, piped)`: the argument untouched, one blank line, then exactly
  one block — `--- piped stdin (<N raw bytes> bytes) ---`, the UTF-8 text (a newline added
  before the footer only when missing), `--- end of piped stdin ---`. That composed string is the
  one user input: what `runtime.send()` receives, what the `userInput` trajectory line records
  under its existing `MAX_FIELD_CHARS` cap, what memory and `UserPromptSubmit` hooks see; no
  second channel, no envelope field (the structured protocols never echoed the prompt). Cap
  `PIPED_STDIN_MAX_BYTES` = 256 KiB, **refused, never truncated**: the first byte past it stops
  the read (the iterator's `return()` destroys the pipe, so a runaway producer is not drained)
  and the run is an ordinary usage error in every output format — `usageErrorText(...)` on stderr
  (the same helper `cli.ts`'s `reportUsageError` uses), empty stdout, exit 2, no runtime, no
  session state. Invalid UTF-8 (`TextDecoder` fatal) and NUL bytes are refused the same way;
  bytes are never sent as base64. Interactive mode does not import the module (asserted over
  `src/` in `verify-headless.ts`). Documented caveat: a parent holding the pipe open without
  writing makes `-p` wait for EOF, as `cat` does. `parseCliArgs` stays I/O-free; the grammar
  states the rule in one `CLI_USAGE` line quoted by both reference docs.
- The three token-efficiency CLI controls are headless-only. `--max-model-calls` installs a
  `BeforeModelCallEvent` hook that throws before provider call `limit + 1`; each process gets a fresh
  count. ContextOffloader is default-on; `--context-offload` is a compatible process-only force-on
  override that does not change loaded/persisted config. `--compact-before` runs the existing
  reversible `AgentRuntime.compact()`
  after restore and before the requested turn; failure starts no public turn and follows the runtime
  failure/strict-cleanup path. With none of these flags, text and structured protocols are unchanged.

Structured output is an opt-in projection over this same loop; the complete public schema and
privacy/bounds policy live in `structured-headless-output.md`. Two SDK details determine that
policy: provider output guardrails can expose blocked text in `modelStreamUpdateEvent` and replace
it only during `Model.streamAggregated`, so v1 publishes completed `modelMessageEvent` `TextBlock`s
rather than raw deltas; and both `reasoningContentDelta` and `ReasoningBlock` can carry text,
signatures or `redactedContent`, none of which may enter the public protocol. The projector is an
explicit typed allowlist and never SDK `toJSON()` — that serialization seam is safe from live agent
state for the trajectory, but it is not a stable public API and still contains private payloads.

`--output-format text` is the literal old protocol. `json` buffers all progress and writes one
terminal result; `stream-json` emits versioned lifecycle/tool/completed-message records and one
terminal result. In both structured modes ordinary human stderr is silent after successful parsing,
and terminal success remains gated by strict shutdown and resume-pointer persistence. CLI usage
failure is the only case that has no structured output contract and retains human stderr/exit 2.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing/blank prompt, bad/repeated value flag, unknown flag | stderr usage error, exit 2, no runtime/model |
| Piped stdin over 256 KiB, not UTF-8, or containing NUL | same stderr usage error shape, exit 2, empty stdout, no runtime — in every output format |
| Piped stdin is a TTY, `/dev/null`, immediate EOF or whitespace-only | no block, no notice; stdout/stderr/`send()` input byte-identical to a run without a pipe |
| Invalid or missing explicit session snapshot | fixed session record, actionable stderr error, exit 1 |
| Permission required with no human | immediate denial record/result; never wait on stdin |
| Turn fails/cancels or has no final reply | stdout empty, stderr error, pointer unchanged, exit 1 |
| Cleanup or pointer persistence fails | stdout empty, stderr error, exit 1 |
| Turn handles a denied tool and completes | final reply on stdout, exit 0 |

### 5. Good / Base / Bad Cases

- **Good:** first call captures `session: <id>`; a later `--session <id>` restores context and emits
  only its final reply to stdout.
- **Base:** `--continue` with no pointer starts fresh and publishes the generated id.
- **Bad:** interruption or cleanup failure after answer generation must not leak the buffered answer
  to stdout or advance the resume pointer.

### 6. Tests Required

`spike/verify-headless.ts` covers parser aliases/precedence, immediate permission denial, bounded
single-line tool records, assembled answer extraction, strict snapshot selection, MCP stderr
isolation, usage exit status, no ANSI/stdout leakage, and piped stdin (SER-050): reader/composer
units (TTY never iterated, empty/whitespace → none, raw byte count across chunk shapes, cap stops
the read, UTF-8/NUL refusal, fixed fence, one-importer structural check) plus the fixture driver
spawned with `stdio 'ignore'` versus a real pipe — identical stdout/stderr/trace for empty and
whitespace pipes, the composed prompt exactly once in `send()`, exit-2 refusal one byte over the
cap in text and `json` with no trace file, acceptance exactly at the cap, and `json`/`stream-json`
output identical with or without a pipe. Also run a built-CLI SIGINT probe that
waits for the session record, sends SIGINT, and asserts nonzero exit plus empty stdout. Live smoke
checks should prove fresh + explicit-id multi-turn restore and default-denial/yolo behavior.

### 7. Wrong vs Correct

```typescript
// WRONG: partial answer can look successful; SDK SIGINT exits 0 first.
for await (const event of runtime.send(prompt)) process.stdout.write(textDelta(event))

// CORRECT: buffer assembled blocks; publish only after cleanup and pointer persistence.
const reply = await runHeadlessTurn(runtime, prompt, writeStderr)
await runtime.shutdown({ throwOnError: true })
await runtime.markResumable()
process.stdout.write(`${reply}\n`)
```

## Scenario: explicit `/compact` conversation reduction

### 1. Scope / Trigger

`/compact` is a cross-layer local command: the TUI requests it, `AgentRuntime` owns the live
SDK objects, `SummarizingConversationManager` mutates messages, `Model.countTokens` measures
the result, and `SessionManager` persists it. It must never fork or invoke the agent loop.

### 2. Signatures

```typescript
AgentRuntime.compact(): Promise<CompactResult>
SummarizingConversationManager.reduce({ agent, model }): Promise<boolean>
Model.countTokens(messages, { systemPrompt, toolSpecs }): Promise<number>
SessionManager.saveSnapshot({ target: agent, isLatest: true }): Promise<void>
```

`CompactResult` contains `messagesBefore`, `messagesAfter`, `estimatedTokensBefore`,
`estimatedTokensAfter`, `estimatedTokensSaved`, and `compacted`.

### 3. Contracts

- Run only while the agent is idle; direct message mutation during `Agent.stream()` is unsafe.
- Explicit compaction uses a dedicated SDK summarizer at its maximum `summaryRatio` (0.8),
  repeatedly, until one rolling summary plus configured `preserveRecentMessages` remain — or
  until a pass stops lowering the count (below). The configured manager attached to `Agent`
  remains unchanged for reactive overflow recovery.
- **Termination (SER-052).** Every pass snapshots the message list (shallow — the SDK splices,
  it never mutates member messages). A pass that returns `true` without lowering
  `agent.messages.length` is undone by splicing the snapshot back (message identity preserved)
  and ends the loop; `compacted` is true only if the count really dropped and `messagesAfter` is
  the real count. Each iteration therefore either lowers the count by ≥ 1 or exits, so the loop
  needs no pass bound and makes at most one summarizer call beyond the shrinking ones. Darwin
  does **not** replicate the SDK's split arithmetic to predict a no-shrink pass; the guard is
  observational so it stays right if the SDK changes. Recorded consequence: the SDK clamps
  `summaryRatio` to `[0.1, 0.8]`, so a 2-message history is never summarized in one pass
  (`floor(2 × 0.8) = 1`); with `preserveRecentMessages: 0` the floor is two messages (one
  rolling summary plus the newest message) and discovering it costs one summarizer call.
  2 messages / preserve 0 is therefore an honest `already compact` no-op after one call, not
  "one summary replaces the pair".
- **Swallowed failure is failure (SER-052).** `reduce()` is called without `error`, so the SDK's
  proactive path catches a summarization error, logs `proactive summarization failed`, and
  returns `false`. Inside darwin's loop the SDK has no other `false` (`insufficient messages`
  needs `length <= preserveRecentMessages`, excluded by the loop condition; `all protected`
  needs `pinFirst`, never set on this manager), so `compactConversation` throws
  `SWALLOWED_SUMMARIZATION_FAILURE` on any pass — first or later — and the existing catch
  restores the cloned originals; drivers print `compaction failed; conversation restored: …`.
  Never `compacted: true` after a failed pass, and never a partial result. The SDK's own
  warning already reaches the user through `routeSdkLogs` (TUI `sdk warn:` notice, headless
  stderr) immediately before darwin's notice, so the cause is not lost. A sentinel `error`
  argument was rejected: it is typed `ContextWindowOverflowError`, the SDK overwrites the
  thrown error's `.cause` with it, and `failureFromError` (`src/trajectory/record.ts`) would
  then print a fabricated `cause: ContextWindowOverflowError` in a structured headless
  `--compact-before` runtime failure.
- Both rules live in `compactConversation`, so the focused (`/compact <focus>`) and unfocused
  (`/compact`, `--compact-before`) managers share them; nothing changes on the runtime's
  overflow-recovery `SummarizingConversationManager`.
- Delegate split adjustment to the SDK: it moves boundaries to preserve tool-use/result pairs.
- Count the complete next request before and after: messages, the finished system prompt
  (including cache blocks), and every registered `toolSpec`. The result is an estimated
  context-size reduction, not billing savings; the summary call itself has a cost.
- A direct manager call emits no `AfterInvocationEvent`, so it does **not** auto-save under
  `saveLatestOn: 'invocation'`. Explicitly call `saveSnapshot(...isLatest: true)`, then write
  the normal resume pointer.
- Clone original `Message`s before reduction. Any summarization, counting, snapshot, or pointer
  failure restores them in place; after a persistence-stage failure, best-effort overwrite the
  latest snapshot with the restored state too.
- Summary content is reasoning-free. Thinking models return `ReasoningBlock`s with the summary,
  and a user-role message must never carry reasoning content (Bedrock rejects the whole later
  request with `User messages cannot contain reasoning content`). The pinned SDK patch makes
  `generateSummary()` drop `reasoningBlock` content before building the user-role summary; a
  response left with no non-reasoning block is a failed summary (throws), never an empty user
  message. Both the `/compact` manager and reactive overflow recovery share this path.
- Repair already-poisoned restores: `stripReasoningFromUserMessages(messages)` (in
  `src/agent/compact.ts`) strips `reasoningBlock`s from user-role messages in place, preserving
  message identity/order and skipping (not counting) any message that would become empty. The
  runtime calls it in `create()` after `initialize()` and the rewind `restoreSnapshot`; the
  repair is in-memory only — the next ordinary save persists it, trajectory bytes are never
  rewritten.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| `messages.length <= preserveRecentMessages + 1` | No model/count/storage call; `compacted: false` |
| SDK `reduce` returns `false` on any pass (swallowed summarization failure) | Throw `SWALLOWED_SUMMARIZATION_FAILURE`; restore original live messages; never `compacted: true`, never a partial result; the SDK's own `sdk warn` line precedes darwin's notice |
| SDK `reduce` returns `true` but the count did not drop | Undo that pass (snapshot spliced back, identity kept); stop; `compacted` reflects earlier shrinking passes only; at most one such call per compaction |
| 2 messages, `preserveRecentMessages: 0` | One summarizer call, undone; `compacted: false`, `messagesAfter: 2`; `already compact` notice |
| Summary or token count throws | Restore original live messages; surface failure |
| Latest snapshot or pointer write throws | Restore live messages, best-effort restore latest snapshot, surface failure |
| Estimated summary is larger | Clamp `estimatedTokensSaved` to zero; never claim negative savings |
| Summary response carries reasoning blocks | Drop them from the user-role summary; text survives; repeated passes over the compacted history succeed |
| Summary response is reasoning-only | Failed summary (throw in `generateSummary`); proactive reduce reports `false`; `/compact` surfaces it as failure and restores; no empty user message |
| Restored history has a reasoning-carrying user message | Strip in memory at runtime `create()`; assistant reasoning and would-be-empty messages untouched |

### 5. Good / Base / Bad Cases

- **Good:** 500-message session becomes one summary plus the recent window, follow-up succeeds,
  and `--resume` restores the compacted list.
- **Base:** conversation already fits the summary-plus-window shape; report no work needed.
  Two messages with `preserveRecentMessages: 0` also report `already compact`, after the one
  pass the SDK can make is found not to lower the count and is undone.
- **Bad:** the summarizer is throttled on the second of three passes; the SDK swallows the
  error and returns `false`. Reporting the first pass as `compacted: true` would persist a
  half-compacted history the user was told succeeded, so the whole operation rolls back.
- **Bad:** saving the compacted snapshot fails after message mutation; returning success would
  make the current process and resumed process disagree, so the operation rolls back.

### 6. Tests Required

`spike/verify-compact.ts` uses a deterministic `Model` with real SDK Agent, summarizer,
session manager, and local storage. Assert the retained messages are byte-identical, context
counting receives system prompt and tools, an immediate follow-up sees the summary, a fresh
agent restores it, and persistence failure restores every original message. The same suite
drives a reasoning-emitting model through a forced two-pass compaction (no user message may
carry a `reasoningBlock`; the second pass must succeed), a reasoning-only summary (rejects
with `SWALLOWED_SUMMARIZATION_FAILURE`, no mutation), and `stripReasoningFromUserMessages`
directly. SER-052 cases: 2 messages / preserve 0 terminates after exactly one summarizer call
with `compacted: false`, byte-identical messages, identity kept, nothing persisted; 16 messages
/ preserve 0 makes exactly three summarizer calls, ends at 2 messages with pass 2 as the rolling
summary (pass 3 undone) and the newest message by identity; a summarizer failure on the second
pass and on the first pass both reject, restore every message and persist nothing; the focused
manager on 2 messages / preserve 0 makes one focused call and is a no-op. The pty completion
scenario asserts `/compact` is discoverable without spending a model call; the live
`spike/verify-tui.ts compacting` scenario seeds two turns with `preserveRecentMessages: 1` so
one pass compacts `4 → 2 messages` for real while it proves keyboard/paste ownership.

### 7. Wrong vs Correct

```typescript
// WRONG: mutates history but leaves snapshot_latest stale; resume brings old context back.
await summarizer.reduce({ agent, model })

// CORRECT: reversible mutation followed by explicit persistence outside the agent loop.
const original = agent.messages.map((message) => message.clone())
try {
  await summarizer.reduce({ agent, model })
  await agent.sessionManager?.saveSnapshot({ target: agent, isLatest: true })
} catch (error) {
  agent.messages.splice(0, agent.messages.length, ...original)
  throw error
}
```

---

## Scenario: `/context` counting and model metadata

### 1. Scope / Trigger

Use this contract when `/context`, `Model.countTokens`, provider model construction, or context
window metadata changes.

### 2. Signatures

```text
BedrockModel({ useNativeTokenCount: true })
OpenAIModel({ contextWindowLimit?: number })
/context -> estimated context — ~N tokens · P% of W window · M message(s)      (no measurement)
/context -> context — ~N tokens (measured B + ~T new) · P% of W window · M message(s)
```

### 3. Contracts

`/context` delegates to `Model.countTokens(messages, { systemPrompt, toolSpecs })`. Supported Bedrock
models use CountTokensCommand over the complete next request. SDK unsupported/IAM failures are
cached and fall back to chars/4 text and chars/2 JSON. OpenAI Responses has no native counter and
stays heuristic. Mantle IDs carry an `openai.` prefix the SDK table does not strip, so Darwin supplies
known metadata (`openai.gpt-5.6-sol` = 1,050,000); unknown IDs remain unknown. The display remains an
estimated request size, not a billing metric.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Bedrock CountTokens supported and authorized | Return provider-native complete-request count |
| Bedrock CountTokens unsupported/IAM denied | SDK caches failure and uses heuristic thereafter |
| OpenAI Responses | Use heuristic; no token-count provider request |
| Known prefixed Mantle model | Report mapped window and percentage |
| Unknown OpenAI model | Report `window unknown`; do not guess |

### 5. Good / Base / Bad Cases

- **Good:** Mantle Sol reports its 1,050,000 window and a heuristic request-size percentage.
- **Base:** an unknown OpenAI model reports a count with `window unknown`.
- **Bad:** leaving the `openai.` prefix unhandled keeps a known Mantle model unknown and disables warnings.

### 6. Tests Required

`spike/verify-config.ts` asserts native Bedrock counting, prefixed/unprefixed known OpenAI metadata,
and unknown-model degradation. `spike/verify-context-format.ts` pins presentation.

### Measurement anchor: measured base plus counted tail

`/context` prefers the measurement the provider already reported over its own heuristic. On each
`afterModelCallEvent` carrying `stopData`, `AgentRuntime.observeContextAnchor` stores that call's
submitted prompt total — `requestInputTokens(usage, config)`, the same arithmetic `/usage`'s per-call
average uses: OpenAI Responses' `inputTokens` (cache already inside it), otherwise uncached input
plus cache read plus cache write, because a cached prefix still occupies the window. This is a
window-occupancy figure and deliberately not a billing view. Stored with it: `agent.messages.length`
at that moment and the boundary message by object reference.

`contextEstimate()` then reports `measured base + countTokens(tail, {})`, where the tail is
`messages.slice(anchor.messageCount)` — counted through the same SDK counter, never a second
estimator, and deliberately without `systemPrompt`/`toolSpecs`, which the anchor already measured.
`ContextEstimate.measuredTokens`/`tailTokens` are present only when a measurement was used; absence
means not measured, never `0` (`usageBuckets` rule). The system prompt's `<working-context>` is
re-derived each run, so the base describes the previous call's prompt: every completed call refreshes
it, which is what bounds the drift to one call.

A fitted `measured / heuristic` correction factor is rejected: provider-, tokenizer- and
content-dependent, requiring unjustifiable smoothing/clamps, and silently scaling every downstream
consumer including the pressure advisory. Do not reintroduce it.

| Condition | Result |
|---|---|
| Completed call, usable counters | Install anchor; next estimate is measured base + tail |
| Failed call, unreported counters, unsplittable Responses reading, empty history | Install nothing, invalidate nothing — previous measurement stays |
| History only appended to | Anchor resolves; growth is charged to the tail, base unchanged |
| History shortened or rewritten (`/compact`) | `resolveAnchor` drops it; whole-request heuristic line returns |
| `/model` switch | `changeModel()` clears it explicitly (foreign tokenizer/prompt overhead) |
| `/clear`, `/rewind`, fresh or resumed session | No anchor until the first metered call |
| Tail `countTokens` throws | Keep the base, report `tailTokens` absent (`tail unknown`) |
| Observer throws | Latch the anchor broken (separate from call stats); never fail the turn |

Presentation is shared with `/status` through `formatContextValue`: with a measurement the line reads
`context — ~N tokens (measured M + ~T new) · …`; without one it stays byte-identical to the
pre-anchor `estimated context — ~N tokens · …`. `spike/verify-context-anchor.ts` covers the pure
state and a real offline runtime (installation, invalidation matrix, tail-only counting, degradation);
`spike/verify-context-format.ts` and `verify-status-command.ts` pin the two rendered shapes.

### Context-pressure advisory

The post-turn context-pressure path consumes this same estimate; it is not another counter and must
not infer pressure from spend/cache-read figures. `contextWarnRatio` is the single configurable
threshold (default `0.8`, custom values preserved, `0` disabled). A known positive window crossing
produces one bounded transcript notice recommending user-controlled `/compact` before the next broad
implementation or verification turn. It never invokes `AgentRuntime.compact()`, mutates conversation
state, or adds a model call. Remaining above is silent; a later known below-threshold estimate re-arms
the session latch. Unknown/invalid windows, invalid token estimates, and estimation failures produce
no pressure result, and `/clear` starts with a fresh latch.

`spike/verify-context-format.ts` pins exact crossing, one-shot/re-arm/disabled/unknown behavior and the
transcript-only projection. Keep `spike/verify-compact.ts`, `verify-status-command.ts`,
`verify-clear-session.ts`, and the frontend frame/queue/resume suites green.



### 7. Wrong vs Correct

```typescript
// WRONG: known Mantle ID misses SDK's unprefixed table.
new OpenAIModel({ modelId: 'openai.gpt-5.6-sol' })

// CORRECT: pass Darwin's normalized metadata; counting remains provider-specific.
new OpenAIModel({ modelId, contextWindowLimit: 1_050_000 })
```

---

## Scenario: official Agent Skills with Darwin compatibility

### 1. Scope / Trigger

Use this contract whenever skill discovery, loading, slash expansion, prompt composition, cache
placement or session restore changes. Production imports `AgentSkills` and `Skill` from
`@strands-agents/sdk/vended-plugins/skills`; do not reintroduce a parser, catalogue renderer,
activation formatter or resource walker.

### 2. Signatures

```text
public model tool: load_skill({ name: string }) -> { instructions: string }
unknown skill:    { error: string, availableSkills: string[] }
private SDK tool: skills({ skill_name: string }) -> string  // never registered
manual command:   /<skill-name> [request]
prompt request:   base/project -> <available_skills> -> <working-context> -> CachePointBlock?
resource bounds:  maxResourceFiles=20; SDK recursion depth=3
state key:        darwin_agent_skills ({ lastInjectedXml, activatedSkills })
```

### 3. Contracts

- Official SDK code owns frontmatter/body parsing, `<available_skills>` generation, activation
  formatting, bounded resource listing and persisted activation state. Darwin both preflights and
  wraps host `sandbox.listFiles` with use-time `lstat`/realpath checks because the SDK host sandbox
  follows directory symlinks. SDK 1.12.0 has no public same-Agent sandbox override, so the wrapper
  uses an Agent proxy: all Darwin skills are Skill instances, making official activation fall back
  to the same base catalogue; forwarded appState still records on the original Agent, but exact
  per-Agent WeakMap identity is not preserved and must not be claimed.
- `src/skills/loader.ts` supplies official `Skill` instances after required built-ins first,
  case-insensitive built-in reservation, project-over-global precedence, optional skip-and-surface,
  and fatal required assets. Missing names default to the directory and names retain Darwin's
  established `[A-Za-z0-9_-]+` grammar; SDK strict lowercase/hyphen validation is deliberately not
  enabled because it would break existing uppercase/underscore skills.
- `src/skills/plugin.ts` delegates initialization/activation to official `AgentSkills`. Its native
  tool remains private; the model and child-tool catalogue see exactly one statically-safe
  `load_skill({name})` tool. Success remains `{ instructions }`.
- `load_skill` and `/skill-name` resolve case-insensitively to a canonical official Skill. Both use
  official activation, so appState/resource behavior is not duplicated. Slash expansion keeps the
  "full text is above, do not call load_skill" guard.
- Official AgentSkills injects on each `BeforeInvocationEvent`, not initialize. With a raw cached
  block array it appends after the cache point. Darwin's later hook reorders known blocks; inability
  to prove that order fails before the model request rather than sending an uncached/duplicated
  catalogue.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Required built-in absent/unreadable/invalid | Refuse startup with packaged path/reason |
| Optional entry invalid/unreadable/duplicate | Skip one entry and add `RuntimeInfo.skillProblems` |
| Project/global name collision | Valid project wins; invalid project claims nothing |
| Built-in collision, any case | Built-in wins; optional entry is reported reserved |
| Unknown `load_skill` name | Recoverable result listing accepted names |
| Resource directory/file is a symlink or resolves outside skill root, including a post-preflight swap | Preflight rejects it, or guarded use-time listing suppresses that directory before outside names are enumerated |
| Resource preflight exceeds 200 entries | Deny activation at the bound before official traversal |
| Legacy cached/uncached prompt matches the exact historical skills prologue, adjacent historical working-context prologue, and trailing closes | Remove only those proven suffix blocks; preserve literal opening-tag text in project rules or either body; for monolithic cached legacy-shaped arrays, block fallback to the generic parser and refuse identity/content unchanged |
| Cache mutation sees unknown multi-block shape | Refuse unchanged; `/model` fails before swapping live config/model |
| More than 20 resource files | First 20 plus official truncation marker |
| Native `skills` appears in `agent.tools` | Contract failure: do not expose a second tool |
| Prompt shape cannot be reordered | Fail the invocation before its model call |

### 5. Good / Base / Bad Cases

- **Good:** a cached resumed Agent restores official appState, refreshes current context, removes
  the prior catalogue, then sends one catalogue before context and one final cache point.
- **Base:** `/commit-message terse` activates officially, inlines instructions/resources and sends
  `terse` without another tool call.
- **Bad:** registering official `AgentSkills` directly exposes `skills({skill_name})`, makes
  permission classification fail closed, and places its catalogue after Darwin's cache point.

### 6. Tests Required

- `spike/verify-agent-skills.ts`: real offline Agents and SessionManager; assert tool names/schema,
  actual first/repeated/resumed `StreamOptions.systemPrompt`, cached and uncached legacy migration,
  canonical restored activation, one catalogue/context/cache, compatibility activation,
  unknown-name result, resource truncation, symlink refusal and preflight bounds.
- `spike/verify-skills.ts`: required fatality, built-in/project/global policy, optional problems,
  official Skill body/path, case-insensitive slash expansion and bundled workflow contracts.
- `spike/verify-permission-modes.ts` keeps `load_skill` statically safe;
  `spike/verify-tui.ts completion` keeps built-ins first and every accepted skill invokable.
- One opt-in `verify-skills-live.ts autonomous` call proves a real model autonomously chooses and
  completes `load_skill`. Do not make it part of the offline aggregate.

### 7. Wrong vs Correct

```typescript
// WRONG: exposes a second schema and lets official injection land after cache.
new Agent({ plugins: [new AgentSkills({ skills })] })

// CORRECT: policy-filter official Skills, vend only load_skill, then reorder after
// the official BeforeInvocation hook and before the model sees StreamOptions.
new Agent({ plugins: [darwinSkills] })
agent.addHook(BeforeInvocationEvent, ({ agent }) => {
  if (!orderOfficialSkillsPrompt(agent)) throw new Error('skills prompt order')
})
```

---

## Scenario: built-in developer supervisor

### 1. Scope / Trigger

`/developer <requirement>` loads a product-bundled skill into the Host's main conversation. The Host supervises external headless darwin invocations through the existing background bash manager; it is not an in-process subagent, scheduler, or fork of `AgentRuntime.send()`.

### 2. Signatures

```text
/developer <delegated requirement>
bash start: darwin -p <complete worker> --yolo --context-offload
bash start: darwin -p <correction> --session <id> --yolo --context-offload [--compact-before]
optional explicit ceiling on either: --max-model-calls <positive integer>
child stderr: ^session: ([a-z0-9_-]+)$
user view: /tasks
```

The built-in source is `src/skills/builtin/developer/SKILL.md`; `pnpm build` must copy it to `dist/src/skills/builtin/developer/SKILL.md` because `tsc` does not copy Markdown assets.

### 3. Contracts

- `scanSkills()` loads required built-ins first in declared order, then deterministic project and global tails. Built-in names are reserved case-insensitively, valid project entries override global entries, and a missing/invalid required built-in fails startup because it is a promised product capability, not optional configuration.
- Keep the supervisor in the Host conversation: only that conversation can escalate product decisions to the user. The `subagent` tool returns one final report and is the wrong boundary for this dialogue.
- Every child invocation uses `bash start`; retain its `bg-*` id for `status`/`output`. For every task, call `output` at least once and, after terminal status, drain it through `hasMore: false` before reviewing the reply or proceeding; status metadata and `outputBytes` never substitute for the child response. Capture conversational identity only from the exact `session:` stderr record and use explicit `--session` on every follow-up.
- Run each child from the exact target root. The child prompt says it is the direct worker and must not load `developer`, start another darwin, or delegate again; without that guard a built-in skill advertised to both Host and child can recurse.
- The first child is one complete direct worker, not a planning-only turn. It may load the target's configured non-developer skills and owns task/planning/research artifacts, implementation, checks, spec updates and authorized commits. Do not set `DARWIN_PLANNING_ONLY`, do not pre-compact a fresh session, and do not make implementation wait for Host plan approval. Only unresolved product/scope/authorization decisions return to the Host/user.
- Every child invocation uses `--yolo` by default because a headless process cannot answer permission prompts. Yolo changes confirmation behavior only: the Host still establishes and enforces the named repository and authorized task scope. The Host independently inspects the diff and runs acceptance checks; failed acceptance returns to the same child session rather than being hidden by a Host edit.
- Developer commands rely on default-on durable context offload (and may retain the compatible force-on flag) but use no model-call budget by default; the
  direct worker follows repository skills to a natural completion. The generic hard CLI ceiling is
  added only when the user or Host explicitly supplies a positive integer. Correction compacts only
  after a large prior turn. Children batch independent reads/checks and serialize dependent writes.
- Verification follows a pyramid: minimal reproduction/focused suite/typecheck while editing; one
  child full gate after source settles; commit/diff/status only after a no-source-change commit; one
  independent Host full gate. Green full suites are not repeated for reassurance.
- A drained child reply containing the provider's transient `turn failed: The server had an error while processing your request. Sorry about that!` message is retried automatically, at most twice after the original attempt. Reuse the same prompt, target root, yolo mode, and captured session id; if planning failed before emitting one, start a fresh planning attempt rather than guessing identity. Deterministic failures are corrected or reported, not blindly retried.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Target has no `.darwin/skills/` | Advertise and load `developer`; no project-skill warning |
| Project defines `DEVELOPER` | Keep built-in, skip project definition, surface collision |
| Built-in asset absent/invalid after packaging | Fail startup with the built-in path/reason |
| First child emits no exact session record | Do not guess from `bg-*` or use `--continue`; report/recover explicitly |
| Child asks an evidence-resolved question | Host answers from requirement/repository evidence |
| Child asks unresolved product/scope/authorization question | Host asks the user |
| Child reply contains the transient provider server-error message | Retry the same turn automatically, at most twice; preserve the captured session when available |
| Child process or acceptance fails | Inspect output and continue the captured session with a focused correction, or report blocker |
| Child begins another developer workflow | Treat as recursion failure; correct the direct worker prompt |

### 5. Good / Base / Bad Cases

- **Good:** one Host turn starts a complete worker, exposes it through `/tasks`, captures `session-*`, and independently verifies its diff and tests; only a failed acceptance launches a same-session correction.
- **Base:** a built-in-only repository expands `/developer` through the ordinary skill path and keeps progressive disclosure.
- **Bad:** using `--continue`, a `bg-*` id, foreground `bash execute`, Host source cwd, or a child prompt that permits recursive developer delegation breaks identity, responsiveness, or target isolation.

### 6. Tests Required

- `spike/verify-skills.ts`: built-in-only discovery/load/slash expansion, progressive disclosure, workflow guard text, budgets, batching/test-pyramid policy, deterministic merge, and collision isolation.
- `spike/verify-headless.ts` / `verify-headless-structured.ts`: parse/reject tuning flags, pass
  overrides explicitly, compact before `turn.started`/send, and classify compact failure as runtime.
- `spike/verify-model-call-budget.ts`: a real offline Agent/tool loop reaches the limit and proves the
  provider never sees call `limit + 1`.
- `spike/verify-context-offload.ts`: process override registers retrieval while loaded config remains
  unchanged.
- `pnpm build` plus package dry-run: compiled and packed Markdown asset exists.
- `spike/verify-developer-live.ts`: real Host TUI, managed planning + explicit-session implementation turns, `/tasks` during streaming, status/output monitoring, no recursion/cwd drift, independent file/test/diff acceptance, and deadline-bounded exit.
- Keep the live scenario opt-in because it makes real model calls.

### 7. Wrong vs Correct

```text
# WRONG: pointer identity, foreground blocking, recursion, and no cost bounds
darwin -p "use developer to fix it" --continue

# CORRECT: one complete worker, with a budget only when explicitly requested
bash start -> darwin -p "own the full repository workflow" --yolo --context-offload
# only after Host acceptance fails:
bash start -> darwin -p "fix this exact finding" --session session-123 --yolo --context-offload
```

---

## Scenario: built-in self-evolution research

### 1. Scope / Trigger

`/self-evolution-research` loads a product-bundled Markdown workflow. A fresh run first rolls its research path with the skill's own bundled script, then persists that roll, its findings, and ranked iteration state under `docs/research/`, and composes the existing built-in `developer` workflow one direction at a time. It adds no scheduler, network client, or alternate agent loop.

### 2. Signatures

```text
/self-evolution-research [request]
backlog router: docs/research/backlog_index.md
backlog pages:  docs/research/backlog/directions-NNN-NNN.md (stable ranges of 20 priorities)
report:         docs/research/research_<YYYY-MM-DD>.md
roll:    node <skill-dir>/scripts/roll-research-path.mjs [--path <id>]
         -> research-path/focus/share/draw/path-source/rolled-at/weights
handoff: load_skill({ name: "developer" })
```

### 3. Contracts

- Read `docs/research/backlog_index.md` before consulting any product-research source. It is a thin policy/router with no direction records or mutable status mirror. Its routes name stable 20-priority pages under `docs/research/backlog/`; closed pages are never rebalanced.
- Search routed pages for heading plus exact Status/Priority/Origin metadata before reading record bodies. Valid states are exactly `not-started`, `in-progress`, `done`, and `abandoned`. Select the highest-priority `in-progress` record first, otherwise `not-started`; while either exists, perform no fresh product research. Read only the selected section and unfinished sections sharing its newest origin report.
- Fresh runs roll the path exactly once, before reading any source, on weights `tui=2 observability=0.5 sdk=1 open=1.5 peer=5` (20% tui, 15% open, 10% sdk, 5% observability, 50% peer). The script's verbatim output is recorded in the report; a re-roll is forbidden and `--path` is user-directed only, printing `path-source: override (user-directed)` so a directed run can never read as chance. The draw runs over half-units (`DRAW_UNITS_PER_WEIGHT = 2`, `TOTAL_DRAW_UNITS = 20`) rather than over the weights, so a half weight becomes a proportional integer range instead of a rounded one — the documented share is the implemented share, a weight that is not a whole half throws at load, and an out-of-range draw throws rather than clamping onto the first or last path.
- Every path inspects current Darwin source/architecture first. The `peer` path additionally needs sourced evidence for Claude Code, Codex, DeepSeek harness, PenguinHarness, and at least one further relevant product; a self-review path cites repository paths and symbols instead and states that no peer product was consulted. Missing source access is recorded as a limitation, never filled from model memory, and a peer table is never padded with a product the run did not open.
- A path whose scope turns out to be in good shape is a valid outcome: record it and propose nothing. The roll changes where evidence comes from, never the 1–5 ratings, the score gate, the report file, or the `developer` handoff.
- Append each run to `docs/research/research_<YYYY-MM-DD>.md` under a unique UTC timestamp. Read an existing same-day file first and never overwrite prior runs.
- Propose at most five non-duplicate directions. Rank 1–5 importance, architecture fit, evidence confidence, implementation difficulty, and implementation risk using `2 × importance + fit + confidence − difficulty − risk`, plus qualitative rationale. Append accepted complete sections to the current page; if the next Priority leaves its range, create the next zero-padded 20-priority page and add exactly one index route.
- Change one selected section in its routed page to `in-progress`, load `developer`, and implement exactly that direction. Set `done` only after the Host's independent acceptance; otherwise retain `in-progress` with blockers. `abandoned` requires an explicit recorded reason. Do not edit another record or create an index status summary.
- `REQUIRED_BUILTIN_SKILLS` in `src/skills/loader.ts` is the single required-name list. All bundled built-ins use ordinary progressive disclosure, slash expansion, collision reservation, and the existing recursive `src/skills/builtin` build copy.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Required built-in asset missing/invalid | Fail startup with its name/path; do not silently remove product capability |
| Optional project/global skill missing/invalid | Preserve existing skip-and-surface behavior |
| Index route missing/broken, page over capacity, record misplaced/incomplete, duplicate ID/Priority, invalid status/score, or broken local origin link | Validation failure; repair the Markdown contract before selection. The sole grandfathered score anomaly is the exact persisted `SER-023` signature (`13:4:5:4:3:3`), preserved losslessly by the pagination migration; changing any field removes the exception. |
| Any `in-progress` backlog record | Select by priority through metadata search; no fresh peer research |
| No `in-progress`, but a `not-started` record | Select by priority through metadata search; no fresh peer research |
| Named product source unavailable | Record limitation and make no unsupported claim |
| Fresh research with no recorded roll | Unauditable: the report must carry the script's verbatim output before any finding |
| Roll produces an unappealing path | Binding; record every output and use the first, never re-roll |
| Run wants a specific path without being told to | Refused: `--path` is user-directed only |
| Unknown `--path` id or unexpected flag | Script exits 2 and rolls nothing |
| Same-day report already exists | Read and append a unique UTC run section; never overwrite |
| Developer child reports success without Host acceptance | Keep `in-progress` |
| Explicit abandonment decision | Set `abandoned` and record decision plus reason |

### 5. Good / Base / Bad Cases

- **Good:** an empty backlog permits fresh research, which rolls its path first, records the roll verbatim, adds no more than five ranked sections, selects one, loads `developer`, and records `done` only after independent checks.
- **Base:** an existing `not-started` record suppresses all fresh peer research and is handed to `developer` alone.
- **Bad:** researching before reading the backlog, choosing a research path instead of rolling it (or re-rolling one that was inconvenient), inventing unavailable product claims, overwriting a same-day report, implementing several records, or trusting the child report as acceptance violates the persistence contract.

### 6. Tests Required

- `spike/verify-skills.ts`: both required built-ins in a project-free scan, load/slash expansion, progressive disclosure, case-insensitive collision isolation, load-bearing workflow language, the backlog/report template contracts, and the path roll — weights imported from the script itself, all twenty half-unit draws mapped exhaustively, out-of-range draws refused, and the CLI's roll/override/exit-2 behaviour.
- `pnpm typecheck`, `pnpm test`, and `pnpm build`; inspect `dist/src/skills/builtin/self-evolution-research/SKILL.md` after build.

### 7. Wrong vs Correct

```text
# WRONG: fresh research while unfinished work exists, then mark child prose complete
read peer docs -> choose several ideas -> child says success -> done

# CORRECT: backlog is the first gate and Host evidence owns completion
read backlog -> select in-progress/not-started (no research) -> load developer -> Host acceptance -> done
```

---

## Scenario: built-in self-reflection

### 1. Scope / Trigger

`/self-reflection` loads a product-bundled Markdown workflow that reviews the session it runs in. The Host locates the current session's trajectory with the skill's bundled locator, delegates the analysis to one headless darwin worker under the `developer` managed-child contract, and independently accepts one reflection document plus append-only backlog sections. It adds no recorder change, no new CLI verb, and no alternate agent loop.

### 2. Signatures

```text
/self-reflection [request]
locate:  node <skill-dir>/scripts/locate-trajectory.mjs [--project <root>] [--session <id>]
         -> project-root/sessions-dir/session/trajectory/selected-by/trajectory-mtime/last-user-input/closed-through-turn/closed-through-seq/other-recent-sessions
subject: ~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl through the printed closed seq (read-only)
output:  docs/reflections/reflection_<YYYY-MM-DD>_<session-id>.md (template: <skill-dir>/references/reflection-template.md)
backlog: docs/research/backlog_index.md -> docs/research/backlog/directions-NNN-NNN.md
         (append-only `SRF-NNN` sections, status not-started; index route only on rollover)
```

### 3. Contracts

- The locator runs **before** the child is launched (the child is itself a session in the same project and would otherwise be selected), mutates nothing, and its `last-user-input:` preview must be recognizably this conversation before the id is trusted. It prints the latest valid `turnEnded` as the inclusive `closed-through-turn:` / `closed-through-seq:` cutoff. `--session` is strict: a missing id is a refusal, never a fallback. No trajectory or no closed turn exits non-zero — there is nothing complete to reflect on.
- The child follows the `developer` managed-child contract unchanged (`bash` `start` mode, `--yolo --context-offload`, drained output, `session:`/`usage:` stderr capture, `-` stays unknown) and must not load `developer`, `self-evolution-research`, or `self-reflection`, start another darwin, or delegate again.
- The record is evidence, never a participant: the child never rewrites, repairs, or appends to the trajectory. The prompt carries the exact closed turn/seq; the child verifies that boundary is the matching `turnEnded`, discards every later record even when replay prints it, and limits summaries, grading, citations, timing and spend to `seq <= closed-through-seq`. The document states the actual inclusive bounded `seq`/turn range and keeps unknown spend metrics unknown, never 0.
- The reflection document follows the bundled template exactly: one grade from the four-level rubric (Perfect/High/Medium/Low) justified by turn/`seq` citations, process observations, findings each with evidence and a concrete darwin-side suggestion, and the `self-evolution-research` scoring (`Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk`, gate 6) applied to every suggestion.
- Backlog integration is append-only: after reading the thin index and searching routed metadata for duplicates/next IDs/priorities, accepted directions become complete `not-started` sections with fresh `SRF-NNN` ids and the reflection document as origin report. Rejected/duplicate directions stay in the document with their scores; existing sections are never edited. A full page rolls to the next zero-padded 20-priority page and appends exactly one index route. The next `self-evolution-research` run selects `SRF` sections through its normal batch rules — the reflection run never implements them.
- Mutation scope is exactly the one reflection file plus appended sections in the current/new backlog page and, only on rollover, one appended index route; no commit without explicit user authorization.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Default-selection preview does not match this conversation | Stop and ask; never reflect on another session |
| User names a past session with `--session <id>` | That session is the subject; preview echoed for confirmation, not matched against this conversation |
| `--session <id>` names a session with no trajectory | Refuse with the exact id; never fall back to newest |
| Selected current or named trajectory has no `turnEnded` | Locator exits non-zero with no subject block; never grade the open request or fall back |
| Selected trajectory has records after its latest `turnEnded` | Print that latest closed turn/seq and exclude the later open tail from every child judgement |
| Project has no trajectory at all (`trajectory: false`) | Locator exits non-zero; report "nothing to reflect on" |
| Output file already exists | Refuse to overwrite |
| A suggestion scores below the gate | Recorded in the document as rejected with its score; not added to the backlog |
| A suggestion duplicates an existing backlog record (any status) | Not re-proposed; noted as a duplicate |
| Backlog diff edits/reorders existing sections, changes the index except for one rollover route, or exceeds a page range/capacity | Acceptance failure — send a focused correction to the same child session |
| Unknown spend metric | Stays `unknown`, never 0 |

### 5. Good / Base / Bad Cases

- **Good:** locator pins this session and the preview matches; one child writes the templated document, appends two above-gate `SRF` sections, and the Host verifies path, sections, score arithmetic, and append-only diff before reporting.
- **Base:** a smooth session yields the grade with citations and zero new directions — "nothing to improve" is a valid, recorded outcome.
- **Bad:** analysing the trajectory in the Host, reflecting on the newest-by-mtime session without checking the preview, rewriting the record, editing existing backlog sections, or letting the reflection run start implementing its own suggestions.

### 6. Tests Required

- `spike/verify-skills.ts`: `/self-reflection` expansion, locate-before-launch and closed-cutoff handoff language, the managed-child and no-recursion language, read-only record handling, the exact output path and template reference, the four-level rubric, the score formula and gate, and the append-only `SRF` backlog contract.
- `spike/verify-self-reflection.ts`: normal current-session open-tail selection, authoritative explicit past selection, no-closed-turn and missing-id refusals, exact turn/seq cutoff output, and byte-zero trajectory/session-state behavior.
- `pnpm typecheck`, `pnpm test`, and `pnpm build`; inspect `dist/src/skills/builtin/self-reflection/` (SKILL.md, `scripts/locate-trajectory.mjs`, `references/reflection-template.md`) after build.
- `spike/verify-tui.ts completion` (free): the loaded-skills count includes the third built-in.

### 7. Wrong vs Correct

```text
# WRONG: reflect on whatever session is newest, in the Host, and edit the backlog in place
launch child -> locate (selects the child) -> Host writes the reflection -> rewrite backlog sections

# CORRECT: locate first, verify the preview and closed cutoff, delegate, accept append-only artifacts
locate + verify preview/cutoff -> pass closed turn/seq to bash-started child -> child writes doc + appends SRF sections -> Host verifies path/template/scores/diff
```

## Prompt Caching

`src/agent/prompt-cache.ts` decides *whether* to cache; the SDK does the placing.
(Verified offline: `spike/verify-prompt-cache.ts`, 35 assertions. Verified live against
Bedrock: `spike/verify-prompt-cache-live.ts` — 11,737 tokens written on turn one, the same
11,737 read on turn two against 3 uncached input tokens.)

### Contract: three cache points, two mechanisms

| Part | How | Notes |
|---|---|---|
| tool schemas | `BedrockModel({ cacheConfig: { strategy: 'auto' } })` | cache point appended after `toolConfig.tools` |
| conversation | same `cacheConfig` | cache point moved to the last user message each request; the SDK strips any earlier ones |
| system prompt | explicit text blocks + final `CachePointBlock` | working context/cache prepared after initialize; official catalogue reordered before every model call |

Since SDK 1.16.0 `AnthropicModelConfig` has a `cacheConfig` of the shared root `CacheConfig` shape
(`ttl`, `toolsTTL`, `systemPromptTTL`, `messagesTTL`; `strategy` is ignored because every active
Claude model caches). `anthropicCacheConfig(plan)` hands it only the shared `ttl` (sections default
to on), so the `anthropic` provider caches tools, system prompt and last user message on one
lifetime — the same three parts as Bedrock — and `planPromptCache` reports exactly those. The
hand-placed system-prompt `CachePointBlock` stays: the SDK honours it and fills a missing TTL
from `cacheConfig.ttl`. Live proof: `spike/verify-anthropic-live.ts` asserts turn 1 writes/reads
and turn 2 (one call, longer history) reads more than any turn-1 call while sending < 400 uncached
input tokens; measured 2026-09-02 through a CloudFront relay: turn 1 input 6 / write 6,115 / read
16,883 over four calls, turn 2 input 3 / write 91 / read 6,115 (1.12.0 re-sent 836 → 1,344 → 1,867
uncached tokens over three turns). Darwin adds no cache points for OpenAI because OpenAI prompt caching
is provider-managed and automatic; the cache plan records that automatic state so the header,
`/status`, and `/model` say `auto` rather than `off`, without reporting an unsupported-provider warning.

### Contract: the final system cache point is prepared after initialize and repaired per invocation

Session restore occurs during initialize, so Darwin refreshes working context and replaces the
final cache point afterwards. Official AgentSkills supports block arrays but injects
`<available_skills>` on every BeforeInvocationEvent; without adaptation it appends after an
existing cache point. Darwin registers its ordering hook after the official callback, moving the
one official catalogue block ahead of working context/cache before each actual model request.
First, repeated and resumed requests are measured in `spike/verify-agent-skills.ts`; assertions on
post-create strings alone are insufficient because official injection has not happened yet.

### Contract: never hand `strategy: 'auto'` to a model that cannot cache

The SDK resolves `auto` by matching the model id against `anthropic`/`claude` and, on a miss,
`logger.warn`s — the default logger writes straight to `console.warn`, which garbles the Ink
frame. Decide support before constructing the model and omit `cacheConfig` entirely.

### Contract: a running token total comes off `agent.metrics`, not off the event stream

`Agent.metrics` is a public getter over the SDK's meter and holds the same lifetime
`accumulatedUsage` that `AgentResult.metrics` carries — readable at any time, including while
idle. `accumulateUsage()` sums all four counters (`inputTokens`, `outputTokens`,
`cacheReadInputTokens`, `cacheWriteInputTokens`), with the two cache counters staying
`undefined` until a provider reports them. Preserve that distinction: `undefined` means “not
reported,” while `0` is a provider-reported measurement. Bedrock and Anthropic retain Darwin's
historic numeric-zero display; provider/API paths without a verified metric show `not
reported` rather than inventing zero. Prefer the getter over tallying `agentResultEvent`: a
cancelled turn may never emit one. What it cannot tell you is a resumed session's earlier spend
— session snapshots persist messages, not metrics, so the meter starts at zero on every
process (`AgentRuntime.usage`, surfaced by `/usage`, says "this run" for exactly that reason).

### Contract: OpenAI Responses reports both cache reads and writes

The OpenAI Responses usage schema, including Bedrock Mantle's implementation, puts cache
activity under `usage.input_tokens_details`: `cached_tokens` is the input read from cache and
`cache_write_tokens` is the input written to cache. Both fields may legitimately be zero.

`@strands-agents/sdk@1.12.0` maps only `cached_tokens`, and published `1.13.0` has the same
omission. The tracked pnpm patch in `patches/@strands-agents__sdk@1.16.0.patch` maps both fields
to `cacheReadInputTokens` / `cacheWriteInputTokens` using presence-aware non-negative checks.
`spike/verify-usage.ts` drives the real `OpenAIModel` Responses adapter with a fake stream and
proves both values reach `Agent.metrics` without a model or network call. Keep the patch until
an installed upstream release maps both fields; removing it earlier makes `/usage` silently
under-report GPT cache writes.

### Contract: headless usage fields are mutually exclusive cost buckets

The machine-readable `usage:` record normalizes provider-native counters before a `/developer`
Host aggregates them. `input` means uncached input; `cacheRead`, `cacheWrite`, and `output` are
separate buckets that may have different provider rates. Bedrock and Anthropic already report
cache activity beside `inputTokens`. OpenAI Responses reports both cache counters as subsets of
`input_tokens`, so its normalized input is
`max(0, inputTokens - cacheReadInputTokens - cacheWriteInputTokens)` when both subsets are
reported. The TUI and headless paths must use the same provider-aware projection. An unreported
cache field remains `-` in the stderr record; when that absence prevents an exact Responses split,
`input` is `-` too. Do not turn absence into a measured zero. Keep the field order and anchored
regex stable for the built-in developer workflow.

Read *during* a turn, the getter returns the totals from before it: the meter accumulates a
model call when that call finishes, so a report asked for mid-stream shows the same numbers as
the one asked for just before (measured in `spike/verify-tui.ts usage`, which reads the meter
while a 60-line answer is still streaming). Anything that shows these numbers while a turn is
in flight has to say so — an unchanged counter next to a visibly working agent reads as broken.

### Contract: a serialized `AgentResult` carries no metrics, but its last message does

Measured on `@strands-agents/sdk@1.12.0`, on a real recorded `trajectory.jsonl` and re-asserted
offline in `spike/verify-trajectory.ts`:

- `AgentResult.toJSON()` returns `type`, `stopReason`, `lastMessage` (plus `structuredOutput` /
  `checkpoint` when present) and **deliberately excludes `metrics` and `traces`** — the SDK's own
  comment gives the reason: not sending large payloads over the wire. So anything that persists a
  serialized `agentResultEvent` gets **no** token counts from `result.metrics`, and never will.
- `Message.toJSON()` **keeps** `metadata`, and the agent attaches the model call's usage there. So a
  serialized result does carry `lastMessage.metadata.usage` — the counters of the **final model call**
  of that invocation, with `metrics.latencyMs` beside them. It is *not* the turn's total: a turn with
  a tool cycle has earlier calls whose usage is only in the meter.
- Therefore a **turn-scoped** number can only come from `Agent.metrics` (see the contract above), read
  as a delta — which is what `startTurnSpend` does and what `turnEnded.spend` stores. A turn that
  throws or is cancelled emits no `agentResultEvent` at all, so for those the meter is the *only*
  source.
- The meter is updated in `Agent._invokeModel` immediately after each model call returns
  (`_meter.updateCycle(result.metadata)`), and not at all for a call that threw. Two consequences to
  rely on: the meter is final by the time a turn's stream ends (so reading it while the turn's closing
  record is composed is exact), and a rejected request contributes nothing (so a turn that failed
  before any call completed is honestly `0`, not unknown).
- **Summarization bypasses the meter.** `SummarizingConversationManager` (and the agentic context
  mode) call `generateSummary` → `model.streamAggregated` **directly**, not through
  `Agent._invokeModel`, so a `/compact` or an overflow reduction spends tokens that appear in neither
  `Agent.metrics` nor `turnEnded.spend`. Anything that presents these numbers must mean "what the
  meter attributed", not "what the provider billed".

### Gotchas

- `AgentResult.metrics.accumulatedUsage` accumulates over the agent's **lifetime**, not per
  turn: read cache tokens as a delta between turns or the second turn appears to double.
- `Agent.stream()` does not re-emit the provider's `modelMetadataEvent`; usage reaches a consumer of
  the agent stream on `agentResultEvent`, and only as the final call's `lastMessage.metadata.usage`
  (see the contract above) — `result.metrics` is dropped by serialization.
- Cache entries live 5 minutes, so a byte-identical prefix is still warm across two runs of a
  test — the live spike puts a nonce in its padded AGENTS.md so the first turn really writes.
- Bedrock requires cache-point TTLs to be **non-increasing** across tools → system → messages;
  `promptCacheTtl` is stamped identically on all three for exactly that reason.

---

## Thinking Effort (adaptive thinking)

`src/agent/thinking.ts` decides which effort level to ask for; the provider does the
thinking. (Verified offline: `spike/verify-thinking.ts`, 55 assertions. Verified live against
Bedrock: `spike/verify-thinking-live.ts`, 28 assertions — including the acceptance matrix
below, re-measured per run.)

### Contract: `effort` goes in its own `output_config`, never inside `thinking`

```typescript
// Wrong: a ValidationException, not a warning.
additionalRequestFields: { thinking: { type: 'adaptive', effort: 'high' } }
// Correct:
additionalRequestFields: { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }
```

Same two keys reach the native Anthropic API through `AnthropicModelConfig.params`, which the
provider merges into the request body verbatim. OpenAI's equivalent is a flat
`params: { reasoning_effort }` with no `xhigh`/`max`.

### Contract: always `adaptive`, never `enabled` + `budget_tokens`

`thinking.type: 'enabled'` is deprecated on Claude 4.6 and rejected outright by the
Mythos/Fable/Opus-4.7 tier. It also matters for caching: switching *between* thinking modes
invalidates the conversation cache breakpoint, while adaptive → adaptive does not — which is
what makes a mid-session `/effort` free. System prompt and tool caches survive either way.

### Contract: the acceptance matrix is measured, not documented

The AWS page says `xhigh` **and** `max` are Opus-only. Measured in us-west-2:

| model | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| `claude-sonnet-4-6` | ok | ok | ok | **rejected** | ok |
| `claude-opus-5` | ok | ok | ok | ok | ok |
| `claude-sonnet-4-5` and earlier | rejected — the whole `output_config` object is refused | | | | |

Rejection messages: `output_config.effort: Input should be 'low', 'medium', 'high' or 'max'`
for `xhigh` on Sonnet 4.6; `output_config.effort: Extra inputs are not permitted` for anything
pre-4.6. Both are per-request, so an unsupported level breaks **every** turn — which is why
`planThinking` clamps to the highest usable level (downwards: `xhigh` → `high`, never up to
`max`, since asking for more depth than the user did is a bill they did not agree to) and
reports the clamp instead of doing it silently.

### Contract: `Model.updateConfig()` merges, so effort is changeable mid-session

`updateConfig` is on the abstract `Model` base and implemented as
`this._config = { ...this._config, ...modelConfig }` — so writing `additionalRequestFields`
leaves `modelId`, `maxTokens` and `cacheConfig` intact, and writing `undefined` clears the key
(`_getAdditionalRequestFields` tests it for falsiness). No agent rebuild, no lost conversation.
The provider-specific keys are not on `BaseModelConfig`, so the one cast lives in `config.ts`,
the only file that names a provider.

### Gotchas

- The SDK strips `thinking` from `additionalRequestFields` when `toolChoice` forces tool use
  (`bedrock.js:_getAdditionalRequestFields`) — Bedrock refuses that combination. Nothing to do,
  but do not "fix" it.
- Adaptive thinking implicitly enables interleaved thinking, so reasoning arrives *between*
  tool calls, not just before the first answer.
- Whether the model thinks at a given level is its own judgement: at `low` it skips thinking on
  easy prompts (measured — `low` answered a logic puzzle with no reasoning block, `high`
  reasoned first). Only `high` and above are documented as "always thinks", so that is the only
  level whose reasoning the live spike asserts.

## Bedrock Mantle (`openai.*` models without an API key)

`OpenAIModel` accepts `bedrockMantleConfig: { region }`, which routes the OpenAI client at
Bedrock's OpenAI-compatible endpoint and mints a bearer token per request from the standard AWS
credential chain (`@aws/bedrock-token-generator`, an optional peer dep). darwin exposes it as
`bedrockMantle: true` on `provider: "openai"`, reusing the existing `region` field.

Proven by `spike/verify-mantle-live.ts` (7 assertions: tool calls, multi-turn context, live
`/effort`) and `spike/probe-mantle-catalog.ts` (lists the real per-region catalog).

### Contract: `bedrockMantle` replaces the credential, never joins it

The SDK throws if `bedrockMantleConfig` arrives alongside `apiKey`, `clientConfig.apiKey` or
`clientConfig.baseURL`. `config.ts` rejects `bedrockMantle` + `apiKeyEnv` at load time instead,
so the error names the file and the two keys rather than surfacing as a bare `Error`.

### Contract: the Mantle catalog is per-region and is not Bedrock's catalog

`aws bedrock list-foundation-models` does **not** list Mantle models. Measured 2026-08-14 via
`GET https://bedrock-mantle.<region>.api.aws/v1/models`:

| region | `openai.gpt-5.6-sol` | `openai.gpt-5.6-terra` / `-luna` | `openai.gpt-5.5` |
|---|---|---|---|
| us-east-1 | present | present | present |
| us-west-2 | **absent** | present | absent |

A wrong region fails as `404 The model '<id>' does not exist` — naming the model, never the
region, which is why `createOpenAIModel` resolves the region itself rather than leaving it to
the SDK's env lookup. Note the models list lives on `/v1` even for ids whose *inference* is on
`/openai/v1` (the SDK's `OPENAI_PATH_MODEL_PREFIXES` routes `openai.gpt-5.` to the latter).

### Contract: api mode is per-model, and `openai.gpt-5.6-*` requires `responses`

`openai.gpt-5.6-sol` answers `400 The model 'openai.gpt-5.6-sol' does not support the
'/v1/chat/completions' API`. `openai.gpt-oss-*` is the opposite. So the mode cannot be inferred
from the provider or the transport — hence the `openaiApi` config key, defaulting to `chat` to
keep the pre-existing native-OpenAI path unchanged. Only the *stateless* Responses form is used:
`stateful: true` cannot coexist with a `conversationManager`, and darwin always installs one.

### Contract: reasoning effort is spelled differently per api mode

Measured against `openai.gpt-5.6-sol`, us-east-1, Responses API:

| field | low | medium | high | xhigh | max |
|---|---|---|---|---|---|
| `reasoning: { effort }` | ok | ok | ok | ok | ok |
| `reasoning_effort` (flat) | `400 Unknown parameter: 'reasoning_effort'` — every level | | | | |

Two consequences. `openaiThinkingParams` takes the api mode and emits the nested shape for
`responses`, the flat one for `chat`. And the `high` clamp that exists for native OpenAI is
lifted when `bedrockMantle` is set, because the whole ladder was measured to work — clamping
anyway would quietly think less than the user asked for.

### Gotcha: effort is billed but never displayed

No `reasoningContentDelta` ever reaches the stream on this pathway — not at any effort level,
and not with `reasoning.summary` set to `auto` or `detailed`. The TUI therefore shows no
thinking for Mantle models even at `max`. Darwin adds no explicit cache points for
`provider: 'openai'`; any prompt caching is automatic and provider-managed.

## Config: the `models` array

`.darwin/config.json` accepts two forms. The single-model form (model keys at the root) still
works unchanged. The array form lists several configurations and switches one on:

```json
{
  "permissionMode": "yolo",
  "models": [
    { "enable": true,  "provider": "openai",  "model": "openai.gpt-5.6-sol",
      "bedrockMantle": true, "openaiApi": "responses", "region": "us-east-1", "maxTokens": 64000 },
    { "enable": false, "provider": "bedrock", "model": "global.anthropic.claude-opus-5",
      "maxTokens": 64000 }
  ]
}
```

### Contract: the array is a file format, not a second runtime shape

`loadConfig` resolves the enabled entry and returns the same flat `AppConfig` the single-model
form produces. That is what keeps the five consumers (`createModelFromConfig`, `planThinking`,
`planPromptCache`, the TUI header, the safety classifier) untouched by the feature — none of them
can tell which form was used. `AppConfig` is now `ModelFields & SessionFields`, and both forms go
through the *same* `validateModelFields`, so the array form cannot drift into a weaker dialect
that accepts different keys.

### Contract: exactly one `enable: true`, and `enable` defaults to false

Zero enabled and two enabled are both `ConfigError`. "First enabled wins" was rejected: this
codebase refuses silent choices, and here the silent choice has a bill attached. `enable` is
absent-means-off, so adding an entry never activates it by accident; the zero-enabled message
lists the candidate model ids so the fix is one edit.

### Contract: model keys and session keys may not cross

With `models` present, a model key at the root (`MODEL_KEYS`) and a session key inside an entry
(`SESSION_KEYS`) are both refused, by name, with the direction to move it. There is no precedence
rule to fall back on, and the alternative — ignoring the misplaced key — means a
`permissionMode` written in an entry silently does nothing, which is a security surprise.

### Contract: `/effort` persists into the enabled entry

`thinkingEffort` is model-scoped (the levels one model accepts are not the levels another does),
so `saveThinkingEffort` writes into the enabled entry, reusing the loader's own
`selectEnabledModel` so the write cannot land on a different entry than the session is running.
Writing it to the root instead would make the *next* load fail as a stray model key — a
convenience that bricks the config.

## `/model`: switching model mid-session

### Contract: `Agent.model` is a mutable property, so the conversation survives

`Agent.model` is declared `model: Model` — not readonly — and reassigning it is the whole
mechanism behind `/model`. No agent rebuild, so `agent.messages`, the session file, the tools,
the plugins and the permission gate all stay as they were. `AgentRuntime.changeModel` builds the
new model *before* it assigns anything, so a failure (missing peer dep, bad region) leaves the
session on the model it was already using.

### Contract: a conversation crosses providers, and reasoning blocks are dropped not rejected

Measured in both directions between `global.anthropic.claude-opus-5` and `openai.gpt-5.6-sol`
(`spike/probe-model-switch.ts`, and end-to-end in `spike/verify-model-command.ts --live`): a
history containing `toolUseBlock`/`toolResultBlock` pairs is translated fine, and the model after
the switch can quote a fact only the pre-switch turn established.

The one wrinkle is Claude's `reasoningBlock`. The Responses adapter logs
`block_type=<reasoningBlock> | reasoning content is not yet supported in multi-turn conversations
with the responses api` and **skips the block** — the request still succeeds. A darwin-placed
system-prompt `CachePointBlock` is likewise ignored by a provider that cannot cache, so a stale
cache point costs nothing.

### Contract: SDK warnings must be routed off the console before they can happen

The SDK's default logger writes `warn`/`error` straight to `console`
(`logging/logger.js`), which tears the Ink frame — the same hazard as the prompt-cache
`strategy: 'auto'` warning. The reasoning-block warning above is unavoidable *and* correct, and it
repeats once per request, so `src/agent/sdk-logging.ts` uses the SDK's official
`configureLogging()` hook to turn SDK logs into transcript notices. `debug`/`info` stay no-ops,
matching the SDK default — unless the opt-in diagnostics tap is installed, which is the section
below.

### Contract: a switch rebuilds the config from the session up, never by spreading

`withModelChoice` copies the session half through `SESSION_KEYS` and then applies the new entry's
fields. Spreading the new fields over the old config would leave the *previous* model's optional
keys behind — switching away from a Mantle entry would keep its `region` and `openaiApi` and
configure the new model with the old one's transport. `verify-model-command.ts --live` asserts the
region is the new entry's (`us-east-1`), not the one it switched away from.

### Contract: the thinking and cache plans are recomputed, and the header reads them live

Effort clamping is per-model and caching is per-provider, so both plans are recomputed on switch
and reported in the `/model` notice. The header reads `runtime.config` / `runtime.promptCache`
rather than the `RuntimeInfo` snapshot, which is fixed at startup.

### Contract: the first built-in-catalogue switch materializes configuration

With no `~/.darwin/config.json`, `/model` offers `DEFAULT_MODELS`; persisting the first switch
writes that exact catalogue as a `models` array with one explicit `enable: true`, so a new
installation keeps its selection after restart. A present flat or empty config remains explicit
user input and is refused rather than silently converted into a different configuration shape.

### Contract: an all-digits `/model` argument is only ever a position

`resolveModelChoice` accepts a 1-based position, an exact name, or a unique substring of the name
or model id — but a numeric argument never falls through to substring matching. It did in the
first draft, and the test caught `/model 4` silently selecting `claude-sonnet-4-6` because its id
contains a `4`. An ambiguous substring returns `'ambiguous'` rather than the first hit.

`/model` is handled *after* the busy check in `App.tsx`, unlike `/effort`: `/effort` reconfigures
the live model, while this replaces the model object, which would change the model under a turn
that is already streaming from it.

## The SDK logger (what darwin measured to tap it)

Darwin's opt-in diagnostics log is `.trellis/spec/backend/session-diagnostics.md`; what follows is
only what was measured about the SDK to make it possible. All of it is asserted by
`spike/verify-diagnostics.ts`, which makes no model call and no network request.

### Contract: `logger` is one mutable module binding, read at call time

`logging/logger.js` is `export let logger = defaultLogger`, and `configureLogging(custom)` assigns
that binding; every call site does `logger.debug(...)` against the live binding rather than a
captured copy. So one `configureLogging` call re-routes the parent agent, **every subagent**, every
model adapter and every MCP client at once, and a later call replaces the routing wholesale — there
is no per-agent logger and no way to scope one. That is why `src/agent/sdk-logging.ts` is the only
caller in this codebase and composes the renderer sink and the diagnostics tap itself.

### Contract: the SDK's own `debug`/`info` defaults are no-ops, and `warn`/`error` are `console`

`defaultLogger` is `{ debug: () => {}, info: () => {}, warn: console.warn, error: console.error }`.
Darwin's no-tap installation is therefore the SDK's own behaviour for `debug`/`info`, not an extra
suppression — the information was never emitted anywhere, which is exactly why an opt-in channel
had to be built rather than found.

### Contract: the interesting diagnostics are at `debug`, and there are 60 of them

`grep -c 'logger.debug\|logger.info' dist/src` counts 60 call sites on 1.12.0. The ones that answer
questions darwin's users actually ask: `models/bedrock.js:1181` `throttled | error_message=<…>`
(and the same line in `anthropic.js:222`, `openai/model.js:210`, `vercel.js:156`),
`bedrock.js:576`/`:573` cache-point placement, `:279`/`:290`/`:294` native token counting and its
fallbacks, `mcp/client.js:200` tool renames, and
`retry/default-model-retry-strategy.js:77-84` retry scheduling. None of them is available at any
other level: a throttled session that leaves no `debug` output leaves no evidence at all.

### Contract: the intervention registry logs a dispatch only when a handler implements it

`interventions/registry.js:_dispatch` logs `event=<…> | dispatching to N handler(s)` and
`handler=<…>, event=<…> | evaluating` — but it is only *reached* for an event some registered
handler overrides (`handler[method] === InterventionHandler.prototype[method]` is skipped). Darwin's
`PermissionGate` implements `onBeforeToolCall` only, so an offline turn produces these lines when it
calls a tool and none when it does not. That is what makes a scripted **tool-calling** turn the
smallest real source of SDK `debug` output for a test, and it is measured, not assumed:
`verify-diagnostics.ts` asserts the captured line `handler=<darwin:permission-gate>,
event=<beforeToolCall> | evaluating`. Note the event label is `beforeToolCall`, not the method name.

### Contract: `warnOnce` dedupes per message for the whole process

`logging/warn-once.js` keeps a module-level `Set` of messages already warned about, so
`new BedrockModel({})`'s default-model nudge and `Model.estimateUtilization`'s missing-window nudge
each fire exactly **once per process**, whatever logger is installed at the time. Two consequences:
a test may use each one only once (both are used, once each, as the offline source of a *real* SDK
`warn`), and a warning that matters can be missed by a sink installed later in the same process.

## Global and project Darwin state

`src/paths.ts` owns user-global and project-local paths. Config is global, permission rules are
project-keyed user state, sessions and background logs are globally stored per canonical project,
and hooks/resources/MCP merge global plus project layers. Project keys combine a bounded readable
canonical-path slug with SHA-256. Legacy rules/hooks/sessions are fallback migration inputs and
are never rewritten.

### Extension directory layers

Skills, child-agent definitions, commands, and hooks may come from project/global `.agents` as well as `.darwin`, without changing their schemas or SDK execution seams. Named-resource precedence is built-in reservation, project `.darwin`, project `.agents`, global `.darwin`, global `.agents`; validation precedes name claiming. Hook files are direct lexical `hooks/*.json` inputs and fail closed. Pre source order is global `.agents`, global `.darwin`, project `.agents`, project `.darwin`; Post reverses source order. A `.darwin` directory source shadows that layer's legacy `hooks.json` and embedded config hooks visibly.

Skill roots may be symlinks. Resource safety resolves the root and permits nested symlinks only when final targets stay inside that real root, retaining the 200-entry preflight and use-time recheck.

---

## SDK pin — 1.16.0 and the regenerated patch

- `@strands-agents/sdk` is pinned at `1.16.0` with `patches/@strands-agents__sdk@1.16.0.patch`
  (14 files). Regenerated 2026-09-02 from the pristine tarball: 11 of the 1.12.0 hunks applied with
  offsets only; three were re-done by hand — `vended-tools/bash/index.{js,d.ts}` (upstream re-shaped
  the index around a `../shell` split; only the `createBash` re-export is added) and
  `vended-tools/file-editor/file-editor.js` hunk 3 (upstream replaced the regex/tab-expansion
  occurrence count with `findOccurrences()`; the miss advisory now formats on the raw content,
  `verify-file-editor.ts` 63/63 unchanged).
- 1.16.0 lists `@tobilu/qmd` (local search store) as an optional dependency that pulls native builds
  (`better-sqlite3`, `node-llama-cpp`, `tree-sitter-*`). Darwin never imports it, so
  `pnpm-workspace.yaml` names it in `ignoredOptionalDependencies`; without that, `pnpm install`
  fails with `ERR_PNPM_IGNORED_BUILDS`. Do not approve those builds instead.
- API change absorbed: `ToolContext.cancelSignal: AbortSignal` is required. Darwin's own synthetic
  contexts (`src/skills/plugin.ts` slash expansion, the preflight/web-search spikes) pass a signal
  that never aborts; every other context comes from the SDK.
- Upgrade procedure that worked: `pnpm patch <pkg>@<new>` → `patch -p1 < old.patch` inside the edit
  dir → port rejects → `node --check` every patched `.js` → `pnpm patch-commit` → `pnpm typecheck` →
  the six patch-focused suites (`verify-file-editor`, `verify-background-bash`, `verify-compact`,
  `verify-context-offload`, `verify-retry-guard`, `verify-http-request-tool`) → `pnpm test` → free
  pty scenarios → the live cache suites for both Claude providers.

