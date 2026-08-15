# Optimize developer background monitoring UI

## Goal

Keep the terminal readable while the built-in developer supervisor monitors a headless child. Repeated background-task polling must no longer turn transient lifecycle metadata into a growing wall of raw JSON, while failures, meaningful child output, and explicit task inspection remain visible.

## Background

- The developer workflow intentionally uses repeated `bash status` and incremental `bash output` calls; removing that monitoring would weaken its lifecycle and output-draining guarantees.
- The TUI currently turns every completed tool call into immutable `<Static>` history. Successful `bash status` results therefore retain their full status JSON, and repeated polls accumulate permanently.
- In-flight calls already render in the live tool panel and disappear when complete. `/tasks` separately provides an explicit local report of all current-run background jobs, and terminal task transitions already append concise completion notices.
- The repository currently contains unrelated uncommitted work, including changes in `src/tui/App.tsx`, `src/agent/runtime.ts`, and `spike/verify-tui.ts`; implementation must preserve those changes and keep this task's edits narrowly scoped.

## Requirements

### R1 — Concise lifecycle presentation

- Concise rendering applies consistently to all background `bash` lifecycle modes (`start`, `list`, `status`, `output`, and `stop`), not only to the built-in developer workflow.
- Successful background `bash` lifecycle monitoring must not append repetitive raw status/result JSON to permanent transcript history.
- The user must retain a bounded indication that monitoring is active while a lifecycle tool call is in flight.
- `Ctrl+B` toggles background-tool detail mode between compact (default) and expanded, with an immediate visible notice of the selected mode. It changes the active and subsequent background-tool rendering without submitting or altering the prompt draft; already-printed terminal scrollback remains unchanged.
- Background task ids shown by default should use the existing short-id presentation where practical; full manager data remains available to the agent and through explicit inspection.

### R2 — Preserve meaningful evidence

- Non-empty child process output read through `bash output` must remain visible in a human-readable form without surrounding cursor/path metadata dominating the transcript.
- Errors and denied lifecycle calls must remain visible and actionable; concise mode must not hide failures.
- Background start and terminal transitions must remain understandable, without changing manager ownership, process cleanup, or developer session identity.
- `/tasks` must continue to provide the explicit current-run task report while idle or streaming.

### R3 — Compatibility and scope

- Keep the SDK agent loop and the developer skill's required `start`/`status`/`output` monitoring behavior unchanged; this task changes presentation, not orchestration.
- Preserve ordinary foreground `bash execute` results and non-background tool rendering.
- Add no dependency and do not overwrite unrelated working-tree changes.

## Acceptance Criteria

- [x] AC1: Repeated successful `bash status` calls for one running task do not create repeated permanent JSON blocks in the terminal transcript.
- [x] AC2: While a monitoring call is active, the live frame shows one bounded status row rather than recursively growing history.
- [x] AC3: A `bash output` result with child text shows that text concisely; an empty successful poll does not add noise.
- [x] AC4: The chosen keyboard chord toggles compact/expanded background-tool details without submitting or altering the prompt draft, and the TUI reports the new mode.
- [x] AC5: Failed or denied lifecycle calls remain in history with an error indication and useful diagnostic content in both modes.
- [x] AC6: Background start/completion and `/tasks` remain understandable, and foreground bash plus other tools retain their existing rendering behavior.
- [x] AC7: Focused formatting/reducer checks, real-pty TUI coverage, `pnpm typecheck`, and the network-free `pnpm test` suite pass.

## Out of Scope

- Changing how often the model polls, replacing polling with a new scheduler/IPC protocol, or changing background process ownership.
- Exposing child reasoning or streaming a headless child's live internal TUI.
- Persisting background jobs across Host restarts or redesigning `/tasks`.
