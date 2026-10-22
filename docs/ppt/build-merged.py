#!/usr/bin/env python3
"""Build the merged narrative from the two reviewed Chinese decks.

Run: python3 docs/ppt/build-merged.py --output /tmp/darwin-merged.pptx
Sources are read-only and hash-pinned. Existing outputs require their exact digest.
Architecture slides contain native shapes only; relationship-bearing shapes are
refused rather than copied incompletely. Story slides stay in their original
package, preserving charts, embedded workbooks, images and notes.
"""
import argparse
from copy import deepcopy
import hashlib
from pathlib import Path
import re

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Inches, Pt

HERE = Path(__file__).resolve().parent
SOURCES = {
    "story": (HERE / "self-evolution-development.zh-CN.plain.pptx",
              "c37e1b9f41650f35855ca30c0f616d4e5f49c79f35682671030e73bc6749e705"),
    "architecture": (HERE / "darwin-architecture-strands-sdk.zh-CN.pptx",
                     "ab8ab92351f879f46e67e6b09c38709b52ebcf6e4d368a241c7d1ca183d365d1"),
}
ORDER = (
    [("story", i) for i in range(1, 14)]
    + [("story", 16), ("story", 17)]
    + [("architecture", 1), ("architecture", 2)]
    + [("architecture", i) for i in range(4, 19)]
    + [("story", i) for i in range(19, 23)]
    + [("architecture", i) for i in (3, 19, 21)]
    + [("story", 14), ("story", 15)]
)
FOOTER = "Darwin · 自进化开发与架构"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def set_text(shape, value):
    """Keep typography of a reviewed single-paragraph caption or heading."""
    paragraphs = shape.text_frame.paragraphs
    if len(paragraphs) != 1 or not paragraphs[0].runs:
        raise ValueError(f"Expected one styled paragraph: {shape.text!r}")
    runs = paragraphs[0].runs
    runs[0].text = value
    for run in runs[1:]:
        run.text = ""


def replace(slide, old, new, *, x=None):
    matches = [s for s in slide.shapes if s.has_text_frame and s.text == old
               and (x is None or abs(s.left - Inches(x)) < 5)]
    if not matches:
        runs = [(shape, run) for shape in slide.shapes if shape.has_text_frame
                for paragraph in shape.text_frame.paragraphs for run in paragraph.runs
                if run.text == old and (x is None or abs(shape.left-Inches(x)) < 5)]
        if len(runs) == 1:
            runs[0][1].text = new
            return runs[0][0]
    if len(matches) != 1:
        raise ValueError(f"Expected one occurrence of {old!r}, got {len(matches)}")
    set_text(matches[0], new)
    return matches[0]


def add_note(slide, text):
    tf = slide.notes_slide.notes_text_frame
    tf.text = tf.text.rstrip() + "\n\n合并版说明：" + text


def page_number(slide, index):
    # Top-right stays clear of the story deck's bottom-right screenshots.
    shape = slide.shapes.add_textbox(Inches(9.05), Inches(.30), Inches(.45), Inches(.22))
    tf = shape.text_frame
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = MSO_ANCHOR.TOP
    paragraph = tf.paragraphs[0]
    paragraph.alignment = PP_ALIGN.RIGHT
    run = paragraph.add_run()
    run.text = f"{index:02d}"
    run.font.name = "Georgia"
    run.font.size = Pt(9)
    bg = slide._element.cSld.xpath("./p:bg/p:bgPr/a:solidFill/a:srgbClr")
    dark = bool(bg and bg[0].get("val", "").upper() == "0F1720")
    run.font.color.rgb = RGBColor.from_string("B5BFCC" if dark else "6B7280")
    return shape


def standardize(slide, source, number, global_number):
    for shape in list(slide.shapes):
        if not shape.has_text_frame:
            continue
        if shape.text in ("Self Evolution Development · darwin", "Darwin Architecture · Strands SDK"):
            set_text(shape, FOOTER)
        if (source == "architecture" and shape.text == f"{number:02d}"
                and shape.top > Inches(5) and shape.left > Inches(9)):
            shape._element.getparent().remove(shape._element)
    if source == "architecture" and number not in (1, 3, 19, 21):
        for shape in slide.shapes:
            if shape.has_text_frame and shape.top < Inches(.5) and re.match(r"^\d{2} · ", shape.text):
                set_text(shape, re.sub(r"^\d{2} · ", "架构 · ", shape.text))
    page_number(slide, global_number)
    add_note(slide, f"第 {global_number} 页，来源为 {SOURCES[source][0].name} 第 {number} 页。")
    for shape in slide.notes_slide.shapes:
        if shape.has_text_frame and shape._element.xpath(".//p:ph[@type='sldNum']"):
            shape.text_frame.text = str(global_number)

