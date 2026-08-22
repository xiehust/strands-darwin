# Enable project memory by default

## Goal

Make learned project memory available without requiring users to discover and add `"memory": true`, while preserving its existing bounded, project-scoped, validated, advisory behavior.

## Background

- `memory` is currently optional and absence leaves memory disabled (`src/config.ts:236-237`, `src/config.ts:848-855`, `spike/verify-memory.ts:50-54`).
- Runtime assembly activates memory only when the validated config is exactly `true`; activation controls startup loading, pre-request validation, delayed post-turn rebuilding, and `/memory` management (`src/agent/runtime.ts:426-427`, `592`, `714`, `804`).
- Generated memory depends on the append-only trajectory. Explicit `memory: true` with `trajectory: false` is currently a startup `ConfigError` (`src/config.ts:851-852`).
- Memory already has strict project scoping, secret/dump filtering, exact source validation, 28-day generated-fact expiry, bounded prompt injection, and local user-only management. This task changes the default, not those safety boundaries.
- The current working tree contains an uncommitted README configuration refresh requested immediately before this task; implementation must preserve and reconcile it rather than overwrite it.

## Requirements

1. A missing `memory` field enables learned project memory by default when trajectory recording is available.
2. Explicit `"memory": false` remains the supported opt-out and must install no memory scheduler, create no memory store, and inject no learned-memory block.
3. For backward compatibility and privacy intent, `"trajectory": false` with omitted `memory` implicitly disables memory. Explicit `"memory": true` combined with `"trajectory": false` remains a startup error.
4. Existing validation remains strict: non-boolean values and placement inside a `models` entry are startup errors.
5. Generated-memory validation, expiry, sensitivity filtering, prompt ordering, management grammar, failure degradation, and project storage paths remain unchanged.
6. Documentation and load-bearing contracts must state the new default, the explicit opt-out, and the trajectory compatibility rule.
7. Focused configuration/memory tests must prove default-on, explicit opt-out, and implicit trajectory opt-out behavior; the full project quality gates must remain green.

## Acceptance Criteria

- [x] Loading configuration with no file, or with a file that omits `memory`, produces an effective config with memory enabled.
- [x] A normal successful durable turn under omitted `memory` can schedule the existing bounded memory rebuild path.
- [x] `"memory": false` disables startup prompt loading, pre-request refresh, scheduler creation, local `/memory` mutation, and memory-store creation exactly as the old absent-field behavior did.
- [x] Invalid `memory` values and model-entry placement are still rejected with actionable `ConfigError` messages.
- [x] `"trajectory": false` with omitted `memory` loads successfully with effective memory disabled, while explicit `"memory": true` with `"trajectory": false` remains a startup error.
- [x] README, `AGENTS.md`, architecture decisions, and backend specs no longer describe learned memory as opt-in/default-off.
- [x] `pnpm typecheck`, focused memory/config suites, `pnpm test`, and `git diff --check` pass.

## Out of Scope

- Changing memory extraction, source validation, expiry duration, storage format/path, prompt bounds, or `/memory` commands.
- Adding model calls, embeddings, vector search, watchers, polling, or a model-facing memory tool.
- Migrating or deleting existing memory state.
- Enabling session diagnostics or context offloading by default.

## Key Decisions

- `"trajectory": false` with omitted `memory` is an implicit memory opt-out, preserving formerly valid configurations and respecting the user's explicit choice not to record trajectories.
- Explicit `"memory": true` with `"trajectory": false` remains invalid because the requested memory source cannot exist.
