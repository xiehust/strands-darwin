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
```

Project definitions are direct `.darwin/agents/*.md` files. Frontmatter requires `name` and
`description`, accepts optional `tools: string[]`, and the non-empty Markdown body is the child
system prompt. `general` is built in and reserved.

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

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| `.darwin/agents/` absent | Built-in `general` only; no warning |
| Invalid YAML/name/description/body/tools | Skip that file and expose an agent problem |
| Case-insensitive duplicate or `general` | Keep first/built-in owner; skip later file |
| Unknown tool in allowlist | Skip definition; never silently drop the unknown entry |
| Unknown requested agent | Return available names as the tool result |
| Child tool denied | Shared gate produces the normal denial result; tool does not run |
| Parent cancelled during model construction | Return cancelled result; do not create child |
| Child invoke throws | Tool reports an error through SDK; child bash cleanup still runs |

### 5. Good / Base / Bad Cases

- **Good:** parent delegates a broad search; child uses `fileEditor`/`bash`, then only its
  evidence-based final report appears in the parent tool result.
- **Base:** no project definitions; `general` handles the task with a fresh context.
- **Bad:** wrapping with `asTool()` forwards child stream events, or building a second gate lets
  a child miss an allow-rule the user just accepted.

### 6. Tests Required

- `spike/verify-subagents.ts`: discovery/errors, exact allowlists, fresh histories, parent
  transcript isolation, approval/denial, and later-dispatch model config.
- `spike/verify-subagents-live.ts`: real main → child delegation, safe repository read, and a
  child bash call reaching the shared permission bridge.
- `spike/verify-tui.ts completion`: invalid definition warning without a model call.
- Always run `pnpm typecheck` and `pnpm test`; cancellation/bash lifecycle changes additionally
  require the existing `cancelThenContinue` and `bashExit` scenarios.

### 7. Wrong vs Correct

```typescript
// WRONG: forwards child stream events and does not prove the child shares darwin's gate.
tools: [child.asTool()]

// CORRECT: private child invocation, reduced tools, shared intervention boundary.
const child = new Agent({
  model: await createModelFromConfig(liveConfig),
  tools: allowedTools,
  interventions: [permissionGate],
  printer: false,
})
const result = await child.invoke(task)
return result.toString()
```

---

## Cancellation and Process Exit

Two independent leaks keep the Node event loop alive; both fixes are load-bearing:

1. **Vended bash session**: the persistent shell's stdio pipes are live handles, and the
   SDK's own `process.on('beforeExit', cleanup)` never fires because those very pipes keep
   the loop non-empty. `AgentRuntime.shutdown()` reaps it via the public API:
   `agent.tool['bash'].invoke({ mode: 'restart' }, { recordDirectToolCall: false })`
   (restart stops the running shell and only lazily creates a new one; the direct call
   bypasses interventions so no permission prompt appears at exit).
2. **Cancelled model stream**: `BedrockModel.stream()` sends its HTTP command without an
   abort signal; after `agent.cancel()` nothing destroys the socket, and the client is
   private — no public cleanup exists. `src/cli.ts` therefore arms an **unref'd** 500ms
   `process.exit` fallback *after* `await runtime.shutdown()` completes. Remove it once
   the SDK accepts an abort signal (re-check with `spike/probe-cancel-exit.ts`).

Regression coverage: `verify-tui.ts` scenarios `bashExit` and `cancelThenContinue`.

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
`cacheReadInputTokens`, `cacheWriteInputTokens`), the two cache ones staying `undefined` until
a provider reports them, so a total must default them to 0. Prefer the getter over tallying
`agentResultEvent`: a cancelled turn may never emit one. What it cannot tell you is a resumed
session's earlier spend — session snapshots persist messages, not metrics, so the meter starts
at zero on every process (`AgentRuntime.usage`, surfaced by `/usage`, says "this run" for
exactly that reason).

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
