# 可选的 AgentCore Memory

[English](agentcore-memory.md) · **简体中文** · [指南首页](README.zh-CN.md)

AgentCore Memory 为 Darwin 提供云端项目经验（episode）、反思（reflection）和跨项目用户偏好，**默认关闭**。它不替代本地 `/memory`，不迁移本地记忆、不回填历史，也不改变模型供应商。上传始终需要手动预览和发送。

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
| `upload` | 默认 `off`。引导建议 `manual`，仅在本地暂存新回合，要求启用 trajectory，不自动发送。 |
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

**预览不能省略，内容可能含秘密，不保证保密。** 未来回合保留所有工具类型的有界原始文本参数和结果，包括任意 MCP、子代理公开报告和记忆工具公开结果，不按工具名、敏感词或路径过滤。换行、斜杠命令、标记、路径和 token 字样保持原文。USER 是用户实际输入；每个 TOOL 将稳定调用身份、输入和对应结果放在一起；OTHER 记录来源、真实结束状态和省略情况。SDK status 与 bash exitCode 分别保留，success 加非零退出码仍表示命令失败。取消后缺失的结果会明确标注，不伪造结果，也不从 endTurn 推断任务成功。

仍排除助手正文、推理和二进制/图像块，不遍历子代理对话，不读取工具路径指向的文件，也不补全 offload 或归档。工具公开文本中的文件内容、diff、日志、skill 或记忆现在可以保留。同步无 I/O 观察器在 after-tool hooks、trajectory 和 offload 截断前采集原始 SDK 执行证据；后续输出干预可能改变模型最终看到的内容。批量取消、执行器异常或后台派发若只有公开 ToolResultEvent，则保留明确标注的备用结果，不覆盖已有执行快照。派发回执不代表任务完成。同一 invocation state 内复用 ID 的结果标为无法可靠配对，不猜测归属。短输入和结果共享完整的 8 KiB 操作预算，包含元数据和 JSON 转义；长数组保留有精确索引的首尾项，较长 stdout 不挤掉已发现的短 stderr 或元数据。只有回合持久化结束后才排队写本地候选；无网络、无模型摘要或额外模型调用。旧请求体、证明和 token 保持原样，不重新生成，也不回填历史。

没有自动发送或自动重试。每个候选最多三次明确请求的发送尝试，重试使用相同请求和幂等 token；重启不重发已接受事件。`AWS event accepted` 只表示接收成功，长期记忆提取和反思是异步的。

## 投影容量与质量

每个完整工具操作上限 8 KiB；序列化 CreateEvent 请求体（包含 JSON 转义）上限 256 KiB，最多 100 条消息，每条不超过 100,000 UTF-8 字节。仅事件文件上限提高到 257 KiB，偏好证明、回执及其他状态仍为 64 KiB，非上传请求仍为 32,000 字节。

最多保留八个临时回合，每回合 64 个完整操作、96 个省略正文的轻量摘要和 8 KiB 用户目标；另有最多八个待写任务。优先保留末尾 16 个操作，再保留失败与紧随其后的恢复操作，输出恢复原始顺序。pending/preview 分别显示目标、完整操作、缺失结果、内容截断、容量省略、内部事件计数和源内容限制，不把它们合并为一个误导的数字。没有目标也没有操作就不创建空元数据候选。

长文本保留精确、Unicode 安全的首尾段（约三分之一开头、三分之二结尾），原字节数、保留字节数和 UTF-16 范围写在原文之外。超过 262,144 个 UTF-16 单元的字符串不做无界扫描，明确标注原字节数未知；保留范围、字节数和原 UTF-16 长度仍准确。JSON 每次最多访问 128 个值，深度 8，每个容器最多 32 项；省略区域有记录，最多四条详细记录加汇总。上游已截断或 offload 的提示作为来源限制，不补读；没有提示的上游丢失可能无法识别。

## 隐私与维护

- 项目经验由主代理的 `episodic_recall`、`reflection_recall` 工具检索，受权限检查约束，子代理不可用。查询应描述任务目标和适用情境，不发送原始日志。返回范围会校验；reflection 的 confidence 是适用价值估计，不是正确概率。
- 本地偏好批准保存在 `~/.darwin/agentcore/<binding>/`，待上传队列在 `~/.darwin/projects/<project-key>/agentcore/<binding>/<scope-binding>/`。文件权限私有，但仍是明文。
- 待上传队列最多 32 回合，满额不会自动淘汰。用 `discard` 处理不需要的候选，或用 `clear-accepted` 释放已接受事件的空间。回执账本最多 256 条，满后需人工归档；崩溃遗留的锁也须人工检查，不应直接删锁重试。
- `/clear`、`/rewind` 或取消不能撤销已发出的 AWS 操作，也不清空持久队列。删除原始事件或等待其 TTL 到期，**不会删除长期记录**。

实现细节见[架构说明](../architecture/load-bearing-decisions.md#agentcore-memory--optional-scoped-user-authorized-cloud-data)，测试范围见[Memory 验证记录](../architecture/agentcore-memory-verification.md)和[配置引导验证记录](../architecture/setup-agentcore-memory-verification.md)。离线检查不会调用真实 AWS 或模型：

```bash
pnpm tsx spike/verify-setup-agentcore-memory.ts
pnpm tsx spike/verify-agentcore-memory.ts
```
