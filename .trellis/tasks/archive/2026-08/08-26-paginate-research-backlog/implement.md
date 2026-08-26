# Implementation plan — paged self-evolution backlog

1. Add parser/validator helpers and malformed fixtures to `spike/verify-skills.ts`, initially capable of validating both the proposed section schema and index page routes.
2. Mechanically migrate the 58 table rows into three priority-range pages, rewrite relative origin URLs, and reduce `backlog_index.md` to policy plus page routes.
3. Run a one-off migration comparison between the HEAD table and working-tree pages to prove all fields survived aside from the intentional representation and relative-link normalization.
4. Update `self-evolution-research`, `self-reflection`, `research_template.md`, and the self-evolution/self-reflection sections of `strands-sdk-contracts.md` for metadata-only discovery, selected-section reads, record mutation, append behavior, and page rollover.
5. Update `spike/verify-skills.ts` workflow/document assertions so they exercise the new contract and all planned invalid fixtures.
6. Run the focused skills suite and typecheck while editing. After source and docs settle, run exactly one complete `pnpm test`, then `pnpm build`; inspect the copied built-in skill text.
7. Run Trellis task validation and `git diff --check`, review the migration diff for unintended content changes, then proceed through the project check/spec/commit workflow.

## Risk and rollback points

- Do not hand-edit historical direction prose during migration; regenerate or fix the transformation if preservation comparison fails.
- Do not create a status/current-work summary in the index; that would introduce a second mutable source.
- Treat broken origin links, duplicated identity/priority, score mismatch, or record loss as migration blockers.
- Keep validation inside the existing offline skills suite; do not add a production parser or dependency for a documentation-only store.
- Update source skill assets first; `dist/` is ignored build output and must not be committed.
