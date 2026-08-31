# SRF-019 — memory_save untrimmed quotes and reasoned evidence rejection

## Problem

- `src/memory/tools.ts` `bounded(max)` applies `z.string().trim()` to every bounded field of
  `memorySaveSchema`, including `evidence.quote` and `userQuote`. `resolveExactSourceAnchor`
  (`src/memory/validation.ts`) requires the quote to be byte-equal to one full source line, so
  the trim makes every indented project line (most code lines) impossible to anchor.
- `src/memory/controller.ts` (~line 261) collapses every anchor failure into one generic
  message `memory evidence must be one unique exact current project line`, which made a real
  failure undiagnosable (origin: docs/reflections/reflection_2026-08-31_session-20260831-011450426.md,
  seq 343–355: byte-identical indented quote rejected twice, ~2 minutes of phantom-chasing,
  wrong hypothesis delivered to the user).

## Fix (inside existing modules, no restructure)

1. `tools.ts`: `evidence.quote` and `userQuote` get a bounded-but-untrimmed schema — keep
   non-emptiness and code-point bounds, drop `.trim()`. All other fields (key, title, fact,
   query, path) keep the trimmed schema. Exact-line validation still gates every save, so
   nothing widens.
2. `validation.ts`: `resolveExactSourceAnchor` returns a discriminated resolution
   (`anchor` or a closed failure reason) instead of `anchor | undefined`. Safety checks stay
   byte-for-byte equivalent in effect — same conditions in the same order, only the failure
   channel gains a reason. Reasons distinguish at minimum: quote-not-one-bounded-line,
   unsafe path, oversized source, unreadable source, no matching line, multiple matching lines.
3. `controller.ts`: `validateCandidate` maps each resolution failure to a reason-specific
   bounded error message; the post-resolve `validateAnchor` re-check keeps a distinct message.

## Acceptance

- spike/verify-memory-tools.ts: an indented unique project line stages through the real SDK
  tool (schema exercised) and commits after durable endTurn; the trimmed variant of that quote
  fails with the no-matching-line reason; a duplicated line fails with the multiple-matches
  reason.
- spike/verify-memory-validation.ts: direct `resolveExactSourceAnchor` cases — indented match
  resolves; no-match / multi-match / oversized / unsafe path / symlink / multiline quote return
  their specific reasons.
- `pnpm typecheck` green; full `pnpm test` green.
- Tool descriptions and AGENTS.md invariants unchanged in truth: memory_save stays an
  un-ruleable ordinary write staged until durable endTurn; children isolated.

## Spec update

`.trellis/spec/backend/strands-sdk-contracts.md` SER-031: state that quotes are matched
untrimmed (byte-identical including indentation) and that evidence rejection is reason-specific.
