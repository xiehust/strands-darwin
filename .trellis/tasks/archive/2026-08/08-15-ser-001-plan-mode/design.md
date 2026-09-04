# Design: enforced plan permission mode

## Architecture and boundaries

`ApprovalMode` remains the single public mode vocabulary used by config and CLI parsing. `AgentRuntime.create` resolves the effective value (`CLI override ?? config`) and constructs the existing `PermissionGate`. The same gate, either directly or wrapped by `ToolHookGate`, is registered on the parent and passed to `SubagentTool` children.

No second Agent, loop, or policy engine is introduced.

## Permission decision flow

`PermissionGate` gains a narrow synchronous plan guard based only on `classify(toolName, input)`:

1. Classify the tool call as read/write/execute.
2. If mode is `plan` and kind is write/execute, return a deterministic denial.
3. Otherwise continue the existing flow: yolo -> static risk -> allow rule -> optional auto classifier -> bridge prompt.

The denial reason identifies plan mode and instructs the model to continue with read-only inspection or ask the user to run outside plan mode. The guard deliberately keys off `PermissionKind`, not `risk`: an in-project write can be statically safe in default mode but must still be blocked in plan mode.

## Hook composition

`ToolHookGate.beforeToolCall` calls the same gate's narrow plan preflight before running Pre hooks. If it returns a denial, the composed handler returns immediately. Otherwise it preserves the current sequence exactly:

Pre hooks -> cancellation check -> PermissionGate -> body -> Post hooks.

The ordinary `PermissionGate.beforeToolCall` also applies the guard, so deployments without configured hooks and child agents are protected. The preflight does not evaluate risk, rules, classifiers, or bridges and does not replace the full permission evaluation after Pre hooks.

## Child agents

`SubagentTool` remains classified as read, allowing delegation itself. Children receive the same composed intervention object. Any child write/execute therefore reaches the same plan guard; no child-specific mode copy is added.

## Diagnostics

- TUI reuses its existing mode row. Plan mode receives explicit read-only wording on that row. If rules are loaded, the row states that they are ignored rather than suggesting bypass capability.
- Headless startup emits one stable stderr line after runtime creation: `permission-mode: <effective>`. It reads `runtime.info.permissionMode`, proving CLI override resolution.

## Compatibility

- Default remains `default`; existing modes retain behavior.
- `--yolo` remains the winning shorthand.
- `plan` is a root/session config value and survives `/model` exactly as other permission modes do.
- Existing allow-rule storage is unchanged; rules become effective again on a later non-plan run.

## Rollback

The change is additive. Rollback removes `plan` from the mode list, the gate preflight, diagnostics/docs, and focused assertions. No persisted state migration is required beyond users removing `"plan"` from config if rolling back.
