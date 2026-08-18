# Strands TypeScript SDK Usage Contracts

> Hard-won, tested contracts for `@strands-agents/sdk` (verified on 1.12.0, 2026-08-13).
> Every rule here was validated by a runnable script under `spike/`; when upgrading the
> SDK, re-run the scripts named below before trusting these still hold.

---

## Agent Assembly

Only `src/agent/runtime.ts` constructs the SDK `Agent`. Keep it a thin assembly; all
customization goes through SDK extension points (interventions, plugins, conversation
manager), never by forking the agent loop.

### Contract: `printer: false` is mandatory

The SDK's default printer writes tool banners and streamed text to stdout, which fights
Ink for the terminal. Every `new Agent({...})` in this project must pass `printer: false`.
(Verified: `spike/bedrock-stream.ts`.)

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

### Contract: the vended bash tool keys its persistent shell per `Agent` instance

`vended-tools/bash` holds `sessions: WeakMap<Agent, BashSession>` off `context.agent`. Two
consequences: a new `Agent` always starts with a fresh shell (cwd and exported variables do not
survive `/clear`), and the *old* Agent's shell must be stopped explicitly via
`invoke({ mode: 'restart' })` — the SDK's `beforeExit` reaper never runs, and leaving it costs
~15 s of extra process exit time (measured with `retire()`'s `stopBashSession()` removed).

---

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
cannot be observed from inside. `recordStream` (`src/trajectory/stream.ts`) does
`for await (… of events) { observe; yield }` and `send` delegates to *that*. Measured with a
tee over a real `Agent.stream()`: the consumer receives the **identical event objects**, in the
same order, with nothing added or swallowed; a consumer that `break`s early still closes the
underlying stream and still reaches the wrapper's `finally`. Keep the observation synchronous —
an `await` between receiving an event and yielding it would change turn timing, and a throw
there would become a second way for a turn to fail.

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
registry.sourceFor(agentId): SubagentDispatchSource | undefined
runtime.listSubagentDispatches() / runtime.subscribeToSubagentDispatches(listener)
shortDispatchId(toolUseId: string | undefined): string   // pure, id shown everywhere
```

Project definitions are direct `.darwin/agents/*.md` files. Frontmatter requires `name` and
`description`, accepts optional `tools: string[]`, and the non-empty Markdown body is the child
system prompt. `general` is built in and reserved. Dispatch states are
`running | succeeded | failed | cancelled`.

### 3. Contracts

- Every dispatch constructs a new model and Agent. No `SessionManager`, parent messages,
  conversation summary, or `subagent` tool reaches the child.
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
- Records hold agent name, task text, state and timestamps only. Observability must never become
  a second path for child transcript to reach the parent — bound the task at presentation time,
  never store anything the child produced.

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

## Scenario: session-owned background bash jobs

### 1. Scope / Trigger

Use this contract when a long shell command must outlive one agent turn but never outlive
darwin itself. Background work extends the existing `bash` tool; it is not a second tool or
a durable scheduler.

### 2. Signatures

```typescript
bash({ mode: 'start', command: string }): Promise<{
  taskId: string; pid: number; outputPath: string
}>
bash({ mode: 'list' }): Promise<BackgroundTaskStatus[]>
bash({ mode: 'status', taskId: string }): Promise<BackgroundTaskStatus>
bash({ mode: 'output', taskId: string }): Promise<{
  taskId: string; output: string; startOffset: number; endOffset: number;
  hasMore: boolean; outputPath: string
}>
bash({ mode: 'stop', taskId: string }): Promise<BackgroundTaskStatus>
new BackgroundBashManager(projectRoot, sessionId)
```

Foreground `{ mode: 'execute'|'restart', ... }` keeps the SDK-vended signature and return
values. Background states are `running | succeeded | failed | stopped`.

### 3. Contracts

- Runtime creates one manager and one wrapped `bash` tool. Main and child agents share the
  manager/task ids, while foreground calls delegate to SDK `bash.invoke(input, context)` so
  the SDK still keys persistent shells by the calling Agent.
- `start` spawns `/bin/bash -lc <command>` at project root with inherited environment,
  `detached: true`, and combined stdout/stderr at
  `.darwin/sessions/<sessionId>/background/<taskId>.log`. It resolves after the OS `spawn`
  event, not process completion.
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
  `stop`, and `restart` are safe lifecycle calls. Existing Pre/Post hooks see each immediate outer
  `bash` call, not eventual background completion.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Blank `start.command` / malformed mode payload | Zod tool error; spawn nothing |
| Invalid or unknown `taskId` | Clear error; never read or signal another path/process |
| Log deleted/unreadable | Status keeps process metadata with `outputBytes: null`; output errors with the owned path |
| Spawn fails | Reject start, close the parent log handle, kill/register-clean any exposed group |
| Repeated/concurrent output | Serialized, disjoint cursor ranges |
| Repeated/concurrent stop | Share one termination operation and stable terminal state |
| Descendant ignores SIGTERM | Escalate to group SIGKILL within the bounded deadline |
| Shutdown races launch setup | Launch rejects before spawn or becomes visible and is stopped |
| Bounded cleanup cannot confirm disappearance | Keep group registered for synchronous exit cleanup |
| Child finishes after `start` | Child foreground `restart` must not stop manager-owned work |
| `list` carries `command`, `timeout`, or `taskId` | Zod tool error; do not reinterpret it as another mode |
| Terminal listener throws/rejects | Continue notifying other listeners; process state/cleanup remains authoritative |
| Terminal log snapshot cannot open/stat/close | Notify once with `outputBytes: null`; no unhandled rejection |


### 5. Good / Base / Bad Cases

- **Good:** a child starts a dev server, the parent lists it without knowing its id, and a
  mounted observer receives exactly one terminal snapshot before later output inspection.
- **Base:** an empty manager lists `[]`; `execute` and `restart` flow unchanged through the SDK
  persistent shell.
- **Bad:** polling status in each consumer duplicates transition logic; notifying from both
  `close` and `stop` duplicates events; shell `&`, dropping the `ChildProcess`, or killing only
  the leader creates orphan descendants; persisting task metadata falsely promises resumable
  process control.

### 6. Tests Required

- `spike/verify-background-bash.ts`: foreground delegation/per-Agent persistence, real
  subagent sharing, permission modes/rules/hooks, empty/ordered list snapshots, exactly-once
  success/failure/stop events, unsubscribe/listener/log-snapshot failure isolation, delayed
  combined output, split-UTF-8 reads, TERM→KILL stop, launch/shutdown races, and bounded cleanup.
- `spike/probe-background-bash-exit.ts`: direct exit, normal shutdown, CLI-style forced
  exit, SIGINT, and SIGTERM with SDK bash signal handlers loaded; leader and descendant must
  both disappear within deadlines.
- Run `pnpm typecheck`, `pnpm test`, and the PTY `bashExit` scenario when model access is
  available.

### 7. Wrong vs Correct

```typescript
// WRONG: bypasses the tool boundary and owns only the shell leader.
spawn('/bin/bash', ['-lc', `${command} &`])
child.kill('SIGTERM')

// CORRECT: one wrapped bash tool, shared manager, process-group ownership and events.
const backgroundBash = new BackgroundBashManager(projectRoot, sessionId)
const bash = createBackgroundBashTool(backgroundBash)
const unsubscribe = backgroundBash.subscribe(renderTerminalTask)
const tasks = await backgroundBash.list()
process.kill(-tasks[0].pid, 'SIGTERM')
unsubscribe()
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
- Token usage lives at `result.lastMessage.toJSON().metadata.usage`, not
  `result.metrics` (which serialization drops — see "a serialized `AgentResult` carries
  no metrics" under Prompt Caching / usage below).

---

## MCP

- `McpClient.loadServers()` natively reads Claude Code's `.mcp.json` (it unwraps
  `mcpServers`, interpolates `${VAR}`, picks stdio/streamable-http/sse from the entry
  shape). Do not hand-roll config parsing; `src/mcp/registry.ts` only adds
  "missing file = no MCP" and `continueOnError: true`.
- A failed server (bad command, unset `${VAR}`) is skipped, not fatal: `listTools()`
  returns `[]` for it. Deliberate trade-off; the header's server count is the only signal.
- stdio servers are child processes — `disconnectAll()` must run on every exit path.
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
  [--continue|--resume|--session <id>]
  [--permission-mode default|auto|plan|yolo|--yolo]
  [--max-model-calls <positive integer>] [--context-offload] [--compact-before]

darwin trajectory <list|search|replay|fork> …    (no model call, no network)

stderr: ^session: ([a-z0-9_-]+)$
stderr: ^permission-mode: (default|auto|plan|yolo)$
stderr: ^trajectory: .+$          (only when recording degraded)
exit: 0 success; 1 runtime/turn/persistence/cleanup/interruption; 2 CLI usage
```

`--session` is strict and names an existing project-local snapshot. It takes precedence over
`--continue`/`--resume`; `--continue` follows `.darwin/last-session.json` and retains the existing
fresh-session fallback when no usable pointer exists.

The `trajectory` subcommand is routed on `argv[0]` before `parseCliArgs` runs and has its own
parser (`src/cli-trajectory.ts`), so `CliOptions` keeps exactly the shape every existing
assertion in `spike/verify-headless.ts` deep-equals. Its exit codes follow the same convention:
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
- The three token-efficiency controls are headless-only and opt-in. `--max-model-calls` installs a
  `BeforeModelCallEvent` hook that throws before provider call `limit + 1`; each process gets a fresh
  count. `--context-offload` enables the existing session-scoped ContextOffloader without changing
  loaded/persisted config. `--compact-before` runs the existing reversible `AgentRuntime.compact()`
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
isolation, usage exit status, and no ANSI/stdout leakage. Also run a built-CLI SIGINT probe that
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
  repeatedly, until one rolling summary plus configured `preserveRecentMessages` remain.
  The configured manager attached to `Agent` remains unchanged for reactive overflow recovery.
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

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| `messages.length <= preserveRecentMessages + 1` | No model/count/storage call; `compacted: false` |
| SDK `reduce` returns `false` before any pass | No-op result |
| Summary or token count throws | Restore original live messages; surface failure |
| Latest snapshot or pointer write throws | Restore live messages, best-effort restore latest snapshot, surface failure |
| Estimated summary is larger | Clamp `estimatedTokensSaved` to zero; never claim negative savings |

### 5. Good / Base / Bad Cases

- **Good:** 500-message session becomes one summary plus the recent window, follow-up succeeds,
  and `--resume` restores the compacted list.
- **Base:** conversation already fits the summary-plus-window shape; report no work needed.
- **Bad:** saving the compacted snapshot fails after message mutation; returning success would
  make the current process and resumed process disagree, so the operation rolls back.

### 6. Tests Required

`spike/verify-compact.ts` uses a deterministic `Model` with real SDK Agent, summarizer,
session manager, and local storage. Assert the retained messages are byte-identical, context
counting receives system prompt and tools, an immediate follow-up sees the summary, a fresh
agent restores it, and persistence failure restores every original message. The pty completion
scenario asserts `/compact` is discoverable without spending a model call.

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
/context -> estimated context — ~N tokens · P% of W window · M message(s)
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
- Developer commands enable process-only context offload but no model-call budget by default; the
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
backlog: docs/research/backlog_index.md
report:  docs/research/research_<YYYY-MM-DD>.md
roll:    node <skill-dir>/scripts/roll-research-path.mjs [--path <id>]
         -> research-path/focus/share/draw/path-source/rolled-at/weights
handoff: load_skill({ name: "developer" })
```

### 3. Contracts

- Read `docs/research/backlog_index.md` before consulting any product-research source.
- Valid states are exactly `not-started`, `in-progress`, `done`, and `abandoned`. Select the highest-priority `in-progress` row first, otherwise `not-started`; while either exists, perform no fresh product research.
- Fresh runs roll the path exactly once, before reading any source, on weights `tui=2 observability=0.5 sdk=1 open=1.5 peer=5` (20% tui, 15% open, 10% sdk, 5% observability, 50% peer). The script's verbatim output is recorded in the report; a re-roll is forbidden and `--path` is user-directed only, printing `path-source: override (user-directed)` so a directed run can never read as chance. The draw runs over half-units (`DRAW_UNITS_PER_WEIGHT = 2`, `TOTAL_DRAW_UNITS = 20`) rather than over the weights, so a half weight becomes a proportional integer range instead of a rounded one — the documented share is the implemented share, a weight that is not a whole half throws at load, and an out-of-range draw throws rather than clamping onto the first or last path.
- Every path inspects current Darwin source/architecture first. The `peer` path additionally needs sourced evidence for Claude Code, Codex, DeepSeek harness, PenguinHarness, and at least one further relevant product; a self-review path cites repository paths and symbols instead and states that no peer product was consulted. Missing source access is recorded as a limitation, never filled from model memory, and a peer table is never padded with a product the run did not open.
- A path whose scope turns out to be in good shape is a valid outcome: record it and propose nothing. The roll changes where evidence comes from, never the 1–5 ratings, the score gate, the report file, or the `developer` handoff.
- Append each run to `docs/research/research_<YYYY-MM-DD>.md` under a unique UTC timestamp. Read an existing same-day file first and never overwrite prior runs.
- Propose at most five non-duplicate directions. Rank 1–5 importance, architecture fit, evidence confidence, implementation difficulty, and implementation risk using `2 × importance + fit + confidence − difficulty − risk`, plus qualitative rationale.
- Change one selected row to `in-progress`, load `developer`, and implement exactly that direction. Set `done` only after the Host's independent acceptance; otherwise retain `in-progress` with blockers. `abandoned` requires an explicit recorded reason.
- `REQUIRED_BUILTIN_SKILLS` in `src/skills/loader.ts` is the single required-name list. Both built-ins use ordinary progressive disclosure, slash expansion, collision reservation, and the existing recursive `src/skills/builtin` build copy.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Required built-in asset missing/invalid | Fail startup with its name/path; do not silently remove product capability |
| Optional project/global skill missing/invalid | Preserve existing skip-and-surface behavior |
| Any `in-progress` backlog row | Select by priority; no fresh peer research |
| No `in-progress`, but a `not-started` row | Select by priority; no fresh peer research |
| Named product source unavailable | Record limitation and make no unsupported claim |
| Fresh research with no recorded roll | Unauditable: the report must carry the script's verbatim output before any finding |
| Roll produces an unappealing path | Binding; record every output and use the first, never re-roll |
| Run wants a specific path without being told to | Refused: `--path` is user-directed only |
| Unknown `--path` id or unexpected flag | Script exits 2 and rolls nothing |
| Same-day report already exists | Read and append a unique UTC run section; never overwrite |
| Developer child reports success without Host acceptance | Keep `in-progress` |
| Explicit abandonment decision | Set `abandoned` and record decision plus reason |

### 5. Good / Base / Bad Cases

- **Good:** an empty backlog permits fresh research, which rolls its path first, records the roll verbatim, adds no more than five ranked rows, selects one, loads `developer`, and records `done` only after independent checks.
- **Base:** an existing `not-started` row suppresses all fresh peer research and is handed to `developer` alone.
- **Bad:** researching before reading the backlog, choosing a research path instead of rolling it (or re-rolling one that was inconvenient), inventing unavailable product claims, overwriting a same-day report, implementing several rows, or trusting the child report as acceptance violates the persistence contract.

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

`AnthropicModelConfig` has **no** `cacheConfig`, so the `anthropic` provider gets the system
prompt cache point only. Darwin adds no cache points for OpenAI because OpenAI prompt caching
is provider-managed and automatic; this is not reported as an unsupported-provider warning.

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
omission. The tracked pnpm patch in `patches/@strands-agents__sdk@1.12.0.patch` maps both fields
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
