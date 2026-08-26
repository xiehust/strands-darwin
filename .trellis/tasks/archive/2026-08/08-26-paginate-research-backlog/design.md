# Design — paged self-evolution backlog

## Boundary

Retain Markdown as the only backlog store. `docs/research/backlog_index.md` remains the stable entry point and policy document; immutable priority-range pages below `docs/research/backlog/` own every direction record. No runtime code reads or writes the backlog.

## File and record shape

Pages use inclusive 20-priority ranges named `directions-NNN-NNN.md`. A direction belongs to the page whose range contains its persisted Priority; completed pages are never rebalanced and the current page may be partially filled.

Each page contains direction sections in ascending Priority:

```markdown
## SER-040 — Add conversation rewind

- Status: `done`
- Priority: 58
- Score: 10
- Importance: 5
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 4
- Origin report: [`research_2026-08-26.md`](../research_2026-08-26.md) (run `12:29:54Z`, rolled `peer` path)

### Implementation / acceptance evidence

...

### Notes / blockers / abandonment reason

...
```

The fixed labels make metadata searchable and mechanically verifiable while prose fields remain ordinary readable Markdown. The title carries the stable ID and full direction text. Every record owns its status; the index contains page routes and policy only, never a status mirror.

## Selective workflow

1. Read the small index first.
2. Use a metadata-only search across routed pages for section headings plus Status, Priority, and Origin report lines. This discovers unfinished work and batch membership without placing completed evidence/notes into model context.
3. Read only the selected direction section and unfinished records sharing its origin report.
4. Mutate only the selected record during implementation. Append accepted research/reflection records to the current range page; if the next Priority falls outside it, create the next range page and append one route to the index.

The same metadata search supplies the highest existing Priority and used SER/SRF IDs for duplicate prevention. Lower numeric Priority and stable-ID tie breaking remain unchanged.

## Migration

Transform each existing table row mechanically into one section. Preserve cell text verbatim for direction, evidence, and notes; preserve every scalar exactly; rewrite only relative Markdown URL targets to account for the additional `backlog/` path segment. A migration check compares parsed old rows with parsed new sections after normalizing those expected URL-base changes.

## Validation

Extend `spike/verify-skills.ts` with a pure parser/validator used against both the repository pages and deliberately malformed in-memory fixtures. It verifies:

- every index route resolves to a page and no unlisted page exists;
- page filename ranges are valid, non-overlapping, and hold no more than 20 records;
- each record has one complete fixed field set and belongs to its page by Priority;
- IDs and priorities are globally unique and records are ordered;
- statuses use exactly the four allowed values;
- all five ratings are 1–5 and Score arithmetic is exact;
- each local Origin report Markdown link resolves from its page;
- negative fixtures actually produce the expected failures, avoiding a validator exercised only on green production data.

Existing string assertions are updated to enforce the paged workflow language and thin-index contract rather than the former monolithic table.

## Compatibility and rollback

README and historical docs continue linking to `backlog_index.md`, so their stable entry point does not change. Source built-in skill assets and the SDK contract change together; `pnpm build` refreshes ignored `dist/` assets for inspection. Rollback restores the single table and the previous workflow/test wording in one commit; no persisted machine schema or user data migration exists outside Git history.
