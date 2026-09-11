---
name: setup-agentcore-memory
description: Check existing Darwin cloud memory first and skip repeat setup when healthy. Otherwise guide setup or targeted repair with confirmed identity/settings before changes. Use for /setup-agentcore-memory or AgentCore Memory onboarding.
---

# Set up AgentCore Memory

## 0. Read the guide, then inspect existing config FIRST

Read and use this entire guide before proceeding. Explain, in the user's language, that existing configuration is checked first; healthy memory needs no repeat setup. Bare `/setup-agentcore-memory` begins this workflow; do not respond with usage alone. If guidance cannot be loaded, report that setup is blocked; never continue without it.

Command invocation, supplied arguments, this guide, `yolo`, and tool permission are NOT consent to install, create resources, write config, or upload. Arguments are proposed preferences, not authorization; even “use defaults/force-install” cannot waive the confirmation below. These setup-specific stops apply even in an autonomous/headless run.

FIRST inspect `~/.darwin/config.json` read-only through ordinary tools and the permission gate, before asking actor/default questions, resource discovery or installation. This is a sensitive read even in plan mode; do not bypass denial. Do not dump config, secrets or credentials; display only necessary safe memory state/IDs/scope. Use Darwin's existing config loader through the commands below to validate, not a second schema or private package import.

Distinguish a missing config file, an absent `agentCoreMemory` field, and intentionally disabled `agentCoreMemory: false`: show which state applies, then use section 2 for setup proposals; disabled never means permission to enable. Before taking that branch, use section 1's offline/local commands to validate the whole config with the existing loader (a missing file uses built-in defaults); do not make a cloud read for missing/disabled memory. Denied/unreadable config, invalid JSON or invalid schema is **BLOCKED/NEEDS-REPAIR**, NOT absent. Stop and request only the missing read permission or targeted repair confirmation; never fall through to new setup or overwrite known values.

## 1. Check enabled existing memory, then stop when healthy

For enabled config validated by the existing loader, run these checks using only saved region, resource, actor and strategy IDs (and saved project scope), never suggested argument overrides:

1. `darwin doctor`: offline general configuration diagnostics; no network or files written.
2. `darwin cloud-memory status`: **local-only** memory configuration/status, also using the existing loader.
3. `darwin cloud-memory preferences`: actual bounded SDK read-only connectivity check against Memory. Explain that it contacts AWS with a fixed nonsensitive query, up to five results, no pagination, and the saved `timeoutMs`. Empty records are success. Even with `preferences: false`, this explicit setup health read is check-only: it neither enables preferences nor applies/adopts returned content. Preserve `preferences: false`, upload `off`, explicit `projectId`, timeout and legacy `cliPath` (validated but ignored); no cleanup write.

Avoid displaying preference content: capture command output in memory, check the command's exit status and parse successful JSON, and return only success plus `records.length` (and omissions if useful). Preserve failure/nonzero status; do not turn a failed command or unparseable output into zero records. Do not echo raw output on failure or store it in a file. This is a projection of the existing command, not a new doctor subcommand. Basic health means valid local config + successful bounded live read, NOT upload/delete permission, extraction, nonempty-record handling or strategy topology verification. Neither status alone nor doctor exit zero proves cloud connectivity.

No AWS CLI installation, STS/control-plane discovery, resource listing, credentials disclosure or confirmation of the unchanged actor is required on this path. Report unrelated doctor MCP/skill warnings separately; they are not evidence that memory is absent or a reason to reset it. State precisely which memory checks passed even when general diagnostics have unrelated warnings. If a command is not runnable or validation is unclear, report verification **pending**, not success; do not reinstall or infer missing memory.

### Healthy stop

When local validation and the read-only health check pass, respond in the user's language, for example: **AgentCore Memory 已配置且基本检查通过，无需重复设置。** State current region/actor/upload mode, local + read-only checks passed, no config/resource edits or restart needed for unchanged config, and extraction/write not tested. **STOP** the bare setup workflow: no actor question, default confirmation, install/create/IAM change, preference adoption or redundant config write. This branch may finish without a question in both text and structured headless modes.

