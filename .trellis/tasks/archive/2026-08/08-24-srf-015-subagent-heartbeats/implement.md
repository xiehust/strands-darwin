# Implementation plan — subagent dispatch heartbeats and targeted cancellation

1. Extend dispatch registry types and lifecycle.
   - Add injectable clock/interval options, safe phase metadata, progress subscriptions, and exact-id targeted cancellation.
   - Ensure begin/finish/cancel cleanup is idempotent and observer throws are isolated.
2. Instrument the real child without intercepting its loop.
   - Register the dispatch-specific canceller.
   - Use SDK model/tool hooks to set only closed phase/tool-name metadata.
   - Preserve final result/error handling and parent full cancellation.
3. Wire user visibility.
   - TUI: update existing active subagent row and implement `/agents cancel <id>` before busy queueing.
   - Headless: bounded stderr heartbeat and stream-JSON event; no final-JSON change.
4. Add focused offline acceptance suite to `pnpm test`.
   - Short injected timing for no-early/periodic behavior, canary privacy, parallel ids, one-child cancellation, refusal cases, cleanup, full cancellation, one final report, and TUI/frame projections.
5. Update architecture/spec/index documentation.
6. Verify once in increasing scope.
   - Focused new suite and impacted existing checks.
   - `pnpm typecheck`.
   - Exactly one full `pnpm test`.
   - `pnpm build`.
7. Validate and archive the task, append the river journal, and commit.
