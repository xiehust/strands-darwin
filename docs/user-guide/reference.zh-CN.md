# 命令与按键参考

[English](reference.md) · **简体中文** · [指南首页](README.zh-CN.md)

## CLI

```bash
darwin                                      # 新建 TUI
darwin --resume                             # 恢复本项目最近会话
darwin --resume <id>                        # 指定会话
darwin --session <id>                       # 指定会话，包括 fork
darwin sessions                             # 可恢复快照
darwin -p "prompt"                          # 单次文本模式
darwin -p "prompt" --continue               # 跟随最近指针
darwin -p "prompt" --output-format json
darwin -p "prompt" --output-format stream-json
darwin trajectory list
darwin trajectory search "text" [--session <id>]
darwin trajectory replay <id> [--turn N] [--json]
darwin trajectory fork <id>
```

只用于 print 模式的选项：`--context-offload`、正整数 `--max-model-calls <n>`、`--compact-before`、`--output-format text|json|stream-json`。权限覆盖选项：`--permission-mode default|auto|plan|yolo`、`--yolo`。为兼容包管理器传参，位于开头的一个独立 `--` 会忽略。未知或非法参数语法返回 2。

## 斜杠命令与内置 skill 入口

`/` 补全会把以下命令与项目 skills、自定义命令一起列出。

| 命令 | 行为 |
|---|---|
| `/agents` | 当前运行的有界派发列表；只有元数据 |
| `/clear` | 创建后继会话；继承当前模式；丢弃队列 |
| `/compact` | 摘要较旧对话；由用户主动触发 |
| `/context` | 已知/估算的上下文大小；Bedrock 可能使用启发式 |
| `/effort [level]` | 查看或设置会持久化的模型思考强度 |
| `/exit`、`/quit` | 退出 |
| `/export <path>` | 精确 replay 投影；不覆盖，也不写会话内部 |
| `/help` | 有界本地命令、语法和按键；带参数会拒绝 |
| `/mcp` | 只读服务器状态/工具/配置路径；不重连 |
| `/memory`、`/memory list` | 含来源、证据、校验/过期原因的条目 |
| `/memory show <id|number>` | 查看一个有界条目 |
| `/memory remember <note>` | 添加经过筛查的用户项目备注 |
| `/memory forget <id/number/all>` | 删除/抑制条目并刷新当前 prompt |
| `/mode [mode]` | 查看/设置仅用户可改的当前权限模式；不持久化 |
| `/model [name]` | 列出/切换已配置模型，会话不断开 |
| `/permissions` | 当前放行规则及来源 |
| `/permissions revoke <n/rule/all>` | 同步收紧 gate 和磁盘规则 |
| `/status` | 只读汇总模型/缓存/强度/模式/MCP/skills/费用/上下文 |
| `/tasks` | 后台任务；忙碌时也可用 |
| `/trajectory` | 当前运行的本地记录状态 |
| `/usage` | 当前进程 token 分桶；未报告不等于零 |
| `/skill-name [request]` | 显式加载并发送一个 skill |
| `/developer <requirement>` | 监督一个完整、可持续的无头 worker |
| `/self-evolution-research` | 内置 skill：待办/研究/评分/受监督迭代循环 |
| `/self-reflection [session id]` | 内置 skill：基于轨迹复盘，达标建议进入 backlog |

`/help`、`/mcp`、`/permissions`、`/status`、`/tasks`、`/trajectory`、`/usage`、记忆管理等报告命令读取本地状态，不会把报告发送给模型；只有文档明确说明会更新当前 prompt 的变更命令例外。忙碌时 `/clear`、`/compact`、`/model`、`/exit`、`/quit` 会拒绝，普通输入进入队列。

## 输入语法

| 语法 | 行为 |
|---|---|
| `/prefix` | 补全内置/自定义命令和 skill |
| `@path` | 补全工作区路径；只插入文本，不插入文件内容 |
| `!command` | 用户授权的单次本地 shell 命令 |
| 普通文本 | 模型提示词；忙碌时排队 |

## 按键

| 按键 | 行为 |
|---|---|
| `Enter` | 有选中补全项时接受，否则发送或排队 |
| `Ctrl+J`、行尾 `\` + `Enter` | 插入换行；多行粘贴保留全部行 |
| `Tab` | 接受选中的补全项 |
| `Up` / `Down` | 先操作菜单，再取回队列、回看历史或移动多行光标 |
| `Escape` | 关闭当前补全菜单或结束历史回看；保留草稿和光标（权限框中仍表示拒绝） |
| `Home` / `End`、`Ctrl+A` / `Ctrl+E` | 移到可见行开头/结尾 |
| `Ctrl+K` / `Ctrl+U` | 删除到行尾/行首 |
| `Ctrl+W` | 删除前一个词 |
| `y` / `n` / `Esc` | 回答权限框；Esc 表示拒绝 |
| `a` / `A` | 权限框中的窄规则/整工具永久放行 |
| `Ctrl+B` | 收起/展开工具详情 |
| `Ctrl+C` | 忙碌时取消；2 秒内再按一次退出；空闲时直接退出 |
| `Ctrl+D` | 退出 |

权限框和压缩界面激活时拥有键盘与粘贴输入。补全菜单对方向键的优先级高于历史回看和光标移动。队列取回又优先于提示词回看。

## 报告命令约定

- `/status` 只读已有 accessor，不产生任何修改；未知指标显示为 `not reported`；名称列表用 `… N more` 控制长度。
- `/help` 只写一条有界历史通知，在忙碌队列判断前处理，不调用模型/工具/网络，也不改配置或会话。
- `/mcp` 不探测、不重连；工具名只来自已经注册的状态。
- `/context` 及阈值提醒只是建议。已知比例跨过阈值后，回合结束时只提醒一次 `/compact`；只有确认比例下降后才重新触发；未知估算保持安静。
- `/compact` 不会自动执行。SDK conversation manager 在溢出时仍可能按 `summaryRatio` 和 `preserveRecentMessages` 做摘要。
- `/export` 与离线 replay 使用完全相同的 formatter。
