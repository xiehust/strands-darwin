# AgentCore CLI memory integration — revised design

Status: proposed architecture, not implemented. Requested on 2026-09-11.
This document does not replace the current user guide's runtime contract.

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

Retain the existing Memory resource and both strategy IDs for now. Before bringing it under CLI lifecycle management, require lossless representation of `namespaceKeys: projectid`, all three namespace templates, existing resource identity, and event retention. Resolve upstream schema/import limitations through a supported release or a separately reviewed minimal upstream/CDK extension; do not silently drop custom keys or rewrite isolation to fit defaults. There is no authorization in this design-only request to modify upstream code or redeploy the existing resource.

### Runtime access

Replace `MemoryCli` with a thin SDK-backed transport, not the whole memory feature. Prefer the official TypeScript AgentCore integration used by the CLI when its public extension points can preserve Darwin's manual upload, custom namespace variables, bounded retrieval and cancellation contracts. Otherwise use the public AWS SDK v3 AgentCore data-plane client, which the CLI itself depends on. The exact SDK adapter is an implementation spike, not a claim that the generated template satisfies those contracts today.

Remove the runtime dependency on shell executables, `/dev/stdin`, and CLI request-file plumbing. Credentials and request signing use the SDK credential chain. Retain explicit region/resource binding, cancellation, bounded inputs/results, finite retries and external-data validation. SDK response normalization must account for Date objects and SDK metadata without widening accepted memory content.

Do not import a globally installed CLI's private dependencies. Declare the selected runtime SDK dependency explicitly, subject to user approval and the repository's release-age rules. Do not add the full CDK/deployment CLI as a Darwin runtime dependency.

### Preserve product behavior

- Project episodes/reflections remain isolated by actor and project and reusable across sessions. User preferences remain actor-scoped across projects; actor ID is `river-xie` in local user configuration, not inferred from credentials.
- Episode queries describe intent; reflection queries describe use case. Both remain ordinary parent-only gated tools.
- Only explicitly adopted preferences apply; initial retrieval is bounded, local revocation is checked before later requests, and remote edits invalidate approval when refreshed.
- Manual preview/send remains the upload default selected by the user. No generated session-manager auto-upload, archive backfill, assistant/private-reasoning upload, or implicit cloud deletion.
- Keep the existing local factual memory, outbox/provenance, receipt discipline, cancellation checks and TUI-only mutation authority. Deploying memory infrastructure must not grant a second path around these boundaries.

## Migration and acceptance

1. Pause the superseded AWS CLI paramfile repair. Its seven modified files remain uncommitted and unaccepted; preserve unrelated work and remove only obsolete transport-specific edits during an authorized implementation pass.
2. Confirm this split architecture and authorization for one explicit runtime SDK dependency. A requirement that *all* reads/writes execute `agentcore` commands cannot be met by the verified upstream CLI.
3. In an isolated local fixture, verify the chosen SDK supports required namespace variables, raw USER/TOOL/OTHER events, stable idempotency tokens, request cancellation and distinct episode/reflection/preference queries. Inspect the official Strands adapter before deciding whether to use it; never copy the generated automatic extraction policy wholesale.
4. Resolve CLI schema/import fidelity before any deployment: validate and synthesize the exact custom scope, reject dropped keys, and prove existing resource IDs remain stable. A successful `agentcore validate` alone is insufficient because unknown keys may be stripped.
5. Replace only the data-plane transport and configuration plumbing; retain permission, projection, adoption and lifecycle regressions. Update both user guides and architecture only when runtime behavior actually changes.
6. Run typecheck, full fast suite and relevant TUI/lifecycle checks. Then verify read-only retrieval against the existing resource. A separately authorized synthetic event test must prove extraction and retrieval; an empty result from a fresh resource proves connectivity only.
7. Build before use. Retire the old runtime `cliPath` setting through an explicit config migration, retaining actor, resource/strategy IDs, automatic project identity and manual upload mode. No destructive resource migration or history rewrite.

Design validation performed: installed CLI 0.26.0 help/version, Memory schema probe, official command/docs/source inspection. No AgentCore project was created or imported, no resource deployed or modified, no dependency installed, and no event uploaded in this design revision. The existing global config remains enabled against the old runtime transport; this proposal does not make that transport operational.

