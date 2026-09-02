# SER-049 Refuse unknown keys in `~/.darwin/config.json`

## Goal

`loadConfig` type-checks every *known* key and refuses a known key found in the wrong half of
the file, but a key it has never heard of is never looked at: `{"thinkingEfort": "high"}` loads
and silently keeps the default effort, `promptCahce: false` keeps caching on and billing cache
writes, `permisionMode` leaves the mode at default. That is the silent no-op the spec's own
principle forbids (`error-handling.md`: "Explicit intent must never be guessed or silently
ignored"). Make every unknown key — at the root and inside `models` entries — a `ConfigError`
that names the file, the key, where it was found and, when one is close, the known key it was
probably meant to be.

Origin: `docs/research/backlog/directions-061-080.md` § SER-049 (Notes subsection is the
contract); report `docs/research/research_2026-09-02.md` (run 02:29:40Z).

## Requirements

- Root: any key outside `SESSION_KEYS ∪ MODEL_KEYS ∪ {"models"}` is refused. Entry: any key
  outside `MODEL_KEYS ∪ {"enable"}` is refused (`name` is already in `MODEL_KEYS`).
- One `ConfigError` reports *all* unknown keys of the file together. Each item names the key
  (JSON-quoted), its location (`at the top level`, or `in models[i]` plus the entry's `name`
  when it is a string), and appends `did you mean "<known>"?` when a known key for that location
  is within optimal-string-alignment (Damerau-Levenshtein) distance ≤ 2, compared
  case-insensitively. Ties resolve to the first key in declaration order. No close match → no
  suggestion. The message begins with the config file path like every other config error.
- Validation order: the check runs after the existing misplaced-known-key checks (a model key
  beside `models`, a session key inside an entry) and after the known-key type checks, so every
  existing message stays byte-identical and keeps precedence. `permissionRules` at the root keeps
  its own `loadConfig` error (thrown before `validate()`).
- Refuse, never warn. No `$schema` / comment / `_`-prefixed escape hatch: the product reason
  against one is that the file has one reader (darwin) and no editor integration today, so an
  accepted-but-ignored key would reintroduce exactly the silent class this direction removes.
- Every key documented in `docs/user-guide/configuration.md` (and the zh-CN twin) still loads,
  and the schema/docs cannot drift: the test walks the two field tables against the exported key
  lists in both directions.
- Writers (`saveEnabledModel`, `saveThinkingEffort`) keep merging into the raw record unchanged —
  they are not validators.
- Existing fixture `futureSetting` in `spike/verify-config.ts` (an "unknown key from a newer
  darwin" surviving a rule write) predates project-scoped `permissionRules` and now contradicts
  the contract; it is replaced by a known key so the assertion it guards (config untouched by a
  rule write) is kept.

## Requirement → check checklist

| Requirement | Check |
|---|---|
| misspelled root key refused, names file + key + `top level` + `did you mean "thinkingEffort"` | `spike/verify-config.ts` `unknownKeys()` — `{"thinkingEfort":"high"}` |
| unknown entry key refused, names `models[1]` and the entry `name` | same — `"temprature"` inside a named entry, suggestion-free |
| stray `$schema` at root refused (no escape hatch) | same — `{"$schema": "...", "model": "x"}` |
| two unknowns in one file reported in ONE message | same — both keys present in the single message |
| near-miss suggestion, case-insensitive | same — `promptCahce` → `promptCache`; `permissionmode` → `permissionMode` |
| unknown key with no close match → no `did you mean` | same — `"favouriteColour"` |
| misplaced-known-key messages unchanged | existing `strayModelKey` / `straySessionKey` assertions, plus a fixture carrying both a misplaced key and an unknown key still gets the misplaced message |
| `permissionRules` precedence kept | existing `permissionRules()` assertions (`project-scoped`) |
| documented keys ⊆ schema and schema ⊆ documented, both docs | same — parses `## Model fields` / `## Session fields` tables in `configuration.md` and `configuration.zh-CN.md` against exported `MODEL_KEYS`/`SESSION_KEYS` |
| a file using every documented key loads | same — flat form with every model + session key, array form with `models`/`enable`/`name` |
| private-HOME probe with a misspelled key prints `Configuration problem:` | manual: `HOME=<tmp> pnpm tsx src/cli.ts -p x` |
| gate | `pnpm typecheck`, full `pnpm test`, `pnpm build` |

## Acceptance Criteria

- [x] `spike/verify-config.ts` covers every checklist row above and passes.
- [x] `.trellis/spec/backend/error-handling.md` gains the unknown-key row;
      `strands-sdk-contracts.md` config bullets state the closed key set.
- [x] `docs/user-guide/configuration.md` and `configuration.zh-CN.md` state the rule.
- [x] `pnpm typecheck` clean, full `pnpm test` green (exit 0, zero FAIL lines), `pnpm build` run.

## Verification (2026-09-02)

- `pnpm tsx spike/verify-config.ts` — 300 passed, 0 failed (was 170 + earlier growth; `unknownKeys()`
  and `documentedKeys()` added). Before the docs were written, the four doc assertions failed and the
  doc walk caught a real pre-existing drift: `terminalBell` was in `SESSION_KEYS` but in neither
  user-guide table — both tables now carry it.
- Three fixtures elsewhere relied on the loader tolerating a forward-compat key
  (`futureSetting`/`future`): `verify-config.ts` (rule append), `verify-thinking.ts` (`/effort`
  persistence), `verify-state-layers.ts`. Each now uses a known key for the load path;
  `verify-thinking.ts` keeps the writer's raw-merge property as its last case and additionally pins
  that the loader then refuses the file naming `futureSetting`. `verify-thinking.ts` 58/58,
  `verify-state-layers.ts` 37/37.
- Interactive probe through `spike/tui-driver.ts` with a private `HOME` holding
  `{"thinkingEfort":"high","promptCache":true}`: exit 1, screen shows `Configuration problem:` and
  `unknown key "thinkingEfort" at the top level (did you mean "thinkingEffort"?)`. Headless `-p`
  path prints the same message after `error:`.
- `pnpm typecheck` clean. Full `pnpm test`: the only failure across runs was the documented
  pre-existing `verify-subagent-heartbeats` wall-clock flake (`active dispatches emit periodic
  stable-id increasing elapsed heartbeats`), reproduced on a stashed clean tree 1/3 runs with the
  runner's fresh-`HOME` invocation and never touching config. Final full `pnpm test`: exit 0, zero
  FAIL lines. `pnpm build` run after the commit.
