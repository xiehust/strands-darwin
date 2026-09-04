# SER-047 classify list markers, blockquote prefixes and table pipes in the markdown answer projection

## Goal

Extend the markdown answer projection's *block* vocabulary so a list item's marker, a
blockquote's `>` prefix and a pipe-fenced table row's `|` separators are classified and drawn
as dimmed marker spans instead of falling through to undifferentiated prose. Presentation only:
the committed text, row counts, fence state and every reader projection stay byte-identical.

## Requirements

- `MarkdownLineKind` gains `list`, `quote` and `table`.
  - `list`: `-`/`*`/`+` or `N.`/`N)` followed by at least one space/tab. The leading
    whitespace, the marker and the whitespace after it are ONE `marker` span (whitespace has no
    visible tone, so folding the indent in keeps the span count minimal); the remainder gets the
    ordinary inline spans. This is what gives a `* item` line its marker — `inlineSpans` must
    keep refusing to read it as emphasis.
  - `quote`: `>` after at most three spaces; the `>` run plus the interleaved/trailing spaces
    and tabs are the `marker` span, the rest ordinary inline spans. Quote *content* is not
    dimmed: only the marker is, exactly as for a heading's `#`.
  - `table`: a row that both starts (after at most three spaces) and ends with `|` and is at
    least two characters wide. Every `|` is a `marker` span; each cell gets inline spans.
    A prose line merely *containing* `|` is deliberately NOT a table — see Notes.
- Classification order is unchanged where it already had a winner: fenced `code`/`fence` beats
  everything, `heading` next, then `rule` (`---`/`***`/`___` stays a rule, never a list), and
  only then quote → list → table → text.
- Every character survives: concatenated spans of a line equal that line byte for byte, for the
  new kinds too. No stripping, re-indenting, renumbering or column alignment.
- `fenceOpenAfter` stays a boolean and is untouched; `turn-state.ts` commit semantics untouched.
- `MarkdownText.tsx`: the new kinds get whole-row tone `{}` (prose) in `rowToneProps` and use
  inline spans in `liveRowText` when the row is exactly its logical line — same rule as `text`
  and `heading`, so a live row can never disagree with what `<Static>` wrote. `spanProps` needs
  no new branch: the generic `style` switch already dims a `marker` span.
- Answers only. No new frame row, no reflow, no width-dependent behavior, no palette entry.

## Acceptance Criteria

- [x] `spike/verify-markdown.tsx` asserts the new classifications and byte-identical span
      concatenation for: `-`/`*`/`+` bullets, `1.` and `1)` ordered items, an indented nested
      bullet, `> ` and `> > ` quotes, a pipe-fenced table row and its delimiter row, a bullet
      inside a fenced block (stays `code`), `---` and `***` (stay `rule`), and prose lines
      containing a stray `*` or `|` (stay `text`).
- [x] `spike/verify-markdown.tsx` proves ANSI-strip and `formatReplay` byte-identity for an
      answer containing lists, quotes and tables, and that the live region's row count is
      unchanged for such an answer.
- [x] `spike/verify-visual-language.tsx` passes.
- [x] `pnpm typecheck` clean and full `pnpm test` green.
- [x] `.trellis/spec/frontend/live-frame.md` records the extended block vocabulary and the
      dropped bare-pipe sub-case with its reason.

## Notes

- Dropped sub-case with recorded reason: a line containing `|` without being pipe-fenced
  (`a | b`, `cmd | grep x`, an alternation in prose) is left as prose. Treating any `|` as a
  table separator would dim ordinary shell pipes and prose alternations — a fragile heuristic
  whose false positives are common in exactly the answers darwin writes. The leading+trailing
  pipe test is the cheap, decidable form of "the author drew a table".
- Blockquote content is not dimmed as a whole row: the projection's rule is markers dimmed *in
  place* as enhancement, and dimming a whole quoted paragraph would reduce legibility of the
  text the answer means to quote.

## Verification (2026-09-01)

- `pnpm tsx spike/verify-markdown.tsx` — 129 passed, 0 failed (was 96).
- `pnpm tsx spike/verify-visual-language.tsx` — 69 passed, 0 failed (was 63).
- `pnpm typecheck` clean (the `rowToneProps` switch is exhaustive over the three new kinds);
  `pnpm build` clean; full `pnpm test` green — every suite reported `0 failed`, no flake this run.
- Requirement → check: list markers / ordered markers / indent → "block vocabulary: list markers";
  `>` prefixes and nested runs → "blockquotes"; pipes and the dropped bare-pipe sub-case →
  "table rows"; classification order (fence, heading, rule) → "block classification never
  outranks fences, headings or rules"; ANSI-strip + transcript + `formatReplay` byte-identity for
  a lists/quotes/tables answer → "a structured answer survives the projection byte for byte" and
  the extended `formatReplay` section; live row counts including a wrapped list item → same
  section; composed surface → the markdown block of `verify-visual-language.tsx`.

## Finding outside this task's scope

An empty live row renders as an empty `<Text>`, which Ink draws as **zero** rows, so a live block
whose text contains a blank line draws one row fewer than `liveTextView` counted — reproducible
with plain prose (`'alpha\n\nbeta'`: 3 counted rows, 2 drawn). Block classification neither causes
nor fixes it; the new live-row assertions are therefore blank-line-free and the quirk is recorded
here rather than papered over. Worth its own direction: the same trap the `<Static>` path already
works around (one outer `<Text>` with literal `'\n'`) is unhandled on the live path.
