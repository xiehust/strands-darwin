# SER-033: validate and expire generated memory

## Goal

Fail closed on stale generated project memory by attaching bounded deterministic source anchors, validating them against the current canonical worktree before prompt inclusion, and expiring unconfirmed generated facts after a configurable conservative horizon while preserving explicit user notes.

## Requirements

- Add one strict top-level `memoryHorizonDays` session setting: integer 0–365, default 28; 0 deliberately disables age expiry. Reject wrong types, ranges, and model-entry placement, and preserve it across live model switches and `/clear` inheritance.
- Evolve the project-bound memory manifest compatibly and honestly. Generated facts carry deterministic bounded project-relative regular-file text anchors where safe; legacy or unanchored facts remain unknown. User notes remain explicit fallible context without source validation or automatic expiry.
- Validate through one centralized eligibility projection before startup prompt assembly and on `/memory` management/refresh. Fresh, resumed, and `/clear` continue through `AgentRuntime.create`; management refresh uses the same projection.
- Generated entries enter ambient prompt only when every fact has a current exact anchor and is inside the configured horizon. Changed/deleted/unsafe sources are invalid, horizon crossings are expired, and unanchored/read-error cases are unknown; all are omitted fail closed.
- Validation reads only bounded UTF-8 regular files within the canonical project root, rejects traversal and symlink escape, performs no writes to source/worktree bytes, and uses no fuzzy matching, vectors, model/network work, watcher, timer, dependency, tool, or SDK-loop interception.
- `/memory list/show` reports bounded exact validation state/reason and bounded anchor metadata without source content. Forget, remember, suppression, sensitivity screening, and user-note rebuild survival remain intact.
- Preserve Host-owned dirty research/log files unchanged and stage/commit only scoped SER-033 work.

## Acceptance Criteria

- [ ] Offline config checks prove the 28-day default, valid overrides including documented 0, invalid values/misplacement, and model-switch preservation.
- [ ] Deterministic fixtures cover current/changed/deleted/unanchored/traversing/symlink/binary/oversized/unreadable generated sources plus non-expiring user notes.
- [ ] Exact horizon boundary semantics and injected-clock revalidation/reactivation are proved.
- [ ] Fresh/resumed/`/clear` and live remember/forget share one eligible bounded learned-memory projection and never retain stale generated prompt context.
- [ ] Validation safety/bounds, Unicode preservation, non-leaking reports, and byte-zero source/trajectory/session/config behavior are proved.
- [ ] Focused memory/config/runtime checks, typecheck, full tests, build, Trellis validation, AGENTS size, and scoped diff/commit checks pass.
