# Implementation plan

1. Put the one-token transport normalization at the `cli.ts` process-argv boundary, before `sessions`/`trajectory` routing and `parseCliArgs`, leaving every domain parser strict and unchanged.
2. Add a focused no-model process suite that uses a fixture entry with Darwin's real routing/parsing seams to compare direct and separated ordinary/subcommand forms and pin exact negative errors.
3. Run the focused suite, relevant existing headless/sessions/trajectory suites, `pnpm typecheck`, then one final `pnpm test` after source settles.
4. Validate and archive the Trellis task, commit all authorized changes, and report the final diff/status.
