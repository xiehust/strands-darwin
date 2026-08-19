# Compact repeated bash wait TUI rows

## Goal

Keep background `bash wait` polling ephemeral in compact TUI mode, so successful polls do not fill scrollback while terminal state remains visible.

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
- Keep the provider/model-visible tool result unchanged; suppression applies only to compact TUI history.

## Acceptance Criteria

- [x] Compact active rows render `bash wait: <short-id>` rather than the full task UUID.
- [x] Repeated valid running waits add no `<Static>` history entries whether output is empty or non-empty.
- [x] A terminal wait produces exactly one concise row naming the task and terminal state whether output is empty or non-empty.
- [x] Malformed, denied, and error wait results remain visible and diagnostic.
- [x] Expanded mode, foreground bash rendering, and provider/model-visible wait results retain their existing behavior.
- [x] Focused background-tool UI checks and `pnpm typecheck` pass.

## Out of Scope

- Changing wait polling, cursor consumption, timeout limits, process cleanup, or provider-visible tool results.
- Changing, combining, or discarding wait output in the provider/model-visible tool result.
- Adding a new live-frame surface or altering trajectory/replay formats.
