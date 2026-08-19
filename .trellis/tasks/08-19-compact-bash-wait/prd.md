# Compact repeated bash wait TUI rows

## Goal

Keep repeated background `bash wait` calls legible in the TUI by showing only the information that changed, rather than repeatedly printing the wait result's full status snapshot and background command.

## Background

- `BackgroundBashManager.wait()` returns `{ reason, status, output }`. The nested `status.command` may contain a very large command and is repeated on every wait result.
- Compact background-tool presentation currently recognizes `start`, `list`, `status`, `output`, and `stop`, but not `wait` (`src/tui/background-tool-presentation.ts`). Therefore successful waits use the ordinary bounded JSON preview shown in `image.png`.
- This is a presentation-only change. The provider-facing result, manager behavior, tool input, transcript recording, and expanded tool-detail mode must remain unchanged.

## Requirements

- Recognize `bash` calls with `mode: 'wait'` as background lifecycle calls.
- In compact mode, show an active wait as a bounded short-task-id row.
- For a successful wait with non-empty incremental output, retain that output in concise tool history without status, command, path, cursor, or timeout metadata.
- Suppress successful waits that have no incremental output while the task remains running, including timeout/change observations.
- When a successful wait observes terminal task state with no output, retain one concise terminal-state row.
- Preserve the ordinary bounded diagnostic fallback for malformed successful payloads and all denied/error results.
- Expanded mode must continue to show the ordinary bounded input and full successful result projection.
- Do not coalesce or discard distinct non-empty output chunks; each is newly consumed output and belongs in history.

## Acceptance Criteria

- [x] Compact active rows render `bash wait: <short-id>` rather than the full task UUID.
- [x] Repeated valid running waits with empty output add no `<Static>` history entries.
- [x] Valid non-empty wait output appears without repeated `status.command`, paths, offsets, or raw JSON wrapper.
- [x] A terminal wait with no output produces a concise row naming the task and terminal state.
- [x] Malformed, denied, and error wait results remain visible and diagnostic.
- [x] Expanded mode and foreground bash rendering retain their existing behavior.
- [x] Focused background-tool UI checks, `pnpm typecheck`, and the fast test suite pass.

## Out of Scope

- Changing wait polling, cursor consumption, timeout limits, process cleanup, or provider-visible tool results.
- Combining separate non-empty output chunks or changing the output emitted by the background process.
- Adding a new live-frame surface or altering trajectory/replay formats.
