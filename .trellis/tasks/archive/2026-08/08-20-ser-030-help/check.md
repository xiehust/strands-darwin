# SER-030 quality check

## Scope and contracts

- Reviewed `prd.md`, `implement.md`, repository findings, and the governing frontend specs.
- `/help` is handled before the busy guard and only dispatches existing `userInput`/`notice` transcript actions.
- The formatter imports the canonical built-in names/descriptions and has finite command, line, and code-point caps.
- No runtime, model, tool, queue, config/session mutation, filesystem, or network dependency enters the formatter.
- README, completion capacity, frame-window expectations, prompt-recall command list, AGENTS architecture index, and frontend specs are synchronized.

## Focused verification

- `pnpm tsx spike/verify-help-command.ts` — 23 passed.
- `pnpm tsx spike/verify-frame-budget.ts` — 75 passed.
- `pnpm tsx spike/verify-tui.ts completion` — 61 passed, including idle/busy help, argument separators, queue stability, and completion row.
- Free pty scenarios: `pathCompletion` 23, `recall` 20, `queue` 17, `toolDetails` 6, `multiline` 9, `cursor` 5 — all passed.

## Final gate

- `pnpm typecheck` — passed.
- `pnpm test` — passed after updating the completion-window expectations for 16 offered rows.
- `python3 ./.trellis/scripts/task.py validate 08-20-ser-030-help` — passed; expected warning that the pre-existing large TUI spec truncates when context-injected.
- `git diff --check` — passed.
- `AGENTS.md` remains below 32 KiB.

## Review result

No unresolved spec, safety, type, test, dependency, or scope issue found. No live/provider test was run or required.
