# Implementation — SRF-012 closed reflection cutoff

1. Add latest-valid-`turnEnded` discovery and explicit closed cutoff output to the read-only locator; fail selected subjects without a closed turn.
2. Update the bundled self-reflection workflow to carry and enforce the exact inclusive turn/seq cutoff while preserving selection, child, template, spend, and backlog contracts.
3. Add focused locator fixtures and strengthen skill contract assertions.
4. Update SDK/trajectory architecture contracts and AGENTS load-bearing index where the reflection reader invariant belongs.
5. Run focused checks while editing. Once source settles, run `pnpm typecheck`, exactly one full `pnpm test`, Trellis validation, and `git diff --check`; then build once, inspect generated assets, and commit.
