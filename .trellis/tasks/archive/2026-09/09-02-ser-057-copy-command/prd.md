# SER-057 /copy last completed answer to the clipboard

## Goal

A built-in `/copy` that puts the committed text of the last *completed* assistant answer — the
same ANSI-free text the `<Static>` transcript holds and `/export` writes (`turn-state.ts`
`AnswerPart` pieces; `formatReplay`) — on the clipboard. OSC 52 through Ink's stdout writer first
(darwin is normally driven over SSH), a platform tool only when a display is present. One bounded
transcript notice; never a model call, tool call, trajectory record or file write.

Backlog record: `docs/research/backlog/directions-061-080.md` § SER-057 (Priority 78). Peer
evidence: Codex `/copy` (S2), Gemini CLI `/copy` with OSC 52 over SSH/WSL (S5).

## Requirements

- R1. **Selection.** `latestCompletedAnswer(history)` returns the text of the newest answer whose
  closing piece (`whole` or `last`) is in history: pieces are joined with `\n`, empty pieces
  contribute nothing (the same rule `formatReplay` applies). An answer still arriving (`first` /
  `middle` pieces without a `last`) is skipped, so mid-turn `/copy` copies the previous answer.
  No completed answer → `undefined`.
- R2. **Transport.** One OSC 52 sequence `ESC ] 52 ; c ; <base64(utf8)> BEL` is written through the
  existing Ink `useStdout().write` path (the same writer `/clear`'s screen clear uses). When
  `WAYLAND_DISPLAY` is set → `wl-copy`; else `DISPLAY` → `xclip -selection clipboard`; macOS →
  `pbcopy`; otherwise no tool. The helper is dependency-free (`node:child_process` spawn, stdin
  pipe, bounded timeout, non-throwing); its failure is a clause of the notice, never a throw.
- R3. **Bound.** `MAX_COPY_BYTES` is a named module constant (UTF-8 bytes of answer text). Over the
  cap, the copied prefix is cut on a code-point boundary and the notice states `copied N of M bytes`
  — never a silent partial copy. Both transports receive the same bounded bytes.
- R4. **Notices.** Nothing completed (fresh session, after `/clear`, after `/rewind`, resumed
  session with no answer) → one bounded `nothing to copy — …` info notice, not an error. An
  argument (`/copy extra`, `/copy\textra`) → `/copy takes no arguments`. Success → one notice naming
  the byte count and the transports used (`OSC 52`, plus the tool name or its failure).
- R5. **Placement.** Handled in `submit()` before the busy guard like `/help`: answers mid-turn,
  never queues, never reaches the model/tool loop, records no `userInput` trajectory line (only the
  local `userInput` history row, as `/help` does), writes no file. `Ctrl+O` untouched.
- R6. **Registry.** `copy` in `BUILTIN_COMMAND_NAMES` / `BUILTIN_COMMAND_DESCRIPTIONS`;
  `MAX_COMPLETIONS` 20→21; one fixed `/help` row (`HELP_FIXED_LINES` 21→22).
- R7. **Docs.** `docs/user-guide/reference.md` (+ `zh-CN`) command table row; README (+ `zh-CN`)
  "Use it" block; spec sentence in `.trellis/spec/frontend/live-frame.md` and the built-in note in
  `prompt-completion.md`. AGENTS.md untouched (32,667 B of a 32,768 B cap).

## Requirement → check

| Requirement | Check |
|---|---|
| R1 selection: whole / first+middle+last joined, empty last skipped, in-progress skipped, none → undefined | `spike/verify-copy-command.ts` |
| R2 OSC 52 exact encoding | `verify-copy-command.ts` (decode round-trip); `verify-tui.ts copy` (raw pty output decodes to the seeded answer) |
| R2 tool selection by env/platform, no spawn in the test | `verify-copy-command.ts` |
| R2 tool failure stated, not thrown | `verify-copy-command.ts` (ENOENT command via injected spawn path) |
| R3 cap: cut on a code-point boundary, `copied N of M bytes` | `verify-copy-command.ts` |
| R4 nothing-to-copy notice | `verify-copy-command.ts`; `verify-tui.ts copy` (fresh session) |
| R4 usage notice | `verify-tui.ts copy` (`/copy extra`) |
| R5 no model turn, no trajectory record | `verify-tui.ts copy` (no `working…`; trajectory record count unchanged after `/copy`) |
| R6 completion row visible, cap grown | `verify-tui.ts completion`; `verify-tui.ts pathCompletion` (window math) |
| R6 help row | `spike/verify-help-command.ts` |
| Gate | `pnpm typecheck`, `pnpm test`, `pnpm build` |

## Acceptance Criteria

- [x] AC1. `spike/verify-tui.ts copy` (free): resumed seeded session → `/copy` emits OSC 52 whose
  base64 decodes to the exact seeded answer text; fresh session `/copy` → nothing-to-copy notice;
  `/copy extra` → usage notice; no `working…`; trajectory byte-identical.
- [x] AC2. `spike/verify-copy-command.ts` in `pnpm test`: encoding, cap counts, nothing-to-copy,
  latest-completed selection with an in-progress answer, tool selection without spawning.
- [x] AC3. `verify-tui.ts completion` green with `MAX_COMPLETIONS = 21`; `verify-help-command.ts`
  pins the new row.
- [x] AC4. `pnpm typecheck`, `pnpm test`, `pnpm build` exit 0.
- [x] AC5. Commits follow the convention; task archived; tree clean.

## Evidence (2026-09-02)

- Seeding a completed answer without a model call **is** possible: the `copy` pty scenario reuses
  the `resume` seeding (local `ResumeFixtureModel`, real `SessionManager` + `TrajectoryRecorder`,
  `--resume`), so `<Static>` history holds a real `whole` `AnswerPart` closed by the replayed
  `contentBlockEvent`. `pnpm tsx spike/verify-tui.ts copy`: 16 passed, 0 failed (6s).
- `pnpm tsx spike/verify-copy-command.ts`: 41 passed, 0 failed.
- `pnpm tsx spike/verify-help-command.ts`: 35 passed (was 34).
- `pnpm tsx spike/verify-tui.ts completion`: 69 passed (was 68); `pathCompletion`: 27 passed
  (pad count 18→19 keeps 3 candidates past the grown cap).
- `spike/verify-frame-budget.ts` had a fixture hard-wired to `MAX_COMPLETIONS = 20` (21 items,
  `maxRows: 24`); it now derives item count and `maxRows` from the cap — 80/80.
- AGENTS.md untouched: 32,667 B.

## Decisions

- Selection walks history backwards for the first `whole`/`last` piece, so the in-progress answer
  (no `last`) is skipped without consulting `status` or the runtime.
- `App` reads history through a render-time mirror ref (`historyRef`) rather than adding
  `state.history` to `submit`'s deps, which would rebuild the callback on every streamed line.
- `MAX_COPY_BYTES = 262_144` (256 KiB of UTF-8 answer text): a named cap, cut on a code-point
  boundary; the over-cap notice is a `warn`.
- The notice after a display tool is awaited (bounded by `COPY_TOOL_TIMEOUT_MS`, 5 s) so the one
  notice can state the tool's outcome; OSC 52 has already been written by then.

## Out of scope

- tmux/screen OSC 52 passthrough configuration (documented as a user-guide caveat only).
- Copying tool output or a specific earlier answer (`/copy <n>`); `/copy` takes no arguments.
