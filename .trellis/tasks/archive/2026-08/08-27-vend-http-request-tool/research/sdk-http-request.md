# SDK HTTP request tool research

- Installed package: `@strands-agents/sdk` 1.12.0.
- Verified export: `@strands-agents/sdk/vended-tools/http-request` exports `httpRequest`.
- Runtime metadata from the installed object: `httpRequest.name === 'http_request'`.
- Installed declaration/source documents direct `Agent({ tools: [httpRequest] })` registration.
- Darwin parent tools are assembled at `src/agent/runtime.ts` in the sole parent `new Agent(...)` tools list.
- Darwin permission `classify()` has no `http_request` special case; its default is `kind: 'execute'` with approval required.
- Parent and child calls share the composed intervention, but child tool catalogues are selected separately. Keeping this vended tool only in the parent list avoids widening child capabilities.
- Existing offline runtime tests inject a fake SDK `Model` with `setRuntimeModelFactoryForTest`, create a private temporary home/project, and consume `runtime.send()` without real model calls.
