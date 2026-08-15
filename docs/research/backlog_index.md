# Darwin self-evolution backlog

This file is the source of truth for iteration directions produced by `self-evolution-research`. Every invocation reads it before consulting product-research sources.

## Status contract

Only these status values are valid:

- `未开始` — researched and queued, but implementation has not started;
- `进行中` — selected for implementation, acceptance, or blocker recovery;
- `完成` — independently accepted, with evidence recorded below;
- `放弃` — closed by an explicit product decision, with its reason recorded below.

Selection order is `进行中` first, then `未开始`, sorted by ascending **Priority** and then stable **ID**. While either unfinished status exists, do not perform fresh product research. Change only one selected row to `进行中` per invocation. A child report is not completion evidence: use `完成` only after independent acceptance. Keep blocked work `进行中`; use `放弃` only with an explicit reason.

## Ranking contract

Rate every dimension from 1 (low) to 5 (high):

- **Importance**: user/product value and urgency; higher is better.
- **Architecture fit**: alignment with Darwin's existing extension points; higher is better.
- **Evidence confidence**: strength of peer sources and Darwin repository evidence; higher is better.
- **Difficulty**: implementation effort and complexity; higher is harder.
- **Risk**: compatibility, safety, and verification risk; higher is riskier.

`Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk`

Score informs ranking but does not replace qualitative rationale, dependency ordering, or safety constraints. **Priority** is the persisted selection order: `1` is highest.

## Directions

| ID | Direction | Status | Priority | Score | Importance | Architecture fit | Evidence confidence | Difficulty | Risk | Origin report | Implementation / acceptance evidence | Notes / blockers / abandonment reason |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|

<!-- Append directions below. Use stable IDs such as SER-001; never renumber existing rows. -->
