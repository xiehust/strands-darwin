# Implementation plan: developer token efficiency

## Phase 1 — opt-in headless controls

1. Extend CLI parsing/types for the three headless-only flags, including duplicate/missing/invalid
   budget refusal and unchanged defaults.
2. Thread process-only overrides through `headless-runner` to `RuntimeOptions`.
3. Add the parent Agent `BeforeModelCallEvent` budget hook before invocation.
4. Make runtime ContextOffloader assembly use the process override without mutating `AppConfig`.
5. Run focused parser/headless/config/offload tests and typecheck.

## Phase 2 — compact-before lifecycle

1. Run `runtime.compact()` after runtime restore and before the requested headless turn.
2. Preserve text and structured failure/cleanup/pointer semantics; structured `turn.started` must not
   precede a failed phase compaction.
3. Extend deterministic headless fixtures to record runtime options and compact ordering/failure.
4. Run focused headless, structured-headless, compact and typecheck checks.

## Phase 3 — developer policy and tests

1. Update the built-in `developer` SKILL with phase ceilings and exact CLI flags.
2. Add batched independent tool guidance and the verification pyramid.
3. Pin every rule in `verify-skills.ts`; update SDK/error/headless specs.
4. Build and verify the copied built-in asset.

## Phase 4 — final acceptance

Run once after source settles:

```bash
pnpm tsx spike/verify-headless.ts
pnpm tsx spike/verify-headless-structured.ts
pnpm tsx spike/verify-context-offload.ts
pnpm tsx spike/verify-compact.ts
pnpm tsx spike/verify-skills.ts
pnpm typecheck
pnpm test
pnpm build
test -f dist/src/skills/builtin/developer/SKILL.md
pnpm tsx spike/verify-tui.ts completion
git diff --check
python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-17-developer-token-efficiency
```

Then load `trellis-check`, inspect the complete diff, update specs, and commit. No live model call is
needed: the SDK hook, runner ordering, offloader and skill text all have deterministic offline seams.
