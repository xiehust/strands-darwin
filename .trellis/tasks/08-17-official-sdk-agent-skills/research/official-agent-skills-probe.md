# Official `AgentSkills` probe — SDK 1.12.0

Date: 2026-08-17

## Scope

The installed package at `node_modules/@strands-agents/sdk` is version 1.12.0 and publicly
exports `@strands-agents/sdk/vended-plugins/skills`. Its declarations and implementation were
read before planning, then exercised with real SDK `Agent` objects and deterministic offline
`Model` implementations (no provider or network call).

## Package behavior confirmed from implementation

- `AgentSkills.getTools()` creates `skills({ skill_name })`.
- `AgentSkills.initAgent()` loads path sources through `agent.sandbox` and registers a
  `BeforeInvocationEvent` hook. It does **not** inject the catalogue during initialization.
- The hook injects `<available_skills>`, retaining an exact `lastInjectedXml` value in the
  configured `agent.appState` key. String prompts use an embedded string; block-array prompts
  get an appended `TextBlock`.
- Repeated injection removes the previous exact value before appending the current catalogue.
- Activation records a de-duplicated `activatedSkills` list in `appState`.
- Activation output is the parsed Markdown body plus official metadata and an optional resource
  listing. Resource traversal is depth-bounded to three recursive levels and capped by
  `maxResourceFiles` (default 20), with a literal truncation marker.
- `Skill.fromContent` always requires `name` and `description`. With `strict: false`, other name
  validation issues warn but load; with `strict: true`, they throw. Darwin's current implicit
  directory-name fallback therefore remains a small product compatibility shim rather than an
  SDK-owned parser behavior.

## Real-Agent prompt/session probe

Probe shape:

- official `Skill` instance supplied to `AgentSkills`;
- `Agent` system prompt initially `[TextBlock(base + working context), CachePointBlock]`;
- deterministic model captured the exact `StreamOptions.systemPrompt` on each call;
- `SessionManager` + `LocalFileStorage` saved and restored a real session snapshot.

Observed:

1. Immediately after `agent.initialize()`, the prompt was still the original two blocks and the
   registered tool was only `skills`.
2. On the first invocation, the model received three blocks:
   `Text(base + working)`, `CachePoint`, `Text(<available_skills>)`.
3. The first invocation left exactly one catalogue and stored `lastInjectedXml` in `appState`.
4. A second invocation still had exactly one catalogue: the official hook removed/re-appended it,
   but it remained after the cache point.
5. A fresh Agent restoring the saved session recovered the three-block prompt and the official
   app state. Its resumed invocation again had one catalogue, still after the cache point.

Conclusion: official de-duplication and state persistence work, including resumed invocations,
but a raw plugin swap violates Darwin's load-bearing order. Darwin needs a narrow prompt-order
adapter around the official hook so every model request becomes:

`base/project -> official catalogue -> current working context -> final cache point`.

The adapter must preserve the official catalogue as its own exact `TextBlock` in the cached
shape. That lets the next official hook remove it without warning before Darwin reorders the
newly appended block. On resume, Darwin must deliberately flatten that known official shape to
refresh working context/reapply the current cache TTL, then reconstruct it before official
removal.

## Real-Agent activation/resource probe

A second deterministic model emitted the official `skills` tool call for a `Skill` whose
`references/` tree exceeded `maxResourceFiles: 2`.

Observed tool result:

- full instructions came from official activation;
- location metadata was included;
- exactly two resource files were listed;
- `... (truncated at 2 files)` followed them;
- `getActivatedSkills(agent)` returned the activated skill and `appState` persisted it.

Conclusion: Darwin's compatibility `load_skill({ name })` should invoke the official native tool
internally and wrap its string result in the existing `{ instructions }` top-level response. It
must not register the native `skills` tool, and slash expansion should call the same official
activation path with the live Agent rather than retain a resource walker.

## Planned constants and compatibility choices

- Pass an explicit production `maxResourceFiles` of 20; test with a smaller injected value where
  useful, and assert the truncation marker.
- Keep `load_skill({ name })` case-insensitive by resolving to the official skill's canonical name
  before invoking the official activation tool (whose map lookup is case-sensitive).
- Keep the existing directory-name fallback by injecting only a missing `name` field and then
  handing the result to official `Skill.fromContent`; retain no YAML parser or metadata model.
- Supply pre-built, policy-filtered `Skill` instances so the SDK cannot overwrite Darwin's
  built-in/project/global precedence.
