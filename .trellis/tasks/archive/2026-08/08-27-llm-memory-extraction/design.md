# Design — Agent-managed project memory tools

## Change boundary

The smallest behavior gap is that Darwin currently derives generated memory by scanning every completed trajectory after the turn and injects the eligible index into every future system prompt. The desired behavior is on-demand: the parent agent explicitly stages a durable fact with `memory_save` and explicitly searches validated project memory with `memory_recall`.

The behavior lives in four existing boundaries:

1. `src/agent/runtime.ts` owns parent-only tool registration and the active turn.
2. `src/trajectory/writer.ts` owns the fact that a successful closing batch is durable.
3. `src/memory/` owns strict state, validation, projection, and `/memory` management.
4. `src/agent/permission.ts` owns read/write classification and all mode semantics.

Expected implementation changes are limited to those boundaries, their focused tests, and the documentation that currently promises heuristic extraction and ambient prompt injection. This task does not add a second model, embeddings, semantic search, subagent memory access, a model-facing delete tool, repository writes, or secret/credential storage. Existing trajectory bytes, snapshots, resume pointers, config, and worktree files remain immutable inputs.

## Public tool contracts

Both tools are registered only on the already-created parent `Agent`, after child tool catalogues are fixed. They are absent when effective `memory` is false. A child cannot name or inherit either tool.

### `memory_recall`

Input:

```json
{
  "query": "context overflow recovery",
  "limit": 5
}
```

- `query`: trimmed, 1–300 Unicode code points, screened against the same secret/credential patterns so a credential cannot be echoed into model context as a search term.
- `limit`: optional integer, default 5, range 1–8.
- The callback performs local reads only. Validation uses `persist: false`; migration and validation metadata are never written by recall.
- The result is one bounded JSON object containing the screened query, matched entries, and omission/degradation counts. Every result says that memory is fallible data, not instructions or policy.
- No match is a successful empty result, not a tool error.

Each returned entry contains only bounded fields needed by the model: `id`, `origin`, `category`, `title`, `fact`/`note`, provenance, validation state, and evidence path/line for project evidence. Raw state, suppression lists, unrelated entries, and topic files are not returned.

### `memory_save`

Input:

```json
{
  "key": "architecture:agent-construction",
  "category": "architecture",
  "title": "Agent construction boundary",
  "fact": "Only src/agent/runtime.ts constructs Agent.",
  "evidence": {
    "path": "AGENTS.md",
    "quote": "Only runtime.ts constructs Agent"
  }
}
```

Categories are a closed enum:

- `architecture`
- `decision`
- `convention`
- `root_cause`
- `verification`
- `preference`
- `identity`

Bounds:

- stable `key`: lowercase namespaced identifier, at most 120 code points;
- `title`: 1–100 code points;
- one atomic `fact`: 1–500 code points;
- one project-relative evidence path and one exact source line where required;
- at most eight staged saves in a turn and at most 32 generated entries in state.

`architecture`, `decision`, `convention`, `root_cause`, and `verification` require exact project evidence. `preference` and non-secret `identity` instead require a `userQuote` that occurs exactly once in the bounded current user input; Darwin verifies it and supplies current session/turn provenance. The model cannot author provenance or save an inferred preference/identity.

The Zod schema bounds and shapes the call before hooks/permission see it. The permission summary shows only bounded key/category/title plus evidence path; it does not echo the fact, quote, or user quote. In auto mode the existing classifier still receives the exact bounded tool input, as it does for other writes. Semantic screening inside the callback then rejects prompt-boundary markup, control characters, secrets/credentials, unrelated dumps, malformed evidence, and temporary/task-progress material before staging. Evidence-backed project verification requirements may be imperative; unanchored policy-like preference/identity text remains forbidden.

A successful callback means **staged**, not persisted. Its result contains a bounded candidate ID and states that commit requires a successful durable `endTurn`. It never echoes the full fact or evidence line back into the result.

## Permission behavior

`src/agent/permission.ts` recognizes both names explicitly:

- `memory_recall` → `kind: read`; static risk is safe, so it runs silently.
- `memory_save` → `kind: write`; static risk remains dangerous even though its target is Darwin-owned state.

The existing gate then supplies all requested behavior without a parallel policy:

- `default`: asks the user;
- `auto`: runs the existing permission classifier model call and asks only when flagged;
- `plan`: `planGuard()` denies before hooks, rules, classifier, prompt, or callback;
- `yolo`: proceeds silently.

