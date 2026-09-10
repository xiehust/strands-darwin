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

Requirements: a POSIX host and AWS CLI v2 with Memory operations. Default executable: `/usr/local/bin/aws`; set an absolute `cliPath` elsewhere. **The locally verified CLI 2.36.42 supports CreateEvent `extractionConfig.namespaceVariables` and CreateMemory `namespaceKeys`.** Darwin checks `create-event --generate-cli-skeleton input` locally before sending and refuses an incompatible CLI. Install a CLI whose skeleton includes `extractionConfig.namespaceVariables`; no version is guessed. Ordinary AWS credential-chain setup is owned by the user. Darwin neither changes credentials nor derives identity from them. Configured AWS endpoint overrides are ignored by the adapter; credential-chain flags including container authorization token/token-file and `AWS_EC2_METADATA_DISABLED` are preserved.

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

Use actual IDs; placeholders are not resources. `actorId` is your configured stable opaque user ID, shared across projects, never email or AWS credential identity. `projectId` is independent; omit it for a SHA-256 key of Darwin's canonical project key. An explicit project ID lets separate checkouts deliberately share project episodes. Actor/strategy IDs accept alphanumeric, `_`, `-` segments up to 128 characters; project ID is lowercase and at most 64 characters (the service namespace-value limit). Region is explicit. Unknown fields and traversal-like scope strings are refused. `timeoutMs` is 100–15000, default 5000; `preferences` defaults true *inside enabled config*; `upload` is `off` (default) or `manual`. Manual uploads require trajectory enabled. Omit `agentCoreMemory` or set it to `false` to disable: no cloud controller, tools, network, or cloud-state writes.

See AWS's [namespace organization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/specify-long-term-memory-organization.html), [episodic strategy](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/episodic-memory-strategy.html), and [CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/short-term-create-event.html) documentation.

## Recall and preference adoption

The parent model gets `episodic_recall({intent, limit?})` and `reflection_recall({useCase, limit?})`. Query length is 1–300 characters, limit 1–5 (default 3); secret-like queries are refused. Intent should describe the task goal; useCase should describe applicability/context. Both use `RetrieveMemoryRecords.searchCriteria.searchQuery` and the configured strategy ID. They are external network calls, not statically safe local memory: ordinary hooks, plan mode and deny rules run before the CLI. Children do not receive either tool. Startup preference retrieval is different: enabling `preferences` explicitly authorizes that bounded host behavior, including in plan mode.

`namespacePath` is hierarchical. Darwin first validates **every** returned namespace, strategy and bounded metadata value against the actor/project/resource binding. Wrong-scope records fail the whole response closed. In-scope episodes returned alongside reflections are omitted with explicit omission/underfill reporting; retrieval never broadens to compensate. No invented AWS type filter is used. Episode/reflection XML is projected into an ordered tree; evidence, assessment and action order remain data. Attributes, DTDs, processing instructions, unknown entities, malformed or oversized XML are refused. Reflection confidence estimates usefulness, not probability of correctness. A schema variation may be refused rather than guessed.

Imagine a retrieved record says “the user explicitly prefers concise answers.” That generated claim is not proof. Darwin does not automatically apply it. Use:

```text
/cloud-memory preferences
/cloud-memory inspect <record-id>
/cloud-memory confirm <record-id> <displayed-hash> global
/cloud-memory forget <record-id>
/cloud-memory delete <record-id> cloud
```

Inspect shows the complete bounded preference and hash. Confirm is your explicit adoption of that visible content as an enduring **cross-project communication/collaboration preference**. Do not confirm implicit guesses, one-time requests, project constraints or policy instructions. Approval binds region/resource/actor/strategy/namespace/record/content; changed content requires fresh inspection and approval. No unsupported citation/proof fields are invented. Once before the first model request in each runtime, a bounded general-preference search caches at most five candidates. Later requests (including compaction) reread local approvals/revocations without cloud retrieval. Explicit `preferences` refreshes the cache; `inspect` updates that record. Remote edits are detected on refresh or a new session, not by server push. A denied PreCompact hook runs before any cloud retrieval. Retrieval failure or unavailable proof applies nothing. Compact and multiline JSON arrays of `{language, context, preference, categories}` are validated and preserved literally; generated `context` is not evidence of a user quote. Inspection and approval are separate files, so a concurrent inspect cannot restore forgotten approval. Local forgetting removes approval immediately, including before the next invocation in another active project. It does not erase historical assistant replies or cloud data. Delete is separate, explicit, scope-checked and irreversible remotely; source events may regenerate records, which remain unapproved. Correction means forget, inspect the corrected cloud record, and confirm its new hash.

## Review and send new turns

Set `upload: "manual"`, then work normally. Only newly closed durable trajectory turns become candidates. Darwin does not await AWS while streaming. Failed, cancelled and incomplete turns keep their actual outcome; `endTurn` is not task success. Nothing is sent yet:

```text
/cloud-memory pending
/cloud-memory preview <token>
/cloud-memory send <token> <preview-hash>
```

