# Journal - river (Part 1)

> AI development session journal
> Started: 2026-08-13

---



## Session 1: TUI coding agent MVP: grill-me 需求拷问到全量交付

**Date**: 2026-08-13
**Task**: TUI coding agent MVP: grill-me 需求拷问到全量交付
**Branch**: `main`

### Summary

grill-me 拷问收敛 MVP 范围后从零交付：Strands TS SDK + Ink 的 coding agent（vended 工具 + InterventionHandler 权限门 + .mcp.json MCP + 自建 Skills 插件 + --resume）。调研纠正两个假设（TS SDK 无 Skills 需自建；vended bash/fileEditor 免自建工具）。9 套实测套件 195 断言全过；验收与质量检查各抓出真 bug（bash 常驻 shell 拖死 /exit；Ctrl+C 后权限队列锁死；取消后模型 socket 泄漏需 unref 强退兜底=SDK abortSignal 缺口）。SDK 契约/错误处理/TUI pty 测试法已沉淀进 spec。遗留：HTTP MCP 未 live 实测、单行输入、会话前工作区文件未入库待用户确认。

### Git Commits

| Hash | Message |
|------|---------|
| `e579948` | (see git log) |
| `49652f7` | (see git log) |
| `18f083d` | (see git log) |

### Status

[OK] **Completed**


## Session 2: 改名 darwin：AGENTS.md 预加载 + .darwin/ 配置目录收敛

**Date**: 2026-08-13
**Task**: 改名 darwin：AGENTS.md 预加载 + .darwin/ 配置目录收敛
**Branch**: `main`

### Summary

CLI 改名 darwin，所有项目态相对运行目录解析：.darwin/{config.json,skills/,sessions/,mcp.json}（MCP 双路径只读一个不合并，回退根 .mcp.json 保留 Claude Code 复用）；新增 AGENTS.md 预加载（<project-instructions> 注入、StringDecoder 防 UTF-8 截断出 �、不可读与不存在区分并在 header 提示）。全套件 234 断言过（verify-agents-md 新增）。教训沉淀：改名类任务会让旧断言退化为永真（断言字符串须被测状态独占）。

### Git Commits

| Hash | Message |
|------|---------|
| `51b534e` | (see git log) |
| `03fc00b` | (see git log) |
| `592e955` | (see git log) |

### Status

[OK] **Completed**


## Session 3: Permission approval modes: default / auto / yolo

**Date**: 2026-08-14
**Task**: Permission approval modes: default / auto / yolo
**Branch**: `main`

### Summary

Redesigned the permission gate into three approval modes. default: whitelist-based static rules (reads, in-project non-sensitive writes, read-only bash segments) run silently, everything else prompts. auto: adds a Haiku-backed safety classifier (Model.streamAggregated one-shot, 5s timeout, fail-closed to prompting) for calls static rules cannot clear. yolo: never prompts. Config permissionMode/classifierModel, CLI --permission-mode/--yolo, TUI mode header + risk reasons. New spike/verify-permission-modes.ts in pnpm test; adapted pty scenarios (gated file moved outside project root, bashExit uses printf since echo is now safe) plus new safePassthrough; live classifier + step-1-2 suites green. Spec: error-handling degradation row, sdk-contracts streamAggregated one-shot pattern + versioned Haiku profile id caveat.

### Git Commits

| Hash | Message |
|------|---------|
| `67ce8b5` | (see git log) |

### Status

[OK] **Completed**


## Session 4: Bound the live frame so a long streamed answer cannot flicker

**Date**: 2026-08-17
**Task**: Bound the live frame so a long streamed answer cannot flicker
**Branch**: `main`

### Summary

