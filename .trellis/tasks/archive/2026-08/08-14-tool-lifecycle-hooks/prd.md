# Add tool lifecycle hooks

## Goal

Let projects enforce deterministic checks and run follow-up automation around every darwin tool call through `PreToolUse` and `PostToolUse` shell hooks configured in `.darwin/config.json`, without forking the Strands agent loop or weakening config-file protections.

## Background

- `src/agent/runtime.ts` is the only agent assembly point and already supplies SDK `InterventionHandler` instances to both the main agent and subagents.
- SDK 1.12 interventions support awaited `beforeToolCall` and `afterToolCall` callbacks. A before callback can deny with model-visible text; an after callback can observe the final result while returning `proceed()` unchanged.
- `.darwin/config.json` is already permission-sensitive: default/auto modes prompt for writes, and wildcard allow-rules can never cover that path. Explicit `yolo` mode remains the user-selected global safety bypass.
- Claude Code configures hooks as event keys containing matcher groups, with command-hook entries. This task implements the compatible command-only subset while using tool-name glob matching as requested.

## Requirements

1. Add an optional top-level `hooks` config object with `PreToolUse` and `PostToolUse` arrays. Each array contains matcher groups shaped as `{ "matcher": "<tool glob>", "hooks": [{ "type": "command", "command": "<shell command>" }] }`.
2. Support case-sensitive tool-name glob matching: `*` matches zero or more characters and `?` matches one character; all other characters are literal. `*` matches every tool.
3. Execute all matching command hooks sequentially in config order, using `/bin/sh -c`, the project root as cwd, and the inherited darwin environment.
4. Send exactly one JSON object on stdin for both events: `{ "tool_name": <name>, "tool_input": <raw input> }`, followed by a newline. Post hooks do not receive or alter the tool result.
5. Run `PreToolUse` after the model has produced the tool name/input and before permission evaluation or tool execution. Stop at the first non-zero exit or process-launch failure, do not execute the tool, and return stderr to the model as the denial reason; use an actionable fallback when stderr is empty.
6. Run `PostToolUse` after every completed tool attempt, including tool errors. A non-zero exit or process-launch failure must not change, retry, or hide the original tool result; remaining matching post hooks still run.
7. Apply the same hook configuration to main-agent and subagent tool calls. Direct cleanup calls that bypass the SDK intervention pipeline remain outside hook execution.
8. Validate explicit hook configuration at startup. Wrong event shapes, blank matchers/commands, unsupported hook types, or malformed entries raise `ConfigError` naming the config path and field.
9. Missing `hooks` means no hook handler and preserves current behavior without spawning processes.
10. Keep hook stdout/stderr captured so commands cannot write directly into the Ink frame. Pre stderr is exposed only when denying; Post output is ignored.
11. Preserve `.darwin/config.json` security: default/auto writes require approval and no persisted allow-rule can cover them, so the agent cannot silently install or weaken hooks. Do not add any agent-facing hook writer or exemption. Explicit `yolo` semantics are unchanged.
12. Add no dependency and keep all paths rooted in the CLI working directory.

## Acceptance Criteria

- [x] Valid `PreToolUse` and `PostToolUse` command groups load from both single-model and `models` config forms and survive runtime model switching as session config.
- [x] Exact, `*`, and `?` tool-name patterns match as specified; regex metacharacters are treated literally.
- [x] A matching Pre hook receives the exact `tool_name`/`tool_input` JSON and exits zero before the tool executes.
- [x] Multiple matching Pre hooks run sequentially; the first failure blocks the tool and later Pre hooks do not run.
- [x] A failed Pre hook returns its stderr in a `DENIED` tool result visible to the model; empty stderr and launch failures produce an actionable fallback.
- [x] Permission prompting/classification is not reached when a Pre hook has already denied the call.
- [x] A matching Post hook runs after both successful and failed tool executions and receives the same name/input payload.
- [x] Failed Post hooks do not change the original result and do not prevent later Post hooks from running.
- [x] Main-agent and subagent tool calls use the same hook runner.
- [x] Invalid hook config refuses startup with an actionable `ConfigError`; absent hooks are silent.
- [x] Writes to `.darwin/config.json` remain exempt from wildcard allow-rules and require confirmation in default/auto modes.
- [x] `pnpm typecheck`, `pnpm test`, targeted hook verification, and relevant permission/subagent regression suites pass.

## Out of Scope

- Hook events other than `PreToolUse` and `PostToolUse`.
- HTTP, prompt, agent, async/background, or per-hook timeout handlers; hook stdout JSON decisions; tool-input mutation; passing tool results to Post hooks.
- User-global hook configuration, live config reload, a hook editor/UI, or environment-variable interpolation beyond normal shell behavior.
- Changing explicit `yolo` mode semantics.

## Key Decisions

- Use the Claude Code matcher-group/command-hook JSON shape so existing concepts transfer cleanly, but interpret `matcher` as a glob rather than Claude Code's regex matcher because wildcard behavior is the requested contract.
- Place the hook intervention before the permission gate. A deterministic Pre rejection should not first ask the user to approve the same call.
- Keep hooks in a separate intervention shared by main and child agents rather than adding hook behavior to `PermissionGate`; hook policy and interactive permission policy have different failure semantics.
