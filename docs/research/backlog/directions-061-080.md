# Darwin self-evolution backlog — priorities 061–080

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-043 — Add a config-gated terminal attention bell: one BEL when a permission prompt is published and one when a turn completes, emitted at the existing driver lifecycle points, never inside the Ink frame, off by default

- Status: `done`
- Priority: 61
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-08-28.md`](../research_2026-08-28.md) (run `13:03:31Z`, rolled `tui` path)

### Implementation / acceptance evidence

Accepted 2026-08-28 in `94909b8` (task archive `e8376df`, journal `8c379cf`); Host acceptance recorded in `docs/iteration-log.md` Batch 65 (`verify-terminal-bell.ts` 14/14, `verify-config.ts` 248/248, `pnpm typecheck`, full `pnpm test` exit 0, `pnpm build`, grep proof that `terminal-bell.ts` is the sole BEL writer). Record repair 2026-08-30: the acceptance commit `6407864` said "SER-043 closes on independent Host acceptance" but only flipped SER-044 to `in-progress`, leaving this record's status line stale at `in-progress`; this run set it to `done` to match the recorded acceptance. Second record repair 2026-08-31: the 2026-08-30 repair commit `e5a8773` claimed to set `done` but actually wrote `not-started`; this run set the status line to `done` — the acceptance evidence above is unchanged and remains authoritative.

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

## SRF-019 — Stop trimming `memory_save` quote fields and make evidence rejection reasons specific

- Status: `done`
- Priority: 64
- Score: 15
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 1
- Origin report: [`reflection_2026-08-31_session-20260831-011450426.md`](../../reflections/reflection_2026-08-31_session-20260831-011450426.md)

### Implementation / acceptance evidence

Accepted 2026-08-31 in `f6d750a` (task archive `e95a15d`; child session `session-20260831-031847766`; managed tasks `bg-789ac43e` transient-provider-failed, retry `bg-7dd4296b` succeeded, exit 0). `src/memory/tools.ts` adds `boundedUntrimmed(max)` (min-1 + code-point cap, no `.trim()`) applied only to `evidence.quote` (4000) and `userQuote` (500); `resolveExactSourceAnchor` returns `SourceAnchorResolution` with a closed six-reason failure set (`quote-not-one-line`/`unsafe-path`/`oversized-source`/`unreadable-source`/`no-matching-line`/`multiple-matching-lines`), safety checks order- and effect-identical; the controller maps each reason to its own message and the post-resolve `validateAnchor` re-check gets a distinct message. Host independently re-ran `verify-memory-validation.ts` 20/20, `verify-memory-tools.ts` 15/15, `pnpm typecheck`, full `pnpm test` (zero FAIL lines), `pnpm build`, plus a direct probe: the indented `src/memory/tools.ts` line 17 anchors `{ok:true, line:17}` while its trimmed variant and an absent line both return `{ok:false, failure:'no-matching-line'}`. Host acceptance recorded in `docs/iteration-log.md` Batch 68.

### Notes / blockers / abandonment reason

In session-20260831-011450426 (harbor project) the agent staged a `root_cause` memory with `evidence.quote` byte-identical to line 11 of `adapters/darwin-swe-bench/pyproject.toml` — verified in-session with `cat -A` (seq 351–352) — and was rejected twice with "memory evidence must be one unique exact current project line" (seq 343/345, 347/348), then spent ~2 minutes phantom-chasing and told the user a wrong hypothesis (seq 355). Root cause: `src/memory/tools.ts:10` applies `z.string().trim()` to every bounded field including `evidence.quote`, while `resolveExactSourceAnchor` (`src/memory/validation.ts`) requires the quote to equal a full source line — so the trim strips leading indentation and every indented project line (most code lines) can never validate. Reproduced both ways against the same dist code and file: untrimmed quote anchors and validates, trimmed quote resolves to no anchor. Fix inside the existing modules: give `evidence.quote` and `userQuote` a bounded-but-untrimmed schema (length/emptiness checks preserved, exact-line validation still gates every save, so nothing widens), and split the controller's single rejection message into reason-specific errors (no matching line vs. multiple matches vs. unreadable file) so an exact-evidence failure is diagnosable. Verify in `verify-memory-tools.ts`/`verify-memory-validation.ts`: an indented unique line saves and commits after `endTurn`; an unindented non-line quote still fails, now with the no-matching-line reason; multi-match and oversized/unsafe paths keep their existing refusals; `pnpm typecheck` and full `pnpm test` stay green.

## SER-046 — State the shipped composer word chords and undo in `/help` and the README input documentation, as a pure projection of fixed local facts

- Status: `in-progress`
- Priority: 65
- Score: 14
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 1
- Risk: 1
- Origin report: [`research_2026-09-01.md`](../research_2026-09-01.md) (run `14:47:59Z`, rolled `tui` path)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

`/help` is Darwin's canonical bounded local discoverability surface, but its "editing and session:" block in `src/tui/help-format.ts` names only `Home/End or Ctrl+A/E`, `Ctrl+K/U`, `Ctrl+W`, `Ctrl+B`, `Ctrl+C` and `Ctrl+D`. Two shipped, spec-documented editing features are missing from it: SER-042's word chords — Alt/Ctrl+Arrow word jumps (`src/tui/App.tsx:2192`), Alt+B/F (`:2074`), Alt+D (`:2083`), Alt+Backspace (`:2243`) — and SER-044's composer undo on Ctrl+_ / Ctrl+- / byte 0x1f (`:2040`). `spike/verify-help-command.ts:55–56` pins exactly the stale subset, so the omission is invisible to the suite. `README.md:104` / `README.zh-CN.md:104` are the only `Ctrl+` mentions in either README and cover Ctrl+R alone; SER-030 already established that correcting stale README input documentation belongs to this surface. Fix strictly inside the existing projection: add the missing lines to `formatHelpReport()` (staying under `MAX_HELP_LINES` / `MAX_HELP_LINE_CODE_POINTS`, and re-checking the bound arithmetic rather than assuming headroom), and mirror the same chords in both READMEs' input sections. No new command, config key, runtime behavior, live-frame row or information channel; `/help` must remain argument-rejecting, handled before busy queueing, and free of model/tool/network work. Acceptance: extend `spike/verify-help-command.ts` to assert the word-chord and undo lines plus the unchanged bounds, keep `spike/verify-tui.ts completion` green, prove README wording names the same chords as `help-format.ts`, and keep `pnpm typecheck` plus the full `pnpm test` green.

## SER-047 — Extend the markdown answer projection's block vocabulary: classify list markers, blockquote prefixes and table pipes as dimmed marker spans, keeping every character

- Status: `not-started`
- Priority: 66
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 4
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-09-01.md`](../research_2026-09-01.md) (run `14:47:59Z`, rolled `tui` path)

