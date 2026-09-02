# Darwin self-evolution backlog — priorities 081–100

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-060 — Show up to three recent non-empty output lines under each background job in `/tasks`, read as a bounded tail of the job's `outputPath` — never through `readOutput`, so the model's shared cursor and `wait` semantics are untouched; rows stay one `<Text>` each and counted

- Status: `not-started`
- Priority: 81
- Score: 9
- Importance: 2
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 1
- Origin report: [`research_2026-09-02.md`](../research_2026-09-02.md) (run `14:43:25Z`, rolled `peer` path)

### Implementation / acceptance evidence

(none yet)

### Notes / blockers / abandonment reason

Requirement: `formatTasksReport` in `src/tui/task-format.ts` gains, under each job row, up to three (`TASK_TAIL_LINES`) recent non-empty output lines, each truncated end-first to a bounded width, indented and marked so they cannot be mistaken for job rows. The lines come from a new bounded tail reader over `BackgroundTaskStatus.outputPath` (read the last N KiB of the file, split, drop blank lines, keep the last three) that is separate from `BackgroundBashManager.readOutput` and never touches the task's shared `cursor`, `OUTPUT_LIMIT` accounting or any `wait` in flight — `bash output`/`wait` results before and after a `/tasks` are byte-identical. Unreadable or empty output is stated (`(no output yet)` / `(output unavailable)`), never an error; the report stays a transcript block (no live row) and the existing one-line-per-job shape is preserved for zero-output jobs. Peer evidence: Codex `/ps` "each background terminal's command plus up to three recent, non-empty output lines" (S2), `claude logs <id>` (S1). Acceptance: `spike/verify-background-bash.ts` (or a sibling in `pnpm test`) starts a real job that writes several lines, asserts the `/tasks` formatter shows the last three non-empty ones bounded, then proves an `output` call's `startOffset`/`endOffset` are unchanged by the `/tasks` read; a job with no output shows the stated placeholder; `spike/verify-tui.ts bang`/`queue` stay green; `pnpm typecheck`, `pnpm test`, `pnpm build`. Handoff constraint: AGENTS.md has 101 B of headroom — no new AGENTS.md row; the invariant sentence goes to `.trellis/spec/frontend/live-frame.md` and `docs/user-guide/reference.md`.
