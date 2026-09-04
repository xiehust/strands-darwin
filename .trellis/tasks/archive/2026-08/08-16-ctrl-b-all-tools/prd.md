# Expand Ctrl+B tool details

## Goal

Make `Ctrl+B` a consistent session-local compact/expanded control for every TUI tool call, so users can inspect ordinary bash, file editing, skills, MCP, subagents, image reads, and future tools without a background-bash-only shortcut model.

## Background and Confirmed Facts

- `Ctrl+B` currently dispatches `toggleBackgroundDetails` after permission-prompt keyboard ownership and before editor commands (`src/tui/App.tsx:541`). It is display-only and preserves the draft.
- The reducer stores `backgroundDetailsExpanded`; only recognized background `bash` lifecycle calls consult it (`src/tui/turn-state.ts:98,222`). Ordinary tools always retain the same summary and render at most four preview lines.
- Running tool rows contain an ordinary one-line summary; background calls additionally retain a compact summary. Completed tool entries contain a summary and full textual preview, but `ToolCallResult` always collapses that preview to four lines (`src/tui/ToolCallPanel.tsx:47-103`).
- Completed history uses Ink `<Static>` and is written once to terminal scrollback (`src/tui/MessageList.tsx:4-24`). A later toggle cannot rewrite already-printed calls without replacing the project's load-bearing static-history architecture.
- The prior background-monitoring contract deliberately applies a toggle to active and subsequent calls while leaving printed scrollback unchanged.

## Requirements

- Rename the state/action/UI terminology from background details to tool details.
- `Ctrl+B` continues to work while idle or streaming, remains subordinate to permission-prompt keyboard ownership, and never edits/submits the draft or starts a model turn.
- Compact remains the default for every new TUI session; the preference is not persisted.
- The mode applies immediately to every active tool row and controls every tool result that completes after the selection.
- Preserve the specialized compact projections for background lifecycle calls, including successful poll suppression and concise child output.
- For all other tools, compact mode preserves today's one-line call summary and status-aware head/tail policy, but bounds result previews by both line count and Unicode code-point count so a minified JSON line cannot bypass truncation.
- Truncation must preserve complete Unicode code points and include an explicit marker stating that content was omitted.
- Expanded mode exposes bounded tool input and a substantially larger bounded result preview for ordinary built-in, MCP, plugin, subagent, and future tools without changing model-visible tool input/output.
- Expanded input is limited to 8,000 Unicode code points and 100 lines; expanded result is limited to 32,000 code points and 200 lines.
- Already-rendered `<Static>` scrollback remains unchanged.
- Errors and denials remain visible and actionable in either mode.
- Add no dependency and change no SDK loop, permission, tool, session, or trajectory contract.

## Acceptance Criteria

- [x] `Ctrl+B` reports `tool details: expanded|compact` and preserves an existing draft without a model call.
- [x] An active non-background tool visibly changes between compact and expanded presentation.
- [x] A non-background result completing in compact mode retains the current status-aware four-line head/tail policy and truncates an oversized single-line JSON preview by Unicode code points.
- [x] A non-background result completing in expanded mode renders bounded input plus a larger bounded result preview, including explicit truncation markers when either cap is reached.
- [x] Background lifecycle compact/suppression behavior and expanded full-result behavior remain compatible.
- [x] Permission prompts retain exclusive keyboard ownership; errors and denials remain visible.
- [x] Calls already written through `<Static>` are not duplicated or rewritten after a toggle.
- [x] Focused reducer/rendering tests, zero-model pty coverage, `pnpm typecheck`, and `pnpm test` pass.

## Out of Scope

- Rewriting terminal scrollback or replacing Ink `<Static>` history.
- Persisting the display preference across runs.
- Changing model-visible tool data, tool execution, permission policy, or headless output.
- Per-tool expansion state or mouse-driven disclosure.

## Key Decisions

- Compact result previews are bounded by the existing four-line status-aware policy and 2,000 Unicode code points.
- Expanded mode shows tool input and result. Input is bounded to 8,000 code points and 100 lines; result is bounded to 32,000 code points and 200 lines.
- Bounds are presentation-only. The model, SDK loop, hooks, trajectory, and session retain their existing full-fidelity contracts.
- Success keeps the beginning, errors keep the diagnostic tail, and denials keep their leading `DENIED:` reason plus the tail. Every truncation is explicitly marked.
- The mode in effect when a call completes is stored on that immutable history item. Later toggles affect active and future calls, never rewrite printed scrollback.
