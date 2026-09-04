# Research: Darwin lifecycle seams and Codex compatibility map

- **Query**: Map all 11 Codex hook events and contracts to exact current Darwin/Strands seams and load-bearing constraints; assess discovery, regex-vs-glob, aliases, decisions, and semantics that must remain unsupported.
- **Scope**: mixed
- **Date**: 2026-08-27

## Findings

### Files Found

| File Path | Description |
|---|---|
| `src/hooks/tool-hooks.ts` | Existing composed Strands intervention for `PreToolUse`/`PostToolUse`; command runner and glob matcher. |
| `src/hooks/lifecycle-hooks.ts` | Existing non-blocking, output-free runner for Darwin-only `TurnComplete`/`PermissionRequest` observations. |
| `src/config.ts` | Strict current hook schema and four-layer discovery/merge. |
| `src/paths.ts` | `.agents`/`.darwin` extension roots and hook source order; executable-policy sensitivity. |
| `src/agent/runtime.ts` | Sole main `Agent` assembly, session send/compact/clear/retire/shutdown seams. |
| `src/agent/permission.ts` | Live permission gate; plan-first and prompt-identity decisions. |
| `src/tui/permission-queue.ts` | Exact “permission prompt became visible” observer seam. |
| `src/tui/App.tsx` | Interactive prompt submission, turn outcome, `/clear`, and manual `/compact` driver seams. |
| `src/headless-runner.ts` | Headless prompt/turn/permission/shutdown seams. |
| `src/agents/subagent-tool.ts` | Child construction, initialize/invoke/final-result boundary, private child transcript. |
| `src/agents/dispatch-registry.ts` | Bounded child start/terminal identity and private lifecycle state. |
| `src/mcp/registry.ts` | Darwin MCP prefix naming (`<server>_<tool>`, not Codex `mcp__...__...`). |
| `node_modules/@strands-agents/sdk/dist/src/hooks/events.d.ts` | Installed Strands 1.12.0 lifecycle event capabilities. |
| `node_modules/@strands-agents/sdk/dist/src/interventions/actions.d.ts` | Allowed intervention actions and short-circuit/transform behavior. |
| `.trellis/spec/backend/strands-sdk-contracts.md` | Authoritative existing tool hooks, lifecycle observer, subagent, compaction, and layer contracts. |
| `.trellis/spec/backend/error-handling.md` | Fail-closed executable-policy loading and Pre/Post/lifecycle failure behavior. |
| `docs/architecture/load-bearing-decisions.md` | Rationale for one SDK loop, only two lifecycle observation events, session replacement, permissions, and child privacy. |
| `AGENTS.md` | Indexed load-bearing invariants and required checks. |

## Current Darwin hook behavior (baseline)

### Discovery and schema

Current source order is explicit in `src/paths.ts:46-53`:

```ts
return [
  { root: userAgentsDir(), scope: 'global', kind: 'agents' },
  { root: userDarwinDir(), scope: 'global', kind: 'darwin' },
  { root: agentsDir(projectRoot), scope: 'project', kind: 'agents' },
  { root: darwinDir(projectRoot), scope: 'project', kind: 'darwin' },
];
```

Each root's direct lexical `hooks/*.json` files are authoritative (`src/config.ts:1099-1133`). `.agents` has no legacy single-file fallback. A `.darwin/hooks/*.json` directory source shadows that `.darwin` layer's legacy `hooks.json` and embedded config hooks with a visible notice (`src/config.ts:1135-1165`). Current events are exactly `PreToolUse`, `PostToolUse`, `TurnComplete`, and `PermissionRequest` (`src/config.ts:911-943`). Groups require a **nonblank** matcher and nonempty command list; handlers accept only `{type:"command",command}` (`src/config.ts:946-985`). Active malformed executable policy refuses startup (`.trellis/spec/backend/error-handling.md:69-70`).

Pre/lifecycle groups merge global `.agents` → global `.darwin` → project `.agents` → project `.darwin`; Post reverses the active sources (`src/config.ts:1062-1079`; spec `:2671-2674`).

### Matching mismatch

Current `matchesToolGlob` is a complete, case-sensitive `*`/`?` **glob**; regex punctuation is literal (`src/hooks/tool-hooks.ts:44-53`, spec `:1011-1025`). Codex matchers are regex strings with special match-all `*`/empty/omitted forms. A compatibility adapter must not pass Codex matchers through `matchesToolGlob` and must not reinterpret existing Darwin files as regex.

### Existing tool lifecycle seam

