# SER-038 lifecycle observation hooks

## Goal

Extend Darwin's existing layered command-hook policy with exactly two bounded, observation-only lifecycle events: `TurnComplete` and `PermissionRequest`.

## Requirements

- Accept only the existing command-hook schema under exactly four hook keys: `PreToolUse`, `PostToolUse`, `TurnComplete`, and `PermissionRequest`; unknown fields or malformed lifecycle groups/commands fail configuration with source-path reporting.
- Discover lifecycle hooks through all four existing extension layers and direct/fallback files. Preserve the existing deterministic wrapper source order: global `.agents` → global `.darwin` → project `.agents` → project `.darwin` for publication; do not reverse lifecycle hooks as Post wrappers are reversed.
- Spawn nothing when lifecycle hooks are absent.
- Write exactly one newline-terminated, bounded JSON object to each matching command's stdin. Payloads expose only the event contract:
  - `TurnComplete`: event name, outcome (`success`, `failure`, or `cancelled`), and source.
  - `PermissionRequest`: event name and the already-assessed permission source label.
- Publish one `PermissionRequest` observation for each logical prompt shown to the user, not for every gate re-decision; queued prompts publish when they become current, withdrawn prompts are not republished, and no prompt publishes after closure.
- Publish one `TurnComplete` for every interactive or headless model turn, after its success/failure/cancellation outcome is known. Continuation behavior remains owned by the existing drivers and does not move into the SDK loop.
- Lifecycle commands are fire-and-observe: do not await their completion in a turn or permission decision. Suppress stdout/stderr and all launch/exit failures. Never write terminal output, alter model context, answer permissions, synthesize tool events, add trajectory records, or intercept/fork the SDK loop.
- Own every spawned command as a process group. Cancellation, `/clear` retirement, and process shutdown request TERM, escalate to KILL after the existing bounded grace period, and reap the children without blocking the user-visible operation.
- Keep `AgentRuntime.create` as the only `Agent` construction boundary.

## Acceptance Criteria

- [x] Strict config tests prove exact keys/schema, source-path errors, all four layers, direct/fallback discovery, deterministic lifecycle ordering, and no spawn with absent lifecycle config.
- [x] Runner tests prove one bounded JSON object per command, output suppression, non-blocking behavior, failure isolation, and TERM→KILL process-group cleanup.
- [x] Permission queue tests prove source payload and exactly-once publication across current, queued, withdrawn, denied, and closed requests.
- [x] Interactive and headless offline tests prove all three turn outcomes and sources without provider calls, with no changes to terminal/model/tool/trajectory output.
- [x] `/clear`, cancel, and shutdown cleanup are covered offline.
- [x] Existing hook/config/state-layer/permission/subagent/trajectory/headless suites pass.
- [x] Final `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.
- [x] Load-bearing architecture docs, backend hook/error contracts, AGENTS index, and user extension guide describe the exact lifecycle contract.

## Scope exclusions

- No generic plugin API or additional lifecycle names.
- No built-in desktop notification behavior.
- No hook return-value protocol, permission mediation, model injection, trajectory event, or SDK-loop changes.
- No dependency changes, publication, or originating research/backlog/supervision-log edits.
