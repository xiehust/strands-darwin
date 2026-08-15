# Self-evolution research skill

## Goal

Ship a built-in `self-evolution-research` skill that repeatedly learns from comparable coding-agent products, compares sourced peer evidence with Darwin's current code and architecture, maintains a persistent ranked iteration backlog, and uses the existing built-in `developer` workflow to implement one selected direction at a time.

## Background

- Built-in skills are filesystem-backed `SKILL.md` assets under `src/skills/builtin/`; `developer` is currently the only required built-in.
- `pnpm build` already copies the complete built-in tree into `dist/src/skills/builtin`.
- Skill discovery and workflow contracts are covered by `spike/verify-skills.ts`.
- `docs/research/` does not yet exist.
- Every actual `/developer` supervision run must eventually be recorded accurately in `docs/iteration-log.md`.

## Requirements

### R1 — Backlog-first invocation

- Every invocation must inspect `docs/research/backlog_index.md` before any fresh product research.
- If unfinished work exists, prioritize `进行中` first, then the highest-priority `未开始` direction, and perform no fresh product research.
- The only allowed statuses are `未开始`, `进行中`, `完成`, and `放弃`.
- Select exactly one direction for implementation, mark it `进行中`, and load the existing `developer` skill rather than duplicating its orchestration.
- Mark a direction `完成` only after independent acceptance. Otherwise keep it `进行中` with blockers. Use `放弃` only with an explicit reason.

### R2 — Evidence-based fresh research

- Fresh research is allowed only when no unfinished backlog exists.
- Research scope must include Claude Code, Codex, DeepSeek harness, PenguinHarness, and additional relevant products.
- Prefer primary sources and record claim-to-source references. Never fabricate a claim when source access is unavailable.
- Compare peer features and innovations against current Darwin source, tests, README, specs, and architecture rather than against memory.
- Persist every run in `docs/research/research_<YYYY-MM-DD>.md`; multiple UTC-day runs must append distinct timestamped sections without overwriting earlier content.

### R3 — Ranked directions and persistent artifacts

- Propose at most five non-duplicate directions in a fresh research run.
- Rank each with explicit importance and implementation-difficulty dimensions plus architecture fit, evidence confidence, and implementation risk.
- Maintain a documented scoring formula and qualitative recommendation.
- Add new directions to `docs/research/backlog_index.md` with stable IDs, priority, source report, status, and implementation/acceptance evidence fields.
- Provide committed templates/contracts for both daily research reports and the backlog index.

### R4 — Built-in product integration

- Advertise and load `self-evolution-research` through the ordinary progressive-disclosure skill path.
- Treat both `developer` and `self-evolution-research` as required packaged built-ins.
- Preserve deterministic sorting, collision isolation, existing project/global skill behavior, and current build copying.
- Add concise README and backend spec documentation.
- Add no dependency and do not fork the SDK agent loop.

## Acceptance Criteria

- [ ] AC1: Built-in-only discovery finds both required skills; `load_skill` and slash expansion load the new workflow, while prompt metadata omits its full body.
- [ ] AC2: Static verification proves the workflow's backlog-first ordering, no-research-with-unfinished-work rule, exact status vocabulary, same-day append behavior, required product scope, evidence safeguards, maximum-five limit, ranking dimensions, developer handoff, and completion/blocker transitions.
- [ ] AC3: `docs/research/research_template.md` and `docs/research/backlog_index.md` expose independently inspectable report, ranking, source, status, and acceptance contracts.
- [ ] AC4: Required built-in collisions remain isolated and reported, and the compiled build contains the new Markdown asset.
- [ ] AC5: `pnpm tsx spike/verify-skills.ts`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass without network access.
- [ ] AC6: README and `.trellis/spec/backend/strands-sdk-contracts.md` concisely record the durable workflow.
- [ ] AC7: The implementation is reported ready for Host acceptance without inventing acceptance results; the supplied child session/task evidence is appended to `docs/iteration-log.md` only in a later same-session turn after the Host provides exact independent results.

## Out of Scope

- Performing the first peer-product research run or choosing the first product direction now.
- Adding network clients, dependencies, schedulers, or a second agent loop.
- Automating Markdown backlog mutation in TypeScript; the skill owns the documented workflow.
- Committing changes.

## Open Questions

None.
