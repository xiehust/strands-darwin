# What committing finished lines costs, and where divergence can actually come from

Two questions the PRD left as "measure it, don't argue it". Neither number below cost a model call.

## 1. Progressive commit is *cheaper* than the single write

`research/probe-static-commit.tsx`, 100x20 pty, a 120-line answer fed one line at a time
through the real `turnReducer` and the real `MessageList`:

| mode | `ESC[3J` | bytes written |
|---|---|---|
| single write at the end (before) | 0 | **60,040** |
| progressive commit (after) | 0 | **30,675** |

The worry in the PRD was that each commit might cost a repaint. It is the reverse, and the reason
is the bounded live region round 1 introduced: with one write at the end, the live tail *is* the
whole answer, so every delta redraws every row of it. Committing finished lines leaves ~2 lines in
the live region — each frame redraws almost nothing, and the committed rows are written once.

The real TUI agrees: `verify-tui.ts longAnswer` reports **16.2–16.8 KB** and **0** clears for its
120-line answer (it prints both, so a regression shows up as a number rather than a feeling).

## 2. The divergence branch cannot be reached through an ordinary model

The PRD asked for the divergence case to be exercised with `spike/offline-model.ts`. It cannot be,
and that is worth writing down rather than faking:

`Model.streamAggregated` (`node_modules/@strands-agents/sdk/dist/src/models/model.js:158`) is
implemented in the SDK's **base** class. It yields each `ModelStreamEvent` from the subclass's
`stream()` and *accumulates the assembled block from those same deltas*. So for any model that
implements `stream()` — which is every model darwin uses, and `offline-model.ts` too — the
authoritative `textBlock` is by construction the concatenation of the deltas. There is nothing to
diverge.

What can still differ, and is why the branch exists:

- the `trim()` applied when the block closes (handled deliberately: leading blank lines are never
  committed, and trailing blank lines are held back — see `commitFinishedLines`);
- citation accumulation (`CitationAccumulator` in the same file) puts text in the assembled block
  that the text deltas did not carry;
- a model that overrides `streamAggregated` itself, which the SDK permits.

So the branch is exercised at the reducer, where the events can be stated directly
(`verify-stream-into-static.ts`, seven assertions), and the offline `Agent` is used for the half it
*can* prove: that a real SDK stream commits lines before the block closes and lands the answer in
history exactly once.

## 3. Two things a later reader will otherwise get wrong

- **Counting occurrences in accumulated pty output proves nothing about duplication.** Every row
  that passed through the live tail was drawn once per repaint, so `row 63` legitimately appears
  dozens of times in `tui.screen`. The no-duplication property is asserted where a stable
  projection exists: the reducer's history, and `formatReplay` over it.
- **The last non-blank line is held back on purpose.** It is what guarantees the closing piece has
  content, and the closing piece is what owns the blank row below the answer — `<Static>` fixes an
  entry's margin when it writes it, so an answer that had already committed every line could never
  get that row back.
