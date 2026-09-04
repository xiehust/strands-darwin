# Design — self-evolution research skill

## Boundary

Implement the feature as a second product-bundled Markdown skill plus persistent documentation contracts. Reuse the existing skill loader, progressive disclosure, slash expansion, build copy, and `developer` supervisor; do not add runtime orchestration or network code.

## Invocation state machine

1. Resolve the repository root and read `docs/research/backlog_index.md` before research.
2. Choose `进行中` first, otherwise the highest-priority `未开始` row. If either exists, skip fresh product research.
3. If no unfinished row exists, inspect Darwin's current source/architecture, gather sourced peer evidence, append one timestamped run to the UTC-date report, propose at most five ranked directions, and add them as `未开始`.
4. Select exactly one direction, transition it to `进行中`, then call `load_skill` for `developer` and supervise that direction under the existing workflow.
5. After independent acceptance, record evidence and transition to `完成`. On failure retain `进行中` with blockers; transition to `放弃` only with an explicit reason.

## Persistence contracts

`docs/research/backlog_index.md` is the source of truth for direction state. Rows have stable IDs, numeric priority/rank, the five evaluation dimensions, source report, evidence, and notes. Only the four specified Chinese status values are valid.

`docs/research/research_<YYYY-MM-DD>.md` is append-only within a UTC day. Each run uses a unique UTC timestamp heading and contains sources, peer highlights, Darwin repository evidence, comparison, up to five directions, scoring, and recommendation. `research_template.md` defines this shape without pretending a research run has occurred.

## Ranking

Score 1–5 dimensions: importance, architecture fit, evidence confidence, implementation difficulty, and implementation risk. Higher is better for the first three and worse for the last two. Use `2 × importance + architecture fit + evidence confidence − implementation difficulty − implementation risk`; retain qualitative rationale and use stable backlog priority to break ties.

## Built-in validation

Replace the loader's one-off developer assertion with a required built-in name list. Tests inspect both skill text and documentation contracts, update built-in-only cardinality assumptions, and test collision reservation for both names. Existing project/global precedence and build copying stay unchanged.

## Compatibility and rollback

No persisted machine-readable schema, dependency, command, or runtime loop is added. Markdown remains human/agent maintained. Rollback removes the new built-in/docs and returns the required-name list/tests/docs to the developer-only state.
