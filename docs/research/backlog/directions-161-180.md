# Darwin self-evolution backlog — priorities 161–180

This page is routed by [`backlog_index.md`](../backlog_index.md). Direction records are ordered by ascending **Priority**; edit a record only under the mutation rules in that index.

## SER-121 — Parent-visible subagent reports omit child reasoning blocks

- Status: `done`
- Priority: 161
- Score: 14
- Importance: 4
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-10.md`](../research_2026-10-10.md) (run `05:32:26Z`)

### Implementation / acceptance evidence

Accepted 2026-10-10 at `ad96efcd2afe6d7a577b1d128a300fbca0f5adfe`. Child session `session-20261010-080517770`, task `bg-3d8c0618-ccb5-421a-bc35-2cb1a7e38ce2`, exit 0. Host gate `bg-dbac56f0-f70b-49a9-ada1-c501ba909e86`, exit 0: child-result-text 30/0, report-projection 49/0, failed-child-text 43/0, subagents 88/0, workflow 38/0, typecheck, full tests, build, no FAIL lines, clean tree. See `docs/iteration-log.md` Batch 174.

### Notes / blockers / abandonment reason

`SubagentTool` turns a successful child into the parent tool result with `projectChildReport(withRetainedMaxTokensText(result.toString(), …))`. Installed `@strands-agents/sdk@1.18.0` `AgentResult.toString` appends every `reasoningBlock` as a `💭 Reasoning:` section ahead of or beside the answer. That text enters parent context. `docs/architecture/sub-agents.md` (Context and result isolation) and `docs/user-guide/development.md` already name the leak and place the fix in `SubagentTool`: the trajectory must record what the parent actually received, not a second hidden copy.

The failure path already refuses this. `failed-child-text.ts` `textOf` keeps `textBlock` text only. `workflow-tool.ts` `terminusText` does the same. The exception is `withRetainedResult`, which rewrites via `toString()` when max-tokens partials are retained and can therefore fold reasoning into a text block that `terminusText` will later keep.

Build the success report from assistant `textBlock` text plus `citationsBlock` text, in block order, joined the way `toString` joins parts, then run the existing max-tokens retention and `projectChildReport` unchanged. Do not delete or rewrite lines inside `projectChildReport`: its contract is that a clean report is byte-identical and imitation lines are escaped, never removed. A reasoning-only result becomes the same empty string a text-less result already becomes; do not invent a substitute sentence. Apply the same extraction inside `withRetainedResult` so a retained partial cannot reintroduce reasoning. Do not change dispatch records, heartbeats, the failure wrapper, or child transcripts.

Acceptance: a fixture result with a reasoning block and a text block yields only the text at the subagent success seam and at the workflow rewrite seam; citation text is kept; a clean text report is unchanged by `projectChildReport`; reasoning-only is empty. Existing `verify-report-projection`, `verify-failed-child-text` and subagent/workflow suites stay green. `pnpm typecheck`, `pnpm test`, `pnpm build`. Update the subagent architecture sentence and the known-limitation line so they describe the new behavior. No SDK patch and no new dependency.

## SER-122 — Upgrade the pinned Strands SDK to 1.20.0 while preserving Darwin's patched contracts and MCP compatibility

- Status: `done`
- Priority: 162
- Score: 12
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 4
- Origin report: [`research_2026-10-10.md`](../research_2026-10-10.md) (run `13:46:11Z`)

### Implementation / acceptance evidence

Accepted commit `47eb4bfba683313e551f70ee701218c7bb2a2b78` after Host diff review against `1be7b50ca1e4ac47008b5fd249e2b87d18aa39cc` (only the child commit intervened). Installed/manifest/workspace/lock pin is 1.20.0. Rebased 19-file patch becomes 18: upstream summary conversion and cache-write mapping replace duplicates; SER-101 provenance and other required patches retained. MCP 2.x OAuth issuer, bounded prompt pagination/timeouts and SDK management-get background delivery adapted without changing policy. Host task `bg-58f827b0-9ef0-472b-9e36-c30d48a56db4` exited 0: `pnpm typecheck`, all 167 registered `pnpm test` suites, `pnpm tsx spike/verify-npm-package.ts` (49/0), free TUI `completion` (82/0), `model` (17/0), `mode` (25/0), `clear` (19/0), `mcp` (14/0), `resume` (19/0), `rewind` (9/0), `modelRetry` (8/0), `pnpm build`, `git diff --check`, clean status and built CLI `darwin 0.0.48`. Child `session-20261010-142039103`; supervision Batch 175 in `docs/iteration-log.md`. No live-provider tests; that remains a stated risk.

### Notes / blockers / abandonment reason

User explicitly requested latest SDK. Official [1.20.0 release](https://github.com/strands-agents/harness-sdk/releases/tag/typescript%2Fv1.20.0) published 2026-10-08; npm latest confirmed 2026-10-10. See report S1–S3/R1–R5. Upgrade `patches/@strands-agents__sdk@1.18.0.patch` to the target version with the existing pnpm patch workflow; preserve still-needed fixes and new upstream behavior. Review SER-101 provenance hunks against upstream before porting; do not duplicate a shipped equivalent. SDK MCP client 2.x is a compatibility risk requiring explicit verification. `pnpm build` regenerates `dist/patches/`. Respect `minimumReleaseAge`; wait if held, never bypass. No automatic migration to experimental contextManager, vended subagent/router or Agent.shutdown. Dependency first: SER-123 follows this accepted upgrade. Its private owner casts remain untouched and its premise remains valid. No blocker remains.

## SER-123 — Adopt the SDK public MCP tool owner accessor in CodeGraph and web-search wrappers

- Status: `done`
- Priority: 163
- Score: 12
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-10.md`](../research_2026-10-10.md) (run `13:46:11Z`)

