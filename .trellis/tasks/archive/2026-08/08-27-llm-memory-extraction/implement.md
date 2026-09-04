# Implementation plan — Agent-managed project memory tools

## Change boundary

Replace only the current generated-memory producer and ambient consumer:

- producer: remove trajectory rescan scheduling and add parent-only staged `memory_save`;
- consumer: remove full prompt injection and add parent-only bounded `memory_recall`;
- keep the strict project-scoped state, validation, projections, `/memory` user management, configuration opt-out, and existing degradation surfaces.

No provider/model path, Agent loop, subagent catalogue, vector index, trajectory schema, live-frame surface, or repository write path is added.

## Ordered implementation

### 1. Define the v3 authoritative entry and migration contracts

Files:

- `src/memory/state.ts`
- `src/memory/validation.ts`
- `src/memory/store.ts`

Work:

- Introduce atomic generated entries with stable key, category, one fact, host-owned source, and project/turn evidence variants.
- Keep user-authored notes and generated suppressions distinct.
- Centralize candidate screening so `/memory remember` and model saves share prompt-boundary, secret/credential, control, and dump rejection without weakening user-note policy.
- Expose a strict exact-line resolver and a non-persisting validation path for tools.
- Add deterministic ID, duplicate collapse, distinct same-key supersession across turns, legacy lineage/suppression mapping, v2 read migration, and bounded v3 atomic commit.
- Keep `state.json` authoritative and regenerate only one bounded `index.md` after state commits; remove obsolete legacy topic projections on authorized mutation.
- Remove trajectory scanning/first-lines extraction code and obsolete scheduler rebuild entry points once all callers move.

Verification gate:

- Extend `spike/verify-memory-validation.ts` for project evidence, turn provenance, expiry, secret rejection, duplicate/supersession behavior, v2 migration, no-follow safety, and state/projection bounds.
- Run `pnpm tsx spike/verify-memory-validation.ts`.

Rollback point: v3 parsing/writing/migration is isolated and verified before runtime tool registration changes.

### 2. Add the parent-only tool controller

Files:

- `src/memory/tools.ts` (new)
- `src/memory/controller.ts` (new, if separating schemas from lifecycle keeps each module bounded)
- `src/agent/runtime.ts`

Work:

- Implement strict Zod schemas and bounded JSON results for `memory_recall` and `memory_save`.
- Bind both callbacks to one runtime-owned controller.
- Register tools only on the parent after child catalogues are fixed and only when effective memory is enabled.
- Stage at most the bounded per-turn candidate count; require a unique current-input `userQuote` for preference/identity; reject a distinct second candidate with the same normalized key; do no persistence in `memory_save`.
- Implement deterministic validated lexical recall with `persist: false`; never include staged candidates.
- Remove startup/pre-request `loadMemoryIndex()` and `<learned-memory>` application.
- Replace `MemoryScheduler` ownership/status with controller ownership/status.

Verification gate:

- Add `spike/verify-memory-tools.ts` using real SDK tools and offline fixtures.
- Prove schema bounds, no-hit recall, deterministic ranking, strict project scope, secret/credential rejection, parent-only registration, opt-out absence, no model/network call, and no write from recall.
- Run `pnpm tsx spike/verify-memory-tools.ts`.

Rollback point: tools can be exercised against fixtures while durable commit remains disabled.

### 3. Bind staged saves to exact durable successful turns

Files:

- `src/trajectory/writer.ts`
- `src/agent/runtime.ts`
- `src/memory/controller.ts`
- `spike/verify-trajectory.ts`
- `spike/verify-memory-tools.ts`

Work:

- Replace `onTurnDurable?: () => void` with a bounded `onTurnSettled` notification carrying either exact durable host-owned session/turn/sequence/time/outcome metadata or an undurable reason after append failure.
- Preserve the writer invariant: publish only after append settlement, catch observer failures, and never await memory work on the stream/append path.
- Implement the explicit two-sided controller state machine so settlement-before-seal and seal-before-settlement reconcile identically.
- Refuse `memory_save` immediately when `beginTurn()` produced no active recording; cover input-barrier failure and recorder budget exhaustion.
- Open the controller's active staging area around the parent `send()` turn; discard non-success immediately and seal exact successful `endTurn` staging until settlement.
- Commit only matching durable `endTurn` turns with no failure/partial state; discard on undurable settlement, throw, cancel, abandonment, or `/clear` before durable acceptance. Once queued after durable acceptance, orderly retire/shutdown waits for commit.
- Serialize detached commits in stable generated-ID order and latch one bounded status problem.
- Reorder cleanup so trajectory close publishes the last settlement, controller reconciliation discards any unresolved area, and then controller close waits for accepted commits.

Verification gate:

