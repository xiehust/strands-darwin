# PRD — Bounded composer undo (SER-044)

Origin: docs/research/backlog/directions-061-080.md, Priority 62 (SER-044); report
docs/research/research_2026-08-28.md, run 13:03:31Z (rolled tui path).

## Problem

The destructive composer chords — Ctrl+K / Ctrl+U (`killToRowEdge`), Ctrl+W and
Alt+Backspace (`deleteWordBefore`), Alt+D and Alt+Delete (`deleteWordAfter`) — destroy
draft text with no recovery. No undo primitive exists anywhere in `src/tui/`.

## Requirement

Bounded composer undo on Ctrl+_ (most terminals send Ctrl+_ and Ctrl+- as byte 0x1f;
Ink's legacy parser reports that byte as `input === '\u001f'` with no modifier flags):

- Before each destructive chord that actually changes the draft text, push the exact
  `{text, cursor}` `EditorValue` onto a small editor-owned snapshot stack.
- Ctrl+_ pops the newest snapshot, restoring text and cursor exactly. Repeated Ctrl+_
  walks further back until the stack is empty; with an empty stack it is a harmless
  no-op (the key is consumed, nothing changes).
- Hard cap 16 snapshots; pushing past the cap drops the oldest.
- The stack clears whenever the draft leaves the editor's ownership: submit (including
  queued submit and every local slash command), queue take-back replacing the draft,
  recall walk replacing the draft, history-search acceptance, rewind-search acceptance,
  `/clear` (covered by submit).
- Recall walk and history/rewind search keep their own snapshot/restore behavior
  untouched — undo is separate state, never shared with `prompt-history-search.ts`.
- No new dependency, config key, persistence, frame row, or trajectory change.
  Restoring the draft IS the feedback.

## Design

- Pure primitives in `src/tui/prompt-editor.ts`: `UNDO_CAP = 16`,
  `type UndoStack = readonly EditorValue[]`, `pushUndo(stack, value)` (bounded append),
  `popUndo(stack)` (`{stack, value}` or `undefined`).
- `App.tsx` owns the stack as a ref (`undoStack`), mirroring how
  `preferredColumn.current` is owned. Destructive chords compute from
  `editorRef.current`, push only when `next.text !== current.text`, then `setEditor`.
- Ctrl+_ handler sits with the readline chords: after permission/compaction/search-mode
  ownership and the Escape branch, before the generic ctrl/meta ignore. Condition covers
  the legacy byte (`typed === '\u001f'`) and the kitty-protocol form
  (`key.ctrl && typed === '_'/'-'`).
- Clear points: top of `submit()` after the empty-text check (conservative: a busy
  refusal also clears, which only loses undo history, never resurrects a sent prompt),
  `returnQueuedToEditor`, `applyRecalled`, history-search accept, `acceptRewind`.

## Acceptance Criteria

- [x] Unit coverage in `spike/verify-prompt-editor.ts`: destroy-then-undo restores
      text+cursor exactly for `killToRowEdge`, `deleteWordBefore`, `deleteWordAfter`;
      repeated undo walks back; cap 16 evicts oldest; empty-stack pop is `undefined`.
- [x] Free pty scenario `undo` in `spike/verify-tui.ts` (no model call): type text,
      Ctrl+U kills, raw 0x1f restores exactly (multi-line draft included); Ctrl+W then
      0x1f restores; repeated 0x1f walks back; undo after a submit does not resurrect
      the sent prompt.
- [x] `pnpm typecheck` and full `pnpm test` green.
- [x] Existing scenarios stay green: cursor, multiline, wordNav, completion, recall,
      recallEmpty, queue, historySearch.
- [x] AGENTS.md free-scenario list updated (stays under 32 KiB).

## Out of scope

Undo of ordinary typing/backspace, redo, persistence, new frame rows, trajectory
changes, backlog record Status (Host closes it),
docs/research/research_2026-08-28.md batch-outcome section.
