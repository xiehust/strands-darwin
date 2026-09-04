# Implementation plan — SRF-013

1. Add a bounded completion classifier, fixed continuation prompt, event candidate collector, and one-shot orchestration helper.
2. Add an explicit deferred trajectory recording seam whose accept/suppress decision preserves the durable-input barrier and recorder non-participation.
3. Integrate the helper into TUI, text headless, and structured headless before any public event projection.
4. Add a focused offline suite covering classification, all output/record surfaces, one-shot behavior, tool/answer outcomes, second-match/failure/cancellation, and regression composition.
5. Update backend/output/live-frame specs, architecture rationale, and AGENTS.md invariant index.
6. Run focused tests during editing; then typecheck, one full `pnpm test`, `pnpm build`, Trellis validation, task archival, journal update, diff review, and commit.

## Rollback points

- If buffering cannot preserve trajectory observer guarantees without SDK-loop interception, stop before integration and revise the driver/runtime seam.
- If streaming `<Static>` cannot be transactionally withheld, prefer delayed publication for guarded candidates rather than attempting to erase terminal output.