A long streaming answer made the TUI strobe: Ink stops repainting in place once the live frame exceeds the viewport and instead writes a whole-screen clear (scrollback included) plus the entire transcript per render, bypassing its frame-rate cap. Measured with a new pty probe (43 clears for a 60-line answer in 24 rows, 0 when bounded). The in-flight answer is now the newest rows that fit, wrapped by darwin so the height is exact and drawn one truncated Text per row, with a notice for the rows that scrolled out; the assembled block still enters Static history whole. The row budget is measured from the header and the box below rather than assumed, which also required composing the prompt cursor position explicitly since box metrics are parent-relative. Verified by verify-live-text (28 pure assertions), a new verify-tui longAnswer scenario asserting no ESC[3J in raw pty bytes (and proven able to fail), the full 182-assertion TUI suite, and pnpm test.

### Git Commits

| Hash | Message |
|------|---------|
| `509de38` | (see git log) |
| `17446db` | (see git log) |

### Status

[OK] **Completed**


## Session 5: Make the whole live frame fit, and stream finished answer lines into scrollback

**Date**: 2026-08-17
**Task**: Make the whole live frame fit, and stream finished answer lines into scrollback
**Branch**: `main`

### Summary

Session summary was not supplied.

### Main Changes

### Summary

Round 2 of the live-frame work, as one parent with two children.

Round 1 bounded the streaming answer against a *measured* chrome height and closed with two items
recorded as out of scope. Measurement turned both into work. The chrome was unbounded too: in an
80x24 terminal a **13-row draft** already took Ink's `clearTerminal` branch and cost two
whole-screen clears (scrollback included) per further row, with nothing streaming at all — an idle
session being typed into — and one in-flight tool call with details expanded drew **41 terminal
rows** from caps that count logical lines and code points. The first probe written for this got the
measurement wrong in an instructive way: it grew the draft with `send("\n" + text)`, which is the
batched-Enter path, so it submitted the draft and spent a real model turn measuring nothing.

`live-frame-chrome` inverted the budget. Every participant now states the rows it wants and
`src/tui/frame-budget.ts` hands them out in a fixed priority order — prompt region, tool panel,
answer — with a share ceiling so the first served cannot take everything, and a `modal` exemption
for the permission box. Only the header is still measured; measuring the boxes being bounded is
what oscillates. Two Ink behaviours turned out to matter more than the arithmetic. Several `<Text>`
children of a `<Box>` are laid out as flex items and wrap *independently*, which made the
permission summary two rows tall and ate the `] ` after `[parent`; rows whose height must be known
are now one `<Text>` with nested spans. And the share ceiling starved the modal permission box
while the call it was asking about ran, cutting its last detail row — which is where
`… truncated N code points` lives, the line saying the value shown is not the whole value.

`stream-into-static` took the trade round 1 refused. Finished answer lines go to `<Static>` while
the turn runs, except the last non-blank one and any trailing blank lines, because the assembled
block is trimmed at the end and committing a trailing blank line made a clean answer report a
divergence. The close is a reconciliation against what was committed: a continuation writes the
remainder, a real disagreement is stated as a warning with the authoritative text in full. It is
*cheaper* than what it replaced — 30,675 bytes against 60,040 for a 120-line answer, because the
alternative redraws the whole tail on every delta.

Two PRD assumptions were wrong and are recorded as such. The divergence branch cannot be reached
through any ordinary model: the SDK's base `Model.streamAggregated` assembles the finished block
from the deltas it has just yielded, so it is exercised at the reducer rather than through a fake
provider. And "appears exactly once" cannot be asserted against accumulated pty output, since every
row that passed through the live tail was drawn once per repaint.

### Main Changes

- `src/tui/frame-budget.ts` (new): one shared row budget, priority order, share ceiling, `modal`
  exemption, and the per-participant plans; all pure.
- `InputBox` windows the draft around the cursor, `ActiveToolCalls` and `PermissionPrompt` draw
  pre-counted rows, and each states what it hides.
- `src/tui/turn-state.ts`: `commitFinishedLines`, `closeAnswer`, and `AnswerPart` deciding at push
  time which piece owns the `agent` label and which owns the blank row; `formatReplay` honours it.
- `.trellis/spec/frontend/live-frame.md` (new): both contracts, split out of `tui-testing.md`,
  which is injected as context and silently truncated past 32 KB.

### Testing

- `spike/verify-frame-budget.ts` (new, 51): the invariant over a matrix, plus `renderToString` of
  the real components — that is what caught the flex-layout rows.
- `spike/verify-stream-into-static.ts` (new, 58): commit timing, the shapes that must not change,
  the authoritative close, interruptions, and one offline `Agent`.
- New pty scenarios `tallDraft` (free) and `tallDraftStreaming`; `longAnswer` now asserts
  progressive visibility and moves its scrolled-out-notice assertion onto an unbroken paragraph.
- Shown able to fail: unbounding the draft turns `tallDraft`'s 8 passes into 4 failures.
- `pnpm typecheck`, `pnpm test` (1813), the full `verify-tui.ts` suite, both probe modes.

### Next Steps

- Follow-up landed the same day: `approve` was flaky three different ways, all of them the scenario
  asserting something about the *model* rather than about darwin. An unanswered second permission
  box now gets drained by the teardown (`settleTurn`, proven by a new `drainPrompt` scenario that
  leaves a box unanswered on purpose); the wait on a 170-character path was self-fulfilling — it
  waited for the string it then asserted, and the path never appears contiguously because Ink breaks
  it — so it waits on a short anchor and compares with the wrap removed; and the disk check no
  longer demands the model transcribe 620 identical characters exactly, but asserts the edit was
  applied in place with nothing else touched. Full suite after all three: 24 scenarios, 202
  assertions, green. All three shapes are written up in `frontend/tui-testing.md`.


### Git Commits

| Hash | Message |
|------|---------|
| `898ad46` | (see git log) |
| `c21cd09` | (see git log) |
| `a5f4b2a` | (see git log) |
| `901283d` | (see git log) |
| `9e487a1` | (see git log) |

### Status

[OK] **Completed**


## Session 6: Implement SER-031 distilled project memory

**Date**: 2026-08-22
**Task**: Implement SER-031 distilled project memory
**Branch**: `main`

### Summary

Added opt-in bounded project-scoped Markdown memory derived asynchronously from eligible durable trajectory turns, with secret filtering, provenance, prompt integration, specs, and offline verification.

### Git Commits

| Hash | Message |
|------|---------|
| `73bc11b` | (see git log) |

### Status

[OK] **Completed**


## Session 7: SER-032 local memory management

**Date**: 2026-08-22
**Task**: SER-032 local memory management
**Branch**: `main`

### Summary

Added bounded local /memory list/show/remember/forget controls, strict project-scoped memory state with durable generated-entry suppression, synchronous live prompt refresh, offline verification, and architecture/spec documentation.

### Git Commits

| Hash | Message |
|------|---------|
| `06873a5` | (see git log) |

### Status

[OK] **Completed**


## Session 8: SER-033 generated memory validation

**Date**: 2026-08-22
**Task**: SER-033 generated memory validation
**Branch**: `main`

### Summary

Added exact bounded worktree anchors, fail-closed validation states, a configurable 28-day generated-memory horizon, unified prompt eligibility, offline safety fixtures, and updated memory contracts.

### Git Commits

| Hash | Message |
|------|---------|
| `64989d6` | (see git log) |

### Status

[OK] **Completed**


## Session 9: Enable project memory by default

**Date**: 2026-08-22
**Task**: Enable project memory by default
**Branch**: `main`

### Summary

Made learned project memory default-on when trajectory recording is available, preserved explicit and trajectory-based opt-outs, expanded runtime/config coverage, and refreshed configuration and architecture documentation.

### Git Commits

| Hash | Message |
|------|---------|
| `e343e1b` | (see git log) |

### Status

[OK] **Completed**


## Session 10: SER-034 informational transcript contrast

**Date**: 2026-08-22
**Task**: SER-034 informational transcript contrast
**Branch**: `main`

### Summary

Raised shared informational notice contrast with an accented durable marker, normal-intensity exact report text, forced-color regression coverage, and synchronized frontend contracts.

### Git Commits

| Hash | Message |
|------|---------|
| `af84a03` | (see git log) |

### Status

[OK] **Completed**


## Session 11: Implement SER-035 animated startup

**Date**: 2026-08-22
**Task**: Implement SER-035 animated startup
**Branch**: `main`

### Summary

Added an immediate bounded Ink startup animation, atomic handoff to App, clean error/resume lifecycle, deterministic component coverage, delayed real-pty acceptance, and frontend contracts. All focused checks, typecheck, and full pnpm test passed.

### Git Commits

| Hash | Message |
|------|---------|
| `53d806f` | (see git log) |

### Status

[OK] **Completed**


## Session 12: Fix SER-035 startup test isolation

**Date**: 2026-08-22
**Task**: Fix SER-035 startup test isolation
**Branch**: `main`

### Summary

Made the startup pty suite use unique process-owned HOME/project fixtures and assert resumed recap semantics without hard-coding SDK restored-message metadata. Focused startup pty, typecheck, and full pnpm test passed.

### Git Commits

| Hash | Message |
|------|---------|
| `1526090` | (see git log) |

### Status

[OK] **Completed**


## Session 13: Modern premium TUI welcome

**Date**: 2026-08-22
**Task**: Modern premium TUI welcome
**Branch**: `main`

### Summary

Added a responsive one-shot DARWIN wordmark, unified the semantic accent palette, softened composer/completion focus, and verified startup, frame-budget, PTY, typecheck, and full test contracts.

### Git Commits

| Hash | Message |
|------|---------|
| `0c852bc` | (see git log) |

### Status

[OK] **Completed**


## Session 14: Restructure the bilingual README and user guide

**Date**: 2026-08-23
**Task**: Restructure the bilingual README and user guide
**Branch**: `main`

### Summary

Reframed the project landing page around self-iteration, self-development, and self-evolution research; moved detailed usage contracts into a complete bilingual user guide; added factual repository metadata and verified links, parity, typecheck, and tests.

### Git Commits

| Hash | Message |
|------|---------|
| `101d316` | (see git log) |

### Status

[OK] **Completed**


## Session 15: Implement SER-036 structured progress checklist

**Date**: 2026-08-23
**Task**: Implement SER-036 structured progress checklist
**Branch**: `main`

### Summary

Added parent-only bounded update_plan state, shared-budget live and final Static projections, ordinary-event-only trajectory semantics, offline SDK and free pty acceptance, and synchronized architecture specs.

### Git Commits

| Hash | Message |
|------|---------|
| `1de577d` | (see git log) |

### Status

[OK] **Completed**


## Session 16: Correct SER-036 checklist row budgeting

**Date**: 2026-08-23
**Task**: Correct SER-036 checklist row budgeting
**Branch**: `main`

### Summary

Made live and final Static checklist rows truncate at one visual row and added adversarial narrow-width rendered-height coverage.

### Git Commits

| Hash | Message |
|------|---------|
| `6f9c1c7` | (see git log) |

### Status

[OK] **Completed**


## Session 17: Implement SER-037 Escape prompt UI dismissal

**Date**: 2026-08-23
**Task**: Implement SER-037 Escape prompt UI dismissal
**Branch**: `main`

### Summary

Added query-scoped Escape dismissal for slash/path completion and prompt recall while preserving permission and compaction ownership; updated bilingual references/specs and added pure plus offline real-pty coverage.

### Git Commits

| Hash | Message |
|------|---------|
| `635c712` | (see git log) |

### Status

[OK] **Completed**


## Session 18: SRF-013 bounded completion guard

**Date**: 2026-08-24
**Task**: SRF-013 bounded completion guard
**Branch**: `main`

### Summary

Added one bounded driver-owned continuation for successful turns that end on internal working notes; suppressed note text across TUI, headless, structured output, trajectory and replay; added offline acceptance coverage and synchronized architecture contracts.

### Git Commits

| Hash | Message |
|------|---------|
| `989e36c` | (see git log) |

### Status

[OK] **Completed**


## Session 19: Implement SRF-014 shell cwd preflight

**Date**: 2026-08-24
**Task**: Implement SRF-014 shell cwd preflight
**Branch**: `main`

### Summary

Reported effective persistent-shell cwd and conservatively refused evidenced wrong-root relative paths before launch.

### Main Changes

- Configured the vended foreground bash tool from AgentRuntime's verified project root.
- Added narrow no-launch wrong-root diagnostics while preserving shell and background lifecycle semantics.
- Documented the invariant in SDK/error contracts and the architecture index.

### Git Commits

| Hash | Message |
|------|---------|
| `3f4c27a` | (see git log) |

### Testing

- [OK] pnpm tsx spike/verify-background-bash.ts — 134 passed
- [OK] pnpm tsx spike/verify-clear-session.ts — 44 passed
- [OK] pnpm typecheck; pnpm test; pnpm build — passed

### Status

[OK] **Completed**


## Session 20: SRF-015 subagent heartbeats and targeted cancellation

**Date**: 2026-08-24
**Task**: SRF-015 subagent heartbeats and targeted cancellation
**Branch**: `main`

### Summary

Added bounded 30-second subagent progress, safe phase projection, user-only per-dispatch cancellation, TUI/headless visibility, offline acceptance coverage, and synchronized architecture/spec contracts. Verified focused suites, typecheck, full pnpm test, and build.

### Git Commits

| Hash | Message |
|------|---------|
| `e6ae0f2` | (see git log) |

### Status

[OK] **Completed**


## Session 21: SRF-015 transient headless heartbeat correction

**Date**: 2026-08-24
**Task**: SRF-015 transient headless heartbeat correction
**Branch**: `main`

### Summary

Kept text-mode subagent heartbeats on transient stderr only rather than duplicating them into persistent diagnostics; re-ran typecheck and the focused offline suite.

### Git Commits

| Hash | Message |
|------|---------|
| `e3ac4db` | (see git log) |

### Status

[OK] **Completed**


## Session 22: SRF-015 full-check fixture correction

**Date**: 2026-08-24
**Task**: SRF-015 full-check fixture correction
**Branch**: `main`

### Summary

Restored the structured-headless fixture's no-op subagent-progress observer after the full focused check exposed the missing runtime seam; reran focused checks, typecheck, the complete offline suite, and build.

### Git Commits

| Hash | Message |
|------|---------|
| `0363101` | (see git log) |

### Status

[OK] **Completed**


## Session 23: Implement SRF-016 retry guard

**Date**: 2026-08-26
**Task**: Implement SRF-016 retry guard
**Branch**: `main`

### Summary

Added a bounded per-Agent/per-invocation repeated-failure intervention guard, explicit foreground bash exit status, default guidance, focused real-Agent coverage, and architecture/spec contracts.

### Main Changes

- Blocked a materially new tool attempt after three normalized same-signature failures while preserving original results and resetting on a new invocation.
- Kept plan, PreToolUse, permission, body, PostToolUse, child isolation, and custom system-prompt replacement semantics intact.

### Git Commits

| Hash | Message |
|------|---------|
| `b5133d3` | (see git log) |

### Testing

- [OK] Focused retry guard: 16 passed; tool hooks and foreground/background bash focused suites passed.
- [OK] pnpm typecheck, full pnpm test, and pnpm build passed.

### Status

[OK] **Completed**


## Session 24: Correct SRF-016 threshold denial

**Date**: 2026-08-26
**Task**: Correct SRF-016 threshold denial
**Branch**: `main`

### Summary

Removed an input-specific exemption so every further call to the affected tool is denied once a failure signature reaches the three-outcome cap.

### Main Changes

- Kept the conservative pre-execution threshold aligned with the required bounded-loop invariant.

### Git Commits

| Hash | Message |
|------|---------|
| `7511778` | (see git log) |

### Testing

- [OK] pnpm typecheck, focused retry-guard suite (15 passed), and pnpm build passed after the correction.

### Status

[OK] **Completed**


## Session 25: SRF-017 CodeGraph preflight

**Date**: 2026-08-26
**Task**: SRF-017 CodeGraph preflight
**Branch**: `main`

### Summary

Added a runtime-scoped read-only CodeGraph index preflight for semantic MCP readers, transparent initialized-target pass-through, parent/child and tool-refresh coverage, and backend architecture contracts. Focused MCP/subagent checks, typecheck, full test, and build passed.

### Git Commits

| Hash | Message |
|------|---------|
| `117103e` | (see git log) |

### Status

[OK] **Completed**


## Session 26: SRF-018 successful empty web search results

**Date**: 2026-08-26
**Task**: SRF-018 successful empty web search results
**Branch**: `main`

### Summary

Verified Darwin's post-registration MCP ownership seam, normalized only the external web-search provider's exact zero-hit signature, preserved true errors and non-empty payloads, and added parent/child real-MCP coverage.

### Main Changes

- Added exact web-search zero-hit normalization at the shared registered catalogue seam.
- Documented provider ownership and the load-bearing parent/child refresh invariant.

### Git Commits

| Hash | Message |
|------|---------|
| `7dda590` | (see git log) |

### Testing

- [OK] Focused real-MCP suite: 8 passed.
- [OK] Affected retry-guard, tool-hooks, subagent, CodeGraph, and MCP command suites passed.
- [OK] pnpm typecheck, one full pnpm test, and pnpm build passed.

### Status

[OK] **Completed**


## Session 27: Restore assistant text after tool-heavy turns

**Date**: 2026-08-26
**Task**: Restore assistant text after tool-heavy turns
**Branch**: `main`

### Summary

Kept completion-guard overflow bounded while retaining terminal assistant text and results, added tool-flood/multi-block/cancellation regressions, and updated the SDK contract.

### Git Commits

| Hash | Message |
|------|---------|
| `c3e1e3b` | (see git log) |

### Status

[OK] **Completed**


## Session 28: SER-039 bounded reverse prompt-history search

**Date**: 2026-08-26
**Task**: `.trellis/tasks/08-26-ser-039-prompt-history-search`
**Branch**: `main`

### Summary

Added project-only `Ctrl+R` reverse search over the existing bounded trajectory prompt reader. Search filters newest-first duplicate-collapsed entries, navigates and accepts locally, restores the exact opening draft/cursor on Escape, and renders through counted prompt rows without adding persistence or model-visible state.

### Verification

- [OK] Pure search, prompt reader/recall, frame-budget and help suites passed.
- [OK] Free PTY `historySearch` plus completion, pathCompletion, recall, recallEmpty, queue, and permissionEscape scenarios passed.
- [OK] `pnpm typecheck`, one complete `pnpm test`, and `pnpm build` passed.
- [OK] Task validation, `git diff --check`, and AGENTS.md 32 KiB bound passed.

### Status

[OK] **Completed; awaiting commit/archive**


## Session 28: Paginate self-evolution backlog

**Date**: 2026-08-26
**Task**: Paginate self-evolution backlog
**Branch**: `main`

### Summary

Split the 96 KB backlog into a thin router plus stable 20-priority pages, updated self-evolution/reflection contracts, and added exercised structural validation with lossless migration proof.

### Git Commits

| Hash | Message |
|------|---------|
| `0135f4b` | (see git log) |

### Status

[OK] **Completed**


## Session 29: Recover oversized model context

**Date**: 2026-08-27
**Task**: Recover oversized model context
**Branch**: `main`

### Summary

Classified Mantle overflow errors, made durable tool-result offload default-on, repaired oversized restored snapshots before provider requests, aligned bounded driver guidance, suspended memory extraction, and archived the completed overflow task.

### Main Changes

- Added exact Mantle context-overflow classification and default-on session-scoped file offload with explicit opt-out.
- Repaired legacy oversized tool results before resumed provider assembly while preserving durable retrieval references and child isolation.
- Aligned TUI, text, and structured failure guidance and synchronized architecture, specs, and bilingual docs.

### Git Commits

| Hash | Message |
|------|---------|
| `e673891` | (see git log) |
| `7a45463` | (see git log) |
| `cbbd09d` | (see git log) |
| `3bffe3d` | (see git log) |

### Testing

- [OK] pnpm test; pnpm typecheck; focused overflow/offload/headless/TUI suites; frozen offline install; SDK syntax and patch checks.

### Status

[OK] **Completed**

### Next Steps

- Resume 08-27-llm-memory-extraction only when overflow work is no longer the priority.


## Session 30: Agent-managed project memory tools

**Date**: 2026-08-27
**Task**: Agent-managed project memory tools
**Branch**: `main`

### Summary

Replaced heuristic ambient memory extraction with parent-only memory_recall and staged memory_save tools, exact evidence validation, durable successful-turn commit, strict v3 migration, permission/lifecycle coverage, and synchronized architecture and user documentation. Typecheck, build, focused suites, full pnpm test, Trellis validation, and diff checks passed.

### Git Commits

| Hash | Message |
|------|---------|
| `06643fe` | (see git log) |

### Status

[OK] **Completed**


## Session 31: Prevent final TUI reply duplication

**Date**: 2026-08-27
**Task**: Prevent final TUI reply duplication
**Branch**: `main`

### Summary

Flush the mutable assistant tail before committing the authoritative text block to Ink Static, with reducer and real-PTY regressions proving the next prompt no longer leaves duplicate scrollback.

### Main Changes

- Added a two-render live-to-Static handoff at text block close without buffering or deduplicating SDK events.
- Added terminal-state reconstruction and an offline PTY fixture matching the reported final-tail plus next-input failure shape.

### Git Commits

| Hash | Message |
|------|---------|
| `9da06c3` | (see git log) |

### Testing

- [OK] pnpm test
- [OK] pnpm typecheck
- [OK] pnpm build
- [OK] pnpm tsx spike/verify-stream-into-static.ts
- [OK] pnpm tsx spike/verify-tui.ts finalReplyHandoff
- [OK] pnpm tsx spike/verify-tui.ts updatePlan

### Status

[OK] **Completed**

## 2026-08-27 — SER-041 clipboard image input

Implemented bounded interactive clipboard image attachment at the ordinary SDK content-block seam. `Ctrl+O` reads one PNG through dependency-free platform helpers, reuses the imageViewer decoder/normalizer and aggregate decode chain, renders one counted chip, and carries the image with its prompt/queue entry. Runtime sends one text-plus-`ImageBlock` invocation while trajectory, replay/export, recall, rewind labels, memory evidence and shell records remain literal-text-only.

Added offline runtime/helper/decoder/queue checks and a free pty scenario covering chip persistence/removal, explicit failure, ordinary send, SDK message content, queue ownership and cancel return. Updated SDK, trajectory, frame, TUI-testing, architecture and AGENTS contracts. Focused checks, typecheck and build pass. Full `pnpm test` ran once and reached one pre-existing Host-owned backlog validation failure because SER-041's in-progress evidence subsection is intentionally empty; 155/156 `verify-skills` assertions pass and all earlier suites, including the new tests, pass.


## Session 32: SER-041 clipboard image input

**Date**: 2026-08-27
**Task**: SER-041 clipboard image input
**Branch**: `main`

### Summary

Added bounded Ctrl+O clipboard image attachment using the shared image decoder and one SDK content-block invocation, with text-only durable records and focused offline/pty coverage. Full test gate has one Host-owned in-progress backlog evidence validation failure; all feature checks, typecheck, and build pass.

### Git Commits

| Hash | Message |
|------|---------|
| `2b04e59` | (see git log) |

### Status

[OK] **Completed**


## Session 33: Vend SDK HTTP request tool

**Date**: 2026-08-27
**Task**: Vend SDK HTTP request tool
**Branch**: `main`

### Summary

Registered the SDK HTTP request singleton on the parent runtime, proved fail-closed and plan-mode gating offline, and documented the parent-only contract.

### Main Changes

- Added the SDK http_request vended tool to the ordinary parent Agent tools list.
- Added offline registration and permission-gating regression coverage.
- Recorded the parent-only HTTP tool architecture and SDK contract.

### Git Commits

| Hash | Message |
|------|---------|
| `ce68299` | (see git log) |

### Testing

- [OK] pnpm tsx spike/verify-http-request-tool.ts (7 passed)
- [OK] pnpm test && pnpm typecheck && pnpm build (passed)

### Status

[OK] **Completed**


## Session 34: Keep dependent background waits attached

**Date**: 2026-08-28
**Task**: Keep dependent background waits attached
**Branch**: `main`

### Summary

Extended terminal-focused bash waits to five minutes, added exact wait-again guidance for still-running timeouts, preserved compact TUI behavior, and verified focused/full suites.

### Git Commits

| Hash | Message |
|------|---------|
| `066fb6f` | (see git log) |

### Status

[OK] **Completed**


## Session 35: Full transcript replay on interactive resume

**Date**: 2026-08-28
**Task**: Full transcript replay on interactive resume
**Branch**: `main`

### Summary

Replaced the bounded last-turn resume recap with a full transcript replay through replayRecords/turnReducer; distinct degradation notices kept; observer/byte-zero invariants proven; specs, AGENTS row and pty resume scenario updated.

### Git Commits

| Hash | Message |
|------|---------|
| `27ed5c3` | (see git log) |

### Status

[OK] **Completed**

## Session 36: Word-wise composer navigation and deletion (SER-042)

**Date**: 2026-08-28
**Task**: Word-wise composer navigation and deletion (SER-042)
**Branch**: `main`

### Summary

Added Alt/Ctrl+Arrow, Alt+B/F word jumps, Alt+Backspace and Alt+D word deletes to the
prompt editor: pure grapheme-aware primitives (moveWordHorizontal, deleteWordAfter,
shared wordBoundaryBefore/After behind Ctrl+W's deleteWordBefore) in prompt-editor.ts,
wired in App.tsx after every existing key owner. New free pty scenario `wordNav`
(discovered: Ink's input parser folds bare control bytes into text chunks, so batched
pty tests must home the cursor with CSI Home/End, not Ctrl+A/E — recorded in
tui-testing.md). Unit spike +19 word-boundary cases; typecheck, full pnpm test, and
cursor/multiline/completion/recall/recallEmpty/queue/historySearch all green.

### Git Commits

| Hash | Message |
|------|---------|
| `c32e5f6` | feat(tui): word-wise composer navigation and deletion |

### Status

[OK] **Completed**

## Session 37: Terminal attention bell (SER-043)

**Date**: 2026-08-28
**Task**: Terminal attention bell (SER-043)
**Branch**: `main`

### Summary

Added a config-gated terminal attention bell: new session-scoped `terminalBell`
boolean (default false, non-boolean refuses startup, survives /model, refused inside
a models entry), `src/tui/terminal-bell.ts` as the sole BEL writer, wired at the two
driver-owned lifecycle publication points only — the PermissionQueue observer in
cli.ts runInteractive and the runTurn finally next to observeTurnComplete in App.tsx.
Off path performs no write at all; headless/child agents never ring. New free pty
suite `verify-terminal-bell.ts` (offline tool-calling model through the real CLI;
counts raw un-stripped \x07: exactly 1 at permission publication, +1 per completed
turn, 0 when disabled) plus a `terminalBell` block in verify-config.ts; both in
pnpm test. Discovered: a project-root fileEditor write is statically safe in default
mode, so the fixture uses bash redirection to force a deterministic prompt. Specs:
error-handling degradation rows + live-frame SER-043 contract. Typecheck, full
pnpm test (twice), and pnpm build all green.

### Git Commits

| Hash | Message |
|------|---------|
| `94909b8` | feat(tui): config-gated terminal attention bell |
| `e8376df` | chore(task): archive 08-28-terminal-bell |

### Status

[OK] **Completed**

---

## 2026-08-28 — Bounded composer undo (SER-044)

**Date**: 2026-08-28
**Task**: Bounded composer undo (SER-044)
**Branch**: `main`

### Summary

Added bounded composer undo: Ctrl+_ / Ctrl+- (byte 0x1f — Ink's legacy parser
reports it as bare `\u001f` with no ctrl flag; the handler also covers the kitty
chord) restores the exact {text, cursor} destroyed by Ctrl+K/U (killToRowEdge),
Ctrl+W / Alt+Backspace (deleteWordBefore) and Alt+D / Alt+Delete (deleteWordAfter).
Pure primitives in prompt-editor.ts (UNDO_CAP 16, pushUndo drops oldest, popUndo);
App.tsx owns the stack as a ref like preferredColumn, pushes only when a chord
changes text, and clears at the top of submit(), queue take-back, recall
replacement, history-search accept and rewind accept. Empty-stack undo is a
consumed no-op; no new UI surface. Unit coverage in verify-prompt-editor.ts; new
free pty scenario `undo` (13th free scenario, AGENTS.md updated). Discovered two
pty delivery rules now in tui-testing.md: control bytes coalesced with other bytes
fold into the text chunk and are stripped (send each in its own write, anchored on
the render it causes via the `frame` getter), and bytes sent before Ink's raw mode
are eaten by the cooked line discipline where Ctrl+U/W are kill/werase. Typecheck,
full pnpm test, undo ×3, and cursor/multiline/wordNav/completion/recall/recallEmpty/
queue/historySearch all green; pnpm build refreshed dist.

### Git Commits

| Hash | Message |
|------|---------|
| `a22d72d` | feat(tui): bounded composer undo on ctrl+_ (SER-044) |
| `fc3351b` | chore(task): archive 08-28-composer-undo |

### Status

[OK] **Completed**

---

## 2026-08-30 — SER-045: parent-only `workflow` DAG tool (SDK Graph)

### What happened

Implemented backlog direction SER-045 end to end as a headless worker:
a parent-only `workflow` tool running a bounded declarative DAG (≤8 nodes,
≤28 edges, data never code) on the installed SDK `Graph`. Extracted the
subagent child construction into `src/agents/child-recipe.ts`
(`buildRecipeChild` + `stopBashSession`) so `SubagentTool` and the new
`WorkflowTool` share one recipe; SubagentTool observable behavior unchanged.
Each node is a thin `InvokableAgent` adapter (user node id outward, unique
`darwin-workflow-*` Agent id inward) that prepends the node task to the
SDK's dependency-merged input; per-node dispatch registry entries with
random ids (shared parent tool_use id would make targeted cancel
ambiguous); one owned AbortController forwards the parent cancel signal
into `graph.invoke` so unstarted nodes never run; terminus content only
returns. Permission classification `read`, following the subagent
precedent.

### Verification

- `pnpm typecheck` green; full `pnpm test` green (exit 0), including new
  `spike/verify-workflow-tool.ts` (32 asserts: validation refusals with zero
  construction, diamond-DAG SDK dependency merge/order, dispatch + provenance,
  terminus-only result, failure sweep, parent cancellation reaching unstarted
  nodes, parent-only registration order). verify-subagent-heartbeats passed
  in the full run (no flake rerun needed).
- Spec: strands-sdk-contracts.md § "bounded declarative workflow DAG
  (SER-045)"; AGENTS.md row (30,278 bytes < 32 KiB); load-bearing-decisions.md
  § "Workflow DAG tool". `pnpm build` run after commit.

### Commits

| Commit | Subject |
|---|---|
| `cbd2863` | feat(agents): add parent-only workflow dag tool on the sdk graph |

### Status

[OK] **Completed** — docs/research/ untouched (Host owns backlog status).

## 2026-08-30 — /workflow built-in command (08-30-workflow-command)

**Task**: user request "为workflow增加'/workflow' command主动触发"; option A
(prompt-style trigger) chosen explicitly over direct DAG execution.

- New `src/commands/workflow-command.ts`: pure `parseWorkflowCommand` +
  `WORKFLOW_COMMAND_USAGE`; expansion template names the `workflow` tool,
  restates ≤8-node bound and reads-parallel/writes-serialized, embeds the
  task verbatim, keeps an indivisible-task escape hatch.
- `expandSlashCommand` checks it first (built-in reservation precedes skills
  and custom commands); `'missing-task'` → null, drivers (TUI + dev-repl) own
  the bare-form usage notice. `BUILTIN_COMMAND_NAMES` +workflow,
  `MAX_COMPLETIONS` 19→20.
- Test fallout: frame-budget omission fixture and pathCompletion pad sat
  exactly at the old cap; grown to overflow by construction. The both-sides
  omission assertion was red on clean HEAD (1-past-cap fixture can never
  omit on both sides) — fixed alongside.
- `pnpm typecheck` + `pnpm test` green; `verify-tui.ts completion` 68/68,
  `pathCompletion` 27/27, new `verify-workflow-command.ts` 20/20 (in
  run-tests). trellis-implement wrote it, trellis-check fixed one missing
  semicolon; Host re-ran the full gate.
- Spec: SER-045 scenario grew the trigger contract bullet + required checks;
  AGENTS.md workflow row (30,516 bytes < 32 KiB); load-bearing-decisions.md;
  user-guide reference/extensions EN+zh. `pnpm build` run after commit.

### Commits

| Commit | Subject |
|---|---|
| `6a95dcb` | feat(commands): add /workflow prompt-style trigger for the dag tool |

### Status

[OK] **Completed** — task archived to archive/2026-08/.


## Session 37: Fix persistent final reply duplication (Static mid-insert)

**Date**: 2026-08-30
**Task**: Fix persistent final reply duplication (Static mid-insert)
**Branch**: `main`

### Summary

Root-caused the recurring duplicate-final-reply bug: finishTurn inserted the final update_plan checklist mid-history, and Ink <Static>'s index-based consumption re-emitted the shifted closing answer while swallowing the checklist. Reproduced deterministically with a new pty probe, fixed finishTurn to append-only, added prefix-stability and terminal-reconstruction regressions, updated SER-036 spec, rebuilt dist.

### Git Commits

| Hash | Message |
|------|---------|
| `2a05ee6` | (see git log) |

### Status

[OK] **Completed**

## 2026-08-31 — /compact reasoning-block poisoning (08-31-compact-summary-reasoning)

- Diagnosed the `/compact` warn `User messages cannot contain reasoning content`: SDK
  `generateSummary()` copies the thinking model's full response (reasoning blocks
  included) into a `role:user` summary message; Bedrock rejects every later request.
- Fixed in the pinned SDK patch (filter `reasoningBlock` from summary content, throw
  if nothing remains) — covers both the overflow manager and `/compact`.
- Added `stripReasoningFromUserMessages` in `src/agent/compact.ts`, wired after
  initialize/rewind restore in `runtime.ts`, to repair already-poisoned histories.
- verify-compact grew 14 assertions (27/27); typecheck + full suite green; spec
  `/compact` scenario updated; committed f4e3271; `pnpm build` refreshed dist.

## 2026-09-02 — SER-053 static bash classifier mutating-argument escapes (09-02-ser-053-bash-classifier-mutating-args)

- `assessBashRisk` judged a segment by its first word only, so `find … -delete`,
  `find … -exec`, `git branch -D/-m`, `git diff/log --output=` were `safe — read-only
  command` and ran unprompted in `default`/`auto`.
- Added a per-command mutating-option rule (`find`, `git branch` incl. combined short
  flags and `--opt=value`, `git log/diff/show --output`) after the first-word check;
  whitelist sets, allow rules, classifier and plan denial untouched.
- `verify-permission-modes.ts` grew 45 assertions (154/154); typecheck + full suite
  exit 0; user guide (en/zh), `strands-sdk-contracts.md` static-safety contract and
  load-bearing-decisions Permissions § state the rule. Committed 14378bc.
- Left for a follow-up direction: bare `git branch <name>` (positional create) is still
  statically safe — the direction scoped the rule to options only.

## 2026-09-02 — SER-054 foreground bash timeout keeps captured output (09-02-ser-054-bash-timeout-evidence)

- A foreground `execute` past its timeout rejected with `Command timed out after N seconds`
  only: captured stdout/stderr were discarded and the persistent shell was killed without
  saying so (next call woke up at the initial cwd).
- Fixed at the existing seam in the pinned SDK patch (`bash.js` timeout handler, the same
  place that shapes the exit-0 restart notice): `BashTimeoutError` now carries `output`,
  `error` (≤ 64 KiB tails, multi-byte-safe cut), `cwd`, `timeoutSeconds`; its message —
  what `createErrorResult` shows the model — states timeout → stdout tail → stderr tail →
  killed/restart-with-cwd → `start`+`wait` pointer. Cap and `hasMore` word are the
  background projection's. No auto-background: the shell cannot detach a running command.
  `stop()` resets the tracked cwd so the post-timeout wrong-root preflight is truthful.
- Patch procedure: `pnpm patch … --edit-dir` → edit → `node --check` → `pnpm patch-commit`;
  `pnpm install --frozen-lockfile` + `cmp` proved re-apply. `verify-background-bash.ts`
  grew 15 assertions (157/157); typecheck, full `pnpm test`, `pnpm build` green.
  Spec (`strands-sdk-contracts.md` bash contract + matrix, `error-handling.md` row) and
  load-bearing Process exit § updated; AGENTS.md untouched (32,412 B, no phrase false).
  Committed 0255368.

## 2026-09-02 — SER-056 parent-only `web_fetch` tool (09-02-ser-056-web-fetch-tool)

- `http_request` returns `response.text()` unbounded; a docs page was 656 KB of HTML that the
  offloader had to absorb. Added a sibling tool `web_fetch({ url, maxChars? })` in
  `src/tools/web-fetch.ts` — SDK `tool()` factory, no dependency: markdown-first `Accept`,
  `http→https` upgrade, same-host redirects followed (5 hops), cross-host ones *reported*
  (status, original url, empty body, both URLs in `notice`), dependency-free HTML→text
  (`TextBuilder` line model with quote-depth prefixes; drop sets for script/style/nav/…), binary
  refused by type+length before reading, 4 MiB download cap, 40 000 code-point body ceiling
  with `[truncated: N of M code points]`. Own `AbortSignal.any([timeout, cancelSignal])`;
  `httpRequest` never imported by the module.
- Test technique worth reusing: the tool speaks https, the fixture is plain http — inject a
  `fetchImpl` that rewrites only the fixture origin. It records the requested URL string, which
  is exactly how the upgrade is proven end to end without TLS. Child-catalogue exclusion is
  observed black-box through `runtime.info.agentProblems`: a probe agent definition with
  `tools: ["web_fetch"]` is reported as naming an unknown tool.
- Found a spec/code gap: `childTools` only filtered `retrieve_offloaded_content`, so
  `http_request` *was* handed to children although AGENTS.md, the load-bearing doc and the spec
  matrix all said otherwise. Promoted the filter to `PARENT_ONLY_TOOL_NAMES` (offload retrieval,
  `http_request`, `web_fetch`) and named the mechanism in the matrix row.
- `verify-web-fetch.ts` 73/73 (in `pnpm test`); `verify-http-request-tool.ts` 7/7 unchanged;
  typecheck + full suite exit 0. AGENTS.md 32,412 → 32,578 B: no room for a new row, so the
  existing HTTP row gained one clause. Committed d14b27c.

## 2026-09-02 — SER-055 `replace_all` on `fileEditor str_replace` (09-02-ser-055-str-replace-all)

- The pinned SDK editor refused non-unique `old_str`, and rule 8 forbids `sed -i`, so a bulk
  rename in one file was N gated calls. Added `replace_all: z.boolean().optional()` to the
  vended schema through the existing pnpm patch: `buildStrReplaceResult(…, replaceAll)` keeps
  every pre-existing branch verbatim and only skips the uniqueness throw when the flag is set,
  splicing the ascending non-overlapping `findOccurrences()` hits in one pass and one
  `writeText`. Result text names the count and the *pre-edit* line numbers (the same numbers the
  uniqueness error reports) plus one snippet around the first replacement; count 1 takes the same
  shape. Other commands ignore the flag — already true today, since the zod object strips it.
- Identity was proven, not asserted: before touching `node_modules` I printed the four
  `str_replace` result strings (multiple / miss / empty / single) and the `insert` text from the
  installed tool and embedded them as literals in `verify-file-editor.ts`; the pre-change spike
  files (`git show HEAD:spike/…`) also still pass unchanged against the new patch.
- Patch procedure that worked: `pnpm patch @strands-agents/sdk@1.16.0 --edit-dir <dir>` applies
  the *existing* patch to the pristine package (the edit dir was byte-identical to the installed
  `file-editor.js`), edit, `node --check`, `pnpm patch-commit <dir>`; only the lockfile
  `patch_hash` follows. Re-apply proof: `--ignore-existing` pristine + `patch -p1 --dry-run`
  clean + `diff -r` of the patched pristine `dist` against the installed one empty.
- Rendering stays input-derived: the diff and `+N -N` stay the one pair; the scope is one row —
  `classify()` adds a `Replace all: every occurrence` detail (so dev-repl and every gate consumer
  state it, not just the Ink box), and `REPLACE_ALL_ROW` (`replace_all: every occurrence`) heads
  `fileEditorInputProjection` and `compactEditDiff`. `summary` untouched (replay prints it
  verbatim); `readEdit` accepts a boolean `replace_all` and treats any other type as an
  unrecognized shape.
- Out of scope, recorded in the PRD: `validatePortableToolInput` in `src/hooks/tool-hooks.ts`
  lists the fileEditor keys a Codex `PreToolUse updatedInput` may carry and does not include
  `replace_all`; a hook that rewrites such an input is refused fail-closed, never misapplied.
- `verify-file-editor.ts` 89/89, `verify-file-editor-serial.ts` 50/50, `verify-edit-diff.ts`
  112/112, `verify-visual-language.tsx` 74/74; typecheck, full `pnpm test` (exit 0, 84 suites),
  `pnpm install --frozen-lockfile`, `pnpm build` green. AGENTS.md 32,578 → 32,667 B (one clause
  on the FileEditor recovery row). Committed 4c40426.

## 2026-09-02 — SER-057 `/copy` last completed answer to the clipboard (09-02-ser-057-copy-command)

- New `src/tui/copy-command.ts`: `latestCompletedAnswer(history)` walks `<Static>` history
  backwards to the first `whole`/`last` `AnswerPart` and joins that answer's pieces with `\n`,
  empty closing pieces contributing nothing — the exact `formatReplay` rule, so clipboard,
  transcript and `/export` cannot disagree. An in-progress answer (`first`/`middle`, no `last`)
  is skipped without consulting `status`, so mid-turn `/copy` copies the previous answer.
- Transport order was the decision: OSC 52 (`ESC ] 52 ; c ; base64 BEL`) through Ink's
  `useStdout().write` first and unconditionally (SSH is the normal case); `wl-copy`/`xclip
  -selection clipboard`/`pbcopy` only when `WAYLAND_DISPLAY`/`DISPLAY`/macOS says a display is
  there, via a spawn-based non-throwing helper in the `clipboard-image.ts` shape; its failure is a
  clause of the one notice. `MAX_COPY_BYTES = 262_144`, cut on a code-point boundary, over-cap
  stated as `copied N of M bytes` (warn).
- `App` reads history through a render-time mirror ref (`historyRef`) instead of adding
  `state.history` to `submit`'s deps — that callback must not be rebuilt per streamed line.
- Seeding a completed answer for a *free* pty scenario worked by reusing the `resume` seeding
  (local `ResumeFixtureModel` + real `SessionManager`/`TrajectoryRecorder` + `--resume`): the
  restored history holds a real `whole` piece. The OSC write is invisible to the driver's
  `screen` (its `stripAnsi` eats the OSC — and would leave a fragment if the base64 held a `+`),
  so the scenario decodes the sequence from `tui.raw`. Display variables are blanked in the
  child env so no platform tool is reached for.
- Growing `MAX_COMPLETIONS` 20→21 broke two hard-wired fixtures: `pathCompletion`'s pad count
  (18→19 keeps three candidates past the cap) and `verify-frame-budget.ts`'s overflow menu
  (21 items, `maxRows: 24` — now `MAX_COMPLETIONS + 1` items and `MAX_COMPLETIONS + 4` rows, the
  4 being draft, marginTop, title and the "… n more" row). Both now derive from the cap.
- `verify-copy-command.ts` 41/41 (in `pnpm test`), `verify-help-command.ts` 35/35,
  `verify-frame-budget.ts` 80/80, free pty `copy` 16/16, `completion` 69/69, `pathCompletion`
  27/27; typecheck, full `pnpm test` (exit 0, zero FAIL lines), `pnpm build` green. AGENTS.md
  untouched at 32,667 B; rationale went to `docs/architecture/load-bearing-decisions.md`
  § `/copy`. Committed 00c5b90.

## 2026-09-02 — SER-058 `darwin doctor` offline read-only diagnostics (09-02-ser-058-doctor-command)

- New `src/cli-doctor.ts` on the `cli-sessions.ts` model (`DOCTOR_COMMAND`, `isDoctorInvocation`,
  `parseDoctorArgs`, `DoctorIo`, `runDoctorCommand → exit code`), routed in `cli.ts` beside
  `sessions` before argument parsing; `darwin doctor` row in `CLI_USAGE` and both reference docs.
  Sections: config, system prompt, project instructions, mcp, skills, hooks and policy, permission
  rules, sessions, versions; `! `-marked problem lines totalled at the end, exit 0 / 1 / 2.
- The one design rule: compose the *real* startup loaders and turn a refusal into a line — never a
  second parser. That forced two side-effect-free halves: `configPath()` `mkdirSync`'d `~/.darwin`
  on every *read* (`loadConfig` and the hook-layer loader), so a pure `configFilePath()` now serves
  the readers and only writers/fixture spikes keep the mkdir form (nothing in `src/` relied on the
  directory existing — every `userDarwinDir()` use is `mkdir recursive` or ENOENT-tolerant); and
  `loadMcpClients` spawned servers while parsing, so its declarative half became
  `readMcpServerConfigs` (same `ConfigError`, same override/ignored derivation), with
  `loadMcpClients` rebuilt on top of it.
- Stdio commands are checked with a plain `X_OK` PATH walk (`lookupOnPath`), http/sse servers say
  `not connected (doctor never connects)`, `${VAR}` commands are stated as not checked rather than
  re-implementing the SDK's interpolation. `args`/`env`/`headers` are never printed (tokens);
  `apiKeyEnv` is reported as set/unset, never the value.
- Non-obvious finding: an invalid global `config.json` yields *two* problem lines — `loadConfig`
  and `loadProjectPolicy` both read it (the latter for embedded legacy `hooks`). Kept, because
  both refusals are true and each names the file; the spike pins exactly two.
- Spike gotcha: a child `node --import tsx` resolves `tsx` from the child's cwd, so a fixture
  project with no `node_modules` fails with `ERR_MODULE_NOT_FOUND`; the suite passes
  `import.meta.resolve('tsx')` instead. Also, the "no write/spawn API" source regex had to anchor
  on calls — bare `truncate`/`cp(` matched `truncated`/`reportMcp(`.
- `verify-doctor-command.ts` 71/71 (in `pnpm test`): unknown key / invalid JSON named with the
  file, marker-writing PATH fixture found and never run, skipped skills with the loader's reason,
  hooks dialects, pristine HOME + fixture project snapshots byte-identical around the real process
  run, `doctor extra` exit 2, import-graph closure free of runtime/headless/tui/Ink/React/`Agent`.
  `verify-cli-args.ts` 43/43; refactored loaders' suites (`verify-config` 332, `verify-state-layers`
  37, `verify-mcp-command` 33) green; typecheck, full `pnpm test` (86 suites, 0 failed),
  `pnpm build`; `node dist/src/cli.js doctor` here: exit 0, no problems. AGENTS.md untouched at
  32,667 B; contract in `error-handling.md` degradation table + a load-bearing-decisions heading.
  Committed b68851f.

