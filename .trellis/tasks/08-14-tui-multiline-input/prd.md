# Support multiline TUI input

## Goal

Let users compose prompts containing multiple lines without losing pasted content or changing the familiar Enter-to-send behavior.

## Background

- `src/tui/App.tsx` currently treats the first newline in an input chunk as submit and drops the remainder.
- `src/tui/InputBox.tsx` is explicitly single-line and renders the draft as one prompt row.
- Ink 7.1.1 provides `usePaste`, which enables bracketed paste mode and delivers the complete pasted string, including newlines, separately from key events.

## Requirements

- Preserve complete multiline pasted text in the draft, normalizing terminal CRLF/CR line endings to LF while removing unsafe non-text control characters.
- Render every draft line in the input box, with a clear continuation prefix and the cursor after the final line.
- Keep plain Enter as submit and preserve existing slash-completion behavior.
- Support explicit manual newline insertion through Ctrl+J and a trailing backslash followed by Enter; the continuation backslash is replaced by the newline.
- Keep keyboard ownership with the permission prompt while it is visible.
- Preserve existing typing-during-streaming and busy-turn behavior.

## Acceptance Criteria

- [x] Bracketed paste containing at least two lines appears completely in the live input box and does not submit automatically.
- [x] Ctrl+J inserts a visible newline without submitting.
- [x] Backslash + Enter inserts a visible newline, removes the backslash marker, and does not submit.
- [x] Plain Enter still submits, including the existing local `/exit` path.
- [x] Backspace can remove characters/newlines from the multiline draft using the existing append-only editor behavior.
- [x] `pnpm typecheck`, `pnpm test`, and a dedicated real-pty multiline scenario pass.

## Out of Scope

- Cursor movement, selection, or insertion in the middle of the draft.
- Input history navigation.
- Changing the readline-based development REPL.
- Adding a third-party text-editor dependency.
