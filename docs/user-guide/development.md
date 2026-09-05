# Limitations and development

**English** · [简体中文](development.zh-CN.md) · [Guide index](README.md)

## Known limitations and safety boundaries

- **No sandbox.** Model-issued shell commands run directly on the host after the permission policy allows them. User `!` commands are explicitly user-authorized and also run on the host.
- **Permission diffs project tool input, not disk.** It exactly shows the proposed old/new text, so concurrent file changes can make the eventual effect differ.
- **Streamable HTTP MCP is configured but not live-tested.** Config handling is verified; stdio is tested end to end. `/mcp` inspection does not probe it.
- **No autonomous scheduler or swarm.** `developer` supervises one external headless child through existing sessions/jobs. `self-evolution-research` selects a bounded batch and calls that supervisor; human product/safety/acceptance authority remains.
- **Parallel subagent writes are unsafe.** Children share one working tree without isolation, locks, or conflict detection. Use concurrency for reads and serialize writes.
- **Child result rendering can include reasoning.** Child transcripts are not recorded as child events, but the current SDK-rendered terminal result returned to the parent may contain child reasoning; see the focused subagent architecture.
- **Bedrock context count is often an estimate.** Darwin enables native `CountTokens`, but measurements in `us-east-1`/`us-west-2` (August 2026) found the API accepts only a bare foundation-model ID while invocation requires an inference profile. `anthropic.claude-sonnet-4-6` counts, but its `us.`/`global.` profile or ARN returns `ValidationException: The provided model doesn't support counting tokens`; bare 4.5/4.6 count while tested `claude-opus-4-7`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-5`, and `claude-fable-5` do not. Darwin therefore does not strip prefixes just for older models and uses the SDK character heuristic until upstream accepts profile IDs. This fallback is debug-only unless diagnostics is enabled; missing `bedrock:CountTokens` IAM permission warns once per model/process.
- **Turn numbers restart per process.** A resumed trajectory can contain several `turn 1` records. Spend totals still count actual closing records.
- **Background control is process-local.** Resume retains logs, not task controls/cursors. Normal shutdown reaps process groups; `SIGKILL`/machine failure cannot guarantee it.
- **Structured output cannot guarantee a terminal record after `SIGKILL` or `EPIPE`.**
- **Diagnostics and offloaded results may contain sensitive conversation/tool material and are retained.** Diagnostics is opt-in; oversized-result offload is default-on unless explicitly disabled. There is no automatic session garbage collection.
- **Direct Anthropic needs an optional peer dependency.** See [Getting started](getting-started.md).

For implementation-level invariants, read [load-bearing decisions](../architecture/load-bearing-decisions.md) before changing the affected subsystem.

## Development commands

```bash
pnpm typecheck    # tsc --noEmit; the static quality gate
pnpm test         # all fast suites, no model/network calls
pnpm build        # emit dist/: the CLI, the built-in skill assets and dist/patches/ (the patch-package copy of the pinned SDK patch the npm package's postinstall applies)
pnpm dev-repl     # line-oriented driver over the same AgentRuntime
```

No linter is configured. The REPL predates Ink and helps separate runtime faults from terminal-rendering faults.

The npm package (`npm install -g strands-darwin`) is `npm pack` of a built tree: the `files` whitelist ships `dist/src`, `dist/patches` and the README only, `prepack` rebuilds, and `postinstall` runs `patch-package --patch-dir dist/patches`. `spike/verify-npm-patch-format.ts` (in `pnpm test`) pins the pnpm→patch-package conversion, the manifest facts and the startup preflight; `spike/verify-npm-package.ts` packs, installs into a temporary prefix and runs the installed binary — it needs the registry, so run it standalone. Publishing is a release step, not part of any suite.

### Cutting a release

Releases are cut by tag. Bump `version` in `package.json` (the only place it lives; `src/version.ts` reads it), commit, then push an annotated tag `vX.Y.Z` whose number equals that version. The `publish` workflow (`.github/workflows/publish.yml`) runs on the tag: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `spike/verify-npm-package.ts`, then refuses if the tag and `package.json` disagree, publishes to npm and creates the GitHub release with generated notes unless one already exists — write the notes first with `gh release create` if you want your own. npm authentication is trusted publishing (OIDC): npmjs.com → package settings → Trusted Publisher → GitHub Actions, owner `xiehust`, repository `strands-darwin`, workflow filename `publish.yml`; a repository secret `NPM_TOKEN` (granular token with 2FA bypass) is the fallback. `gh workflow run publish.yml --ref main` rehearses the gate on a runner without publishing.

The test layer uses real files, sessions, process groups, SDK objects, and PTYs rather than mocks. `spike/` is the test suite, not scratch space. Files named `verify-*` assert and exit nonzero on failure. `pnpm test` runs the fast subset.

## Focused and live checks

Examples of free/offline focused suites:

```bash
pnpm tsx spike/verify-config.ts
pnpm tsx spike/verify-mcp-config.ts
pnpm tsx spike/verify-mcp-command.ts
pnpm tsx spike/verify-skills.ts
pnpm tsx spike/verify-agent-skills.ts
pnpm tsx spike/verify-headless.ts
pnpm tsx spike/verify-headless-structured.ts
pnpm tsx spike/verify-agents-md.ts
pnpm tsx spike/verify-system-prompt.ts
pnpm tsx spike/verify-permission-modes.ts
pnpm tsx spike/verify-prompt-cache.ts
pnpm tsx spike/verify-trajectory.ts
pnpm tsx spike/verify-memory.ts
pnpm tsx spike/verify-background-bash.ts
pnpm tsx spike/verify-tasks-tail.ts
pnpm tsx spike/verify-file-editor.ts
pnpm tsx spike/verify-doctor-command.ts
pnpm tsx spike/verify-copy-command.ts
pnpm tsx spike/verify-tui.ts completion
pnpm tsx spike/verify-tui.ts copy
pnpm tsx spike/verify-tui.ts escRewind
pnpm tsx spike/verify-tui.ts pathCompletion
pnpm tsx spike/verify-tui.ts recall
pnpm tsx spike/verify-tui.ts bang
pnpm tsx spike/verify-tui.ts queue
pnpm tsx spike/verify-tui.ts mcp
```

Model-calling checks require real credentials and may incur cost:

```bash
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-tui.ts approve
AWS_REGION=us-west-2 pnpm tsx spike/acceptance-e2e.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-step-1-2.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-classifier.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-prompt-cache-live.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-thinking-live.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-mcp.ts
AWS_REGION=us-west-2 pnpm tsx spike/verify-skills-live.ts autonomous
AWS_REGION=us-west-2 pnpm tsx spike/verify-developer-live.ts
pnpm tsx spike/verify-mantle-live.ts
pnpm tsx spike/probe-model-switch.ts
```

Use Bedrock inference-profile IDs, never bare `anthropic.*`. The TUI suites require a real PTY because Ink needs raw mode; `spike/tui-driver.ts` supplies it. Run one scenario by appending its name. Scenario names evolve with the TUI; inspect `spike/verify-tui.ts` for the current set.

## Architecture map

The agent loop is never forked. Only `src/agent/runtime.ts` constructs `Agent`, as a thin assembly over SDK extension points. Detailed rationale and verification links are indexed in [load-bearing decisions](../architecture/load-bearing-decisions.md). The focused [subagent architecture](../architecture/sub-agents.md) covers discovery, assembly, context isolation, permissions, observability, cancellation, and concurrency.

Core source areas:

```text
src/agent/        runtime, models, permissions, prompts, sessions, diagnostics
src/tui/          Ink application, frame budget, editor, projections, rendering
src/trajectory/   append-only writer and offline readers/replay/fork/export
src/memory/       parent memory tools, durable staging, validation, commands
src/skills/       official AgentSkills policy adapter and built-ins
src/agents/       child definitions, dispatch registry, subagent tool
src/mcp/          configuration and read-only registry projection
src/hooks/        layered tool hooks
src/config.ts     strict config parsing and model construction
src/paths.ts      all global/project path ownership
```

## Repository development workflow

Nontrivial changes are understood first (the matching section of `docs/architecture/load-bearing-decisions.md` plus the relevant `spike/` suite), then implemented, verified with `pnpm typecheck`, `pnpm test` and the row's listed checks, and committed. The paper trail matters because darwin develops darwin. Every supervised `/developer` batch also appends child session, accepted commits, and Host-rerun evidence to [the iteration log](../iteration-log.md).

Keep `AGENTS.md` below 32 KiB because darwin preloads only that cap. Do not add `devEngines` to `package.json`; it can break every `npx` MCP server with an opaque closed connection. Do not bypass pnpm's `minimumReleaseAge` for fresh SDK releases. Pinned SDK patches must be revalidated on upgrade.

## Project and global state during development

All `.darwin/` paths derive from CLI cwd; `process.cwd()` is confined to CLI drivers. User state is project-keyed outside the worktree. Agents/commands/skills/hooks/MCP support global and project layers as described in [Extensions](extensions.md). Built-ins stay reserved; project named resources override global. Hook files are executable policy and deliberately sensitive.
