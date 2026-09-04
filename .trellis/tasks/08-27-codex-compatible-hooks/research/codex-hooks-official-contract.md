# Research: Official Codex hooks contract

- **Query**: Design a Codex-compatible hooks adapter for Darwin; catalog all 11 Codex events, JSON input/output contracts, matcher/timeout/async/handler behavior, discovery, aliases, and unsupported semantics.
- **Scope**: external
- **Date**: 2026-08-27

## Findings

### External References

- [Official Codex hooks page](https://developers.openai.com/codex/hooks/) — release-behavior authority used for this report.
- [Official Markdown rendering](https://developers.openai.com/codex/hooks.md) — same page in machine-readable form.
- [Generated hook schemas on `openai/codex` `main`](https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated) — exact schema artifacts, but the official page warns that `main` may contain fields not in the current release; the page wins on release behavior.

### Files Found

| File Path | Description |
|---|---|
| `codex-rs/hooks/schema/generated/*.schema.json` (external repository) | Input/output schemas for the 11 documented events plus an `interrupt` event not documented as part of the release event set. |

## Core configuration and execution contract

### Discovery and trust

Official Codex discovers hook configuration beside active Codex config layers as either `hooks.json` or inline `[hooks]` tables in `config.toml`. The practical locations named by the page are:

- `~/.codex/hooks.json`
- `~/.codex/config.toml`
- `<repo>/.codex/hooks.json`
- `<repo>/.codex/config.toml`

All matching hooks from all sources run; higher-precedence config layers do not replace lower layers. If one layer has both `hooks.json` and inline `[hooks]`, Codex merges them and warns. Enabled plugins can additionally contribute a default `hooks/hooks.json`, manifest-referenced files, or inline hook objects.

Project-local `.codex` hooks run only for a trusted project layer. Every non-managed hook definition is hash-reviewed; new or changed definitions are skipped until trusted through `/hooks`. Managed system/MDM/cloud/`requirements.toml` hooks are policy-trusted and cannot be disabled in the user browser. `--dangerously-bypass-hook-trust` bypasses persisted trust for one invocation.

**Important negative finding:** the official page does **not** list `.agents/hooks.json` or `.agents/hooks/*.json`. Those would be Darwin portability extensions, not official Codex discovery.

### Three-level shape

```json
{
  "description": "optional metadata",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|apply_patch",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ./policy.py",
            "timeout": 30,
            "statusMessage": "Checking policy",
            "additionalContextLimit": 2500,
            "async": false,
            "commandWindows": "py -3 .\\policy.py"
          }
        ]
      }
    ]
  }
}
```

The levels are event → matcher group → handler. `description` is inert metadata.

### Handler types

| Type | Contract |
|---|---|
| `command` | Receives one event JSON object on stdin. Runs with the session cwd and inherited environment. `commandWindows` can override the command on Windows. Output is interpreted according to the event. |
| `mcp_tool` | Calls `tool` on an already-connected `server`; optional recursively templated `input` defaults to `{}`. It is synchronous, requests no approval, triggers no nested hooks, and uses the same output decision contract as a command. Missing server/tool and errors do not block. `SessionEnd` does not support it. |
| `prompt`, `agent` | Parsed but skipped in the current release. |

MCP input templates use `${field.nested}`. A placeholder occupying the whole JSON value preserves the source type; embedded placeholders stringify. Objects and arrays expand recursively.

### Matching

`matcher` is a **regex string**, not a glob. `"*"`, `""`, or omission means match all (the bare `*` is therefore a documented special case, not a generally valid regex). Matching event fields are listed in the event catalog below. `UserPromptSubmit` and `Stop` ignore configured matchers.

All matching files/groups run. Multiple matching **command** hooks for one event launch concurrently, so one cannot prevent another from starting. This differs materially from Darwin's current sequential Pre/Post command execution.

### Timeouts and background execution

- `timeout` is seconds.
- Default: 600 seconds for most command and MCP handlers.
- `SessionEnd`: default 1 second, maximum 3 seconds, always synchronous.
- `async: true` applies to command hooks and lets the triggering operation continue.
- Codex permits up to eight background hooks concurrently per session; excess work waits.
- Background hooks can finish out of order. Session end cancels unfinished background hooks and discards undelivered output.
- Informational background output (`additionalContext`, `systemMessage`) is delivered only at the next safe point: after the current model request/tool activity before a later request, or at the next user turn if idle. Completion never starts a turn.
- Background output cannot block, approve, rewrite, or otherwise control its triggering operation.

### Output and exit-code baseline

- Exit 0 with no stdout: success/continue.
- Event-specific plain-text behavior is cataloged below.
- JSON `systemMessage` is surfaced as a UI/event-stream warning where supported.
- Exit code 2 plus stderr is a blocking/feedback/continuation shorthand for `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SubagentStop`, and `Stop`, with event-specific meaning.
- Other launch, timeout, parse, and nonzero-exit failures are hook failures; they do not acquire broader policy authority than the event grants.
- Common JSON fields are not universally accepted. In particular, `PreToolUse` and `PermissionRequest` reject `continue`, `stopReason`, and `suppressOutput`; `PostToolUse` accepts `continue: false` and `stopReason` but not `suppressOutput`.

### Large model-visible output

Model-visible `additionalContext` defaults to an approximate 2,500-token per-handler threshold. `additionalContextLimit` selects another positive threshold; `0` disables spilling and passes all context. Oversized output is written under `<temp_dir>/hook_outputs/<session_id>/<uuid>.txt`, while the model receives a head/tail preview and path; if writing fails, it receives a truncated preview. This setting applies only to `additionalContext`, not tool feedback or continuation prompts.

## Common JSON input

Every command receives these fields:

| Field | Type | Meaning |
|---|---|---|
| `session_id` | string | Current root Codex session id; subagent events use the parent session id. |
| `transcript_path` | string \| null | Session transcript path, if available; format is explicitly unstable. |
| `cwd` | string | Session working directory and command cwd. |
| `hook_event_name` | string | Exact event name. |
| `model` | string | Codex extension: active model slug. |

Turn-scoped events add `turn_id`. `SessionStart`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, and `Stop` add `permission_mode`, one of `default`, `acceptEdits`, `plan`, `dontAsk`, or `bypassPermissions`.

## Common JSON output

The shared shape is:

```json
{
  "continue": true,
  "stopReason": "optional",
  "systemMessage": "optional",
  "suppressOutput": false
}
```

`SessionStart`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SubagentStop`, and `Stop` support this shape. `SubagentStart` supports `systemMessage` and hook-specific context, but `continue: false` does not stop startup. `suppressOutput` is parsed but not implemented. `PostToolUse` supports `systemMessage`, `continue: false`, and `stopReason`; it rejects `suppressOutput`. Event-specific precedence remains important: on `Stop` and `SubagentStop`, any `continue: false` wins over continuation decisions from sibling hooks.

## All 11 events

### Summary matrix

| Event | Matcher target | Event-specific input | Plain stdout | Controlling output |
|---|---|---|---|---|
| `SessionStart` | `source` | `source` | Additional developer context | `hookSpecificOutput.additionalContext`; common stop fields |
| `SessionEnd` | `reason` | `reason` | Advisory only | Output cannot steer or keep thread open |
| `SubagentStart` | `agent_type` | `turn_id`, `agent_id`, `agent_type`, `permission_mode` | Child developer context | Additional child context; `continue:false` ignored for startup |
| `PreToolUse` | tool name + aliases | `turn_id`, `tool_name`, `tool_use_id`, `tool_input` | Ignored | deny, allow+rewrite, additional context |
| `PermissionRequest` | tool name + aliases | `turn_id`, `tool_name`, `tool_input` | Ignored | allow / deny / no decision |
| `PostToolUse` | tool name + aliases | Pre fields + `tool_response` | Ignored | feedback/block, replace normal result processing, additional context |
| `PreCompact` | `trigger` | `turn_id`, `trigger` | Ignored | `continue:false` prevents compaction |
| `PostCompact` | `trigger` | `turn_id`, `trigger` | Ignored | `continue:false` stops after compaction |
| `UserPromptSubmit` | ignored | `turn_id`, `prompt` | Additional developer context | block prompt, additional context |
| `SubagentStop` | `agent_type` | turn/agent fields, child transcript/message, active flag | Invalid | continue child; `continue:false` wins |
| `Stop` | ignored | `turn_id`, active flag, last assistant message | Invalid | create continuation prompt; `continue:false` wins |

### 1. `SessionStart`

Input extension:

```json
{ "source": "startup | resume | clear | compact" }
```

Matcher applies to `source`. Plain stdout becomes extra developer context. JSON may return:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Load workspace conventions."
  }
}
```

After root compaction, `source: "compact"` runs before the next request, including an immediate mid-turn continuation after automatic compaction. `continue: false` ends that turn before another model request.

### 2. `SessionEnd`

Input extension:

```json
{ "reason": "other" }
```

`reason` is currently always `other`; matcher filters it. It runs only for the main thread on archive/delete of an open conversation, normal Codex close, or after 30 idle minutes with no connected client. Unsubscribe/switching conversations is not immediate end. It never runs for subagents.

It is command-only, synchronous, advisory, default timeout 1 second/max 3 seconds. Output cannot steer Codex or keep the thread open. Failures are reported as hook failures.

### 3. `SubagentStart`

Input extension:

```json
{
  "turn_id": "...",
  "agent_id": "...",
  "agent_type": "...",
  "permission_mode": "..."
}
```

Matcher applies to `agent_type`. Plain stdout and `hookSpecificOutput.additionalContext` become extra developer context for that child. `systemMessage` is accepted. `continue: false` is compatibility-parsed but does not prevent the child from starting.

### 4. `PreToolUse`

Input extension:

```json
{
  "turn_id": "...",
  "tool_name": "Bash | apply_patch | mcp__server__tool | function_name",
  "tool_use_id": "...",
  "tool_input": {}
}
```

Matcher applies to canonical `tool_name` and aliases. Plain stdout is ignored.

Deny:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Blocked by policy."
  }
}
```

Legacy deny is `{ "decision": "block", "reason": "..." }`; exit 2/stderr is equivalent.

Rewrite/proceed:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": { "command": "echo rewritten" }
  }
}
```

