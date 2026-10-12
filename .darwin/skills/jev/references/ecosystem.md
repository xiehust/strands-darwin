# Choose a Jev project by the job you want done

Checked **2026-09-20** against original READMEs and selected documentation.
These are optional upstream projects, **not dependencies automatically bundled
or installed by this skill**. Examples support OpenRouter or explicit direct TypeSafe; an
upstream project may require another provider key or host. No upstream project
was installed or run for this directory update.

## Browser and desktop

### Jev Ultrafast — a browser action loop

[Project](https://github.com/browser-use/jev-ultrafast) ·
[Checked README](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/README.md)

Use it for browser navigation with fresh indexed DOM controls. Jev chooses an
operation and compatible target; a small LLM supplies typing text. Upstream uses
Python/uv, Browser Harness and a TypeSafe key plus a text-model key (the example
uses OpenRouter). After its documented setup, `uv run jev` opens the demo.
The reported 7.1-second flight search is one demo, not general reliability.
For benchmark context see [WindTunnel's separate harnesses](x-intake-2026-09-20.md).

### Jev Desktop — reuse Codex Computer Use

[Project](https://github.com/yikangy873-gif/jev-desktop) ·
[Checked README](https://github.com/yikangy873-gif/jev-desktop/blob/9b02783ed96a81f2529827492de708ca1956c265/README.md)

Use it for bounded macOS app or browser interactions in an existing Codex CUA
runtime. Prepared typing values stay local; Jev chooses among allowed controls.
Requires Codex plugin support, Node 22+, Python 3.10+ and a TypeSafe key. Follow
its marketplace/setup instructions; installing our `jev-ui` skill does not
install this plugin. The author reports integration samples and offline tests,
explicitly not a controlled speedup. Sensitive controls return to the host.

## Give agents a reusable decision tool

### TypeSafe MCP — one generic evaluate tool

[Project](https://github.com/itsmostafa/typesafe-mcp) ·
[Checked README](https://github.com/itsmostafa/typesafe-mcp/blob/d4c110c7edd82127a4ca962c9d60fb96f748eb6e/README.md)

A Go binary exposes state/questions over stdio MCP, plus a Pi extension. The
checked version accepts TypeSafe **or OpenRouter** credentials; TypeSafe wins if
both are set. Choose this for a generic judgment tool rather than a toolkit of
named recipes. Its `evaluate setup mcp` changes client configuration and carries
environment credentials into it; review scope and storage before running setup.
A manual reviewed setup may be preferable. Raw responses do not implement your
action policy for you.

### Jev MCP — named judgment tools

[jkudish/jev-mcp](https://github.com/jkudish/jev-mcp) ·
[Checked README](https://github.com/jkudish/jev-mcp/blob/67dd9fa5a6e895909f1b2d80bf45534c29cff25a/README.md)

The checked Node 20+ server exposes ten tools: verify, screen, find, classify,
decide, rerank, compare, extract, review and gate. Its command is
`npx -y @jkudish/jev-mcp`; register a reviewed version with your MCP client.
It supports OpenRouter; `JEV_PROVIDER=openrouter` selects it explicitly instead
of relying on key precedence. Supply `OPENROUTER_API_KEY` in the server's
environment, not in tool arguments. Criteria and downstream actions remain
customizable. The README's speed and benchmark statements are upstream reports.

[blakestone-x/jev-mcp](https://github.com/blakestone-x/jev-mcp) ·
[Checked README](https://github.com/blakestone-x/jev-mcp/blob/59289a0b472a3ebc3e9abfebba2d59ec2c881863/README.md)

A separate Python/uv server offers classify, score, check, match and screen.
Its documented setup uses `TYPESAFE_API_KEY`. Do not confuse similarly named MCP
packages or assume their tools, exit conventions and response shapes match.
The registration helper documents plaintext key storage and process-list exposure;
do not copy that helper blindly into a shared environment. Its combined-state
classification example returns one label, not one label per input record.

## Data, routing and context

### SemDecide — semantic shell pipelines

[Project](https://github.com/sharziki/semdecide) ·
[Checked README](https://github.com/sharziki/semdecide/blob/33cf5c03c50e02e59df3f3ea81f0650f6b791545/README.md)

Python 3.10+ CLI for predicates, choices, rubric scores and JSONL filtering.
The checked release is installed from GitHub artifacts, not PyPI, and uses a
TypeSafe key. After upstream setup, for example:

```bash
cat tickets.jsonl | semdecide filter 'The customer reports a current service blocker' --field text
```

Its exit codes differ from `jev-decide`: false/no-match, uncertainty and provider
failure are distinct. Use SemDecide for a ready-made streaming CLI; use our
examples to design a custom OpenRouter judgment. No stream throughput test was
run here. See also [P04](community.md#p04).

### Jev Codex Router — per-turn model selection

[Project](https://github.com/0xNatoshi/jev-codex-router) ·
[Checked README](https://github.com/0xNatoshi/jev-codex-router/blob/8292b519659280884627a962c826ac7721136a64/README.md)

Routes model, thinking depth and speed mode through an existing local Codex
Router installation. Requires its service and session-sharing setup, macOS,
Python 3.11+ and a TypeSafe key; this is not a drop-in OpenRouter skill.
Start with route recommendations or upstream shadow mode before changing a live
session. Do not silently enable session sharing, launch services or swap providers.
The [backtest](https://github.com/0xNatoshi/jev-codex-router/blob/8292b519659280884627a962c826ac7721136a64/BACKTEST.md)
reprices 237 historical turns at fixed token volumes; its reported savings omit
model-switch cache invalidation and do not establish equal task quality.

### winnow — recoverable tool-result filtering

[Project](https://github.com/GhalebDweikat/winnow) ·
[Checked README](https://github.com/GhalebDweikat/winnow/blob/51d80b945c74c8384bc47fa817179f668289afd8/README.md)

Likely the “VINNOW” in the user's list; spelling is provisional until confirmed.
It judges tool-output blocks, retains uncertain content, caches originals and
provides recall stubs. Upstream requires Claude Code function hooks, Python/uv
and a sidecar; summaries can additionally call Anthropic. Set upstream
`WINNOW_MODE=shadow` to inspect proposed changes without rewriting results.
Read which data leaves the machine. Its small hand-labeled replay is not proof
that aggressive pruning improves full tasks. Compare this with
[compact-adviser](x-intake-2026-09-20.md), which asks *when* to compact instead.

## Code review and discovery

### Jev Review — staged review with a dashboard

[Project](https://github.com/devagrawal09/jev-review) ·
[Checked README](https://github.com/devagrawal09/jev-review/blob/31f89602797fb7bea007f8a480bf368bf564954e/README.md)

Uses separate risk, file, evidence, mechanism and severity judgments over a diff
or codebase. Requires Node 24+, Git and a TypeSafe key. After upstream setup:

```bash
npm run review:changes:save -- /path/to/your/repo
npm run dashboard
```

Findings are inspection leads. The README explicitly says compiler diagnostics,
static analysis and indexing are not integrated. Do not imply these commands
run your tests or prove a patch safe.

### Blink — distinguish code search from the review service

[ellipsis-dev/blink](https://github.com/ellipsis-dev/blink) ·
[Checked README](https://github.com/ellipsis-dev/blink/blob/a621ede75649303a933828c18c27ad800bb43ef0/README.md)

This repository routes walkers through **file/folder names** to suggest paths;
it is not full-content review. Requires Bun 1.3.14+ and a TypeSafe key. After its
setup, `./blink "where are invoices generated?" /path/to/repo -r` explores a
path. Walker percentages are not probabilities of a bug or correctness.

[blink.review](https://blink.review/) separately advertises an agent-oriented
review CLI. Its landing page was read; installation, implementation and claimed
speed were not verified. Do not conflate its review claims with the search repo.

## Learn by editing an example

### TypeSafe AI Playground — community, not official

[Project](https://github.com/TypeSafeAI/typesafe-playground) ·
[Checked README](https://github.com/TypeSafeAI/typesafe-playground/blob/f67c3571fca1c468b4585f17282a58a1f57b1a17/README.md)

Likely the “TypeSafe All Playground” in the request. Its README identifies it as
an independent community extension of
[nickthompson480/typesafe-ai-playground](https://github.com/nickthompson480/typesafe-ai-playground),
with editable questions, A/B inputs, conversation, extraction and simulation
workspaces. Requires Node 22+ and its pinned pnpm version; live runs use a
TypeSafe key. Some routes use mocks or local solvers: check the mode before
treating a screenshot as a model result. The UI was not run here.

## More awesome lists

Read these for breadth; follow entries back to original sources before copying
setup instructions or benchmark claims. Directory membership is not verification.

- [Anil-matcha/awesome-jev-by-typesafe](https://github.com/Anil-matcha/awesome-jev-by-typesafe): use cases, prompts and starter patterns. Checked `afd223fcd4395cca3d5b3c9d1acac30b19203e25`.
- [cobanov/awesome-jev](https://github.com/cobanov/awesome-jev): categorized project discovery. Checked `359d390476606a1a69aac72977373b6f66035e7e`.
- [yibie/awesome-jev](https://github.com/yibie/awesome-jev): projects plus guides and discussions. Checked `f2f25e4c9bf0ef4d132071ac1167b0ef03704afa`.
- [hellogumbo/awesome-jev](https://github.com/hellogumbo/awesome-jev): broad community directory. Checked `776f499028aa2557e5abd621b1205d295b9bcc44`.
- [yzfly/awesome-jev-zh](https://github.com/yzfly/awesome-jev-zh): Chinese discovery and onboarding. Checked `6089b3ea0abfab19ae572accde4e312f54877635`.

This collection's contribution is **task → editable example → separately
installable skill → evidence**, not a claim to have invented or bundled these
projects. Keep the original authors' attribution and license if reusing code.

## Expanded project directory

See the [45-entry README project table](https://github.com/wuyoscar/jev-skill/blob/main/README.md#projects)
for apps, demos, reports, model alternatives and methodology references. The
[September 21 intake](intake-2026-09-21.md) maps all 76 supplied list entries and
records newly inspected commits. Alternative-model API compatibility is not
Jev equivalence. These projects are never installed by the setup skill.
