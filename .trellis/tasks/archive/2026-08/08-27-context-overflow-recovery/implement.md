# Implementation plan: recover from oversized model context

## 1. Pin the observed provider classification

- Add an offline OpenAI Responses fake-client regression for the exact Mantle message.
- Patch `@strands-agents/sdk` OpenAI overflow patterns to recognize only the needed `exceed model maximum` phrase.
- Prove a nearby generic `ModelError` stays unclassified and the existing SDK conversation-manager retry owns a recognized overflow.
- Regenerate/update the tracked pnpm patch without changing SDK version or dependencies.

Validation:

```bash
pnpm tsx spike/verify-context-overflow.ts
pnpm typecheck
```

Rollback point: the OpenAI classifier patch hunk and focused test are independently removable.

## 2. Make durable context offload default-on

- Change `SessionFields.contextOffload` to a concrete boolean and add `DEFAULTS.contextOffload: true`.
- Default omitted config to true; retain explicit false.
- Preserve `maxResultTokens` validation against effective offload state.
- Keep `--context-offload` as a headless process-only force-on override and update comments/help/docs that currently call it opt-in.
- Build the existing session-scoped `ContextOffloader` for every effective-on main runtime; explicit false without CLI override omits it.
- Update config/runtime/context-offload tests for default-on, explicit-off, force-on, threshold, retrieval permission, and `/clear`/resume factory behavior.

Validation:

```bash
pnpm tsx spike/verify-config.ts
pnpm tsx spike/verify-context-offload.ts
pnpm tsx spike/verify-headless.ts
pnpm tsx spike/verify-headless-structured.ts
pnpm typecheck
```

Rollback point: default and runtime gate can revert without touching stored session artifacts.

## 3. Repair legacy oversized snapshots before request assembly

- Extend the pinned SDK `ContextOffloader` with a once-per-Agent restored-history scan on its first `BeforeModelCallEvent`.
- Refactor/reuse the plugin's existing threshold check, block storage, preview/reference construction, and in-place replacement; do not add a second marker format.
- Preserve message tracking IDs, tool-result IDs/status/order, and tool-use/result pairing.
- Keep count/store failures non-destructive and bounded; never create dangling references or repeat the scan.
- Add a real SDK SessionManager fixture seeded with an oversized protected recent result. Prove the first resumed model call sees bounded content, the reference retrieves original bytes, invocation persistence rewrites latest, and a second restore stays bounded.
- Add explicit-off/unrecoverable coverage proving one failure and no retry loop.

Validation:

```bash
pnpm tsx spike/verify-context-overflow.ts
pnpm tsx spike/verify-context-offload.ts
pnpm tsx spike/verify-compact.ts
pnpm tsx spike/verify-stream-resumption.ts
pnpm typecheck
```

Rollback point: restored-history SDK patch is isolated from normal new-result offload.

## 4. Align bounded failure guidance across drivers

- Add one shared context-overflow error projection that preserves bounded provider evidence and appends `/compact`, narrow-retry, and `/clear` guidance.
- Use it from interactive TUI and text/structured headless turn-failure boundaries without changing structured schema v1 or adding a new trajectory event.
- Preserve failed-turn prompt-queue return and stream-interruption exclusion.
- Add focused module/driver assertions for identical semantic guidance and bounds.

Validation:

```bash
pnpm tsx spike/verify-headless-structured.ts
pnpm tsx spike/verify-stream-resumption.ts
pnpm tsx spike/verify-prompt-queue.ts
pnpm tsx spike/verify-tui.ts queue
pnpm typecheck
```

Rollback point: shared formatting is presentation-only; removing it leaves recovery intact.

## 5. Documentation and full verification

- Update `.trellis/spec/backend/strands-sdk-contracts.md`, `.trellis/spec/backend/error-handling.md`, architecture rationale, AGENTS.md load-bearing index, and English/Chinese configuration/reference/usage docs.
- State default-on offload, explicit false opt-out, retained `--context-offload` force-on semantics, session disk accumulation, restored-history repair, exact Mantle classification, and unchanged advisory-only `contextWarnRatio`.
- Update any developer/self-reflection wording that implies the flag is required for ordinary safety, while keeping compatible explicit flags valid.
- Run focused suites, full quality gates, patch integrity, and diff checks.

Validation:

```bash
pnpm typecheck
pnpm test
pnpm tsx spike/verify-tui.ts completion
git diff --check
python3 ./.trellis/scripts/task.py validate .trellis/tasks/08-27-context-overflow-recovery
```

## Review gates

- Verify only `src/agent/runtime.ts` constructs the parent Agent; no driver retry/loop interception was added.
- Verify default-off claims are gone and explicit `contextOffload: false` is documented/tested.
- Verify the exact incident error is classified while unrelated failures remain unchanged.
- Verify the first request after legacy resume is bounded before provider invocation.
- Verify raw historical trajectory and immutable snapshots are byte-untouched.
- Verify offload storage failures keep original content and never persist a broken reference.
- Verify no new dependency, model call, live test requirement, slash command, frame row, or structured protocol field was introduced.
