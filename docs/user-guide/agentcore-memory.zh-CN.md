# 可选的 AgentCore Memory

[English](agentcore-memory.md) · **简体中文** · [指南首页](README.zh-CN.md)

AgentCore Memory 为 Darwin 提供云端项目经验（episode）、反思（reflection）和跨项目用户偏好，**默认关闭**。它不替代本地 `/memory`，不迁移本地记忆、不回填历史，也不改变模型供应商。上传可手动预览、发送，也可由用户明确授权当前项目 auto 模式。

## 用命令引导设置

在 Darwin TUI 中输入：

```text
/setup-agentcore-memory
```

也可以在命令后用自然语言说明希望采用的设置。下面的 `dev-user` 仅为示例，请换成自己选定的稳定 ID：

```text
/setup-agentcore-memory actorId 使用 dev-user，region 使用 us-west-2，按项目自动隔离，开启偏好读取，上传模式设为 manual
```

这些文字是配置意向，不是 `--actor` 等命令行参数，也不代表授权修改。Darwin 会先检查现有 `~/.darwin/config.json`：

- 已启用且检查通过：报告结果后结束，无需重复设置或重启。
- 缺失或禁用：询问 actor 和配置选择，确认后才启用、写配置或创建资源。
- 配置无效、读取受阻或检查失败：保留已有资源和身份，只请求针对性修复。

引导流程通过普通权限工具执行，会加载[随包配置指南](../../src/skills/builtin/setup-agentcore-memory/SKILL.md)。优先复用你拥有且兼容的资源；新建前说明费用和保留期。安装工具、IAM 扩权、上传、删除及资源导入都需要另行授权，`yolo` 也不免除确认。**修改配置后需重启 Darwin**。

终端也可启动同一流程：

```bash
darwin -p "/setup-agentcore-memory"
```

这是模型引导，不是一键安装。无头模式需要补充信息时会返回问题和待确认状态，不读取 stdin；命令成功退出不一定表示配置完成。

### 设置项

