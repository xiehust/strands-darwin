#!/usr/bin/env python3
"""Build the standalone Darwin architecture deck with the reference deck's visual style.

Requires the already-installed python-pptx package. No network or source-deck writes.
Usage: python3 docs/ppt/build-architecture.py --output /tmp/architecture.pptx
Existing outputs require an exact --replace-sha256 digest, never blind overwrite.
"""
from pathlib import Path
import argparse
import hashlib
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt

ROOT = Path(__file__).resolve().parents[2]
REVISION = "dec1cd3"
AS_OF = "2026-10-22"
C = dict(ink="0F1720", paper="F7F5F0", teal="1493A8", cyan="33C3E0",
         amber="B45309", border="D9D4C7", muted="5B6571", light="B5BFCC",
         panel="1B2633", white="FFFFFF", pale="E8F1F0")
FONT = "Microsoft YaHei"
ENGLISH = "Georgia"
MONO = "Consolas"
P = Presentation()
P.slide_width, P.slide_height = Inches(10), Inches(5.625)
P.core_properties.title = "Darwin 整体架构与 Strands SDK"
P.core_properties.subject = "Agent、子 agent、后台任务、上下文、会话与扩展机制"
P.core_properties.author = "Darwin"
P.core_properties.keywords = "Darwin, Strands SDK, architecture, 中文"
P.core_properties.comments = f"Code snapshot {REVISION}; {AS_OF}. Independent companion deck."

def rgb(value):
    return RGBColor.from_string(C.get(value, value))


def rect(s, x, y, w, h, fill="white", border=None, kind=MSO_SHAPE.RECTANGLE):
    a = s.shapes.add_shape(kind, Inches(x), Inches(y), Inches(w), Inches(h))
    a.fill.solid()
    a.fill.fore_color.rgb = rgb(fill)
    for effect in a._element.xpath("./p:style/a:effectRef"):
        effect.set("idx", "0")
    if border:
        a.line.color.rgb = rgb(border)
        a.line.width = Pt(0.7)
    else:
        a.line.fill.background()
    return a


