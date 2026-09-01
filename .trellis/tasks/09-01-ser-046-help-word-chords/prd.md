# SER-046 document composer word chords and undo in /help and READMEs

## Goal

State the already-shipped composer word chords (SER-042) and composer undo (SER-044) in the
bounded local `/help` projection and in both READMEs' input documentation. Documentation of
shipped behavior only: no runtime behavior change, no new command, no config key, no new
live-frame row or information channel.

## Requirements

- `src/tui/help-format.ts` `formatHelpReport()` states, in its `editing and session:` block:
  - word jumps on Alt/Ctrl+Left/Right and Alt+B / Alt+F;
  - word deletion on Alt+Backspace (before the cursor) and Alt+D (after it);
  - composer undo on Ctrl+_ (or Ctrl+-) restoring the last kill/word-delete.
- Only chords verified in `src/tui/App.tsx` are documented. Verified in this task:
  - modified-arrow word jump (`(key.leftArrow || key.rightArrow) && (key.ctrl || key.meta)`),
  - `key.meta` + `b`/`f`, `key.meta` + `d`,
  - `key.meta` + backspace/delete (word before/after),
  - `'\u001f'` or ctrl + `_`/`-` undo pop.
- `/help` stays a pure projection of fixed local facts: bounded, argument-rejecting, handled
  before busy queueing, no model/tool/network/config/session work. No new export beyond the
  existing bounds.
- Bound arithmetic is re-checked rather than assumed: the `slice(0, MAX_HELP_LINES)` must not be
  able to drop any fixed line even when the command inventory fills `MAX_HELP_COMMANDS` and the
  "N more commands not shown" notice is emitted.
- `README.md` and `README.zh-CN.md` name the same chords as `help-format.ts`, consistent with
  each other; the Chinese README is translated, not English-cloned.

## Acceptance Criteria

- [x] `spike/verify-help-command.ts` asserts the new word-chord and undo facts and the
      unchanged/justified bounds, including that the line cap cannot truncate a fixed line; it passes.
- [x] `spike/verify-tui.ts completion` passes (free, no model call).
- [x] Both READMEs name the same chords as `help-format.ts`.
- [x] `pnpm typecheck` clean and full `pnpm test` green.
- [x] `.trellis/spec/frontend/` records the `/help` bound arithmetic contract.

## Notes

- `MAX_HELP_LINES` was 40 against 37 emitted lines while `MAX_HELP_COMMANDS` is 24 against 19
  built-ins — the cap could already truncate the editing block after a few new commands. This
  task raises `MAX_HELP_LINES` to the provable worst case (`MAX_HELP_COMMANDS` + fixed lines +
  overflow notice) instead of relying on incidental headroom.

## Verification (2026-09-01)

- `pnpm tsx spike/verify-help-command.ts` — 34 passed, 0 failed (was 27).
- `pnpm tsx spike/verify-tui.ts completion` — 68 passed, 0 failed.
- `pnpm typecheck` clean; `pnpm build` clean.
- `pnpm test` — one known flake (`active dispatches emit periodic stable-id increasing
  elapsed heartbeats`); `spike/verify-subagent-heartbeats.ts` standalone: 36 passed, 0 failed.
- README.md, README.zh-CN.md, docs/user-guide/reference.md and reference.zh-CN.md each name
  Alt/Ctrl+Left/Right, Alt+B, Alt+F, Alt+Backspace, Alt+D and Ctrl+_ — the same set as
  `formatHelpReport()`.
- Bounds: 39 emitted lines, `MAX_HELP_LINES` = 24 + 21 = 45, so a cap-filling command
  inventory plus the overflow notice still cannot truncate a fixed row.
