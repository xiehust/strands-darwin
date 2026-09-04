# Rename to darwin: AGENTS.md preload and .darwin config dir

## Goal

把上一任务交付的 TUI coding agent 产品化命名为 **darwin**，并把「darwin 运行所在目录」的
项目级配置收敛到 `.darwin/`（对齐 `.claude/`、`.codex/`、`.kiro/` 的目录惯例），同时新增
AGENTS.md 预加载能力。

关键语义：**所有 `.darwin/`、AGENTS.md、`.mcp.json` 都相对于 darwin CLI 的运行目录
（`process.cwd()`，即被操作的目标仓库），不是 darwin 自己的源码仓库。**

## Requirements

### R1 改名 darwin
- package.json：`name: "darwin"`（bin 名 `darwin`，scripts 不变）。
- TUI header、README、代码内出现的 `strands-darwin` 品牌字符串改为 `darwin`
  （如 PermissionGate 的 `name`）。
- `AGENT_ID` 改为 `darwin`。旧 `.strands-tui/` 会话不迁移（pre-1.0，README 记一句即可）。

### R2 AGENTS.md 预加载
- 启动时读取运行目录的 `AGENTS.md`（仅 cwd，不向上遍历，MVP 不做多级合并）。
- 存在则以带分隔的段落追加进 system prompt（明确标注来源，如
  `<project-instructions source="AGENTS.md">`）；不存在则静默跳过。
- TUI header 显示是否加载（如 `AGENTS.md: loaded (1.2 KB)` / 缺省不显示）。
- 空文件跳过；过大（>32 KB）截断并在 header 警示（防止吃掉 context）。

### R3 `.darwin/` 配置目录（运行目录下）
- `config.json` → `.darwin/config.json`（模型/provider 配置，原根目录 config.json 不再读）。
- skills 扫描目录 `skills/` → `.darwin/skills/`（原目录不再扫）。
- 会话持久化 `.strands-tui/` → `.darwin/sessions/`（快照）+ `.darwin/last-session.json`
  （--resume 指针）。
- MCP 双路径：优先 `.darwin/mcp.json`，不存在则回退根目录 `.mcp.json`（保留 Claude Code
  配置复用能力），两者都存在时只读 `.darwin/mcp.json` 并在 header 提示回退未生效。
  两个文件格式相同（Claude Code mcpServers 格式）。
- 本仓库 `.gitignore`：`.strands-tui/` 条目替换为 `.darwin/sessions/` 与
  `.darwin/last-session.json`（`.darwin/` 其余内容如 config/skills 应可入库）。
- 本仓库自带的示例 `skills/commit-message` 移到 `.darwin/skills/commit-message`
  （dogfood：在本仓库运行 darwin 时可用）。

### R4 同步更新
- README 全面更新（名字、目录布局图、配置路径、迁移一句话）。
- spike 验证脚本中的路径假设同步修改，全部套件重跑通过。
- `.trellis/spec/backend/strands-sdk-contracts.md` 中 `.strands-tui/` 引用同步更新。

## Acceptance Criteria

- [ ] `package.json` name/bin 为 `darwin`；TUI header 显示 darwin 品牌；代码无残留
      `strands-darwin` 品牌字符串（除历史文档/journal 外）。
- [ ] 在含 AGENTS.md 的目录运行：其内容进入 system prompt（用一条能被 AGENTS.md 规则影响的
      对话实测），header 显示已加载；无 AGENTS.md 的目录正常启动。
- [ ] `.darwin/config.json`、`.darwin/skills/`、`.darwin/sessions/` 全部生效：provider 配置
      被读取、skill 双触发路径可用、`--resume` 跨进程恢复（均以现有验证套件改路径后重跑证明）。
- [ ] MCP：仅有根 `.mcp.json` 时可用（回退）；`.darwin/mcp.json` 存在时优先。
- [ ] `pnpm typecheck` 干净；全部 spike 套件（含 acceptance-e2e）通过。

## 约束

- 不改动行为逻辑（权限、流式、skills 语义均保持），本任务只做命名与路径收敛 + AGENTS.md 注入。
- 旧路径不做兼容读取（config.json / skills/ / .strands-tui/ 直接废弃），README 说明即可。
