# PRD — `/workflow` built-in command: prompt-style trigger for the workflow DAG tool

## Background

darwin already ships a parent-only `workflow` tool (`src/agents/workflow-tool.ts`): a bounded
data-only DAG (≤8 nodes) of subagent tasks executed by the SDK `Graph`. Today only the model
decides to call it. The user wants a way to *actively* steer a turn toward workflow-style
delegation from the prompt line.

Decision (user, 2026-08-30): **option A — prompt-style trigger.** `/workflow <task description>`
wraps the description into a prompt that explicitly instructs the model to orchestrate the task
with the `workflow` tool, and sends it through the ordinary submit path. The model still owns
DAG decomposition. No new execution channel: the command never constructs nodes, never calls
`WorkflowTool` directly, and never bypasses permission/plan gating.

## Requirements

R1. `/workflow <task description>` becomes a built-in slash command. With a non-empty argument
    it expands into one prompt (the wrapped description + explicit instruction to use the
    `workflow` tool, including the reads-parallel / writes-serialized guidance) and is sent as
    an ordinary user turn.
R2. Expansion lives at the runtime layer (like skill / custom-command expansion), so the TUI,
    headless `--prompt`, and dev-repl all honour it identically.
R3. Bare `/workflow` (no argument, or whitespace only) is a local bounded usage notice — no
    model call, no turn.
R4. Discoverability: the name appears in the slash-completion menu with a one-phrase
    description, in `/help`'s command inventory, and is reserved against custom commands and
    skills (all three derive from `BUILTIN_COMMAND_NAMES` / `RESERVED_COMMAND_NAMES`).
R5. `MAX_COMPLETIONS` grows with the new built-in (19 → 20) so the menu keeps every built-in
    visible (AGENTS.md contract).
R6. Ordinary-prompt semantics everywhere else: while busy it queues like any prompt (SER-027,
    it is not on the refuse list), the trajectory records it exactly as other expanded
    commands are recorded, and prompt recall / replay need no new cases.

## Non-goals

- No `/workflow <JSON DAG>` direct-execution mode (option B, explicitly rejected).
- No change to `WorkflowTool` itself, its bounds, or its child recipe.
- No new live-frame surface, no new trajectory record type.

## Acceptance criteria

A1. `pnpm typecheck` and `pnpm test` pass.
A2. `spike/verify-tui.ts completion` (free) passes with the grown menu: every built-in
    including `/workflow` visible.
A3. `verify-help-command.ts` still proves help lists all built-ins (total-by-construction
    Record makes a missing description a compile error).
A4. Typing `/workflow do X` sends exactly one expanded prompt through the ordinary submit
    path; the expansion text names the `workflow` tool and embeds the user's description
    verbatim.
A5. Bare `/workflow` produces a local usage notice and no model call.
A6. A custom command or skill named `workflow` is rejected as colliding with a built-in.