## 2026-09-02 — SER-059 Esc Esc opens the `/rewind` chooser (09-02-ser-059-esc-esc-rewind)

- One opener, two keys: the `/rewind` command body (from the `startRewind` guard through
  `setRewindSearch(openRewindSearch(...))`) became `openRewindChooser(): Promise<boolean>` in
  `App.tsx`, and the Escape chord calls the same callback — the pty scenario proves the shared path
  by anchoring on the command's own capacity warning and refusal wording rather than new strings.
- Chord bookkeeping is a single `useRef<number>` read-and-cleared at the *top* of `useInput`, so
  every key — including an Escape consumed by permission denial or a search mode, which return
  before the composer branch — disarms it, and only the composer's own Escape on an empty idle
  composer (`status === 'idle'`, empty queue, empty draft) re-arms. `\x1b\x1b` in one chunk is one
  Ink `escape` with `meta` and counts as both presses. `ESCAPE_REWIND_CHORD_MS = 500` lives in the
  pure `rewind-search.ts` so `help-format.ts` and the spikes import it without `App.tsx`.
- The new `escRewind` scenario found a pre-existing bug on its fresh-session leg: a refused
  `/rewind` (no catalogue) printed its notice but left `/rewind` in the draft (neither the batched
  `text\r` path nor the menu-accept path clears it — `/help`/`/clear` clear their own), so the
  following `/exit` went to the model as `/rewind/exit`. The command now clears the draft whenever
  the opener resolves `false` (and on the takes-no-arguments refusal); the chord path has an empty
  draft by definition. Pinned by `a refused /rewind leaves an empty draft`.
