# Implementation plan: official SDK Agent Skills

## Preconditions

- Stay in planning until the user approves the complete plan.
- At implementation start, re-read this task's PRD/design/plan and the curated specs/research.
- Snapshot hashes of the three Host-owned files and verify them again before commit:
  `docs/research/backlog_index.md`, `docs/research/research_2026-08-17.md`,
  `docs/iteration-log.md`.
- Confirm `037dce6` remains an ancestor of `HEAD`.

## Phase 1 — official catalogue policy

1. Refactor `src/skills/loader.ts` to import SDK `Skill` and create policy-filtered official skill
   instances.
2. Keep constants and diagnostic path metadata required by build/runtime/tests.
3. Preserve required built-in order/fatality and project-over-global case-insensitive precedence.
4. Preserve optional failure collection and silent absent directories.
5. Keep only the missing-name and established `[A-Za-z0-9_-]+` name-policy compatibility
   boundaries, while handing frontmatter/body parsing and Skill field extraction to
   `Skill.fromContent` without stricter SDK name validation.
6. Delete Darwin's parser, prompt renderer, loaded-skill model, formatter, and recursive resource
   traversal.
7. Update `spike/verify-skills.ts` and `spike/verify-state-layers.ts` for official objects and
   built-ins-first deterministic order.
8. Run focused discovery tests plus `pnpm typecheck`.

**Rollback point:** no runtime plugin change yet; revert this phase if official validation cannot
preserve accepted existing skills and exact failure isolation.

## Phase 2 — official activation with one compatibility tool

1. Replace `SkillsPlugin` in `src/skills/plugin.ts` with the thin official adapter.
2. Construct official `AgentSkills` with policy-filtered `Skill` instances, explicit resource cap
   20, Darwin-compatible name policy and an isolated state key.
3. Delegate plugin initialization to official `initAgent`, but never expose its native tool.
4. Capture the native official tool through public `getTools()` and invoke it internally from one
   registered `load_skill({ name })` compatibility tool.
5. Keep case-insensitive resolution, recoverable unknown-name results and the public
   `{ instructions }` success shape.
6. Make `/skill-name` invoke that same official activation path against the initialized live Agent,
   preserve request/default text, and keep the explicit do-not-reload guard.
7. Ensure runtime, child eligible-tool snapshots and custom command collision inputs contain
   `load_skill` and never `skills`.
8. Add direct real-Agent activation/resource-bound assertions to the focused suite.
9. Run skills, permission-mode, custom-command, subagent and typecheck suites.

**Rollback point:** tool catalogue must show exactly one compatibility tool before prompt-order
work continues.

## Phase 3 — prompt/cache/session order

1. Add minimal explicit prompt-block helpers, likely in a new `src/skills/prompt.ts` or next to the
   adapter, to recognize/reorder only Darwin-owned shapes.
2. Update `src/agent/working-context.ts` so fresh and resumed explicit official-skill block shapes
   replace only working context while preserving base/project and catalogue.
3. Update `src/agent/prompt-cache.ts` so the final cache point can be added/replaced on recognized
   block shapes and omitted for unsupported providers.
4. Update `src/agent/runtime.ts`:
   - prepare base/project -> current working context -> cache point after initialize;
   - register the adapter's post-official `BeforeInvocationEvent` ordering hook;
   - wire the live Agent into slash activation;
   - preserve RuntimeInfo and child-tool timing.
5. Add `spike/verify-agent-skills.ts` with a deterministic real Model and real SessionManager:
   - initialization tool names/schema;
   - first actual request order and one catalogue;
   - repeated request de-duplication/order;
   - official activation state;
   - saved/resumed prompt and appState;
   - refreshed working context and final cache-point placement;
   - block-array behavior and no warning-causing failed removal.
6. Register the suite in `spike/run-tests.ts`.
7. Update existing AGENTS.md/working-context/cache tests to exercise actual official Agent behavior
   where prompt injection is in scope rather than fake plugin stand-ins.
8. Run all focused offline suites and `pnpm typecheck`.

**Rollback point:** do not proceed if the model-captured `StreamOptions.systemPrompt` differs from
base -> project -> official catalogue -> current working context -> final cache point on any first,
repeat or resumed call.

