# Tool lifecycle hooks — implementation plan

1. Extend `AppConfig` session fields and validation for the command-only `hooks.PreToolUse` / `hooks.PostToolUse` structure; add single-model, model-array, model-switch persistence, absent, and rejection tests.
2. Add `src/hooks/tool-hooks.ts` with anchored glob matching, shell execution, JSON stdin serialization, and the composed `ToolHookGate` lifecycle handler.
3. Wire one shared effective intervention into `AgentRuntime` and `SubagentTool`, keeping `PermissionGate` available for allow-rule state and UI persistence.
4. Add a fast no-network hook verification suite using real shell commands and SDK tools. Cover payloads, matcher semantics, order, Pre denial wording/short-circuit, permission-before-execution ordering, Post success/error/failure isolation, and the SDK cancelled-call After-event gotcha.
5. Extend subagent verification to prove child calls use the same hook handler, and retain existing config-path permission exemptions as regression assertions.
6. Add the suite to `pnpm test`; run targeted hook/config/subagent checks, `pnpm typecheck`, full `pnpm test`, and `git diff --check`.
7. Run Trellis quality review, update backend SDK/error-handling specs with the executable hook contract, commit with project conventions, push, archive the task, and push the archive commit.

## Risk / rollback points

- Do not register hooks and permissions as independently ordered handlers; SDK After callbacks reverse order and denied Before calls still produce After events.
- Do not let a Post failure throw from `afterToolCall`; that would replace a healthy tool result with a lifecycle failure.
- Do not infer completed execution from `AfterToolCallEvent` alone; mark only calls whose composed Before chain proceeded.
- Keep hook subprocess stdio piped. Inheriting stdout/stderr corrupts the Ink frame.
- Preserve `hooks` in `SESSION_KEYS`; otherwise `/model` silently drops hook configuration for later subagents/config snapshots.
