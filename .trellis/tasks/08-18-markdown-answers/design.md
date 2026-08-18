# Design — markdown-styled assistant answers (SER-021)

## Shape

One new pure module and a render-time projection; the committed text is never touched.

- `src/tui/markdown.ts` (pure, dependency-free, line-oriented)
  - `markdownLines(text, codeOpen=false): readonly MarkdownLine[]` — classifies every
    line (`text | heading | fence | code | rule`) and splits text/heading lines into
    inline spans (`plain | marker | bold | italic | code`). Invariant: concatenating
    span texts joined by `\n` reproduces the input byte for byte — style in place,
    keep every character.
  - `fenceOpenAfter(text, codeOpen=false): boolean` — the minimal state carried across
    `AnswerPart` piece boundaries. Deliberately a boolean toggle (any ``` / ~~~ line
    opens; inside a block a bare ``` / ~~~ line closes): the state carried between
    pieces is a boolean, so the classifier must not need more than a boolean.
- `src/tui/MarkdownText.tsx` — the projection: `MarkdownAnswerText` (one outer `<Text>`
  whose children are nested styled spans and literal `'\n'` strings — measured: an
  empty `<Text>` renders zero rows, so per-line `<Text>`s would eat blank lines) and
  `liveRowText` for the pre-wrapped live rows.
- `src/tui/visual-language.ts` — `markdownCodeColor` (cyan `active`); markers/fences/
  rules ride `dimColor`, headings ride `bold`. Markers survive ANSI stripping — colour
  is enhancement only, per the module's own contract.

## Fence state across pieces

`turn-state.ts` assistant history items gain `codeOpen: boolean` — the fence state at
the start of that piece — computed at push time as `fenceOpenAfter(state.committedAnswer)`
(`''` → `false`, so `whole`/`first` pieces are always closed-state). `<Static>` never
redraws, so the state is decided when the piece is pushed, same as `part`. The live
region's initial state is the same expression over the *current* `committedAnswer`,
passed from `App` as `liveCodeOpen`; both sides derive from one function over one string,
which is what makes the live region unable to disagree with what `<Static>` wrote.

## Live region

`liveTextView` rows become `{ text, line }` (source logical line index) so a wrapped
row can be toned by its line's kind; the wrapping, tail logic and row counts are
unchanged (`wrapToRows` keeps its string shape for `App`'s row counting). Each row stays
ONE `<Text wrap="truncate-end">`: inline spans are rendered only when the row is the
whole untransformed line (span concatenation === row text), otherwise the row falls back
to whole-row tone (code/fence/rule/heading) or plain text — a `**bold**` split by the
wrap stays plain until the line is committed, which is a styling nuance, not a state
disagreement.

## Out of scope / untouched

Syntax highlighting by language; user messages, notices, tool output, prompt editor;
`formatReplay` / `/export` (they read `item.text`/`item.part` only — `codeOpen` is
invisible to them, proven byte-for-byte in the spike); reconciliation and the divergence
warning (still compare plain strings).

## Verification

New `spike/verify-markdown.tsx` in `pnpm test` (module invariants, fence state across
reducer-committed pieces, ANSI-stripped render equality, `formatReplay` byte-stability);
`verify-visual-language.tsx` extended; `verify-live-text.ts` / `verify-stream-into-static.ts`
/ `probe-live-frame-overflow.tsx` updated for the new shapes; pty `completion`, `recall`,
`multiline`, `clear` free scenarios; one live `approve` run.
