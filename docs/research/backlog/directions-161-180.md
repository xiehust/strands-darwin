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

- Status: `done`
- Priority: 165
- Score: 10
- Importance: 3
- Architecture fit: 4
- Evidence confidence: 5
- Difficulty: 3
- Risk: 2
- Origin report: [`research_2026-10-11.md`](../research_2026-10-11.md) (run `07:36:52Z`)

### Implementation / acceptance evidence

Accepted `2a8d34caf71147354f302c9369a276c26c443351` after Host inspection of the full 16-file diff against base `e42ec39868ca162ebd664b0d4008dd6333155b65`; no other writer committed in that range. Fresh child `session-20261011-080210438`, managed task `bg-e2d742c8-eb75-47b4-aae3-05ae2b3c2e7f`, exited 0 and was fully drained. Host acceptance `bg-9bd1f8ef-d9c9-4378-a1c6-0757e6ccfbfa` exited 0: `pnpm typecheck`, full `pnpm test` (169 registered suites, including both new real-Git and production-CLI pty suites), `pnpm exec tsx spike/verify-tui.ts completion` (83 passed, zero failed), `pnpm build`, diff/clean checks, and built CLI version 0.0.49. Host verified grammar/scopes, hostile helper sentinels, byte preservation, bounds/failures/cancellation and local-only TUI ownership/privacy through those suites. Both README languages, English/Chinese narrative/reference guides and architecture rationale are synchronized. `docs/iteration-log.md`, Batch 178, holds the supervision/spend record.

Safety refinement: a bounded read-only config preflight conservatively refuses configured clean/process filters and promisor/partial-clone repositories, even unused, because ordinary no-external-diff/textconv switches do not prevent those helpers/fetches. This preserves the requirement rather than bypassing it. Untracked/submodule contents remain excluded; limits are 5 seconds, 64 KiB capture, 200 display lines and 500 code points per line. Concurrent external changes are not an atomic snapshot; verification was on Linux. Child had one existing permission-preview pty exit timeout, then passed that unchanged suite and a full retry; Host acceptance passed once without corrections.

### Notes / blockers / abandonment reason

P2 (Codex) and P7 (Aider) document local diff inspection. At the research baseline, Darwin's canonical command list had no `diff`; `fileEditorDiff` displays tool input, `/review` makes a model turn, and `!git diff` feeds its output into the next prompt. Add TUI-only idle `/diff` (tracked worktree versus index) and `/diff --staged` (index versus HEAD, unborn supported), exact grammar with local usage for all other arguments. Always label scope and exclude/state untracked and submodule contents. One bounded Static notice, no model/tool/trajectory/prompt-history/shell-report effect or workspace/session mutation. Busy refuses locally; preserve modal ownership and cancel/exit/replacement cleanup. Fixed argv/cwd, no shell/pager/color/external diff/textconv/fsmonitor helper/submodule recursion; cap output/time and sanitize terminal controls. Errors and truncation must be honest. Use the report's complete requirements, tests and authorization boundary; do not alter tool-input diffs or `/review`. Score 10 clears the gate; no new-direction dependency. Host owns research/backlog/log and push; implementation must use a fresh developer child.


## SER-126 — Add an explicit base-commit merge-base review scope through the existing pure review prompt

- Status: `done`
- Priority: 166
- Score: 13
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 1
- Origin report: [`research_2026-10-13.md`](../research_2026-10-13.md) (run `14:46:08Z`)

### Implementation / acceptance evidence

Accepted `fc7bb821c5b507166576e66dd627bf63cf051d15` (`feat(review): add merge-base prompt scope`) after Host inspection of the explicit 14-file diff from `dd3948124bd7b03479508ebff2b51d0804c7f8b9`; no foreign commits. Fresh child `session-20261013-151220347`, task `bg-c51e8699-bc89-459b-a290-b0df7b99f9f4`, exited 0 and was fully drained. No correction/retry.

