# Darwin self-evolution backlog — priorities 141–160

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-102 — Extend `/review` with an explicit full-SHA commit scope while preserving existing current-change and literal-focus forms

- Status: `in-progress`
- Priority: 141
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-26.md`](../research_2026-09-26.md) (run `03:44:50Z`)

### Implementation / acceptance evidence

Not implemented. Source S2 (Codex commit review) and current `src/commands/review-command.ts:parseReviewCommand` / `spike/verify-review-command.ts` establish the gap; `SER-087` already supplies the safe prompt-expansion path.

### Notes / blockers / abandonment reason

Implement an explicit `/review --commit <40-hex-SHA>` target; retain exact legacy `/review` and `/review <focus>` prompt bytes and parsing behavior except malformed `--commit` invocations, which must give local usage without a model turn. A valid invocation should produce a fixed review-only prompt naming the exact SHA, guiding inspection of the target commit diff against its parent (root commits against empty tree), surrounding code and relevant tests; unsupported/missing git objects must be reported rather than fabricated. No shell interpolation, hidden git execution or new reviewer executor at parse time; ordinary SDK invocation, gate, prompt queue, literal input trajectory and no-edit guidance stay intact. Explicit SHA avoids rev/flag injection and moving refs. Document grammar in README and user guide/reference EN/zh-CN and rationale in architecture only if changed. Extend review tests across parser, runtime/headless, TUI/REPL, invalid local path and permission behavior; run typecheck, test, free TUI completion and build. Host owns report/backlog/iteration log, child owns implementation/docs and may commit them. No score exception or product decision needed.

