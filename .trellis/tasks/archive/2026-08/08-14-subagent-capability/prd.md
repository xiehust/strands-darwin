# Add subagent capability

## Goal

Give darwin a delegation tool that lets the main agent send a bounded task to an isolated child agent, keep the child’s working conversation out of the main conversation, and return only the child’s final report. Projects can add specialist definitions under `.darwin/agents/`, while every installation has a useful built-in general agent.

## Background and confirmed constraints

- `src/agent/runtime.ts` is the only production assembly point for SDK `Agent` instances; the SDK loop must remain unmodified.
- Strands SDK 1.12.0 supports agents-as-tools, but its adapter forwards child stream events through the parent tool stream. Darwin needs a stricter boundary that returns only the final child result.
- `PermissionGate` is an SDK `InterventionHandler` and can be attached to child agents. The same gate must govern parent and child environment tool calls so approval mode, in-session rules, persisted rules, and the UI permission queue remain consistent.
- Project state is rooted at the CLI working directory through `.darwin/`.

## Requirements

### R1 — Main-agent delegation tool

- The main agent has one `subagent` tool accepting a required natural-language task and an optional agent name.
- Omitting the name selects the built-in `general` agent.
- The tool description exposes the accepted agent names and descriptions so the main model can choose a specialist.
- Calling `subagent` itself does not require a permission prompt; it performs no project I/O. Any child environment tool call is evaluated separately by the normal permission gate.

### R2 — Isolated child execution

- Every dispatch creates a fresh child `Agent` and model using the runtime’s currently active model configuration.
- A child receives only its system prompt, project instructions, available tool catalogue, and the delegated task. It receives no parent messages and has no session manager or persisted conversation.
- The parent receives only the child’s final textual result (or a concise error); child reasoning, model deltas, intermediate messages, and tool transcript are not copied into parent history.
- Child agents cannot dispatch further child agents in this MVP.
- Multiple dispatches are independent, including repeated use of the same definition.

### R3 — Project-defined agents

- Darwin scans direct Markdown files under `<projectRoot>/.darwin/agents/` at startup.
- Each file uses YAML frontmatter with required `name` and `description`, optional `tools`, and a non-empty Markdown body as the child system prompt.
- Names use the SDK tool-name grammar, are unique case-insensitively, and cannot shadow the built-in `general` agent.
- `tools` is an exact, case-sensitive allowlist of registered environment tool names. Omitting it grants all child-eligible tools; an empty list grants none. The `subagent` tool is never child-eligible.
- Unknown or malformed tool allowlists, invalid metadata, unreadable files, empty prompts, and duplicate names skip only that file. Accepted definitions continue to load and skipped files are surfaced as startup diagnostics.
- An absent `.darwin/agents/` directory is normal and silent.

### R4 — Built-in general agent

- A built-in `general` definition is always available without project configuration.
- Its prompt is suitable for repository exploration and self-contained delegated coding/research tasks, and instructs it to return a concise, evidence-based report.
- It can use all child-eligible tools, subject to permission policy.

### R5 — Permission, cancellation, and resource safety

- Child calls to `bash`, `fileEditor`, skill tools, and MCP tools pass through the same `PermissionGate` instance and therefore the same approval mode and allow-rules as the parent.
- Tool restrictions reduce a child’s registered tools; they never grant permission or bypass the gate.
- Parent cancellation propagates to an active child. Pending child permission prompts can be denied by the existing cancellation path.
- Child-owned persistent bash sessions are reaped after each dispatch and again during runtime shutdown on a best-effort basis. Shared MCP clients remain owned and disconnected by the main runtime.

### R6 — Documentation and compatibility

- README documents the delegation tool, built-in agent, custom Markdown format, tool restriction semantics, isolation boundary, and permission behavior.
- Existing sessions, skills, slash commands, MCP configuration, model switching, prompt caching, and permission modes continue to work.
- No dependency or configuration migration is introduced.

## Acceptance Criteria

- [x] AC1: With no `.darwin/agents/` directory, runtime startup exposes exactly one built-in `general` definition through a callable `subagent` tool.
- [x] AC2: A valid custom Markdown file is discovered and selectable; malformed, duplicate, reserved, unreadable, empty, and unknown-tool definitions are isolated and reported without preventing startup.
- [x] AC3: Two dispatches start with fresh child histories, and parent history contains the delegated task plus final tool result but none of the child’s intermediate conversation or tool transcript.
- [x] AC4: A child with unrestricted tools can read/search the repository and return an evidence-based summary; a restricted child sees only its allowlisted tools, while `tools: []` sees none.
- [x] AC5: In `default` permission mode, a child read follows static safe rules, a child write/execute reaches the existing permission bridge, denial prevents the operation, and approval permits it. `auto`, persisted/session rules, and `yolo` retain their existing semantics because all calls use the same gate.
- [x] AC6: Cancelling a turn while a child is active cancels child execution, releases pending approval waits, and leaves the session usable; completed/cancelled children do not leave a persistent bash process owned by the child.
- [x] AC7: `/model` changes affect later child dispatches without changing already-running children or parent conversation history.
- [x] AC8: `pnpm typecheck`, `pnpm test`, focused subagent verification, and relevant no-model-call TUI coverage pass; at least one live model verification demonstrates main → child delegation and a permission-gated child tool call.
- [x] AC9: README and `.trellis/spec/` record the final custom-agent, isolation, permission, cancellation, and cleanup contracts.

## Out of scope

- Recursive child delegation, child-to-child handoff, durable/background children, resumable child sessions, child progress streaming into the main transcript, per-agent model/provider overrides, per-agent permission modes, and hot reload of `.darwin/agents/`.
- A graph/swarm scheduler or automatic multi-step task planner beyond model-chosen calls to the single `subagent` tool.
