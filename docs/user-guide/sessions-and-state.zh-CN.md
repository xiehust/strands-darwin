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

### Rewind 与 tangent

`/rewind`（或在空闲且为空的输入框上连按两次 `Esc`）列出本会话已完成提示词的检查点——每条模型跑完了回合的纯文本提示词（无论是回答了它，还是以拒绝类停止原因拒绝了它）在运行前都会留下一个不可变的 SDK 快照，每个会话最多 100 个——接受其中一个，就把对话分支到一个恢复到该边界的新后继会话；所选提示词回到编辑器但不发送，来源会话仍留在磁盘上、可恢复且逐字节不变。失败或被取消的回合不留检查点。被拒绝的提示词是有意列出的：被拒绝的回复会留在对话里，可能让接下来的提示词以同样方式失败，所以拒绝提示会指向这里——回退到那条提示词，就能在改写之前把被拒绝的那次交换移除。只有对话会移动：工作区文件、shell 与 `!` 的效果、hooks、MCP 写入、子代理、后台任务和已学习记忆都不会回滚，提示里会明说。

`/tangent` 是同一条路径上的书签，专为"先问点旁边的事，再回来"这一常见场景。裸 `/tangent` 先武装；你接下来发送的那条提示词开始它，该提示词的检查点就是返回点（标题栏显示 `tangent since prompt N`，N 是该提示词在本会话已编目提示词中的序号，`/status` 多出一行 `tangent`）。再输入 `/tangent`（或 `/tangent end`）即返回：同样的后继会话、同样的省略说明，外加 `returned from tangent — N prompt(s) discarded`，其中 N 统计自武装以来已编目的提示词，含返回点那一条——在 tangent 内发送了 A、B、C 三条后显示 `3 prompts discarded`。不会把任何内容放回编辑器：你要的是返回，不是重发。只有一层，不命名，没有选择器（选择器就是 `/rewind`；进行中再 `/tangent start` 会被拒绝）。如果武装后的第一条提示词无法编目——附带了图片、是后台任务唤醒、回合失败或被取消、检查点容量已满——tangent 会立即结束并说明原因。在那之前输入 `/tangent end` 只是解除武装。tangent 与权限模式一样是 TUI 当前会话状态：不持久化、不记录，`/clear` 或接受一次 `/rewind` 会以 `tangent ended by …` 结束它，恢复的会话里不存在，无头模式和 dev REPL 中不可用。

## 只追加轨迹

默认开启时，每轮都会向以下 JSONL 文件追加记录：

```text
~/.darwin/sessions/<project-key>/<session-id>/trajectory.jsonl
```

内容包括本次运行的模型/模式（由 `/rewind` 分支出的会话，其运行记录还会写明来源会话和快照 id；`replay` 在该运行的标题行打印为 `rewound from <session> snapshot <id>`，恢复摘要也会重复这一句）、模型调用前持久化的用户输入、助手内容块、带上限的工具输入/结果、权限门每判定一次工具调用就写入的一条 `permissionDecision`（由哪一级裁定——`safe`、`allow-rule`、`classifier`、`yolo`、`user-approved`、`user-denied`、`deny-rule`、`plan-denied`、`write-scope-denied`、`restart-limit-denied`——当时生效的模式、是否向你发起了确认、匹配或授予的规则、子代理发起时的子代理标签，以及该调用的 `toolUseId`；绝不含工具输入，因为该调用自己的记录已经保存了它）、shell 命令记录，以及 `turnEnded` 中的结束/失败/取消状态、耗时、费用和未保存事件数。失败会保留错误类、消息和被包装的供应商错误类。子代理的对话和事件不会写入（唯一例外是子代理的权限判定，会带上其派发标签）。权限记录只写日志：模型和屏幕看到的内容完全不变。

限制为：字符串最多 8,000 个 Unicode code point；单条记录最多 64 KiB；单会话文件最多 64 MiB。每次截断都会明确记录。思考内容只记录是否存在，不保存正文。已写入字节永不重写；中断只会留下有效前缀，读取器会报告末尾半行。记录失败时会放行主流程，并只提示一次。设置 `trajectory: false` 可完全关闭。

初始 `userInput` 在模型调用前有一个有界、失败时放行的落盘屏障；超时或写入错误不会替换供应商调用，也不会改变原错误。

