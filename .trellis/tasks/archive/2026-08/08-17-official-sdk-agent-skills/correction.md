# Independent acceptance correction

## Status

Independent Host acceptance of commits `53105b0` / `02dbcb2` failed. The archived task was
reopened honestly for one focused correction attempt. No additional real model/network calls are
authorized; the already completed live smoke remains the only one.

## Findings being corrected

1. Offline skill suites accidentally invoked the SDK default provider by constructing Agent without
   a model.
2. Pre-migration uncached string snapshots retained the old `<available-skills>` catalogue.
3. Statically-safe skill activation needed a bounded, symlink-safe host-resource preflight before
   delegating formatting/listing to official AgentSkills.
4. Planning text incorrectly promised SDK strict name validation although Darwin must preserve its
   existing `[A-Za-z0-9_-]+` product grammar.
5. Cache mutation accepted arbitrary text-block arrays, and `/model` ignored refusal.
6. Runtime startup failures after diagnostics installation did not unwind the SDK tap/log.
7. Activated-state resume, actual child tool catalogue, temp roots and fail-closed hook tests needed
   direct coverage.

## Acceptance evidence

Correction implementation completed without any additional live/model/network call. Verification:

- focused official-Agent skills suite: first/repeated/resumed order, activated-state restore,
  cached and uncached legacy migration, symlink/outside-root rejection, 200-entry preflight, and
  official 20-file truncation;
- skill/AGENTS suites use an explicit deterministic local Model and assert it was called;
- actual SubagentTool child catalogue contains `load_skill` and not `skills`;
- prompt-cache unknown arrays are unchanged/refused; offline `/model` shape switching succeeds for
  known shapes and fails before live config changes for unknown ones;
- injected post-initialize runtime creation failure closes diagnostics, resets SDK tap, settles MCP
  and background cleanup failures;
- `pnpm typecheck` and all 31 `pnpm test` suites pass;
- `pnpm build` and both required bundled assets pass;
- free `verify-tui.ts completion` passes 25/25;
- `git diff --check` and archived Trellis validation pass.

The existing live smoke was not rerun. Final Host recheck then found one boundary bug: migration
regexes could start at a literal `<available-skills>` mention inside project instructions and delete
rules through the real appended catalogue. The final focused fix replaces regex guessing with
standalone trailing-block parsing and proves cached plus uncached real SessionManager resumes keep
the full project-rule bytes, remove only the stale catalogue, and inject exactly one current
catalogue. Resource guarding now preserves exact `context.agent` identity while retaining complete
preflight safety. Final commit hashes/checks are reported by the worker; independent Host recheck
remains the acceptance authority.
