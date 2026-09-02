# SER-059 Esc Esc opens the /rewind chooser on an empty idle composer

## Goal

A second `Escape` within a short window on an **empty, idle** composer opens the same `/rewind`
checkpoint chooser typing `/rewind` opens — the exact same code path, so acceptance, cancel,
notices and the "nothing is sent, no snapshot is created, the selected prompt returns unsent"
contract (SER-040) are inherited, not re-implemented. The first `Escape` stays a no-op; every
existing `Escape` owner (permission denial, rewind/history search, completion menu, recall) keeps
its key and resets the chord.

Backlog record: `docs/research/backlog/directions-061-080.md` § SER-059 (Priority 80). Peer
evidence: Codex "Press Esc twice with an empty composer to edit the previous user message" (S2),
Gemini CLI `/rewind` "Press Esc twice as a shortcut" (S5).

## Requirements

- R1. **Chord.** `ESCAPE_REWIND_CHORD_MS` is a named exported constant (500 ms) in
  `src/tui/rewind-search.ts`. In `App.tsx`'s `Escape` branch, when no owner consumed the key
  (no completion menu, no recall walk — permission, compaction, rewind and history search already
  return earlier), `status === 'idle'`, the queue is empty and the draft text is empty, the first
  `Escape` records `Date.now()` in a ref and does nothing else; a second `Escape` whose timestamp
  is within the window opens the chooser. `\x1b\x1b` delivered in one stdin chunk (Ink reports it
  as one `escape` with `meta`) counts as both presses. A timestamp comparison only — no
  `setTimeout`, no tick, no new state row.
- R2. **Reset.** A consumed first `Escape` (menu dismissed, recall ended), a non-empty draft, a
  running turn or `!` command, a queued entry, a pending permission, or any other key between the
  two `Escape`s clears the armed timestamp; the next `Escape` is a first one again. Two `Escape`s
  further apart than the window do not open the chooser (the second re-arms).
- R3. **One code path.** The `/rewind` command body from the `startRewind` guard through
  `setRewindSearch(openRewindSearch(...))` moves into one `openRewindChooser()` callback that both
  the command and the chord call. The chord does not dispatch a `userInput` transcript row and
  writes no trajectory record; with no catalogue (fresh session, resumed session without a mapped
  boundary, driver without `startRewind`, catalogue problem) it shows exactly the notice `/rewind`
  shows. No new runtime accessor beyond `listRewindCheckpoints()`.
- R4. **Docs.** `/help` gains one fixed row (`HELP_FIXED_LINES` 22→23); `docs/user-guide/reference.md`
  (+ `zh-CN`) keyboard row; README (+ `zh-CN`) input sentence where `Escape` is documented; spec
  sentence in `.trellis/spec/frontend/prompt-recall.md` (rewind section) and the Escape contract
  lines in `tui-testing.md` / `live-frame.md`; rationale paragraph in
  `docs/architecture/load-bearing-decisions.md` § `/rewind`. AGENTS.md untouched (32,667 B of a
  32,768 B cap).

## Requirement → check

| Requirement | Check |
|---|---|
| R1 Esc Esc on an empty idle composer with a catalogue shows the chooser (same anchors as `rewind`) | `spike/verify-tui.ts escRewind` |
| R1 a single Esc shows nothing | `verify-tui.ts escRewind` |
| R2 Esc Esc with a non-empty draft: draft intact, no chooser | `verify-tui.ts escRewind` |
| R2 Esc Esc while a `!` command is busy: no chooser | `verify-tui.ts escRewind` |
| R2 two Escapes further apart than the window: no chooser | `verify-tui.ts escRewind` (sleep > `ESCAPE_REWIND_CHORD_MS`) |
| R3 fresh session without a catalogue: the same notice `/rewind` shows | `verify-tui.ts escRewind` (second TUI, fresh work dir) |
| R3 chooser acceptance from the chord behaves like `/rewind` | `verify-tui.ts escRewind` (Enter → `Workspace unchanged:`, prompt returned unsent, no `working…`) |
| R3 `/rewind` command unchanged | `verify-tui.ts rewind` |
| R4 help row | `spike/verify-help-command.ts` |
| Escape owners unchanged | `verify-tui.ts completion`, `recall`, `historySearch`, `undo`, `wordNav` |
| Gate | `pnpm typecheck`, `pnpm test`, `pnpm build` |

## Acceptance Criteria

- [x] AC1. `spike/verify-tui.ts escRewind` (free) green: chooser on Esc Esc, nothing on one Esc,
  draft intact and no chooser with a draft, no chooser while `!` is busy, no chooser past the window,
  fresh-session notice identical to `/rewind`'s. (20/20)
- [x] AC2. `spike/verify-help-command.ts` pins the new row (36/36); `verify-tui.ts completion` 69,
  `recall` 22, `historySearch` 11, `undo` 7, `wordNav` 11, `rewind` 7 — all 0 failed.
- [x] AC3. `pnpm typecheck`, `pnpm test` (86 suites, 0 failed), `pnpm build` exit 0.
- [x] AC4. Commits follow the convention; task archived; tree clean; AGENTS.md byte-identical (32,667 B).

## Evidence (2026-09-02)

- `pnpm tsx spike/verify-tui.ts escRewind`: 20 passed, 0 failed. Both Escapes are separate pty
  writes 120 ms apart (inside the 500 ms window); the "too far apart" pair uses `window + 300 ms`.
- The scenario found a pre-existing bug on its fresh-session leg: a refused `/rewind` (no catalogue)
  showed its notice but left `/rewind` in the draft, so the following `/exit` was submitted as
  `/rewind/exit` — a model prompt. `openRewindChooser()` now resolves `true`/`false` and the command
  clears the draft on `false` (and on the takes-no-arguments refusal), matching `/help`/`/clear`.
  The chord path is unaffected (its draft is empty by definition). Pinned by
  `a refused /rewind leaves an empty draft`.
- `spike/verify-help-command.ts`: 36 passed (was 35).

## Decisions

- The armed timestamp is captured and cleared at the *top* of the key handler, before any owner
  runs, and only the composer's Escape branch re-arms it. Resetting inside each owner would have
  missed Escapes consumed by permission denial and the two search modes, which return earlier.
- `\x1b\x1b` in one stdin chunk is reported by Ink as a single `escape` with `meta`; it is treated
  as both presses so a fast double-tap on a coalescing terminal still works.
- `ESCAPE_REWIND_CHORD_MS` lives in the pure `rewind-search.ts` module so `help-format.ts` and the
  spikes can import it without pulling in `App.tsx`.

## Out of scope

- Editing the previous user message in place (Codex's fork-and-edit); darwin's chooser returns the
  selected prompt unsent, which is SER-040's existing contract.
- A visible "press Esc again" hint row (no new frame row by requirement).
