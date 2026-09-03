---
name: commit-message
description: Write git commit messages following this project's conventions. Use when the user asks for a commit message, or asks you to commit staged changes.
---

# Commit message conventions

Follow these rules exactly when writing a commit message for this project.

## Format

```
<type>(<scope>): <subject>

<body>

🤖 Committed with Darwin Coding Agent
```

## Rules

1. `type` must be one of: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`.
2. `scope` is the affected module, lowercase, no spaces (e.g. `permission`, `mcp`, `skills`).
3. `subject` is imperative mood, lowercase, no trailing period, at most 60 characters.
4. Separate subject and body with one blank line.
5. Wrap the body at 72 characters.
6. The body explains **why**, never **what** — the diff already shows what changed.
7. Never mention tooling or AI assistance in the subject or body. The only
   exception is the signature line below.
8. End every message with the signature `🤖 Committed with Darwin Coding Agent`
   on its own line, separated from the body by one blank line.

## Example

```
fix(permission): deny unknown tools by default

MCP servers register tools we have no policy entry for. Defaulting to
"execute" means a new tool is gated until someone classifies it, rather
than silently running unprompted.

🤖 Committed with Darwin Coding Agent
```

See `references/types.md` for when to use each type.
