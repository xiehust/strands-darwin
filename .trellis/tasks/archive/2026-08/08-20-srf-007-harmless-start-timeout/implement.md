# Implementation plan

1. Narrow provider validation so the existing positive numeric `timeout` field is also accepted for `start`, while callback dispatch remains `manager.start(command)`.
2. Extend the focused suite with exact manager-dispatch comparison, unchanged permission/raw-input assertions, exact Pre/Post hook payloads, misplaced-field validation, and a real process that outlives a short redundant timeout.
3. Update the authoritative SDK contract and process-exit architecture wording without changing SRF-006 wait semantics.
4. Run the focused suite while editing, then `pnpm typecheck`, then one full `pnpm test` gate after source settles.
5. Validate and archive the Trellis task, commit all authorized changes, and report the final diff/status.
