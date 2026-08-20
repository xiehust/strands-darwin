# Repository findings

- `src/commands/custom-commands.ts` is the canonical ordered built-in name/description inventory; `InputBox` already reads it for completion descriptions.
- `src/tui/App.tsx` handles local transcript reports before the busy guard. A synchronous pure `/help` branch can therefore remain available while `status === 'shell'` without queueing or touching the runtime.
- Notices enter immutable transcript history through the existing `turnReducer`; no component or live-frame budget participant is needed.
- `MAX_COMPLETIONS` is 15 for 15 built-ins. Adding `/help` requires 16, and the free `completion` scenario explicitly asserts each built-in row.
- `useInput` implements Ctrl+J, trailing backslash+Enter, Home/End, Ctrl+A/E/K/U/W, Ctrl+B, Ctrl+C, Ctrl+D, and arrow precedence. `usePaste` inserts all normalized lines and never submits.
- Free busy-state verification can run `!sleep` and invoke `/help` before cancelling it; the queue listing must remain absent.
- README's key table says `/` lists skills and omits path/shell/editor/multiline behavior; Known limitations falsely claims single-line input and first-newline paste submission.
