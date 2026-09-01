<div align="center">
  <h1>darwin</h1>
  <p>A terminal coding agent that improves by using each accepted revision to build the next one.</p>
  <p><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="https://nodejs.org/"><img alt="Node.js >=20.3.0" src="https://img.shields.io/badge/Node.js-%3E%3D20.3.0-339933?logo=nodedotjs&amp;logoColor=white"></a>
    <a href="https://www.typescriptlang.org/"><img alt="TypeScript 7.0.2" src="https://img.shields.io/badge/TypeScript-7.0.2-3178C6?logo=typescript&amp;logoColor=white"></a>
    <a href="https://www.npmjs.com/package/@strands-agents/sdk"><img alt="Strands Agents SDK 1.12.0" src="https://img.shields.io/badge/Strands_Agents_SDK-1.12.0-5E4AE3"></a>
    <a href="https://spdx.org/licenses/ISC.html"><img alt="ISC License" src="https://img.shields.io/badge/License-ISC-blue.svg"></a>
  </p>
  <img src="docs/images/welcome.png" alt="darwin terminal welcome screen" width="100%">
</div>

## Evolution by iteration

darwin is an experiment in self-hosted AI development. The [v0.0.1 baseline](https://github.com/xiehust/strands-darwin/releases/tag/v0.0.1) was built entirely with [Claude Code](https://claude.com/claude-code). Every later feature, fix, and release is made by running the current darwin inside this repository. Once a revision passes independent acceptance, that revision becomes the tool used to build the next one.

A human remains the developer of record: people set product and safety boundaries, authorize work, resolve decisions the repository cannot answer, and accept the result. The implementation is produced by darwin under those boundaries. The baseline is a fixed comparison point; Trellis task records under [`.trellis/`](.trellis/) and the [iteration log](docs/iteration-log.md) make subsequent work auditable.

### Built-in self-evolution research

`/self-evolution-research` supplies the selection loop in front of implementation. It advances unfinished work in a persistent [research backlog](docs/research/backlog_index.md); when none remains, it makes one binding, auditable weighted draw across comparable-product research, TUI review, open-ended improvement, unused Strands SDK capability, and observability.

The run gathers cited evidence from this repository or primary product sources, rejects duplicates, scores directions for value, fit, evidence, difficulty, and risk, and queues only work that meets the score gate. Each qualifying direction goes separately to the built-in `developer` supervisor. A fresh headless darwin implements it, then the Host independently inspects the diff and reruns acceptance checks. Only an accepted revision feeds the next direction.

```text
unfinished backlog, or one weighted research-path draw
  → evidence-backed research and scored directions
  → developer-supervised implementation
  → independent acceptance and commit
  → the accepted Darwin researches and builds the next revision
```

This is a bounded workflow, not autonomous product authority. A dirty or unverifiable starting point, repeated acceptance failure, a falsified premise, or a product/safety decision only a person can make stops the batch and records the reason. See the [dated research reports](docs/research/) and [self-reflections](docs/reflections/) for the evidence trail.

## What it gives you

- **A readable Ink TUI:** streaming Markdown answers, proposed file-edit diffs, elapsed time and token spend, slash/path completion, prompt recall and queueing, local `!` commands, and bounded reports.
- **Safe approval modes:** `default`, classifier-assisted `auto`, read-only `plan`, and explicit `yolo`, with narrow project-scoped allow rules that can be revoked in-session.
- **Durable work:** resumable project-scoped sessions, append-only trajectories, replay/search/fork/export, cost records, optional diagnostics, background jobs, and parent-managed on-demand project memory with exact evidence and durable-turn commit.
- **Extension layers:** built-in and project/global skills, custom commands, child agents with workflow-DAG delegation, tool hooks, and stdio/HTTP MCP servers, with portable `.agents/` discovery.
- **Automation:** one-shot text output or versioned JSON/JSONL, strict session selection, bounded model-call and context-offload controls, and nonzero cancellation/failure exits.
- **Model choice:** Amazon Bedrock, direct Anthropic, direct OpenAI, and OpenAI-compatible models through Bedrock Mantle; live model and thinking-effort switching.

The agent loop remains the Strands SDK loop. darwin assembles SDK models, interventions, plugins, conversation management, and tools rather than forking the loop. Maintainer rationale lives in [architecture decisions](docs/architecture/load-bearing-decisions.md).

## Install and start

Requirements: Node.js 20.3+, pnpm, and credentials for your configured provider (AWS by default).

```bash
git clone https://github.com/xiehust/strands-darwin.git
cd strands-darwin
pnpm install
pnpm build
pnpm add --global .
```

The build emits the CLI to `dist/`; the global install registers the `darwin` executable from `package.json`. Ensure pnpm's global bin directory is on `PATH` (run `pnpm setup` if pnpm reports otherwise). Keep the cloned directory after installation because the global package is linked to it.

You can now run darwin directly from any repository; its current working directory becomes the project root:

```bash
cd /path/to/your-project
darwin
darwin --resume
darwin --resume <id>        # ids: darwin sessions
darwin --session <id>
```

When developing darwin itself, `pnpm start` still runs the TypeScript source without a global installation.

`node-pty`, used by the TUI tests, is a native dev dependency already allow-listed in `pnpm-workspace.yaml`. Add any new native dependencies to that allow-list.

## Configure a model

The only active model/provider configuration is `~/.darwin/config.json`. With no file, darwin uses its built-in Bedrock catalogue. A minimal Bedrock configuration is:

```json
{
  "provider": "bedrock",
  "model": "global.anthropic.claude-opus-5",
  "region": "us-west-2",
  "permissionMode": "default"
}
```

Bedrock uses the standard AWS credential chain and requires an inference-profile model ID such as `us.`, `eu.`, `apac.`, or `global.`, not a bare `anthropic.*` ID. Direct providers use `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; direct Anthropic additionally needs the optional `@anthropic-ai/sdk` peer dependency.

For multiple switchable models, provider-specific fields, Bedrock Mantle, caching, thinking effort, context limits, and all session settings, read [Getting started and providers](docs/user-guide/getting-started.md) and [Configuration and context](docs/user-guide/configuration.md).

## Use it

```text
/                       list commands, skills, and custom commands
@src/                   complete a workspace path (path text only)
!pnpm test              run a user-authorized local shell command
/developer <requirement>
/self-evolution-research
/help                   local command, prompt, and key reference
/rewind                 branch conversation from a completed prompt (workspace unchanged)
```

Use `Ctrl+R` to search this project's prompt history (type to filter, `Ctrl+R`/`Up`/`Down` to navigate, `Enter`/`Tab` to accept, `Escape` to cancel), `Ctrl+C` to cancel busy work, `Ctrl+B` to expand or compact tool details, and `/exit` or `Ctrl+D` to quit. In the composer, `Alt/Ctrl+Left/Right` or `Alt+B`/`Alt+F` moves by word, `Alt+Backspace`/`Alt+D` deletes the word before/after the cursor, and `Ctrl+_` (or `Ctrl+-`) undoes the last `Ctrl+K`/`Ctrl+U`, `Ctrl+W` or `Alt` word deletion. Model tool calls still pass through the active permission mode; `!` commands are commands you authorize by typing them yourself.

For non-interactive use:

```bash
darwin -p "inspect this project"                         # reply on stdout; progress on stderr
darwin -p "inspect this project" --output-format json
darwin -p "inspect this project" --output-format stream-json
```

Read [Using darwin](docs/user-guide/using-darwin.md) for TUI, headless, structured-output, queue, shell, and background-job contracts.

## Documentation

- **[User guide](docs/user-guide/README.md):** installation, providers, daily use, configuration, state, safety, extensions, command reference, limitations, and development.
- **[Architecture](docs/architecture/load-bearing-decisions.md):** the contracts implementation changes must preserve.
- **[Research backlog](docs/research/backlog_index.md) and [reports](docs/research/):** evidence and ranked self-evolution directions.
- **[Iteration log](docs/iteration-log.md):** supervised implementation batches and independent acceptance.
- **[Reflections](docs/reflections/):** trajectory-based reviews that can feed the research backlog.

## Status

darwin is experimental and runs commands directly on your machine; it is not a sandbox. The permission gate is the safety boundary for model-issued tool calls. Read [Limitations and development](docs/user-guide/development.md) before relying on it for sensitive or unattended work.

## License

[ISC](https://spdx.org/licenses/ISC.html)
