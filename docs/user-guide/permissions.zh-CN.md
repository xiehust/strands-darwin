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
| 目标解析后落入下文敏感路径集合的读取——`fileEditor view`，或 `cat`/`head`/`tail`/`grep`/`rg`/`find`/`ls`/`wc` 的任一非选项参数 | 否——权限框会指出该路径；包括 `plan` 在内的所有模式都会询问；没有任何放行规则能覆盖它，也不会提供规则选项 |
| 项目内 `fileEditor` 写入，但不包括 `.git/`、`.env*` 和敏感 Darwin 策略/配置 | 普通模式下是；`plan` 中拒绝 |
| 每个命令段都以只读白名单命令开头（`git status/log/diff/show/branch`、`ls`、`cat`、`grep`、`rg`、`find` 等），且无重定向/替换的 bash | 是 |
| 白名单命令带有已知的写操作选项——`find` 带 `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/`-fprint*`/`-fls`；`git branch` 带 `-d`/`-D`/`-m`/`-M`/`-c`/`-C`/`-u`（包括 `-Df` 这类合并短选项）、`--delete`/`--move`/`--copy`/`--set-upstream-to[=…]`/`--unset-upstream`/`--edit-description`；`git log`/`diff`/`show` 带 `--output[=…]` | 否——权限框会指出该选项 |
| 其他全部调用，包括所有 MCP 工具 | 否 |

白名单按命令段逐段判定：`git status && git branch -D main` 会因为后半段而询问。这是纯白名单：解析不确定时多问一次，不会静默放行。`plan` 允许读文件、加载 skill、查询后台任务和委派；拒绝文件修改、带命令的 bash 以及未知/MCP 工具。它在 `PreToolUse` 之前拒绝，因此被拦截的操作不会触发项目 hook 命令。磁盘上的规则仍保留，但会显示为已忽略。

拒绝不算工具错误。模型收到的是用户拒绝结果，并被要求不要重试或绕过。

### 敏感路径读取

读取同样走白名单，但有一组固定路径永远不会被静默读取：`~/.ssh/`、`~/.aws/`、`~/.gnupg/` 之下的任何内容（目录本身也算）、`~/.netrc`、`~/.kube/config`、`~/.docker/config.json`、`/etc/shadow`、任何位置上名为 `.env` 或 `.env.*` 的文件，以及 Darwin 自身的配置、hook 和权限规则文件。路径按 shell 的方式解析（`~`、`~/`、`$HOME`、`${HOME}`、相对与绝对形式、`..` 会被归一化），因此 `cat ~/.ssh/id_rsa`、`head $HOME/.aws/credentials` 和 `fileEditor view ../../.netrc` 都会以 `reads a sensitive path: <path>` 询问。`plan` 模式下敏感的 `fileEditor view` 是询问而非拒绝，因为它仍然是读操作（带命令的 bash 仍像以前一样在 `plan` 中被拒绝）；`auto` 绝不会把它交给分类器，而是直接询问；无头运行中该询问表现为 `permission denied`。仅对 `grep` 和 `rg`，从凭据位置的上级目录开始搜索（`grep -r AKIA ~`、`rg -uu secret /`、`grep -r k /etc`）同样视为读取它，并以 `reads a sensitive path: ~ (searches above ~/.ssh)` 询问；`.env*` 文件不在这条上级目录规则之内，因此含有 `.env` 的项目里 `grep -r foo .` 仍然静默。其余读取——`cat README.md`、`ls ~/.ssh/../`、`.envrc`、`/etc/os-release`——和以前一样静默放行。`echo` 不算读取器：重定向和命令替换已被拒绝，它只能打印参数。判定标准是这组固定集合，而不是「项目之外」，因为 Darwin 会合法地读取 `/tmp`、`/etc/os-release` 和全局 skill 目录。

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

## 无头模式与本地命令

无头模式没有交互 bridge：未被静态安全或持久规则放行的调用会立即拒绝。需要时应显式选择 `auto`/`yolo`。

`!<command>` 由用户直接输入，不属于模型调用，因此不经过该 gate，并可在 `plan` 中运行；详见[使用 darwin](using-darwin.zh-CN.md)。模型后续请求的命令仍受 gate 保护。

## 审计记录

gate 每裁定一次调用，都会在会话轨迹中写入一条 `permissionDecision` 记录（见[会话与状态](sessions-and-state.zh-CN.md)）：由哪一级裁定（`safe`、`allow-rule`、`classifier`、`yolo`、`user-approved`、`user-denied`、`deny-rule`、`plan-denied`、`write-scope-denied`、`restart-limit-denied`）、当时生效的模式、是否向你发起了确认、匹配或授予的规则、子代理发起时的子代理标签，以及该调用的 `toolUseId`——绝不含工具输入，因为该调用自己的记录已经保存了它。它只写日志：模型、工具结果、屏幕和无头输出都不变，也没有任何配置项。`darwin trajectory replay` 与 `/export` 只为向你发起过确认或被拒绝的调用打印一行 `permission · <tool> · …` 提示；静默放行不打印任何内容。读取记录不需要调用模型。
