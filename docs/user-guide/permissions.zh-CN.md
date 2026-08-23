# 权限

[English](permissions.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 模式

可在 `~/.darwin/config.json` 中设置 `permissionMode`，用 `--permission-mode <mode>` 覆盖单次运行，或用 `--yolo` 作为简写。`/mode` 只改变当前会话，不写配置；`/clear` 会继承；正在处理的权限框或分类结果会撤回，并从头重新判断。

| 模式 | 行为 |
|---|---|
| `default` | 能由静态规则证明安全的调用直接执行，其余询问用户 |
| `auto` | 先做静态判定，再交给低成本分类器；分类器无法放行的调用才询问 |
| `plan` | 只允许读操作；写入/执行在规则、分类器、权限框和工具 hooks 之前拒绝 |
| `yolo` | 不询问；标题区会警告 |

分类依据是 `(toolName, input)`，因为同一个工具可能同时支持读写。未知工具（包括 MCP）按 execute 处理，无法静态证明安全。主代理和子代理共用同一 intervention。

## 静态安全判定

| 调用 | 静态安全？ |
|---|---|
| `fileEditor view`、`load_skill`、bash 生命周期查询/restart | 是 |
| 项目内 `fileEditor` 写入，但不包括 `.git/`、`.env*` 和敏感 Darwin 策略/配置 | 普通模式下是；`plan` 中拒绝 |
| 每个命令段都以只读白名单命令开头（`git status/log/diff/show/branch`、`ls`、`cat`、`grep`、`rg`、`find` 等），且无重定向/替换的 bash | 是 |
| 其他全部调用，包括所有 MCP 工具 | 否 |

这是纯白名单：解析不确定时多问一次，不会静默放行。`plan` 允许读文件、加载 skill、查询后台任务和委派；拒绝文件修改、带命令的 bash 以及未知/MCP 工具。它在 `PreToolUse` 之前拒绝，因此被拦截的操作不会触发项目 hook 命令。磁盘上的规则仍保留，但会显示为已忽略。

拒绝不算工具错误。模型收到的是用户拒绝结果，并被要求不要重试或绕过。

## 分类器辅助的 `auto`

静态安全规则和显式放行规则都未命中时，`auto` 会把调用交给低成本模型（默认 Haiku，可用 `classifierModel` 替换）。安全判定直接执行；不安全、超时、抛错或无法解析时，都退回用户权限框，并显示分类器理由。分类器不会自动拒绝。

切换模式会撤回进行中的权限框或分类结果，从头重新判断，并有次数上限，避免来回抖动。取消会拒绝等待中的权限请求；runtime 关闭后，bridge 会锁定为拒绝状态。

## 权限框与 diff

权限框会标明风险和来源：

```text
permission required (execute — `curl` is not on the safe-command list)
[explorer#a1b2c3d4] bash: curl https://example.com
allow? y n always: a=curl * A=all bash esc=deny
```

`[parent]` 表示主代理；`[agent#dispatch]` 标识某次子代理调用。即使多个读型子代理并行执行，权限框仍会串行出现。

`fileEditor` 权限框显示有长度上限的行 diff，由工具参数中的旧/新文本直接计算。去掉 ANSI 后，标记仍然存在；批准时使用的是未截断原文。由于它不会重新读取磁盘，外部并发修改可能让展示的提案和最终落盘效果不同。

## 记住一次选择

- `y`：只批准本次调用。
- `n` 或 `Esc`：拒绝。
- `a`：批准，并保存当前提议的窄规则。
- `A`：批准，并保存整个工具的规则。

规则按项目存于 `~/.darwin/projects/<project-key>/permission-rules.json`：

```json
{
  "allow": ["bash:pnpm *", "fileEditor:src/**"]
}
```

| 规则 | 覆盖范围 |
|---|---|
| `bash:pnpm *` | 每个串联命令段都必须以 `pnpm` 开头 |
| `bash:pnpm typecheck *` | 该命令，可带额外参数 |
| `fileEditor:src/**` | `src/` 下的写入；`**` 可跨 `/`，`*` 不可 |
| `bash` | 所有 bash 调用；MCP 只能使用整工具形式 |

规则在静态安全判定之后、分类器之前检查，因此命中后也能省去分类器调用。

## 规则安全与撤销

bash pattern 必须匹配每个串联命令段；`pnpm build && rm -rf /` 不匹配 `bash:pnpm *`。带重定向或命令替换的内容永不匹配规则。任何规则都不能覆盖 `~/.darwin/config.json`、项目权限文件、启用中的 hook 文件/目录或 `.env*` 写入，否则代理可能扩大自身权限。已经静态安全的调用不会显示一个实际无效的规则选项。

普通 `y` 不会暗中保存规则。`/permissions` 会列出所有生效规则，并区分来自磁盘还是当前会话。`/permissions revoke <n|rule|all>` 会同步从 gate 和文件中删除，下次调用重新询问，重启后也不会复活。该命令只能收紧权限；新增规则仍只能来自权限框。可以手工编辑 JSON，但非法规则会导致启动错误。

## 无头模式与本地命令

无头模式没有交互 bridge：未被静态安全或持久规则放行的调用会立即拒绝。需要时应显式选择 `auto`/`yolo`。

`!<command>` 由用户直接输入，不属于模型调用，因此不经过该 gate，并可在 `plan` 中运行；详见[使用 darwin](using-darwin.zh-CN.md)。模型后续请求的命令仍受 gate 保护。
