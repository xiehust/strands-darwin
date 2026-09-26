# Darwin self-evolution backlog — priorities 141–160

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-102 — Extend `/review` with an explicit full-SHA commit scope while preserving existing current-change and literal-focus forms

- Status: `done`
- Priority: 141
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-26.md`](../research_2026-09-26.md) (run `03:44:50Z`)

### Implementation / acceptance evidence

Accepted commit `3ec0da4f139793dd3477d3100a03ee52b3c11dee` (`feat(review): support exact commit review scope`). Child session `session-20260926-040422866` ran in managed task `bg-657cc00a-c095-4bb1-a273-c57bfc9ada2e` (exit 0, drained); prior attempt `bg-dc7bacb3-3df5-4c90-bbc9-b866033abeee` stopped before its first model call when Host set `AWS_EC2_METADATA_DISABLED=true`, preventing Bedrock token minting. Initial malformed launch `bg-83849d9e-fd03-408c-a757-166ff5dcfda7` failed CLI `-p` grammar before a session existed. Host inspected command, runtime, TUI, headless and REPL integration diff, focused suite changes and EN/zh-CN README, guide/reference and architecture text. Host reran `pnpm typecheck && pnpm test && AWS_EC2_METADATA_DISABLED=true pnpm tsx spike/verify-tui.ts completion && pnpm build && git diff --check && git status --short` in `bg-31a8c4b6-76bb-46d4-9002-dfba02317254` (exit 0; 9,756 `PASS` lines, zero failure sections, completion 75/0; clean tree, built dist). Existing `/review` focus unchanged, malformed explicit commit refused locally and no model turn; no live-provider review-quality claim. Iteration log: Batch 152. Child usage input unknown (`-` from stopped attempt), output 18,221, cacheRead unknown, cacheWrite unknown; successful task alone input 92, output 18,221, cacheRead 3,691,767, cacheWrite 120,506. Cost aggregate unknown; successful task $1.2220.

### Notes / blockers / abandonment reason

Implement an explicit `/review --commit <40-hex-SHA>` target; retain exact legacy `/review` and `/review <focus>` prompt bytes and parsing behavior except malformed `--commit` invocations, which must give local usage without a model turn. A valid invocation should produce a fixed review-only prompt naming the exact SHA, guiding inspection of the target commit diff against its parent (root commits against empty tree), surrounding code and relevant tests; unsupported/missing git objects must be reported rather than fabricated. No shell interpolation, hidden git execution or new reviewer executor at parse time; ordinary SDK invocation, gate, prompt queue, literal input trajectory and no-edit guidance stay intact. Explicit SHA avoids rev/flag injection and moving refs. Document grammar in README and user guide/reference EN/zh-CN and rationale in architecture only if changed. Extend review tests across parser, runtime/headless, TUI/REPL, invalid local path and permission behavior; run typecheck, test, free TUI completion and build. Host owns report/backlog/iteration log, child owns implementation/docs and may commit them. No score exception or product decision needed.