## Phase 4 — documentation and cleanup

1. Update comments in touched production modules to remove stale statements about missing official
   TS support and string-only injection.
2. Update `AGENTS.md` architecture sections for official ownership, compatibility tool and measured
   per-invocation ordering.
3. Update `.trellis/spec/backend/strands-sdk-contracts.md`:
   - replace the self-built Skills section;
   - record official first/repeat/resume/block-array behavior and the runnable focused suite;
   - update prompt cache/session contracts that refer to the old plugin;
   - update required built-in references if loader symbol names move.
4. Review `.trellis/spec/backend/error-handling.md`; preserve failure semantics and update only
   stale implementation names or official-validation wording.
5. Update README skill format/precedence/tool behavior, prompt order, permission table, resource
   count/depth cap and verification command descriptions.
6. Preserve package build copying of bundled Markdown/resources and verify output. Do not remove
   `gray-matter` because the agent-definition loader still uses it.
7. Search for stale `SkillsPlugin`, `renderAvailableSkills`, `loadSkill`,
   `formatSkillForModel`, old `<available-skills>` spelling, native `skills` exposure and stale
   "TS SDK has no Skills" statements.

## Phase 5 — verification and acceptance

Run, in this order:

```bash
pnpm tsx spike/verify-agent-skills.ts
pnpm tsx spike/verify-skills.ts
pnpm tsx spike/verify-state-layers.ts
pnpm tsx spike/verify-agents-md.ts
pnpm tsx spike/verify-working-context.ts
pnpm tsx spike/verify-prompt-cache.ts
pnpm tsx spike/verify-permission-modes.ts
pnpm tsx spike/verify-custom-commands.ts
pnpm typecheck
pnpm test
pnpm build
test -f dist/src/skills/builtin/developer/SKILL.md
test -f dist/src/skills/builtin/self-evolution-research/SKILL.md
pnpm tsx spike/verify-tui.ts completion
git diff --check
python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-17-official-sdk-agent-skills
```

Then run one low-token live smoke in `us-west-2`. Prefer a focused mode added to
`spike/verify-skills-live.ts` that performs only the autonomous path:

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-skills-live.ts autonomous
```

Acceptance evidence must show `calling load_skill`, `load_skill -> ok`, skill-conformant output,
and no permission prompt/native `skills` tool.

Finally:

1. Inspect all diffs and re-run the Host-owned file hashes plus `git merge-base --is-ancestor
   037dce6 HEAD`.
2. Load/run Trellis check guidance; fix findings and repeat affected tests.
3. Review/update specs as required.
4. Validate the task and inspect the logical commit set. The user pre-authorized implementation,
   commit and archive for SER-012, so no additional commit-confirmation prompt is required.
5. Commit the accepted implementation without amending/rebasing or modifying Host-owned files.
6. Archive the Trellis task in the follow-up bookkeeping commit required by the workflow.

## Expected file set

### Add

- `.trellis/tasks/08-17-official-sdk-agent-skills/{prd.md,design.md,implement.md,research/**}`
  (later archived under `.trellis/tasks/archive/2026-08/`)
- `spike/verify-agent-skills.ts`
- possibly `src/skills/prompt.ts` if prompt shaping is clearer outside the adapter

### Modify

- `src/skills/loader.ts`
- `src/skills/plugin.ts`
- `src/agent/runtime.ts`
- `src/agent/working-context.ts`
- `src/agent/prompt-cache.ts`
- `spike/run-tests.ts`
- `spike/verify-skills.ts`
- `spike/verify-state-layers.ts`
- `spike/verify-agents-md.ts`
- `spike/verify-working-context.ts`
- `spike/verify-prompt-cache.ts`
- `spike/verify-skills-live.ts` (only to add a one-call mode if necessary)
- `AGENTS.md`
- `README.md`
- `.trellis/spec/backend/strands-sdk-contracts.md`
- `.trellis/spec/backend/error-handling.md` only if stale names/wording require it

### Deliberately unchanged

- `package.json` and `pnpm-lock.yaml` unless implementation reveals an evidence-backed need
- `src/agent/permission.ts` behavior
- bundled skill content/resources
- Host-owned research/backlog/iteration files