def import_native_slide(presentation, source):
    """Import the checked, relationship-free artwork through python-pptx.

    Keep the destination spTree object: python-pptx's cached SlideShapes holds it.
    Notes use library-created parts so names and back-references remain valid.
    """
    allowed = {"slideLayout", "notesSlide"}
    if any(r.reltype.rsplit("/", 1)[-1] not in allowed for r in source.part.rels.values()):
        raise ValueError("Architecture slide has relationships requiring a full part-graph import")
    for element in source._element.iter():
        if any(name.startswith("{" + REL_NS + "}") for name in element.attrib):
            raise ValueError("Architecture artwork unexpectedly references an external part")
    layout = presentation.slide_layouts[0]
    if len(layout.placeholders):
        raise ValueError("Story layout must be the verified placeholder-free DEFAULT layout")
    dest = presentation.slides.add_slide(layout)
    src_tree = source._element.cSld.xpath("./p:spTree")[0]
    dst_tree = dest._element.cSld.xpath("./p:spTree")[0]
    for element in list(dst_tree):
        dst_tree.remove(element)
    for element in src_tree:
        dst_tree.append(deepcopy(element))
    dest._element.attrib.update(source._element.attrib)
    dest._element.cSld.attrib.update(source._element.cSld.attrib)
    for element in list(dest._element.cSld):
        if element is not dst_tree:
            dest._element.cSld.remove(element)
    for element in source._element.cSld:
        if element is not src_tree:
            dest._element.cSld.insert(0, deepcopy(element))
    for element in list(dest._element):
        if element is not dest._element.cSld:
            dest._element.remove(element)
    for element in source._element:
        if element is not source._element.cSld:
            dest._element.append(deepcopy(element))
    notes = dest.notes_slide
    if notes.notes_text_frame is None:
        # The story deck's notes master has no placeholders. Reuse its existing
        # valid notes layout, while keeping the newly created part/backlink.
        template = presentation.slides[0].notes_slide._element.cSld.xpath("./p:spTree")[0]
        tree = notes._element.cSld.xpath("./p:spTree")[0]
        for element in list(tree):
            tree.remove(element)
        for element in template:
            tree.append(deepcopy(element))
    if notes.notes_text_frame is None:
        raise ValueError("The source notes layout has no body placeholder")
    notes.notes_text_frame.text = source.notes_slide.notes_text_frame.text
    return dest


def assemble():
    for path, expected in SOURCES.values():
        if digest(path) != expected:
            raise ValueError(f"Source changed; review it before updating the pin: {path}")
    p = Presentation(SOURCES["story"][0])
    a = Presentation(SOURCES["architecture"][0])
    assert (p.slide_width, p.slide_height) == (a.slide_width, a.slide_height)
    slides = {("story", i): slide for i, slide in enumerate(p.slides, 1)}
    ids = {("story", i): element for i, element in enumerate(p.slides._sldIdLst, 1)}
    for source, number in ORDER:
        if source != "architecture":
            continue
        slides[(source, number)] = import_native_slide(p, a.slides[number-1])
        ids[(source, number)] = p.slides._sldIdLst[-1]
    old = ids[("story", 18)]
    p.slides._sldIdLst.remove(old)
    p.part.drop_rel(old.rId)
    for element in list(p.slides._sldIdLst):
        p.slides._sldIdLst.remove(element)
    for key in ORDER:
        p.slides._sldIdLst.append(ids[key])
    assert len(p.slides) == len(ORDER) == 41
    # Stale UI sections/custom shows can reference discarded slide ids; these
    # sources have neither. Fail rather than silently keeping broken navigation.
    if p.part._element.xpath("./p:sectionLst | ./p:custShowLst"):
        raise ValueError("Source navigation needs an explicit remapping")
    p.core_properties.title = "Darwin：自进化开发与架构"
    p.core_properties.subject = "实验过程、当前架构、历史评估与后续计划"
    p.core_properties.comments = "Merged from the two reviewed Chinese decks; experiment Aug–Sep 2026, architecture snapshot 2026-10-22."
    return p, slides

