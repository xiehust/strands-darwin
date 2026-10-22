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
text(s, "从一次对话，到并行委派、后台结果和可恢复的会话。", .5, 3.57, 4.65, .75, 14, "light")
for yy, label, detail in [(1.42, "Darwin", "交互 · 权限 · 状态 · 产品边界"),
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
s = base("01 · 整体架构", "SDK 管执行循环，Darwin 管产品边界",
         subtitle="核心不是重写一个 agent，而是把 SDK 的扩展点装配成一个可用的 coding agent。",
         sources=("src/agent/runtime.ts", "src/agents/child-recipe.ts"),
         notes="docs/architecture/load-bearing-decisions.md:32–68：父 Agent 在 runtime.ts 构造，子 Agent 在 child-recipe.ts 构造；两处都是薄装配。没有 fork agent loop，也没有设置自定义 toolExecutor。图为组件依赖，不代表每个组件都单独部署。")
for yy, label, value, fill in [
    (1.96, "交互层", "Ink TUI / headless driver：输入、流式输出、审批、取消、通知", "white"),
    (2.55, "Darwin 装配层", "AgentRuntime：模型、提示词、权限门、工具目录、会话与观察器", "white"),
    (3.14, "Strands SDK", "Agent loop · Model · Tools · Hooks / Plugins · Graph · SessionManager", "pale"),
    (3.73, "执行与存储", "模型服务 / MCP / shell / 文件系统 / 本地 session 与 offload 存储", "white")]:
    rect(s, .5, yy, 9, .46, fill, "border")
    text(s, label, .65, yy+.105, 1.55, .24, 11.5, "teal", True)
    text(s, value, 2.28, yy+.105, 7.03, .25, 11.5)
band(s, "流式事件向上交给 driver；模型与工具执行仍由 SDK 完成。")

# 03 — A capability map, with stable names rather than a feature-count claim.
s = base("01 · 能力映射", "从 SDK primitive 到 Darwin 功能",
         sources=("src/agent/runtime.ts", "src/agent/compact.ts", "src/agents/workflow-tool.ts"),
         notes="能力名以锁定的 TypeScript SDK 1.21.0 为准。该表说明复用关系，不表示所有 Darwin 行为均由未修改的上游 SDK 提供；右栏明确产品层适配。后台委派使用 SDK 原生 backgroundTasks，Darwin 增加配置、观察和唤醒；ContextOffloader 的排除与历史修复依赖 pinned patch。")
matrix(s, ["SDK 原语", "Darwin 对应功能", "Darwin 增加的边界"], [
    ("Agent / Model / stream()", "主对话、工具循环、流式回答", "薄装配、TUI / headless driver"),
    ("InterventionHandler / hooks", "权限审批、失败保护、取消", "统一 gate，子 agent 共用策略"),
    ("Agent + Graph", "subagent / workflow", "共享 child recipe、并发上限、结果投影"),
    ("backgroundTasks", "subagent / workflow 后台委派", "结果观察、空闲唤醒；bash 另走 manager"),
    ("ContextOffloader", "大工具结果卸载与按需取回", "持久存储、恢复修复、skill 排除"),
    ("SummarizingConversationManager", "/compact [focus]", "用户显式压缩、失败与无缩减保护"),
    ("SessionManager / checkpoints", "--resume / /rewind", "项目隔离、分支恢复、只读列表"),
    ("AgentSkills / McpClient", "load_skill / MCP 工具", "分层发现、安全封装、统一权限")
], [3.25, 2.65, 3.1], y=1.52, row_h=.35, sizes=[10.1, 10.4, 10.1])

# 04 — This code is an intentionally abridged reading aid, not a runnable snippet.
s = base("02 · Agent", "主 Agent 是一份装配，不是另一套循环",
         sources=("src/agent/runtime.ts:795–1140", "src/agent/model-retry.ts"),
         notes="右侧为结构性节选，省略了具体对象构造和其他选项，不能直接复制运行。runtime.ts:1024 起创建父 Agent：tools 含普通工具与 McpClient；plugins 含官方 AgentSkills 与可选 offloader；sessionManager、conversationManager、interventions、backgroundTasks 均通过 SDK 公共配置入口。printer:false 避免 SDK stdout 与 Ink 冲突。retryStrategy:null 后安装 Darwin 的 SDK hook/middleware 重试机制。")
card(s, .5, 1.58, 4.0, 1.10, "先组装运行环境", "配置与项目说明、模型、工具、skills、session。", size=11.5)
card(s, .5, 2.88, 4.0, 1.18, "再挂接 SDK 扩展点", "权限 intervention、事件 hooks；\n模型调用 middleware。", size=11.5)
code(s, "new Agent({\n  model, systemPrompt,\n  tools: [...tools, ...mcp.clients],\n  plugins: [skills, offloader],\n  sessionManager, conversationManager,\n  interventions: [intervention],\n  backgroundTasks,\n  printer: false, retryStrategy: null\n})", 4.85, 1.58, 4.65, 2.74, 10.5)
text(s, "结构节选 · 省略对象构造和条件分支", 4.85, 4.43, 4.65, .25, 10, "muted")
text(s, "主循环与默认工具执行器都留在 SDK。", .5, 4.43, 4.1, .3, 12, "teal", True)

# 05 — Logical flow. Exact hook order is deliberately not over-specified.
s = base("02 · Agent 的一次调用", "一次用户输入，如何变成工具与回答",
         subtitle="driver 消费 send() 的实时事件；不是等整轮结束，再把回答一次性打印出来。",
         sources=("src/agent/runtime.ts", "src/agent/permission.ts", "src/hooks/tool-hooks.ts"),
         notes="图是逻辑阶段，不是精确 hook 注册顺序。SDK agent.stream() 执行循环，工具调用前的 intervention 与 hook 负责权限和保护。未知工具 fail-closed 为 execute；plan 先拒绝写；敏感读单独审批。Darwin 观察模型/工具事件生成 TUI 和 trajectory，不拦截或重写 SDK 循环。工具结果成为下一次模型调用的输入，直至 SDK 完成。")
for x, num, title, body in [(.5, "01", "接收输入", "TUI / headless\n进入 send()"),
                           (2.82, "02", "调用模型", "SDK Agent.stream()\n生成文本或工具请求"),
                           (5.14, "03", "工具前把关", "权限 / hooks\n批准后才执行"),
                           (7.46, "04", "返回工具结果", "SDK 接续模型\n直到完成回答")]:
    step(s, x, 2.01, 2.04, num, title, body)
for x in [2.54, 4.86, 7.18]:
    arrow(s, x+.025, 2.77, x+.255, 2.77)
rect(s, .5, 3.86, 9, .43, "ink")
text(s, "观察面：模型事件 / 工具事件 → TUI、usage、trajectory；不接管执行循环。",
     .67, 3.96, 8.65, .24, 11.5, "cyan")
band(s, "权限不是提示词约定：被拒绝的工具调用，不进入工具函数体。", y=4.43)

# 06 — Delegation shares policy and workspace, not parent conversation state.
s = base("03 · Subagent", "子 agent：独立对话，共用权限与工作树",
         sources=("src/agents/subagent-tool.ts", "src/agents/child-recipe.ts", "src/agents/retained-children.ts"),
         notes="subagent 是 Darwin 自定义 tool，不是直接使用 SDK 新增的 vended subagent。工具校验定义/续聊 id/并发额度后创建 dispatch，再通过 buildRecipeChild 构造独立 SDK Agent。默认并发上限8。每个 child 有模型实例、对话、conversation manager 与重试状态；无父 sessionManager、父 offload 存储、后台委派或递归委派工具。continue 通过最多4份内存保留对话 seed 新 Agent，仅当前runtime有效；/clear、/rewind或退出后不可续聊。不是磁盘 session，也不保留活 Agent 或 shell。一次特殊流中断的活 child 续跑则是另一机制。")
rect(s, .5, 1.57, 2.17, 2.47, "ink")
text(s, "Parent Agent", .7, 1.72, 1.78, .36, 16, "cyan", True, ENGLISH)
text(s, "定义明确任务\n调用 subagent\n接收最终报告", .7, 2.16, 1.78, 1.25, 13, "white")
arrow(s, 2.74, 2.78, 3.11, 2.78)
card(s, 3.19, 1.57, 2.80, 2.47, "buildRecipeChild()", "新 Agent / 模型实例\n独立 messages\n筛选后的工具目录\n独立摘要与重试状态", size=11.5)
card(s, 6.29, 1.57, 3.21, 2.47, "共享，不代表隔离", "共享 permission gate\n共享工作树与部分工具资源\n不继承父会话和 offload\n不允许递归委派", accent="amber", size=11.5)
band(s, "continue=<id>：用保留对话创建新 child；最多保留 4 份，仅当前 runtime 有效。")

# 07 — A DAG, with each edge encoded explicitly and without crossings.
s = base("03 · Workflow", "DAG 编排交给 SDK Graph，不另造调度器",
         sources=("src/agents/workflow-tool.ts", "src/agent/permission.ts"),
         notes="workflow schema最多8个节点、28条边。Darwin在创建child/model/dispatch之前校验循环、未知节点/agent及scope。SDK Graph负责AND依赖、依赖输出合并、并发、取消与terminus输出。每节点复用child recipe；只返回终点报告。writeScopes仅由现有gate限制fileEditor写，不覆盖bash；并行分支用于读取，写入按edge序列化。/developer是另一个概念：启动完整headless Darwin进程并由Host验收，不等于这个进程内subagent/Graph工具。")
card(s, .5, 1.61, 2.18, .98, "读取 A", "例如：实现与调用链", size=11)
card(s, .5, 2.98, 2.18, .98, "读取 B", "例如：测试与约束", size=11)
card(s, 3.55, 2.27, 2.28, 1.17, "汇总 C", "等 A、B 全部完成", size=11)
card(s, 6.70, 2.27, 2.80, 1.17, "写入 D", "串行实施，最终报告返回父层", size=11)
arrow(s, 2.68, 2.12, 3.55, 2.58)
arrow(s, 2.68, 3.47, 3.55, 3.11)
arrow(s, 5.83, 2.86, 6.70, 2.86)
text(s, "Darwin：先校验有界 DAG", 3.55, 1.60, 5.8, .31, 13, "teal", True)
text(s, "SDK Graph：依赖调度、合并输入、并发与取消", 3.55, 3.76, 5.8, .33, 12, "muted")
band(s, "writeScopes 只约束 fileEditor 写入，不覆盖 bash；它不是文件系统沙箱。", accent="amber")

# 08 — Separate SDK-native background tasks from Darwin's process manager.
s = base("04 · Background tasks", "同叫“后台”，其实是两条执行通道", dark=True,
         sources=("src/agent/background-delegation.ts", "src/tools/background-bash.ts"),
         notes="SDK BackgroundTasks/InProcessTaskEngine负责委派。bash start/wait等是Darwin的BackgroundBashManager，而非SDK后台任务插件，也不是patch新增的后台API。SDK bash patch主要修改前台持久shell的cwd、stdin、取消与退出。两通道在TUI既有通知FIFO汇合；headless委派会等到交付，shell无自动wake，需要当前运行显式wait。")
card(s, .5, 1.57, 4.35, 2.47, "后台 Agent 委派", "SDK backgroundTasks\nsubagent / workflow\n立即 ACK，最终报告由 SDK 交付\n管理：list / get / cancel", dark=True, size=12.5)
card(s, 5.15, 1.57, 4.35, 2.47, "后台 Shell 作业", "Darwin BackgroundBashManager\nbash start：真实进程 + 日志\nwait / output 取结果，终态可唤醒\n管理：status / list / stop", dark=True, size=12.5)
band(s, "共用权限门与 TUI 通知队列，但任务引擎、结果交付方式和生命周期不同。", dark=True)

# 09 — Report transport is SDK-owned; the wake contains metadata only.
s = base("04 · 后台 Agent 委派", "先返回 ACK，完成后再把报告交回模型",
         subtitle="只为父层 subagent / workflow 开启；_background_execution 不是绕过权限的通道。",
         sources=("src/agent/background-delegation.ts", "src/tui/task-wake.ts"),
         notes="权限的BeforeToolCallEvent先于SDK routeToolCall。SDK后台引擎去除标志、运行工具并返回ACK。BackgroundDelegationObserver转发原AfterToolCallEvent并发布settlement；TUI只有空闲时将metadata wake经普通submit入队。SDK hooks追加synthetic strands_manage_background_task(mode:get)调用/结果对，不是模型轮询。快任务也可在当前/已有回合交付，已交付则去重。wake不复制报告。headless与关闭wake时waitForCompletion:true，在原invocation内等待。clear/rewind在任务已完成但未交付时仍可能拒绝。")
for x, n, title, body in [(.5, "01", "请求与审批", "调用委派工具\n通过普通权限门"),
                         (2.82, "02", "SDK 后台运行", "ACK 返回 task ID\n父层可以继续工作"),
                         (5.14, "03", "完成事件入队", "Observer 观察终态\nTUI 空闲时 wake"),
                         (7.46, "04", "SDK 交付报告", "synthetic get\n模型读到最终结果")]:
    step(s, x, 2.00, 2.04, n, title, body)
for x in [2.54, 4.86, 7.18]:
    arrow(s, x+.025, 2.76, x+.255, 2.76)
text(s, "TUI 开启 wake", .5, 3.81, 2.1, .30, 12.5, "teal", True)
text(s, "可以先结束原回合；完成后由普通队列唤醒，不额外复制报告。", 2.68, 3.81, 6.82, .45, 11.8)
text(s, "Headless / 关闭 wake", .5, 4.36, 2.1, .30, 11.5, "amber", True)
text(s, "SDK 在当前 invocation 内等待交付；不是直接退出并遗留结果。", 2.68, 4.36, 6.82, .45, 11.8)

# 10 — A completion signal is not the same as a model turn.
s = base("04 · 后台 Shell 作业", "只在终态通知；已读过的结果不再唤醒",
         sources=("src/tools/background-bash.ts", "src/agent/task-terminal-delivery.ts", "src/tui/task-wake.ts"),
         notes="BackgroundBashManager发布running到succeeded/failed/stopped的一次终态快照，不以输出字节或turn结束触发。wait/output共享游标；通知尾部独立读取不抢游标。TerminalDeliveryLedger记录成功bash结果的terminal task IDs，只在父send自然endTurn后提交delivered；失败或取消不算已交付。支持wait/status/stop/list，offload后要求预览仍明确带ID。通知层事件驱动无定时轮询，但wait内部有20ms本地检查；不可说整个系统完全不轮询。wait普通上限30秒，terminal-focused上限30分钟；超时仍可能运行。headless无自动shell wake，TUI关闭wake仅notice。进程与通知不是跨崩溃持久队列。")
code(s, 'bash { mode: "start", command: "pnpm test" }\n→ taskId / pid / outputPath', .5, 1.57, 9, .76, 11.5)
card(s, .5, 2.66, 2.8, 1.43, "运行与等待", "进程输出写日志\nwait / output 共享读取游标", size=11.5)
card(s, 3.60, 2.66, 2.8, 1.43, "终态触发", "完成、失败或停止\n生成有界输出尾部", size=11.5)
card(s, 6.70, 2.66, 2.8, 1.43, "空闲时去重", "模型已在完成回合读到？\n是：丢弃 wake；否：入队", size=11.5)
arrow(s, 3.31, 3.34, 3.58, 3.34)
arrow(s, 6.41, 3.34, 6.68, 3.34)
band(s, "通知记为 taskNotification，不伪装成 userInput；headless 需要在当前运行中显式等待。")

# 11 — Context controls solve different problems, not one automatic compactor.
s = base("05 · Context management", "上下文管理不是一个开关，而是几种分工",
         sources=("src/agent/context-anchor.ts", "src/tui/context-format.ts", "src/agent/compact.ts"),
         notes="/context用SDK Model.countTokens以及Darwin provider-usage锚点估算；缓存命中也占上下文窗口。contextWarnRatio默认0.8；仅在回合结束后显示有界提醒，不调用模型或自动compact。Darwin没有开启proactiveCompression，但SDK conversation manager保留真实overflow后的reactive summarization/retry；因此不能声称系统从不自动摘要。当前采用conversationManager与ContextOffloader，而非实验性contextManager。")
card(s, .5, 1.59, 4.35, 1.19, "看得见：/context", "provider 实测锚点 + 新增消息计数；\n分项展示提示词、工具与消息。", size=11.5)
card(s, 5.15, 1.59, 4.35, 1.19, "提醒：压力阈值", "默认 80% 提醒一次；持续高位不重复。\n不自动改写历史。", size=11.5)
card(s, .5, 3.06, 4.35, 1.19, "少携带：offloading", "大工具结果留在磁盘；上下文里保留预览和可检索引用。", size=11.5)
card(s, 5.15, 3.06, 4.35, 1.19, "改写历史：/compact", "用户主动发起摘要，保留近期消息；实际会调用模型。", size=11.5)
band(s, "80% 提醒不触发自动压缩；真正溢出时，SDK 仍保留反应式摘要恢复。")

# 12 — Offload contents and storage remain distinguishable from summary.
s = base("05 · Offloading", "大结果放磁盘，模型按需取回原文",
         sources=("src/agent/runtime.ts:962–995", "src/config.ts:640–652", "SDK ContextOffloader + patch"),
         notes="父Agent默认contextOffload:true、maxResultTokens:5000；SDK默认阈值仍为2500，Darwin覆盖为5000。SDK预览默认预算1000 tokens，实际按字符估算截取。LocalFileStorage位于同一session的offload根，evictAfterCycles:null支持同session resume检索。Darwin patch提供excludeTools、恢复旧历史时首次pre-model修复，以及JSON多行字符串可读检索投影。load_skill完整正文不卸载；SDK排除错误、检索及AgentAsTool(delegate=true)结果。Darwin的subagent/workflow是普通tool，不属于这一委派豁免。不承诺跨rewind新分支引用迁移；未筛选的完整retrieval可能重新吃掉token预算。没有session GC。")
card(s, .5, 1.63, 2.73, 1.55, "工具原始结果", "完整日志 / 文件 / 搜索结果\n超过配置阈值", size=11.5)
card(s, 3.64, 1.63, 2.73, 1.55, "ContextOffloader", "完整内容存盘\n上下文只保留预览 + 引用", size=11.5)
card(s, 6.78, 1.63, 2.72, 1.55, "按需检索", "reference + pattern\n或 line_range 精确取回", size=11.5)
arrow(s, 3.26, 2.41, 3.60, 2.41)
arrow(s, 6.40, 2.41, 6.74, 2.41)
code(s, "~/.darwin/sessions/<project-key>/<session-id>/offload/", .5, 3.50, 9, .51, 11)
text(s, "默认阈值 5,000 tokens", .5, 4.26, 3.05, .36, 16, "teal", True)
text(s, "同 session 恢复后可检索；load_skill 保持完整，不当作普通长日志卸载。",
     3.83, 4.25, 5.67, .52, 11.5)

# 13 — SDK summary, explicitly controlled by Darwin's manual command.
s = base("05 · Compact", "压缩的是对话历史，不是删掉长工具结果",
         sources=("src/agent/compact.ts", "src/agent/runtime.ts:1718–1748"),
         notes="每次compact新建SummarizingConversationManager，summaryRatio:0.8，默认保留最近10条messages而非10轮。无focus完全采用SDK默认prompt；有focus追加固定节且限制400 code points。SDK负责摘要生成、工具配对边界及text-only summary；pinned patch只从包根导出DEFAULT_SUMMARIZATION_PROMPT。Darwin的reduce循环中，不缩减则撤销该pass停止；SDK返回false按失败处理并回滚。成功保存latest snapshot并更新resume pointer。/compact会调用模型、改变后续上下文；不是无损归档，trajectory仍独立保留。")
rect(s, .5, 1.66, 4.2, .55, "white", "border")
text(s, "历史：M1  M2  M3  …  M(n−10)", .69, 1.80, 3.83, .25, 13, "muted")
rect(s, 5.30, 1.66, 4.2, .55, "white", "border")
text(s, "近期：最近 10 条 messages", 5.49, 1.80, 3.83, .25, 13, "teal", True)
arrow(s, 2.60, 2.28, 2.60, 2.72)
arrow(s, 7.40, 2.28, 7.40, 2.72)
rect(s, .5, 2.82, 4.2, .64, "ink")
text(s, "SDK 生成摘要", .69, 2.99, 3.83, .32, 17, "cyan", True)
rect(s, 5.30, 2.82, 4.2, .64, "pale")
text(s, "近期消息按安全配对边界保留", 5.49, 3.01, 3.83, .28, 12.5, "teal", True)
text(s, "默认 prompt + 可选 focus", .5, 3.84, 4.2, .3, 13, "ink", True)
text(s, "focus 最多 400 字符码点；不是另写一套摘要器。", .5, 4.24, 4.2, .49, 11.5, "muted")
text(s, "失败与无缩减保护", 5.30, 3.84, 4.2, .3, 13, "ink", True)
text(s, "失败回滚；不缩减则撤销该次变更，不能虚报压缩成功。", 5.30, 4.24, 4.2, .49, 11.5, "muted")

# 14 — Never use trajectory as a substitute for a model checkpoint.
s = base("06 · Persistence", "三类持久状态，分别回答三个问题",
         sources=("src/agent/session.ts:522–535", "src/trajectory/record.ts", "src/memory/controller.ts"),
         notes="全局根~/.darwin，按project-key隔离。SDK snapshots实际路径为sessions/<project-key>/session/<id>/scopes/agent/darwin/snapshots；Darwin轨迹为sessions/<project-key>/<id>/trajectory.jsonl；project memory为projects/<project-key>/memory/state.json。SessionManager saveLatestOn:'invocation'自动恢复/保存，preset包括messages/state（序列化的appState）/systemPrompt/modelState/interrupts。trajectory有截断限额，不是无损模型状态。memory_save需权限与证据，stage后仅成功endTurn且对应trajectory闭合记录持久化才commit。TUI resume另外读取trajectory恢复人类滚屏，不把它喂回模型。")
card(s, .5, 1.66, 2.8, 2.36, "Snapshot", "“模型接着怎么想？”\nSDK SessionManager\n保存会话状态与插件状态\n支持 resume / checkpoint", size=12)
card(s, 3.6, 1.66, 2.8, 2.36, "Trajectory", "“刚才发生过什么？”\nDarwin 追加式观察记录\n支撑 replay / export / 审计\n恢复人类看到的 transcript", size=12)
card(s, 6.7, 1.66, 2.8, 2.36, "Project memory", "“下次还该记住什么？”\nDarwin 验证后的项目事实\n授权、暂存、成功后提交\n不是旧对话自动全量载入", size=12)
band(s, "三者都不是工作区备份；快照不保存活进程、shell、MCP 连接或文件系统。")

# 15 — The persistence mechanism, separate from the visible session commands.
s = base("06 · SessionManager", "持久化的是状态；恢复时重新装配运行时",
         sources=("src/agent/session.ts:522–535", "src/agent/runtime.ts:1074–1117", "SDK session-manager.js"),
         notes="createSessionManager用LocalFileStorage(sessionPaths(projectRoot).sessionsDir)、sessionId、saveLatestOn:'invocation'构造SDK SessionManager。SDK InitializedEvent恢复latest，AfterInvocationEvent保存。Darwin固定agent.id='darwin'以保持scope。snapshot preset包含messages、state（序列化的appState）、systemPrompt、modelState、interrupts；插件激活状态可经appState持久化。错误/取消后的latest不代表可选成功rewind checkpoint。Darwin lease限制同session同时一个活进程，pointer支撑bare --resume；explicit id严格选择。当前环境与prompt cache在恢复后重新整理。")
for x, n, title, body in [(.5, "01", "选择会话", "Darwin 解析 session ID\n按项目分区并持有 lease"),
                         (2.82, "02", "初始化并恢复", "新建 Agent + manager\ninitialize() 读取 latest"),
                         (5.14, "03", "普通调用", "SDK 对话与工具循环\n插件使用 appState"),
                         (7.46, "04", "结束后保存", "saveLatestOn:\n\"invocation\"")]:
    step(s, x, 1.64, 2.04, n, title, body)
for x in [2.54, 4.86, 7.18]:
    arrow(s, x+.025, 2.40, x+.255, 2.40)
code(s, "snapshot = messages + state(appState) + systemPrompt + modelState + interrupts",
     .5, 3.49, 9, .58, 11)
band(s, "latest 用于恢复；不可变 checkpoint 用于分支。一次保存，不等于一次成功验收。")

# 16 — Latest snapshots versus immutable, user-selected branch points.
s = base("06 · Session 与 checkpoint", "Resume 续接，Rewind 分支，Clear 新开",
         sources=("src/agent/rewind.ts", "src/agent/runtime.ts:2570–2757", "src/paths.ts:70–100"),
         notes="SessionManager初始化时restore latest，invocation后保存。rewind在合格文本prompt发送前保存isLatest:false不可变快照；仅SDK正常endTurn或refusal-class结束进入Darwin catalogue。失败/取消产生的快照也占每session100上限但不可选；满额不阻断普通turn。rewind新runtime恢复prompt前快照，原prompt回编辑框未发送，旧状态不改。clear也创建successor，避免沿用旧SessionManager hooks。交接MCP与background bash manager，重建session/skills/gate/offload。子agent continue只是内存对话，不是此机制。活委派或完成未交付时clear/rewind本地拒绝。")
matrix(s, ["操作", "Session 身份", "模型上下文", "旧会话与副作用"], [
    ("--resume", "原 session", "恢复 latest snapshot", "继续旧会话；资源重新装配"),
    ("/rewind", "新 session 分支", "恢复所选 prompt 之前", "原快照不改；prompt 回编辑框"),
    ("/clear", "新 session", "新建空 conversation", "不删除旧 session；交接进程资源")
], [1.30, 1.62, 2.55, 3.53], y=1.56, row_h=.50, sizes=[12, 11, 11, 11])
rect(s, .5, 3.68, 9, .53, "ink")
text(s, "Rewind：发送前保存不可变快照 → 合格结束后登记 → 用户选择后创建新分支",
     .68, 3.83, 8.64, .28, 11.5, "cyan")
band(s, "最多 100 个 rewind-owned 快照；回退不撤销文件、shell、MCP 写入或已提交记忆。", accent="amber")

# 17 — Official skills plugin plus Darwin discovery and containment checks.
s = base("07 · Skills plugin", "Skills 是按需激活的知识，不是另一个执行器",
         sources=("src/skills/plugin.ts", "src/skills/loader.ts", "src/skills/resource-safety.ts"),
         notes="当前使用SDK官方AgentSkills和Skill对象。Darwin负责built-in保留及project .darwin > project .agents > global .darwin > global .agents分层发现、安全预检与use-time realpath复验；资源预检上限200 entries。官方原生skills工具保持private，模型只见load_skill。BeforeInvocationEvent注入metadata catalogue，activatedSkills/lastInjectedXml持久到appState。/skill-name使用相同官方activation后展开普通prompt；加载skill只提供instructions和resource listing，不自动运行scripts，不提高权限。load_skill被offloader排除。")
for x, n, title, body in [(.5, "01", "发现 SKILL.md", "Darwin 分层加载\n名称保留与资源校验"),
                         (2.82, "02", "注入目录", "SDK AgentSkills\n先给名称与描述"),
                         (5.14, "03", "按需激活", "load_skill(name)\n完整说明与资源列表"),
                         (7.46, "04", "普通工具执行", "按说明调用工具\n仍然经过权限门")]:
    step(s, x, 1.66, 2.04, n, title, body)
for x in [2.54, 4.86, 7.18]:
    arrow(s, x+.025, 2.42, x+.255, 2.42)
rect(s, .5, 3.53, 9, .55, "ink")
text(s, "base → project-instructions → available_skills → working-context → cache point",
     .66, 3.70, 8.68, .28, 10.7, "cyan", font=MONO)
band(s, "目录不等于完整 skill；加载不等于执行；激活状态通过 SDK appState 跟随会话。")

# 18 — SDK extensions occupy distinct seams in the same runtime.
s = base("07 · 扩展点", "MCP、Plugin、Hook：接入位置各不相同",
         sources=("src/mcp/registry.ts", "src/skills/plugin.ts", "src/hooks/tool-hooks.ts"),
         notes="McpClient作为tool source进入Agent.tools，initialize时发现与注册工具；Darwin合并全局与项目配置、应用workspace trust、控制命名与权限。未知MCP工具默认execute，readOnly元信息不是免审批通行证。Plugin通过initAgent/注册hooks接入；AgentSkills与ContextOffloader是已使用的官方插件。Hook是SDK生命周期事件，Darwin利用BeforeToolCall/AfterToolCall/BeforeInvocation等挂策略。模型重试用AfterModelCallEvent+InvokeModelStage，不fork循环。原生配置命令hooks与Codex兼容hooks是另一个产品层适配，不是SDK插件包。")
card(s, .5, 1.63, 2.8, 2.36, "MCP：扩展工具", "McpClient → tools\n连接、发现、调用由 SDK 处理\nDarwin 加配置合并与信任边界\n工具仍经过普通 gate", size=11.5)
card(s, 3.6, 1.63, 2.8, 2.36, "Plugin：注入能力", "AgentSkills / ContextOffloader\n随 Agent 初始化\n注入目录、注册工具或 hooks\n可利用 appState 存状态", size=11.5)
card(s, 6.7, 1.63, 2.8, 2.36, "Hook：接生命周期", "工具前后 / 调用前后\n权限、观察、失败保护\nInvokeModelStage middleware\n实现可取消模型重试", size=11.5)
band(s, "扩展接入同一执行链：不新增绕过权限的入口，也不把外部内容升级成授权。")

# 19 — Preserve the provenance of capabilities and avoid obsolete patch counts.
s = base("08 · 复用边界", "哪些是 SDK，哪些是 Darwin，哪些是补丁",
         sources=("docs/architecture/load-bearing-decisions.md:32–68", "patches/@strands-agents__sdk@1.21.0.patch"),
         notes="本页是代表性分工，不是全量补丁清单。当前固定1.21.0及pnpm patch。Agent loop、default executor、Graph与backgroundTasks不靠Darwin重写。Foreground bash的stdin/cwd/process-group行为属于patch；后台bash manager是Darwin源码。ContextOffloader excludeTools、历史修复、JSON检索投影及DEFAULT_SUMMARIZATION_PROMPT根导出属于patch。当前SDK原生已提供text-only summary，勿把旧版本reasoning scrub继续算作当前本地patch。SDK新增能力不代表Darwin已启用：实验性contextManager、shared stash、vended subagent/REPL未选择。")
card(s, .5, 1.63, 2.8, 2.45, "SDK 原生", "Agent 循环与工具执行\nGraph 与 backgroundTasks\nSessionManager 与摘要\nAgentSkills / McpClient", size=12)
card(s, 3.6, 1.63, 2.8, 2.45, "Darwin 产品层", "TUI / headless 与权限门\nchild recipe、报告与限额\n后台 shell 与完成通知\nrewind、trajectory、memory", size=12)
card(s, 6.7, 1.63, 2.8, 2.45, "Pinned patch", "offload 排除 / 恢复修复\n前台 bash 的进程安全细节\nfileEditor 有界恢复提示\n默认摘要 prompt 根导出", accent="amber", size=12)
band(s, "不把“SDK 有这个能力”写成“Darwin 已经启用”；所有结论针对当前锁定版本。", accent="amber")

# 20 — Dark conclusion, echoing the original deck's closing visual treatment.
s = base("收束 · 架构选择", "复用执行机制，把工程边界留在产品层", dark=True,
         notes="这不是SDK宣传页，也不是全部源代码导览。重点回顾用户指定的Agent/subagent、后台任务结果、上下文、session/checkpoint和skills。Darwin的增值层是交互、安全边界、状态可见性和恢复语义，而不是第二套agent loop。并行与后台都不改变授权，不意味着隔离沙箱。")
card(s, .5, 1.65, 4.35, 2.40, "Strands SDK 提供机制", "怎样调用模型和执行工具\n怎样编排、摘要与保存状态\n怎样扩展能力并交付后台报告", dark=True, size=14)
card(s, 5.15, 1.65, 4.35, 2.40, "Darwin 决定产品语义", "什么可以做，什么时候需要人\n什么状态可恢复，哪些不能回滚\n什么结果该进入下一次模型调用", dark=True, size=14)
band(s, "核心原则：一套 SDK 循环，多种受控扩展；恢复上下文，不假装恢复整个世界。", dark=True)

# 21 — Reader-facing navigation; granular evidence is in each slide's notes.
s = base("附录 · 代码阅读地图", "沿着这些入口，可以把图走回代码",
         subtitle="阅读基线：" + REVISION + " · " + AS_OF + " · @strands-agents/sdk 1.21.0 + 项目补丁",
         notes="各页备注包含机制说明、边界和来源。参考原稿为docs/ppt/self-evolution-development.zh-CN.pptx；仅复用风格，不更改、不合并。SDK源码位于node_modules/@strands-agents/sdk/dist/src；锁定版本见package.json:46，补丁见pnpm-workspace.yaml。文档与源码冲突时本材料按当前源码表述，尤其offload默认阈值5000与全局项目分区session路径。")
matrix(s, ["主题", "主要入口", "对应验证脚本（spike/）"], [
    ("Agent / 子 agent", "src/agent/runtime.ts · agents/child-recipe.ts", "verify-subagents.ts"),
    ("工作流与后台委派", "agents/workflow-tool.ts · agent/background-delegation.ts", "verify-background-delegation.ts"),
    ("后台 shell 与通知", "tools/background-bash.ts · tui/task-wake.ts", "verify-task-wake.ts"),
    ("上下文", "agent/compact.ts · agent/context-anchor.ts", "verify-context-offload.ts / verify-compact.ts"),
    ("会话 / 检查点", "agent/session.ts · agent/rewind.ts", "verify-rewind.ts / verify-clear-session.ts"),
    ("Skills / MCP", "skills/plugin.ts · mcp/registry.ts", "verify-skills.ts / verify-mcp-command.ts")
], [1.55, 4.35, 3.1], y=1.92, row_h=.40, sizes=[10.2, 9.0, 9.0])
text(s, "表中省略的目录前缀均为 src/；详细机制与限制见每页演讲者备注。",
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
