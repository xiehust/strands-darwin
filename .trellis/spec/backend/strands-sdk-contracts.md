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
prompt cache point only. OpenAI gets nothing.

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
thinking for Mantle models even at `max`. Prompt caching is also off (`planPromptCache` returns
`DISABLED` for `provider: 'openai'`), so a Mantle session re-sends its whole prefix every turn.
