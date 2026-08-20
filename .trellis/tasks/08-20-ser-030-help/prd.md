# SER-030 bounded in-session help

## Goal

Make Darwin's working prompt syntax and editor controls discoverable in-session through a bounded, local `/help` report, and make README input documentation match the implemented behavior.

## Requirements

1. Add `/help` as a described built-in completion row and grow the completion cap so every built-in remains offered.
2. Format help as one bounded transcript notice using the canonical built-in name/description inventory; do not maintain a second command catalogue.
3. Cover slash completion, path-only `@` insertion, user `!` shell commands, all supported multiline entry forms, completion selection/acceptance, prompt recall and queue take-back precedence, editing chords, tool-detail toggle, cancellation, and exit controls.
4. Handle `/help` before the busy guard. It must not call the model, queue, emit a tool event, add a live-frame surface, mutate configuration/session state, or access the network.
5. Reject any `/help` argument locally, including space-, tab-, and newline-separated forms.
6. Correct README's key table and remove the stale single-line/multiline-paste limitation.
7. Update the governing frontend contracts with the local bounded-help behavior and verification obligations.

## Acceptance Criteria

- [x] A focused pure formatter suite proves canonical command rows, all required prompt/key facts, explicit bounds, and no duplicate or invented command rows.
- [x] Free real-pty coverage proves idle and `!`-busy `/help`, unchanged queued-message state, local argument rejection for space/tab/newline separators, and no model-working state.
- [x] Free `completion` proves `/help` is described and every built-in remains offered after increasing `MAX_COMPLETIONS`.
- [x] Applicable completion, path, recall, queue, tool-details, multiline, cursor/key scenarios remain green.
- [x] README and frontend specs match the executable input behavior.
- [x] `pnpm typecheck`, `pnpm test`, Trellis validation, and `git diff --check` pass.

## Constraints

- No provider/live-model test is required.
- Use an offline `!` command as the busy state.
- Do not change the research backlog/source or `docs/iteration-log.md`.
- Do not load the developer skill, delegate, push, or add dependencies.
