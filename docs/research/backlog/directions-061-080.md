# Darwin self-evolution backlog — priorities 061–080

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-043 — Add a config-gated terminal attention bell: one BEL when a permission prompt is published and one when a turn completes, emitted at the existing driver lifecycle points, never inside the Ink frame, off by default

- Status: `not-started`
- Priority: 61
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-28.md`](../research_2026-08-28.md) (run `13:03:31Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted 2026-08-28 in `94909b8` (task archive `e8376df`, journal `8c379cf`); Host acceptance recorded in `docs/iteration-log.md` Batch 65 (`verify-terminal-bell.ts` 14/14, `verify-config.ts` 248/248, `pnpm typecheck`, full `pnpm test` exit 0, `pnpm build`, grep proof that `terminal-bell.ts` is the sole BEL writer). Record repair 2026-08-30: the acceptance commit `6407864` said "SER-043 closes on independent Host acceptance" but only flipped SER-044 to `in-progress`, leaving this record's status line stale at `in-progress`; this run set it to `done` to match the recorded acceptance.

### Notes / blockers / abandonment reason

Darwin never signals the terminal today: a grep for BEL/OSC writes across `src/` is empty, so a permission prompt or a finished turn in an unfocused tab/pane is discovered only by looking. The exact moments are already first-class driver-owned events — `TurnComplete` (outcome/source) and `PermissionRequest` in `src/hooks/lifecycle-hooks.ts:8–18` — used today only to run external commands. Add one boolean config key (default **off**) following the established `src/config.ts` field pattern, and emit a single `\x07` to the real stdout at those two publication points in the interactive driver only: never per frame render, never inside an Ink row (BEL is a non-printing control byte, so ANSI-stripped pty assertions and `/export` byte-stability are untouched), never in headless drivers, and never a new information channel — no OSC title writes, no notification payload, no focus tracking. Off must be byte-identical to before the feature existed. Verify config parsing in `spike/verify-config.ts`, and add a pty check asserting exactly one BEL per permission publication and one per turn completion when enabled, zero when disabled; existing lifecycle and TUI suites stay green.

## SER-044 — Add bounded composer undo: Ctrl+_ restores the draft and cursor state destroyed by kill/word-delete chords from a small capped editor-owned snapshot stack, cleared on submit/queue/clear, never touching recall or search snapshots

- Status: `done`
- Priority: 62
- Score: 9
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-08-28.md`](../research_2026-08-28.md) (run `13:03:31Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted in `a22d72d` (task archive `fc3351b`, journal `6e20949`; child session `session-20260828-144128660`; managed task `bg-aa391bed-8fe7-4443-bb8f-376022df838a`, succeeded, exit 0). Pure bounded primitives (`UNDO_CAP = 16`, `UndoStack`, `pushUndo`, `popUndo`) in `src/tui/prompt-editor.ts`; `App.tsx` owns the ref like `preferredColumn`, snapshots via `applyDestructive` only when a chord actually changes text (Ctrl+K/U, Ctrl+W/Alt+Backspace, Alt+D/Alt+Delete), pops on Ctrl+_ (legacy 0x1f byte and kitty ctrl chord, consumed even when empty), and clears at submit, queue take-back/return, recall acceptance, history-search accept, and rewind accept; search/recall snapshot-restore untouched. Host inspected the diff and independently passed `verify-prompt-editor.ts` 48/48, free pty `undo` 7/7, `cursor` 5/5, `multiline` 9/9, `wordNav` 11/11, `completion` 67/67, `recall` 22/22, `recallEmpty` 4/4, `queue` 17/17, `historySearch` 11/11, `pnpm typecheck`, `pnpm build`, `git diff --check`/`show --check`, clean tree, and AGENTS.md size 29,618 bytes < 32 KiB; the one full-`pnpm test` failure was the documented pre-existing `verify-subagent-heartbeats` timing flake, which passed 21/21 in isolation immediately after and also flaked at the pre-batch HEAD.

### Notes / blockers / abandonment reason

The kill chords Ctrl+K/Ctrl+U (`killToRowEdge`, `src/tui/App.tsx:1972–1980`) and Ctrl+W (`deleteWordBefore`, `src/tui/App.tsx:1982`) destroy draft text with no recovery — no undo primitive exists anywhere in `src/tui/` — while the codebase already trusts snapshot-restore for modal flows (`src/tui/prompt-history-search.ts` snapshots draft/cursor on Ctrl+R and restores on Escape). Add a small capped stack (e.g. 16) of `{text, cursor}` snapshots owned by the editor state: push before each destructive chord (kill/word-delete; optionally coalesced typing bursts, but destructive chords are the requirement), pop on Ctrl+_ (with the common Ctrl+- terminal alias) restoring text and cursor exactly. Clear the stack whenever the draft leaves the editor's ownership — submit, queue enqueue, queue take-back replacing the draft, recall/search acceptance, `/clear` — so undo can never resurrect a prompt that was already sent or recorded. Modal ownership is unchanged: permission, completion menu, compaction, history/rewind search keep their keys, and recall/search Escape restoration keeps its own snapshots. No persistence, no new frame row (an optional bounded transient notice may reuse an existing surface), no trajectory involvement. Verify with editor unit checks (destroy-then-undo identity, cap eviction, clear-on-submit/queue/clear) plus a free pty scenario: type, Ctrl+U, Ctrl+_ restores exactly; disabled paths byte-identical.
napshot-restore for modal flows (`src/tui/prompt-history-search.ts` snapshots draft/cursor on Ctrl+R and restores on Escape). Add a small capped stack (e.g. 16) of `{text, cursor}` snapshots owned by the editor state: push before each destructive chord (kill/word-delete; optionally coalesced typing bursts, but destructive chords are the requirement), pop on Ctrl+_ (with the common Ctrl+- terminal alias) restoring text and cursor exactly. Clear the stack whenever the draft leaves the editor's ownership — submit, queue enqueue, queue take-back replacing the draft, recall/search acceptance, `/clear` — so undo can never resurrect a prompt that was already sent or recorded. Modal ownership is unchanged: permission, completion menu, compaction, history/rewind search keep their keys, and recall/search Escape restoration keeps its own snapshots. No persistence, no new frame row (an optional bounded transient notice may reuse an existing surface), no trajectory involvement. Verify with editor unit checks (destroy-then-undo identity, cap eviction, clear-on-submit/queue/clear) plus a free pty scenario: type, Ctrl+U, Ctrl+_ restores exactly; disabled paths byte-identical.