No memory allow-rule is suggested or matched; `memory_save` is added to the centralized rule-exempt predicate in `permission-rules.ts`. Approval covers only the exact call being judged. Permission rendering shows bounded key/category/title/evidence-path details through the ordinary write prompt, not the fact or quote text.

## Turn lifecycle and durable commit

A runtime-owned `MemoryToolController` binds callbacks to the one foreground parent turn. The tools run normally through the SDK loop; the controller does not construct, intercept, retry, or fork that loop.

```text
AgentRuntime.send
  → trajectory.beginTurn() supplies turn identity
  → memory controller opens an empty staging area for that turn
  → parent tool calls may add validated candidates
  → recordStream observes the unchanged SDK stream
  → TurnRecording.end() classifies the outcome
  → trajectory closing batch append settles
  → onTurnSettled receives durable or undurable metadata
  → controller commits only exact durable successful endTurn candidates
```

The trajectory callback is replaced with a bounded `onTurnSettled` notification. `TurnRecording.end()` supplies host-owned turn/outcome metadata to the recorder; after the closing append settles, the recorder publishes exactly one of:

- `durable`: session, turn, closing sequence/time, stop reason, and failure/partial flags;
- `undurable`: turn plus a bounded reason, with no invented sequence/time.

The callback itself remains caught and unawaited. It is never invoked before the append settles. If recording is already inactive and `beginTurn()` returns no recording, the controller marks the turn undurable before the model can call `memory_save`; the tool returns a bounded refusal and stages nothing.

The controller is a two-sided state machine because stream finalization and runtime resumption can race:

- `open`: accepts valid saves;
- `sealed-success`: the SDK result was exact `endTurn`, waiting for settlement;
- `settled-durable`: settlement arrived first and is buffered, waiting for seal;
- `discarded`: failed/cancelled/partial/undurable/closed;
- `committing`: success and durable settlement have both arrived exactly once.

Seal and settlement reconcile identically in either order. Commit eligibility is exact: durable settlement, `stopReason === "endTurn"`, no failure/partial text, and matching active turn. An undurable settlement, absent recorder, consumer abandonment, non-success result, or controller close discards. `/clear` before durable settlement discards; once both durable settlement and successful seal have queued commit, orderly retirement/shutdown waits for that accepted commit. Resume starts with no staging state.

The settlement callback schedules an internal serialized commit chain and returns immediately, preserving the recorder's observer/non-blocking contract. Shutdown ordering is explicit: await trajectory close first so the last settlement is published, reconcile/close staging, then await the controller commit chain. A commit failure latches one bounded memory problem and never changes the already completed turn.

SDK tool batches may execute calls concurrently, so callback arrival order is not an ordering authority. The controller permits only one staged candidate per normalized key per turn: an exact duplicate is idempotent, while a distinct second fact for the same key is rejected. Final commit order is the stable generated ID order. `memory_recall` never includes staged entries; a save becomes recallable only after commit.

## Authoritative state and projections

The existing project-keyed location remains. The authoritative JSON file is required; Markdown projections are retained when safely writable but may be omitted on projection degradation:

```text
~/.darwin/projects/<project-key>/memory/
├── state.json
└── index.md                 # optional bounded derived projection
```

`state.json` is the only authority. Directory and file protections remain `0700` and `0600`, no-follow reads, regular-file checks, strict UTF-8/schema/byte bounds, atomic temp-file replacement, and the in-process state lock. Read-modify-write mutations re-read under that lock; recall returns only a complete atomic version.

State version 3 represents one generated fact per entry. Conceptually:

```json
{
  "id": "generated-…",
  "key": "architecture:agent-construction",
  "category": "architecture",
  "title": "Agent construction boundary",
  "fact": "Only src/agent/runtime.ts constructs Agent.",
  "origin": "generated",
  "source": {
    "session": "session-…",
    "turn": 4,
    "seq": 87,
    "at": "2026-08-27T…Z"
  },
  "evidence": {
    "kind": "project",
    "anchor": {
      "path": "AGENTS.md",
      "line": 42,
      "hash": "…",
      "codePoints": 32
    }
  },
  "validation": {
    "state": "valid",
    "reason": "…",
    "checkedAt": "…"
  }
}
```

Preference/identity entries use `{ "kind": "userInput", "quoteHash": "…", "codePoints": 42 }`; the host verifies the unique quote against the bounded current input and supplies session/turn/closing sequence/time at durable commit without persisting the full user input again. They still expire under `memoryHorizonDays`. User-authored `/memory remember` notes remain a distinct origin and retain their current no-expiry behavior.

