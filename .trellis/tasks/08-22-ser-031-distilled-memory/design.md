# Design — SER-031 distilled project memory

## Data flow

`trajectory.jsonl` (append-only source) → delayed reader after durable close → eligibility/projection/redaction → atomic Markdown topic/index writes under `~/.darwin/projects/<project-key>/memory/` → startup index loader → one `<learned-memory>` prompt block.

The trajectory stays authoritative and byte-identical. The memory store is disposable derived state and never participates in replay/resume.

## Storage schema and bounds

- `memory/index.md`: generated header, fallibility warning, bounded topic list, omission summary.
- `memory/topics/<stable-session-turn-id>.md`: one eligible turn's distilled facts and provenance (`session`, `turn`, closing `seq`, source timestamp).
- Stable project scoping reuses `userProjectDir(projectRoot)`.
- Topic count, candidate count, line/code-point, index byte, and topic byte limits are exported and tested. Oldest overflow topics are omitted from the index/store projection rather than making prompt growth unbounded.
- Writes use sibling temporary files plus rename; topic/index output is deterministic for identical source records.

## Eligibility and extraction

A turn is eligible only when one complete trajectory read contains one `userInput`, one closing `turnEnded` with `stopReason: endTurn`, no `failure`, no partial/damaged/truncated source, and one usable final `agentResultEvent` assistant text. Short prompt/answer pairs are skipped.

Extraction reads only the user text for topic naming and the final assistant text for factual candidate lines. It never reads reasoning, before/after tool records, raw tool outputs, partial text, or failure payloads. It rejects fenced/code/JSON/log-like lines, secret/.env/token/key patterns, high-entropy credential-like values, and oversized candidates. The topic states how many candidates were omitted without reproducing them.

## Scheduling and degradation

`TurnRecording.end()` exposes a post-durable callback owned by the recorder. The callback is scheduled only after the closing append succeeds. Runtime supplies a project-memory scheduler when opted in. Scheduling is synchronous/no-throw; work starts on a detached timer, coalesces pressure to the latest requested scan, and each scan races a short timeout. A problem latches in memory status and is read on existing post-turn TUI/dev/headless warning surfaces. The stream never awaits extraction.

Runtime shutdown/retire settles only currently reachable bounded scheduler work; timeout detaches stuck work so process cleanup remains bounded.

## Prompt composition

Startup loads `index.md` only when enabled. The loader caps bytes, strips any prior learned-memory block from restored snapshots, and creates a fixed wrapper that says the content is fallible context, not instructions/policy, and must not override project instructions. Runtime refreshes it after SDK restore through the same conservative known-prompt parser used for working context. Official skills ordering becomes:

base + project instructions → official skills → learned-memory (optional) → working context → final cache point.

Fresh, resumed, and `/clear` all use `AgentRuntime.create`, so each reads the current index.

## Non-goals

No model call for extraction, no search/retrieval tool, no embeddings/vectors, no topic-body injection, no `/memory`, no aging/revalidation, no generic model write path, no trajectory schema mutation.
