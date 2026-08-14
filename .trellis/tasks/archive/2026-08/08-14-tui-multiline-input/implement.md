# Implementation plan: multiline TUI input

1. Add text normalization and distinct paste handling in `src/tui/App.tsx`.
2. Add Ctrl+J and trailing-backslash continuation handling while preserving Enter submit and slash completion.
3. Render multiline drafts with continuation prefixes in `src/tui/InputBox.tsx`.
4. Add a zero-model-call real-pty scenario covering paste, Ctrl+J, backslash+Enter, rendering, backspace across a newline, and plain Enter through `/exit`.
5. Run `pnpm typecheck`, `pnpm test`, and the dedicated pty scenario; also run the existing completion scenario because Enter/completion handling shares the changed branch.
6. Review the diff, update the frontend TUI spec with the established input contract, then commit and push.

## Risk and rollback points

- Bracketed paste depends on the terminal honoring Ink's mode; the pty scenario must send explicit bracket markers rather than only writing raw newline chunks.
- Ctrl+J and LF share byte `0x0a`; test the actual pty behavior before treating Ink key metadata as stable.
- Input-box height can affect permission rendering; the multiline scenario stays model-free, while the existing completion test guards adjacent rendering behavior.
