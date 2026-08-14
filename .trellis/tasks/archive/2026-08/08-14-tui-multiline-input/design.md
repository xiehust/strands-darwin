# Design: multiline TUI input

## Boundaries

The draft remains a single `string` owned by `App`. Newlines are canonical `\n`; the runtime and message history already accept arbitrary strings, so only terminal ingestion and live rendering change.

## Input paths

1. **Paste:** register Ink's `usePaste` so bracketed paste is separated from `useInput`. Normalize `\r\n`/`\r` to `\n`, retain LF and tab, and remove other C0/DEL controls before appending the whole payload.
2. **Ctrl+J:** Ink reports line feed as a Ctrl+J key. Append `\n` directly.
3. **Backslash + Enter:** when Enter is pressed and the current draft ends in `\\`, replace that final marker with `\n`; otherwise retain completion acceptance and submit semantics.
4. **Legacy unbracketed chunks:** if a terminal sends a multi-character chunk containing line endings through `useInput`, preserve it as normalized draft text rather than interpreting its first newline as submit.

Paste and manual newline input are ignored while a permission request owns the keyboard, matching ordinary typing.

## Rendering

`InputBox` splits the draft on `\n`, renders the first row after `you> `, and renders later rows after a dim continuation marker. The inverse-space cursor remains at the end of the last row. Ink handles visual wrapping within each row; no cursor-position model is introduced.

## Compatibility and trade-offs

- Plain Enter remains send, so existing usage and pty helpers are unchanged.
- The editor remains append/backspace-only. Full cursor navigation is intentionally deferred.
- The continuation backslash is consumed, following shell-style visual intent; Ctrl+J is available when a literal trailing backslash is needed.
- No dependency or configuration change is required because the installed Ink version owns bracketed-paste handling.

## Rollback

The change is isolated to `App`, `InputBox`, and one pty scenario. Reverting those edits restores the single-line behavior without data migration.
