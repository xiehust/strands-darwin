# AgentCore CLI memory integration — revised design

Status: SDK runtime data-plane migration implemented; infrastructure import remains deferred.
Approved implementation followed the design requested on 2026-09-11. The user guide documents
the runtime contract; the acceptance boundary below separates local proof from live verification.

## Verified upstream capabilities

The requested project is [`aws/agentcore-cli`](https://github.com/aws/agentcore-cli), installed locally as `@aws/agentcore` **0.26.0**, command `agentcore`. It is distinct from `aws bedrock-agentcore` in AWS CLI v2. Upstream source was inspected at revision `5b7a04051759265f9f3aec1f6fdef4085d856845`.

- `agentcore add memory` supports EPISODIC and USER_PREFERENCE strategies; `create --no-agent`, `validate --json`, `deploy`, `status --type memory --json`, and `import memory` are infrastructure/project operations. The verified CLI command tree has no direct CreateEvent, RetrieveMemoryRecords, GetMemoryRecord or DeleteMemoryRecord command.
- Strategy configuration supports `namespaceTemplates` and `reflectionNamespaceTemplates`. Default episodic templates are actor/session scoped, not project scoped, and cannot replace Darwin's isolation templates unchanged.
- The official TypeScript Strands template uses `MemoryManager` with `createAgentCoreMemoryStores` from `bedrock-agentcore/experimental/memory/strands`. The CLI generates integration code; the SDK performs data-plane operations. Generated automatic extraction is not equivalent to Darwin's user-authorized manual outbox.
- The installed Memory schema does not declare `namespaceKeys`. A local schema-only probe accepted an object containing that field but stripped it from the parsed result. Upstream Memory schema likewise omits it.
- Upstream `import-memory.ts` filters namespace templates containing `{memoryStrategyId}` and does not copy custom namespace keys. Consequently an import/deploy round trip is not established as lossless for the existing Darwin resource. Do not run it on that resource merely because import is available.

References: [memory guide](https://github.com/aws/agentcore-cli/blob/5b7a04051759265f9f3aec1f6fdef4085d856845/docs/memory.md), [Memory schema](https://github.com/aws/agentcore-cli/blob/5b7a04051759265f9f3aec1f6fdef4085d856845/src/schema/schemas/agentcore-project.ts), [import mapping](https://github.com/aws/agentcore-cli/blob/5b7a04051759265f9f3aec1f6fdef4085d856845/src/cli/commands/import/import-memory.ts), [TypeScript template](https://github.com/aws/agentcore-cli/blob/5b7a04051759265f9f3aec1f6fdef4085d856845/src/assets/typescript/http/strands/capabilities/memory/memory.ts).

## Recommended architecture

**Use AgentCore CLI for infrastructure and an official SDK for runtime memory access.** Replacing the executable name in the current transport is not a supported design.

### Infrastructure management

Use a dedicated memory-only AgentCore project outside coding-target repositories. It owns CLI project configuration and deployment targets; ordinary Darwin runs never generate a deployment project in each repository, deploy a runtime/harness, or execute resource-management commands as model tools. Configuration is explicit and deployment remains user-authorized. CLI telemetry and any CDK bootstrap/IAM effects must be disclosed before provisioning.

Retain the existing Memory resource and both strategy IDs for now. Before bringing it under CLI lifecycle management, require lossless representation of `namespaceKeys: projectid`, all three namespace templates, existing resource identity, and event retention. Resolve upstream schema/import limitations through a supported release or a separately reviewed minimal upstream/CDK extension; do not silently drop custom keys or rewrite isolation to fit defaults. There is no authorization in this runtime migration to modify upstream code, import, deploy or update the existing resource, or change IAM.

### Runtime access

`MemoryTransport` replaces `MemoryCli` using `BedrockAgentCoreClient` and the public AWS v3 CreateEvent/RetrieveMemoryRecords/GetMemoryRecord/DeleteMemoryRecord Commands. The sole added direct runtime dependency is pinned to `@aws-sdk/client-bedrock-agentcore@3.1127.0` (published September 4; Node >=20), installed through pnpm's normal release-age/supply-chain policy rather than the newly published 3.1130 release. No globally installed private dependencies are imported.

The inspected official Strands template uses `MemoryManager`/`createAgentCoreMemoryStores` with `extraction: true`. That automatic upload path conflicts with Darwin's explicit preview/send gates, so it is deliberately not installed or integrated. The data client changes transport only; no SDK agent loop, memory store or session manager is generated.

Remove the runtime dependency on shell executables, `/dev/stdin`, and CLI request-file plumbing. Credentials and request signing use the SDK credential chain. Retain explicit region/resource binding, cancellation, bounded inputs/results, finite retries and external-data validation. SDK response normalization must account for Date objects and SDK metadata without widening accepted memory content.

Do not import a globally installed CLI's private dependencies. Declare the selected runtime SDK dependency explicitly, subject to user approval and the repository's release-age rules. Do not add the full CDK/deployment CLI as a Darwin runtime dependency.

### Preserve product behavior

- Project episodes/reflections remain isolated by actor and project and reusable across sessions. User preferences remain actor-scoped across projects; the existing actor ID stays only in private user configuration, not inferred from credentials.
- Episode queries describe intent; reflection queries describe use case. Both remain ordinary parent-only gated tools.
- Only explicitly adopted preferences apply; initial retrieval is bounded, local revocation is checked before later requests, and remote edits invalidate approval when refreshed.
- Manual preview/send remains the upload default selected by the user. No generated session-manager auto-upload, archive backfill, assistant/private-reasoning upload, or implicit cloud deletion.
- Keep the existing local factual memory, outbox/provenance, receipt discipline, cancellation checks and TUI-only mutation authority. Deploying memory infrastructure must not grant a second path around these boundaries.

## Migration and acceptance

- The stopped paramfile repair was superseded, not accepted as a passing repair. Only its obsolete transport fixture/tests and claims were replaced. Existing policy regressions are mapped in [the verification checklist](agentcore-memory-verification.md); historical failures remain historical failures.
- Local tests use real SDK Commands, serialization/signing and loopback HTTP, synthetic credentials and isolated HOME. They preserve actual runtime/permissions, manual outbox, preference confirmation/revocation and lifecycle coverage. No service call or synthetic upload is part of this implementation acceptance.
- Run typecheck, the full fast suite and free completion check, then commit/build. Host independently owns the full acceptance gate and read-only retrieval against the existing resource. Real extraction requires separately authorized synthetic upload; it remains unverified here.
- After accepted build, Host removed only the actual global `agentCoreMemory.cliPath`, verified unchanged resource/strategy IDs, actor, automatic project identity, preferences enabled and manual uploads, and successfully queried all three scopes through built Darwin (empty results). Other users can remove the legacy key; until then its validated value is ignored with a bounded migration notice. No automatic config or namespace rewrite occurs in code.
- Before any future infrastructure import/deploy, require lossless namespace-key/template representation and stable resource identity. Validation alone is insufficient when unknown fields can be stripped.

Historical design validation: installed CLI 0.26.0 help/version, Memory schema probe and official source/docs inspection, without resource changes. This implementation adds the approved runtime dependency but creates/imports/deploys no AgentCore project, changes no IAM or global config, and uploads/deletes no AWS event. Host owns the iteration log.

