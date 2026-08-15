# SER-001 enforced planning mode

## Goal

Add a technically enforced planning permission mode so users can let Darwin inspect a repository and delegate read-only research without allowing mutation or command execution.

## Background

Darwin already routes parent and child tool calls through one SDK intervention and classifies each call by `(toolName, input)` as `read`, `write`, or `execute`. The public permission modes are selected through global config or `--permission-mode`; the runtime records the effective post-override mode for user-facing diagnostics. SER-001 extends those existing seams rather than adding a prompt convention, sandbox, or custom agent loop.

The Host-selected public value is `plan`: `permissionMode: "plan"` and `--permission-mode plan`.

## Requirements

- Add `plan` to the existing approval-mode type, config validation, CLI parser, usage text, and user documentation. Preserve `default` as the default and preserve the existing `--yolo` precedence contract.
- In `plan`, calls classified as `read` proceed through the existing permission intervention.
- In `plan`, calls classified as `write` or `execute` are denied deterministically with actionable, mode-specific wording.
- Plan denials happen before static-risk approval, allow-rule matching, classifier invocation, and permission prompting. Neither persisted nor session allow rules can bypass them.
- Unknown and MCP tools remain fail-closed because the existing classifier treats them as `execute`.
- The same intervention instance enforces plan mode for child agents; read-classified `subagent` delegation may proceed, but child writes and executes may not.
- When configured tool hooks are present, a plan-blocked call is denied before any `PreToolUse` shell command. Existing Pre -> permission -> body -> Post ordering remains unchanged for calls not blocked by plan mode and for every other permission mode.
- The TUI header identifies the effective mode and explains its read-only effect without adding a new header row. Loaded allow rules must not be presented as effective bypasses in plan mode.
- Headless stderr identifies the effective post-override mode with a stable bounded diagnostic.
- Keep `AgentRuntime.create` as the only thin SDK Agent assembly and keep enforcement in `PermissionGate` plus the existing composed `ToolHookGate`; do not fork or intercept the SDK loop.
- Do not add dependencies, alter unrelated behavior, or modify the Host-authored research report/backlog outcome fields.

## Acceptance Criteria

- [x] `permissionMode: "plan"` loads successfully and `--permission-mode plan` parses for interactive and headless runs.
- [x] `--yolo` retains its documented precedence when supplied with a permission-mode value.
- [x] Read-classified calls proceed in plan mode.
- [x] Write- and execute-classified calls deny with actionable wording even when statically safe, covered by an allow rule, paired with an approving bridge, or paired with a classifier that would approve.
- [x] Plan-denied calls make zero permission-bridge calls and zero classifier calls.
- [x] Plan-denied calls execute no configured Pre/Post hook process and no tool body.
- [x] A child agent uses the shared intervention: its execute call is denied without prompting and its tool body does not run.
- [x] TUI and headless diagnostics identify effective mode `plan`; a CLI override is visibly authoritative over config.
- [x] Focused config, permission, hook, child-agent, headless, and pty checks pass.
- [x] `pnpm typecheck`, `pnpm test`, and `git diff --check` pass.
- [x] Backend/frontend specs and README/AGENTS guidance describe the implemented contract.
- [x] `docs/iteration-log.md` records Batch 5 honestly, with Host acceptance pending.

## Out of Scope

- OS/container sandboxing, network isolation, or filesystem virtualization.
- A new planning system prompt, slash command, runtime mode switch, or separate SDK loop.
- Reclassifying existing tools or making arbitrary bash commands safe.
- Parallel/inspectable subagent work from SER-002.
- Final edits to the Host-owned SER research/backlog outcome evidence.

## Constraints

- Existing unrelated working-tree changes in `docs/research/` must remain untouched.
- Every edited file must be read first.
- One Trellis task owns PRD, design, implementation, check, spec-update, and commit phases.
- No network commands, dependency installation, push, or history rewrite.