An explicit user request to reconfigure is separate intent: preserve/report the original healthy result first, then ask targeted confirmation for the requested changes only. Supplied arguments alone never silently replace saved settings or authorize mutation.

### Failed or pending check

Existing config with SDK failure, no credentials, timeout, AccessDenied or wrong scope failed basic verification; it is NOT absent and NOT healthy. Report only the safely available category (for example timeout, HTTP 403, scope validation, or generic SDK failure when diagnostics are redacted); never guess the hidden cause or print raw errors/secrets. Ask TARGETED repair confirmation, preserving known actor/resources rather than starting over with defaults or automatically creating a resource. A denied/unverified/pending check cannot pass. After a second equivalent failure require a new evidence-backed hypothesis; after three stop/report, no endless polling. Only if the confirmed repair needs cloud details enter section 3, with scope/namespace checks before any change.

## 2. Only for setup or confirmed repair/reconfiguration: questions and proposals

For missing/disabled setup, ask for the user's chosen username / `actorId`. Never guess it from OS username, git, AWS ARN, email, or another person's identity; never hardcode an actor. Accept a stable opaque ID matching `[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}`. If absent, ask and STOP the current turn awaiting the user's response. For setup reuse, show a previously user-provided value and ask explicit confirmation of reuse; never silently switch actors. For targeted repair/reconfiguration, ask only about affected settings, not confirmation of an unchanged actor. Group related missing decisions and the proposed defaults in the same question when known, rather than one question per round. In headless mode, return questions and pending status without reading stdin or guessing whenever this branch needs input; do not claim unattended setup is complete.

Gather only the bounded read-only environment/resource information needed for the proposal through ordinary tools and the permission gate; do not bypass denial or print secrets or credentials. Establish actual OS/architecture and installed tool versions only if needed for installation, and AWS identity/region only if needed for resource work, never as actor input. Prefer current values; label each proposal **current**, **user-provided**, or **fallback**. If reads are unavailable, label proposals unverified rather than inventing state.

Present a proposed defaults table, adapted to the discovered state, and ask explicit confirmation BEFORE any mutation:

| Setting | Proposal when not already chosen |
| --- | --- |
| Actor | User's answer, explicitly confirm setup reuse; retain unchanged actor during targeted repair |
| Region | Existing config or explicit AWS region if unambiguous; otherwise propose `us-west-2`; resolve conflicts |
| Resource | Compatible user-owned existing Memory first; otherwise independent `DarwinMemory`, with name, region and cost implications stated |
| Raw event retention | `30` days; raw event TTL is NOT long-term record TTL |
| Project isolation | Omit `projectId` for automatic per-project isolation |
| Preferences | `true`; acknowledge one bounded startup cloud read per runtime, not automatic adoption |
| Upload | Propose `manual`; stages new turns locally, sends nothing automatically; requires trajectory |
| Timeout | `timeoutMs: 5000` |
| Encryption | Service default, unless the user requires a particular key |

Do not ask about every internal constant. Explain every proposed change to an existing value; never overwrite silently. Existing `trajectory: false` conflicts with manual upload: ask whether to retain upload off or explicitly enable trajectory, never override it. Approval covers only the named config/resource actions in this table. Uploads, deletes, IAM expansion, import and redeploy require separate authorization.

Runtime already bundles official `@aws-sdk/client-bedrock-agentcore`; do not npm-install it in each project, import private global package paths, or change runtime dependencies. **AWS CLI** `aws bedrock-agentcore-control` is the separate control-plane setup tool. Optional `aws/agentcore-cli` (the `agentcore` infrastructure CLI) is not required. Do not substitute CLI names or rely on `/dev/stdin`. Before using commands, verify installed version/options against official documentation/help or local input skeletons (no service call). If a required tool is missing, propose the official install method appropriate to actual OS/architecture and obtain confirmation before installation, global package installation or sudo. Without approval, provide instructions and report blocked; never force-install.