### Implementation / acceptance evidence

Accepted `26a947bb5237e0be00c3d642a242373d82db2fc1` after diff review against `38ac3d31a22d30d42723d5fa991ea83c3b27a60a` (only this child commit intervened). First implementation failed Host typecheck because SDK 1.20 does not export the McpTool constructor; one focused same-session correction inferred its type from public `McpClient.listTools`, guarded by existing exact-client registry membership, then read the public getter. No deep import or patch. Host second acceptance `bg-e51233eb-ee7c-4210-a325-b7a74c75fa0d` exited 0: CodeGraph suite 25/0, web-search suite 18/0, typecheck, full 167-suite test gate, build, built-wrapper imports, built CLI, diff check and clean tree. Negative controls prove non-MCP lookalike getters unread, foreign owners unchanged, no extra discovery, repeat/refresh stability, parent/child denial and unchanged bytes/events. Child `session-20261010-155414907`; complete tasks/spend recorded in iteration-log Batch 176.

### Notes / blockers / abandonment reason

Depends on accepted SER-122. Upstream [PR #4863](https://github.com/strands-agents/harness-sdk/pull/4863) exposes a read-only getter for the original client without connecting. At research time, `src/mcp/codegraph-preflight.ts` and `src/mcp/web-search-empty-results.ts` used `mcpOwner` with `as unknown as { mcpClient?: unknown }`; this is the exact cast upstream replaced. Preserve existing wrapper behavior, streaming bytes/events, permission gates, parent/child and refresh lifecycle; do not widen server matching or introduce discovery. Follow the two load-bearing architecture sections. No product UX change is intended. Accepted implementation updates those sections only; README and bilingual user guides remain accurate. The pre-existing private server-name map and refresh seam remain version-sensitive, intentionally outside this direction. No blocker remains.

## SER-124 — Add Ctrl+X Ctrl+E as a composer alias for the existing Ctrl+G external editor

- Status: `done`
- Priority: 164
- Score: 10
- Importance: 2
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-11.md`](../research_2026-10-11.md) (run `06:17:14Z`)

### Implementation / acceptance evidence

Starting gate: clean source revision `71efa11cc279f45f3b0afe0dab91fec244055416` plus research-only commit `26fa7c166af968d53712d31e7c6ac915cd053521`; Host `pnpm typecheck && pnpm test` passed in `bg-f5ed2fd6-c4c0-4661-a936-8b977e0ec461` (exit 0). Research metadata separately passed `pnpm exec tsx spike/verify-skills.ts` (163/0). No source changed during that gate.

Accepted commit **`3f1e9b0016e3eedf6e3a544ae1dc7ce7c9636c86`** from fresh child **`session-20261011-063935064`**, managed task **`bg-36a662ff-3953-4fd7-ae47-bea2b70c5b55`** (exit 0, fully drained; no correction/retry). The explicit base/result range contains only the child commit. Host independently reviewed all 12 changed files and accepted `bg-c5c031ea-b634-4977-9319-1ea9a28d8ca1` (exit 0): `pnpm typecheck`, full `pnpm test` (167 registered suites, including expanded real-editor pty and input/help/security regressions), `pnpm exec tsx spike/verify-tui.ts completion` (82/0), `pnpm build`, diff check and clean status. Built CLI separately reports 0.0.49. Both README languages, English/Chinese narrative/reference guides, `/help` and existing editor architecture rationale are synchronized. No dependency, SDK patch, permission change or new submission path. Supervision and exact spend are recorded in `docs/iteration-log.md` **Batch 177**. No remaining blocker.

Sources S1 (Claude Code) and S9 (Aider) document the readline editor chord. At `71efa11`, `src/tui/App.tsx` calls `openExternalEditor` only for Ctrl+G; the final key filter ignores Ctrl+X, and bare Ctrl+E moves to row end. Existing behavior and safety contracts are in `docs/architecture/load-bearing-decisions.md` § Ctrl+G external editor and `spike/verify-external-editor{,-pty}.ts`.

Acceptance: a real production-CLI pty must prove separate and combined Ctrl+X/Ctrl+E input invokes exactly the existing callback once, preserves the exact multiline draft, returns edits unsent, and generates no prompt/model request before explicit Enter. Ctrl+X alone is inert; a different intervening key disarms it and behaves normally; repeated Ctrl+X may re-arm. Invalidate on paste, permission/search/compaction ownership, submission/queueing, session replacement and editor handoff; never arm under a higher-priority owner. Retain every Ctrl+G eligibility/failure/privacy bound, including current busy/queue/peer/goal/delegation checks. Bare Ctrl+E remains row-end. No timer or new frame row. Run focused editor/input/help suites, free `tui completion`, `pnpm typecheck`, full `pnpm test`, and Host `pnpm build`; synchronize `/help`, both README/user-guide languages and the existing architecture rationale.

### Notes / blockers / abandonment reason

Modest ergonomic value, exact primary-source and code evidence, and high fit through a shared callback give `2×2+5+5−2−2 = 10`, above the gate without changing ratings. Depends only on shipped SER-113; no new batch dependency. This is not a second editor implementation, shell launcher, quote injector, auto-submit path, new slash command, generalized keybinding system or SDK patch. Host owns research/backlog/log and final push; implementation remains inside one fresh `developer` child session.

## SER-125 — Add a user-only bounded local Git diff viewer without sending changes to the model

- Status: `not-started`
- Priority: 165
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-10-11.md`](../research_2026-10-11.md) (run `07:36:52Z`)

