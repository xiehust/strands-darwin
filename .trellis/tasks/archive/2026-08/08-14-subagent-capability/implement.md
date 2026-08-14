# Subagent capability — implementation plan

1. Add project-agent definition types, built-in `general`, Markdown frontmatter parsing, deterministic scanning, validation, and isolated diagnostics under `src/agents/`.
2. Add a custom `subagent` SDK tool that resolves definitions, creates a fresh child model/Agent per invocation, filters its tools, attaches the shared permission gate, privately drains child execution, returns only the final report, and tracks active children for cancellation/cleanup.
3. Wire the loader/tool into `AgentRuntime.create()` after main initialization so MCP/plugin tool names are known; expose runtime diagnostics, classify delegation itself as safe, and extend runtime cancellation/shutdown for children.
4. Surface invalid agent files in the existing TUI and dev-REPL startup diagnostics without adding a line for valid definitions.
5. Add a fast filesystem/contract suite covering the built-in definition, valid and invalid files, reserved/duplicate names, exact tool restrictions, missing directory, fresh child context, parent isolation, shared permission gating, cancellation, `/model` snapshot behavior, and bash cleanup. Add it to `pnpm test`.
6. Add or extend no-model-call PTY coverage for agent diagnostics and the visible `subagent` tool where practical; add one targeted live scenario proving main-agent delegation and a child permission-gated repository tool call.
7. Document `.darwin/agents/`, the built-in agent, tool allowlists, context isolation, permission behavior, and limitations in README.
8. Run targeted verification, `pnpm typecheck`, `pnpm test`, the relevant free TUI scenario, and the targeted live scenario. Review the diff and run Trellis quality checks.
9. Update backend SDK/error-handling specs with the measured contracts, run final validation, commit with the project convention, push `main`, and archive the Trellis task in a follow-up task commit if the repository workflow requires it.

## Validation commands

```bash
pnpm tsx spike/verify-subagents.ts
pnpm typecheck
pnpm test
pnpm tsx spike/verify-tui.ts completion
AWS_REGION=us-west-2 pnpm tsx spike/verify-subagents-live.ts
```

If implementation touches cancellation or child bash lifecycle in a way the focused suite cannot fully prove, also run:

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts cancelThenContinue
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts bashExit
```

## Risk and rollback points

- Do not use SDK `Agent.asTool()` unless a probe disproves event forwarding; its current implementation deliberately forwards child stream events and violates the context boundary.
- Build the child catalogue from initialized main tools so MCP/plugin tools are real, but never give the child the `subagent` tool.
- Share the `PermissionGate`, not merely its config snapshot; otherwise session allow-rules and prompts can diverge.
- Never directly invoke child environment tools to perform work; only the child SDK loop may call them, ensuring interventions execute.
- Cleanup is resource-specific and best-effort. Do not disconnect shared MCP clients from child cleanup.
- Keep valid-agent UI silent to protect the fixed TUI frame height; only skipped files add warnings.
