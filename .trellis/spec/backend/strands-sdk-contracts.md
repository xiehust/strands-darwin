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
- Slash-expanded messages must include "the full text is above, do not call load_skill" or
  the model redundantly loads the skill it was just given.