def edit_narrative(p, slides):
    s = lambda n: slides[("story", n)]
    a = lambda n: slides[("architecture", n)]

    replace(s(1), "自进化迭代开发的实验", "自进化开发与 Darwin 架构")
    replace(s(1), "用 darwin 开发 darwin：三个星期的迭代记录", "实验过程、阶段结果和当前架构实现")
    replace(s(1), "2026-08-13 → 2026-09-06 · github.com/xiehust/strands-darwin",
            "实验：2026 年 8–9 月 · 架构：2026-10-22")
    add_note(s(1), "全篇依次介绍实验过程、阶段成果、当前架构、原实验的评估与计划。实验数据与架构快照使用不同时间范围。")
    replace(s(3), "路线", "实验流程")
    replace(s(3), "迭代过程概览", "实验部分的迭代过程")
    replace(s(5), "第一层", "实验 · 需求来源")
    replace(s(11), "第二层", "实验 · 执行与验收")
    replace(s(16), "第二层 · 机制", "实验 · 开发流程")
    add_note(s(17), "阶段成果之后转入架构说明。以下架构按 2026-10-22 的代码整理，不能与本页三周实验统计视作同一版本。")

    # Convert the second deck's cover into a section divider, not a second opening.
    replace(a(1), "架构篇 · 独立补充材料", "架构实现 · 2026-10-22")
    replace(a(1), "Darwin", "当前版本", x=.5)
    replace(a(1), "Architecture", "架构实现")
    replace(a(1), "整体架构与 Strands SDK", "Strands SDK 1.21.0 + 项目补丁")
    replace(a(1), "Agent、子任务、上下文管理和会话恢复的实现。",
            "介绍 Agent、后台任务、上下文与会话管理。")
    a(1).notes_slide.notes_text_frame.text = (
        "前面介绍实验过程和阶段成果，下面介绍这些流程在当前版本中的实现。\n"
        "架构快照：2026-10-22；commit dec1cd3；Strands SDK 1.21.0 + 项目补丁。\n"
        "这部分不代表 8–9 月实验期间的全部实现，也不将后文历史测试作为此版本的测试结果。"
    )
    replace(a(8), "两类任务都通过权限检查，完成通知进入同一个 TUI 队列。",
            "subagent/workflow 在进程内运行；/developer 另起 headless darwin 进程。")
    add_note(a(8), "与前面 /developer 区分：后台 subagent/workflow 使用当前进程的 SDK 任务引擎，/developer 则监督一个完整的 headless Darwin 子进程。两类后台通道仍共用权限检查与 TUI 通知队列。")

    replace(s(19), "DeepSWE 前 20 题 · 2026-09-05 / 09-08",
            "实验评估 · DeepSWE 前 20 题 · 2026-09-05 / 09-08")
    replace(s(19),
            "同一个模型（Bedrock 上的 Claude Opus 5）、同一批任务，只换 agent：darwin 是 commit 2240a3c，Claude Code 是 2.1.261。9 月 8 日两个 harness 各自把 effort 从 high 降到 medium 再跑一轮，其余不变。",
            "以下回到 9 月的测试，不对应 10 月架构快照。模型为 Bedrock Claude Opus 5，darwin 为 2240a3c，Claude Code 为 2.1.261。9 月 8 日仅把 effort 从 high 改为 medium，任务和其他配置不变。")
    add_note(s(19), "此页是原实验的历史测试，darwin 为 2240a3c。不是对前面 dec1cd3 架构快照重新运行的测试。")
    replace(s(20), "RSI · 四类模式 · 对照", "原实验 · 方法对照")
    replace(s(20), "darwin 已有运行证据和修改范围限制，独立评估仍需补充：",
            "原实验已有运行证据和修改范围限制，持续评估仍需补充：")
    replace(s(20), "只有回归测试和人审 diff，没有留外任务集", "迭代验收未接入独立留出任务集")
    replace(s(20),
            "darwin 主要属于第三类：在人工审核下修改自身框架。模型能力仍是限制，独立测试集和外部验证器计划通过 Harbor 补充。",
            "以上为原实验的方法对照。上一页的同题测试不等于持续评估流程；当时计划通过 Harbor 接入独立测试集和验证器。")
    add_note(s(20), "方法分类与待补充项沿用原实验记录，不表示 2026-10-22 的实现进度。一次同题测试与持续的独立留出评估是不同事项。")
    replace(s(21), "未来方向 ·ROADMAP", "原实验 · 后续评估计划")
    replace(s(21), "下一步：增加独立量化评估", "原稿提出的后续评估计划")
    replace(s(21), "现在缺什么", "当时的评估不足")
    add_note(s(21), "本页展示原稿提出的计划，并未在此次合并中核验其截至 10 月的落地进度。保留计划与已完成结果的区别。")
    replace(s(22), "实验结果与仍需人工决定的部分", "总结：已完成的流程与人工职责")

    # Reference material follows the conclusion and is not part of the main talk.
    replace(a(3), "01 · SDK 使用情况", "附录 A · SDK 功能对照")
    replace(a(19), "08 · 实现来源", "附录 B · SDK 与本地实现")
    replace(a(21), "附录 · 源码与测试", "附录 C · 源码与测试")
    tf = a(21).notes_slide.notes_text_frame
    tf.text = tf.text.replace("原文件未修改或合并。", "源文件保持不变，本页作为合并版附录。")
    replace(s(14), "第二层 · 踩坑 1", "隐藏附录 D · 原实验的 token 消耗")
    replace(s(14),
            "互不依赖的读取、搜索、检查在同一条消息里批量发出。现在一个方向典型花费 1–16 美元、12–170 次调用。",
            "互不依赖的读取、搜索、检查在同一条消息里批量发出。当时一个方向典型花费 1–16 美元、12–170 次调用。")
    replace(s(15), "第二层 · 踩坑 2", "隐藏附录 E · 原实验的执行问题")
    for n in (14, 15):
        add_note(s(n), "保留源文件的隐藏状态，移到附录供问答使用。数据属于原实验，不是当前版本的成本或能力指标。")
    for index, (source, number) in enumerate(ORDER, 1):
        standardize(slides[(source, number)], source, number, index)