## SER-045 — Add a parent-only `workflow` tool: a bounded declarative DAG of subagent tasks executed by the SDK `Graph` orchestrator, with each node built by the existing subagent child recipe and only bounded terminus reports returned to the parent

- Status: `done`
- Priority: 63
- Score: 9
- Importance: 4
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 4
- Risk: 3
- Origin report: [`research_2026-08-30.md`](../research_2026-08-30.md) (run `08:21:38Z`, `sdk` path, `path-source: override (user-directed)`)

### Implementation / acceptance evidence

Accepted 2026-08-30 in `cbd2863` (task archive `94d63a9`, journal `109a956`; child session `session-20260830-083601272`; managed task `bg-ef70bc59-8467-4efb-8208-c606857695e0`, succeeded, exit 0). `src/agents/child-recipe.ts` extracts the shared child-construction recipe consumed by both `SubagentTool` (behavior unchanged) and the new parent-only `src/agents/workflow-tool.ts` (data-only DAG, `MAX_WORKFLOW_NODES = 8` / `MAX_WORKFLOW_EDGES = 28`, Kahn cycle refusal and bounded validation errors before any dispatch/model/child exists, SDK `Graph` execution with `maxSteps = nodeCount` and the parent cancel signal into `graph.invoke`, terminus-only result); registered in `runtime.ts` after the child-catalogue capture, classified `read` in `permission.ts` on the `subagent` precedent. Host independently passed `pnpm typecheck`, full `pnpm test` (exit 0), `spike/verify-workflow-tool.ts` in isolation (32/32), `pnpm build`, `git diff --check`/`git show --check`, and AGENTS.md 30,278 bytes < 32 KiB; details in `docs/iteration-log.md` Batch 67. Documented accepted deviation: no whole-graph `timeout` knob — bounded by node cap, `maxSteps`, and cancellation, matching every other delegation path.

### Notes / blockers / abandonment reason

User-directed: give darwin a Claude Code–style workflow capability (S3, `code.claude.com/docs/en/workflows.md`: orchestration held by an artifact, intermediate results flowing worker-to-worker) built on the Strands SDK `Graph` multi-agent pattern the repo does not use today (no SDK `multiagent/` import anywhere in `src/`). Shape: one new parent-only tool `workflow` whose input is **data, never code** — a bounded DAG `{ nodes: [{ id, agent?, task }], edges: [[source, target]] }` (cap nodes ≤ 8, validate unknown agent names, duplicate/unknown node ids, cycles, over-cap counts with bounded error strings). Execution is the SDK `Graph` (`node_modules/@strands-agents/sdk/dist/src/multiagent/graph.d.ts`): declarative `{nodes, edges}` constructor, AND-semantics dependency scheduling, dependency-merged node inputs (upstream final reports become downstream input without round-tripping through the parent context), bounded `maxConcurrency`, whole-graph `timeout`, and `MultiAgentInvokeOptions.cancelSignal` wired to the parent tool context's cancel signal. Each node is a fresh child built by the exact recipe `SubagentTool.run` uses today (`src/agents/subagent-tool.ts:140–222`: model snapshot, `composeSystemPrompt`, per-definition tool filtering, shared permission intervention with `source` provenance, dispatch-registry heartbeats + targeted `/agents cancel`, codex-hook fork, max-tokens recovery, bash-session reaping) — extract that recipe into a shared factory rather than duplicating it, with `SubagentTool` behavior unchanged. Only bounded terminus content (`_resolveContent`) returns as the tool result; child transcripts stay private; no trajectory record of child events (existing subagent invariant). The tool description must state the reads-parallel/writes-serialized rule: concurrent nodes share one working tree, so parallel branches are for reads and writes are serialized by edges. Parent-only like `update_plan` — never in child catalogues. Verify with a free stub-model suite `spike/verify-workflow-tool.ts` in `pnpm test`: validation refusals; diamond-DAG dependency order with upstream reports visible in downstream input; dispatch registration per node; bounded terminus-only result; cancellation aborting unstarted nodes; existing `verify-subagent-heartbeats.ts` green.