Generated IDs are deterministic from normalized key + fact. Exact duplicates collapse. A newly validated generated entry with the same key supersedes the older generated entry atomically; generated entries never replace user notes. Existing ID suppression continues to prevent reintroducing the exact forgotten fact. A changed, newly approved fact under the same key is a distinct ID and may replace the stale generated value.

After authoritative state commits, Darwin regenerates one bounded `index.md` for human inspection and removes obsolete legacy `topics/` projections only on authorized mutation. Projection failure leaves valid state usable, latches a bounded status problem, and is repaired by the next successful mutation; Markdown is never parsed back as trusted state.

## Validation and secret handling

Project evidence is resolved by Darwin, never trusted from model output:

1. canonicalize the project root;
2. reject absolute/backslash/dot-segment paths;
3. reject symlinks and outside-root resolution;
4. open with `O_NOFOLLOW` where available;
5. enforce regular UTF-8 file, byte, line-count, and line-length bounds;
6. require the supplied quote to equal exactly one complete normalized source line;
7. derive line number and SHA-256 hash on the host;
8. repeat exact validation before commit and on every recall.

Preference/identity candidates skip file anchoring only after their exact `userQuote` is verified against the current input; they receive the same content, secret, dump, and prompt-boundary screening. Secret and credential patterns retain the current conservative behavior: rejection covers both obvious values and secret-bearing labels. Rejected content is not persisted in state or Markdown and is not echoed in a tool result.

## Retrieval

Recall first reads strict state and validates in memory without persistence. Invalid, unknown, expired, suppressed, or failed-migration generated entries are omitted. Explicit user notes remain eligible but are still labelled explicit/unvalidated. When a `memory_save` commit or `/memory forget` runs concurrently, recall may observe the complete state immediately before or after that atomic mutation, never a partial state.

Ranking is deterministic and local:

1. normalize query and entry text to Unicode lowercase tokens;
2. award fixed weights for exact phrase, stable key, title/category, and fact/note token matches;
3. require at least one match;
4. sort by score descending, then source/authored time descending, then ID ascending;
5. apply requested count and final serialized byte/code-point caps.

No stemming, fuzzy model call, embedding, network, index daemon, watcher, or background scan is introduced. Query terms are returned so an empty result remains explainable.

## Prompt and configuration behavior

The complete memory index is no longer loaded at startup or before requests, and the `<learned-memory>` system-prompt block is removed. Tool descriptions provide bounded guidance about when to recall or save. The fixed prompt order becomes base → project instructions → official skills → working context → cache point.

`memory` keeps its current configuration semantics because it now gates both tools and state management. `memory: false` or effective trajectory opt-out registers neither model-facing tool and writes nothing. `memoryHorizonDays` continues to control generated-entry expiry. `/memory` remains the user-only list/show/remember/forget and audit surface; it may perform migrations/mutations because it is an explicit user command, unlike the read-only recall tool.

## Migration

Version-2 state is accepted as legacy input but never trusted from stored validation metadata alone.

- On `memory_recall`, legacy generated entries are revalidated in memory with no write. Only entries with current exact anchors can be returned; they receive deterministic legacy keys/categories in the projection.
- On the first authorized mutation (`memory_save` durable commit or mutating `/memory` command), Darwin revalidates v2 entries, atomizes each currently valid anchored fact into one v3 entry, and drops unknown/invalid/expired generated facts instead of recreating the old archive. Legacy keys are deterministic from the old topic ID plus fact index, and categories fall back to `convention` because migration does not invent semantics.
- User notes and suppression IDs are preserved; suppressing an old topic ID suppresses every atomic fact migrated from that topic.
- Trajectories are never rescanned or backfilled, and no model call is made.

## Failure and observability

The controller replaces the extraction scheduler as the source of `memoryStatus`. It reports the existing directory plus bounded `problem` and `pending` state. Existing TUI/headless/REPL post-turn warning paths remain the only user-visible degradation surface; no new live-frame row is added.

- Recall read/corruption failure returns one bounded successful degradation result with zero entries; it never silently trusts state.
- Save validation failure is an ordinary bounded tool refusal and stages nothing.
- Durable commit/state/projection failure leaves prior valid authoritative state usable and latches a warning; it cannot fail the parent turn.
- State lock, commit queue, staged candidate count, state entries, query result count, and every serialized field remain bounded.

The ordinary SDK before/after tool events remain the sole trajectory evidence that the agent requested memory work. No new trajectory record type is added, and memory state never becomes trajectory input.
