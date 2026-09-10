# Optional AgentCore Memory

**English** · [简体中文](agentcore-memory.zh-CN.md) · [Guide index](README.md)

## What changes, and what does not

AgentCore Memory is **off by default**. Darwin's existing project-local `memory_recall`, `memory_save`, `/memory`, validation and retention remain unchanged. There is no migration or archive backfill. The model provider is independent: cloud memory does not switch your model or run a second model loop.

Enabling cloud memory adds gated project episode/reflection retrieval and host-configured preference retrieval. Uploading is a separate opt-in, and only manual preview/send is supported. A configured cloud preference is still untrusted contextual data, never an instruction with policy or permission precedence.

## Provisioning and configuration

Provision **outside Darwin** one existing Memory resource with exactly the intended episodic and user-preference strategies. Darwin never creates or updates resources/strategies. Use these namespace templates (AWS substitutes `{memoryStrategyId}` for each strategy):

- Episodic: `/users/{actorId}/projects/{projectid}/strategy/{memoryStrategyId}/sessions/{sessionId}/`
- Episodic reflection: `/users/{actorId}/projects/{projectid}/strategy/{memoryStrategyId}/`
- User preference: `/users/{actorId}/strategy/{memoryStrategyId}/preferences/`

Declare the custom lowercase `projectid` in the resource's `namespaceKeys`. Every uploaded event supplies `extractionConfig.namespaceVariables.projectid`, with a lowercase value. Missing variables can allow CreateEvent to succeed while extraction is skipped: monitor AWS extraction logs/`NamespaceResolutionFailure`. Do not provision a broader reflection namespace; validating returned namespace labels cannot undo cross-user synthesis performed by a wrongly configured strategy. IAM must restrict the resource and appropriate operations (`RetrieveMemoryRecords`, `GetMemoryRecord`; `CreateEvent` only for uploads, `DeleteMemoryRecord` only for explicit deletion). Configure the resource's event expiry deliberately; it is not long-term record retention.

Requirements: a POSIX host and AWS CLI v2 with Memory operations. Default executable: `/usr/local/bin/aws`; set an absolute `cliPath` elsewhere. **CLI 2.36.21 does not contain CreateEvent's `extractionConfig` field and cannot upload this feature's events.** Darwin checks `create-event --generate-cli-skeleton input` locally before sending and refuses an incompatible CLI. Install a CLI whose skeleton includes `extractionConfig.namespaceVariables`; no version is guessed. Ordinary AWS credential-chain setup is owned by the user. Darwin neither changes credentials nor derives identity from them. Configured AWS endpoint overrides are ignored by the adapter.

Add this object at the root of `~/.darwin/config.json`, alongside your existing model configuration:

```json
{
  "agentCoreMemory": {
    "enabled": true,
    "region": "us-west-2",
    "memoryId": "YourMemory-0123456789",
    "episodicStrategyId": "YourEpisodes-0123456789",
    "preferenceStrategyId": "YourPreferences-0123456789",
    "actorId": "opaque-user-42",
    "projectId": "my-project",
    "cliPath": "/usr/local/bin/aws",
    "timeoutMs": 5000,
    "preferences": true,
    "upload": "off"
  }
}
```

Use actual IDs; placeholders are not resources. `actorId` is your configured stable opaque user ID, shared across projects, never email or AWS credential identity. `projectId` is independent; omit it for a SHA-256 key of Darwin's canonical project key. An explicit project ID lets separate checkouts deliberately share project episodes. Actor/strategy IDs accept alphanumeric, `_`, `-` segments up to 128 characters; project ID is lowercase. Region is explicit. Unknown fields and traversal-like scope strings are refused. `timeoutMs` is 100–15000, default 5000; `preferences` defaults true *inside enabled config*; `upload` is `off` (default) or `manual`. Manual uploads require trajectory enabled. Omit `agentCoreMemory` or set it to `false` to disable: no cloud controller, tools, network, or cloud-state writes.

See AWS's [namespace organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html), [episodic strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/episodic-memory-strategy.html), and [CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-create-event.html) documentation.

## Recall and preference adoption

The parent model gets `episodic_recall({intent, limit?})` and `reflection_recall({useCase, limit?})`. Query length is 1–300 characters, limit 1–5 (default 3); secret-like queries are refused. Intent should describe the task goal; useCase should describe applicability/context. Both use `RetrieveMemoryRecords.searchCriteria.searchQuery` and the configured strategy ID. They are external network calls, not statically safe local memory: ordinary hooks, plan mode and deny rules run before the CLI. Children do not receive either tool. Startup preference retrieval is different: enabling `preferences` explicitly authorizes that bounded host behavior, including in plan mode.

AWS documentation differs about exact versus hierarchical namespace lookup. Darwin uses `namespacePath`, then validates **every** returned namespace, strategy and bounded metadata value. Mixed or wrong-scope results fail closed. No invented AWS type filter is used. Episode/reflection XML is projected into an ordered tree; evidence, assessment and action order remain data. Attributes, DTDs, processing instructions, unknown entities, malformed or oversized XML are refused. Reflection confidence estimates usefulness, not probability of correctness. A schema variation may be refused rather than guessed.

