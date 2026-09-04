# Markdown-styled assistant answers (SER-021)

## Goal

Render assistant answer text — `<Static>`-committed history pieces and the live streaming
region — with markdown-aware styling (headings, `**bold**`/`*italic*`, inline code, fenced
code blocks, dividers) as a pure presentation-time projection over the committed text,
which is never altered.

## Requirements

1. Styling uses the existing semantic palette (`src/tui/visual-language.ts`): headings
   bold, emphasis emphasized, inline code and fenced code block lines visually distinct,
   fence delimiters/dividers subtle. Syntax highlighting by language is OUT of scope.
2. The committed text is the source of truth and never changes: `turn-state.ts` keeps
   committing exact plain lines, reconciliation/divergence warning keep working on plain
   text, the trajectory record, `/export` and `darwin trajectory replay` stay
   byte-identical. Every answer character is kept — markers are de-emphasized in place,
   never stripped — so ANSI-stripped output is unchanged.
3. Fence state (inside/outside a code block) is derived deterministically per
   `AnswerPart` piece — carried as minimal reducer state — so a fence opened in one
   committed piece styles the next piece correctly, and the live region cannot disagree
   with what `<Static>` already wrote. Ink layout traps: one `<Text>` with nested spans
   per counted row; the live region's row count stays exactly what `liveTextView` counted.
4. The styling module is pure, dependency-free and line-oriented, with its own focused
   spike suite wired into `pnpm test`. User messages, notices, tool output and the
   prompt editor are untouched.

## Acceptance Criteria

- [x] New focused spike suite (headings, emphasis, inline code, fences incl. state
      across piece boundaries, non-markdown passthrough, ANSI-stripped output unchanged)
      in `pnpm test`.
- [x] `spike/verify-visual-language.tsx` extended and passing.
- [x] `pnpm typecheck` exit 0; `pnpm test` exit 0, every suite 0 failed.
- [x] Byte-stability: `formatReplay` output unchanged for markdown-bearing answers.
- [x] Free pty scenarios pass: `completion`, `recall`, `multiline`, `clear`; live
      `approve` once after source settles.
- [x] `git diff --check` clean; working tree clean after commit.

## Notes

- Origin: docs/research/research_2026-08-18.md run 12:30:29Z, direction SER-021.
- No new dependencies; no model/provider config changes.
