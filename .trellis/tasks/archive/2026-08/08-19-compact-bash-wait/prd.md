# Compact repeated bash wait TUI rows

## Goal

Keep background `bash wait` polling ephemeral in compact TUI mode, so successful polls do not fill scrollback while terminal state remains visible. Also prevent a dependent workflow from falsely treating a bounded running-task timeout as a handoff point: terminal-focused waits may remain attached for a practical bounded interval, and a still-running timeout explicitly tells the model to wait again before ending the turn.

## Background

- `BackgroundBashManager.wait()` returns `{ reason, status, output }`. The nested `status.command` may contain a very large command and is repeated on every wait result.
- Compact background-tool presentation currently recognizes `start`, `list`, `status`, `output`, and `stop`, but not `wait` (`src/tui/background-tool-presentation.ts`). Therefore successful waits use the ordinary bounded JSON preview shown in `image.png`.
- This is a presentation-only change. The provider-facing result, manager behavior, tool input, transcript recording, and expanded tool-detail mode must remain unchanged.

## Requirements

- Recognize `bash` calls with `mode: 'wait'` as background lifecycle calls.
- In compact mode, show an active wait as a bounded short-task-id row.
- In compact mode, suppress every valid successful wait while the observed task state remains `running`, whether incremental output is empty or non-empty and regardless of the wait reason.
- When a valid successful wait observes terminal task state, retain exactly one concise short-task-id/state row and suppress its output, if any.
- Preserve the ordinary bounded diagnostic fallback for malformed successful payloads and all denied/error results.
- Expanded mode must continue to show the ordinary bounded input and full successful result projection, including wait output.
- Keep the provider/model-visible tool result unchanged for ordinary and terminal waits; suppression applies only to compact TUI history.
- Preserve output-sensitive waits at the existing 30-second maximum, but allow explicit terminal-focused (`wakeOnOutput: false`) waits to use a larger documented finite maximum suitable for test/build completion.
- A terminal-focused wait that reaches its deadline while the task is still `running` must retain `reason: 'timeout'` and add one bounded model-visible instruction: if later work depends on completion, call `bash wait` again before ending the turn because background completion does not resume the agent.
- Do not add automatic model continuation, a background-completion model call, an unbounded wait, or any TUI status ownership change.

## Acceptance Criteria

- [x] Compact active rows render `bash wait: <short-id>` rather than the full task UUID.
- [x] Repeated valid running waits add no `<Static>` history entries whether output is empty or non-empty.
- [x] A terminal wait produces exactly one concise row naming the task and terminal state whether output is empty or non-empty.
- [x] Malformed, denied, and error wait results remain visible and diagnostic.
- [x] Expanded mode, foreground bash rendering, and provider/model-visible wait results retain their existing behavior.
- [x] Focused background-tool UI checks and `pnpm typecheck` pass.
- [x] Output-sensitive wait validation remains `[1, 30000]`; terminal-focused wait accepts the documented larger maximum and rejects values above it.
- [x] A terminal-focused `timeout + running` result carries the bounded wait-again/no-auto-resume instruction; terminal, cancelled, shutdown, and output-sensitive results do not.
- [x] Long terminal-focused waits remain promptly cancellable and shutdown-safe, without stopping the background task.
- [x] Focused background-bash and background-tool UI checks, `pnpm test`, `pnpm typecheck`, and `git diff --check` pass.

## Out of Scope

- Changing polling cadence, cursor consumption, process cleanup, or provider-visible output bytes/status data.
- Changing, combining, or discarding wait output in the provider/model-visible tool result.
- Adding a new live-frame surface or altering trajectory/replay formats.
