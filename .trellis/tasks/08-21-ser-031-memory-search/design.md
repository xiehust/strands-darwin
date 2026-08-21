# Design — SER-031 explicit project memory search

## Data flow

`search_memory` input → zod code-point query validation → `searchTrajectories(projectRoot, query, agentId, { excludeSessionId, sessionLimit, hit limit })` → bounded `SearchOutcome` → deterministic textual formatter → ordinary SDK tool result → existing tool lifecycle/rendering.

The trajectory JSONL and snapshots remain the only read sources. There is no write path.

## Search bounds and honesty

The model adapter owns fixed conservative caps for query code points, sessions, hits, and final result code points. `searchTrajectories` gains optional exclusion/session bounds so it can report which sessions were excluded or omitted without changing callers that omit those options. It continues to own matching and excerpt generation.

The projection includes:

- one source line per hit: session, turn, type, excerpt;
- damage lines for scanned damaged records, even when they have no hits;
- named snapshot-only sessions, bounded with an omitted count;
- active-session exclusion and session-scan omission counts;
- explicit no-match and hit/result truncation notices.

A query that is empty after trimming or exceeds the code-point cap is rejected by the tool schema before any read. Excerpts and final output are sliced by code point, never UTF-16 unit.

## Assembly and permissions

Create the tool in `AgentRuntime.create` after session resolution and before parent Agent initialization. Put it in the parent's initial tool list, so the existing post-initialize `childTools = agent.tools` snapshot includes it. `SubagentTool.toolsFor` remains unchanged: definitions without `tools` inherit it, while explicit allowlists include it only when named.

Add an explicit `search_memory` read classification. `PermissionGate.planGuard` already permits every `read` request and unknown tools continue to classify as `execute`.

## UI and prompt boundary

No TUI code changes. The SDK emits ordinary tool-use/result events, and existing components render them. The tool description is the only model discoverability surface. No historical bytes are appended to startup state, working context, system prompt, hooks, or post-turn processing.

## Verification

Add one focused offline suite that seeds real JSONL/snapshot state and invokes the actual SDK tool. It hashes source files and pointer before/after, exercises all bounds and damage states, checks permission/plan behavior, and performs structural source assertions. Extend subagent tests only where needed to prove inheritance and explicit allowlist behavior; retain the existing trajectory suite as the CLI/search regression.