`ToolHookGate` is one shared intervention instance for parent and all children (`src/agent/runtime.ts:486-497,625-633`; `src/agents/subagent-tool.ts:155-168`). Its ordering is:

1. plan guard
2. repeated-failure guard
3. sequential matching Pre commands
4. `PermissionGate`
5. tool body (SDK-owned)
6. sequential matching Post commands
7. repeated-failure observation

Evidence: `src/hooks/tool-hooks.ts:175-228`, spec `:1023-1031`. Pre command failure or launch error denies; Post command exit/output/launch failure cannot alter the original result. Eligibility keyed by `toolUseId` prevents Post after denied Before events (`src/hooks/tool-hooks.ts:208-247`). Commands receive only `{tool_name,tool_input}` and no result (`:55-148`).

### Existing lifecycle observation seam

`LifecycleHookRunner` is intentionally separate from SDK interventions. It publishes only:

```ts
{ event: 'TurnComplete', outcome, source }
{ event: 'PermissionRequest', source }
```

Payloads are capped at 4096 bytes and dropped whole if oversized (`src/hooks/lifecycle-hooks.ts:5-20,118-133`). `publish()` launches detached `/bin/sh -c` processes and returns without waiting; stdout/stderr and exit status are discarded (`:33-58,73-115`). Cancellation, `/clear` retirement, startup unwind, and shutdown reap process groups (`:60-71,136-170`; `src/agent/runtime.ts:1231-1248,1382-1395,1454-1477`). The spec forbids decisions, tool/result replacement, model context, terminal output, trajectory, or event-set generalization (`strands-sdk-contracts.md:1081-1117`).

Interactive turn completion is published in `src/tui/App.tsx:682-760`; headless in `src/headless-runner.ts:216-224`. A TUI permission observation fires exactly when the prompt becomes current, with queue/withdrawal deduplication (`src/tui/permission-queue.ts:30-40,47-67,79-86,142-155`). Headless publishes immediately before its local denial (`src/headless-runner.ts:121-142`).

### Installed Strands extension points

Installed SDK version is `@strands-agents/sdk@1.12.0`. Relevant public events/capabilities:

- `InitializedEvent`: after Agent initialization (`events.d.ts:110-121`).
- `BeforeInvocationEvent`: request boundary; mutable `cancel` (`:123-145`).
- `AfterInvocationEvent`: end boundary; mutable `resume` starts another invocation under the same lock and emits a fresh Before/After pair (`:147-176`).
- `MessageAddedEvent`: framework-added user/assistant/tool-result messages, not preloaded/manual pushes (`:178-198`).
- `BeforeToolCallEvent`: mutable `toolUse`, `cancel`, replacement `selectedTool`, interrupt (`:200-253`).
- `AfterToolCallEvent`: success/failure result, mutable `result`, optional `retry`, reverse callback order (`:255-299`).
- `BeforeModelCallEvent`: mutable cancellation and projected tokens (`:300-332`).
- `AfterModelCallEvent`: result/error/stop data and retry, reverse callback order (`:363-410`).

Interventions add strict action semantics: before-tool permits proceed/deny/guide/confirm/transform; after-tool permits only proceed/transform (`interventions/handler.d.ts:33-41`). Deny short-circuits remaining handlers; transform changes later-visible content (`actions.d.ts:127-145`).

## Event-by-event mapping

Legend: **native** = existing exact seam; **adapter** = feasible only with a bounded adapter at the named seam; **projection** = emit compatible input but ignore controlling output; **unsupported** = semantics conflict with current invariants.