For `Bash`/`apply_patch`, replacement must contain string `command`; for MCP/other function tools it is the replacement argument object. `updatedInput` is legal only with `permissionDecision: "allow"`. Informational `hookSpecificOutput.additionalContext` is also supported.

Unsupported by current Codex release and treated as hook failure while the original call continues: `permissionDecision: "ask"`, legacy `decision: "approve"`, `continue:false`, `stopReason`, `suppressOutput`, and malformed rewrite combinations.

### 5. `PermissionRequest`

Runs only when Codex is about to ask for approval; it does not run for calls that need no approval. Input extension:

```json
{
  "turn_id": "...",
  "tool_name": "...",
  "tool_input": { "description": "optional human approval reason" }
}
```

Do not assume every input has `description`. Plain stdout is ignored.

Allow:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

Deny adds optional `message` under the decision. Across multiple hooks, any deny wins; otherwise any allow suppresses the normal approval prompt; with no decision, ordinary approval continues. `updatedInput`, `updatedPermissions`, and `interrupt` are reserved and fail closed today.

### 6. `PostToolUse`

Input extension:

```json
{
  "turn_id": "...",
  "tool_name": "...",
  "tool_use_id": "...",
  "tool_input": {},
  "tool_response": {}
}
```

Runs after supported success and failure results. Plain stdout is ignored. Example feedback:

