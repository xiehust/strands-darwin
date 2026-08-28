# PRD — Word-wise composer navigation and deletion (SER-042)

Origin: backlog direction SER-042 (docs/research/backlog/directions-041-060.md, Priority 60);
origin report docs/research/research_2026-08-28.md (run 13:03:31Z, rolled tui path).

## Requirement

Add word-wise navigation and deletion to the TUI prompt editor:

- `Alt+Left` / `Ctrl+Left` and `Alt+Right` / `Ctrl+Right` jump to the previous/next
  word boundary.
- `Alt+B` / `Alt+F` are the readline chord equivalents of the word jumps.
- `Alt+Backspace` deletes the word before the cursor — the same primitive `Ctrl+W`
  already uses (`deleteWordBefore`).
- `Alt+D` deletes the word after the cursor.

All operations are grapheme-aware: a jump or delete never splits an emoji/ZWJ cluster
or combining sequence, using the module's existing `Intl.Segmenter` segmentation and
`deleteWordBefore`'s whitespace-delimited notion of word characters.

## Constraints

- Pure primitives live in `src/tui/prompt-editor.ts` beside `deleteWordBefore`.
- Chords are wired in `src/tui/App.tsx` AFTER the existing owners — permission prompt,
  completion menu (Tab/arrows), queue take-back, recall walk, history/rewind search —
  so no current key contract changes. Plain arrows, Ctrl+A/E/K/U/W, Home/End, and all
  menu/recall/queue behavior stay byte-identical.
- No new dependencies, frame rows, config keys, persistence, or trajectory changes.
- Ink's installed parser already delivers the chords: CSI-modified arrows set
  `key.ctrl` (modifier & 4) / `key.meta` (modifier & 10); `ESC+letter` maps to
  meta+char; `ESC+DEL`/`ESC+BS` map to meta+backspace. Handle what the parser reports.

## Acceptance Criteria

- [ ] `spike/verify-prompt-editor.ts` extended with word-boundary cases — ASCII words,
      punctuation runs, whitespace runs, emoji/ZWJ clusters, CJK, line boundaries,
      start/end of text — all passing.
- [ ] A free pty scenario in `spike/verify-tui.ts` (no model call) proving word jumps and
      word deletes act on the draft; existing scenarios `completion`, `recall`,
      `recallEmpty`, `queue` stay green.
- [ ] `pnpm typecheck` green; full `pnpm test` green (verify-subagent-heartbeats has a
      known pre-existing timing flake — rerun in isolation if it fails).
- [ ] No change to permission/compaction key ownership; `prompt-editor.ts` gains pure
      primitives only.