Preview displays the exact CreateEvent body, scope, source session/turn/ordering, omission notice and hash. Check it for private material. The allowlist is intentionally sparse, **not a confidentiality guarantee**: bounded literal user goals as `USER` messages; tool actions/results as `TOOL` messages; source/outcome/omissions as `OTHER`; tool names and a tiny argument allowlist (`pnpm test|typecheck|build`, `git status --short`, fileEditor operation); result status and numeric exit evidence. No free-form tool output, files/diffs, logs, sensitive-path content, system/skill text, reasoning, images, binary, child transcript or memory retrieval results are uploaded. All assistant prose is omitted, even with preferences off and no tools, because it may paraphrase private images, shell reports, expanded custom commands or memory. This loses assistant explanations but never manufactures user quotes. Review is still necessary because even a short user goal can be confidential. Decline with `/cloud-memory discard <token>` to remove that pending body and unblock later turns; simply leaving it pending preserves the ordering block. No background sender decides for you.

Send requires a prior preview of the unchanged bytes. Events preserve Darwin session ID, turn/sequence order and a stable idempotency token; later turns wait for earlier pending turns in the same session. There are at most three explicitly requested attempts, with no automatic retry. Restart does not resubmit accepted events. A lost acknowledgement can leave a pending event that AWS already accepted; retry uses the identical token/body. “AWS event accepted” never means “episode generated.” Extraction and reflection happen asynchronously, and incomplete episodes may not appear yet.

Standalone `darwin cloud-memory` is read-only: `status`, `preferences`, `inspect`, `pending`, `preview`. Inspect/preview write no approval or preview proof. Failures, invalid usage and cancellation exit nonzero; disabled status exits zero. Headless mutation is unavailable in this first version (including the development REPL). Only actual user-submitted TUI `/cloud-memory` management can confirm, forget, delete, send, discard or clear accepted bodies. A hash binds reviewed bytes; it is not proof that a human authorized them. This closes the ordinary model-bash CLI route, including broad allow-rules. It is not a shell sandbox: explicitly approved arbitrary shell, a pseudo-terminal driver, direct AWS CLI, or code/filesystem access under the user's credentials can still act outside this command boundary. `/cloud-memory`, `/status`, startup and post-turn notices report enabled/degraded state; the live frame gains no rows. Busy TUI management is refused rather than queued.

## Bounds, lifecycle and verification

Transport: no shell, JSON via stdin rather than argv, one CLI attempt per request, 32 KB input, 256 KiB stdout, 8 KiB diagnostics, process-group cancellation and a total timeout. Service diagnostics are omitted rather than exposing credentials. Retrieval returns at most five records, each at most 12,000 characters; XML caps at 500 tokens and 16 levels. No pagination/archive download. Approvals: 64 local records with separate inspection/adoption files, at most five applied with 4,000 characters of validated JSON each. Outbox: 32 turns per configuration/project binding, 24 projected steps per turn, eight queued local jobs, 1 MiB trajectory-tail read, 64 KiB state-file cap, 256 directory entries. Full/degraded queues state the omission; no eviction or silent deletion. `/cloud-memory clear-accepted` explicitly removes accepted bodies and attempt/preview files to free the 32-turn capacity. Discard and cleanup first persist a receipt/tombstone; cleaned tokens cannot upload again. The bounded receipt ledger holds 256 tokens and is never evicted: further cleanup refuses at that limit, requiring user-managed archival outside Darwin. Ordering remains among non-discarded pending turns. Send/discard/cleanup use an exclusive cross-process lock and refuse in-flight work; a crash-held `active.json` (also used for bounded preference-state writes) requires manual owner inspection/recovery, never automatic lock stealing. New state is written and synced privately, then atomically published without clobbering. Interrupted `.tmp` files are not events/attempts and are never silently deleted by a later run; directory capacity still counts them. Legacy corrupt final entries need manual review rather than guessing order. Old OTHER-only payloads remain previewable/discardable but cannot upload or be automatically converted. Interrupted cleanup is reported and can be completed by repeating the user command from its receipt/tombstone.

Approvals live under `~/.darwin/agentcore/<binding>/`; outboxes under `~/.darwin/projects/<project-key>/agentcore/<binding>/<scope-binding>/`. These are sensitive user-owned policy paths. Files are private and symlinks refused. Disabled mode does not touch them. `/clear` and `/rewind` create fresh session controllers and refresh preferences, keep durable outboxes, and do not undo AWS effects. Shutdown cancels CLI work and drains bounded accepted local projection work. A crash before the detached local projection is persisted can omit that candidate; there is deliberately no archive repair/backfill. Raw-event expiry/deletion does **not** delete long-term records.

Offline proof: `pnpm tsx spike/verify-agentcore-memory.ts` uses real files, subprocesses, actual runtime and permission gates, but no AWS calls. `pnpm tsx spike/verify-agentcore-memory-live.ts` skips unless `AGENTCORE_DISPOSABLE_CONFIG` names an explicitly disposable config and `AGENTCORE_ALLOW_SYNTHETIC_UPLOAD=yes`; actor must start `synthetic-`. It uploads only synthetic events, creates/deletes no resources, and leaves cleanup to the resource owner. It tests transport acceptance, not guaranteed extraction timing. No live service behavior was verified during this implementation; no disposable resource was supplied.
