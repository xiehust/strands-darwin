# Darwin self-evolution backlog

This file is the source of truth for iteration directions produced by `self-evolution-research`. Every invocation reads it before consulting product-research sources.

## Status contract

Only these status values are valid:

- `未开始` — researched and queued, but implementation has not started;
- `进行中` — selected for implementation, acceptance, or blocker recovery;
- `完成` — independently accepted, with evidence recorded below;
- `放弃` — closed by an explicit product decision, with its reason recorded below.

Selection order is `进行中` first, then `未开始`, sorted by ascending **Priority** and then stable **ID**. While either unfinished status exists, do not perform fresh product research. Exactly one row is `进行中` at a time, but a single invocation works the whole **batch** — the unfinished rows sharing one origin report — advancing to the next direction after each one is accepted and closed, until the batch is exhausted or a recorded halt condition fires. A child report is not completion evidence: use `完成` only after independent acceptance. Keep blocked work `进行中`; use `放弃` only with an explicit reason, which may be the score gate below.

## Ranking contract

Rate every dimension from 1 (low) to 5 (high):

- **Importance**: user/product value and urgency; higher is better.
- **Architecture fit**: alignment with Darwin's existing extension points; higher is better.
- **Evidence confidence**: strength of peer sources and Darwin repository evidence; higher is better.
- **Difficulty**: implementation effort and complexity; higher is harder.
- **Risk**: compatibility, safety, and verification risk; higher is riskier.

`Score = 2 × Importance + Architecture fit + Evidence confidence − Difficulty − Risk`

Score informs ranking but does not replace qualitative rationale, dependency ordering, or safety constraints. **Priority** is the persisted selection order: `1` is highest.

## Score gate

`MINIMUM_IMPLEMENTATION_SCORE = 6`. Every dimension is rated 1–5, so an all-average direction scores exactly 6; below that a direction is not worth an iteration.

A direction scoring below the gate is never added as `未开始` — the research report records it as rejected with its score — and any existing row found below the gate at selection time becomes `放弃` with the reason `below score gate (Score = <n> < 6)` and is skipped without halting the batch. One exception and one prohibition: a below-gate direction is kept only when an explicit safety, correctness, or dependency reason is recorded in its Notes; and dimension ratings are never restated to move a direction across the gate — a corrected rating must be introduced by a research run that says the correction is what changed.

## Directions

<!-- Append directions below. Use stable IDs such as SER-001; never renumber existing rows. -->

| ID | Direction | Status | Priority | Score | Importance | Architecture fit | Evidence confidence | Difficulty | Risk | Origin report | Implementation / acceptance evidence | Notes / blockers / abandonment reason |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| SER-001 | Add an enforced read-only planning permission mode | 完成 | 1 | 16 | 5 | 5 | 5 | 2 | 2 | [`research_2026-08-15.md`](./research_2026-08-15.md) | Accepted in `e2e1463`: Host inspected the commit/diff and re-ran `pnpm typecheck`, `pnpm test`, `spike/verify-tui.ts plan` (4 passed), Trellis validation, `git diff --check`, and clean-tree verification successfully. | `plan` denies write/execute before hooks, rules, classifiers, and prompts; the shared intervention covers child agents. Unknown tools remain fail-closed as execute. |
| SER-002 | Make subagent work parallel and inspectable with source-labelled status and approvals, initially for read-heavy delegation | 完成 | 2 | 8 | 4 | 3 | 5 | 4 | 4 | [`research_2026-08-15.md`](./research_2026-08-15.md) | Accepted in `404aa1c`: Host inspected all 27 files and re-ran `pnpm typecheck`, `pnpm test` (24 suites, 0 FAIL), `verify-subagents.ts` (66 passed, measured two-dispatch overlap plus resolved parent/child sources), `verify-tui.ts agents` (6), `completion` (20), `approve` (23, incl. the no-added-frame-row assertion), `cancelThenContinue` (5), `bashExit` (3), Trellis validation and `git diff --check` successfully. | Concurrency was already real (SDK default `ConcurrentToolExecutor`, measured 303 ms for two 300 ms children) so it is pinned by test and contract rather than built; approvals remain serialized by the SDK's single hook loop. Concurrent write delegation is still unguarded by design — documented, not prevented. |
| SER-003 | Add append-only session trajectory export plus search/fork/replay primitives over SDK events | 未开始 | 3 | 8 | 4 | 3 | 5 | 5 | 3 | [`research_2026-08-15.md`](./research_2026-08-15.md) | — | Must remain an observer/adapter around the SDK loop and define replay correctness. |
| SER-004 | Add an optional isolated execution backend for shell/file mutation | 未开始 | 4 | 7 | 5 | 2 | 5 | 5 | 5 | [`research_2026-08-15.md`](./research_2026-08-15.md) | — | High security value but requires a design spike for portability, mounts, credentials, and persistent-shell behavior. |
| SER-005 | Establish a stable local coding-agent evaluation corpus and regression scorecard for self-evolution | 未开始 | 5 | 6 | 4 | 3 | 4 | 5 | 4 | [`research_2026-08-15.md`](./research_2026-08-15.md) | — | Measurement must precede automated optimization; PenguinHarness benchmark results are publisher claims and its public suite is roadmap work. |
