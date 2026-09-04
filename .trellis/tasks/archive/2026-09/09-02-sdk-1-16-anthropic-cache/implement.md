# Implementation plan

1. Workspace: `pnpm-workspace.yaml` (remove patch entry, add `ignoredOptionalDependencies`), `pnpm add @strands-agents/sdk@1.16.0`.
2. Regenerate patch per design § Patch regeneration; `git rm` the 1.12.0 patch.
3. Fix `cancelSignal` in `src/skills/plugin.ts`, `spike/verify-codegraph-preflight.ts`, `spike/verify-web-search-empty-results.ts`.
4. `pnpm typecheck`; `node --check` on patched files.
5. Focused suites: `verify-file-editor`, `verify-background-bash`, `verify-compact`, `verify-context-offload`, `verify-retry-guard`, `verify-http-request-tool`.
6. Anthropic cache: `prompt-cache.ts` (`planPromptCache`, `anthropicCacheConfig`), `config.ts`; `verify-config.ts` assertions.
7. Live: extend `verify-anthropic-live.ts` with cache assertions; run it; run `verify-prompt-cache-live.ts` (Bedrock).
8. `pnpm test`; `verify-tui.ts completion|bang|mcp|clear`.
9. Docs: README badge, `docs/architecture/load-bearing-decisions.md`, spec (`strands-sdk-contracts.md` patch-file names, anthropic cache contract), `prompt-cache.ts` comments, `status-format.ts:251` comment check.
10. Commit, `pnpm build`.
