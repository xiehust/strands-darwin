# 权限

[English](permissions.md) · **简体中文** · [指南首页](README.zh-CN.md)

## 导入设置不代表授权

`darwin import --from claude-code [--apply]` 永远不写 hook、MCP 配置、权限规则或 `trust.json`。输出的少量准确 JSON 片段仅供人工检查，不是完整策略转换。不支持的 `ask`/deny 规则、工具限制及含敏感信息的配置会明确列为遗漏；不要忽略这些限制而直接粘贴 allow 片段。确认后只向指定的项目级规则文件合并数组，保留原有 deny 规则。Claude 全局权限没有对应的 Darwin 全局规则存储。根目录 `.mcp.json` 仍按既有机制作为启动回退并接受 workspace trust 检查；导入提示词既不授予也不撤销信任。详见[迁移映射](extensions.zh-CN.md#迁移-claude-code-设置)。

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
| 目标解析后落入下文敏感路径集合的读取——`fileEditor view`，或 `cat`/`head`/`tail`/`grep`/`rg`/`find`/`ls`/`wc` 的任一非选项参数 | 否——权限框会指出该路径；包括 `plan` 在内的所有模式都会询问；没有任何放行规则能覆盖它，也不会提供规则选项 |
| 项目内 `fileEditor` 写入，但不包括 `.git/`、`.env*` 和敏感 Darwin 策略/配置 | 普通模式下是；`plan` 中拒绝 |
| 每个命令段都以只读白名单命令开头（`git status/log/diff/show/branch`、`ls`、`cat`、`grep`、`rg`、`find` 等），且无重定向/替换的 bash | 是 |
| 白名单命令带有已知的写操作选项——`find` 带 `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/`-fprint*`/`-fls`；`git branch` 带 `-d`/`-D`/`-m`/`-M`/`-c`/`-C`/`-u`（包括 `-Df` 这类合并短选项）、`--delete`/`--move`/`--copy`/`--set-upstream-to[=…]`/`--unset-upstream`/`--edit-description`；`git log`/`diff`/`show` 带 `--output[=…]` | 否——权限框会指出该选项 |
| 其他全部调用，包括所有 MCP 工具 | 否 |

白名单按命令段逐段判定：`git status && git branch -D main` 会因为后半段而询问。这是纯白名单：解析不确定时多问一次，不会静默放行。`plan` 允许读文件、加载 skill、查询后台任务和委派；拒绝文件修改、带命令的 bash 以及未知/MCP 工具。它在 `PreToolUse` 之前拒绝，因此被拦截的操作不会触发项目 hook 命令。磁盘上的规则仍保留，但会显示为已忽略。

拒绝不算工具错误。模型收到的是用户拒绝结果，并被要求不要重试或绕过。

### 敏感路径读取

读取同样走白名单，但有一组固定路径永远不会被静默读取：`~/.ssh/`、`~/.aws/`、`~/.gnupg/` 之下的任何内容（目录本身也算）、`~/.netrc`、`~/.kube/config`、`~/.docker/config.json`、`/etc/shadow`、任何位置上名为 `.env` 或 `.env.*` 的文件，以及 Darwin 自身的配置、hook 和权限规则文件。路径按 shell 的方式解析（`~`、`~/`、`$HOME`、`${HOME}`、相对与绝对形式、`..` 会被归一化），因此 `cat ~/.ssh/id_rsa`、`head $HOME/.aws/credentials` 和 `fileEditor view ../../.netrc` 都会以 `reads a sensitive path: <path>` 询问。`plan` 模式下敏感的 `fileEditor view` 是询问而非拒绝，因为它仍然是读操作（带命令的 bash 仍像以前一样在 `plan` 中被拒绝）；`auto` 绝不会把它交给分类器，而是直接询问；无头运行中该询问表现为 `permission denied`。仅对 `grep` 和 `rg`，从凭据位置的上级目录开始搜索（`grep -r AKIA ~`、`rg -uu secret /`、`grep -r k /etc`）同样视为读取它，并以 `reads a sensitive path: ~ (searches above ~/.ssh)` 询问；`.env*` 文件不在这条上级目录规则之内，因此含有 `.env` 的项目里 `grep -r foo .` 仍然静默。其余读取——`cat README.md`、`ls ~/.ssh/../`、`.envrc`、`/etc/os-release`——和以前一样静默放行。`echo` 不算读取器：重定向和命令替换已被拒绝，它只能打印参数。判定标准是这组固定集合，而不是「项目之外」，因为 Darwin 会合法地读取 `/tmp`、`/etc/os-release` 和全局 skill 目录。

与路径集合并列的是环境变量：`echo $ANTHROPIC_API_KEY` 和 `cat /proc/self/environ` 是只读命令，会静默放行，但它们泄露不了 darwin 自己的凭据——模型启动的 shell 一开始就不会继承形似凭据的变量：名字中含有 `KEY`、`SECRET`、`TOKEN`、`PASSWORD` 或 `CREDENTIAL` 的变量都不会传给持久 `bash` shell 和 `bash start` 任务，父代理和每个子代理都一样，只有配置里的 `shellEnv.passthrough` 能恢复某个名字（见 [Shell 环境变量](configuration.zh-CN.md#shell-环境变量)）。这不是权限判定，任何规则或模式都改变不了它；你自己的 `!` 命令、hook 和 MCP 服务器仍使用你的环境。

## 分类器辅助的 `auto`

静态安全规则和显式放行规则都未命中时，`auto` 会把调用交给低成本模型（默认 Haiku，可用 `classifierModel` 替换）。安全判定直接执行；不安全、超时、抛错或无法解析时，都退回用户权限框，并显示分类器理由。分类器不会自动拒绝。

切换模式会撤回进行中的权限框或分类结果，从头重新判断，并有次数上限，避免来回抖动。取消会拒绝等待中的权限请求；runtime 关闭后，bridge 会锁定为拒绝状态。

## 权限框与 diff

权限框会标明风险和来源：

```text
permission required (execute — `curl` is not on the safe-command list)
[explorer#a1b2c3d4] bash: curl https://example.com
allow? y n always: a=review rule A=review tool esc=deny
```

`[parent]` 表示主代理；`[agent#dispatch]` 标识某次子代理调用。即使多个读型子代理并行执行，权限框仍会串行出现。

`fileEditor` 权限框显示有长度上限的行 diff，由工具参数中的旧/新文本直接计算。去掉 ANSI 后，标记仍然存在；批准时使用的是未截断原文。由于它不会重新读取磁盘，外部并发修改可能让展示的提案和最终落盘效果不同。

## 记住一次选择

- `y`：只批准本次调用。
- `n` 或 `Esc`：拒绝。
- `a`：预览当前提议的窄规则；`A`：预览整个工具的规则。此时尚未放行或保存。
- 预览中，按 `Enter` 逐页阅读完整规则，最后一页再按一次才保存并批准。`b` 返回权限框、不作答；`y` 仍只批准本次调用，`n`/`Esc` 拒绝，`Ctrl+C` 取消。

预览沿用权限框的行数预算，不增加屏幕区域。它显示由本次工具名及原始输入生成的完整规则，采用 ASCII JSON 字符串形式，例如 `"bash:curl\u0020*"`：空格显示为 `\u0020`，避免行首行尾空白消失；引号、反斜杠、Unicode 和控制字符也以 JSON 转义显示，不执行终端控制序列。拼接各页规则行并按 JSON 解码，得到的就是实际保存的字符串。长规则必须逐页查看；改变终端尺寸会从头预览。终端放不下规则和按键提示时，保存被禁用，扩大窗口后才能继续。请求被撤回或替换后，旧预览失效。

保存提示会指出规则及规则文件；写入失败则说明仅本会话生效。用 `/permissions` 查到编号，再用 `/permissions revoke <n>` 撤销。预览不改变规则语法、建议范围、敏感路径豁免或拒绝规则优先级。

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

## 只测试候选规则，不授予权限

在项目目录运行 `darwin permissions test 'bash:pnpm *'`，或在 TUI 输入
`/permissions test bash:pnpm *`（忙碌时也可用）。CLI 的规则必须是一个 shell 参数，
需要时加引号；TUI 直接读取后面的整段规则，不加 shell 引号。内部空格、换行、冒号和
shell 元字符按原有语法处理。缺失、空白、非法规则及多余 CLI 参数在本地报用法错误
（退出码 2）；有效报告即使证据不可用也以 0 退出。候选规则上限为 2,000 码点，没有 `add` 命令。

报告列出原解析器的结果、已记录的 `(toolName, input)`、候选放行规则是否匹配，以及哪条
当前拒绝规则优先。它只是**匹配结果，不是执行许可**：不会模拟 safe/plan/yolo、hook 或
其他 gate 策略。不执行工具、hook、模型或网络操作，不授予或撤销规则，也不改配置、
trajectory、快照、恢复指针或当前 gate。

范围会明确打印：CLI 仅读取当前项目的 trajectory 目录，按会话 id 逆字典序最多检查 20 个，
拒绝规则来自用户私有的 `~/.darwin/projects/<project-key>/permission-rules.json`。
不加载全局配置或旧式策略；文件缺失或损坏时拒绝优先级为未知。TUI 只读当前会话已落盘的
trajectory 和当前拒绝规则的副本。两条路径都不读其他项目、offload 内容、快照或实时工具输入。

证据本来就可能不完整：每文件最多 2 MiB、合计最多 8 MiB，超限文件跳过而非悄悄截短。
缺失、损坏、停止记录、截断、脱敏和占位输入均明确说明，不恢复原文。禁用期间、子代理输入
以及忙碌回合尚未落盘的事件可能缺失，因此不会声称覆盖完整历史或完整无匹配。
同一会话内重复的精确调用对合并显示。最多显示 20 行，每个字段转义后最多显示 240 码点；
省略行数与显示截断均注明。匹配始终使用完整的已记录输入，而不是预览文本。

## 拒绝规则

同一文件还可以有第二个数组 `deny`，语法完全相同。拒绝规则是你写下一次就一直生效的禁令：在所有模式下（包括 `yolo`）、对主 agent 及每个子代理和 workflow 节点都生效，并优先于任何匹配的放行规则——无论该放行规则来自配置还是本会话内授予。

```json
{
  "allow": ["bash:pnpm *"],
  "deny": ["bash:git push --force*", "bash:*curl*", "fileEditor:dist/**", "http_request"]
}
```

拒绝规则在一切可能放宽调用的环节之前判定——先于 plan 守卫、`yolo`、静态安全名单、放行规则和分类器——因此被拒绝的调用不会弹出询问、不会进入分类器，也不会触发 `PreToolUse` hook。匹配方式是放行规则的保守反向：bash 拒绝规则只要**任一**串联命令段匹配即生效（`bash:git push --force*` 会拒绝 `git status && git push --force`）；重定向和命令替换永不豁免（`echo $(git push --force)`、`git push --force > log`、`(git push --force)` 都会被拒绝——其内部内容同样算作命令段）；放行侧的例外不适用，所以 `.env*` 写入、`memory_save` 以及 darwin 自身的策略文件同样可以被拒绝。文件 pattern 覆盖该路径上的所有 `fileEditor` 调用，包括 `view`。pattern 锚定在命令段开头，要在命令段任意位置捕获 `curl`，写 `bash:*curl*`。

模型会收到一条指明规则的错误——`blocked by deny rule bash:git push --force*`——要求它不要重试或绕过，而是告诉你。权限框永远不会提供拒绝规则，会话内也永远不会授予：修改拒绝规则只能编辑文件，并在新会话中生效。非法条目会像 `allow` 一样成为指明该条目的启动错误。

## 规则安全与撤销

bash pattern 必须匹配每个串联命令段；`pnpm build && rm -rf /` 不匹配 `bash:pnpm *`。带重定向或命令替换的内容永不匹配规则。任何规则都不能覆盖 `~/.darwin/config.json`、项目权限文件、启用中的 hook 文件/目录或 `.env*` 写入，也不能覆盖对上文敏感路径集合的读取，否则代理可能扩大自身权限。已经静态安全的调用不会显示一个实际无效的规则选项。（以上均指放行规则；拒绝规则按上文所述反向处理。）

普通 `y` 不会暗中保存规则。`/permissions` 会列出所有生效的放行规则并区分来自磁盘还是当前会话，随后以 `deny (configured)` 列出每条拒绝规则。`/permissions revoke <n|rule|all>` 会同步把放行规则从 gate 和文件中删除，下次调用重新询问，重启后也不会复活；它拒绝撤销拒绝规则，因为那会放宽权限——请改文件。该命令只能收紧权限；新增规则仍只能来自权限框（放行）或文件（拒绝）。`/status` 分别统计放行与拒绝规则数。可以手工编辑 JSON，但非法规则会导致启动错误。

## 工作区信任

克隆下来的仓库是不可信输入，而一份 checkout 里有三类东西原本会在 darwin 启动的一瞬间就*执行或授权*：钩子命令文件（`.darwin/hooks.json`、`.darwin/hooks/*.json`、`.agents/hooks.json`、`.agents/hooks/*.json`，或已提交的 `.darwin/config.json` 里的 `hooks` 键）、`.darwin/mcp.json` 或根目录 `.mcp.json` 声明的 MCP 服务器（每个 stdio 条目都是一个在你第一条提示之前就被拉起的进程），以及已提交的 `.darwin/config.json` 里的旧式 `permissionRules`。自 SER-090 起，这三类东西在你同意之前都不会被启用。

在一个 checkout 声明了其中任何一项的项目里首次交互式启动时，darwin 会在运行时存在**之前**——也就是钩子还没机会运行、服务器还没机会拉起、规则还没机会生效之前——显示一个模态框。它写出项目根目录，并逐项列出 checkout 将要启用的内容：每个钩子文件及其方言和各事件的命令数、每个 MCP 服务器及其命令与参数（或 URL）和声明它的文件、旧式规则文件及其 allow/deny 数量。无法解析的钩子或 MCP 文件会被列为“unreadable”——它仍然是 checkout 携带的东西。按 `y`（或 Enter）接受；`n` 拒绝；Escape 只对本次会话拒绝且不写入任何记录，下次启动会再问一次。

答案存放在 `~/.darwin/projects/<key>/trust.json`，形如 `{ "trusted": true|false, "decidedAt": "<ISO 时间>" }`——与 `permission-rules.json` 同一个用户私有项目目录，位于仓库之外，因此仓库里提交的文件不可能替克隆授予自己信任（checkout 内的 `.darwin/trust.json` 永远不会被读取）。已存的答案在之后每次启动时静默生效；删除该文件即可重新被询问。文件格式损坏时视为“尚无决定”，附一条有界提示，绝不崩溃。

拒绝（或 Escape）后会话照常开始，但仓库提供的这些层被**保留不用**：那些文件里的钩子命令一条都不运行，项目 MCP 服务器一个都不拉起，旧式项目 allow/deny 规则一条都不授予，权限框里的“总是允许”也不会把已提交的规则复制进你的用户私有文件。转录中会有一条提示说明被保留的内容；`/status` 在 `mcp` 与 `hooks` 行追加 ` · N held (untrusted project): …`；`/mcp` 把每个被保留的服务器列为 `held (untrusted project)`，且不会尝试连接。`/clear` 或 `/rewind` 的后继会话继承这一决定。所有用户私有的内容仍照常加载——`~/.darwin` 与 `~/.agents` 的钩子、`~/.darwin/mcp.json`、你自己的 `permission-rules.json`——而 skills、自定义命令与 `AGENTS.md` 属于提示内容而非执行，因此从不进入这道门。没有声明这些文件的项目不会看到任何变化。

无头模式（`-p`）从不弹出对话框。已存的 `trusted: true` 直接生效；没有决定或 `trusted: false` 时，这些层被保留，文本输出在 stderr 写一行 `trust:` 说明保留了什么，结构化输出在 `run.started.trust` 中携带 `{ "state": "trusted"|"untrusted"|"undecided", "held": [...] }`。信任像 darwin 的其他路径一样以项目根目录为键，而不是 git 状态；它不新增第二条权限通道，也不改变面向模型的敏感路径分类。

## 无头模式与本地命令

无头模式没有交互 bridge：未被静态安全或持久规则放行的调用会立即拒绝。需要时应显式选择 `auto`/`yolo`。

`!<command>` 由用户直接输入，不属于模型调用，因此不经过该 gate，并可在 `plan` 中运行；详见[使用 darwin](using-darwin.zh-CN.md)。模型后续请求的命令仍受 gate 保护。

## 审计记录

gate 每裁定一次调用，都会在会话轨迹中写入一条 `permissionDecision` 记录（见[会话与状态](sessions-and-state.zh-CN.md)）：由哪一级裁定（`safe`、`allow-rule`、`classifier`、`yolo`、`user-approved`、`user-denied`、`deny-rule`、`plan-denied`、`write-scope-denied`、`restart-limit-denied`）、当时生效的模式、是否向你发起了确认、匹配或授予的规则、子代理发起时的子代理标签，以及该调用的 `toolUseId`——绝不含工具输入，因为该调用自己的记录已经保存了它。它只写日志：模型、工具结果、屏幕和无头输出都不变，也没有任何配置项。`darwin trajectory replay` 与 `/export` 只为向你发起过确认或被拒绝的调用打印一行 `permission · <tool> · …` 提示；静默放行不打印任何内容。读取记录不需要调用模型。
