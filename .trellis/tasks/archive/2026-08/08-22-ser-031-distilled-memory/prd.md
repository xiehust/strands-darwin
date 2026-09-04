# SER-031 distilled project memory

## Goal

Add an opt-in, project-scoped derived memory store that distills only durable successful trajectory turns into bounded inspectable Markdown and loads only its compact index as explicitly fallible context.

## Requirements

- Add a strictly validated root/session config boolean, default off.
- Store generated memory outside the repository under Darwin's existing stable project scope, as one bounded `index.md` plus bounded topic Markdown files with source session/turn/sequence/time provenance.
- Derive only after a turn is user-visible and its closing trajectory batch is durable. Eligible turns must be closed successful `endTurn` turns with a final assistant answer and enough substantive text; skip active, failed, cancelled, damaged, truncated, or short turns.
- Distillation is deterministic and offline. It may use only the final assistant answer, never reasoning or tool event payloads. Drop code/log/dump-like and sensitive candidates, state candidate omissions, and enforce field/file/topic-count bounds.
- Extraction is detached, serialized/coalesced, timeout-bounded, fail-open, and observable through existing post-turn/terminal warning surfaces without adding a live-frame row.
- Keep source trajectory and unrelated state byte-identical. Do not add a model tool, vectors, embeddings, dependencies, SDK-loop interception, `/memory`, or aging/revalidation.
- On enabled fresh, resumed, and `/clear` factory construction, load the current bounded index exactly once below project instructions/official skills and before working context/final cache point. Label it fallible learned context, never instructions or policy. Do not inject topic bodies.
- Preserve the existing base → project instructions → official skills → working context → final cache order, extended only by the new learned-memory block at the documented lower-authority position.

## Acceptance Criteria

- [ ] Missing/false config creates and injects nothing; `true` opts in; non-boolean and misplaced model-entry values fail with `ConfigError`.
- [ ] Focused offline fixtures prove only eligible durable closed successful turns generate bounded human-readable index/topic Markdown with stable project scope and provenance.
- [ ] Credentials, tokens, `.env` material, reasoning, tool dumps, code/log/JSON-like text, truncated/over-bound fields, and ambiguous sensitive candidates do not enter memory; omission counts are explicit.
- [ ] Source trajectory plus unrelated config/session files remain byte-identical.
- [ ] Failure, timeout, queue pressure, and unwritable storage do not reject or materially delay the turn and expose one bounded warning through existing surfaces.
- [ ] Prompt probes prove one labelled index in the safe position for fresh/resumed runtimes; topic files are absent from the prompt; `/clear` uses the normal factory and current store.
- [ ] Repository contains no `search_memory`, vector/embedding dependency, generic persistence tool, SDK-loop fork, or new dependency.
- [ ] Focused suite, typecheck, complete `pnpm test`, relevant specs/docs, and the AGENTS architecture index are green/current; AGENTS.md remains under 32 KiB.

## Source and constraints

- Direction: `docs/research/research_2026-08-22.md`, run `2026-08-22T03:02:03Z`, S1–S7 and current-Darwin evidence.
- Supersedes the raw model-facing trajectory search reverted in `076d9dd`; that design must not return.
- Host-owned `docs/research/backlog_index.md`, `docs/research/research_2026-08-22.md`, and `docs/iteration-log.md` are read-only for this task.
