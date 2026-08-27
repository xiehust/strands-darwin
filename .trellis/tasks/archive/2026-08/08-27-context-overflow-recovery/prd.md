# Recover from oversized model context

## Goal

Keep an interactive Darwin session usable when a model turn suddenly exceeds its context window, including the observed Mantle/OpenAI failure caused by a multi-megabyte tool result. Recovery must be bounded, visible, and use Strands SDK extension points rather than replacing the agent loop.

## Background and confirmed facts

- Session `session-20260827-011054525` failed on turn 5 with `ModelError: prompt tokens (1416135) exceed model maximum (1050000) for openai.gpt-5.6-sol`.
- The request grew from roughly 451k tokens to overflow in one tool cycle. The latest tool-result message was about 2.89 MB on disk and the SDK heuristic estimates it alone at roughly 1.44M tokens.
- Darwin attaches `SummarizingConversationManager` with `summaryRatio` and `preserveRecentMessages`, but the OpenAI adapter classifies only known overflow phrases. Mantle's `exceed model maximum` phrase is not among them, so the error remains a generic `ModelError` and reactive reduction does not run.
- With the current `preserveRecentMessages: 10`, ordinary summarization cannot remove the incident's oversized result because it is inside the protected recent window. The protected ten messages alone exceed the model window.
- Darwin's post-turn context-pressure path is advisory by contract and deliberately never calls `/compact`. A failed turn returns before that post-turn advisory runs.
- The SDK `ContextOffloader` already prevents large tool results from entering the conversation verbatim and leaves a retrievable session-scoped reference, but Darwin currently keeps it opt-in through `contextOffload` / `--context-offload`.
- Product decision (2026-08-27): context offloading becomes default-on for every main runtime. `contextOffload: false` remains the explicit persistent opt-out, and the existing `--context-offload` flag remains a compatible process-only force-on override.

## Requirements

### Prevention, error recognition, and recovery

- Enable the existing SDK `ContextOffloader` by default for every main runtime, using the current session-scoped durable storage, retrievable preview/reference shape, SDK default threshold, and no eviction across resume.
- Keep `contextOffload: false` as the explicit persistent opt-out. `maxResultTokens` remains valid only when effective config has offloading enabled, and `--context-offload` continues to force the feature on for a process without persisting config.
- Preserve the existing child-agent contract: children keep their current bounded final-answer path and are not given shared parent offload storage or a recursively available retrieval capability in this task.
- Recognize the exact observed Mantle/OpenAI context-overflow shape as `ContextWindowOverflowError` without broadening unrelated provider failures into retries.
- Recover inside the SDK-supported conversation-management path; do not intercept, fork, or reimplement the Agent loop in a TUI/headless driver.
- Recovery must make measurable progress or stop. It may not repeatedly resend the same oversized request or enter an autonomous retry loop.
- A single tool result larger than the model window must be handled even when it is inside `preserveRecentMessages`; new results are offloaded before the next model call, and restored legacy results are offloaded before their first resumed provider request.
- Preserve the user's prompt and enough bounded recent context for the model to continue. Any omitted/offloaded content must be explicitly represented rather than silently disappearing.
- The same recovery policy must apply to interactive, text headless, structured headless, resumed sessions, and parent agents. Child-agent isolation and existing SDK ownership remain unchanged.

### Visibility and persistence

- Surface a bounded notice when automatic recovery changes conversation context, distinguishing summarization from oversized-result offload/truncation and stating any content that remains retrievable.
- Successful recovery must persist through the existing session snapshot path so `--resume` does not restore the pre-recovery oversized conversation.
- If recovery cannot make the request fit, keep the session alive and report an actionable bounded failure that recommends `/compact`, a narrower retry, or `/clear`; do not claim recovery succeeded.
- Existing trajectory remains observer-only: record ordinary tool/model/error events unchanged and do not rewrite past records.

### Compatibility and safety

- Preserve explicit `/compact`, context-pressure warnings, `contextWarnRatio`, model switching, permission gates, hooks, prompt queue behavior, cancellation, and snapshot rollback guarantees.
- Do not add a dependency, a second model provider path, or a second general-purpose Agent.
- Do not expose arbitrary offload storage paths to the model; retrieval remains through the existing statically safe retrieval tool and session-scoped storage.
- Existing sessions with oversized snapshots must either recover on the next attempted turn or fail with the new actionable bounded message; they must not be silently corrupted.

## Acceptance Criteria

- [x] An offline OpenAI/Mantle classifier test proves `prompt tokens (1416135) exceed model maximum (1050000) for openai.gpt-5.6-sol` becomes `ContextWindowOverflowError`, while nearby non-overflow `ModelError` messages remain unchanged.
- [x] A real SDK Agent fixture reproduces a tool result larger than its model window and completes because default-on offload replaces it before the next provider request, without looping.
- [x] A persisted legacy snapshot whose oversized result is among the configured protected recent messages is repaired before its first resumed provider request; that request is below the fixture's window and retains the user prompt plus an explicit retrievable reference.
- [x] The repaired message state is saved and a second fresh runtime/session manager restores the bounded state rather than the oversized snapshot; the stored reference resolves to the original content.
- [x] An unrecoverable case ends once, leaves the runtime usable, and emits an actionable notice without draining queued prompts into the failure.
- [x] Interactive and headless error projections remain bounded and semantically aligned; structured output keeps its existing schema and event ordering.
- [x] Explicit `/compact`, ordinary overflow summarization, default-on/explicit-off context-offload contracts, resume, trajectory, and max-token recovery suites remain green.
- [x] `pnpm typecheck`, focused offline suites, and `pnpm test` pass. No live provider call is required for the regression because the observed provider error and oversized request can be reproduced deterministically.

## Out of Scope

- General token-budget optimization or changing model context-window metadata.
- Automatic compaction solely because a successful turn crosses `contextWarnRatio`; the advisory remains user-controlled.
- Rewriting historical trajectory files, old immutable snapshots, or the failed session's stored records.
- Session garbage collection for accumulated offload data.
- Changing tool-specific output limits unrelated to model-context safety.
