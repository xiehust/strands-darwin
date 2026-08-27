# Design: recover from oversized model context

## Boundary and architecture

Keep the SDK agent loop authoritative. The implementation has three narrow layers:

1. **Prevent new oversized tool-result messages.** Main runtimes always install the existing SDK `ContextOffloader` unless effective config explicitly sets `contextOffload: false`. It retains the current session-scoped `LocalFileStorage`, SDK default 2,500-token threshold unless `maxResultTokens` overrides it, 1,000-token preview, retrieval tool, and `evictAfterCycles: null` so references survive resume.
2. **Repair restored oversized tool results before the first provider request.** Extend the pinned SDK offloader so its first `BeforeModelCallEvent` scans restored messages once and routes oversized successful `ToolResultBlock`s through the same durable store/preview/reference transformation used for new results. This runs after session restore and before request assembly, including when the result sits inside `preserveRecentMessages`.
3. **Classify the observed Mantle overflow correctly.** Extend the pinned SDK OpenAI error-classification patch with the bounded phrase `exceed model maximum`, so non-tool/history overflows still reach the existing `AfterModelCallEvent` summarization/retry hook.

The resume scan is part of the offloader plugin rather than the summarizing manager: it preserves content behind retrievable references, avoids inventing a second replacement format, and prevents the doomed provider call instead of reacting after it.

No TUI/headless driver performs compaction or resends a turn. Drivers only format an overflow that remains unrecoverable.

## Data flow

### New sessions and new tool results

```text
config (default true / explicit false)
  → AgentRuntime creates session-scoped ContextOffloader
  → AfterToolCallEvent counts the transformed tool result
  → oversized success is durably stored
  → event.result becomes preview + reference
  → ToolResultEvent, trajectory, UI and conversation all observe that same replacement
  → SessionManager saves the bounded conversation after invocation
```

The raw tool outcome may still appear in tracing/meter internals before `AfterToolCallEvent`; Darwin's trajectory and public UI consume the hook-transformed `ToolResultEvent`, so public/session context remains bounded.

### Legacy resumed session with offload enabled

```text
SessionManager restores historical messages
  → first BeforeModelCallEvent reaches ContextOffloader
  → plugin scans restored successful ToolResultBlocks once
  → oversized blocks use the same durable store + preview/reference replacement
  → request is assembled from bounded history
```

If storage fails, the original block stays intact and ordinary model behavior proceeds; no dangling reference is created. The one-time scan is Agent-local and runs before each restored block can be sent.

### Non-tool/history overflow or explicit offload opt-out

```text
provider returns Mantle overflow phrase
  → OpenAI adapter wraps ContextWindowOverflowError
  → existing conversation manager reactive hook runs once
  → summarize reducible old messages
  → retry through the existing SDK attempt loop only when reduction changed history
```

Progress is mandatory. If ordinary summarization cannot reduce anything—such as an explicit opt-out whose protected recent window alone is oversized—the original overflow propagates once with actionable guidance.

## Configuration contract

- `contextOffload` becomes a concrete defaulted boolean in `SessionFields` and `AppConfig`.
- Default: `true`.
- Explicit `false`: persistent opt-out.
- `maxResultTokens` is accepted whenever effective `contextOffload` is true; it is rejected with explicit false.
- Existing `--context-offload` remains a compatible force-on override, primarily useful when config explicitly disables it. It stays headless-only and does not persist.
- `/clear`, `/rewind`, resume, and `/model` inherit/reload the effective config through existing factories; offload storage is rebuilt per successor session as it is today.

This intentionally changes default behavior and tool catalogues: `retrieve_offloaded_content` is present by default on main agents. Completion-menu constants are unaffected because this is a model tool, not a slash command.

## Restored-history offload contract

The SDK patch reuses the normal offloader transformation rather than defining a second truncator:

- On the first `BeforeModelCallEvent` for an Agent, inspect its current messages once. Fresh conversations have no historical result to transform; restored sessions do.
- Consider only successful `ToolResultBlock`s that still contain ordinary content. Existing offload placeholders remain below threshold and are left byte-identical.
- Count one result at a time using the active model and the plugin's existing threshold. Reuse `_storeBlock` and `_buildPreviewText` so storage framing, preview bounds, media placeholders, references, and retrieval behavior cannot diverge.
- Replace the block in place while preserving `toolUseId`, status, message ordering, tracking IDs, and valid tool-use/result pairing.
- A store/count failure leaves that block untouched and continues scanning bounded by the finite restored message list; it does not fail startup or create a retry loop.
- The scan completes before the provider request is assembled. It is Agent-local and cannot repeat on each cycle.

The offline regression must start from a persisted oversized snapshot, initialize a fresh Agent with the patched offloader, and prove the very first provider call sees the bounded reference form and can retrieve the original bytes.

## Visibility and error projection

Normal proactive offload is already model-visible through the SDK preview/reference marker and user-visible in the ordinary bounded tool-result projection. It should not add a separate TUI frame row or trajectory event.

For an unrecovered `ContextWindowOverflowError`, add one shared formatter used by interactive and headless error paths. It keeps the provider detail bounded and appends actionable guidance: run `/compact`, retry with a narrower request, or `/clear`. Structured output keeps schema v1 and receives the same formatted message through its existing bounded `StructuredFailure` projection.

Successful internal recovery produces no extra synthetic assistant/user message and no second public turn. Evidence remains the transformed tool result plus ordinary model-attempt events; trajectory stays an observer.

## Persistence and old sessions

- New offloaded blocks are written before the transformed tool result is committed. A storage failure keeps the original result, allowing normal error/recovery behavior rather than creating a dangling reference.
- `SessionManager(saveLatestOn: 'invocation')` persists transformed/recovered messages at invocation completion, including the restored-history repair before any later provider failure.
- Existing immutable snapshots and trajectory records are never rewritten.
- A resumed legacy snapshot is repaired immediately before its next model call when offload is enabled. With explicit opt-out, it remains unchanged and any overflow receives the actionable failure.

## Child agents

This task does not attach the parent session's durable offloader to transient child Agents. Child final answers have a distinct load-bearing path, no session-scoped snapshot/storage contract, and delegation results are explicitly excluded by the SDK offloader. The parent can still offload an oversized ordinary child-tool result only where the SDK permits without breaking delegation semantics. Broader child storage/offload policy is deferred.

## Compatibility and rollback

- Keep explicit `/compact` semantics and context-pressure advisory unchanged.
- Keep `--context-offload` grammar accepted; do not remove a documented flag in this fix.
- A user can restore prior inline-result behavior with `"contextOffload": false`.
- Code rollback is the config default plus SDK patch hunks; stored offload files remain harmless session artifacts and are governed by existing manual session cleanup.

## Tests

Focused offline coverage:

- OpenAI Responses fake client emits the exact Mantle error and a nearby non-overflow error.
- Config default/false/threshold/CLI override matrix.
- Existing `verify-context-offload.ts` flips its runtime assertions to default-on and explicit-off, preserving cross-process retrieval.
- New real Agent overflow fixture covers recent protected huge result, one bounded retry, tool-pair validity, and no-loop failure.
- Resume fixture proves bounded message state restores and references still resolve.
- Interactive/headless shared formatting and structured schema/bounds.

Then run `pnpm typecheck`, the focused suites, and full `pnpm test`. No live model call is needed.