def validate(p):
    assert len(ORDER) == len(set(ORDER)) == len(p.slides) == 41
    assert [i for i,s in enumerate(p.slides,1) if s._element.get("show") == "0"] == [40,41]
    for i, slide in enumerate(p.slides, 1):
        if not slide.notes_slide.notes_text_frame.text.strip():
            raise ValueError(f"Missing notes on slide {i}")
        text = "\n".join(s.text for s in slide.shapes if s.has_text_frame)
        if "独立补充材料" in text:
            raise ValueError(f"Standalone-cover wording remains on slide {i}")
        for shape in slide.shapes:
            if (shape.left < 0 or shape.top < 0 or
                    shape.left+shape.width > p.slide_width+100 or
                    shape.top+shape.height > p.slide_height+100):
                raise ValueError(f"Slide {i} has out-of-canvas geometry: {shape.name}")
    original = Presentation(SOURCES["story"][0])
    for i,(source, number) in enumerate(ORDER):
        if source != "story":
            continue
        before, after = original.slides[number-1], p.slides[i]
        old_tables = [[[c.text for c in row.cells] for row in shape.table.rows]
                      for shape in before.shapes if shape.has_table]
        new_tables = [[[c.text for c in row.cells] for row in shape.table.rows]
                      for shape in after.shapes if shape.has_table]
        assert old_tables == new_tables, f"Data table changed on slide {i+1}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--replace-sha256")
    args = parser.parse_args()
    if args.output.resolve() in [p.resolve() for p,_ in SOURCES.values()]:
        parser.error("Refusing to overwrite a source deck")
    if args.output.exists() and digest(args.output) != args.replace_sha256:
        parser.error("Output exists; supply its exact --replace-sha256")
    p, slides = assemble()
    edit_narrative(p, slides)
    validate(p)
    p.save(args.output)
    for source, expected in SOURCES.values():
        assert digest(source) == expected, f"Source changed: {source}"
    print(f"Created {args.output}: {len(p.slides)} slides; 36 main + 5 appendix, 2 hidden")


if __name__ == "__main__":
    main()
