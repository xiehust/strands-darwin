# Design: bilingual README

## Boundaries

This change is documentation-only apart from adding standard public-repository metadata to `package.json`. It does not alter source code, dependencies, generated output, or runtime behavior.

## README header

Both README files use the same GitHub-compatible HTML structure:

1. centered `<h1>` project name;
2. centered, language-specific one-line description;
3. centered language selector with the current language in `<strong>` and the other language as a relative link;
4. centered Shields.io badges for Node.js, TypeScript, Strands Agents SDK, and ISC;
5. centered `docs/images/welcome.png` screenshot with language-specific alt text.

Only HTML attributes GitHub Markdown supports are used. No inline CSS, script, SVG, or generated assets are introduced. Badge labels are static projections of committed package facts, and badge links point to authoritative project/dependency pages.

## Information architecture

The root READMEs become matching landing pages of at most 300 physical lines. Their first product section leads with three connected ideas: iteration as the thesis, darwin developing its own next revision under human supervision, and `self-evolution-research` finding and driving evidence-backed improvements. Setup and broad capabilities follow; detailed mechanics link into the guide.

The guide uses paired files so either language remains one click away and links stay easy to audit:

```text
docs/user-guide/
├── README.md / README.zh-CN.md
├── getting-started.md / getting-started.zh-CN.md
├── using-darwin.md / using-darwin.zh-CN.md
├── configuration.md / configuration.zh-CN.md
├── sessions-and-state.md / sessions-and-state.zh-CN.md
├── permissions.md / permissions.zh-CN.md
├── extensions.md / extensions.zh-CN.md
├── reference.md / reference.zh-CN.md
└── development.md / development.zh-CN.md
```

The English guide reorganizes the current README rather than copying it wholesale. Each topic has one owning page; cross-topic repetition becomes links. Existing architecture, research, reflection, and iteration records remain where they are.

## Translation contract

`README.zh-CN.md` mirrors the English landing page's section order and technical coverage. Every English user-guide page has a complete `.zh-CN.md` counterpart with the same heading hierarchy, examples, tables, warnings, and links. Prose is translated by meaning rather than English sentence shape. Commands, code blocks, paths, identifiers, config keys, environment variables, model IDs, literal UI output, and record examples remain executable or recognizable.

Every paired document includes reciprocal language navigation. Chinese headings are translated, and same-document links use the corresponding GitHub anchors. Links to existing maintainer documents remain English because translating those files is out of scope.

## Package metadata

Add standard npm metadata:

- `repository.type`: `git`
- `repository.url`: `git+https://github.com/xiehust/strands-darwin.git`
- `homepage`: `https://github.com/xiehust/strands-darwin#readme`
- `bugs.url`: `https://github.com/xiehust/strands-darwin/issues`

## Compatibility and rollback

GitHub and common Markdown renderers degrade the HTML header to ordinary HTML content. The Markdown body remains conventional. Rollback consists of reverting the two README/header changes, image addition, and package metadata fields; no migration is involved.
