# Vend SDK HTTP request tool

## Goal

Expose the installed Strands TypeScript SDK HTTP request vended tool to every freshly created parent `AgentRuntime` through Darwin's ordinary tool registration and intervention path.

## Confirmed requirements

- Import the already-installed `@strands-agents/sdk/vended-tools/http-request`; do not add or upgrade dependencies.
- Register the tool only on the parent runtime's ordinary `Agent` tools list in `src/agent/runtime.ts`; do not fork or intercept the SDK loop and do not add a hidden network path.
- Preserve the existing permission architecture. The SDK tool's verified name is `http_request`, so the existing unknown-tool fail-closed classification must treat it as `execute`, prompt in ordinary modes, and deny it in plan mode before its body can run.
- Do not add the network tool to child catalogues. Children remain limited by their existing safe read-oriented tool selection and shared intervention.
- Add focused offline regression coverage. It must inspect a freshly created runtime and exercise permission denial with a fake model-generated tool call; it must not invoke the HTTP callback, perform a network request, or call a real model.
- Keep existing tests green; pass `pnpm typecheck` and `pnpm build`.
- Update the authoritative SDK contract and load-bearing index only where needed to make the parent-only registration and gating invariant explicit.
- Commit the completed change using repository conventions. Do not push.

## Acceptance criteria

- [ ] A fresh parent `AgentRuntime` contains exactly the SDK-exported tool object under actual name `http_request`.
- [ ] Registration is in the ordinary `tools` list on the sole parent `Agent` construction in `src/agent/runtime.ts`.
- [ ] `classify('http_request', input)` remains fail-closed as `execute`.
- [ ] Default-mode denial prevents the HTTP tool body from running, and plan mode denies it before prompting or running.
- [ ] Focused coverage is offline and is included in `pnpm test`.
- [ ] `pnpm test`, `pnpm typecheck`, and `pnpm build` pass.
- [ ] Required Trellis/spec artifacts are complete and the work is committed.

## Out of scope

- Real external HTTP requests or model calls.
- Custom HTTP semantics, allow-listing, URL filtering, response rewriting, or a new permission class.
- Child-agent access to the HTTP tool.
- Dependency changes or unrelated refactors.