Host acceptance task `bg-3f3756c3-e709-4aff-bac4-f53c7bdb6f28` exited 0: `pnpm typecheck`; full `pnpm test`, including `verify-review-command.ts` (283 passed, 0 failed) and `verify-review-drivers.ts` (33 passed, 0 failed); `pnpm exec tsx spike/verify-tui.ts completion` (83 passed, 0 failed); `pnpm build`; diff check, clean-tree check and exact-HEAD check. Built CLI reports 0.0.52. Both READMEs, English/Chinese narrative and reference guides, and architecture review paragraphs are synchronized in the accepted commit. Checks prove parser/prompt/transport/gate contracts, not live model review accuracy. Full supervision receipt and spend: `docs/iteration-log.md`, Batch 179.

### Notes / blockers / abandonment reason

P3 (Codex official CLI review scopes) documents merge-base branch review. `src/commands/review-command.ts::parseReviewCommand` currently recognizes only full-SHA `--commit`; a leading `--base` becomes literal focus on the working-tree prompt. Add `/review --base <40-hex-SHA>` for the unique merge-base-to-HEAD committed diff, without Git execution during expansion. Preserve existing bare/focus/commit bytes and commit-only usage. Malformed base forms return base-specific local usage in every driver before queue/model work; valid forms retain ordinary queue/image ownership and literal trajectory. Prompt names resolved object identities, excludes dirty/untracked changes, handles missing/unrelated/ambiguous/empty scopes honestly, and asks for no fetch/checkout/edit/commit. It remains guidance, not enforced read-only. No new tools, modes, dependencies, config or loop. Full requirements, test matrix, docs and authorization are in the report. Score 13 clears gate 6; no new-direction dependency. Host owns research/backlog/log and push; use a fresh developer child.

## SER-127 — Upgrade the pinned Strands SDK to 1.21.0 while preserving Darwin's patched contracts and runtime defaults

- Status: `done`
- Priority: 167
- Score: 12
- Importance: 5
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 4
- Risk: 4
- Origin report: [`research_2026-10-19.md`](../research_2026-10-19.md) (run `03:29:56Z`)

### Implementation / acceptance evidence

Accepted commits: `2e99b2a2b99301838bb77b9a44f42ccee35ea014` (SDK 1.21.0, required Zod peer range, patch rebase, regression coverage and current docs) and `f4a849b2b0af40c9d9f2e09ba297397061682e30` (live compaction fixture correction). Fresh child `session-20261019-040627597`; managed initial task `bg-489f8da9-ace3-4264-b3ea-3de989024591` and one focused correction `bg-daf99d4d-90f6-412f-bdff-c597b4080348`, both exit 0 and fully drained. Host reviewed explicit base `e31f527ef10209197f441bf31eff043969507844` to both result commits; no intervening writer. Independent comparison proves all 54 hunks/18 patched files retain the same 1,150 added/removed lines.

Host acceptance: `bg-16839289-595b-4045-a4c2-f423f572a8b6` passed `pnpm typecheck`, all 171 fast suites, real-registry `verify-npm-package.ts` (49/0) and build. `bg-7cd5e3cc-0727-4d8d-a8d6-c769d145eca2` passed live Responses reasoning (99/0), `tui bashExit` (3/0), `tui cancelThenContinue` (5/0), and the cancel-exit probe (exit 0). Initial acceptance withheld because live compaction had failed. Separate complete old/new SDK/provider diagnostics showed identical requests and `content_filtered` on the marker-only fixture, but successful 4-to-2 reduction on ordinary content. The correction changes only seed prompts/waits, not production behavior or the compaction success/input-ownership assertions. Host second acceptance `bg-2ea33632-e046-45e8-b900-03cdebab8229` passed corrected live `tui compacting` (5/0), `tui completion` (83/0), typecheck, all 171 fast suites, build, diff check and clean status. No waiver.