Imagine a retrieved record says “the user explicitly prefers concise answers.” That generated claim is not proof. Darwin does not automatically apply it. Use:

```text
/cloud-memory preferences
/cloud-memory inspect <record-id>
/cloud-memory confirm <record-id> <displayed-hash> global
/cloud-memory forget <record-id>
/cloud-memory delete <record-id> cloud
```

Inspect shows the complete bounded preference and hash. Confirm is your explicit adoption of that visible content as an enduring **cross-project communication/collaboration preference**. Do not confirm implicit guesses, one-time requests, project constraints or policy instructions. Approval binds region/resource/actor/strategy/namespace/record/content; changed content requires fresh inspection and approval. No unsupported citation/proof fields are invented. Before the first and each subsequent invocation, one bounded general-preference search applies at most five matching approvals inside an untrusted context block. Failure or unavailable proof applies nothing. Local forgetting removes approval immediately, including before the next invocation in another active project. It does not erase historical assistant replies or cloud data. Delete is separate, explicit, scope-checked and irreversible remotely; source events may regenerate records, which remain unapproved. Correction means forget, inspect the corrected cloud record, and confirm its new hash.

## Review and send new turns

Set `upload: "manual"`, then work normally. Only newly closed durable trajectory turns become candidates. Darwin does not await AWS while streaming. Failed, cancelled and incomplete turns keep their actual outcome; `endTurn` is not task success. Nothing is sent yet:

```text
/cloud-memory pending
/cloud-memory preview <token>
/cloud-memory send <token> <preview-hash>
```

Preview displays the exact CreateEvent body, scope, source session/turn/ordering, omission notice and hash. Check it for private material. The allowlist is intentionally sparse, **not a confidentiality guarantee**: bounded plain user goals; bounded public assistant statements only before tool/memory exposure; tool names and a tiny argument allowlist (`pnpm test|typecheck|build`, `git status --short`, fileEditor operation); result status and numeric exit evidence. No free-form tool output, files/diffs, logs, sensitive-path content, system/skill text, reasoning, images, binary, child transcript or memory retrieval results are uploaded. Once a session encounters tools or preference/memory data, later assistant prose is omitted to avoid re-uploading paraphrases. Review is still necessary because even a short user goal can be confidential. Decline by not sending; no background sender will decide for you.

Send requires a prior preview of the unchanged bytes. Events preserve Darwin session ID, turn/sequence order and a stable idempotency token; later turns wait for earlier pending turns in the same session. There are at most three explicitly requested attempts, with no automatic retry. Restart does not resubmit accepted events. A lost acknowledgement can leave a pending event that AWS already accepted; retry uses the identical token/body. “AWS event accepted” never means “episode generated.” Extraction and reflection happen asynchronously, and incomplete episodes may not appear yet.

The same commands work headlessly as `darwin cloud-memory <arguments>` without a model invocation. `/cloud-memory`, `/status`, startup and post-turn notices report enabled/degraded state; the live frame gains no rows. Busy TUI management is refused rather than queued.

## Bounds, lifecycle and verification

Transport: no shell, JSON via stdin rather than argv, one CLI attempt per request, 32 KB input, 256 KiB stdout, 8 KiB diagnostics, process-group cancellation and a total timeout. Service diagnostics are omitted rather than exposing credentials. Retrieval returns at most five records, each at most 12,000 characters; XML caps at 500 tokens and 16 levels. No pagination/archive download. Approvals: 64 local record files, at most five applied with 1,000 characters each. Outbox: 32 turns per configuration/project binding, 24 projected steps per turn, eight queued local jobs, 1 MiB trajectory-tail read, 64 KiB state-file cap, 256 directory entries. Full/degraded queues state the omission; no eviction or silent deletion. Retained accepted entries consume capacity; manage old local state outside Darwin after inspecting it.

Approvals live under `~/.darwin/agentcore/<binding>/`; outboxes under `~/.darwin/projects/<project-key>/agentcore/<binding>/<scope-binding>/`. These are sensitive user-owned policy paths. Files are private and symlinks refused. Disabled mode does not touch them. `/clear` and `/rewind` create fresh session controllers and refresh preferences, keep durable outboxes, and do not undo AWS effects. Shutdown cancels CLI work and drains bounded accepted local projection work. A crash before the detached local projection is persisted can omit that candidate; there is deliberately no archive repair/backfill. Raw-event expiry/deletion does **not** delete long-term records.

Offline proof: `pnpm tsx spike/verify-agentcore-memory.ts` uses real files, subprocesses, actual runtime and permission gates, but no AWS calls. `pnpm tsx spike/verify-agentcore-memory-live.ts` skips unless `AGENTCORE_DISPOSABLE_CONFIG` names an explicitly disposable config and `AGENTCORE_ALLOW_SYNTHETIC_UPLOAD=yes`; actor must start `synthetic-`. It uploads only synthetic events, creates/deletes no resources, and leaves cleanup to the resource owner. It tests transport acceptance, not guaranteed extraction timing. No live service behavior was verified during this implementation; no disposable resource was supplied.