| Codex event | Exact Darwin/Strands seam | Feasible scope | Required invariant boundary |
|---|---|---|---|
| `SessionStart` | `AgentRuntime.create` after `await agent.initialize()` and current prompt refresh (`runtime.ts:569-660`); source is known from create options (`new`, restore, `/clear`, rewind) | adapter/projection | Do not inject hook stdout/`additionalContext` into the fixed system-prompt composition after initialization or mutate restored messages. `startup`/`resume`/`clear` can be observed; Codex `compact` source is not a new session in Darwin. |
| `SessionEnd` | `AgentRuntime.retire()` for `/clear`/rewind (`runtime.ts:1382-1395`) and `shutdown()` (`:1454-1477`) | advisory adapter | Must stay advisory; output cannot delay/steer. Darwin has no archive/delete/30-minute idle session-end concept. If executed during shutdown, a strict bounded timeout is mandatory. |
| `SubagentStart` | `SubagentTool.run`: after child identity/Agent construction and before or after `child.initialize()` (`subagent-tool.ts:155-191`) | projection | Child system prompt is already composed at construction. No hook output may become child context without changing the child privacy/system-prompt contract. `continue:false` must remain ineffective, matching Codex startup behavior. |
| `PreToolUse` | Existing `ToolHookGate.beforeToolCall` (`tool-hooks.ts:175-210`) | closest native policy seam | Preserve plan → retry → Pre → permission ordering and one shared parent/child intervention. Deny is compatible. Input rewrite is technically possible through Strands transform/mutable `event.toolUse`, but conflicts with current strict policy and authorization reasoning; recommended unsupported initially. |
| `PermissionRequest` | Actual decision request: inside `PermissionGate` bridge; actual visible prompt: `PermissionQueue.observeCurrent` (`permission-queue.ts:142-155`); headless bridge (`headless-runner.ts:132-142`) | observation native; decision adapter risky | Never let a hook `allow` bypass Darwin's gate/user-only live policy. A deny-only pre-prompt policy could be composed in the gate, but the current lifecycle event is intentionally output-free and sees only source labels. Keep existing event unchanged; Codex-compatible decision output should be unsupported unless a separately specified deny-only seam is approved. |
| `PostToolUse` | Existing `ToolHookGate.afterToolCall`, with `event.result` available (`tool-hooks.ts:212-228`; SDK `events.d.ts:263-298`) | observation native | Current contract deliberately passes only name/input and never transforms result. Blocking/replacing result, `continue:false`, `updatedMCPToolOutput`, and model context violate result-preservation/retry-guard/trajectory evidence. Keep output observational. |
| `PreCompact` | Manual: TUI immediately before `runtime.compact()` (`App.tsx:1336-1356`); headless `--compact-before` before turn. Reactive SDK compaction is internal to conversation manager before/model retry. | manual adapter/projection only | `/compact` must remain direct, reversible, idle-only, no agent-loop fork (`spec:1772-1807`). Blocking manual compaction is possible at driver/runtime boundary but creates a new policy surface; automatic trigger cannot be accurately covered without SDK manager customization. |
| `PostCompact` | Manual: after `compactConversation` succeeds and persistence completes (`runtime.ts:929-951`, `App.tsx:1344-1356`) | manual advisory adapter | Do not stop an implicit continuation or mutate context. Reactive automatic compaction lacks an exposed Darwin boundary. |
| `UserPromptSubmit` | `AgentRuntime.send` before trajectory `beginTurn` / before `agent.stream` (`runtime.ts:788-825`), with literal user input separately available | adapter possible, but output constrained | The trajectory input barrier must remain durable before provider/tool execution (`runtime.ts:803-822`). Blocking before `beginTurn` is possible; injecting developer context or rewriting prompt would alter literal trajectory/model boundary and multimodal guarantees. Recommended observation-only initially. |
| `SubagentStop` | `child.invoke()` result before dispatch terminal finish/final report return (`subagent-tool.ts:187-198`) | advisory projection | Continuation would require a second child invocation and risks exposing/depending on `last_assistant_message` or transcript; current child returns one private final report only. Child transcript/message fields must not be emitted. |
| `Stop` | Driver's completed turn boundary: TUI `runTurn` finally (`App.tsx:682-760`) or headless boundary (`headless-runner.ts:200-224`); SDK `AfterInvocationEvent` exposes `resume` | advisory projection only | Darwin's direct-driver contract forbids unfinished-plan/success classifier continuation; exact stream interruption is the only driver continuation. Do not use SDK `AfterInvocationEvent.resume` or synthesize a user prompt from hook output. Existing `TurnComplete` is the safe equivalent observation. |

## Discovery recommendation

### `.agents/hooks.json`

Do **not** treat `<root>/.agents/hooks.json` as the Codex-format file by default. Current Darwin `.agents` hook authority is **directory-only**, direct lexical `.agents/hooks/*.json`; a single `.agents/hooks.json` would collide conceptually with existing extension semantics and is not an official Codex location.

If portability requires a single-file form, define it explicitly as a new Darwin source and specify precedence/shadowing. Safer recommendation: continue accepting Codex-shaped files as direct entries under existing `.agents/hooks/*.json` (for example `.agents/hooks/codex.json`) and identify dialect by strict top-level/event schema, avoiding a new ambiguous path.

### Optional `<repo>/.codex/hooks.json`

This is the official project-local Codex file and is the best optional compatibility source. It must be opt-in/trust-gated because Darwin currently has no Codex project trust database. Silent auto-execution would be less safe than Codex itself. Recommended choices, in order:

1. Require an explicit Darwin config switch/source allowlist before loading `.codex/hooks.json`.
2. Or support discovery but skip with a visible startup problem until separately trusted by exact content hash.
3. Do not support it at all in the first adapter if trust UX is outside task scope.

If loaded, define its place in wrapper order rather than pretending it is an existing `.agents`/`.darwin` layer. A reasonable portability order is project `.codex` alongside project `.agents`, outside project `.darwin` policy, but this is a product decision. All active parse/schema errors should fail startup because the file is executable policy.

Do not add Codex `config.toml`, plugin manifests, managed requirements, or global `~/.codex` discovery under a narrow JSON adapter unless separately required; each brings precedence and trust semantics beyond file-format compatibility.

## Matcher and tool-name recommendation

### Preserve dialect-specific matching

- Existing Darwin sources retain complete case-sensitive glob semantics.
- Codex-format sources compile regex semantics independently.
- Treat omitted/empty/`*` as match-all only in the Codex dialect.
- Validate invalid regex at startup (fail closed) rather than discover it during a tool call.
- Do not translate glob → regex or regex → glob heuristically; patterns such as `file*`, `^Bash$`, `Edit|Write`, and `mcp__.*` prove the dialects are not interchangeable.

### Canonical and alias matching

Keep stdin `tool_name` as the real Darwin/Strands registered name, but match each Codex regex against a bounded alias set:

| Darwin tool | Codex match aliases | Notes |
|---|---|---|
| `bash` | `bash`, `Bash` | Codex scripts commonly expect `Bash`; Darwin policy currently names `bash`. Do not lie in input: alias only for matching. |
| `fileEditor` write/create/replace | `fileEditor`, `Edit`, `Write` | Unlike Codex `apply_patch`, Darwin's tool is multimode. Derive Edit/Write alias from the validated operation, never name alone; reads must not match write aliases. |
| `subagent` | `subagent`, `Agent` | Codex aliases `spawn_agent` to `Agent`; Darwin's equivalent is `subagent`. |
| MCP tool `<prefix>_<tool>` | actual Darwin name, optional synthetic `mcp__<server>__<serverTool>` | Darwin defaults to `<server>_<tool>` (`src/mcp/registry.ts:211-237`), not Codex double-underscore naming. A synthetic alias requires a reliable initialized client/tool mapping; never infer by splitting underscores. Explicit user prefixes and bare names make inference ambiguous. |
| Other local tools | exact registered name | Includes `http_request`, `imageViewer`, `update_plan`, memory tools. |

MCP alias mapping should be captured from the initialized MCP clients/tool objects at `runtime.ts:569-616`, where final names exist. The SDK internally knows server-side names separately from prefixed names (`node_modules/.../mcp/client.js:198-218,278-281`), but those maps are private. If no safe public mapping exists, support actual Darwin tool names only and document Codex MCP patterns as nonportable rather than reaching into private fields.

## Output-decision recommendation

### Safe compatibility subset

- `PreToolUse`: support exit 0 as allow/no-op; support exit 2/stderr and Codex deny JSON as Darwin denial. Parse `systemMessage` only if there is an existing bounded visible warning channel; otherwise ignore/report unsupported without affecting execution.
- Existing Darwin `PreToolUse` nonzero fail-closed behavior should remain for Darwin dialect. For Codex dialect, only exact exit 2 should be a policy denial with stderr; define other nonzero/invalid output conservatively. Because Codex generally reports hook failure and continues, making every nonzero deny would not be compatible; because Darwin treats executable policy failure as denial, failing open would weaken existing policy. This needs a dialect-specific explicit decision, not accidental reuse.
- `PostToolUse`, session/subagent/compact/stop events: advisory execution only; output discarded or bounded warnings only.
- `PermissionRequest`: no allow. At most deny-only under a separately approved gate seam; otherwise observation-only.

### Semantics that must remain unsupported to preserve current invariants