- Two-Escape pty timing: separate writes 120 ms apart for "inside the window", `window + 300 ms`
  for "too far apart"; the first single-Esc check doubles as the first press of the far-apart pair.
- `verify-tui.ts escRewind` 20/20; `rewind` 7, `completion` 69, `recall` 22, `historySearch` 11,
  `undo` 7, `wordNav` 11 all green; `verify-help-command.ts` 36/36 (`HELP_FIXED_LINES` 22→23);
  typecheck, full `pnpm test` (86 suites, 0 failed), `pnpm build`. AGENTS.md untouched at 32,667 B;
  spec sentence in `prompt-recall.md` § `/rewind` (plus the Escape lines in `tui-testing.md` and
  `live-frame.md`), rationale under load-bearing-decisions § `/rewind`. Committed 5eea0e4.

## 2026-09-02 — SER-060 `/tasks` output tails (09-02-ser-060-tasks-output-tail)

- The tail is a second *reader*, not a second *consumer*: `src/tools/background-tail.ts` opens the
  job's `outputPath` itself (`O_RDONLY | O_NOFOLLOW`, regular file only), reads at most the last
  `TASK_TAIL_WINDOW_BYTES` (8 KiB), drops the leading partial line only when a complete line follows
  it, splits on `\r\n`/`\n`/`\r`, strips ANSI/C0, expands tabs, drops blank lines and keeps the last
  `TASK_TAIL_LINES` (3). It imports nothing from `background-bash.ts`, so it cannot touch `cursor`,
  `OUTPUT_LIMIT` or a `wait` in flight. Proof shape that worked well: identical control/probe jobs,
  tail only the probe, then compare `output()` (and a terminal-focused `wait` spanning the tail read)
  field by field; then tail again after `output()` and deep-equal it to the pre-`output()` tail.
