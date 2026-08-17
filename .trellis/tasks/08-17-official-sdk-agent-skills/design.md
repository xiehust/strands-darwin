# Design: official SDK Agent Skills migration

## 1. Boundary

Replace the temporary parser/plugin core with one Darwin adapter around the SDK's official
`AgentSkills` and `Skill`:

- **SDK-owned:** frontmatter/body parsing, Skill data model, catalogue XML, activation state,
  activation formatting, sandbox resource traversal and resource bounds.
- **Darwin-owned:** built-in/project/global discovery policy, problem isolation, required built-in
  fatality, `load_skill({ name })` compatibility, slash expansion, permission classification,
  and prompt/cache/session ordering.

No agent-loop fork and no SDK patch are needed.

## 2. Skills catalogue

### Data model

Replace Darwin's `Skill` metadata interface with a small accepted-record shape that carries:

- the official `Skill` instance;
- the absolute skill directory / SKILL.md path needed by product-policy diagnostics and tests.

Use official `Skill` fields (`name`, `description`, `instructions`, `path`) everywhere else.

### Layering algorithm

1. Discover required built-in directories in the declared required-name order.
2. Parse each through official `Skill.fromContent(..., { strict: true, path })`; any missing or
   invalid required asset throws with path/reason.
3. Discover project directories deterministically and parse valid entries through official
   `Skill.fromContent`.
4. Discover global directories similarly.
5. Resolve case-insensitive names with this precedence:
   - built-ins reserve their names;
   - accepted project entries claim names before global entries;
   - an invalid entry claims nothing;
   - duplicate/reserved entries become `SkillProblem`s.
6. Return catalogue order as required built-ins first, accepted project entries next, and accepted
   non-shadowed global entries last, with deterministic sorting inside optional layers.

Compatibility for a missing `name` remains narrow: inject `name: <directory>` into frontmatter
before calling `Skill.fromContent`. Do not parse the YAML or body locally. This preserves today's
README contract while leaving validation and the resulting object official.

## 3. Official plugin adapter and single tool

Use a Darwin-owned class (rename the old `SkillsPlugin` to make official ownership visible, e.g.
`DarwinSkills`) that:

- constructs `AgentSkills({ skills: officialSkills, maxResourceFiles: 20, strict: true,
  stateKey: ... })`;
- delegates `initAgent(agent)` to the official plugin so its `BeforeInvocationEvent` hook owns
  catalogue injection;
- intentionally does **not** expose official `getTools()` directly;
- captures the official native tool privately and registers one compatibility `load_skill` tool;
- stores the live Agent after initialization for slash expansion.

`load_skill` resolves names case-insensitively, invokes the official native `skills` tool with the
canonical `skill_name` and a real ToolContext whose Agent is the caller, then wraps success as
`{ instructions: <official string> }`. Unknown names keep the existing recoverable
`{ error, availableSkills }` result. Because the public tool is still named `load_skill`, current
permission classification, bundled instructions, child-agent allowlists and live transcript UX
remain unchanged. The native `skills` tool never enters `agent.toolRegistry`, so there is no second
model-facing skill tool.

Slash expansion parses `/name [request]`, resolves case-insensitively, activates through the same
official native tool against the live parent Agent, and inlines its returned instructions/resource
listing plus the existing no-reload guard and request. This removes Darwin's custom formatting and
resource traversal while retaining the TUI contract.

## 4. Prompt/cache/session ordering adapter

### Measured SDK behavior

Official `AgentSkills` injects only on `BeforeInvocationEvent`. With a cached block array it appends
a catalogue `TextBlock` after Darwin's existing cache point. Its `appState.lastInjectedXml`
de-duplicates repeated/resumed invocations, but does not enforce Darwin's order.

### Target shape

At every model call:

```text
[
  TextBlock(base + project instructions),
  TextBlock(<available_skills>),
  TextBlock(current <working-context>),
  CachePointBlock
]
```

Using a separate official catalogue `TextBlock` is deliberate: on the next invocation the official
hook can find and remove exactly the block tracked in `lastInjectedXml`, then append the refreshed
one. Darwin's later ordering hook then moves the appended catalogue before working context and the
cache point. This prevents warning spam and duplication.

### Hook order

Register a Darwin `BeforeInvocationEvent` callback **after** official `initAgent` registers its
callback. The SDK executes same-order Before callbacks in registration order, so:

1. official hook removes the previous exact catalogue and appends one current catalogue;
2. Darwin hook recognizes the known prompt shape and moves that appended catalogue before working
   context and the cache point.

