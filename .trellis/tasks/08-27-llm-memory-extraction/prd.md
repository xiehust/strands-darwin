# LLM-based learned memory extraction

## Goal

Replace the current first-lines heuristic with a bounded LLM distillation step so learned project memory retains only durable, future-useful facts from completed coding turns while preserving Darwin's existing project scope, user management, validation, and fail-closed prompt-injection boundaries.

## Background

- The current extractor in `src/memory/store.ts` is deterministic and keeps up to eight early answer lines after syntactic filtering. A 2026-08-27 audit found 25 generated entries / 174 facts in this project, but zero exact anchors and zero entries eligible for ambient context; across all local projects, all 36 generated entries were `unknown`.
- The existing design derives only from closed durable successful trajectory turns, schedules work after the visible turn, stores strict project-keyed state, excludes invalid/unknown/expired generated context before every request, and keeps `/memory remember` notes distinct.
- The current architecture and specs explicitly say extraction makes no model/network call. This task intentionally changes that product decision while retaining the rule that extraction never forks or participates in the parent SDK agent loop.
- `@strands-agents/sdk@1.12.0` already ships `ModelExtractor`, which makes a direct `Model.streamAggregated()` call with a dedicated system prompt and parses bounded fact-shaped JSON. The SDK also supports Agent structured output, but Darwin's invariant permits only `src/agent/runtime.ts` to construct `Agent`; a direct model-based extraction boundary avoids a second agent loop.

## Requirements

### Extraction behavior

- Use an LLM after an eligible turn becomes durable to select semantic memory candidates; do not ask the parent answer to emit a memory-specific section.
- Prefer no memory over weak memory. Retain only durable information likely to help a future coding session, including confirmed product/architecture decisions, stable repository conventions, verified non-obvious root causes, recurring verification requirements, and explicit durable user preferences.
- Reject temporary progress, git status and commit hashes, generic headings, one-off commands/results, unanswered questions, unconfirmed proposals, facts obvious from current source without additional value, and sensitive or identity-bearing material.
- Produce a strict bounded machine-readable result. Malformed, oversized, incomplete, policy-like, or sensitive output produces no generated memory and cannot fail the completed user turn.
- Keep generated candidates atomic and independently validatable rather than invalidating an entire multi-fact topic because one candidate lacks evidence.

### Evidence, freshness, and state

- Generated code/project claims must carry bounded exact current project-relative evidence that Darwin reopens and hashes itself; model-supplied evidence is never trusted without deterministic validation.
- A candidate without acceptable evidence must not enter ambient context. The design must decide whether it is omitted entirely or retained as visibly ineligible audit state without recreating the current large `unknown` archive.
- Preserve project-key binding, strict state parsing, symlink/no-follow protections, age expiry, durable generated-ID suppression, `/memory list|show|forget|remember`, user notes, and the single bounded `<learned-memory>` block.
- Define deterministic deduplication/supersession so a newer confirmed fact can replace a conflicting stale one instead of accumulating both.
- Define migration/rebuild treatment for current v2 generated entries and existing trajectory history; no existing trajectory, snapshot, resume pointer, config, or worktree byte may be rewritten.

### Scheduling, cost, and observability

- The extraction model call stays outside the visible turn's critical path and outside the parent conversation. Failure, timeout, cancellation, shutdown, or malformed output degrades by skipping extraction and surfacing a bounded existing memory-status problem.
- Calls are serialized/coalesced and bounded by input size, output size, candidate count, timeout, and retry policy. There is no autonomous retry loop.
- Extraction calls and token usage must be observable and distinguishable from parent-turn usage; they must not be silently attributed to the parent trajectory spend.
- `memory: false` and effective trajectory opt-out continue to make no extraction call and create no memory state.

### Safety and architecture

- Extraction input is limited to bounded eligible user/final-answer evidence and only the minimum project evidence needed for validation. Reasoning, raw tool payloads, credentials, environment dumps, and child transcripts remain excluded.
- Treat trajectory/model content as untrusted data inside explicit prompt boundaries; extracted text can never become instructions, permissions, hooks, tool calls, or a model-facing write/search tool.
- Reuse the configured Strands model abstraction and SDK-supported direct model extraction behavior; do not add a provider SDK path, vector index, embedding dependency, model-facing memory tool, or second general-purpose `Agent`.
- Preserve delayed post-durable scheduling and the centralized pre-request eligibility projection.

## Acceptance Criteria

- [ ] A deterministic offline model fixture proves durable decisions/root causes/preferences are selected while temporary progress, headings, questions, unconfirmed recommendations, secrets, account identities, and malformed output are rejected.
- [ ] Every accepted generated fact is independently bounded, evidence-backed, and deterministically revalidated; one rejected candidate does not suppress unrelated valid candidates.
- [ ] A seeded real-world-style trajectory corpus produces useful eligible facts rather than zero anchors, and stale/conflicting facts are deterministically omitted or superseded.
- [ ] Extraction runs only after a closed successful durable turn, never delays or changes the parent stream/result/trajectory, and at most the configured bounded work is launched per coalesced batch.
- [ ] Provider failure, timeout, cancellation, invalid JSON/schema, and shutdown leave the prior valid store usable, report one bounded degradation, and cause no automatic retry storm.
- [ ] `memory: false` and trajectory-disabled configurations make zero extractor model calls and preserve the current no-store/no-prompt behavior.
- [ ] `/memory` management, suppressions, explicit user notes, expiry, startup/resume/`/clear` prompt ordering, strict state/path safety, and byte-purity of source records continue to pass focused checks.
- [ ] Extraction model token use is exposed separately from ordinary parent-turn usage and documented as billable provider work.
- [ ] Specs, architecture rationale, English/Chinese user documentation, and AGENTS.md's load-bearing index no longer claim model/network-free extraction.
- [ ] Offline focused suites, `pnpm typecheck`, and `pnpm test` pass; a separately named live check demonstrates one real configured-provider extraction call and valid persisted output.

## Out of Scope

- Vector/embedding retrieval or semantic search.
- A model-facing `remember`/`search_memory` tool.
- Letting the extractor edit arbitrary files or invoke tools.
- Rewriting trajectory history, repository source, snapshots, or resume pointers.
- Replacing explicit `/memory remember` user notes with generated entries.

## Open Product Decision

- Which configured model should perform the additional billable extraction call, and how should its cost be controlled when memory remains default-on?
