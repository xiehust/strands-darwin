# Structured headless JSON and JSONL output

Backlog direction `SER-011`, from `docs/research/research_2026-08-17.md` run
`2026-08-17T01:10:12Z`.

## Goal

Add opt-in final JSON and live JSONL protocols to one-shot `-p/--print` runs while preserving the
existing text protocol byte-for-byte and retaining the same SDK loop, permissions, persistence,
cleanup, cancellation and exit semantics.

## Requirements

1. `--output-format text|json|stream-json` is accepted only with `-p/--print`, once; invalid use
   fails before runtime construction with exit 2. `text` is the unchanged default.
2. JSON writes exactly one versioned terminal document. JSONL writes one versioned object per line,
   at least one lifecycle event before completion, and exactly one authoritative terminal result.
3. Every record uses one monotonic process-output sequence starting at 1. Session id is requested or
   resolved when known, otherwise null only before resolution.
4. Success is terminal only after the turn, strict shutdown, and resume-pointer persistence all
   succeed. Runtime, turn, cleanup and pointer failures are structured; cancellation is structured
   and nonzero; multiple failures retain observation order.
5. The public protocol is an explicit projection, never raw SDK serialization. It omits reasoning
   text, signatures, reasoning redacted content, guardrail-redacted original output, raw tool input,
   raw tool results, metrics/traces and live agent/invocation state.
6. V1 streams lifecycle/tool records plus completed assistant `TextBlock` content after the SDK's
   output-redaction point, never unsafe raw token deltas.
7. Unknown usage metrics are absent, measured zeros stay zero. Successful terminal result text is
   complete; other public strings are bounded and marked when truncated; JSON escaping keeps one
   object per JSONL line.
8. Structured stdout has no human contamination and structured stderr has no ordinary human
   progress. Quiet MCP behavior remains. Usage errors before a valid contract keep the existing
   human stderr-only format.
9. Preserve max-token recovery, permission behavior, signals, cleanup/reaping, diagnostics,
   trajectory, forced-exit fallback, and the default text stdout/stderr ordering.
10. No dependencies, server/daemon, SDK package, filesystem rewind, evaluation corpus, or edits to
    `docs/research/**` / `docs/iteration-log.md`.

## Acceptance Criteria

- [ ] Driver/subprocess regressions prove text success, failure and interrupt output ordering is
      byte-for-byte unchanged.
- [ ] Final JSON success/failure/cancel/cleanup/persistence cases each produce one parseable document.
- [ ] JSONL emits live lifecycle/tool/assistant events and exactly one terminal record per caught run.
- [ ] Adversarial SDK events prove no reasoning/signature/redacted/raw-tool payload reaches output.
- [ ] Unknown-vs-zero usage, permission denial, max-token recovery, pointer gating and nonzero cancel
      remain intact.
- [ ] Focused suites, trajectory, max-token, typecheck, full test, build, diff check and Trellis
      validation pass.
- [ ] Exactly two low-token Bedrock calls — one JSON and one stream-json — pass in disposable state.
- [ ] Final commit follows project convention; Host-owned research/log files remain untouched.