交互界面的 `Ctrl+S` [草稿暂存](using-darwin.zh-CN.md#草稿暂存)只属于当前输入框，不是会话快照或轨迹记录。取回并正常提交之前，暂存内容不会进入恢复记录、回放、导出、历史回看或记忆。切换 `/model` 和执行 `/compact` 会保留它；成功清空会话、通过 rewind/tangent 创建后继会话或退出时，会丢弃并提示。

## 离线轨迹命令

```bash
darwin trajectory list
darwin trajectory search "npm install"
darwin trajectory search "flaky test" --session <id>
darwin trajectory replay <id>
darwin trajectory replay <id> --turn 3 --json
darwin trajectory fork <id>
```

这些命令不调用模型、不访问网络，也不重新执行工具。`replay` 会重建用户提示、助手回复、工具状态/结果预览、失败信息、费用，每次成功的 `/compact`——一行 `context compacted: 12 → 5 messages` 提示（只有消息数和可选的压缩前估算值，绝不含摘要或 focus 文本；其后的第一次模型调用显示 `context: reset by compaction`，而不是 SDK 过时的估算），以及每一次向你发起确认或拒绝调用的权限判定——紧挨在被判定的工具行之前的一行提示：`permission · bash · denied by deny rule bash:git push --force*`、`permission · fileEditor · approved by user (rule granted fileEditor:src/**)`，子代理的调用则如 `permission · bash · denied by user · explorer#d1`；静默放行（`safe`、`allow-rule`、`classifier`、`yolo`）不打印任何内容，因此没有确认也没有拒绝的会话重放结果与以前完全一致；不会还原 token 时序、思考内容、已截断字节或终端颜色。轨迹中包含失败回合并不代表读取失败，正常返回 0。搜索可按工具名、判定结果或规则找到权限判定。可读记录中没有搜索结果时输出 `no matches` 并返回 0；会话根本没有轨迹时返回 1。

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
session cost: ≥ $0.0415 (cacheRead partly reported, cacheWrite partly reported; base rates, LiteLLM)
```

`trajectory list` 与 `trajectory replay` 也会离线为记录计价，单价来自实时会话填充的同一个 `~/.darwin/model-prices.json`——每个模型按各自缓存的单价计算。`list` 在每行会话后追加一段 `cost: …`；`replay` 在 `session spend:` 下方打印 `session cost:`，若不止一个模型参与，还在每个模型的 token 行后给出该模型自己的金额。缓存不认识的模型视为*未计价*：合计变成指明该模型的下限（`≥ $3.1250 (2 models; no price for us.made-up.model; …)`），绝不算作 0，也绝不省略；只有部分轮次报告的分桶按已报告部分计价并标注 `partly reported`；没有记录 spend 的轮次同样让合计成为下限（`N turn(s) unknown`）。没有缓存文件时显示 `cost: unknown (price unavailable)`。读取记录绝不会下载或写入价格；`/export` 完全不含成本行——导出的文稿只取决于记录本身。

这些数字来自 SDK 对回合的归因，不是账单。`/compact` 和溢出处理中的摘要调用绕过 meter，因此不会计入 `/usage` 或轨迹费用。回合编号在同一份轨迹文件内唯一：恢复运行会从文件中已有的最大 `turn` 继续编号，因此 `--turn N` 只选中一个回合（在此之前写下的记录仍可能包含多个 `turn 1`）；合计按实际结束记录统计。

### 成本

`/status` 与 `/usage` 按 LiteLLM 基础单价为本次运行的分桶计价，**每个模型用各自的单价**——`cost  ≈ $0.0123 (base rates, LiteLLM)`；headless 运行则在 `usage:` 之后以一条 stderr 记录写出同样的数字：

```text
usage: input=412 output=1350 cacheRead=130961 cacheWrite=398
cost: total=0.0415 input=0.0008 output=0.0135 cacheRead=0.0262 cacheWrite=0.0010 model=global.anthropic.claude-sonnet-5 pricing=global.anthropic.claude-sonnet-5
```

这只是估算：仅用基础档单价（不含长上下文或 1 小时缓存价目），摘要调用因为 meter 不计而不计入。`/model` 切换后，每个模型的 token 按该模型自己的单价计价：该行会标出模型数（`≈ $4.6250 (2 models; base rates, LiteLLM)`），`/usage` 在其下方为每个模型各加一行，混合中若有模型没有价格，数字就变成指明该模型的下限（`≥ $3.1250 (2 models; no price for <id>; …)`）；此时 headless 写出 `model=2-models pricing=mixed`。未报告的分桶绝不按 0 计价——TUI 显示下限（`≥ $0.0030 (cacheRead not reported, cacheWrite not reported; …)`），headless 则把该分桶和 `total` 都写成 `-`。`pricing=` 给出单价所用的 LiteLLM key，或 `none`（LiteLLM 没有该模型）/ `unavailable`（价目表尚未获取——离线，或后台下载还没完成）。子代理使用父级当前模型，按其单价计价。

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
~/.darwin/projects/<project-key>/permission-rules.json 项目放行与拒绝规则
~/.darwin/projects/<project-key>/memory/                项目记忆
```

卸载结果和后台日志需要在恢复后继续解析引用，因此会一直保留。当前没有会话垃圾回收，请自行删除已经结束的会话目录。旧版项目侧规则/会话可能作为迁移源读取，并在首次写入或恢复时复制到用户状态；仓库文件不会改动。