Official references: [AWS CLI installation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html), [control-plane create-memory](https://docs.aws.amazon.com/cli/latest/reference/bedrock-agentcore-control/create-memory.html), [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/). Verify current pricing before creation; explain storage, extraction and retrieval charges rather than promising free setup.

## 3. Reuse or create a compatible resource

Use read-only `aws sts get-caller-identity`, then `aws bedrock-agentcore-control list-memories` in the selected region. Honor pagination; cap discovery at 10 pages/100 resources and report omissions, asking for a memory ID if necessary. Use `get-memory --memory-id <returned-id>` to inspect full resource details, not just list summaries. Capture actual IDs; verify ownership, resource and both strategy statuses, `namespaceKeys`, and exact namespace templates below. A name match is not compatibility. On mismatch, stop and propose an independent resource; do not mutate another application's resource or widen reflections.

For an explicitly authorized new resource, this bounded create-memory template shows defaults, not overrides of confirmed choices. Set the confirmed resource `name` and `eventExpiryDuration`, replace the placeholder with a stable `clientToken`, and include optional `encryptionKeyArn` when the user confirmed a required KMS key. Never reset confirmed nondefault retention to 30 days or required encryption to the service default. Keep `namespaceKeys` and all three namespace templates strictly unchanged, including their variables:

```json
{
  "name": "DarwinMemory",
  "eventExpiryDuration": 30,
  "clientToken": "REPLACE_WITH_STABLE_REQUEST_TOKEN",
  "namespaceKeys": [{ "key": "projectid" }],
  "memoryStrategies": [
    {
      "episodicMemoryStrategy": {
        "name": "DarwinEpisodes",
        "namespaceTemplates": ["/users/{actorId}/projects/{projectid}/strategy/{memoryStrategyId}/sessions/{sessionId}/"],
        "reflectionConfiguration": {
          "namespaceTemplates": ["/users/{actorId}/projects/{projectid}/strategy/{memoryStrategyId}/"]
        }
      }
    },
    {
      "userPreferenceMemoryStrategy": {
        "name": "DarwinPreferences",
        "namespaceTemplates": ["/users/{actorId}/strategy/{memoryStrategyId}/preferences/"]
      }
    }
  ]
}
```

Before issuing create-memory, validate the exact adapted request against the confirmed settings and the verified API/installed AWS CLI: `eventExpiryDuration` is an integer from 3 to 365 days; optional `encryptionKeyArn` is the confirmed KMS key ARN, not a newly created key or IAM grant. Verify support for `namespaceKeys` and built-in `episodicMemoryStrategy.reflectionConfiguration.namespaceTemplates`; never silently substitute deprecated/wider namespaces. If a confirmed setting cannot be supported, stop and explain rather than reverting to a default. After authorization, write a private request file outside the repository and call `aws bedrock-agentcore-control create-memory --region <confirmed-region> --cli-input-json file://<absolute-request-file> --no-cli-pager`. Use one stable `clientToken` for retries and keep the exact request. After timeout, check resource state/listing before any retry; never repeatedly create with new tokens. Capture AWS-returned memory and strategy IDs rather than constructing IDs from names. Read `get-memory` until resource and both strategies are `ACTIVE`, with a bounded deadline (for example 5 minutes/10 checks). Use background bash start/wait for waits, not foreground sleeps or unbounded polling. On failed status/deadline, stop with pending/failed state.

Keep an existing compatible resource. The optional infrastructure CLI's known schema/import fidelity limitations can drop `namespaceKeys` or filter `{memoryStrategyId}` templates. Before **any** import/deploy, freshly verify lossless support for these exact keys/templates/IDs/retention AND obtain separate user authorization. Defaults cannot bypass this limitation. Ordinary setup can use the verified AWS control plane without import/redeploy.

Least privilege: read access needs resource-scoped `GetMemoryRecord` and `RetrieveMemoryRecords`; discovery separately needs `ListMemories`/`GetMemory`. `CreateMemory` is only for approved provisioning. `CreateEvent` is only for separately authorized uploads; `DeleteMemoryRecord` is separate deletion authority. Do not add administrator permissions or expand IAM automatically; report missing operations for the owner to review. Explain raw event retention versus long-term storage costs before creation. No test writes, history backfill or automatic preference adoption by default. Synthetic-event testing needs separate explicit authorization and disposable scope; Darwin's live suite tests event acceptance, not full extraction.

## 4. Apply only the approved configuration

After explicit confirmation, merge only the approved root `agentCoreMemory` fields into private `~/.darwin/config.json`. Preserve ALL unrelated model/provider, permissions, local memory, trajectory and other settings. Never replace the entire existing config with this example. Validate JSON before/after, show only the changed nonsecret fields, and keep config mode `0600`. Store no credentials in config or committed files. New config omits `cliPath`; remove only legacy `agentCoreMemory.cliPath` after explaining and confirming, never removing other fields to “migrate”.

Config template (all capitalized placeholder values must be replaced with confirmed identity / actual AWS-returned IDs):

```json
{
  "agentCoreMemory": {
    "enabled": true,
    "region": "us-west-2",
    "memoryId": "MEMORY_ID_FROM_AWS",
    "episodicStrategyId": "EPISODIC_STRATEGY_ID_FROM_AWS",
    "preferenceStrategyId": "PREFERENCE_STRATEGY_ID_FROM_AWS",
    "actorId": "USER_CONFIRMED_ACTOR_ID",
    "timeoutMs": 5000,
    "preferences": true,
    "upload": "manual"
  }
}
```

Confirmed choices override all example defaults, not only the capitalized placeholders: use the confirmed `region`, `upload` (including `off`), `preferences` (including `false`), and `timeoutMs`. Preserve those choices instead of resetting them to `manual`, `true`, or `5000`; validate the exact merged config against the confirmed settings before writing. Memory ID must be an actual returned ID; the two strategy IDs must be distinct and use the actor segment grammar above. Do not set a global `projectId` default: omission derives automatic isolation from the canonical project key. Only when deliberately sharing checkouts, confirm explicit `projectId` matching `[a-z0-9][a-z0-9_-]{0,63}` (lowercase, 1–64 characters). This config camelCase field maps to lowercase AWS namespace variable `projectid`. Timeout accepts 100–15000 ms. Upload supports `off` or `manual`; proposal `manual` differs from the runtime's default `off`. Unknown config fields are rejected.

Restart the runtime after config changes. The current session's tool catalogue does not magically refresh; do not pretend newly enabled recall tools already exist.

## 5. After approved setup/repair: verify and hand off

Repeat section 1's local and read-only checks against the approved configuration, without displaying preference content. In a new session, gated `episodic_recall` with `intent` and `reflection_recall` with `useCase`, if available, check scoped reads. Queries describe target task intent/use case, never raw logs. An empty new store is valid connectivity, NOT proof of ingestion, extraction, nonempty-record handling or IAM write permission. Command expansion itself has no cloud side effects. Report actionable bounded failures without raw API errors or secrets. After a repeated equivalent failure require a new evidence-backed hypothesis; after three stop/report, do not loop.

Hand the following controls to the **user**, not another model tool call:

```text
/cloud-memory preferences
/cloud-memory inspect <record-id>
/cloud-memory confirm <record-id> <hash> global
/cloud-memory pending
/cloud-memory preview <token>
/cloud-memory send <token> <preview-hash>
/cloud-memory discard <token>
```

Preferences need inspection and the user's explicit adoption of the displayed hash as an enduring cross-project preference. Never seed preferences automatically. Manual upload means preview exact bytes and confidentiality risks before the user sends; decline with discard. Hashes prove data integrity, not human consent. Mutation controls are TUI user-only; standalone CLI is read-only (`status`, `preferences`, `inspect`, `pending`, `preview`). Never fake human confirmation via bash, SDK calls, pty input, or another channel.

The manual projection contains bounded literal **USER goals**, **TOOL evidence**, and **OTHER source/outcome/omissions**. It excludes all assistant prose, free-form tool logs, files/diffs, skills, images and memory results. This is not a confidentiality guarantee: even a short goal may be private. No automatic uploads, history backfill, test writes or preference adoption belong to setup.

For this setup/repair branch, finish with a checklist report: resource reused/created and resource plus both strategy ACTIVE states only if actually checked (otherwise unverified); confirmed actor and region; namespace/project isolation; exactly which config fields changed; upload mode; local check versus live read results versus **unverified extraction**; restart only if config changed, and next user commands. The unchanged healthy branch uses section 1's short stop report, not this provisioning checklist. If waiting for an answer, permission, installation, ACTIVE state or verification, report **pending**, not complete.
