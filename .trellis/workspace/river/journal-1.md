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
