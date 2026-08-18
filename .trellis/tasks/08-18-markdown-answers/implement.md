# Implementation record — markdown-styled assistant answers (SER-021)

## What changed

- `src/tui/markdown.ts` (new): pure line-oriented classifier — line kinds
  `text|heading|fence|code|rule`, inline spans `plain|marker|bold|italic|code`,
  `fenceOpenAfter` as the boolean fence state carried across pieces. Invariant:
  spans concatenate back to the input byte for byte.
- `src/tui/MarkdownText.tsx` (new): `MarkdownAnswerText` (one outer `<Text>` of
  nested spans + literal `'\n'` — an empty `<Text>` renders zero rows, measured,
  so per-line `<Text>`s would swallow blank lines) and `liveRowText` (one
  `<Text wrap="truncate-end">` per counted row; inline spans only when the row is
  its whole logical line, else whole-row tone).
- `src/tui/visual-language.ts`: `markdownCodeColor` (= `visualColor.active`).
- `src/tui/turn-state.ts`: assistant history items carry `codeOpen`
  (`fenceOpenAfter(committedAnswer)` at push time). Committed text unchanged;
  reconciliation/divergence untouched.
- `src/tui/live-text.ts`: `LiveTextView.rows` are `LiveRow { text, line }`; one
  wrapping calculation (`liveRows`) feeds both `wrapToRows` and `liveTextView`.
- `src/tui/MessageList.tsx`: assistant entries render through
  `MarkdownAnswerText`; live rows through `liveRowText` with `liveCodeOpen`.
- `src/tui/App.tsx`: passes `liveCodeOpen={fenceOpenAfter(state.committedAnswer)}`.
- Spikes: new `spike/verify-markdown.tsx` (49 asserts) + `spike/force-color.ts`
  (chalk emits nothing on a pipe — force color or the "styling happened" assert
  passes vacuously); wired into `run-tests.ts`. `verify-visual-language.tsx`
  extended (markdown section); `verify-live-text.ts`, `verify-stream-into-static.ts`,
  `probe-live-frame-overflow.tsx` updated for the new shapes.
- Specs: `.trellis/spec/frontend/live-frame.md` new contract section; AGENTS.md
  new load-bearing paragraph.

## Verification results

- `pnpm typecheck` exit 0.
- `pnpm test` exit 0, 45 suites, all `0 failed` (includes verify-markdown).
- Byte-stability: `darwin trajectory replay` output for three real recorded
  sessions (20260818-065005946, -104704270, -025938746; 68–181 markdown-marker
  lines each) byte-identical (`cmp`) between HEAD (via `git stash`) and this
  change; `formatReplay` byte-equality also asserted in the spike.
- Free pty scenarios: completion 35/0, recall 20/0, multiline 9/0, clear 19/0,
  tallDraft 8/0, pathCompletion 18/0, cursor 5/0.
- Live: `AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve` 26/0 at
  120x50 (first attempt hit a transient model stream timeout; re-run clean).
- `probe-live-frame-overflow.tsx`: 43 clears unbounded / 0 bounded — matches the
  documented baseline, so the live block's height accounting is unchanged.
- `git diff --check` clean.

## Decisions worth remembering

- Fence classifier is a boolean toggle by design: the state carried between
  pieces is one boolean, so the classifier may not need the opening fence's
  character/length.
- The `last` piece of a fenced answer legitimately starts with `codeOpen: true`
  (its first line is the close) — a test that expects "after the fence → false"
  is wrong about where piece boundaries fall.
- `_underscore_` emphasis deliberately unrecognized (snake_case identifiers).
- Inline styling degrades to whole-row tone on wrapped live rows rather than
  mapping span offsets through the wrap (trailing-space trim + tab expansion make
  rows non-substrings of their line).
