# Editable input cursor and mouse positioning

## Goal

Make Darwin's prompt editor behave like a conventional multiline text input: the user can move the insertion cursor with the keyboard, edit at that position, and click within the visible prompt to reposition it.

## Background

- `src/tui/App.tsx:65-74` stores only the draft string; it has no cursor offset today.
- `src/tui/App.tsx:436-447` reserves Up/Down for slash completion and always deletes the final character.
- `src/tui/InputBox.tsx:4-5` explicitly implements append/backspace-only editing and draws a synthetic cursor only at the end.
- Ink 7.1.1 exposes keyboard arrows, Home, End, Delete, element measurement, and terminal cursor positioning, but no mouse event API. Mouse clicks therefore require a small SGR mouse-protocol adapter with explicit setup and teardown.
- Enabling standard terminal mouse reporting changes native mouse selection behavior in many terminals; Shift-drag commonly bypasses application mouse capture.

## Requirements

1. Track a cursor boundary within the canonical LF draft and keep it valid across typing, paste, completion, submission, and draft clearing.
2. Insert printable text and paste at the cursor rather than always appending.
3. Support conventional keyboard editing:
   - Left/Right move one user-visible character boundary.
   - Home/End move to the current visible row boundary.
   - Up/Down move between explicit or terminal-wrapped visible rows while preserving the intended column; when slash completions are visible, they retain Up/Down ownership.
   - Backspace removes the character before the cursor; Delete removes the character after it.
4. Render the cursor at its actual input position on every logical line, including the end of the draft and empty lines.
5. A primary-button click on a visible input row moves the cursor to the nearest valid character boundary on that row. Clicks outside the editable input, during a permission prompt, or while the input is disabled do nothing.
6. Mouse tracking must be disabled on normal unmount/exit so the shell cannot be left receiving mouse-report escape sequences.
7. Preserve existing Enter, Ctrl+J, trailing-backslash continuation, slash completion, paste normalization, permission ownership, Ctrl+C, and Ctrl+D behavior.
8. Add no new runtime dependency unless implementation evidence shows the protocol cannot be handled safely in-project.

## Acceptance Criteria

- [ ] Given a one-line draft, Left/Right/Home/End visibly reposition the cursor and subsequent typing inserts at that position.
- [ ] Backspace and Delete remove text on the correct side of the cursor, including around LF boundaries.
- [ ] In multiline and terminal-wrapped input, Up/Down move to the nearest valid position on the adjacent visible row; slash completion navigation remains unchanged.
- [ ] Unicode input never leaves the cursor inside a surrogate pair or combining sequence, and wide characters render/click-map by terminal cell width.
- [ ] Clicking before, within, or after visible input text places the cursor at the nearest valid boundary; unrelated screen clicks do not alter the draft.
- [ ] Paste inserts at the cursor and never submits; Enter/Ctrl+J/continuation behavior remains covered by the real PTY suite.
- [ ] Permission prompts continue to own all keyboard and paste input, and mouse clicks cannot mutate the hidden draft while one is pending.
- [ ] Exiting Darwin restores terminal mouse mode, including the tested clean-exit path.
- [ ] `pnpm typecheck`, `pnpm test`, and the relevant zero-model PTY scenarios pass.

## Out of Scope

- Selecting or copying output text inside Darwin.
- Mouse drag selection, double-click word selection, hover, scrolling, or clickable history/tool panels.
- Command-history recall and undo/redo.
- Editing completed user or assistant messages.

## Key Decisions

- Use standard SGR mouse click tracking for broad terminal compatibility. While Darwin is running, users hold Shift while dragging when they need the terminal's native text selection.
- Treat terminal-wrapped portions of long logical lines as visible editor rows: Up/Down and mouse hit-testing follow what the user sees, including after terminal resize.
- Keep copy/selection behavior out of Darwin; this task changes only prompt cursor movement and click positioning.