README languages, getting-started/development guide languages and architecture synced; reference behavior unchanged. Spend across both worker invocations: input 154, output 44,194, cacheRead 9,935,892, cacheWrite 348,697; exclusive sum 10,328,937, approximate USD 16.5059. Exact receipts and supervision milestones: `docs/iteration-log.md`, Batch 180; origin report outcome. Batch exhausted; no remaining unfinished direction.

### Notes / blockers / abandonment reason

The SDK-path release check found installed/pinned 1.20.0 and newest TypeScript SDK release [typescript/v1.21.0](https://github.com/strands-agents/harness-sdk/releases/tag/typescript%2Fv1.21.0), published 2026-10-14T20:07:44Z (accessed 2026-10-19). This is the batch's first and only accepted direction, not a re-opening of a prior version upgrade.

Update the exact SDK pin, lockfile and `pnpm-workspace.yaml`; rebase `patches/@strands-agents__sdk@1.20.0.patch` onto 1.21.0, retaining every local contract unless proven redundant upstream. The new patch is the source of truth; `pnpm build` regenerates `dist/patches/`. Honor pnpm's `minimumReleaseAge` without bypass. Preserve the current conversation manager, durable session-local offloader/legacy repair, child isolation, permission gate, provider reasoning/usage, shell/file-editor behavior and bounded MCP prompt requests. New SDK stash/model/tool APIs are not authorization to change defaults or broaden child access.

Acceptance: explicit base/result diff and patch inventory; `pnpm typecheck` + every `pnpm test` suite; all load-bearing rows citing the pinned SDK patch (focused checks outside the runner as applicable); `pnpm tsx spike/verify-npm-package.ts` against the registry; post-acceptance `pnpm build`. Record any unexecuted live check rather than claiming it. Keep README languages, relevant guide narrative/reference and architecture accurate. Origin report R1–R4 identifies source symbols, existing tests and scope. Implementation uses a fresh `developer` child; Host independently verifies, logs the session/checks/spend, and alone changes this status to `done`.


## SER-128 — Keep composer Up/Down coherent across batched terminal input by using the current draft and cursor for every move

- Status: `not-started`
- Priority: 168
- Score: 12
- Importance: 3
- Architecture fit: 5
- Evidence confidence: 5
- Difficulty: 2
- Risk: 2
- Origin report: [`research_2026-10-19.md`](../research_2026-10-19.md) (run `09:40:46Z`)

### Implementation / acceptance evidence

Not implemented. Host reproduced at `5f3240f4c5a20fdc368786bf5318c9f0ca08590b`: paste `aaa\nbbb\nccc\nddd`, then send Up+Up+`!` in one terminal write; the CLI inserts after `ccc`, not `bbb`. No model call occurs. Research report R2–R6 links source, existing tests and the offline PTY artifacts.

### Notes / blockers / abandonment reason

Requirement: make each ordinary composer Up/Down use the synchronous current editor value, not `App`'s render-captured `layout`. Reuse `layoutEditor`/`moveVertical`, preserve preferred-column behavior and grapheme/soft-wrap affinity, and keep existing precedence: permission/compaction/search owners, then completion, queue take-back, recall, ordinary movement. No new key, UI row, timer, send/queue behavior, SDK loop, dependency or config surface.

Acceptance: register an offline real-CLI PTY regression with repeated Up and Down in one write and exact insertion witnesses; cover mixed preceding cursor/text changes, multiline plus soft-wrapped Unicode at ordinary/narrow widths, preferred-column retention and no unintended model invocation. Verify neighboring completion/queue/recall/search/permission ownership using new or existing focused checks. Child and Host independently run `pnpm typecheck` + `pnpm test`; Host inspects explicit base/result diffs, reruns the focused reproduction, checks README/guide/architecture accuracy, and runs `pnpm build`. Each requirement gets a test in the child's checklist. Host alone closes status after acceptance and appends the supervision session, commit, checks and spend to `docs/iteration-log.md`.

No dependency on another new direction. Selection score remains 12 ≥ 6. Keep the implementation inside one fresh developer child; no Host implementation patching.
