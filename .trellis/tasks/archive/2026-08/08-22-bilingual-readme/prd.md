# Restructure the README and add a Chinese edition

## Goal

Turn the README into a concise project landing page that explains why darwin is distinctive, especially its self-iteration, self-development, and self-evolution research model. Move operational reference material into a navigable user guide, and provide the same clear landing page in natural Simplified Chinese.

## Background

- `README.md` is currently the repository's only user-facing entry point and contains 1,350 lines / about 80 KB.
- It mixes product positioning, installation, daily usage, configuration, safety behavior, extension systems, diagnostics, architecture, development commands, and implementation details.
- Existing documents under `docs/architecture/`, `docs/research/`, and `docs/reflections/` preserve maintainer rationale and evidence; they are not a task-oriented user guide.
- The user supplied the public repository URL `https://github.com/xiehust/strands-darwin` and authorized use of `docs/images/welcome.png`, a 1242 × 434 PNG showing darwin's welcome screen.
- The project declares Node.js 20+, TypeScript, the Strands Agents SDK, pnpm usage, and an ISC license. No CI workflow exists, so a passing-build badge would be misleading.

## Requirements

### Landing-page READMEs

- Replace the current English README with a focused project introduction no longer than 300 physical lines.
- Add `README.zh-CN.md` as a complete Simplified Chinese counterpart with matching structure and technical meaning, also no longer than 300 physical lines.
- Give both files a centered, GitHub-compatible HTML header containing the project name, a language-specific description, English / 简体中文 navigation, factual Shields.io badges, and `docs/images/welcome.png`.
- Use `https://github.com/xiehust/strands-darwin` as the canonical public repository address. Badges cover Node.js 20+, TypeScript, Strands Agents SDK, and ISC License.
- Keep only the material needed to understand the project, install and configure it, start a session, discover its core workflows, and reach detailed documentation.

### Core story and feature emphasis

- Explain the self-development loop: darwin runs inside its own repository, implements subsequent revisions, and turns each accepted revision into the tool used for the next one, while a human retains product and safety decisions.
- Explain iteration as a product principle: the v0.0.1 Claude Code baseline provides a fixed comparison point, and subsequent work leaves an auditable Trellis and iteration-log trail.
- Present built-in `self-evolution-research` as a first-class core capability, not a secondary skill. Describe its persistent backlog, weighted research-path selection, evidence-based scoring, handoff to the `developer` supervisor, independent acceptance, and next-revision loop without implying unbounded autonomy.
- Include a compact selection of user-facing strengths: safe permission modes, TUI workflow, resumable sessions and trajectories, skills/subagents/MCP extensibility, headless automation, and local project memory.

### User guide

- Add a new `docs/user-guide/` directory with paired English and Simplified Chinese indexes and topic-oriented pages.
- Provide a complete Chinese counterpart for every English user-guide page; neither language may be a summary of the other.
- Move, edit, and deduplicate the current README's operational detail into the guide rather than dropping it.
- Cover at least: getting started and providers; interactive/headless use; configuration and context; sessions/trajectory/memory/diagnostics/background jobs; permissions; MCP/skills/subagents/hooks; command and keyboard reference; limitations and development.
- Give every guide page reciprocal language navigation and keep the two editions structurally aligned.
- Keep architecture, research, reflection, and iteration-log documents in their current locations and link to them instead of duplicating them.
- Update moved-content links and same-document anchors so navigation remains valid from the new paths.

### Language and metadata

- Rewrite Chinese prose as natural technical documentation using `humanizer-zh`: avoid literal English syntax, inflated claims, repetitive transitions, and formulaic AI phrasing while preserving meaning.
- Preserve official names, code identifiers, CLI flags, environment variables, paths, JSON keys, command output, and code blocks wherever translation would make them invalid or misleading.
- Add the approved public repository metadata to `package.json`: git repository URL, README homepage, and Issues URL.
- Do not introduce dependencies, runtime behavior changes, or unrelated documentation edits.

## Acceptance Criteria

- [ ] `README.md` and `README.zh-CN.md` are each 300 lines or fewer and follow matching section structures.
- [ ] Both READMEs prominently explain self-iteration, self-development, and `self-evolution-research` before the broader feature list.
- [ ] The `self-evolution-research` description covers research selection, evidence/scoring, supervised implementation, independent acceptance, and iteration from the accepted revision.
- [ ] GitHub renders the centered headers, factual Shields.io badges, and `docs/images/welcome.png` without broken links or unsupported CSS.
- [ ] Each header links to both language editions and clearly indicates the current language.
- [ ] `docs/user-guide/` has a useful index, topic pages, and preserves all substantive operational information removed from the old README.
- [ ] Installation and first-run instructions remain directly discoverable from each README.
- [ ] All fenced code blocks are balanced and preserve executable/configuration content.
- [ ] All repository-relative links resolve; same-document fragments target headings in the current document.
- [ ] `package.json` parses and exposes the approved `repository`, `homepage`, and `bugs` metadata.
- [ ] Final Chinese prose review finds no obvious translationese or AI-style filler and no altered technical claims.

## Out of Scope

- Translating existing architecture, research, reflection, or Trellis documents.
- Adding a logo, generating a new banner, or creating a separate documentation website.
- Changing dependencies or application behavior.
- Claiming autonomous product or safety authority for darwin.
uments.
- Adding a logo, generating a new banner, or creating a separate documentation website.
- Changing dependencies or application behavior.
- Claiming autonomous product or safety authority for darwin.

## Open Question

- Decide whether the detailed user guide is English-only or receives a parallel Simplified Chinese edition in this task.
