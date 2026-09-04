# Agent-managed project memory tools

## Goal

Replace heuristic/post-turn learned-memory extraction with bounded built-in tools that let the active agent decide when durable project knowledge should be saved and when relevant knowledge should be retrieved. Persist memory as strict project-scoped files while preserving user management, evidence validation, and fail-closed prompt-injection boundaries.

## Background

- The current extractor in `src/memory/store.ts` scans durable successful trajectory turns and keeps early answer lines after syntactic filtering. A 2026-08-27 audit found many generated facts but no valid exact anchors, so none entered ambient context.
- The existing implementation already has strict project-keyed state, atomic writes, exact source-anchor validation, expiry, suppression, `/memory` user management, and global project-scoped storage under `~/.darwin/projects/<project-key>/memory/`.
- The product direction changed during planning: do not launch a separate post-turn LLM extraction call. Let the active parent agent use bounded built-in memory tools within its ordinary turn instead.

## Requirements

### Built-in tool behavior

- Provide a parent-only built-in read tool that searches project memory and returns bounded relevant entries as explicitly fallible data. The agent decides when retrieval is useful; no full generated-memory archive is injected into every request.
- Provide a parent-only built-in save tool for atomic durable facts such as confirmed architecture/product decisions, stable repository conventions, verified non-obvious root causes, recurring verification requirements, and explicit durable user preferences.
- Prefer no memory over weak memory. Reject temporary progress, git status and commit hashes, generic headings, one-off commands/results, unanswered questions, unconfirmed proposals, secrets, credentials, prompt boundaries, unrelated bulk dumps, and policy-like instructions. Non-secret account identity may be saved when it is durable and relevant to the project.
- A save issued during a turn is staged and becomes durable only after that turn closes successfully and its trajectory is durable. Failed, cancelled, partial, or non-`endTurn` turns leave no generated memory.
- Tool results are strict, bounded machine-readable projections. Memory tools run through the ordinary SDK tool loop but cannot invoke other tools, edit repository files, create/retry/intercept an agent loop, or trigger a separate model call.

### Evidence, freshness, and state

- Generated code/project claims must carry bounded exact current project-relative evidence that Darwin reopens and hashes itself; model-supplied paths and quotes are never trusted without deterministic validation.
- Explicit user preferences and non-secret account identity must quote exact bounded text from the current user input; Darwin verifies that quote and supplies current session/turn provenance. The model cannot invent either source. Such entries remain project-scoped and are stored only in Darwin's private `0700` directory and `0600` files.
- Invalid or unanchored generated candidates are rejected rather than retained as a growing `unknown` archive.
- Preserve project-key binding, strict parsing, symlink/no-follow protections, age expiry, durable generated-ID suppression, `/memory list|show|forget|remember`, user notes, and deterministic deduplication/supersession.
- Existing trajectory, snapshot, resume pointer, config, and worktree bytes are never rewritten.

### File storage and retrieval

- Keep memory outside the repository under the existing project-keyed Darwin directory so normal memory use does not dirty the worktree.
- Use strict versioned JSON as the authoritative state because it supports exact schema validation, atomic replacement, stable IDs, provenance, anchors, suppression, and migration. A bounded Markdown index may remain as a human-readable projection but is never authoritative or parsed back as trusted memory.
- Retrieval is local and deterministic: bounded lexical ranking/listing over the validated store, with no vector database, embedding model, network call, or hidden second LLM call.
- Returned entries are revalidated before use and explicitly labelled as fallible context rather than instructions or policy.

### Configuration, permissions, and lifecycle

- `memory: false` and effective trajectory opt-out expose neither model-facing memory tool and create no memory state.
- `memory_recall` is classified as a statically safe local read and runs silently. `memory_save` is classified as an ordinary write: default mode asks, auto mode uses the existing classifier path, plan mode denies, and yolo mode runs silently. No memory-specific permission exception or allow-rule exists.
- Parent and subagent memory state are isolated: subagents cannot save or retrieve project memory on the parent's behalf.
- Cancellation, failed/partial turns, and `/clear` before a turn is durably closed discard staged saves. Once a successful `endTurn` is durably recorded, orderly retirement or shutdown may finish its already-accepted serialized commit; areas without a durable settlement are discarded. Resume starts with no staged state.
- Existing `/memory` remains the user-only management and audit surface; model tools do not gain forget, bulk export, arbitrary file, or raw-state operations.

## Acceptance Criteria

- [x] Offline fixtures prove the agent-facing tools can save and retrieve durable decisions, root causes, preferences, and non-secret account identity, while secrets, credentials, temporary facts, policy-like text, oversized or malformed candidates, and unrelated dumps are rejected.
- [x] A save becomes visible only after a successful durable `endTurn`; failure, cancellation, partial output, undurable recording, and `/clear` before durable close discard it, while orderly shutdown may finish an already accepted durable commit.
- [x] Every accepted generated project fact is independently bounded, evidence-backed, deterministically revalidated, and returned only as fallible data.
- [x] Retrieval is bounded, deterministic, project-scoped, network-free, and does not inject the complete memory archive into every model request.
- [x] Duplicate facts collapse deterministically and a newer validated fact can supersede a conflicting stale generated fact without replacing user-authored notes.
- [x] `memory: false` and trajectory-disabled configurations expose no memory tools and preserve the current no-store behavior.
- [x] `/memory` management, suppressions, explicit user notes, expiry, strict state/path safety, and byte-purity of source records continue to pass focused checks.
- [x] Existing valid state has an explicit migration path; invalid legacy generated entries are not silently trusted or backfilled by a model call.
- [x] Specs, architecture rationale, English/Chinese user documentation, and AGENTS.md's load-bearing index describe agent-managed on-demand memory accurately.
- [x] Focused offline suites, `pnpm typecheck`, and `pnpm test` pass. No live extraction/retrieval check is required because those operations add no model call; auto mode retains its existing permission-classifier model call and is verified through the injected offline classifier seam.

## Out of Scope

- Vector/embedding retrieval or semantic search.
- A separate extraction model, second general-purpose `Agent`, or post-turn model call.
- Subagent access to project memory.
- A model-facing forget/delete/raw-state tool.
- Secret or credential persistence, a secret manager, credential rotation, or a cross-project credential vault.
- Letting memory tools edit arbitrary files or repository source.
- Rewriting trajectory history, snapshots, or resume pointers.

## Open Product Decision

- None currently; the permission and secret-handling behavior is resolved above.
