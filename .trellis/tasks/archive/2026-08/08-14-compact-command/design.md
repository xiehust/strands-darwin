# Design: `/compact`

## Architecture

Keep the SDK agent loop unchanged. `AgentRuntime` owns a single `SummarizingConversationManager` instance and exposes one explicit `compact()` operation. The TUI recognizes `/compact`, enters a local `compacting` busy state, awaits the runtime operation, and renders a notice.

```text
TUI /compact
  -> AgentRuntime.compact()
     -> count full request context (model.countTokens)
     -> SummarizingConversationManager.reduce({ agent, model }) repeatedly
     -> count rewritten full request context
     -> SessionManager.saveSnapshot({ target: agent, isLatest: true })
     -> write --resume pointer
  <- CompactResult
  -> transcript notice
```

## Runtime Contract

`CompactResult` carries:

- original and resulting message counts
- estimated context tokens before and after
- non-negative token savings

The runtime keeps references to the explicit compaction manager and session manager. The SDK's public `reduce` mutates `agent.messages` in place and uses the current live model, so `/model` switches are naturally respected. The agent's existing configured manager remains responsible for reactive overflow recovery; the explicit manager uses the SDK's maximum 0.8 ratio to minimize the number of paid summary calls.

Compaction repeats while more than `preserveRecentMessages + 1` messages remain. The extra one is the rolling summary. If the SDK cannot reduce a pass, stop; if no pass has reduced anything, return a no-op result. Repeated passes delegate all split/tool-pair logic to the SDK.

## Token Measurement

Call `model.countTokens(agent.messages, { systemPrompt: agent.systemPrompt, toolSpecs: agent.tools.map(tool => tool.toolSpec) })` before and after. This approximates the next complete model request and uses the provider's native counter when supported, with the SDK's documented fallback otherwise.

The user-facing report says `estimated context tokens`; it does not claim billing savings. The model call that creates the summary is a one-time compaction cost and is not subtracted from future-context reduction.

## Persistence and Rollback

Clone the original messages before any model call. On any exception:

1. restore `agent.messages` in place from those clones;
2. best-effort save the restored latest snapshot if persistence may have been attempted;
3. rethrow for the TUI to surface.

On success, explicitly save `snapshot_latest` because no `AfterInvocationEvent` fires for a direct conversation-manager call. Then update `.darwin/last-session.json`. This makes an immediate exit followed by `--resume` restore the compacted state.

## TUI Behavior

- Built-in completion order starts with `compact`, then existing commands.
- `/compact` is handled after the normal streaming guard: it must not mutate messages while an invocation is reading them.
- While awaited, status is `compacting`; the input remains disabled and shows `compacting conversation…`.
- The literal command is added to visible transcript history, but never to the agent's message list.
- No-op, success, and failure are transcript notices.
- Existing rendered `<Static>` history remains on screen; only future model context and persisted session data are compacted.

## Compatibility

No session file format, config shape, dependency, or provider-specific API is added. Existing overflow-triggered summarization continues through the same manager. Resume remains keyed by the same session and stable agent id.

## Verification Strategy

A focused offline spike uses a deterministic fake `Model` with real SDK `Agent`, `SummarizingConversationManager`, `SessionManager`, and `LocalFileStorage`. It verifies:

- repeated reductions and preserved recent messages;
- token count includes system prompt and tools;
- follow-up invocation sees summary context;
- latest snapshot restores into a fresh agent;
- summary or snapshot failure rolls messages back.

The existing pty slash-completion scenario verifies `/compact` discovery without a live model call.

## Risks and Mitigations

- **Repeated summarization loses detail:** keep the configured recent window and use the project's technical summarization prompt; users opt into compaction explicitly.
- **Summary can be larger than source:** report `max(0, before - after)` honestly; message reduction can still be useful, but do not claim negative savings.
- **Snapshot write after mutation fails:** restore in-memory messages and best-effort restore persisted latest state before reporting failure.
- **Tool pair split:** delegate entirely to the SDK manager, which adjusts split points.