### Implementation / acceptance evidence

Not started.

### Notes / blockers / abandonment reason

`MarkdownLineKind` in `src/tui/markdown.ts:34` is `'text' | 'heading' | 'fence' | 'code' | 'rule'`, so every bullet, ordered-list item, blockquote and table row falls through to prose `inlineSpans` at `:88` — and `inlineSpans` deliberately keeps a bullet `* item` line plain (`:117–121`) to protect snake_case and multiplication from emphasis styling. The result is that structured answers, the common shape of Darwin's own output, render as undifferentiated prose while headings and code already carry tone. The extension point exists: add block kinds whose leading marker (`-`/`*`/`+`, `N.`/`N)`, `> `, and a table row's `|` separators) becomes a `marker` span and whose remaining text keeps ordinary inline spans, then give the new kinds tone in `spanProps`/`rowToneProps` in `src/tui/MarkdownText.tsx`. The projection contract is the hard constraint (`.trellis/spec/frontend/live-frame.md:428`): every character survives, markers are dimmed in place and never stripped or realigned, so ANSI-stripped output is byte-identical to the committed text, `/export` stays byte-identical, and pty substring assertions keep matching. Two ordering hazards to respect — the existing `RULE` classification of `---`/`***`/`___` must still win over a list marker, and the fence/code branch must still win over everything, so `fenceOpenAfter` stays a boolean and live rows keep agreeing with `<Static>`. Out of scope: reflowing or re-indenting list text, renumbering ordered lists, aligning table columns, and any per-language code highlighting (explicitly out of scope at `src/tui/markdown.ts:20`). Acceptance: `spike/verify-markdown.tsx` asserts the new classifications *and* that concatenated spans equal the input line for every case (including a bullet inside a fenced block, a `---` rule, and a `1.` item), `spike/verify-visual-language.tsx` green, an `/export` byte-identity check over an answer containing lists/quotes/tables, plus `pnpm typecheck` and the full `pnpm test` green.
