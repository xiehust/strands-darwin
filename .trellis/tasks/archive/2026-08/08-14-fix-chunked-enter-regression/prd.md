# Fix chunked Enter multiline regression

## Goal

Restore reliable one-line submission after multiline input support: when a terminal/pty batches printable text with Enter as a trailing CRLF, darwin must submit the text instead of appending a newline and leaving the turn stuck in the draft.

## Confirmed evidence

- `TuiSession.submit()` writes one chunk as `<text>\r`, but terminal line discipline may deliver `<text>\r\n` to Ink.
- Ink 7's input parser deliberately does not split CR or tab from a non-escape chunk. `parseKeypress("text\r\n")` therefore yields `key.return === false` and the whole sequence as `typed`.
- `App.tsx` recognizes only a batched trailing `\r`. A trailing `\r\n` falls through to `normalizeDraftText()`, becomes `\n`, and renders an empty `...>` continuation line instead of starting the turn.
- The failure reproduced in model-driven `bashExit` / `cancelThenContinue` scenarios; the screen stopped at the submitted text plus `...>` and never showed `working…`.

## Requirements

- Treat a non-single-key `useInput` payload ending in CRLF as printable text followed by one submit action, matching the existing trailing-CR behavior.
- Preserve the preceding payload exactly under the existing draft normalization rules.
- Preserve trailing-backslash continuation semantics for batched CR and CRLF input.
- Do not change LF/Ctrl+J insertion, bracketed paste behavior, ordinary single-key Enter, completion acceptance, or permission-prompt keyboard ownership.
- Add a deterministic real-pty regression that sends text plus CRLF in one write and proves it is submitted rather than appended as a continuation.

## Acceptance Criteria

- [x] A single pty write containing `/exit\r\n` exits cleanly instead of rendering `...>`.
- [x] A single pty write containing printable text plus CRLF submits exactly once (proved with the local `/exit` command, so no model call can mask the event boundary).
- [x] Batched text ending in `\\` plus a line terminator inserts a continuation newline and does not submit.
- [x] Existing multiline and completion scenarios pass.
- [x] `pnpm typecheck` and `pnpm test` pass.
