# Design — Editable input cursor and mouse positioning

## Boundaries

The feature stays inside the interactive TUI. Agent runtime, session persistence, permissions, and headless output are unchanged.

- `App.tsx` owns draft/cursor state and keyboard semantics.
- `InputBox.tsx` renders an editor layout supplied from a pure layout module.
- A small TUI-local mouse adapter owns terminal protocol setup, parsing, and teardown.
- Pure editor helpers own grapheme boundaries, display-cell widths, visual wrapping, cursor movement, edits, and click hit-testing. This keeps Unicode and geometry testable without an Ink renderer.

## Editor state and text boundaries

Keep `draft` as canonical LF text and add a UTF-16 cursor offset mirrored in a ref beside `draftRef`. Every externally supplied offset is snapped to an `Intl.Segmenter(..., {granularity: 'grapheme'})` boundary. This prevents movement/deletion through surrogate pairs, combining sequences, and joined emoji.

An atomic setter updates draft and cursor refs before React state, preserving the existing protection against multiple stdin events arriving before a render.

Editing operations:

- typing/paste inserts at the cursor and advances by inserted UTF-16 length;
- Backspace deletes the preceding grapheme;
- Delete deletes the following grapheme;
- Left/Right move to adjacent grapheme boundaries;
- Home/End move to the start/end of the current visual row;
- Up/Down retain a preferred display-cell column until a horizontal edit/move resets it;
- completion replaces the draft and places the cursor at its end;
- submit/clear resets text and cursor atomically.

When slash completions are visible, Up/Down continue to navigate the completion list. Left/Right/Home/End and editing still operate on the draft.

## Visual layout

A pure layout function receives draft, terminal width, and cursor offset and produces visual rows with:

- source start/end offsets;
- prompt prefix (`you> ` for the first logical row, `...> ` for later explicit LF rows);
- grapheme boundaries and display-cell columns;
- the cursor's output-relative `(x, y)`.

Wrapping uses available cells after the row prefix. A grapheme is never split. Wide graphemes use terminal display width; zero-width combining marks stay in their grapheme. Empty logical lines still produce one row. Terminal resize recomputes layout and snaps Up/Down/click geometry to the new visible rows.

`InputBox` renders one visual row per layout row with wrapping disabled, and uses Ink's `useCursor()` to place the real terminal cursor. This replaces the synthetic inverse-space cursor and gives IME/terminal cursor behavior consistent with Ink 7.1.1.

## Mouse protocol and coordinates

Ink has no mouse hook. Add a TUI-local adapter that:

1. writes `CSI ?1000h` and `CSI ?1006h` after mount to request button events in SGR form;
2. recognizes complete `CSI <button;column;row M/m` strings delivered by Ink `useInput` (Ink strips the initial ESC before invoking the handler);
3. accepts only primary-button press events;
4. maps 1-based terminal coordinates into the current input box's visible viewport rows;
5. delegates the row/column to pure editor hit-testing;
6. writes `CSI ?1006l` and `CSI ?1000l` during effect cleanup.

Because the live Ink region is bottom-anchored in the primary screen, viewport row mapping uses the measured live region/input height and terminal row count. Clicks outside the measured editable rows are ignored. Mouse reports are consumed before ordinary printable-input handling so protocol fragments can never enter the draft.

Standard mouse tracking captures ordinary clicks. Native terminal selection remains available through Shift-drag, as explicitly accepted for this task.

## Lifecycle and safety

Mouse mode is enabled only while interactive `App` is mounted on TTY streams. React cleanup handles `/exit`, Ctrl+D, normal unmount, and errors that unmount Ink. The CLI's existing bounded force-exit fallback runs only after `waitUntilExit` and runtime shutdown; therefore mouse teardown must occur as part of Ink unmount, before that fallback.

Permission prompts keep ownership: mouse reports are parsed/consumed, but cannot update cursor state while a permission is pending. The disabled busy/compacting input likewise ignores clicks.

## Compatibility

No alternate screen is introduced. Completed `<Static>` output and terminal scrollback stay unchanged. No runtime dependency is planned: Unicode segmentation is built into supported Node versions; display-width logic will be a focused local utility verified against CJK, combining marks, and emoji.

## Validation

- Add pure tests for grapheme-safe edits, display widths, wrapping, preferred-column movement, resize, and click hit-testing.
- Extend the real PTY driver/scenario with arrow/Home/End/Delete sequences and SGR mouse reports.
- Assert mouse enable and disable escape sequences from raw PTY output, while existing `screen` assertions remain ANSI-stripped.
- Re-run multiline and completion PTY scenarios because their Enter, paste, Backspace, and Up/Down ownership contracts are load-bearing.