After `initialize()`, runtime prompt preparation converts the base/project prompt into explicit
blocks: `Text(base/project)`, `Text(current working context)`, and an optional final cache point.
There is intentionally no catalogue yet on a fresh Agent: the official plugin owns first
injection, and its Before hook runs before the first model call. The Darwin hook then reorders that
official `TextBlock` in the same Before phase, so the model's first observed request has the target
shape. No synthetic/cancelled invocation and no copied XML generator are needed.

After an invocation, the Agent retains the target shape and `SessionManager` snapshots it together
with the official state. On resume, runtime prompt preparation recognizes that explicit known
shape, preserves the official catalogue block, replaces only the working-context block, and
replaces/removes the final cache point according to the current plan. The subsequent official hook
can still remove the preserved exact catalogue block without warning before appending its current
copy; the Darwin hook moves the new copy back into the target slot.

The prompt preparation/reordering code must accept only explicit Darwin-owned block shapes and
continue to refuse unknown arrays rather than flattening or guessing. Never copy the SDK's XML
generator.

### Resume

Session snapshots include both `systemPrompt` and `appState`. On resume:

- session restore runs during `InitializedEvent`, after plugin initialization;
- restored official `lastInjectedXml` and `activatedSkills` survive;
- runtime replaces the stale working context and reapplies the configured cache point against the
  known target block shape;
- on invocation, official removal and Darwin reordering produce one catalogue in target order.

Generalize `applyWorkingContext`/cache helpers only to explicit Darwin-owned shapes; continue to
refuse unknown block arrays rather than guess.

## 5. Resource bounds

Pass `maxResourceFiles: 20` explicitly in production. The SDK also caps recursive depth at three.
Tests create more than the injected cap and assert the official truncation marker. README/specs
must state the file count and depth honestly.

## 6. Files and deletion scope

### Production

- `src/skills/loader.ts`: replace parser/resource/prompt functions with catalogue policy that
  creates official `Skill` objects; delete `renderAvailableSkills`, `loadSkill`, recursive resource
  traversal, `LoadedSkill` and `formatSkillForModel`.
- `src/skills/plugin.ts`: replace the hand-built plugin with the official adapter; delete custom
  `initAgent` prompt append and custom activation formatting; retain compatibility tool and slash
  parsing only.
- `src/agent/runtime.ts`: wire the adapter/live Agent and prompt-order hook; preserve `RuntimeInfo`,
  command collision input and child catalogue.
- `src/agent/working-context.ts`, `src/agent/prompt-cache.ts`: minimally extend recognized prompt
  shapes/order helpers based on the settled probe.
- `src/agent/permission.ts`: behavior should remain unchanged; touch only comments if needed.
- `package.json`/`pnpm-lock.yaml`: keep `gray-matter` because `src/agents/loader.ts` still uses it;
  no dependency changes expected.

### Tests/docs

- Add `spike/verify-agent-skills.ts` for focused official-plugin real-Agent first/repeat/resume,
  block arrays, compatibility-tool activation and resource bounds; register it in
  `spike/run-tests.ts`.
- Refactor `spike/verify-skills.ts` around the new official objects and product policy.
- Update `spike/verify-agents-md.ts`, `spike/verify-working-context.ts`,
  `spike/verify-prompt-cache.ts`, `spike/verify-state-layers.ts`, and permission assertions only
  where shapes/names require it.
- Update `spike/verify-skills-live.ts` to a single low-token autonomous smoke if needed.
- Update `AGENTS.md`, `.trellis/spec/backend/strands-sdk-contracts.md`,
  `.trellis/spec/backend/error-handling.md` if any failure wording changes, and README skill/cache
  architecture and resource-bound prose.
- Do not edit the three Host-owned research/iteration files.

## 7. Risks and rollback

- **Prompt cache regression:** official injection is per invocation. The real-Agent focused suite
  must inspect the actual `StreamOptions.systemPrompt`, not merely `agent.systemPrompt` after setup.
- **Resume duplication:** `lastInjectedXml` is persisted app state. Test a new Agent against an
  actual `SessionManager` snapshot.
- **Adapter accidentally exposes `skills`:** assert both tool registry and child-visible tools
  contain `load_skill` and not `skills`.
- **Validation drift:** official strict validation is narrower than Darwin's prior regex. Preserve
  existing valid samples; report newly-invalid optional entries and fail bundled entries.
- **Slash expansion without ToolContext:** it must activate against the initialized live Agent;
  don't call the official tool without context.
- **SDK private behavior:** use only public `AgentSkills`, `Skill`, `getTools`,
  `getAvailableSkills`, `getActivatedSkills`, Tool invoke/stream and hooks. Do not access private
  fields.

Rollback is one coherent revert: the migration changes no persisted file format. Existing
snapshots may carry the new official state key; the old code would ignore it.
