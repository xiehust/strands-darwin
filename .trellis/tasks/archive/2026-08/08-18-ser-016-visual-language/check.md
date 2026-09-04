# Verification record

## Focused checks

- `node --import tsx spike/verify-visual-language.tsx` — 22 passed.
- `node --import tsx spike/verify-frame-budget.ts` — 61 passed.
- `node --import tsx spike/verify-stream-into-static.ts` — 58 passed.
- Free real-pty scenarios: `completion` 29, `pathCompletion` 18, `recall` 20, `cursor` 5, `multiline` 9, `mode` 25, `plan` 4, `clear` 19, `tallDraft` 8 — all passed.
- `AWS_REGION=us-west-2 node --import tsx spike/verify-tui.ts approve` — 23 passed on the clean structural run. Two preceding attempts reached and passed every modal/edit assertion, then hit the documented model-volunteered-extra-tool exit flake.

## Project gate

- `pnpm typecheck` — passed.
- `pnpm test` — passed, including the new visual-language suite.
- `python3 ./.trellis/scripts/task.py validate 08-18-ser-016-visual-language` — passed (one expected context-size truncation warning for the research report).
- `git diff --check` — passed.

## Review

The semantic token module is dependency-free and imported by all five target surfaces. No SDK-loop, input-ownership, cursor, mouse, or frame-budget code changed. Header capability inventories became counts; required mode/cache/effort and degradation rows remain. ANSI-stripped deterministic assertions cover transcript roles, selection, and the complete permission information set.
