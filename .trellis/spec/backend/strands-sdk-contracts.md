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
  `result.metrics`.

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

## Scenario: headless one-shot CLI

### 1. Scope / Trigger

`darwin -p <message>` is the non-interactive boundary around the same `AgentRuntime.send()` loop
used by Ink. It exists for scripts: Ink is dynamically imported only on the interactive branch,
stdout is an atomic result channel, and stderr is bounded progress/diagnostics.

### 2. Signatures

```text
darwin -p|--print <message>
  [--continue|--resume|--session <id>]
  [--permission-mode default|auto|plan|yolo|--yolo]

stderr: ^session: ([a-z0-9_-]+)$
stderr: ^permission-mode: (default|auto|plan|yolo)$
exit: 0 success; 1 runtime/turn/persistence/cleanup/interruption; 2 CLI usage
```

`--session` is strict and names an existing project-local snapshot. It takes precedence over
`--continue`/`--resume`; `--continue` follows `.darwin/last-session.json` and retains the existing
fresh-session fallback when no usable pointer exists.

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

## Skills (the one self-built module)

The TS SDK has no Skills support yet ("Skills are not yet available in TypeScript SDK").
`src/skills/` implements the Agent Skills spec as an SDK `Plugin` (same shape as Python's
`AgentSkills`): `getTools()` contributes `load_skill`, `initAgent()` appends the
`<available-skills>` name+description list to the system prompt (progressive disclosure).
When the SDK ships official support, delete the module and swap in theirs.

- `LocalAgent.systemPrompt` is writable and read per model call, so `initAgent()` mutation
  is reliable — but only string prompts; block-array prompts throw (cachePoint ordering).
  The prompt-cache wrapper therefore runs *after* `initialize()`, never before.
- Slash-expanded messages must include "the full text is above, do not call load_skill" or
  the model redundantly loads the skill it was just given.

---

## Scenario: built-in developer supervisor

### 1. Scope / Trigger

`/developer <requirement>` loads a product-bundled skill into the Host's main conversation. The Host supervises external headless darwin invocations through the existing background bash manager; it is not an in-process subagent, scheduler, or fork of `AgentRuntime.send()`.

### 2. Signatures

```text
/developer <delegated requirement>
bash start: darwin -p <planning prompt> --yolo
bash start: darwin -p <approval/correction> --session <captured-id> --yolo
child stderr: ^session: ([a-z0-9_-]+)$
user view: /tasks
```

The built-in source is `src/skills/builtin/developer/SKILL.md`; `pnpm build` must copy it to `dist/src/skills/builtin/developer/SKILL.md` because `tsc` does not copy Markdown assets.

### 3. Contracts

- `scanSkills()` loads built-ins before `<target>/.darwin/skills`, then sorts the merged catalogue. A case-insensitive project collision is skipped and reported; a missing/invalid required built-in fails startup because it is a promised product capability, not optional project configuration.
- Keep the supervisor in the Host conversation: only that conversation can escalate product decisions to the user. The `subagent` tool returns one final report and is the wrong boundary for this dialogue.
- Every child invocation uses `bash start`; retain its `bg-*` id for `status`/`output`. For every task, call `output` at least once and, after terminal status, drain it through `hasMore: false` before reviewing the reply or proceeding; status metadata and `outputBytes` never substitute for the child response. Capture conversational identity only from the exact `session:` stderr record and use explicit `--session` on every follow-up.
- Run each child from the exact target root. The child prompt says it is the direct worker and must not load `developer`, start another darwin, or delegate again; without that guard a built-in skill advertised to both Host and child can recurse.
- Planning is a no-edit first turn, prefixed with `DARWIN_PLANNING_ONLY=1` so target hooks can enforce read-only behavior. Approval/correction is a later turn in the same session and tells the child to proceed without another approval question.
- Every child invocation uses `--yolo` by default because a headless process cannot answer permission prompts. Yolo changes confirmation behavior only: the Host still establishes and enforces the named repository and authorized task scope. The Host independently inspects the diff and runs acceptance checks; failed acceptance returns to the same child session rather than being hidden by a Host edit.
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

- **Good:** one Host turn starts a planning task, exposes it through `/tasks`, captures `session-*`, starts an approved implementation task with that id, then independently verifies the diff and test.
- **Base:** a built-in-only repository expands `/developer` through the ordinary skill path and keeps progressive disclosure.
- **Bad:** using `--continue`, a `bg-*` id, foreground `bash execute`, Host source cwd, or a child prompt that permits recursive developer delegation breaks identity, responsiveness, or target isolation.

### 6. Tests Required

- `spike/verify-skills.ts`: built-in-only discovery/load/slash expansion, progressive disclosure, workflow guard text, deterministic merge, and collision isolation.
- `pnpm build` plus package dry-run: compiled and packed Markdown asset exists.
- `spike/verify-developer-live.ts`: real Host TUI, managed planning + explicit-session implementation turns, `/tasks` during streaming, status/output monitoring, no recursion/cwd drift, independent file/test/diff acceptance, and deadline-bounded exit.
- Keep the live scenario opt-in because it makes real model calls.

### 7. Wrong vs Correct

```text
# WRONG: pointer identity, foreground blocking, and recursive child role
darwin -p "use developer to fix it" --continue

# CORRECT: managed direct-worker turns with distinct process/conversation ids
bash start -> DARWIN_PLANNING_ONLY=1 darwin -p "plan only; do not delegate" --yolo
# parse session: session-123 from output
bash start -> darwin -p "approved; implement now" --session session-123 --yolo
```

