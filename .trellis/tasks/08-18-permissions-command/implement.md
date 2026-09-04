# Implementation notes

- `src/agent/permission.ts`: `AllowRuleOrigin`/`AllowRuleEntry`; gate tracks origin per rule
  (`configured` seeded from `options.allowRules`, `session` on `addAllowRule`), new
  `removeAllowRule()` (removal-only) and `listAllowRules()` (fresh array). Decision path untouched.
- `src/config.ts`: `removeAllowRules(projectRoot, rules)` — loads project policy (same legacy
  promotion as `appendAllowRule`), writes the loaded set minus exactly the revoked rules.
  Filter-only by construction.
- `src/agent/runtime.ts`: `listAllowRules()`, `revokeAllowRules(rules)` → `{ removed, saved }`;
  gate revoked synchronously, persistence promise reported by the caller (grant-flow shape).
- `src/tui/App.tsx`: `/permissions` handled above the busy check next to `/mode` (user-only,
  narrowing-only, mid-turn welcome); `applyPermissionsCommand` + `formatPermissionRulesReport`
  exported for the free spike. Report/usage/degradation all notices through `<Static>`.
- `src/commands/custom-commands.ts` + `src/tui/InputBox.tsx`: 12th built-in, `MAX_COMPLETIONS` 12.
- Verification: new free `spike/verify-permissions-command.ts` (42 asserts, in `pnpm test`);
  `spike/verify-tui.ts completion` and `pathCompletion` pass; `pnpm typecheck` clean;
  `pnpm test` exit 0.
- Spec: `.trellis/spec/backend/error-handling.md` gained the revocation-write-failure row;
  AGENTS.md allow-rules paragraph extended; README permissions section mentions `/permissions`.
