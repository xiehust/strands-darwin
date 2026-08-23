# darwin user guide

**English** · [简体中文](README.zh-CN.md)

This guide owns darwin's operational documentation. The [root README](../../README.md) is the short introduction; maintainer rationale remains in [architecture](../architecture/load-bearing-decisions.md), [research](../research/), [reflections](../reflections/), and the [iteration log](../iteration-log.md).

## Read by task

| Page | Covers |
|---|---|
| [Getting started and providers](getting-started.md) | requirements, installation, working-directory layout, model providers, first run, migration |
| [Using darwin](using-darwin.md) | TUI, headless and structured output, prompt queue, local shell commands, background jobs |
| [Configuration and context](configuration.md) | every config field, model switching, caching, effort, system prompt, `AGENTS.md`, working context |
| [Sessions and state](sessions-and-state.md) | snapshots, resume, trajectory, cost, export/fork, memory, diagnostics, stored paths |
| [Permissions](permissions.md) | four modes, static safety, classifier behavior, allow rules and revocation |
| [Extensions](extensions.md) | discovery order, MCP, skills, bundled workflows, subagents, custom commands, hooks |
| [Command and keyboard reference](reference.md) | CLI, slash commands, prompt syntax, keys, command-specific behavior |
| [Limitations and development](development.md) | known limits, local gates, test suites, debugging REPL, architecture index |

## Three starting paths

- **First use:** [Getting started](getting-started.md) → [Configuration](configuration.md) → [Using darwin](using-darwin.md).
- **Safety review:** [Permissions](permissions.md) → [Sessions and state](sessions-and-state.md) → [Limitations](development.md).
- **Customization:** [Extensions](extensions.md) → [Command reference](reference.md) → [Architecture](../architecture/load-bearing-decisions.md).