- Formatter split: sanitizing is a property of the log text and lives with the reader; the display
  width (`TASK_TAIL_LINE_LIMIT` 100, marker `    │ `) is presentation and lives in `task-format.ts`,
  where `summarizeTaskCommand`'s truncation became a shared `truncateEnd` (pinned by the existing
  suite). `formatTasksReport(tasks, nowMs, tails?)` — the optional map keeps legacy calls byte-identical;
  `App.tsx` awaits `readBackgroundTails(tasks)` before the one notice, so no partial second notice.
- Decision stated in spec: a zero-output job keeps its row **plus** `(no output yet)`; a missing/
  replaced/unreadable log or an uncovered task reads `(output unavailable)`; the reader never rejects.
- No model-free pty path can start a background job (`!` is not one), so `verify-tui.ts completion`
  keeps only the empty-state `/tasks` assertions and `verify-tasks-tail.ts` carries the tail proof —
  said so in `tui-testing.md` § Tests Required.
- `verify-tasks-tail.ts` 33/33 (new, in `pnpm test`), `verify-task-format.ts` 18/18 (was 10);
  `verify-tui.ts completion` 69, `bang` 19, `queue` 17 all green; typecheck, full `pnpm test`
  (0 failed), `pnpm build`. AGENTS.md untouched at 32,667 B; contract rows in `tui-testing.md`
  (background task monitoring), `strands-sdk-contracts.md` (wait/cursor matrix + tests),
  `error-handling.md` degradation table, one sentence in `live-frame.md`, rationale paragraph under
  load-bearing-decisions § Process exit. Committed 5c4dcb3.



## Session 38: Cost accounting from the LiteLLM price table, per model

**Date**: 2026-09-04
**Task**: Cost accounting from the LiteLLM price table, per model
**Branch**: `main`

### Summary

Developer-skill supervision of child session-20260904-021257844 (two turns). Iteration 1 (31ed30c): ~/.darwin/model-prices.json fetch-once cache (mapped id never refetched, litellmKey:null for unlisted ids, bounded 10s/8MiB fetch degrading to unavailable, DARWIN_MODEL_PRICES_FETCH=off), pure cost math, cost row in /status and /usage, separate headless cost: record with usage: byte-identical. Iteration 2 (fe7ee6d): per-model shares in the runtime so /status,/usage,cost: price each model at its own rates after /model; offline cost in trajectory list/replay via spend.ts (pure math moved to src/pricing/cost.ts, readers never fetch/write); developer and self-reflection skills capture cost:. Host acceptance: typecheck, pnpm test (96 suites), tui completion, real headless probe and offline trajectory readers; pnpm build after each. Child spend approx 24-25 USD.

### Git Commits

| Hash | Message |
|------|---------|
| `31ed30c` | (see git log) |
| `fe7ee6d` | (see git log) |

### Status

[OK] **Completed**
