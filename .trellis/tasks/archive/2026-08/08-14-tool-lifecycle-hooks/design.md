# Tool lifecycle hooks — design

## Architecture

Add `src/hooks/tool-hooks.ts` with three responsibilities:

1. validated runtime hook types and tool-name glob matching;
2. shell command execution with JSON stdin and captured output;
3. a `ToolHookGate extends InterventionHandler` that composes configured hooks with the existing `PermissionGate`.

The runtime constructs one `PermissionGate` as today. With no configured hooks it registers that gate directly. With hooks it registers one `ToolHookGate` wrapping the gate. The same registered handler is passed to `SubagentTool`, so child agents get identical hook and permission behavior without rebuilding policy or forking the SDK loop.

## Config contract

`hooks` is a session-scoped field because it governs the conversation/tool environment rather than one model:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "file*",
        "hooks": [
          { "type": "command", "command": "./scripts/check-tool.sh" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "./scripts/audit-tool.sh" }
        ]
      }
    ]
  }
}
```

`SessionFields`, `SESSION_KEYS`, and `withModelChoice()` carry the validated object unchanged across `/model`. Validation is strict at the explicit config boundary: both event values are arrays; every group is an object with a nonblank matcher and nonempty hooks array; every hook is `{ type: "command", command: nonblank string }`. Unknown top-level config keys remain tolerated by existing policy, but unknown keys inside a declared hook entry do not affect execution.

## Lifecycle and ordering

`ToolHookGate.beforeToolCall()`:

1. find matching Pre groups and flatten their command entries in file order;
2. run commands sequentially;
3. on the first failure, return `InterventionActions.deny(...)` and do not call `PermissionGate`;
4. when all pass, delegate to `PermissionGate.beforeToolCall()`;
5. only when permission returns `proceed`, mark the tool-use id as eligible for Post hooks.

`ToolHookGate.afterToolCall()` checks and removes that eligibility marker. This is necessary because SDK 1.12 emits `AfterToolCallEvent` even for calls cancelled by an intervention. Post hooks therefore run after success and tool-body errors, but not after Pre-hook or permission denial. The marker is keyed by model-issued `toolUseId`, which is stable through the SDK execution pipeline.

The SDK invokes After callbacks in reverse order, but composition keeps both policies inside one handler, avoiding cross-handler ordering ambiguity.

## Shell process contract

Each command is spawned as `/bin/sh -c <command>` with:

- `cwd: projectRoot`;
- inherited environment;
- stdin: `JSON.stringify({ tool_name, tool_input }) + "\n"`;
- stdout and stderr piped/captured, never inherited by Ink.

The runner resolves to `{ exitCode, stdout, stderr }`; spawn errors are represented as failures rather than thrown through the agent loop. A Pre failure reason prefers trimmed stderr and otherwise names the command and exit/spawn failure. Post failures are consumed and execution continues to every later matching Post hook.

## Glob semantics

Compile a matcher to an anchored regular expression after escaping every regex metacharacter, then translate escaped glob tokens:

- `*` → `.*`
- `?` → `.`

Matching is case-sensitive against the complete tool name. Thus `file*` matches `fileEditor`, `file.Editor` is literal, and `*` matches every name.

## Security boundary

Hooks are executable project configuration, so no tool or UI mutator is added. Existing permission policy remains the boundary:

- `.darwin/config.json` writes are dangerous in default/auto modes;
- `permission-rules.ts` exempts that path from both matching and suggestions;
- configuring `fileEditor` or a path-glob allow rule cannot authorize config changes;
- explicit `yolo` remains an intentional user override and is not silently enabled by hooks.

A Pre hook itself is trusted configuration and executes without an additional permission prompt; prompting for a configured policy command would make deterministic enforcement recursive and unusable.

## Compatibility and rollback

No hooks means the current `PermissionGate` is registered unchanged and no process is spawned. Removing the hook module plus config/runtime/subagent wiring restores current behavior. No dependency, persisted migration, prompt, or TUI layout change is required.