def text(s, value, x, y, w, h, size=13, color="ink", bold=False,
         font=FONT, align=PP_ALIGN.LEFT, spacing=1.18):
    a = s.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = a.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = 0
    tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.TOP
    for i, line in enumerate(value.split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        p.space_before = Pt(0)
        p.space_after = Pt(3)
        r = p.add_run()
        r.text = line
        r.font.name = font
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = rgb(color)
        # Preserve the original deck's explicit East Asian font selection.
        ea = OxmlElement("a:ea")
        ea.set("typeface", FONT)
        r._r.get_or_add_rPr().append(ea)
    return a


def arrow(s, x1, y1, x2, y2, color="teal"):
    a = s.shapes.add_connector(MSO_CONNECTOR.STRAIGHT,
                              Inches(x1), Inches(y1), Inches(x2), Inches(y2))
    a.line.color.rgb = rgb(color)
    a.line.width = Pt(1.3)
    for effect in a._element.xpath("./p:style/a:effectRef"):
        effect.set("idx", "0")
    head = OxmlElement("a:tailEnd")
    head.set("type", "triangle")
    a._element.spPr.get_or_add_ln().append(head)
    return a


def base(section, title, *, dark=False, subtitle=None, sources=(), notes=""):
    s = P.slides.add_slide(P.slide_layouts[6])
    s.background.fill.solid()
    s.background.fill.fore_color.rgb = rgb("ink" if dark else "paper")
    rect(s, 0, 0, 0.12, 5.625, "cyan" if dark else "teal")
    text(s, section, .5, .28, 9, .26, 10.5, "cyan" if dark else "teal", True)
    text(s, title, .5, .68, 9, .60, 28, "white" if dark else "ink", True)
    if subtitle:
        text(s, subtitle, .5, 1.35, 9, .46, 12, "light" if dark else "muted")
    text(s, "Darwin Architecture · Strands SDK", .5, 5.22, 5.2, .22,
         8.5, "light" if dark else "muted", font=ENGLISH)
    text(s, f"{len(P.slides):02d}", 9.08, 5.20, .42, .25, 10,
         "light" if dark else "muted", font=ENGLISH, align=PP_ALIGN.RIGHT)
    if sources:
        text(s, "代码索引：" + " · ".join(sources), .5, 4.93, 9, .20, 8,
             "light" if dark else "muted")
    s.notes_slide.notes_text_frame.text = (
        f"代码核对日期：{AS_OF}\n仓库：github.com/xiehust/strands-darwin\n"
        f"基线 commit：{REVISION}；@strands-agents/sdk 1.21.0（含项目 pinned patch）。\n"
        f"来源：\n" + "\n".join(sources) + "\n\n" + notes
    )
    return s


def card(s, x, y, w, h, title, body, *, dark=False, accent="teal", size=12):
    rect(s, x, y, w, h, "panel" if dark else "white", None if dark else "border")
    text(s, title, x+.18, y+.15, w-.36, .36, 14, "cyan" if dark else accent, True)
    text(s, body, x+.18, y+.59, w-.36, h-.70, size, "white" if dark else "ink")


def band(s, value, y=4.39, *, dark=False, accent="teal"):
    rect(s, .5, y, 9, .42, "panel" if dark else "pale")
    text(s, value, .65, y+.08, 8.7, .28, 11.3, "cyan" if dark else accent, True)


def code(s, value, x, y, w, h, size=11):
    rect(s, x, y, w, h, "ink")
    pad = .10 if h <= .8 else .17
    text(s, value, x+.18, y+pad, w-.36, h-2*pad, size, "cyan", font=MONO, spacing=1.20)


def step(s, x, y, w, number, title, body, *, dark=False):
    rect(s, x, y, w, 1.5, "panel" if dark else "white", None if dark else "border")
    text(s, number, x+.15, y+.12, w-.3, .30, 15, "cyan" if dark else "teal", True, ENGLISH)
    text(s, title, x+.15, y+.51, w-.3, .34, 13, "white" if dark else "ink", True)
    text(s, body, x+.15, y+.91, w-.3, .49, 10.5, "light" if dark else "muted")


def matrix(s, headers, rows, widths, y=1.65, row_h=.43, sizes=None):
    x0 = .5
    x = x0
    for h, w in zip(headers, widths):
        rect(s, x, y, w, .4, "ink")
        text(s, h, x+.12, y+.09, w-.24, .24, 10.5, "white", True)
        x += w
    for j, row in enumerate(rows):
        yy = y+.4+j*row_h
        x = x0
        for i, (v, w) in enumerate(zip(row, widths)):
            rect(s, x, yy, w, row_h, "white" if j % 2 == 0 else "pale")
            text(s, v, x+.12, yy+.08, w-.24, row_h-.12,
                 sizes[i] if sizes else 10.7, "teal" if i == 0 else "ink", i == 0)
            x += w


def validate_geometry():
    problems = []
    for i, s in enumerate(P.slides, 1):
        for sh in s.shapes:
            if (sh.left < 0 or sh.top < 0 or
                sh.left + sh.width > P.slide_width + 100 or
                sh.top + sh.height > P.slide_height + 100):
                problems.append(f"slide {i}: {sh.name} lies outside the canvas")
        if not s.notes_slide.notes_text_frame.text.strip():
            problems.append(f"slide {i}: no speaker notes")
    if problems:
        raise ValueError("\n".join(problems))

# 01 — Standalone cover, echoing the reference deck's dark editorial opening.
s = base("架构篇 · 独立补充材料", "", dark=True,
         notes="本材料扩展原演示稿中的 SDK 架构部分，不重复自进化实验时间线。以当前代码为准，原稿中的历史实现不代表当前架构。所有图均为可编辑的 PowerPoint 原生形状。")
text(s, "Darwin", .5, 1.10, 5.4, .8, 44, "white", True, ENGLISH)
text(s, "Architecture", .5, 1.91, 5.6, .8, 42, "cyan", True, ENGLISH)
text(s, "整体架构与 Strands SDK", .5, 2.91, 5.1, .45, 22, "white", True)
text(s, "Agent、子任务、上下文管理和会话恢复的实现。", .5, 3.57, 4.65, .75, 14, "light")
for yy, label, detail in [(1.42, "Darwin", "终端界面 · 权限检查 · 会话管理"),
                           (2.50, "Strands SDK", "Agent · Tools · Plugins · Sessions"),
                           (3.58, "Workspace", "代码 · 命令 · 文件 · 外部工具")]:
    rect(s, 6.1, yy, 3.4, .80, "panel")
    text(s, label, 6.3, yy+.12, 3.0, .27, 16, "cyan", True, ENGLISH)
    text(s, detail, 6.3, yy+.48, 3.0, .22, 10.5, "light")
arrow(s, 7.8, 2.25, 7.8, 2.45, "cyan")
arrow(s, 7.8, 3.33, 7.8, 3.53, "cyan")
text(s, "SDK 1.21.0 + pinned patch  /  " + AS_OF + "  /  " + REVISION,
     .5, 4.66, 8.8, .25, 10, "light", font=MONO)

# 02 — Component architecture: separate ownership, not a forked loop.
s = base("01 · 整体架构", "Darwin 的主要组件",
         subtitle="Darwin 使用 SDK 的 Agent，另外实现终端界面、权限检查和会话管理。",
         sources=("src/agent/runtime.ts", "src/agents/child-recipe.ts"),
         notes="父 Agent 在 runtime.ts 中创建，子 Agent 在 child-recipe.ts 中创建。这两处设置模型、工具和扩展项，使用 SDK 的 Agent 循环和默认工具执行器。Darwin 没有设置自定义 toolExecutor。图中展示组件关系，各层并非独立部署。参见 docs/architecture/load-bearing-decisions.md:32–68。")
for yy, label, value, fill in [
    (1.96, "交互层", "Ink TUI/headless：输入、输出、审批、取消和完成通知", "white"),
    (2.55, "Darwin 运行层", "AgentRuntime：模型、提示词、权限检查、工具注册和会话管理", "white"),
    (3.14, "Strands SDK", "Agent loop · Model · Tools · Hooks/Plugins · Graph · SessionManager", "pale"),
    (3.73, "执行与存储", "模型服务、MCP、shell、文件系统、本地会话与 offload 存储", "white")]:
    rect(s, .5, yy, 9, .46, fill, "border")
    text(s, label, .65, yy+.105, 1.55, .24, 11.5, "teal", True)
    text(s, value, 2.28, yy+.105, 7.03, .25, 11.5)
band(s, "SDK 调用模型并执行工具，Darwin 的 TUI 和 headless 入口读取事件并输出结果。")

# 03 — A capability map, with stable names rather than a feature-count claim.
s = base("01 · SDK 使用情况", "SDK 功能与 Darwin 中的用途",
         sources=("src/agent/runtime.ts", "src/agent/compact.ts", "src/agents/workflow-tool.ts"),
         notes="本表对应 TypeScript SDK 1.21.0。右栏列出 Darwin 在 SDK 基础上实现的部分。后台委派使用 SDK 原生 backgroundTasks，Darwin 负责配置、读取完成事件和唤醒会话。ContextOffloader 的工具排除和历史修复使用本地补丁。")
matrix(s, ["SDK 组件", "Darwin 功能", "Darwin 实现的部分"], [
    ("Agent/Model/stream()", "主对话、工具循环、流式回答", "Agent 配置、TUI/headless 入口"),
    ("InterventionHandler/hooks", "权限审批、失败处理、取消", "父子 Agent 共用权限检查"),
    ("Agent + Graph", "subagent/workflow", "子 Agent 创建、并发限制、报告格式"),
    ("backgroundTasks", "subagent/workflow 后台委派", "完成通知；bash 使用独立管理器"),
    ("ContextOffloader", "工具结果卸载与检索", "结果持久化、历史修复、排除 skill"),
    ("SummarizingConversationManager", "/compact [focus]", "手动压缩及失败回滚"),
    ("SessionManager/checkpoints", "--resume、/rewind", "按项目分区、恢复分支、列出会话"),
    ("AgentSkills/McpClient", "load_skill、MCP 工具", "分层加载、资源校验、权限检查")
], [3.25, 2.65, 3.1], y=1.52, row_h=.35, sizes=[10.1, 10.4, 10.1])

# 04 — This code is an intentionally abridged reading aid, not a runnable snippet.
s = base("02 · Agent", "主 Agent 的创建与配置",
         sources=("src/agent/runtime.ts:795–1140", "src/agent/model-retry.ts"),
         notes="右侧代码省略了对象创建和部分选项，不能直接运行。runtime.ts:1024 起创建父 Agent，tools 包含普通工具和 McpClient，plugins 包含 AgentSkills 和可选的 offloader。会话管理、摘要、权限拦截和后台委派通过 SDK 配置项传入。printer:false 关闭 SDK 的终端输出，避免与 Ink 冲突。Darwin 设置 retryStrategy:null，再通过 SDK hook 和 middleware 实现模型重试。")
card(s, .5, 1.58, 4.0, 1.10, "准备配置和运行环境", "读取配置和项目说明，创建模型、工具与会话。", size=11.5)
card(s, .5, 2.88, 4.0, 1.18, "注册 SDK 扩展", "设置权限拦截、事件钩子\n和模型调用中间件。", size=11.5)
code(s, "new Agent({\n  model, systemPrompt,\n  tools: [...tools, ...mcp.clients],\n  plugins: [skills, offloader],\n  sessionManager, conversationManager,\n  interventions: [intervention],\n  backgroundTasks,\n  printer: false, retryStrategy: null\n})", 4.85, 1.58, 4.65, 2.74, 10.5)
text(s, "代码节选，省略对象创建和条件分支", 4.85, 4.43, 4.65, .25, 10, "muted")
text(s, "使用 SDK 默认循环和工具执行器。", .5, 4.43, 4.1, .3, 12, "teal", True)

# 05 — Logical flow. Exact hook order is deliberately not over-specified.
s = base("02 · Agent 调用", "一次调用的执行流程",
         subtitle="TUI 和 headless 入口通过 send() 读取事件，输出回答和工具状态。",
         sources=("src/agent/runtime.ts", "src/agent/permission.ts", "src/hooks/tool-hooks.ts"),
         notes="图中展示主要执行阶段，具体 hook 顺序以源码为准。SDK agent.stream() 执行对话循环。工具调用前，intervention 和 hook 检查权限。未知工具按 execute 处理，plan 模式提前拒绝写入，敏感读取需要单独审批。Darwin 根据模型和工具事件更新 TUI、记录 trajectory。SDK 把工具结果交给模型，继续执行到回合结束。")
for x, num, title, body in [(.5, "01", "接收输入", "TUI/headless\n调用 send()"),
                           (2.82, "02", "调用模型", "SDK Agent.stream()\n生成文本或工具请求"),
                           (5.14, "03", "检查权限", "运行钩子、检查权限\n通过后执行工具"),
                           (7.46, "04", "返回工具结果", "SDK 继续调用模型\n直到回合结束")]:
    step(s, x, 2.01, 2.04, num, title, body)
for x in [2.54, 4.86, 7.18]:
    arrow(s, x+.025, 2.77, x+.255, 2.77)
rect(s, .5, 3.86, 9, .43, "ink")
text(s, "模型和工具事件用于更新 TUI、统计用量和记录 trajectory。",
     .67, 3.96, 8.65, .24, 11.5, "cyan")
band(s, "权限检查未通过时，SDK 不执行对应工具。", y=4.43)

# 06 — Delegation shares policy and workspace, not parent conversation state.
s = base("03 · Subagent", "子 Agent 的创建与共享资源",
         sources=("src/agents/subagent-tool.ts", "src/agents/child-recipe.ts", "src/agents/retained-children.ts"),
         notes="subagent 是 Darwin 自定义工具，没有使用 SDK 内置的 vended subagent。工具检查定义、续聊 ID 和并发额度，然后创建 dispatch，并通过 buildRecipeChild 创建独立的 SDK Agent。默认并发上限为 8。子 Agent 有独立的模型实例、消息、摘要管理器和重试状态，不接收父级 SessionManager、offload 存储或再次委派的工具。continue 使用内存里保留的对话创建新 Agent，最多保留 4 份，仅当前 runtime 有效。/clear、/rewind 或退出后无法继续这些对话。保留内容不包括 Agent 实例或 shell。特定流中断后的一次续跑复用原来的子 Agent 实例，与 continue 创建新实例分开处理。")
rect(s, .5, 1.57, 2.17, 2.47, "ink")
text(s, "父 Agent", .7, 1.72, 1.78, .36, 16, "cyan", True, ENGLISH)
text(s, "指定子任务\n调用 subagent\n接收最终报告", .7, 2.16, 1.78, 1.25, 13, "white")
arrow(s, 2.74, 2.78, 3.11, 2.78)
card(s, 3.19, 1.57, 2.80, 2.47, "buildRecipeChild()", "创建 Agent 和模型实例\n使用独立消息列表\n按定义筛选工具\n单独管理摘要和重试状态", size=11.5)
card(s, 6.29, 1.57, 3.21, 2.47, "共享资源与限制", "共用 PermissionGate\n共用工作树和部分工具\n不继承父会话和 offload\n不能再委派子任务", accent="amber", size=11.5)
band(s, "continue=<id> 使用保留对话创建新子 Agent，最多保留 4 份，仅当前 runtime 有效。")

# 07 — A DAG, with each edge encoded explicitly and without crossings.
s = base("03 · Workflow", "Workflow 的依赖调度",
         sources=("src/agents/workflow-tool.ts", "src/agent/permission.ts"),
         notes="workflow 最多接受 8 个节点和 28 条依赖边。Darwin 在创建子 Agent、模型和 dispatch 前，检查循环依赖、节点引用、Agent 名称和写入范围。SDK Graph 等待一个节点的全部前驱完成，合并输入，并处理并发、取消和终点输出。各节点使用相同的子 Agent 创建函数，父层只收到终点报告。writeScopes 通过权限检查限制 fileEditor 的写入路径，不限制 bash。并行分支用于读取，需要串行执行的写入节点应通过依赖边连接。/developer 另外启动完整的 headless Darwin 进程，由 Host 验收，与这里的进程内委派不同。")
card(s, .5, 1.61, 2.18, .98, "读取 A", "例如：实现与调用链", size=11)
card(s, .5, 2.98, 2.18, .98, "读取 B", "例如：测试与约束", size=11)
card(s, 3.55, 2.27, 2.28, 1.17, "汇总 C", "等 A、B 全部完成", size=11)
card(s, 6.70, 2.27, 2.80, 1.17, "写入 D", "按顺序修改并返回报告", size=11)
arrow(s, 2.68, 2.12, 3.55, 2.58)
arrow(s, 2.68, 3.47, 3.55, 3.11)
arrow(s, 5.83, 2.86, 6.70, 2.86)
text(s, "Darwin 校验节点、依赖和写入范围", 3.55, 1.60, 5.8, .31, 13, "teal", True)
text(s, "SDK Graph 处理依赖、输入合并、并发和取消", 3.55, 3.76, 5.8, .33, 12, "muted")
band(s, "writeScopes 限制 fileEditor 的写入路径，不限制 bash，也不提供文件系统隔离。", accent="amber")

# 08 — Separate SDK-native background tasks from Darwin's process manager.
s = base("04 · 后台任务", "后台子任务与后台 Shell", dark=True,
         sources=("src/agent/background-delegation.ts", "src/tools/background-bash.ts"),
         notes="SDK 的 BackgroundTasks 和 InProcessTaskEngine 执行后台委派。bash 的 start、wait 等操作由 Darwin 的 BackgroundBashManager 实现。SDK bash 的本地补丁主要处理前台持久 shell 的工作目录、标准输入、取消和退出。两类任务的完成通知进入 TUI 的同一个先进先出队列。headless 模式会等待后台委派报告，但不会因后台 shell 结束而自动开启回合，需要显式调用 wait。")
card(s, .5, 1.57, 4.35, 2.47, "后台 Agent 委派", "SDK backgroundTasks\n运行 subagent/workflow\n先返回 ACK，完成后交付报告\n管理操作为 list/get/cancel", dark=True, size=12.5)
card(s, 5.15, 1.57, 4.35, 2.47, "后台 Shell 作业", "Darwin BackgroundBashManager\nstart 启动进程并记录日志\nwait/output 读取执行结果\n管理操作为 status/list/stop", dark=True, size=12.5)
band(s, "两类任务都通过权限检查，完成通知进入同一个 TUI 队列。", dark=True)

# 09 — Report transport is SDK-owned; the wake contains metadata only.
s = base("04 · 后台 Agent 委派", "后台子任务的结果交付",
         subtitle="父 Agent 可把 subagent/workflow 转为后台任务，调用前仍需通过权限检查。",
         sources=("src/agent/background-delegation.ts", "src/tui/task-wake.ts"),
         notes="BeforeToolCallEvent 中的权限检查先于 SDK 的 routeToolCall。SDK 后台引擎接收任务并返回 ACK。工具完成后，BackgroundDelegationObserver 转发原 AfterToolCallEvent。TUI 空闲时，通过普通 submit 提交包含任务信息的通知。SDK hook 追加 strands_manage_background_task(mode:get) 的调用和结果，模型无需轮询。较快的任务可在已有回合中交付，已经交付的报告不会再次触发通知。通知本身不复制报告。headless 模式或关闭自动唤醒时，waitForCompletion:true 使 SDK 在原调用内等待。/clear 和 /rewind 在任务完成但报告尚未交付时仍可能被拒绝。")
for x, n, title, body in [(.5, "01", "请求与审批", "调用委派工具\n检查工具权限"),
                         (2.82, "02", "SDK 后台运行", "ACK 返回 task ID\n父 Agent 可继续工作"),
                         (5.14, "03", "完成通知入队", "接收任务完成事件\nTUI 空闲时提交通知"),
                         (7.46, "04", "SDK 交付报告", "自动追加 get 结果\n模型读取最终报告")]:
    step(s, x, 2.00, 2.04, n, title, body)
for x in [2.54, 4.86, 7.18]:
    arrow(s, x+.025, 2.76, x+.255, 2.76)
text(s, "TUI 自动唤醒开启", .5, 3.81, 2.1, .30, 12.5, "teal", True)
text(s, "原回合可以先结束。任务完成但结果尚未交付时，队列在空闲时触发新回合。", 2.68, 3.81, 6.82, .45, 11.8)
text(s, "Headless/关闭唤醒", .5, 4.36, 2.1, .30, 11.5, "amber", True)
text(s, "SDK 在当前调用内等待任务完成并交付结果。", 2.68, 4.36, 6.82, .45, 11.8)

# 10 — A completion signal is not the same as a model turn.
s = base("04 · 后台 Shell 作业", "后台 Shell 的完成通知与去重",
         sources=("src/tools/background-bash.ts", "src/agent/task-terminal-delivery.ts", "src/tui/task-wake.ts"),
         notes="BackgroundBashManager 在任务从 running 转为 succeeded、failed 或 stopped 时发布一次状态通知，输出增加和模型回合结束不会触发该通知。wait/output 共用读取位置，通知单独读取日志尾部。TerminalDeliveryLedger 收集成功 bash 结果中的已结束任务 ID，父回合以 endTurn 正常完成后才标记为已交付。失败或取消的回合不提交此标记。wait/status/stop/list 均可提供任务状态，结果卸载后的预览仍须包含任务 ID 才计入去重。通知根据事件触发，wait 内部则每 20ms 检查一次。普通 wait 最长等待 30 秒，terminal-focused 模式最长 30 分钟，超时后任务可能仍在运行。headless 不会自动唤醒；TUI 关闭唤醒后只显示完成提示。任务管理状态和待发通知没有跨进程恢复机制。")
code(s, 'bash { mode: "start", command: "pnpm test" }\n→ taskId / pid / outputPath', .5, 1.57, 9, .76, 11.5)
card(s, .5, 2.66, 2.8, 1.43, "运行与等待", "进程输出写入日志\nwait/output 共用读取位置", size=11.5)
card(s, 3.60, 2.66, 2.8, 1.43, "任务结束", "完成、失败或停止时通知\n附带截取后的日志尾部", size=11.5)
card(s, 6.70, 2.66, 2.8, 1.43, "检查是否已交付", "已在完成回合中交付：跳过\n尚未交付：排队通知", size=11.5)
arrow(s, 3.31, 3.34, 3.58, 3.34)
arrow(s, 6.41, 3.34, 6.68, 3.34)
band(s, "完成通知记录为 taskNotification；headless 模式需要显式等待后台 Shell。")

# 11 — Context controls solve different problems, not one automatic compactor.
s = base("05 · 上下文管理", "上下文用量、卸载和压缩",
         sources=("src/agent/context-anchor.ts", "src/tui/context-format.ts", "src/agent/compact.ts"),
         notes="/context 以服务商报告的上次完成调用的输入 token 数为基础，加上 SDK Model.countTokens 对后续消息估算的 token 数。缓存读取和写入的 token 也计入输入用量。分项报告分别列出提示词、工具和消息。contextWarnRatio 默认为 0.8，回合结束后达到阈值时显示提醒，提醒本身不调用模型或触发压缩。Darwin 没有开启 proactiveCompression。发生实际上下文溢出时，SDK 的 conversation manager 仍可通过摘要和重试恢复。当前使用 conversationManager 和 ContextOffloader，没有使用实验性的 contextManager。")
card(s, .5, 1.59, 4.35, 1.19, "用量查询 /context", "以上次调用的输入 token 数为基础，\n加上后续消息的估算 token 数。", size=11.5)
card(s, 5.15, 1.59, 4.35, 1.19, "用量提醒", "默认达到 80% 时提醒，持续高位不重复。\n提醒不改写对话历史。", size=11.5)
card(s, .5, 3.06, 4.35, 1.19, "结果卸载 offloading", "较大的工具结果存到磁盘，上下文保留预览和引用。", size=11.5)
card(s, 5.15, 3.06, 4.35, 1.19, "对话压缩 /compact", "用户发起压缩后，模型生成历史摘要，并保留近期消息。", size=11.5)
band(s, "用量提醒不会自动压缩。发生上下文溢出时，SDK 可通过摘要和重试恢复。")

# 12 — Offload contents and storage remain distinguishable from summary.
s = base("05 · Offloading", "工具结果卸载与检索",
         sources=("src/agent/runtime.ts:962–995", "src/config.ts:640–652", "SDK ContextOffloader + patch"),
         notes="父 Agent 默认启用 contextOffload，maxResultTokens 为 5000。SDK 自身的默认阈值为 2500，Darwin 覆盖了这个值。SDK 预览预算默认为 1000 tokens，实际按字符估算截取。LocalFileStorage 使用当前会话的 offload 目录，evictAfterCycles:null 使同一会话恢复后仍可检索结果。本地补丁增加了 excludeTools、旧会话首次模型调用前的历史修复，以及 JSON 多行字符串的可读检索格式。load_skill 的完整说明不卸载。SDK 还排除错误、检索及 AgentAsTool(delegate=true) 的结果，Darwin 的 subagent/workflow 普通工具不在该豁免范围。恢复同一会话后可继续检索，但不保证 /rewind 新分支能使用原会话的引用。取回完整结果会重新占用上下文，目前没有会话存储的自动清理。")
card(s, .5, 1.63, 2.73, 1.55, "工具原始结果", "完整日志 / 文件 / 搜索结果\n超过配置阈值", size=11.5)
card(s, 3.64, 1.63, 2.73, 1.55, "ContextOffloader", "完整内容存盘\n上下文只保留预览 + 引用", size=11.5)
card(s, 6.78, 1.63, 2.72, 1.55, "按需检索", "reference + pattern\n或 line_range 精确取回", size=11.5)
arrow(s, 3.26, 2.41, 3.60, 2.41)
arrow(s, 6.40, 2.41, 6.74, 2.41)
code(s, "~/.darwin/sessions/<project-key>/<session-id>/offload/", .5, 3.50, 9, .51, 11)
text(s, "默认阈值 5,000 tokens", .5, 4.26, 3.05, .36, 16, "teal", True)
text(s, "恢复同一会话后可继续检索。load_skill 返回的完整说明不卸载。",
     3.83, 4.25, 5.67, .52, 11.5)

# 13 — SDK summary, explicitly controlled by Darwin's manual command.
s = base("05 · Compact", "/compact 的摘要与消息保留",
         sources=("src/agent/compact.ts", "src/agent/runtime.ts:1718–1748"),
         notes="每次 /compact 都创建 SummarizingConversationManager，设置 summaryRatio:0.8，默认保留最近 10 条消息，不是 10 轮对话。没有 focus 时使用 SDK 默认提示词；有 focus 时追加一节，内容最多 400 个 Unicode 码点。SDK 负责生成纯文本摘要，并保持工具调用与结果的配对。本地补丁从包根导出 DEFAULT_SUMMARIZATION_PROMPT。Darwin 调用 reduce() 后，如果消息数没有减少，就撤销该次修改并停止；SDK 返回 false 时按失败处理并回滚。成功后保存最新快照，更新会话恢复指针。压缩会调用模型并改写后续上下文，原有 trajectory 记录独立保留。")
rect(s, .5, 1.66, 4.2, .55, "white", "border")
text(s, "历史：M1  M2  M3  …  M(n−10)", .69, 1.80, 3.83, .25, 13, "muted")
rect(s, 5.30, 1.66, 4.2, .55, "white", "border")
text(s, "默认保留最近 10 条消息", 5.49, 1.80, 3.83, .25, 13, "teal", True)
arrow(s, 2.60, 2.28, 2.60, 2.72)
arrow(s, 7.40, 2.28, 7.40, 2.72)
rect(s, .5, 2.82, 4.2, .64, "ink")
text(s, "SDK 生成摘要", .69, 2.99, 3.83, .32, 17, "cyan", True)
rect(s, 5.30, 2.82, 4.2, .64, "pale")
text(s, "保留工具调用与结果的配对", 5.49, 3.01, 3.83, .28, 12.5, "teal", True)
text(s, "摘要提示词与 focus", .5, 3.84, 4.2, .3, 13, "ink", True)
text(s, "focus 最多 400 个 Unicode 码点。\n内容追加到 SDK 默认提示词中。", .5, 4.24, 4.2, .49, 11.5, "muted")
text(s, "失败或消息数未减少时的处理", 5.30, 3.84, 4.2, .3, 13, "ink", True)
text(s, "摘要失败时回滚。消息数量未减少时，撤销该次修改并停止。", 5.30, 4.24, 4.2, .49, 11.5, "muted")

# 14 — Never use trajectory as a substitute for a model checkpoint.
s = base("06 · 持久化", "会话快照、运行记录与项目记忆",
         sources=("src/agent/session.ts:522–535", "src/trajectory/record.ts", "src/memory/controller.ts"),
         notes="数据存储在 ~/.darwin 下，按 project-key 分区。SDK 快照路径为 sessions/<project-key>/session/<id>/scopes/agent/darwin/snapshots，轨迹为 sessions/<project-key>/<id>/trajectory.jsonl，项目记忆为 projects/<project-key>/memory/state.json。SessionManager 设置 saveLatestOn:'invocation'，自动恢复和保存 messages、state（序列化的 appState）、systemPrompt、modelState 和 interrupts。trajectory 有截断限制，不能用于完整恢复模型状态。memory_save 经过授权和证据校验后暂存，仅在 endTurn 成功且对应轨迹记录持久化后提交。TUI 恢复会话时另读 trajectory 显示历史记录，不将这些回放内容再次输入模型。")
card(s, .5, 1.66, 2.8, 2.36, "Snapshot", "SDK SessionManager 管理\n保存消息和插件状态\n用于恢复会话\n支持创建检查点", size=12)
card(s, 3.6, 1.66, 2.8, 2.36, "Trajectory", "由 Darwin 追加记录\n记录输入、回答和工具事件\n用于回放、导出和审计\n恢复终端里的历史记录", size=12)
card(s, 6.7, 1.66, 2.8, 2.36, "Project memory", "保存验证后的项目事实\n先授权和暂存\n成功回合结束后提交\n按需检索，供后续会话使用", size=12)
band(s, "这些记录不包含工作区文件备份，也不保存运行中的进程或 MCP 连接。")

# 15 — The persistence mechanism, separate from the visible session commands.
s = base("06 · SessionManager", "会话快照的保存与恢复",
         sources=("src/agent/session.ts:522–535", "src/agent/runtime.ts:1074–1117", "SDK session-manager.js"),
         notes="createSessionManager 使用 LocalFileStorage(sessionPaths(projectRoot).sessionsDir)、sessionId 和 saveLatestOn:'invocation' 创建 SDK SessionManager。SDK 在 InitializedEvent 时恢复 latest，在 AfterInvocationEvent 时保存快照。Darwin 固定 agent.id='darwin'，保证恢复时使用相同存储范围。快照包括 messages、state（序列化的 appState）、systemPrompt、modelState 和 interrupts，插件激活状态可通过 appState 保存。错误或取消后保存的 latest 不一定是可选的 rewind 检查点。会话 lease 保证同一会话同时只有一个进程使用。未指定 ID 的 --resume 读取项目指针，指定 ID 时严格选择该会话。恢复后重新整理当前环境信息和提示词缓存。")
for x, n, title, body in [(.5, "01", "选择会话", "解析 session ID\n获取会话独占锁"),
                         (2.82, "02", "初始化并恢复", "创建 Agent 和管理器\ninitialize() 恢复快照"),
                         (5.14, "03", "执行调用", "SDK 对话与工具循环\n插件使用 appState"),
                         (7.46, "04", "结束后保存", "saveLatestOn:\n\"invocation\"")]:
    step(s, x, 1.64, 2.04, n, title, body)
for x in [2.54, 4.86, 7.18]:
    arrow(s, x+.025, 2.40, x+.255, 2.40)
code(s, "snapshot = messages + state(appState) + systemPrompt + modelState + interrupts",
     .5, 3.49, 9, .58, 11)
band(s, "latest 保存最近的会话状态；不可变 checkpoint 用于 /rewind 选择历史分支。")

# 16 — Latest snapshots versus immutable, user-selected branch points.
s = base("06 · 会话操作", "Resume、Rewind 和 Clear 的区别",
         sources=("src/agent/rewind.ts", "src/agent/runtime.ts:2570–2757", "src/paths.ts:70–100"),
         notes="SessionManager 初始化时恢复 latest，调用结束后保存快照。rewind 在符合条件的文本 prompt 发送前保存 isLatest:false 的不可变快照。回合以 endTurn 或拒绝类结果正常结束后，才将快照登记为可选检查点。失败和取消回合生成的快照也占每会话 100 个的上限，但不可选择；达到上限后仍可继续普通对话。/rewind 创建新 runtime，恢复 prompt 发送前的快照，将原 prompt 放回编辑框而不发送，旧会话保持不变。/clear 同样创建新 runtime，避免继续使用旧 SessionManager 的 hooks。MCP 和后台 bash 管理器交接给新 runtime，会话、skills、权限检查和 offload 存储重新创建。子 Agent 的 continue 使用内存对话，与会话快照分开。委派仍在运行或报告尚未交付时，/clear 和 /rewind 会被拒绝。")
matrix(s, ["操作", "会话", "模型上下文", "对旧会话的处理"], [
    ("--resume", "原会话", "恢复最新快照", "继续旧会话，重新创建运行资源"),
    ("/rewind", "新会话分支", "恢复所选输入发送前的状态", "原快照不改，输入回到编辑框"),
    ("/clear", "新会话", "新建空对话", "保留旧会话，交接进程资源")
], [1.30, 1.62, 2.55, 3.53], y=1.56, row_h=.50, sizes=[12, 11, 11, 11])
rect(s, .5, 3.68, 9, .53, "ink")
text(s, "发送 prompt 前保存快照 → 回合正常结束后登记 → 选择快照后建立分支",
     .68, 3.83, 8.64, .28, 11.5, "cyan")
band(s, "每个会话最多创建 100 个回退快照。回退不撤销文件、命令、MCP 写入或已提交记忆。", accent="amber")

# 17 — Official skills plugin plus Darwin discovery and containment checks.
s = base("07 · Skills 插件", "Skills 的发现与按需加载",
         sources=("src/skills/plugin.ts", "src/skills/loader.ts", "src/skills/resource-safety.ts"),
         notes="Darwin 使用 SDK 官方的 AgentSkills 和 Skill。内置技能名称保留。其余技能按项目 .darwin、项目 .agents、全局 .darwin、全局 .agents 的优先顺序查找，正文按需加载。Darwin 预先检查资源路径，使用时再次校验 realpath，预检最多扫描 200 个条目。SDK 原生 skills 工具保持私有，模型只看到 load_skill。BeforeInvocationEvent 加入技能名称和描述，activatedSkills 和 lastInjectedXml 存在 appState 中。/skill-name 使用同一套激活逻辑，再展开为普通输入文本。加载技能只返回说明和资源列表，不会自动执行脚本或增加权限。offloader 不卸载 load_skill 的返回内容。")
for x, n, title, body in [(.5, "01", "发现 SKILL.md", "按优先级查找技能\n检查名称和资源路径"),
                         (2.82, "02", "注入目录", "SDK AgentSkills\n先给名称与描述"),
                         (5.14, "03", "按需激活", "load_skill(name)\n完整说明与资源列表"),
                         (7.46, "04", "调用工具", "按说明调用工具\n执行前检查权限")]:
    step(s, x, 1.66, 2.04, n, title, body)
for x in [2.54, 4.86, 7.18]:
    arrow(s, x+.025, 2.42, x+.255, 2.42)
rect(s, .5, 3.53, 9, .55, "ink")
text(s, "base → project-instructions → available_skills → working-context → cache point",
     .66, 3.70, 8.68, .28, 10.7, "cyan", font=MONO)
band(s, "技能目录只包含名称和描述。load_skill 返回完整说明，激活状态保存在 appState 中。")

# 18 — SDK extensions occupy distinct seams in the same runtime.
s = base("07 · 扩展接口", "MCP、Plugin 和 Hook 的使用方式",
         sources=("src/mcp/registry.ts", "src/skills/plugin.ts", "src/hooks/tool-hooks.ts"),
         notes="McpClient 作为工具来源加入 Agent.tools，initialize 时发现并注册工具。Darwin 合并全局和项目配置，检查项目授权，处理工具名称和权限。未知 MCP 工具默认按 execute 处理，readOnly 元信息不能代替权限规则。Plugin 通过 initAgent 和 hooks 接入，目前使用的官方插件包括 AgentSkills 和 ContextOffloader。Darwin 在 BeforeToolCall、AfterToolCall、BeforeInvocation 等生命周期事件中执行权限和记录逻辑。模型重试使用 AfterModelCallEvent 和 InvokeModelStage，不修改循环。原生配置命令 hooks 和 Codex 兼容 hooks 由 Darwin 另外适配。")
card(s, .5, 1.63, 2.8, 2.36, "MCP 工具", "McpClient 加入工具目录\nSDK 处理连接、发现和调用\nDarwin 处理配置与项目授权\n工具调用仍需检查权限", size=11.5)
card(s, 3.6, 1.63, 2.8, 2.36, "SDK 插件", "AgentSkills/ContextOffloader\n随 Agent 初始化\n加入目录、注册工具或 hooks\n可通过 appState 保存状态", size=11.5)
card(s, 6.7, 1.63, 2.8, 2.36, "生命周期 Hook", "在工具或模型调用前后运行\n用于权限、记录和失败处理\nInvokeModelStage middleware\n支持可取消的模型重试", size=11.5)
band(s, "MCP 工具使用相同的权限检查。加载技能或插件不会自动授予额外权限。")

# 19 — Preserve the provenance of capabilities and avoid obsolete patch counts.
s = base("08 · 实现来源", "SDK 原生功能与 Darwin 的实现",
         sources=("docs/architecture/load-bearing-decisions.md:32–68", "patches/@strands-agents__sdk@1.21.0.patch"),
         notes="本页列出主要实现来源，完整补丁以 patch 文件为准。当前固定 SDK 1.21.0 并应用 pnpm patch。Agent 循环、默认工具执行器、Graph 和 backgroundTasks 使用 SDK 实现。前台 bash 的标准输入、工作目录和进程组处理使用本地补丁，后台 bash 管理器位于 Darwin 源码。ContextOffloader 的 excludeTools、历史修复、JSON 检索格式和 DEFAULT_SUMMARIZATION_PROMPT 根导出也由补丁提供。当前 SDK 已原生支持纯文本摘要，旧版本的 reasoning scrub 不再是本地补丁。实验性 contextManager、shared stash、vended subagent 和 REPL 尚未启用。")
card(s, .5, 1.63, 2.8, 2.45, "SDK 原生功能", "Agent 循环与工具执行\nGraph 与 backgroundTasks\nSessionManager 与摘要\nAgentSkills/McpClient", size=12)
card(s, 3.6, 1.63, 2.8, 2.45, "Darwin 自行实现", "TUI/headless 与权限检查\n子 Agent 创建、报告和限额\n后台 shell 与完成通知\nrewind、trajectory、memory", size=12)
card(s, 6.7, 1.63, 2.8, 2.45, "SDK 本地补丁", "offload 排除和历史修复\n前台 bash 的进程处理\nfileEditor 替换失败提示\n默认摘要提示词的包根导出", accent="amber", size=12)
band(s, "当前使用 SDK 1.21.0。实验性 contextManager 和内置 subagent/REPL 尚未启用。", accent="amber")

# 20 — Dark conclusion, echoing the original deck's closing visual treatment.
s = base("总结", "实现分工", dark=True,
         notes="SDK 提供 Agent 执行、工作流调度、后台委派、摘要和会话快照。Darwin 通过配置项、插件、hooks 和 middleware 接入这些功能，另外实现终端交互、权限检查、子任务管理、通知、回退、轨迹和项目记忆。并行和后台执行仍需遵守相同权限规则，工作区并未因此隔离。")
card(s, .5, 1.65, 4.35, 2.40, "Strands SDK", "执行 Agent 循环和工具调用\n调度工作流和后台委派\n生成摘要并保存会话快照\n提供插件和 MCP 接口", dark=True, size=14)
card(s, 5.15, 1.65, 4.35, 2.40, "Darwin", "提供 TUI 和 headless 入口\n检查权限并显示任务状态\n管理子 Agent 和结果通知\n提供回退、轨迹和项目记忆", dark=True, size=14)
band(s, "Agent 循环和 Graph 调度由 SDK 执行，Darwin 通过配置和扩展接口接入。", dark=True)

# 21 — Reader-facing navigation; granular evidence is in each slide's notes.
s = base("附录 · 源码与测试", "相关源码和验证脚本",
         subtitle="代码版本：" + REVISION + " · " + AS_OF + " · @strands-agents/sdk 1.21.0 + 项目补丁",
         notes="各页备注包含实现说明、限制条件和来源。版式参考 docs/ppt/self-evolution-development.zh-CN.pptx，原文件未修改或合并。SDK 源码位于 node_modules/@strands-agents/sdk/dist/src，依赖版本见 package.json:46，补丁配置见 pnpm-workspace.yaml。文档与源码不一致时，以本材料标明版本的源码为准，包括 offload 默认阈值 5000 和按项目分区的全局会话路径。")
matrix(s, ["主题", "主要入口", "对应验证脚本（spike/）"], [
    ("Agent / 子 agent", "src/agent/runtime.ts · agents/child-recipe.ts", "verify-subagents.ts"),
    ("工作流与后台委派", "agents/workflow-tool.ts · agent/background-delegation.ts", "verify-background-delegation.ts"),
    ("后台 shell 与通知", "tools/background-bash.ts · tui/task-wake.ts", "verify-task-wake.ts"),
    ("上下文", "agent/compact.ts · agent/context-anchor.ts", "verify-context-offload.ts / verify-compact.ts"),
    ("会话 / 检查点", "agent/session.ts · agent/rewind.ts", "verify-rewind.ts / verify-clear-session.ts"),
    ("Skills / MCP", "skills/plugin.ts · mcp/registry.ts", "verify-skills.ts / verify-mcp-command.ts")
], [1.55, 4.35, 3.1], y=1.92, row_h=.40, sizes=[10.2, 9.0, 9.0])
text(s, "表中省略的目录前缀均为 src/，详细实现说明和限制见每页备注。",
     .5, 4.80, 9, .23, 10, "muted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--replace-sha256")
    args = parser.parse_args()
    if args.output.exists():
        digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
        if digest != args.replace_sha256:
            parser.error("Output exists; supply its exact --replace-sha256 to replace it.")
    validate_geometry()
    P.save(args.output)
    print(f"Created {args.output}: {len(P.slides)} slides; editable text and diagrams.")


if __name__ == "__main__":
    main()