1. **Hook-driven `PermissionRequest allow`** — bypasses Darwin's gate/human prompt and the invariant that only the user changes live permission policy.
2. **`PreToolUse updatedInput` initially** — changes the authorized operation after plan/retry/policy classification unless the entire gate is reordered and reassesses transformed input. Strands can transform, but compatibility is not safety.
3. **`PostToolUse` result replacement/block/`continue:false`/`updatedMCPToolOutput`** — violates “original result survives,” retry-guard evidence, and direct event/trajectory integrity.
4. **`Stop` continuation** through `AfterInvocationEvent.resume` or driver-generated prompts — violates direct-driver streaming and the exact single stream-interruption continuation exception.
5. **`SubagentStop` continuation** — changes one-child-one-invocation behavior and can create hidden loops.
6. **Model-visible `additionalContext` from lifecycle/background hooks** — existing lifecycle hooks are forbidden from model context; no delayed context-injection queue exists.
7. **`SessionStart`/`SubagentStart` developer-context mutation after fixed prompt composition** — risks duplicate/reordered cache fragments and restored-state mutation.
8. **Automatic `PreCompact`/`PostCompact` parity** — SDK reactive compaction is not exposed as a stable Darwin seam; do not claim all triggers.
9. **MCP hook handlers** in the first adapter — direct calls would be a second MCP execution channel, potentially bypassing ordinary permission/hooks/preflight/empty-result wrappers and `/mcp`'s read-only projection. If ever added, they must be explicitly isolated, no approval/nested hooks, use existing connections, and never reconnect.
10. **`async:true` controlling output** — background work cannot control already-running operations. Darwin currently has no safe next-request model-context delivery channel.
11. **Hook stdout/stderr/status rows in TUI/headless/trajectory** — current output-free lifecycle and frame/protocol contracts prohibit this.
12. **Child transcript or `last_assistant_message` in `SubagentStop` payload** — violates child privacy and no-subagent-transcript invariants.
13. **Untrusted automatic `.codex` execution** — would be less safe than official Codex's hash trust review.
14. **Concurrent Pre policy commands without a deliberate contract change** — existing sequential ordering and first-failure short circuit are load-bearing. Codex concurrency cannot be copied blindly.

## Implementation shape recommendation (design evidence, not code)

Use a **dialect adapter feeding existing owners**, not a second agent loop or a broad general lifecycle bus:

- Parse Codex JSON into a separate typed representation retaining regex, timeout, async, and handler metadata.
- Translate only the approved safe subset into the existing composed `ToolHookGate` and bounded advisory runner(s).
- Keep current Darwin schema/paths/semantics byte-for-byte compatible.
- Give every new session a session-owned process manager so cancel, `/clear`, startup unwind, and shutdown preserve TERM→KILL cleanup.
- Add explicit support/reporting status per event (supported policy, advisory projection, ignored field, unsupported event semantics) rather than silently claiming full compatibility.
- Keep `runtime.ts` as the sole main `Agent` assembly; use existing SDK intervention/hooks and driver seams only.

## Related Specs

- `.trellis/spec/backend/strands-sdk-contracts.md:997-1073` — current tool-hook ordering and failure matrix.
- `.trellis/spec/backend/strands-sdk-contracts.md:1077-1117` — exact lifecycle observer contract and forbidden channels.
- `.trellis/spec/backend/strands-sdk-contracts.md:1122-1268` — child privacy/concurrency/dispatch invariants.
- `.trellis/spec/backend/strands-sdk-contracts.md:1772-1833` — direct reversible compaction contract.
- `.trellis/spec/backend/strands-sdk-contracts.md:2663-2674` — extension layer order.
- `.trellis/spec/backend/error-handling.md:69-78` — fail-closed active policy and Pre/Post/lifecycle failures.
- `docs/architecture/load-bearing-decisions.md:15-22` — SDK loop is never forked.
- `docs/architecture/load-bearing-decisions.md:1-6` — current hook layers and exact two-event lifecycle observer.
- `AGENTS.md:79-110` — indexed load-bearing decisions and required checks.

## Caveats / Not Found

- Darwin currently exposes no stable public turn id. Session id exists, but a Codex-compatible `turn_id` needs a new bounded session-local identity owner; trajectory turn numbers are optional observer state and must not become runtime input.
- Darwin trajectory files are globally stored outside the repo and are not Codex rollout transcripts. Supplying `transcript_path` could encourage dependence on an unstable/private format; `null` is the honest compatibility value unless a stable export is specified.
- `permission_mode` values differ (`default|auto|plan|yolo` vs Codex's five names). Mapping is lossy: likely `default→default`, `auto→acceptEdits` only approximately, `plan→plan`, `yolo→bypassPermissions`; there is no exact `dontAsk` equivalent. Payload should either use Darwin-native mode as an extension or document an explicit approximation.
- Darwin's current global hooks include `~/.agents/hooks/*.json`, `~/.darwin/hooks/*.json`, and legacy `~/.darwin/hooks.json`; official Codex global paths are different. Cross-tool portability is project-file-format compatibility unless broader discovery is deliberately added.
- Official Codex launches sibling command handlers concurrently, while current Darwin executes sequentially. Full concurrency would change short-circuit and process ownership behavior and needs a separate product decision.
