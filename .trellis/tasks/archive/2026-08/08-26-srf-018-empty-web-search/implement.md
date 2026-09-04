# Implementation plan — SRF-018

1. Add the selected MCP wrapper and apply it in runtime assembly before child catalogue capture.
2. Add and run the focused network/model-free real-tool-shaped suite; fix only failures attributable to SRF-018.
3. Update the backend contract, architecture rationale, AGENTS index, and fast test manifest.
4. Run affected adjacent suites, then `pnpm typecheck`, exactly one full `pnpm test`, and `pnpm build`.
5. Run Trellis quality/finish workflow, update the task journal, archive the task, and commit all owned changes while excluding `docs/research/backlog_index.md` and `docs/iteration-log.md`.