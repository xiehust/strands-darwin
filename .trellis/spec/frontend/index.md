# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory contains guidelines for frontend development. Fill in each file with your project's specific conventions.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [TUI Testing](./tui-testing.md) | Testing Ink through a real pty: anchored waits, idle detection, exit assertions | **Filled** |
| [Live Frame](./live-frame.md) | The redrawn frame's row budget, and committing answer lines to `<Static>` | **Filled** |
| [Prompt Completion](./prompt-completion.md) | The two completion sources, and why `@` inserts a path and never file content | **Filled** |
| [Prompt Recall](./prompt-recall.md) | `Up`/`Down` over the trajectory record: the binding, what counts as history, and the read bounds | **Filled** |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | To fill |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | To fill |
| [State Management](./state-management.md) | Local state, global state, server state | To fill |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | To fill |
| [Type Safety](./type-safety.md) | Type patterns, validation | To fill |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English**.