---

## Scenario: built-in self-evolution research

### 1. Scope / Trigger

`/self-evolution-research` loads a product-bundled Markdown workflow. It persists peer-product research and ranked iteration state under `docs/research/`, then composes the existing built-in `developer` workflow for exactly one selected implementation. It adds no scheduler, network client, or alternate agent loop.

### 2. Signatures

```text
/self-evolution-research [request]
backlog: docs/research/backlog_index.md
report:  docs/research/research_<YYYY-MM-DD>.md
handoff: load_skill({ name: "developer" })
```

### 3. Contracts

- Read `docs/research/backlog_index.md` before consulting any product-research source.
- Valid states are exactly `未开始`, `进行中`, `完成`, and `放弃`. Select the highest-priority `进行中` row first, otherwise `未开始`; while either exists, perform no fresh product research.
- Fresh runs inspect current Darwin source/architecture and sourced evidence for Claude Code, Codex, DeepSeek harness, PenguinHarness, and at least one additional relevant product. Missing source access is recorded as a limitation, never filled from model memory.
- Append each run to `docs/research/research_<YYYY-MM-DD>.md` under a unique UTC timestamp. Read an existing same-day file first and never overwrite prior runs.
- Propose at most five non-duplicate directions. Rank 1–5 importance, architecture fit, evidence confidence, implementation difficulty, and implementation risk using `2 × importance + fit + confidence − difficulty − risk`, plus qualitative rationale.
- Change one selected row to `进行中`, load `developer`, and implement exactly that direction. Set `完成` only after the Host's independent acceptance; otherwise retain `进行中` with blockers. `放弃` requires an explicit recorded reason.
- `REQUIRED_BUILTIN_SKILLS` in `src/skills/loader.ts` is the single required-name list. Both built-ins use ordinary progressive disclosure, slash expansion, collision reservation, and the existing recursive `src/skills/builtin` build copy.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Required built-in asset missing/invalid | Fail startup with its name/path; do not silently remove product capability |
| Optional project/global skill missing/invalid | Preserve existing skip-and-surface behavior |
| Any `进行中` backlog row | Select by priority; no fresh peer research |
| No `进行中`, but a `未开始` row | Select by priority; no fresh peer research |
| Named product source unavailable | Record limitation and make no unsupported claim |
| Same-day report already exists | Read and append a unique UTC run section; never overwrite |
| Developer child reports success without Host acceptance | Keep `进行中` |
| Explicit abandonment decision | Set `放弃` and record decision plus reason |

### 5. Good / Base / Bad Cases

- **Good:** an empty backlog permits sourced research, adds no more than five ranked rows, selects one, loads `developer`, and records `完成` only after independent checks.
- **Base:** an existing `未开始` row suppresses all fresh peer research and is handed to `developer` alone.
- **Bad:** researching before reading the backlog, inventing unavailable product claims, overwriting a same-day report, implementing several rows, or trusting the child report as acceptance violates the persistence contract.

### 6. Tests Required

- `spike/verify-skills.ts`: both required built-ins in a project-free scan, load/slash expansion, progressive disclosure, case-insensitive collision isolation, load-bearing workflow language, and the backlog/report template contracts.
- `pnpm typecheck`, `pnpm test`, and `pnpm build`; inspect `dist/src/skills/builtin/self-evolution-research/SKILL.md` after build.

### 7. Wrong vs Correct

```text
# WRONG: fresh research while unfinished work exists, then mark child prose complete
read peer docs -> choose several ideas -> child says success -> 完成

# CORRECT: backlog is the first gate and Host evidence owns completion
read backlog -> select 进行中/未开始 (no research) -> load developer -> Host acceptance -> 完成
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
| system prompt | `agent.systemPrompt = [TextBlock, CachePointBlock]` | placed by us, after `initialize()` |

`AnthropicModelConfig` has **no** `cacheConfig`, so the `anthropic` provider gets the system
prompt cache point only. Darwin adds no cache points for OpenAI because OpenAI prompt caching
is provider-managed and automatic; this is not reported as an unsupported-provider warning.

### Contract: the system prompt cache point goes on after `initialize()`

`SkillsPlugin.initAgent` appends `<available-skills>` during initialization and throws on a
block-array prompt. Wrapping earlier therefore either crashes or caches a prefix that ends
mid-prompt. The SDK never rewrites `systemPrompt` itself (session restore does not touch it),
so the post-initialize assignment survives for the life of the agent.

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

### Gotchas

- `AgentResult.metrics.accumulatedUsage` accumulates over the agent's **lifetime**, not per
  turn: read cache tokens as a delta between turns or the second turn appears to double.
- `Agent.stream()` does not re-emit the provider's `modelMetadataEvent`; usage arrives on
  `agentResultEvent`.
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
matching the SDK default.

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

## Global and project Darwin state

`src/paths.ts` owns user-global and project-local paths. Config is global, permission rules are
project-keyed user state, sessions and background logs are globally stored per canonical project,
and hooks/resources/MCP merge global plus project layers. Project keys combine a bounded readable
canonical-path slug with SHA-256. Legacy rules/hooks/sessions are fallback migration inputs and
are never rewritten.
