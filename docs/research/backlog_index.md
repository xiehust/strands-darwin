# Darwin self-evolution backlog

This file is the required first-read entry point and source-of-truth router for iteration directions produced by `self-evolution-research` and `self-reflection`. Direction records live only in the routed priority pages below; this index deliberately contains no per-direction status catalogue.

## Direction pages

Pages use stable inclusive ranges of 20 priorities. Closed ranges are never rebalanced; the current range may contain fewer than 20 records.

- [Priorities 001–020](./backlog/directions-001-020.md)
- [Priorities 021–040](./backlog/directions-021-040.md)
- [Priorities 041–060](./backlog/directions-041-060.md)
- [Priorities 061–080](./backlog/directions-061-080.md)
- [Priorities 081–100](./backlog/directions-081-100.md)

Read this index first. For routine selection, search the routed pages for direction headings plus exact `Status`, `Priority`, and `Origin report` metadata; do not load completed records' evidence and notes. Read only the selected direction section and unfinished batch peers sharing its origin report.

## Status and selection contract

Only these status values are valid:

- `not-started` — researched and queued, but implementation has not started;
- `in-progress` — selected for implementation, acceptance, or blocker recovery;
- `done` — independently accepted, with evidence recorded in its direction section;
- `abandoned` — closed by an explicit product decision, with its reason recorded in its direction section.

These four spellings replaced the original Chinese tokens (`未开始`/`进行中`/`完成`/`放弃`) on 2026-08-16; the states themselves are unchanged. Archived Trellis task records and verbatim historical quotes may retain the old spellings as evidence.

Selection order is `in-progress` first, then `not-started`, sorted by ascending **Priority** and then stable **ID**. Search exact metadata across the routed pages; while either unfinished status exists, do not perform fresh product research. Identify the current batch as unfinished directions sharing the newest origin report. Exactly one direction is `in-progress` at a time, but a single invocation works that whole batch, advancing after each accepted closure until the batch is exhausted or a recorded halt condition fires. A child report is not completion evidence: use `done` only after independent acceptance. Keep blocked work `in-progress`; use `abandoned` only with an explicit reason, which may be the score gate below.

## Ranking contract

Rate every dimension from 1 (low) to 5 (high):

- **Importance**: user/product value and urgency; higher is better.
- **Architecture fit**: alignment with Darwin's existing extension points; higher is better.
- **Evidence confidence**: strength of source and Darwin repository evidence; higher is better.
- **Difficulty**: implementation effort and complexity; higher is harder.
- **Risk**: compatibility, safety, and verification risk; higher is riskier.

`Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk`

Score informs ranking but does not replace qualitative rationale, dependency ordering, or safety constraints. **Priority** is the persisted selection order: `1` is highest.

## Score gate

`MINIMUM_IMPLEMENTATION_SCORE = 6`. Every dimension is rated 1–5, so an all-average direction scores exactly 6; below that a direction is not worth an iteration.

A direction scoring below the gate is never appended as `not-started`: the research/reflection report records it as rejected with its score. Any existing direction found below the gate at selection time becomes `abandoned` with the reason `below score gate (Score = <n> < 6)` and is skipped without halting the batch. A below-gate direction is retained only when an explicit safety, correctness, or dependency reason is recorded in Notes. Dimension ratings are never restated to move a direction across the gate; a corrected rating requires a research run that records what changed.

## Record, mutation, and rollover contract

Every direction is one `## <ID> — <direction>` section in exactly one routed page. Its fixed metadata records Status, Priority, Score, all five ratings, and Origin report; the two prose subsections record implementation/acceptance evidence and notes/blockers/abandonment reason. IDs and priorities are stable and globally unique. Do not duplicate mutable direction state in this index.

During implementation, mutate only the selected record. Existing records are never reordered or restated. Fresh accepted research or reflection directions append to the current range page in dependency/priority order, using the next unused stable `SER-NNN` or `SRF-NNN` ID and the next Priority. If that Priority falls outside the current page's range, create `directions-NNN-NNN.md` for the next 20-priority range and add exactly one route above; never rebalance closed pages. Reflection backlog integration is append-only: it may append accepted `SRF` sections and, only on rollover, append the new page route; it never edits an existing direction.
