# Background task monitoring

## Goal

Make session-owned background bash work visible to both the user and the agent: users can inspect all jobs with `/tasks`, terminal completion is surfaced without disrupting the active turn, and the agent can list the registry instead of needing an id it may no longer have in context.

## Background

- `BackgroundBashManager` already owns an in-memory, session-scoped task map with command, state, timestamps, exit metadata, and retained logs. It exposes `status`, `output`, and `stop` only by id (`src/tools/background-bash.ts`).
- Main and child agents share one manager and wrapped `bash` tool, so that map already represents all jobs started during the current runtime.
- TUI transcript notices are dim, completed history entries rendered through `<Static>`. They can be appended while a model turn streams without invoking or cancelling the agent loop (`src/tui/App.tsx`, `src/tui/turn-state.ts`, `src/tui/MessageList.tsx`).
- Task control is intentionally not restored by `--resume`; retained logs are diagnostics, not resumable process ownership.

## Requirements

### R1 — Agent-side task listing

- Extend the existing `bash` tool with a safe `list` mode that requires no task id and returns snapshots of every task known to the current runtime.
- Each result retains the existing status contract: id, full command, state, start/finish times, exit metadata, PID, log path, and output size.
- Results use deterministic launch order. An empty registry returns an empty list.
- `list` remains inside the existing `bash` boundary so permission rules and tool hooks retain their current semantics; it is a statically safe read operation.

### R2 — User `/tasks` command

- Add `/tasks` as a built-in, completion-visible local TUI command. It never enters the model loop and accepts no arguments.
- `/tasks` works while idle and while a turn is streaming because it only reads runtime-owned metadata; it must not cancel, pause, replace, or enqueue an agent turn.
- The report lists every current-runtime task with id, a concise single-line command summary, state, and elapsed duration. Running duration ends at the report time; terminal duration ends at `finishedAt`.
- Empty state is explicit. Command text is whitespace-normalized and bounded for readable terminal output; the underlying agent-side list keeps the full command.
- Like the current task registry, `/tasks` does not claim to recover jobs from a resumed process.

### R3 — Terminal completion notices

- The manager exposes a subscription boundary for task state changes, and emits exactly one terminal event when a registered task becomes `succeeded`, `failed`, or `stopped`.
- The TUI subscribes for its mounted lifetime and renders each terminal event as a dim transcript notice containing task id, concise command summary, terminal state, and elapsed duration. Failure notices also expose exit code or signal when available.
- A notice arriving during a streaming/permission-blocked turn must not invoke cancellation or mutate the turn status; the existing model/tool stream continues uninterrupted.
- A notice arriving while idle must trigger a render immediately without waiting for keyboard input or another turn.
- Unmount unsubscribes. Runtime shutdown may stop tasks, but normal TUI exit must not create misleading user-facing notices after the UI has unmounted.

### R4 — Compatibility and documentation

- Existing start/status/output/stop, foreground bash, permissions, hooks, subagents, process-group cleanup, logs, and shutdown behavior remain compatible.
- Add no dependency or persisted/config schema.
- README documents `bash list`, `/tasks`, completion notices, current-runtime scope, and retained-log/resume limits.

## Acceptance Criteria

- [x] AC1: `bash({ mode: 'list' })` returns all current-runtime tasks in launch order, with full existing status metadata; no id is required, empty returns `[]`, and permission classification is safe/read.
- [x] AC2: `/tasks` appears in slash completion and reports id, bounded command summary, state, and elapsed duration for running and terminal jobs without a model call; extra arguments produce an actionable notice.
- [x] AC3: `/tasks` can be submitted during a streaming turn and the turn still reaches its normal completion.
- [x] AC4: success, non-zero failure, and explicit stop each produce exactly one dim terminal notice with state and elapsed time; failure includes available exit metadata.
- [x] AC5: completion during streaming is shown without cancelling or ending that turn, and completion while idle appears without further input.
- [x] AC6: subscriptions are cleaned up on unmount; listing/notification additions do not weaken task ownership, bounded shutdown, or process-exit cleanup.
- [x] AC7: focused background-manager and task-monitor tests, `pnpm typecheck`, `pnpm test`, and relevant real-pty TUI scenarios pass.
- [x] AC8: README and backend/frontend specs record the final API, notification, timing, and testing contracts.

## Out of Scope

- Restoring task control or notifications after `--resume`; cross-process/global task lists.
- Tailing output in `/tasks`, log viewers, filtering, sorting controls, cancellation from the `/tasks` UI, progress percentages, resource metrics, scheduling, retries, or log pruning.
- Persisting notification acknowledgement state or replaying notifications from retained logs.
- Changing process ownership, stop escalation, or exit fallback behavior beyond regressions needed to preserve them.