- In `spike/verify-trajectory.ts`, prove the new callback fires only after append settlement, reports exact durable metadata or bounded undurable outcome, and leaves append-only/pass-through behavior unchanged.
- In `spike/verify-memory-tools.ts`, prove both settlement/seal race orders; active-recorder absence; success commit; failed/cancelled/partial/abandoned/undurable discard; commit failure isolation; shutdown waiting only for an accepted commit; and `/clear` discard before acceptance.
- Run both focused suites.

Rollback point: if the durable handoff cannot retain the writer's observer contract, stop and revert this phase rather than committing saves earlier.

### 4. Integrate permission semantics and user management

Files:

- `src/agent/permission.ts`
- `src/agent/permission-rules.ts`
- `src/memory/command.ts`
- `src/memory/state.ts`
- `spike/verify-memory-command.ts`
- focused permission tests (`spike/verify-permissions-command.ts` and/or a new memory-specific offline test)

Work:

- Classify `memory_recall` as read and `memory_save` as write; summaries expose only bounded key/category/title/evidence path, not fact/quote text.
- Keep `memory_save` statically dangerous and add it to the centralized rule-exempt predicate so neither matching nor suggestions can cover it.
- Accept that auto mode's existing classifier receives the bounded exact call before semantic callback screening; verify through the injected offline classifier seam and never claim auto is model-call-free.
- Rely on existing default/auto/plan/yolo logic; add no memory-specific gate.
- Adapt `/memory list|show|forget|remember` to v3 atomic entries and migration while preserving explicit user-note semantics and generated suppression.
- Ensure management reports never expose raw state or broaden path access.

Verification gate:

- Prove recall is silent read; save asks in default, reaches the injected classifier in auto, is denied before hooks/side effects in plan, and proceeds in yolo.
- Prove configured/session allow-rules never cover or get suggested for save, denial stages nothing, and mode-change withdrawal re-decides through the existing bounded loop.
- Run `pnpm tsx spike/verify-memory-command.ts` and focused permission suites.

### 5. Remove obsolete ambient extraction/prompt machinery

Files:

- `src/memory/scheduler.ts` (delete if no remaining caller)
- `src/memory/prompt.ts` (delete if no remaining caller)
- `src/agent/prompt-cache.ts`
- `src/skills/prompt.ts` only if learned-memory positioning helpers become dead
- existing memory/system-prompt/clear-session tests

Work:

- Remove heuristic scheduler and full `<learned-memory>` prompt refresh.
- Remove dead prompt-fragment recognition/order branches without disturbing project instructions, official skills, working context, or final cache point.
- Update clear/resume tests: memory tools and current disk state survive through ordinary runtime construction, but no complete memory index appears in the system prompt.
- Keep `/memory` transcript notices and existing warning surfaces; add no frame row.

Verification gate:

- Update/run `spike/verify-memory.ts`, `spike/verify-system-prompt.ts`, `spike/verify-working-context.ts`, and `spike/verify-clear-session.ts`.
- Prove prompt order is base → project instructions → skills → working context → cache point and no legacy block duplicates on resume/clear.

### 6. Documentation and load-bearing contracts

Files:

- `.trellis/spec/backend/strands-sdk-contracts.md`
- `.trellis/spec/backend/session-trajectory.md`
- `.trellis/spec/backend/error-handling.md`
- `docs/architecture/load-bearing-decisions.md`
- `AGENTS.md`
- `README.md`
- `README.zh-CN.md`

Work:

- Replace deterministic post-turn extraction and ambient injection language with parent-only save/recall contracts.
- Document permission modes, durable staging, strict files, validation/migration, opt-out, failure degradation, and secret/credential rejection.
- Update the fixed prompt-order invariant and free-check catalogue.
- Keep AGENTS.md below 32 KiB.

### 7. Full verification and review

Run, in order:

```bash
pnpm tsx spike/verify-memory-validation.ts
pnpm tsx spike/verify-memory-tools.ts
pnpm tsx spike/verify-memory-command.ts
pnpm tsx spike/verify-trajectory.ts
pnpm tsx spike/verify-system-prompt.ts
pnpm tsx spike/verify-working-context.ts
pnpm tsx spike/verify-clear-session.ts
pnpm typecheck
pnpm test
git diff --check
python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-27-llm-memory-extraction
```

Also run any focused permission suite changed in phase 4. No live extraction/retrieval suite is required: both tools are fully testable through the real local SDK tool loop with an offline scripted model. Auto mode's pre-existing classifier call is exercised with the injected offline classifier seam.

Review gates:

- confirm only `src/agent/runtime.ts` constructs `Agent`;
- confirm child catalogues contain neither memory tool;
- grep that no trajectory scan, scheduler, or `<learned-memory>` ambient injection remains;
- confirm every model-controlled field has schema and final serialized bounds;
- confirm recall makes zero writes and save makes zero writes before durable success;
- confirm tool input/results remain the only trajectory evidence and no new record type was added;
- inspect git status so unrelated pre-existing `.trellis/tasks/08-27-long-silent-responses-oom/` remains untouched.
