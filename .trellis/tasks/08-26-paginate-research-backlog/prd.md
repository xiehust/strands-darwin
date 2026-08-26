# Paginate self-evolution backlog directions

## Goal

Keep the self-evolution backlog authoritative and auditable while making routine backlog inspection load only a small routing index and the direction records relevant to the current operation, rather than the current 96 KB monolithic Markdown table.

## Background

- `docs/research/backlog_index.md` currently contains 58 direction rows and is 96,194 bytes. Most bytes are completed directions' implementation evidence and notes.
- The built-in `self-evolution-research` and `self-reflection` workflows, their backend contract, the research template, and `spike/verify-skills.ts` all name the monolithic backlog contract.
- Direction status is mutable during implementation, while IDs, priorities, scores, origin links, evidence, and notes must remain inspectable history.
- The user approved a thin index plus stable priority-range pages, with one readable section per direction and no duplicated mutable status summary in the index.

## Requirements

1. Keep `docs/research/backlog_index.md` as the required first-read entry point and source-of-truth router. It must retain the status, ranking, score-gate, selection, and batch contracts, but not embed direction records.
2. Store direction records under `docs/research/backlog/` in stable priority ranges of 20: `directions-001-020.md`, `directions-021-040.md`, `directions-041-060.md`, then the same zero-padded pattern for later ranges. Closed ranges are never rebalanced; the current range may contain fewer than 20 records.
3. Represent each direction as a Markdown section with exactly one authoritative copy of its ID, direction text, status, priority, score, five ratings, origin report, implementation/acceptance evidence, and notes/blocker/abandonment field. Do not duplicate mutable direction state in `backlog_index.md`.
4. Preserve all 58 existing directions and their semantics during migration: IDs, text, status, priority, score dimensions, origin targets, evidence, and notes. Adjust relative Markdown links only as required by the deeper directory.
5. Make backlog-first operations selective: inspect the index, search page records for exact unfinished statuses, then read only the selected direction and its batch peers. Fresh additions append to the current page; when its 20-record range is full, create the next page and add its route to the index.
6. Update both built-in workflows, the research template, and the backend self-evolution/self-reflection contracts so selection, status transitions, reflection append-only behavior, mutation scope, and new-page rollover all target the paged layout without weakening existing rules.
7. Extend the existing offline skills verification with a lightweight backlog validator covering routed-page existence, page capacity/range membership, globally unique IDs and priorities, the exact status vocabulary, required fields, score arithmetic, and resolvable local origin links.
8. Keep this a Markdown documentation contract. Add no runtime datastore, dependency, CLI command, generated mutable status mirror, or model/network call.

## Acceptance Criteria

- [ ] `backlog_index.md` is a small routing/contract document with links for all existing priority pages and contains no direction-record sections or second mutable status catalogue.
- [ ] Pages `001-020`, `021-040`, and `041-060` contain exactly the existing 58 directions in ascending priority, at most 20 per page, with one complete section per direction.
- [ ] A migration comparison against the pre-change table confirms every existing field is preserved after normalizing the intentional layout and relative-link changes.
- [ ] The built-in research workflow can find `in-progress` before `not-started`, identify the newest-origin unfinished batch, update one record, append new records, and roll over a full page without reading every completed record into context.
- [ ] The built-in reflection workflow appends accepted `SRF` records to the current page without editing existing records, except that creating a new page also adds one route in the index.
- [ ] `spike/verify-skills.ts` rejects invalid statuses, duplicate IDs/priorities, wrong score arithmetic, misplaced/over-capacity records, missing routed pages, incomplete fields, and broken local origin links through non-vacuous fixture checks or equivalent exercised validation paths.
- [ ] `pnpm tsx spike/verify-skills.ts`, `pnpm typecheck`, `pnpm test`, `pnpm build`, Trellis task validation, and `git diff --check` pass; the built skill copies in `dist/` reflect the new contract after build inspection.

## Out of Scope

- Changing direction priorities, scores, statuses, wording, acceptance decisions, or research findings.
- Splitting dated research reports or `docs/iteration-log.md`.
- Adding backlog filtering/search UI, a database, JSON/YAML source of truth, or a new CLI command.
- Rewriting historical Trellis task files, reflection reports, or dated research reports that link to the stable index entry point.

## Risks and Constraints

- Relative origin links change depth when records move; validation must prove they still resolve.
- A duplicated status summary would recreate synchronization risk, so the index may route by priority range but may not own per-direction state.
- Historical evidence contains long prose; migration must be mechanical and lossless rather than editorial.
- The source skill files under `src/skills/builtin/` are authoritative; `dist/` is build output and remains untracked.