### Implementation / acceptance evidence

Not implemented. Acceptance is defined in the origin report's Recommendation: independently inspect the base/result diff; run real-Git/helper-sentinel/byte-preservation and production-CLI pty checks, `pnpm typecheck`, `pnpm test`, free `tui completion`, and `pnpm build`.

### Notes / blockers / abandonment reason

P2 (Codex) and P7 (Aider) document local diff inspection. Darwin's canonical command list has no `diff`; `fileEditorDiff` displays tool input, `/review` makes a model turn, and `!git diff` feeds its output into the next prompt. Add TUI-only idle `/diff` (tracked worktree versus index) and `/diff --staged` (index versus HEAD, unborn supported), exact grammar with local usage for all other arguments. Always label scope and exclude/state untracked and submodule contents. One bounded Static notice, no model/tool/trajectory/prompt-history/shell-report effect or workspace/session mutation. Busy refuses locally; preserve modal ownership and cancel/exit/replacement cleanup. Fixed argv/cwd, no shell/pager/color/external diff/textconv/fsmonitor helper/submodule recursion; cap output/time and sanitize terminal controls. Errors and truncation must be honest. Use the report's complete requirements, tests and authorization boundary; do not alter tool-input diffs or `/review`. Score 10 clears the gate; no new-direction dependency. Host owns research/backlog/log and push; implementation must use a fresh developer child.
