# Adopt official SDK Agent Skills

## Goal

Execute SER-012 by replacing Darwin's temporary, hand-built Agent Skills core with the official
`AgentSkills` and `Skill` exported by `@strands-agents/sdk@1.12.0`, reducing duplicated SDK
behavior without changing Darwin's user-facing skill catalogue, invocation UX, permission
boundary, or prompt/session guarantees.

## Background

- The installed SDK publicly exports `@strands-agents/sdk/vended-plugins/skills`; the repository's
  architecture explicitly named official TypeScript support as the deletion trigger for the
  hand-built core.
- Darwin currently owns parsing, activation, prompt catalogue injection and unbounded resource
  traversal in `src/skills/loader.ts` and `src/skills/plugin.ts`.
- Darwin also owns product policy that the SDK does not: required built-ins, layer precedence,
  startup problem reporting, `/skill-name`, the safe `load_skill({ name })` compatibility
  contract, and prompt/cache/session ordering.
- A planning probe against a real SDK `Agent` confirmed that unadapted `AgentSkills` injects its
  catalogue only on `BeforeInvocationEvent`; with Darwin's cached block array this places a skill
  `TextBlock` after the existing cache point. It de-duplicates repeated and resumed catalogues via
  `appState`, but a Darwin ordering adapter is required to put current working context and the
  cache point back at the tail.

## Requirements

### Official SDK ownership

1. Production code must import and use the SDK's official `AgentSkills` and `Skill`.
2. The official plugin must own skill parsing, catalogue generation, activation state and bounded
   resource traversal. Darwin must not retain parallel implementations of those behaviors.
3. Darwin may keep only the thin product-policy/compatibility boundary the SDK does not provide.

### Catalogue and startup policy

4. The catalogue must load required bundled skills first and reserve their names
   case-insensitively.
5. A valid project skill must override a global skill of the same case-insensitive name; a broken
   project skill must not claim the name and suppress a valid global skill.
6. Optional project/global skill failures must remain isolated and visible through
   `RuntimeInfo.skillProblems`; absent optional directories remain silent.
7. Missing or invalid required built-in skills must remain fatal and name their packaged path or
   reason.
8. Catalogue order must be deterministic: required built-ins first, then accepted project skills,
   then non-shadowed global skills.

### Model and user compatibility

9. The model must see exactly one skills-loading tool named `load_skill`, with input schema
   `{ name: string }`; the SDK's native `skills({ skill_name })` tool must not be registered or
   leaked into parent or child tool catalogues.
10. `load_skill` must remain statically safe/read-only in every permission mode. Its successful
    result must continue to expose an `instructions` field, and an unknown name must remain a
    recoverable result that lists available skills.
11. The compatibility tool must delegate actual activation to official SDK behavior so resource
    bounds and `appState` activation tracking are not reimplemented.
12. `/skill-name` matching remains case-insensitive, preserves optional trailing user text, and
    inlines the official instructions and bounded resource listing without causing the model to
    call `load_skill` again.
13. Existing completion/header/custom-command collision behavior and
    `RuntimeInfo.skillNames`/`skillProblems` remain available.

### Prompt, cache and session order

14. Every model request, fresh or resumed, must contain exactly one official
    `<available_skills>` catalogue in this order:
    base prompt -> project instructions -> skills -> current working context -> final cache point.
15. Repeated invocations must neither duplicate the catalogue nor move it after working context or
    the cache point.
16. A resumed session must preserve the snapshotted base/project/skills rules, refresh only the
    current working context, restore official activation state, and finish with one cache point.
17. Block-array prompts produced by Darwin's prompt cache must be supported rather than refused.
18. Resource listings must have an explicit production bound and an observable truncation marker.

### Documentation and lifecycle

19. Update architecture comments, `AGENTS.md`, README and backend specs to describe official SDK
    ownership and the measured ordering adapter honestly.
20. Complete the Trellis lifecycle: reviewed planning artifacts, implementation, independent
    check, spec review/update, task validation, accepted commit, and archive.

## Acceptance Criteria

- [x] Production imports `AgentSkills` and `Skill` from
      `@strands-agents/sdk/vended-plugins/skills`.
- [x] The deleted scope includes Darwin's skills frontmatter parser, custom catalogue renderer,
      custom activation/resource walker, and old block-array-refusing plugin behavior.
- [x] Only `load_skill` is model-facing; no registered `skills` tool exists.
- [x] `load_skill.toolSpec` retains the `name` property, remains safe/read-only, returns
      instructions/resources, and delegates activation to the official plugin.
- [x] Built-in reservation, required-built-in fatality, project-over-global precedence,
      optional-skill problems and deterministic built-ins-first order are covered offline.
- [x] Slash expansion is case-insensitive, preserves arguments, includes instructions and a
      bounded resource listing, and includes the no-reload guard.
- [x] A focused offline suite drives real SDK `Agent` instances through first, repeated and
      resumed invocations with block-array cache points, proving one catalogue and the required
      final order on the actual model request.
- [x] Existing focused suites for skills, AGENTS.md, working context, permission modes, state
      layers and completion pass after truthful updates.
- [x] `pnpm typecheck`, `pnpm test`, `pnpm build`, `git diff --check`, Trellis validation and the
      free completion scenario pass.
- [x] One low-token live skills smoke proves an autonomous real model call uses `load_skill`
      successfully and produces skill-conformant output.
- [x] Built-in Markdown/resources are present under `dist/src/skills/builtin/` after build.
- [x] `docs/research/backlog_index.md`, `docs/research/research_2026-08-17.md` and
      `docs/iteration-log.md` are unchanged, and commit `037dce6` remains in history.
- [x] The accepted implementation is committed and the Trellis task is archived.

## Out of Scope

- Changing skill directories, adding remote skill URLs, or adopting a non-host sandbox.
- Exposing the SDK-native `skills` tool or changing bundled skill workflows.
- Changing the agent loop, permission mode semantics, session storage layout, or provider cache
  policy.
- Editing Host-owned research/backlog or iteration-log files.

## Open Questions

None. Repository evidence and the real-Agent probe resolve the implementation boundary; the user
must still approve this planning summary before the task can enter implementation.