```json
{
  "decision": "block",
  "reason": "Review this result before continuing.",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Generated files changed."
  }
}
```

The completed side effect is never undone. `decision:"block"` (or exit 2/stderr) replaces the model-facing original result with feedback and continues the model. `continue:false` also stops normal processing of the original result and continues from hook feedback/stop text. `updatedMCPToolOutput` and `suppressOutput` are parsed but unsupported and fail the hook open to ordinary result processing.

### 7. `PreCompact`

Input extension:

```json
{ "turn_id": "...", "trigger": "manual | auto" }
```

Matcher applies to `trigger`; plain stdout is ignored. Common JSON output is supported. `continue:false` stops before compaction.

### 8. `PostCompact`

Same input/matcher as `PreCompact`, emitted after compaction. Plain stdout is ignored. Common JSON output is supported. `continue:false` stops after compaction.

### 9. `UserPromptSubmit`

Input extension:

```json
{ "turn_id": "...", "prompt": "literal submitted prompt" }
```

Matcher is ignored. Plain stdout or `hookSpecificOutput.additionalContext` becomes developer context. `{ "decision":"block", "reason":"..." }` or exit 2/stderr rejects the prompt. Common output fields are supported.

### 10. `SubagentStop`

Input extension:

```json
{
  "turn_id": "...",
  "agent_id": "...",
  "agent_type": "...",
  "agent_transcript_path": null,
  "stop_hook_active": false,
  "last_assistant_message": null
}
```

Matcher applies to `agent_type`. Exit 0 requires JSON; plain stdout is invalid. `{ "decision":"block", "reason":"Run another pass." }` or exit 2/stderr requests continuation of the child. `stop_hook_active` lets hooks avoid loops. If any sibling returns `continue:false`, it overrides continuation requests.

### 11. `Stop`

Input extension:

```json
{
  "turn_id": "...",
  "stop_hook_active": false,
  "last_assistant_message": null
}
```

Matcher is ignored. Exit 0 requires JSON; plain stdout is invalid. `{ "decision":"block", "reason":"Run tests again." }` or exit 2/stderr does **not** reject the completed turn: Codex creates a new continuation prompt acting as a user prompt with `reason` as text. `stop_hook_active` guards recurrence. Any sibling `continue:false` overrides continuation.

## Tool coverage and aliases

| Tool path | Coverage | Official matcher name/alias |
|---|---|---|
| Shell / unified exec | Pre + Post | `Bash`; later `write_stdin` polling does not rerun Pre and may deliver the original command's Post when it finishes. |
| `apply_patch` | Pre + Post | Canonical `apply_patch`; aliases `Edit` and `Write`. Input still reports `tool_name:"apply_patch"`. |
| MCP | Pre + Post | `mcp__<server>__<tool>` convention, e.g. `mcp__filesystem__read_file`. |
| Other local function tools | Pre + Post | Function name; `spawn_agent` additionally matches `Agent`. |
| Hosted tools such as `WebSearch` | No | Not on the local function-tool hook path. |

Specialized paths can opt out. The official page says tool hooks are a useful guardrail, not a complete enforcement boundary.

## Caveats / Not Found

- The page does not define deterministic conflict resolution for multiple concurrent `updatedInput` values; it only states that matching command hooks launch concurrently and documents decision precedence for `PermissionRequest`, `Stop`, and `SubagentStop`. Do not invent rewrite precedence without checking the release implementation.
- The generated `main` schemas include an `interrupt` event absent from the official release event catalog. It is out of scope for an 11-event compatibility claim.
- Exact shell selection and all platform process details are not specified on the release page; only command/cwd/environment/Windows override behavior is documented.
