# Fix long-silent OpenAI Responses OOM

## Goal

Find and remove the production heap-growth path that exhausted a 4 GiB Node heap while an OpenAI Responses/Mantle request remained silent for about 50 minutes. Prove both the cause and the fix with a repeatable offline memory reproduction.

## Incident evidence

- Session `session-20260827-033022778` entered one turn around 05:04 and remained on `working` until Node reported heap OOM roughly 50 minutes later.
- The turn emitted no model stream or trajectory events before the crash; earlier turns completed normally.
- The request snapshot was about 1.23 MiB / 240k tokens and used OpenAI Responses through Mantle with `gpt-5.6-sol`.
- On-disk trajectory, snapshot, and background logs were only about 1.0, 1.2, and 1.4 MiB respectively, so their static file sizes do not explain a 4 GiB heap.

## Requirements

- Investigate the complete silent-request lifetime, including the Strands OpenAI Responses adapter, `openai` streaming client, SDK telemetry/local tracing, Darwin trajectory observation, diagnostics, and the TUI 90 ms render tick.
- Produce a deterministic, network-free reproduction that makes the leaking path measurable under a low heap limit or by heap/RSS sampling.
- Fix the actual unbounded retention or allocation path; do not raise `--max-old-space-size`, add an arbitrary turn timeout, or rely on an unsupported provider behavior guess.
- Keep the SDK Agent loop owned by Strands. If the defect is in the pinned SDK dependency, use the existing pnpm patch mechanism and keep the patch narrowly scoped.
- Preserve direct event streaming, the bounded live-frame design, trajectory's observer-only semantics, durable context offload, cancellation, and all existing provider behavior outside the leak.
- Use no real model calls and no network access during investigation or verification.
- Do not commit; the Host will independently inspect and accept the working tree.

## Acceptance Criteria

- [x] An offline harness reproduces sustained memory growth through the same production code path and distinguishes the responsible subsystem from the other investigated candidates.
- [x] The harness demonstrates bounded memory after the fix under a low heap or records repeatable heap/RSS samples with an explicit bound.
- [x] A regression check exposes the pre-fix retained User Timing entries and proves the fix stays bounded without contacting a model or network.
- [x] Focused regression checks, `pnpm typecheck`, and `pnpm test` pass.
- [x] The relevant Trellis spec records the newly established request-lifecycle and memory-bound contract plus its verification command.
- [x] The final report states evidence, changes, every command result, and residual risks.
