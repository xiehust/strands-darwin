# Implementation plan: bilingual README and user guide

1. Build the English information architecture from the existing README:
   - rewrite `README.md` as a landing page capped at 300 physical lines;
   - lead with iteration, self-development, and `self-evolution-research`;
   - retain compact setup, core capability, safety, and documentation entry points;
   - distribute detailed operational material across the nine planned `docs/user-guide/` English pages without losing substantive contracts.
2. Build the Simplified Chinese edition:
   - add `README.zh-CN.md` with matching landing-page structure and the same 300-line cap;
   - add a complete `.zh-CN.md` counterpart for every guide page;
   - apply `humanizer-zh` while preserving commands, identifiers, paths, configuration literals, output, examples, limits, and warning strength.
3. Add the centered GitHub-compatible header, factual Shields.io badges, language navigation, and supplied screenshot to both root READMEs. Add reciprocal language navigation to every guide pair.
4. Add `repository`, `homepage`, and `bugs` metadata to `package.json` while preserving dependencies and existing ordering.
5. Verify mechanically:
   - parse `package.json` and assert exact public metadata;
   - assert both root READMEs are at most 300 lines;
   - assert every English guide page has exactly one Chinese counterpart and reciprocal navigation;
   - compare paired heading levels and fenced-block counts, and confirm all fences are balanced;
   - extract and check repository-relative links/images from every new or changed Markdown file;
   - validate same-document anchors with GitHub-style normalization;
   - search Chinese prose for common translationese/AI-style filler and review each hit manually;
   - inspect `git diff --check`, status, and the final diff summary.
6. Run `pnpm typecheck` and `pnpm test` as repository gates because package metadata and primary documentation changed.

## Risk and rollback points

- The largest risk is omission while splitting a long source document. Maintain an explicit old-section-to-new-page coverage check and review all original headings against their owning destination.
- The second risk is technical drift between languages. Keep paired hierarchy/examples aligned and review literal syntax independently of prose quality.
- GitHub anchors can differ around punctuation and inline code. Validate local fragments and manually inspect normalization exceptions.
- Do not modify `pnpm-lock.yaml`; package metadata does not change the dependency graph.
- Keep the supplied `docs/images/welcome.png` byte-identical.