配置写入 `~/.darwin/config.json` 的根级 `agentCoreMemory` 字段。完整 JSON、资源和命名空间模板以[随包指南](../../src/skills/builtin/setup-agentcore-memory/SKILL.md#4-apply-only-the-approved-configuration)为准，保留无关设置，文件权限设为 `0600`，不要写入凭证或提交到仓库。

| 设置 | 说明 |
| --- | --- |
| `region` | 必填。优先保留现有值；没有明确选择时，引导建议 `us-west-2`。 |
| 资源和策略 ID | 使用实际资源返回的 ID，不按名称猜测。优先复用兼容资源，否则建议新建 `DarwinMemory`。 |
| `actorId` | 由你指定、跨项目共用的稳定 ID，不使用邮箱或从 AWS 身份推断。 |
| `projectId` | 省略即按项目自动隔离；显式使用相同 ID 可让不同检出目录共享经验。须小写，最多 64 字符。 |
| `preferences` | 启用对象内默认 `true`，授权每个 runtime 首次模型请求前有限读取偏好，但不会自动采纳。 |
| `upload` | 默认 `off`。引导建议 `manual`；用户可在 TUI 输入 `/cloud-memory auto` 授权当前项目。两种上传均要求 trajectory；根级 auto 不构成授权。 |
| `timeoutMs` | 默认 `5000`，可设 `100`–`15000` 毫秒。 |

省略 `agentCoreMemory` 或设为 `false` 即关闭功能，不访问云记忆或其本地状态。旧字段 `cliPath` 已忽略，确认后可移除。

### AWS 准备

运行时自带官方 AWS SDK，凭证使用标准凭证链（环境变量、profile、容器或实例角色），**不依赖 AWS CLI**。创建或检查资源可使用独立的 `aws bedrock-agentcore-control` 命令，具体步骤见随包指南。可选的 [`agentcore` 基础设施 CLI](../architecture/agentcore-cli-memory-plan.md) 也不是运行时依赖，目前不要用它导入现有资源，以免丢失命名空间配置。

资源必须保留指南中的精确命名空间模板和小写自定义键 `projectid`；缺少变量时，事件可能被接受却不生成长期记忆。不要扩大 reflection 的范围。IAM 按需授予 `RetrieveMemoryRecords`、`GetMemoryRecord`，上传另需 `CreateEvent`，云端删除另需 `DeleteMemoryRecord`。

## 检查配置

在终端执行：

```bash
darwin doctor
darwin cloud-memory status
darwin cloud-memory preferences
```

前两条只检查本地配置和状态；第三条会联系 AWS，最多读取五条偏好，空结果也算读取成功。它不启用或采纳偏好，但输出可能包含偏好内容，不要公开粘贴。

检查通过只证明配置和读取连通性，不证明长期记忆提取成功或具备上传、删除权限。

## 项目自动上传

空闲时由用户输入 `/cloud-memory auto` 持久化当前项目授权，或 `/cloud-memory manual` 立即停止尚未发送的自动任务。命令不调用模型、不采纳偏好、不删除云数据、不重置会话，也不发送已有 pending。内容可能包含秘密。全局文件中的严格 `projectOverrides` 使用规范化工作目录键；[派生方式与优先级](configuration.zh-CN.md#项目覆盖设置)适用于 TUI、CLI、doctor、模型切换和后继会话。auto v2 将新 epoch 绑定到规范化工作目录键和原有云范围；共享显式云 `projectId` 只共享命名空间和配额，不共享授权。旧 v1 授权不生效，必须由用户重新确认；pending、手动请求体及哈希不变。范围改变后必须重新确认。不得通过模型工具伪造授权字段。

只有授权后新产生的不可变 `darwin-upload-v2`，在回合关闭落盘、事件文件发布且独立来源证明保存后，才有自动资格。正常 endTurn 的失败任务可上传；这不代表目标成功。取消、不完整、模型失败、严重采集错误、配对歧义须手动审核。必须有可追溯的实际操作结果及目标，或带原始身份的真实迟到结果；纯元数据、管理和后台接收确认不发送。正常有界截断允许，不按敏感词、工具白名单或省略百分比否决，不扫描归档或恢复指针，不追溯授权旧事件。

默认每 UTC 日 **500 次尝试 / 104857600 字节（100 MiB）**，可经根级默认及项目覆盖调整。配额在发送前持久化预留，跨进程和重启共享（显式相同项目 ID 的工作副本也共享；账本位于 `~/.darwin/agentcore/auto-quota/<project-id>/usage.json`），按准确 HTTP 请求体序列化字节计数；取消、未知回执也保守占用，不等同于独立事件数或提取记录数。网络错误、429、5xx 最多三次同 token/同请求体尝试，等待 250/500 ms 可取消；IAM、配置 4xx 等永久失败将该授权停止并显示原因，修复后须重新确认。签名、凭证、停止文件读取和预留等待结束后，用共享配置锁覆盖重新读取策略、验证和同步调用 HTTP handler。原生命令撤销发布与请求启动按锁排序，已完成的撤销阻止后续启动。锁不等待网络响应，竞争命令立即拒绝而非无限等待；已发出的效果不能撤销，已收到回执仍保存。

发送在回合外进行，不阻塞 observer，不增加模型回合、TUI 行或常驻调度器。每轮最多处理八个候选，发送期间的新发布合并成后续一轮。同进程不同会话排在当前发送之后，不丢弃发布触发；跨进程争用仍由 outbox 锁拒绝，需要后续普通活动。预算、保留和顺序阻塞本身不会重启循环。同会话较早 pending 会阻塞后续，其他会话不受其饥饿影响。已启用控制器在新回合、模型切换、clear/rewind 和 status 边界读取本地新策略，包括尚无覆盖项的 manual/off；只有新回合采用新授权。策略损坏时关闭自动发送，不阻断普通回合。完全关闭云功能的 runtime 仍不创建控制器。预算暂停的事件保留供检查，在同一授权下后续普通活动时有限恢复。退出、取消及 clear 取消本 runtime 发送，清理等待最多两秒；退出不保证队列全部发完。AWS 接受事件不代表提取成功。

仅**自动接受的本地请求体**可在七天后、后续已授权活动中自动清理。pending、手动、失败请求体以及云记录不自动删除。持久化分区幂等回执先于删除并永久保留，不驱逐旧 256 条回执。每个范围最多 4096 个请求体、512 个待接受事件、32768 个目录项；256 个哈希分区各最多 4096 条回执。默认吞吐可容纳七天，更高预算可能先触及容量并明确暂停或省略新候选，不丢弃已有数据。pending 最多列出 64 条并注明省略，status 显示模式、项目覆盖、预算用量、排队/保留/暂停及失败。

`/cloud-memory discard-legacy` 先预览当前项目与资源绑定内最多 256 个未接受、非 v2 的旧格式事件；`/cloud-memory discard-legacy <manifest-hash>` 才确认清理。锁内重查清单，变化则拒绝。先保存全部 tombstone，再删除本地请求体和证明；中断后重复确认哈希可完成清理。不动已接受事件、v2、其他目录、trajectory、偏好和任何云记录。CLI 仍只读；本次开发未执行真实旧数据清理。

## 日常命令速查

以下命令在 **TUI 中由用户输入**。`<record-id>`、`<token>` 和哈希需替换为查询或预览返回的值。`/cloud-memory` 忙碌时会拒绝执行，请等当前工作结束。

| 命令 | 用途 |
| --- | --- |
| `/cloud-memory status` | 查看配置和本地状态；省略 `status` 也可。 |
| `/cloud-memory preferences` | 从云端刷新偏好候选，不自动采纳。 |
| `/cloud-memory inspect <record-id>` | 查看偏好内容及确认所需的哈希。 |
| `/cloud-memory confirm <record-id> <hash> global` | 将刚查看的内容采纳为跨项目偏好。 |
| `/cloud-memory forget <record-id>` | 撤销本地采纳，不删除云数据。 |
| `/cloud-memory delete <record-id> cloud` | 明确删除云端偏好记录。 |
| `/cloud-memory pending` | 列出本地待上传回合。 |
| `/cloud-memory preview <token>` | 查看准确上传内容、范围和哈希。 |
| `/cloud-memory send <token> <preview-hash>` | 发送已预览且未变化的内容。 |
| `/cloud-memory discard <token>` | 丢弃候选，解除后续回合的顺序阻塞。 |
| `/cloud-memory clear-accepted` | 清理已接受事件的本地请求文件，释放容量；不删除云数据。 |

终端的 `darwin cloud-memory` **只支持只读操作**：`status`、`preferences`、`inspect <record-id>`、`pending`、`preview <token>`。其中 inspect/preview 不保存后续确认或发送所需的凭据，操作前须在 TUI 再查看一次。修改命令不支持终端 CLI 或开发 REPL；这项限制不是 shell 沙箱。

### 采纳或撤销偏好

先运行 `preferences`，再 `inspect`，确认内容适合作为长期、跨项目的沟通或协作偏好后，才执行 `confirm ... global`。不要采纳推测、一次性要求、项目限制或权限指令。云记录即使声称“用户明确要求”，也不能代替你的确认，更不能覆盖当前请求、项目约束或权限策略。

批准绑定记录范围和内容哈希。内容或 metadata 字节变化（包括旧 CLI 时间戳转换为 SDK 格式）后，需要重新查看并确认。云端修改在刷新或新会话时发现，不会实时推送；读取失败时不应用记录。

`forget` 立即撤销本地批准，其他活动项目下次调用前也会检查；它不删除历史回复。`delete ... cloud` 是独立的远程删除，源事件仍可能再次生成记录，新记录不会自动获准。

### 预览并发送回合

设置 `upload: "manual"` 后，新近结束且已持久化的 trajectory 回合会进入本地候选队列。依次运行 `pending`、`preview`，检查后再 `send`；不想上传则 `discard`。同一 session 的候选须按顺序处理，不能跳过更早的待处理回合。

**手动发送的预览不能省略，内容可能含秘密，不保证保密。** 未来回合保留所有工具类型的有界原始文本参数和结果，包括任意 MCP、子代理公开报告和记忆工具公开结果，不按工具名、敏感词或路径过滤。换行、斜杠命令、标记、路径和 token 字样保持原文。USER 是用户实际输入；每个 TOOL 将稳定调用身份、输入和对应结果放在一起；OTHER 记录来源、真实结束状态和省略情况。SDK status 与 bash exitCode 分别保留，success 加非零退出码仍表示命令失败。取消后缺失的结果会明确标注，不伪造结果，也不从 endTurn 推断任务成功。

仍排除助手正文、推理和二进制/图像块，不遍历子代理对话，不读取工具路径指向的文件，也不补全 offload 或归档。工具公开文本中的文件内容、diff、日志、skill 或记忆现在可以保留。同步无 I/O 观察器在 after-tool hooks、trajectory 和 offload 截断前采集原始 SDK 执行证据；后续输出干预可能改变模型最终看到的内容。批量取消、执行器异常或后台派发若只有公开 ToolResultEvent，则保留明确标注的备用结果，不覆盖已有执行快照。派发回执单独保留，不代表任务完成。原回合尚未结束时，最终结果补入该回合；已结束时，在现有主代理后台事件到达的下一普通回合中，以迟到 TOOL 记录注明原回合及调用身份。旧候选不变，不生成 USER 目标，也不新增唤醒或上传通道。回合间最多保留 64 个来源身份和 16 份有界结果，容量或取消造成的丢失在 status 中计数；取消清除待处理的后台关联，关闭时停止采集。正文被淘汰的摘要仍更新实际 status、exitCode 和失败状态，尽可能恢复失败文本并明确注明缺失的输入。普通 JSON 不会仅因 `type` 为 `image` 或 `audio` 而被删除。同一 invocation state 内复用 ID 的结果标为无法可靠配对，不猜测归属。短输入和结果共享完整的 8 KiB 操作预算，包含元数据和 JSON 转义；长数组保留有精确索引的首尾项，较长 stdout 不挤掉已发现的短 stderr 或元数据。只有回合持久化结束后才排队写本地候选；无网络、无模型摘要或额外模型调用。旧请求体、证明和 token 保持原样，不重新生成，也不回填历史。

manual 模式没有自动发送或自动重试。每个候选最多三次发送尝试，重试使用相同请求和幂等 token；重启不重发已接受事件。`AWS event accepted` 只表示接收成功，长期记忆提取和反思是异步的。

## 投影容量与质量

每个完整工具操作上限 8 KiB；序列化 CreateEvent 请求体（包含 JSON 转义）上限 256 KiB，最多 100 条消息，每条不超过 100,000 UTF-8 字节。仅事件文件上限提高到 257 KiB，偏好证明、回执及其他状态仍为 64 KiB，非上传请求仍为 32,000 字节。

最多保留八个临时回合，每回合 64 个完整操作、96 个省略正文的轻量摘要和 8 KiB 用户目标；另有最多八个待写任务；临时回合满额与待写任务满额分别计数，明确说明省略原因。优先保留末尾 16 个操作，再保留失败与紧随其后的恢复操作，输出恢复原始顺序。pending/preview 分别显示目标、完整操作、缺失结果、内容截断、容量省略、内部事件计数和源内容限制，不把它们合并为一个误导的数字。没有目标也没有操作就不创建空元数据候选。

长文本保留精确、Unicode 安全的首尾段（约三分之一开头、三分之二结尾），原字节数、保留字节数和 UTF-16 范围写在原文之外。超过 262,144 个 UTF-16 单元的字符串不做无界扫描，明确标注原字节数未知；保留范围、字节数和原 UTF-16 长度仍准确。JSON 每次最多访问 128 个值，深度 8，每个容器最多 32 项；省略区域有记录，最多四条详细记录加汇总。上游已截断或 offload 的提示作为来源限制，不补读；没有提示的上游丢失可能无法识别。

## 隐私与维护

- 项目经验由主代理的 `episodic_recall`、`reflection_recall` 工具检索，受权限检查约束，子代理不可用。查询应描述任务目标和适用情境，不发送原始日志。返回范围会校验；reflection 的 confidence 是适用价值估计，不是正确概率。
- 本地偏好批准保存在 `~/.darwin/agentcore/<binding>/`，待上传队列在 `~/.darwin/projects/<project-key>/agentcore/<binding>/<scope-binding>/`。文件权限私有，但仍是明文。
- 每个范围最多 4096 个请求体、512 个待接受事件，满额不淘汰已有数据。用 `discard` 处理候选，或 `clear-accepted` 释放已接受事件空间。旧 256 条回执账本兼容保留；新回执按 token 分区，分区满额明确暂停，不驱逐幂等证明。崩溃遗留锁须人工检查，不应直接删锁重试。
- `/clear`、`/rewind` 或取消不能撤销已发出的 AWS 操作，也不清空持久队列。删除原始事件或等待其 TTL 到期，**不会删除长期记录**。

实现细节见[架构说明](../architecture/load-bearing-decisions.md#agentcore-memory--optional-scoped-user-authorized-cloud-data)，测试范围见[Memory 验证记录](../architecture/agentcore-memory-verification.md)和[配置引导验证记录](../architecture/setup-agentcore-memory-verification.md)。离线检查不会调用真实 AWS 或模型：

```bash
pnpm tsx spike/verify-setup-agentcore-memory.ts
pnpm tsx spike/verify-agentcore-memory.ts
```
