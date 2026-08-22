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
