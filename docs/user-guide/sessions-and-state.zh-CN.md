# 会话与状态

[English](sessions-and-state.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 快照存储与恢复

每轮结束后，会话会快照到 `~/.darwin/sessions/<project-key>/`；`last-session.json` 指向裸 `--resume` 应恢复的最近会话。状态按规范化后的仓库路径隔离，其他工作树的会话不会混入候选列表。

```bash
darwin sessions
darwin --resume <id>
darwin --session <id>
```

`darwin sessions` 完全只读、离线运行，只列出可恢复的快照，并按最近活动排序。每行包含 ID、距今时间、第一条已记录的用户提示词和 `(last)` 标记。轨迹关闭时显示 `(not recorded)`；损坏或不可用的条目会跳过并给出数量。列出会话不会写文件，也不会移动最近会话指针。无效或属于其他项目的 ID 会被拒绝，不会回退。指定恢复的会话只有在完成新回合后，才会成为裸 `--resume` 的目标。

TUI 恢复时，会在输入框出现前从该会话的原始轨迹中显示一份有长度上限的只读摘要，只包含最近一个完整的用户请求和助手答复。轨迹缺失、关闭、损坏或内容被省略都会明说。此过程不创建模型消息、不调用模型、不改文件，也不移动指针。新会话和无头模式不受影响。

`/clear` 通过同一个工厂创建后继 runtime，继承当前权限模式，退役旧 runtime，并重建会话级状态。新会话完成回合之前，不会改动磁盘上的指针。runtime 的 `AGENT_ID` 参与快照路径计算，修改它会让旧快照失去入口。

## 只追加轨迹

默认开启时，每轮都会向以下 JSONL 文件追加记录：

```text
~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl
```

内容包括本次运行的模型/模式、模型调用前持久化的用户输入、助手内容块、带上限的工具输入/结果、shell 命令记录，以及 `turnEnded` 中的结束/失败/取消状态、耗时、费用和未保存事件数。失败会保留错误类、消息和被包装的供应商错误类。子代理的对话和事件不会写入。

限制为：字符串最多 8,000 个 Unicode code point；单条记录最多 64 KiB；单会话文件最多 64 MiB。每次截断都会明确记录。思考内容只记录是否存在，不保存正文。已写入字节永不重写；中断只会留下有效前缀，读取器会报告末尾半行。记录失败时会放行主流程，并只提示一次。设置 `trajectory: false` 可完全关闭。

初始 `userInput` 在模型调用前有一个有界、失败时放行的落盘屏障；超时或写入错误不会替换供应商调用，也不会改变原错误。

## 离线轨迹命令

```bash
darwin trajectory list
darwin trajectory search "npm install"
darwin trajectory search "flaky test" --session <id>
darwin trajectory replay <id>
darwin trajectory replay <id> --turn 3 --json
darwin trajectory fork <id>
```

这些命令不调用模型、不访问网络，也不重新执行工具。`replay` 会重建用户提示、助手回复、工具状态/结果预览、失败信息和费用；不会还原 token 时序、思考内容、已截断字节或终端颜色。轨迹中包含失败回合并不代表读取失败，正常返回 0。可读记录中没有搜索结果时输出 `no matches` 并返回 0；会话根本没有轨迹时返回 1。

`fork` 会把快照、卸载文件和轨迹前缀复制到新 ID，源文件与最近会话指针保持不变：

```bash
NEW=$(darwin trajectory fork session-20260816-101112)
darwin --session "$NEW"
darwin -p "carry on" --session "$NEW"
```

`/trajectory` 在本地报告当前运行的文件、记录数/字节数、截断和问题。`/export <path>` 精确写出 `formatReplay(replayRead(...))`，拒绝覆盖已有文件，也拒绝写入 `~/.darwin/sessions/` 内部；没有轨迹时只提示无内容可导出。`/copy` 则把最近一条已完成回答的文本（与导出内容相同的纯文本）通过 OSC 52 放到剪贴板，不触碰轨迹。

## 用量与费用

`turnEnded.spend` 会标记 provider/model，并分别记录 `input`、`output`、`cacheRead`、`cacheWrite`。供应商未报告的字段保持缺失，展示为 `-`，合计时显示 `(+N unreported)`，绝不冒充零。只有实测为零才记录 `0`。切换过模型的会话会拆分合计，不会混用价目；旧记录显示 unknown。

```text
turn 3 spend: input=412 output=1350 cacheRead=130961 cacheWrite=398 · bedrock/global.anthropic.claude-opus-5
session spend: input=412 output=1350 cacheRead=130961(+1 unreported) cacheWrite=398(+1 unreported) over 2 turn(s)
```

这些数字来自 SDK 对回合的归因，不是账单。`/compact` 和溢出处理中的摘要调用绕过 meter，因此不会计入 `/usage` 或轨迹费用。回合编号会随进程重新从 1 开始，恢复后的记录可能包含多个 `turn 1`；合计按实际结束记录统计。

### 成本

`/status` 与 `/usage` 按当前模型的 LiteLLM 基础单价为本次运行的分桶计价——`cost  ≈ $0.0123 (base rates, LiteLLM)`；headless 运行则在 `usage:` 之后以一条 stderr 记录写出同样的数字：

```text
usage: input=412 output=1350 cacheRead=130961 cacheWrite=398
cost: total=0.0415 input=0.0008 output=0.0135 cacheRead=0.0262 cacheWrite=0.0010 model=global.anthropic.claude-sonnet-5 pricing=global.anthropic.claude-sonnet-5
```

这只是估算：仅用基础档单价（不含长上下文或 1 小时缓存价目），即使中途 `/model` 切换也按当前模型的单价乘以整个进程的 meter，摘要调用因为 meter 不计而不计入。未报告的分桶绝不按 0 计价——TUI 显示下限（`≥ $0.0030 (cacheRead not reported, cacheWrite not reported; …)`），headless 则把该分桶和 `total` 都写成 `-`。`pricing=` 给出单价所用的 LiteLLM key，或 `none`（LiteLLM 没有该模型）/ `unavailable`（价目表尚未获取——离线，或后台下载还没完成）。

单价来自 `~/.darwin/model-prices.json`，其中只保存每个模型 id 解析后的映射（绝不保存整张表）：文件已知的模型不会再次下载；未知 id 会在启动或 `/model` 时触发每进程一次的后台获取；LiteLLM 没有列出的 id 会被记录为无价格，避免每次启动重试。删除该文件即可刷新价格。`DARWIN_MODEL_PRICES_FETCH=off` 可完全关闭下载。

## 项目记忆

轨迹可用时，记忆默认开启并存于工作树外：

```text
~/.darwin/projects/<project-key>/memory/
├── state.json       # 严格、带版本的权威状态
└── index.md         # 可选的人类可读投影
```

只有父 agent 能调用 `memory_recall` 和 `memory_save`，子 agent 不会获得这两个工具。Recall 在当前已校验条目上做有界、本地、确定性的词法排序，结果明确标为可能出错的数据而非指令或策略；它不调用网络、向量、embedding 或隐藏模型，也不会把完整归档常驻注入每次 prompt。

Save 走普通写权限。项目事实必须提供一条精确的当前项目相对源码行；明确用户偏好和非敏感账户身份必须引用当前用户输入中的精确文本。保存先暂存，只有同一回合以成功且轨迹已落盘的 `endTurn` 结束后才会持久化。失败、取消、部分输出、轨迹退化或落盘接受前 `/clear` 都会丢弃暂存。生成事实仍受 `memoryHorizonDays`（默认 28 天；`0` 只关闭时间过期）控制，并在 recall 时重新校验。

本地管理和审计命令为：

```text
/memory
/memory show <id|number>
/memory remember <note>
/memory forget <id|number|all>
```

`remember` 会原子拒绝疑似密钥、prompt 边界标记、dump 和超长备注。`forget` 会抑制生成 ID，防止完全相同的已忘记事实重新出现。不可读、伪造、项目不符或通过符号链接逃逸的 store 会被拒绝；校验/提交问题只产生提示。记忆不会重写轨迹、快照、指针、配置或仓库文件。

## 诊断日志

设置 `{ "diagnostics": true }` 后，SDK 的 `debug`/`info`/`warn`/`error` 与 darwin 通知会追加到：

```text
~/.darwin/sessions/<project-key>/<session-id>/diagnostics.log
```

它默认关闭，因为供应商 payload 可能引用会话内容。字段未设置时，不做格式化，也不会创建文件。日志适合 `tail -f`，可用来查看限流、cache point 放置、token 统计降级和 MCP 重命名。

限制为：每行 8,000 个 Unicode code point；每会话 8 MiB；待写队列 1 MiB。达到文件上限时会写入一条结束说明；输入过快时丢弃并统计诊断行，不会丢 stream event 或阻塞代理。写入失败只提示一次。日志不会自动删除。SDK warning 会出现两次，一次来自 SDK，一次来自 darwin 通知。SDK logger 是进程级的，因此会包含子代理诊断；轨迹仍不包含子代理事件。

## 其他状态路径

```text
~/.darwin/config.json                                  全局模型/会话配置
~/.darwin/sessions/<project-key>/                      快照、轨迹、诊断、任务、卸载结果
~/.darwin/projects/<project-key>/permission-rules.json 项目放行规则
~/.darwin/projects/<project-key>/memory/                项目记忆
```

卸载结果和后台日志需要在恢复后继续解析引用，因此会一直保留。当前没有会话垃圾回收，请自行删除已经结束的会话目录。旧版项目侧规则/会话可能作为迁移源读取，并在首次写入或恢复时复制到用户状态；仓库文件不会改动。
