# SER-017 — `/permissions`: list and revoke allow-rules in-session

Origin: `docs/research/research_2026-08-18.md` (run 2026-08-18T09:15:03Z), backlog
`docs/research/backlog_index.md` SER-017.

## Problem

Wildcard allow-rules are the one thing that turns a permission prompt into silence, and
today they are write-only from inside a session: `PermissionGate.addAllowRule` and the
grant-time persistence exist, but there is no way to *see* what is currently allowed, no
way to distinguish a rule the project configured from one granted minutes ago, and no
removal path at all — narrowing requires editing
`~/.darwin/projects/<project-key>/permission-rules.json` by hand and restarting. Peers
treat this as table stakes: Claude Code's `/permissions` shows rules by scope and removes
them mid-turn, effective on the next tool call (https://code.claude.com/docs/en/commands);
Codex frames `/permissions` as inspecting active boundaries
(https://developers.openai.com/codex/cli/features/).

## Goals

1. `/permissions` lists every live allow-rule with its origin: `configured` (loaded from
   the project permission-rules file at startup) vs `granted this session`.
2. `/permissions revoke <n|rule|all>` removes one rule (by report index or exact string)
   or every rule from the live gate **and** persists the removal to
   `permission-rules.json`, so a fresh process does not resurrect it. A session-granted
   rule that was persisted is removed from the file too.
3. The very next matching tool call prompts again — the gate's live list is the
   enforcement surface, the file is only memory for the next process.
4. User-only, handled before the agent like `/mode`; the model can never invoke it.
5. Unknown/malformed subcommands degrade to a usage notice; nothing falls through to the
   model as a prompt.

## Non-goals / hard constraints

- **Never widens.** The command has no add path; additions keep going exclusively through
  the permission-prompt grant flow. Persistence of a revocation only ever *filters* the
  rule set the loader already reports as in force — it never writes a rule that was not
  already both live and loadable.
- Rule-exemption policy untouched: `isRuleExempt` still means no rule can cover
  `~/.darwin/config.json` or `.env*`; this feature does not touch that code.
- Frame contracts: report is a notice through `<Static>`; header gains no row; the
  completion menu keeps every built-in visible (`MAX_COMPLETIONS` grows 11 → 12).
- A failed persistence write costs the file, not the session: the gate has already
  stopped honouring the rule, and the failure is reported as a warn notice naming the
  file (grant-flow precedent, reported-not-awaited).
- No new dependency. No model-calling suites run by the worker.

## Design

- **Gate** (`src/agent/permission.ts`): rules gain per-rule origin, tracked in a
  `Map<string, 'configured' | 'session'>` seeded from `options.allowRules`;
  `addAllowRule` marks additions `session` (a configured rule revoked and re-granted is
  honestly `session` now). New `removeAllowRule(rule): boolean` and
  `listAllowRules(): readonly AllowRuleEntry[]`. Decision path unchanged — it already
  reads the live array.
- **Persistence** (`src/config.ts`): `removeAllowRules(projectRoot, rules)` loads the
  project policy (same legacy promotion as `appendAllowRule`), filters out exactly the
  revoked rules, writes the result to `permissionRulesPath`. Filter-only by construction.
- **Runtime** (`src/agent/runtime.ts`): `listAllowRules()` delegates to the gate;
  `revokeAllowRules(rules)` removes from the gate synchronously and returns
  `{ removed, saved }` with `saved` the persistence promise the caller reports
  (`changeThinkingEffort` shape).
- **TUI** (`src/tui/App.tsx`): `/permissions` handled above the busy check next to
  `/mode` — revocation only narrows, and mid-turn is exactly when it is wanted.
  `applyPermissionsCommand` exported for the free spike, like `formatUsageReport`.
- **Completion** (`src/commands/custom-commands.ts`, `src/tui/InputBox.tsx`): add
  `permissions` between `model` and `tasks`; description "list or revoke allow-rules";
  `MAX_COMPLETIONS` 12.

## Acceptance Criteria

- [ ] A granted rule appears in the report with origin `granted this session`; a
      configured rule with origin `configured`.
- [ ] After `revoke`, the same tool call the rule used to silence asks again (proved over
      the gate + command handler in a free spike, no model call).
- [ ] Revocation is persisted: re-loading project policy after revoke does not contain
      the rule; revoking a configured rule removes it from the file.
- [ ] `/permissions bogus` and `/permissions revoke` (no target) yield usage notices.
- [ ] No code path in the command can add or rewrite a rule.
- [ ] `pnpm typecheck`, `pnpm test` (including the new free spike) pass;
      `spike/verify-tui.ts completion` still shows every built-in.

## Verification plan

- New free suite `spike/verify-permissions-command.ts` (added to `run-tests.ts`): gate
  origin/removal semantics, next-call-prompts-again over `beforeToolCall`, persistence
  round-trip against a temp HOME/projectRoot, filter-only persistence, command handler
  report / revoke / usage-degradation notices.
- `spike/verify-tui.ts completion` (free) for the menu; `pnpm typecheck`; `pnpm test`
  once before commit.
