# Design

## Behavior gap

A parent `AgentRuntime` currently registers bash, file editor, image viewer, and MCP sources, but not the installed SDK HTTP request tool. The desired behavior is to include the SDK singleton while leaving execution to the SDK and authorization to Darwin's existing intervention.

## Change boundary

- `src/agent/runtime.ts`: import `httpRequest` and add it to the parent `Agent`'s ordinary tools list.
- `spike/verify-http-request-tool.ts`: add an offline registration and permission-gating regression.
- `spike/run-tests.ts`: include the focused regression in the fast suite.
- `AGENTS.md` and `.trellis/spec/backend/strands-sdk-contracts.md`: state the parent-only, fail-closed contract and its check.
- Trellis task artifacts: record requirements, evidence, plan, and check results.

No permission bypass, custom callback wrapper, alternate loop, child registration, dependency change, or real request is needed.

## Test strategy

Use a fake model that asks the runtime for `http_request`. First inspect the freshly initialized private agent's registered tools and compare identity/name to the SDK export. Then deny the generated call through a recording permission bridge and assert the request is classified `execute`, the stream completes without network access, and no model call beyond the fake model occurs. Separately create a plan-mode runtime and assert the call is denied before the bridge is asked. Since the vended callback is never reached, the test stays offline.
