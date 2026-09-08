// Portrait (9:16, phone-sized) twin of build-deck.cjs: same 23 slides, same content, same
// palette, re-laid out for one image per slide on mobile. Writes
// docs/blog/self-evolution-development.zh-CN.mobile.pptx. Captions come from captions.cjs
// (speaker notes only; build-deck.cjs owns wechat-captions.zh-CN.md).
// Run: NODE_PATH=$(npm root -g) node docs/blog/slides/build-deck-portrait.cjs
const path = require("node:path");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const {
  FaTerminal, FaUserEdit, FaRobot, FaCompass, FaDice, FaSearch,
  FaFileAlt, FaVial, FaUserShield, FaSyncAlt, FaCoins, FaClipboardCheck,
  FaBalanceScale, FaHourglassHalf, FaRedoAlt, FaLayerGroup, FaGithub, FaCodeBranch,
} = require("react-icons/fa");
const { CAPTIONS } = require("./captions.cjs");

const IMG = (name) => path.join(__dirname, "..", "images", name);
const OUT = path.join(__dirname, "..", "self-evolution-development.zh-CN.mobile.pptx");

const C = {
  ink: "0F1720", paper: "F7F5F0", card: "FFFFFF", cyan: "1493A8", cyanBright: "33C3E0",
  amber: "D97706", muted: "6B7280", line: "D9D4C7", white: "FFFFFF", dim: "9AA4B2",
};
const HF = "Microsoft YaHei";
const NF = "Georgia";

// 9:16 → 1080 × 1920 px at 144 dpi. For 3:4 use H = 10.
const W = 7.5, H = 13.333, M = 0.5, CW = W - 2 * M;

function svg(Icon, color, size = 256) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Icon, { color, size: String(size) }));
}
async function icon(Icon, color) {
  const png = await sharp(Buffer.from(svg(Icon, "#" + color))).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}
function fit(px, py, boxX, boxY, boxW, boxH) {
  const r = px / py;
  let w = boxW, h = w / r;
  if (h > boxH) { h = boxH; w = h * r; }
  return { x: boxX + (boxW - w) / 2, y: boxY + (boxH - h) / 2, w, h };
}
const shadow = () => ({ type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.10 });

async function main() {
  const pres = new pptxgen();
  pres.defineLayout({ name: "PORTRAIT", width: W, height: H });
  pres.layout = "PORTRAIT";
  pres.title = "Self Evolution Development —— 自进化迭代开发的实验（手机版）";
  pres.author = "darwin";

  // ---- shared pieces --------------------------------------------------------
  function footer(s, dark) {
    s.addText("Self Evolution Development · darwin", { x: M, y: H - 0.5, w: 5, h: 0.3, fontFace: NF, fontSize: 10, color: dark ? C.dim : C.muted, margin: 0 });
  }
  function lightSlide(title, kicker, opts = {}) {
    const s = pres.addSlide();
    s.background = { color: C.paper };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.14, h: H, fill: { color: C.cyan }, line: { color: C.cyan } });
    if (kicker) s.addText(kicker, { x: M, y: 0.55, w: CW, h: 0.32, fontFace: NF, fontSize: 12, color: C.cyan, charSpacing: 2, margin: 0 });
    s.addText(title, { x: M, y: 0.9, w: CW, h: 1.0, fontFace: HF, fontSize: opts.size || 28, bold: true, color: C.ink, margin: 0, valign: "top" });
    footer(s, false);
    return s;
  }
  function darkSlide() {
    const s = pres.addSlide();
    s.background = { color: C.ink };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.14, h: H, fill: { color: C.cyanBright }, line: { color: C.cyanBright } });
    return s;
  }
  // Step slide: kicker = the step, problem in large type, the answer in cyan. Content from y ≈ 2.7.
  function problemSlide(step, problem, solution) {
    const s = pres.addSlide();
    s.background = { color: C.paper };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.14, h: H, fill: { color: C.cyan }, line: { color: C.cyan } });
    s.addText(step, { x: M, y: 0.55, w: CW, h: 0.32, fontFace: NF, fontSize: 12, color: C.cyan, charSpacing: 2, margin: 0 });
    s.addText("问题", { x: M, y: 0.92, w: 0.7, h: 0.3, fontFace: HF, fontSize: 11, color: C.muted, margin: 0 });
    s.addText(problem, { x: M, y: 1.18, w: CW, h: 0.85, fontFace: HF, fontSize: 21, bold: true, color: C.ink, margin: 0, valign: "top" });
    s.addText("解法", { x: M, y: 2.05, w: 0.7, h: 0.3, fontFace: HF, fontSize: 11, color: C.muted, margin: 0 });
    s.addText(solution, { x: M, y: 2.3, w: CW, h: 0.6, fontFace: HF, fontSize: 13.5, bold: true, color: C.cyan, margin: 0, valign: "top" });
    footer(s, false);
    return s;
  }
  function dividerSlide(index, title, body) {
    const s = darkSlide();
    s.addText(index, { x: M, y: 4.4, w: CW, h: 0.4, fontFace: NF, fontSize: 14, color: C.cyanBright, charSpacing: 3, margin: 0 });
    s.addText(title, { x: M, y: 4.9, w: CW, h: 1.4, fontFace: HF, fontSize: 32, bold: true, color: C.white, margin: 0, valign: "top" });
    s.addText(body, { x: M, y: 6.5, w: CW, h: 2.6, fontFace: HF, fontSize: 15, color: C.dim, margin: 0, valign: "top", lineSpacingMultiple: 1.2 });
    footer(s, true);
    return s;
  }
  function chip(s, text, x, y, w, opts = {}) {
    const h = opts.h || 0.42;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: opts.bg || C.ink }, line: { color: opts.bg || C.ink }, rectRadius: 0.06 });
    s.addText(text, { x: x + 0.1, y, w: w - 0.2, h, fontFace: "Consolas", fontSize: opts.size || 12, color: opts.fg || C.cyanBright, valign: "middle", margin: 0 });
  }
  function card(s, x, y, w, h) {
    s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { color: C.card }, line: { color: C.line, width: 0.75 }, shadow: shadow() });
  }
  async function iconRow(s, Icon, x, y, w, head, body, opts = {}) {
    const d = opts.d || 0.5;
    s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: opts.circle || C.cyan }, line: { color: opts.circle || C.cyan } });
    s.addImage({ data: await icon(Icon, C.white), x: x + d * 0.25, y: y + d * 0.25, w: d * 0.5, h: d * 0.5 });
    s.addText(head, { x: x + d + 0.2, y: y - 0.03, w: w - d - 0.2, h: 0.38, fontFace: HF, fontSize: 15, bold: true, color: C.ink, margin: 0 });
    s.addText(body, { x: x + d + 0.2, y: y + 0.36, w: w - d - 0.2, h: opts.bodyH || 0.9, fontFace: HF, fontSize: 12, color: C.muted, valign: "top", margin: 0 });
  }
  function stat(s, x, y, w, num, label, opts = {}) {
    const runs = Array.isArray(num)
      ? [{ text: num[0], options: { fontFace: NF } }, { text: num[1], options: { fontFace: HF, fontSize: Math.round((opts.size || 34) * 0.55) } }]
      : num;
    s.addText(runs, { x, y, w, h: 0.75, fontFace: NF, fontSize: opts.size || 34, bold: true, color: opts.color || C.cyan, margin: 0, valign: "bottom" });
    s.addText(label, { x, y: y + 0.76, w, h: 0.45, fontFace: HF, fontSize: 12, color: C.muted, margin: 0, valign: "top" });
  }
  const bullets = (items) => items.map((t, k) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: k < items.length - 1 } }));
  // A stacked card with an icon circle, a heading and a body — the portrait form of the
  // landscape 2×2 grids.
  async function iconCard(s, Icon, color, head, body, y, h, opts = {}) {
    const dark = opts.dark === true;
    s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: CW, h, fill: { color: dark ? C.ink : C.card }, line: { color: dark ? C.ink : C.line, width: 0.75 }, shadow: shadow() });
    const d = 0.5;
    s.addShape(pres.shapes.OVAL, { x: M + 0.25, y: y + 0.25, w: d, h: d, fill: { color }, line: { color } });
    s.addImage({ data: await icon(Icon, dark ? C.ink : C.white), x: M + 0.25 + d * 0.25, y: y + 0.25 + d * 0.25, w: d * 0.5, h: d * 0.5 });
    s.addText(head, { x: M + 0.95, y: y + 0.25, w: CW - 1.2, h: 0.5, fontFace: HF, fontSize: 15, bold: true, color: dark ? C.white : C.ink, margin: 0, valign: "middle" });
    s.addText(body, { x: M + 0.25, y: y + 0.9, w: CW - 0.5, h: h - 1.05, fontFace: HF, fontSize: 12.5, color: dark ? C.dim : C.muted, margin: 0, valign: "top", lineSpacingMultiple: 1.1 });
  }

  // ==== 1. 封面 ================================================================
  {
    const s = darkSlide();
    s.addText("Self Evolution", { x: M, y: 1.5, w: CW, h: 0.8, fontFace: NF, fontSize: 44, bold: true, color: C.white, margin: 0 });
    s.addText("Development", { x: M, y: 2.25, w: CW, h: 0.8, fontFace: NF, fontSize: 44, bold: true, color: C.cyanBright, margin: 0 });
    s.addText("自进化迭代开发的实验", { x: M, y: 3.25, w: CW, h: 0.55, fontFace: HF, fontSize: 24, color: C.white, margin: 0 });
    s.addText("让一个 coding agent 接手自己的开发，三个星期后发生了什么", { x: M, y: 3.9, w: CW, h: 0.5, fontFace: HF, fontSize: 13.5, color: C.dim, margin: 0 });
    chip(s, "you> /self-evolution-research", M, 4.7, 4.6, { bg: "1B2633" });
    const f = fit(1242, 434, M, 5.9, CW, 3.0);
    s.addShape(pres.shapes.RECTANGLE, { x: f.x - 0.12, y: f.y - 0.12, w: f.w + 0.24, h: f.h + 0.24, fill: { color: "1B2633" }, line: { color: "2A3A4D", width: 0.75 } });
    s.addImage({ path: IMG("00-welcome.png"), ...f });
    s.addText("2026-08-13 → 2026-09-06", { x: M, y: 11.3, w: CW, h: 0.4, fontFace: NF, fontSize: 13, color: C.dim, margin: 0 });
    s.addText("github.com/xiehust/strands-darwin", { x: M, y: 11.75, w: CW, h: 0.4, fontFace: NF, fontSize: 13, color: C.dim, margin: 0 });
    footer(s, true);
  }

  // ==== 2. 起因 ================================================================
  {
    const s = lightSlide("想验证两件事", "起因");
    s.addText("现在的模型和 agent 框架，够不够让一个 coding agent 接手自己的开发——从提需求、实现、测试、验收到提交整条链都由它自己跑，人只在边界上做决定。",
      { x: M, y: 2.0, w: CW, h: 1.2, fontFace: HF, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" });
    await iconRow(s, FaSearch, M, 3.4, CW, "受 Auto Research 和 agent 自我改进的启发", "Karpathy 的 autoresearch、Sakana 的 Darwin Gödel Machine 都在问同一个问题：把改进的循环交给 agent 之后，人还需要留在哪里。", { bodyH: 0.9 });
    await iconRow(s, FaLayerGroup, M, 4.8, CW, "顺带压测 Strands SDK", "权限拦截、上下文压缩和卸载、子 agent 编排、多模型切换、会话恢复，它都声称支持，但没有一个足够复杂的项目同时压过。", { bodyH: 0.9, circle: "50808E" });
    await iconRow(s, FaCodeBranch, M, 6.2, CW, "基线固定在 v0.0.1", "8 月 13 日用 Claude Code 搭出来，之后每一次提交都由当时最新的 darwin 自己写。", { bodyH: 0.7, circle: C.amber });
    s.addShape(pres.shapes.RECTANGLE, { x: M, y: 7.6, w: CW, h: 3.6, fill: { color: C.ink }, line: { color: C.ink } });
    s.addText("规则只有一条", { x: M + 0.35, y: 7.9, w: CW - 0.7, h: 0.4, fontFace: HF, fontSize: 13, color: C.dim, margin: 0 });
    s.addText("每一版通过验收的 darwin，就是开发下一版的工具。", { x: M + 0.35, y: 8.35, w: CW - 0.7, h: 1.1, fontFace: HF, fontSize: 21, bold: true, color: C.white, margin: 0, valign: "top" });
    s.addText("代码库本身就是实验和测试环境。", { x: M + 0.35, y: 9.55, w: CW - 0.7, h: 0.45, fontFace: HF, fontSize: 14, color: C.cyanBright, margin: 0 });
    chip(s, "git tag v0.0.1  # 2026-08-13", M + 0.35, 10.3, 4.4, { bg: "1B2633" });
  }

  // ==== 3. 路线图（两层问题） ===================================================
  {
    const s = lightSlide("两层问题，七步", "路线");
    s.addText("回头看，三周的迭代其实在回答两个问题。第一个是迭代方向从哪来：从人一条条提，逐步过渡到 darwin 自己定。第二个是方向定了之后，每一轮怎么做好。",
      { x: M, y: 2.0, w: CW, h: 1.0, fontFace: HF, fontSize: 12.5, color: C.muted, margin: 0, valign: "top" });
    const layers = [
      ["第一层 · 迭代方向从哪来", C.cyan, [
        ["第一步", "搭基线", "Claude Code 写的 v0.0.1", FaCodeBranch],
        ["第二步", "人提需求", "人是唯一的方向来源", FaUserEdit],
        ["第三步", "Claude Code 替我提", "方向来源换成另一个 agent", FaRobot],
        ["第四步", "darwin 驱动 darwin", "让 darwin 有能力给自己派活", FaSyncAlt],
        ["第五步", "自己找方向", "研究 + backlog + 评分门槛", FaCompass],
        ["第六步", "骰子选路径", "跳出局部最优", FaDice],
      ]],
      ["第二层 · 方向定了，每一轮怎么做好", C.amber, [
        ["第七步", "反思轨迹", "从自己的运行记录里找改进点", FaSearch],
        ["踩坑", "token、验收、泄漏、流程", "每个坑改一次流程或提示词", FaCoins],
        ["机制", "文件、真实测试、边界、新版本接手", "让循环跑三周不失控", FaFileAlt],
      ]],
    ];
    let ly = 3.2;
    for (const [name, color, steps] of layers) {
      const rows = Math.ceil(steps.length / 2), cellH = 1.05, cellW = (CW - 0.25 - 0.2) / 2;
      s.addShape(pres.shapes.RECTANGLE, { x: M, y: ly, w: 0.07, h: 0.4 + rows * cellH, fill: { color }, line: { color } });
      s.addText(name, { x: M + 0.25, y: ly, w: CW - 0.25, h: 0.35, fontFace: HF, fontSize: 14, bold: true, color, margin: 0 });
      for (let i = 0; i < steps.length; i++) {
        const [step, head, body, Icon] = steps[i];
        const x = M + 0.25 + (i % 2) * (cellW + 0.2), y = ly + 0.45 + Math.floor(i / 2) * cellH, d = 0.38;
        s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color }, line: { color } });
        s.addImage({ data: await icon(Icon, C.white), x: x + d * 0.25, y: y + d * 0.25, w: d * 0.5, h: d * 0.5 });
        s.addText(step, { x: x + d + 0.12, y, w: cellW - d - 0.12, h: d, fontFace: NF, fontSize: 10.5, color: C.muted, margin: 0, valign: "middle" });
        s.addText(head, { x, y: y + 0.44, w: cellW, h: 0.3, fontFace: HF, fontSize: 12.5, bold: true, color: C.ink, margin: 0 });
        s.addText(body, { x, y: y + 0.72, w: cellW, h: 0.3, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, valign: "top" });
      }
      ly += 0.45 + rows * cellH + 0.5;
    }
  }

  // ==== 4. 第一步：基线 ========================================================
  {
    const s = lightSlide("用 Claude Code 搭一个基线", "第一步 · 2026-08-13");
    s.addText("给 Claude Code 的提示词只有一句：", { x: M, y: 2.0, w: CW, h: 0.35, fontFace: HF, fontSize: 12, color: C.muted, margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: M, y: 2.4, w: CW, h: 1.05, fill: { color: C.ink }, line: { color: C.ink } });
    s.addText("使用 strands sdk ts 版，搭建一个 tui 的简单的单体 agent 模式的 coding agent MVP，支持 skills，mcp 等基础功能。",
      { x: M + 0.25, y: 2.4, w: CW - 0.5, h: 1.05, fontFace: HF, fontSize: 12.5, italic: true, color: C.white, margin: 0, valign: "middle" });
    s.addText("PRD 里定下一条原则：能用 SDK 的就不自己造。两天、19 个 commit，v0.0.1 出来了。验收标准是能改真实代码——在一个真的 git 仓库里对话，agent 读文件、改文件、跑命令，独立完成一次小修改。",
      { x: M, y: 3.65, w: CW, h: 1.3, fontFace: HF, fontSize: 12.5, color: C.ink, margin: 0, valign: "top" });
    stat(s, M, 5.0, 2.1, "19", "commit", { size: 32 });
    stat(s, M + 2.2, 5.0, 2.2, "~3,100", "行 TypeScript", { size: 32 });
    stat(s, M + 4.5, 5.0, 2.0, "18", "验证脚本", { size: 32 });
    card(s, M, 6.5, CW, 5.9);
    s.addText("v0.0.1 有什么", { x: M + 0.3, y: 6.7, w: CW - 0.6, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color: C.ink, margin: 0 });
    const items = [
      ["复用 SDK", "Bedrock 上的 Claude；bash / fileEditor 工具；SessionManager 会话和 --resume；SDK 的对话压缩"],
      ["MCP", "SDK McpClient，stdio 和 Streamable HTTP，沿用 .mcp.json 格式"],
      ["权限", "读放行，写和执行前弹 y/n；SDK hook 拦截，不改 agent loop。次日加 default / auto / yolo"],
      ["Skills（唯一自建）", "TS SDK 当时没有 Skills：扫 SKILL.md，load_skill 按需加载，/skill-name 手动触发"],
      ["TUI 与项目层", "Ink 消息流、工具面板、确认框；预载 AGENTS.md，配置收进 .darwin/"],
    ];
    items.forEach(([h, b], i) => {
      const y = 7.25 + i * 1.0;
      s.addText(h, { x: M + 0.3, y, w: 1.75, h: 0.9, fontFace: HF, fontSize: 12, bold: true, color: i === 3 ? C.amber : C.cyan, margin: 0, valign: "top" });
      s.addText(b, { x: M + 2.1, y, w: CW - 2.4, h: 0.95, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, valign: "top" });
    });
  }

  // ==== 5. 分隔：第一层 ========================================================
  dividerSlide("第一层", "迭代方向从哪来？", "自我迭代最难的一步是决定下一步改什么。这一层讲方向来源怎么一步步从人手里交出去：人自己提，换成另一个 agent 提，再到 darwin 能给自己派活，最后 darwin 自己研究、自己排优先级，并用随机性避免只盯着一处看。");

  // ==== 6. 第二、三步 ==========================================================
  {
    const s = problemSlide("第二步 · 第三步", "方向全靠我一条条提，人成了瓶颈", "先让 Claude Code 扮演开发者替我提需求，每个需求用最新的 darwin 去做");
    s.addText([
      { text: "第二步：", options: { bold: true, color: C.cyan } },
      { text: "我在 darwin 仓库里启动 darwin，一条条提需求：system prompt 可配置、prompt caching、/usage、通配符权限、/effort。验证了一个前提：darwin 改自己的源码不会把自己弄坏。但方向只有一个来源，就是我。", options: { breakLine: true } },
      { text: " ", options: { breakLine: true, fontSize: 8 } },
      { text: "第三步：", options: { bold: true, color: C.cyan } },
      { text: "提需求很花时间，而且我提的不见得比模型提得好。8 月 14 日晚上给 Claude Code 一条指令：" },
    ], { x: M, y: 3.1, w: CW, h: 2.0, fontFace: HF, fontSize: 12.5, color: C.ink, margin: 0, valign: "top" });
    s.addShape(pres.shapes.RECTANGLE, { x: M, y: 5.2, w: CW, h: 1.3, fill: { color: C.ink }, line: { color: C.ink } });
    s.addText("现在开始你扮演一个开发者，不要修改 repo 中的任何代码，只负责提出需求，用 darwin 来迭代自己……迭代下一个需求时，用最新的 darwin 启动去迭代。",
      { x: M + 0.25, y: 5.2, w: CW - 0.5, h: 1.3, fontFace: HF, fontSize: 12, color: C.white, margin: 0, valign: "middle", italic: true });
    const f = fit(2278, 962, M, 6.9, CW, 3.2);
    s.addImage({ path: IMG("01-cc-as-developer.png"), ...f, shadow: shadow() });
    s.addText("Claude Code 以开发者口吻提出的前六个需求。第 6 条 /compact 由第 5 条刚接入的模型驱动完成。方向来源从人换成了另一个 agent，但还是在 darwin 外面。",
      { x: M, y: f.y + f.h + 0.25, w: CW, h: 1.0, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 7. 第四步 /developer ===================================================
  {
    const s = problemSlide("第四步", "darwin 只能被别人驱动，不能给自己派活", "把 headless 模式、后台 bash、完成通知组装成 /developer：一个 darwin 监督另一个");
    const flow = [
      ["Host darwin", "定范围和授权"],
      ["headless 子进程", "研究、实现、检查、提交"],
      ["Host 独立验收", "自己看 diff、跑测试"],
      ["pnpm build", "构建新版本"],
      ["下一轮", "新 darwin 起子进程"],
    ];
    const bh = 0.7, arrow = 0.3, by = 3.3;
    flow.forEach(([head, body], i) => {
      const y = by + i * (bh + arrow), dark = i === 0 || i === 2;
      s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: CW, h: bh, fill: { color: dark ? C.ink : C.card }, line: { color: dark ? C.ink : C.line, width: 0.75 }, shadow: shadow() });
      s.addText(head, { x: M + 0.25, y, w: 2.6, h: bh, fontFace: HF, fontSize: 14, bold: true, color: dark ? C.cyanBright : C.ink, margin: 0, valign: "middle" });
      s.addText(body, { x: M + 2.9, y, w: CW - 3.1, h: bh, fontFace: HF, fontSize: 12, color: dark ? C.dim : C.muted, margin: 0, valign: "middle" });
      if (i < flow.length - 1) s.addText("↓", { x: M, y: y + bh - 0.03, w: 1.0, h: arrow + 0.06, fontFace: NF, fontSize: 16, color: C.cyan, align: "center", margin: 0, valign: "middle" });
    });
    const after = by + flow.length * bh + (flow.length - 1) * arrow + 0.3;
    s.addText("验收不过 → 在同一个子会话里继续修正；验收通过 → 这个版本接手下一轮。这一步本身不产生方向，但它让 darwin 有了执行方向的引擎，后面两步才成为可能。",
      { x: M, y: after, w: CW, h: 1.0, fontFace: HF, fontSize: 12, color: C.ink, margin: 0, valign: "top" });
    chip(s, "/developer 开始自我迭代，优化 TUI 交互，迭代至少 5 轮", M, after + 1.1, CW, { size: 11.5 });
    s.addText("第一次运行的结果：5 轮必做 + 1 轮验收发现的修复，六个 commit。验收发现的两个问题都不是子进程造成的，但只看子进程汇报会漏掉。",
      { x: M, y: after + 1.65, w: CW, h: 0.8, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, valign: "top" });
    const f = fit(1638, 856, M, after + 2.55, CW, H - 0.7 - (after + 2.55));
    s.addImage({ path: IMG("03-first-developer-batch.png"), ...f, shadow: shadow() });
  }

  // ==== 8. 第五步 找方向 =======================================================
  {
    const s = problemSlide("第五步", "每一批还得我说一句“这批做什么”", "让 darwin 自己研究、自己排优先级：/self-evolution-research + backlog + 评分门槛");
    await iconRow(s, FaClipboardCheck, M, 3.1, CW, "先看 backlog", "读 docs/research/backlog_index.md，有没做完的方向就先做，没有才开始研究。", { bodyH: 0.8 });
    await iconRow(s, FaSearch, M, 4.4, CW, "研究同类产品", "Claude Code、Codex、DeepSeek harness、PenguinHarness……对照 darwin 当前的代码和架构，每次最多提 5 个方向。", { bodyH: 0.9 });
    await iconRow(s, FaBalanceScale, M, 5.8, CW, "过门槛才进 backlog", "低于 6 分的不进；报告里记一笔“考虑过，拒绝”。进了 backlog 的方向逐个交给 developer 实现。", { bodyH: 0.9, circle: C.amber });
    card(s, M, 7.4, CW, 4.1);
    s.addText("五个维度，各打 1 到 5 分", { x: M + 0.3, y: 7.6, w: CW - 0.6, h: 0.4, fontFace: HF, fontSize: 13, color: C.muted, margin: 0 });
    const dims = ["重要性", "架构契合", "证据可信度", "实现难度", "风险"];
    dims.forEach((d, i) => chip(s, d, M + 0.3 + (i % 3) * 2.0, 8.1 + Math.floor(i / 3) * 0.5, 1.85, { bg: i < 3 ? C.cyan : "B45309", fg: C.white, size: 11.5, h: 0.4 }));
    s.addText("Score = 2×重要性 + 契合 + 证据 − 难度 − 风险", { x: M + 0.3, y: 9.25, w: CW - 0.6, h: 0.45, fontFace: "Consolas", fontSize: 13, bold: true, color: C.ink, margin: 0 });
    s.addText("MINIMUM_IMPLEMENTATION_SCORE = 6", { x: M + 0.3, y: 9.7, w: CW - 0.6, h: 0.4, fontFace: "Consolas", fontSize: 13, color: C.cyan, margin: 0 });
    s.addText("全部维度打平均分正好是 6：一个平平无奇的方向不值得一次迭代。分数不能事后改，改评分要有记录。", { x: M + 0.3, y: 10.3, w: CW - 0.6, h: 1.4, fontFace: HF, fontSize: 12, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 9. 第六步 骰子 =========================================================
  {
    const s = problemSlide("第六步", "让模型自己选方向，会陷进局部最优", "借随机梯度下降的思路：给选择加一点随机扰动，摇骰子决定这次往哪看");
    s.addText("模型自己选研究什么，每次都去看同类产品，提出来的总是别人已有的功能；让它自查，它只挑最熟的那块看。这和优化里的局部最优是一回事：每一步都朝当前看起来最好的方向走，就再也看不到别处。",
      { x: M, y: 3.1, w: CW, h: 1.5, fontFace: HF, fontSize: 12.5, color: C.ink, margin: 0, valign: "top" });
    s.addText("随机数必须由脚本产生，模型自己“随便选一个”时给出的并不随机。", { x: M, y: 4.6, w: CW, h: 0.4, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, valign: "top" });
    s.addChart(pres.charts.DOUGHNUT, [{
      name: "研究路径", labels: ["同类产品 peer", "TUI 自查", "开放式 open", "SDK 未用能力", "可观测性"], values: [50, 20, 15, 10, 5],
    }], {
      x: M - 0.1, y: 5.0, w: CW + 0.2, h: 3.0, holeSize: 55,
      chartColors: [C.ink, C.cyan, C.amber, "50808E", "6B7280"],
      showLegend: true, legendPos: "r", legendFontSize: 11, legendColor: C.ink,
      showPercent: true, showValue: false, dataLabelColor: C.white, dataLabelFontSize: 11,
      chartArea: { fill: { color: C.paper } },
    });
    card(s, M, 8.2, CW, 3.7);
    s.addText("摇出来的结果算数，skill 里定了几条规矩", { x: M + 0.3, y: 8.35, w: CW - 0.6, h: 0.4, fontFace: HF, fontSize: 14, bold: true, color: C.ink, margin: 0 });
    s.addText(bullets([
      "一次研究只摇一次，读任何资料之前摇。",
      "输出原样抄进报告，不能改写。",
      "不喜欢也不能重摇；没发现就如实写“没有发现”，不悄悄换路。",
      "人用 --path 指定时，报告里必须留着 path-source: override。",
      "骰子只决定证据从哪来，不改变评分、门槛和交付方式。",
    ]), { x: M + 0.3, y: 8.85, w: CW - 0.6, h: 1.9, fontFace: HF, fontSize: 12, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 5 });
    s.addShape(pres.shapes.RECTANGLE, { x: M + 0.3, y: 10.8, w: CW - 0.6, h: 0.9, fill: { color: C.ink }, line: { color: C.ink } });
    s.addText("“Rolling after reading is choosing.”", { x: M + 0.5, y: 10.82, w: CW - 1.0, h: 0.5, fontFace: NF, fontSize: 14, italic: true, color: C.cyanBright, margin: 0, valign: "middle" });
    s.addText("先读了再摇，就等于挑。", { x: M + 0.5, y: 11.28, w: CW - 1.0, h: 0.35, fontFace: HF, fontSize: 11.5, color: C.dim, margin: 0 });
  }

  // ==== 10. 骰子带来了什么 =====================================================
  {
    const s = lightSlide("跳出局部最优之后，看见了什么", "第六步 · 结果");
    s.addText("加了骰子之后，backlog 里开始出现看别家产品看不出来的方向。每条路径的方向都对照 docs/research/ 里记录的研究路径核过。",
      { x: M, y: 2.0, w: CW, h: 0.9, fontFace: HF, fontSize: 12.5, color: C.muted, margin: 0, valign: "top" });
    const cols = [
      ["tui", "TUI 自查", C.cyan, ["Esc 关闭弹层", "按词移动光标", "撤销删词", "终端提醒铃"]],
      ["observability", "可观测性", "50808E", ["失败回合写进记录", "每回合 token 花费", "可选的诊断日志"]],
      ["sdk", "SDK 未用能力", C.ink, ["官方 AgentSkills 替换手写核心", "SDK Graph 上的 workflow DAG", "结构化 headless 输出"]],
      ["open", "开放式", C.amber, ["/compact 不收缩时会一直循环", "SDK 默认模型重试：等待看不见、不能取消", "未知 config key 给出 did-you-mean"]],
    ];
    const gap = 0.25, cw = (CW - gap) / 2, ch = 3.0;
    cols.forEach(([id, name, color, items], i) => {
      const x = M + (i % 2) * (cw + gap), y = 3.1 + Math.floor(i / 2) * (ch + gap);
      card(s, x, y, cw, ch);
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw, h: 0.08, fill: { color }, line: { color } });
      chip(s, `path: ${id}`, x + 0.2, y + 0.3, cw - 0.4, { bg: color, fg: C.white, size: 11, h: 0.36 });
      s.addText(name, { x: x + 0.2, y: y + 0.8, w: cw - 0.4, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color: C.ink, margin: 0 });
      s.addText(bullets(items), { x: x + 0.2, y: y + 1.3, w: cw - 0.4, h: ch - 1.45, fontFace: HF, fontSize: 11.5, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 5 });
    });
    s.addText("到这里，方向来源完成了从人到 darwin 的交接：人只留下权重、门槛和什么算“值得做”这几条规则。",
      { x: M, y: 9.6, w: CW, h: 0.9, fontFace: HF, fontSize: 12.5, color: C.ink, margin: 0, italic: true, valign: "top" });
  }

  // ==== 11. 分隔：第二层 =======================================================
  dividerSlide("第二层", "方向定了之后，每一轮怎么做好？", "有了方向，还要让每一轮的执行越来越顺：弯路少一点、token 省一点、验收不被糊弄。这一层讲 darwin 怎么从自己的运行记录里找改进点，三周里踩过哪些坑、改了什么，以及是哪几件事让这个循环没有失控。");

  // ==== 12. 第七步 反思 ========================================================
  {
    const s = problemSlide("第七步", "过程里的弯路没人看见，同样的错会一直犯", "让 darwin 读自己的运行轨迹，打分、找原因，把改进点写回 backlog");
    s.addText("每个会话都有一份只追加的 trajectory.jsonl：用户输入、每次工具调用、模型返回、token、回合结束原因。它原本是给回放和导出用的，也正好是反思的材料。/self-reflection 起一个新的 headless darwin 读它，按模板写反思：",
      { x: M, y: 3.1, w: CW, h: 1.6, fontFace: HF, fontSize: 12.5, color: C.ink, margin: 0, valign: "top" });
    const items = [
      ["1", "给完成度打分", "完美 / 高 / 中 / 低，各有明确定义。十次里有四次打了“低”。"],
      ["2", "找 darwin 自己的问题", "哪些弯路能靠改提示词、工具描述、上下文管理、agent 编排避免。"],
      ["3", "同一套评分和门槛", "值得做的写进 backlog，交给 developer；重复的标记重复，不再入队。"],
    ];
    items.forEach(([n, head, body], i) => {
      const y = 4.55 + i * 0.95;
      s.addShape(pres.shapes.OVAL, { x: M, y, w: 0.46, h: 0.46, fill: { color: i === 2 ? C.amber : C.cyan }, line: { color: i === 2 ? C.amber : C.cyan } });
      s.addText(n, { x: M, y, w: 0.46, h: 0.46, fontFace: NF, fontSize: 15, bold: true, color: C.white, align: "center", valign: "middle", margin: 0 });
      s.addText(head, { x: M + 0.65, y: y - 0.02, w: CW - 0.65, h: 0.35, fontFace: HF, fontSize: 14, bold: true, color: C.ink, margin: 0 });
      s.addText(body, { x: M + 0.65, y: y + 0.34, w: CW - 0.65, h: 0.55, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, valign: "top" });
    });
    const f = fit(1119, 747, M, 7.5, CW, 3.9);
    s.addImage({ path: IMG("06-reflection-scores.png"), ...f, shadow: shadow() });
    s.addText("第一次反思找出两条：流中断后一个 11 分钟的回合卡死等人输 continue；bash status 多传一个字段白花一次调用。SRF-003 证据不足被拒，理由写明，不靠改分硬过门槛。",
      { x: M, y: f.y + f.h + 0.2, w: CW, h: 1.0, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 13. 闭环 ===============================================================
  {
    const s = darkSlide();
    s.addText("到这里，循环就完整了", { x: M, y: 0.9, w: CW, h: 0.7, fontFace: HF, fontSize: 28, bold: true, color: C.white, margin: 0 });
    const nodes = [
      ["研究 / 反思", "产生方向", FaCompass],
      ["评分过门槛", "进 backlog", FaBalanceScale],
      ["developer", "监督 headless 子进程", FaRobot],
      ["独立验收", "Host 自己看 diff、跑测试", FaClipboardCheck],
      ["pnpm build", "新版本接手下一轮", FaSyncAlt],
    ];
    const bh = 1.1, gap = 0.4, by = 2.1;
    nodes.forEach(([head, body, Icon], i) => {
      const y = by + i * (bh + gap);
      s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: CW, h: bh, fill: { color: "1B2633" }, line: { color: "2A3A4D", width: 0.75 } });
      const d = 0.56, col = i === 4 ? C.amber : C.cyanBright;
      s.addShape(pres.shapes.OVAL, { x: M + 0.3, y: y + (bh - d) / 2, w: d, h: d, fill: { color: col }, line: { color: col } });
      s.addText(head, { x: M + 1.1, y: y + 0.12, w: CW - 1.3, h: 0.45, fontFace: HF, fontSize: 16, bold: true, color: C.white, margin: 0 });
      s.addText(body, { x: M + 1.1, y: y + 0.58, w: CW - 1.3, h: 0.4, fontFace: HF, fontSize: 12, color: C.dim, margin: 0, valign: "top" });
      if (i < nodes.length - 1) s.addText("↓", { x: M + 0.3, y: y + bh - 0.02, w: d, h: gap + 0.04, fontFace: NF, fontSize: 18, color: C.cyanBright, align: "center", margin: 0, valign: "middle" });
    });
    for (let i = 0; i < nodes.length; i++) {
      const d = 0.56, y = by + i * (bh + gap) + (bh - d) / 2;
      s.addImage({ data: await icon(nodes[i][2], C.ink), x: M + 0.3 + d * 0.25, y: y + d * 0.25, w: d * 0.5, h: d * 0.5 });
    }
    const end = by + nodes.length * bh + (nodes.length - 1) * gap;
    s.addShape(pres.shapes.LINE, { x: W - M - 0.15, y: by + bh / 2, w: 0, h: end - bh - by, line: { color: C.amber, width: 1.5, dashType: "dash", beginArrowType: "triangle" } });
    s.addText("↑ 新版本回到起点，继续研究下一个方向", { x: M, y: end + 0.3, w: CW, h: 0.4, fontFace: HF, fontSize: 12.5, color: C.amber, margin: 0 });
    s.addText("人保留的：给方向、产品取舍、安全边界、授权 push。其余的，darwin 自己跑。", { x: M, y: end + 1.0, w: CW, h: 0.9, fontFace: HF, fontSize: 14, color: C.white, margin: 0, valign: "top" });
  }

  // ==== 14. 坑：token ==========================================================
  {
    const s = lightSlide("最先碰到的问题：token 烧得太快", "第二层 · 踩坑 1");
    const stats = [["706", "次模型调用"], [["29.6", " 万"], "output token"], [["3.98", " 亿"], "cache read token"], ["1.11", "每次调用平均只发的工具数"]];
    stats.forEach(([n, l], i) => stat(s, M + (i % 2) * 3.3, 2.0 + Math.floor(i / 2) * 1.45, 3.1, n, l, { size: 34, color: i === 3 ? C.amber : C.cyan }));
    s.addText("8 月 17 日统计的一个批次。同一个子会话从 planning 续到第四轮修正，每次调用读取的缓存上下文从 23 万涨到 79 万；最后一轮只产出 3111 个 output token，却读了 1740 万缓存。Planning 阶段单独占 37% 的 output。",
      { x: M, y: 5.0, w: CW, h: 1.5, fontFace: HF, fontSize: 12, color: C.ink, margin: 0, valign: "top" });
    s.addText([
      { text: "改法 · 流程  ", options: { bold: true, color: C.cyan } },
      { text: "不再拆 planning child 和 implementation child 各审一次；一个完整 worker 自己走完研究、实现、检查、提交，Host 只在最后独立验收。", options: { breakLine: true } },
      { text: "改法 · 提示词  ", options: { bold: true, color: C.cyan } },
      { text: "互不依赖的读取、搜索、检查在同一条消息里批量发出。现在一个方向典型花费 1–16 美元、12–170 次调用。" },
    ], { x: M, y: 6.5, w: CW, h: 1.9, fontFace: HF, fontSize: 12, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 6 });
    const f = fit(683, 341, M, 8.5, CW, 3.3);
    s.addImage({ path: IMG("05-context-growth.png"), ...f, shadow: shadow() });
    s.addText("后期的修正本身不贵，贵的是它们一直带着前面所有的历史。", { x: M, y: f.y + f.h + 0.2, w: CW, h: 0.4, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, italic: true });
  }

  // ==== 15. 坑：其余四个 =======================================================
  {
    const s = lightSlide("另外四个教训", "第二层 · 踩坑 2");
    const items = [
      [FaHourglassHalf, C.cyan, "监督子进程比子进程干活还贵", "一个批次 390 次工具调用，322 次是 Host 在轮询两个子进程的 status 和 output，每醒一次都是一轮带全上下文的模型调用。先改成阻塞式 wait，最长能等 30 分钟；最后反过来：后台任务 start 后立即返回，Host 可以结束回合，任务结束时一条 <task-notification> 进入提示队列，会话空闲时唤醒模型。"],
      [FaBalanceScale, C.amber, "反思要敢打低分", "十次里四次“低”：结论形成了没发出去、轨迹定位不匹配、最后一个回合没闭合。未闭合那条变成了 SRF-012：反思只对已闭合的回合打分。"],
      [FaRedoAlt, C.ink, "同一个错，不换假设就别再试", "一次服务端校验失败，darwin 换着参数连试了六种变体，12 分钟、1.1 万 output token，直到被人取消。反思提出 SRF-016 重试守卫：同一失败签名第二次要说出有证据的新假设，第三次停下汇报，第四次直接拒绝执行。"],
      [FaLayerGroup, "50808E", "流程框架也会变成拖累", "Trellis 前三周有用；切到 Claude Fable 5.1 后，模型自己会读 AGENTS.md、跑 spike 再改代码，Trellis 成了第二本规则手册。9 月 4 日整层移除，只留下那句原则。"],
    ];
    const hs = [2.9, 2.2, 2.7, 2.3];
    let y = 2.0;
    for (let i = 0; i < items.length; i++) {
      await iconCard(s, items[i][0], items[i][1], items[i][2], items[i][3], y, hs[i]);
      y += hs[i] + 0.2;
    }
  }

  // ==== 16. 为什么能一直跑下去 =================================================
  {
    const s = lightSlide("为什么能一直跑下去", "第二层 · 机制");
    const rows = [
      [FaFileAlt, C.cyan, "该记的东西都写进文件", "每个会话从零开始，上一代只能靠文件传给下一代。AGENTS.md 预载进系统提示，一张表列着哪些约束不能破坏、代码在哪、用哪个脚本验证（32 KB 上限）。每批必须往 iteration-log 追加一条。“Specs injected, not remembered.”"],
      [FaVial, C.cyan, "测试不用 mock", "spike/ 下一百三十来个脚本：真实 pty 驱动 TUI、真的 git 仓库、直接调模型。pnpm test 跑其中 100 个免模型套件。子进程说“测试过了”，Host 用同一条命令得到同一个答案。"],
      [FaUserShield, C.cyan, "提前说好哪些事归人管", "产品取舍、安全边界、授权是人的。工作树不干净、起点无法验证、验收反复失败、前提被证伪——整批停下并记录原因。darwin 在没人在场时知道该停在哪。"],
      [FaSyncAlt, C.amber, "每一轮都用刚改出来的 darwin 做下一轮", "验收通过、提交后立刻 build，下一个方向就由新 darwin 来做。改动一提交就进入实际工作：改得好下一轮顺一些，改坏了下一轮就会撞上它。每次改进的结果，反过来决定下一次改进的质量。"],
    ];
    const hs = [2.7, 2.3, 2.3, 2.6];
    let y = 2.0;
    for (let i = 0; i < rows.length; i++) {
      await iconCard(s, rows[i][0], rows[i][1], rows[i][2], rows[i][3], y, hs[i], { dark: i === 3 });
      y += hs[i] + 0.2;
    }
  }

  // ==== 17. 现在的样子 =========================================================
  {
    const s = lightSlide("三个星期之后", "现在的样子 · 2026-08-13 → 09-06");
    const stats = [
      ["672", "commit"], ["99", "受监督的迭代批次"], ["95", "backlog 方向 · 93 done"],
      ["~37,000", "行 TypeScript（src/）"], ["~130", "spike 脚本 · 100 个进 pnpm test"], ["20 / 10", "研究报告 / 反思报告"],
    ];
    const gap = 0.25, cw = (CW - gap) / 2, ch = 2.0;
    stats.forEach(([n, l], i) => {
      const x = M + (i % 2) * (cw + gap), y = 2.0 + Math.floor(i / 2) * (ch + gap);
      card(s, x, y, cw, ch);
      s.addText(n, { x: x + 0.25, y: y + 0.25, w: cw - 0.5, h: 0.9, fontFace: NF, fontSize: 40, bold: true, color: i === 2 ? C.amber : C.cyan, margin: 0 });
      s.addText(l, { x: x + 0.25, y: y + 1.25, w: cw - 0.5, h: 0.6, fontFace: HF, fontSize: 13, color: C.muted, margin: 0, valign: "top" });
    });
    s.addText("基线之后的实现代码都是 darwin 写的。功能：流式 Markdown 和文件 diff、四种权限模式、可恢复会话和轨迹回放、subagent 和 workflow DAG、hook 和 MCP、headless 结构化输出、多模型切换、agent 管理的项目记忆，以及三个自进化 skill。",
      { x: M, y: 9.2, w: CW, h: 2.4, fontFace: HF, fontSize: 14, color: C.ink, margin: 0, valign: "top", lineSpacingMultiple: 1.2 });
  }

  // ==== 18. Strands SDK 用到了什么、补了什么 ===================================
  {
    const s = lightSlide("Strands SDK：用到了什么，补了什么", "SDK 压测结果", { size: 24 });
    s.addText("runtime.ts 是唯一构造 Agent 的地方，只做装配；agent 循环一次都没有 fork 过。不够的地方集中在自带工具和插件的细节，用一个 pnpm patch 补齐。",
      { x: M, y: 2.0, w: CW, h: 0.9, fontFace: HF, fontSize: 12, color: C.muted, margin: 0, valign: "top" });
    card(s, M, 3.0, CW, 4.85);
    s.addShape(pres.shapes.RECTANGLE, { x: M, y: 3.0, w: CW, h: 0.08, fill: { color: C.cyan }, line: { color: C.cyan } });
    s.addText("原生用上的", { x: M + 0.25, y: 3.2, w: CW - 0.5, h: 0.35, fontFace: HF, fontSize: 14, bold: true, color: C.ink, margin: 0 });
    const used = [
      ["模型", "BedrockModel / AnthropicModel / OpenAIModel（Mantle）；Model.updateConfig() 会话中途换 effort 和模型；CachePointBlock"],
      ["工具", "bash、fileEditor、httpRequest 直接注册；McpClient（stdio + Streamable HTTP）"],
      ["上下文", "SummarizingConversationManager 做 /compact；ContextOffloader 默认开；SessionManager + LocalFileStorage；checkpoint 做 /rewind"],
      ["控制", "InterventionHandler 做权限门；模型、工具、调用三类 hook；InvokeModelStage 中间件 + ExponentialBackoff 做限流重试"],
      ["多 agent", "默认并发执行器跑 subagent；Graph 跑 workflow DAG；backgroundTasks 做后台委派；官方 AgentSkills"],
    ];
    used.forEach(([h, b], i) => {
      const y = 3.65 + i * 0.82;
      s.addText(h, { x: M + 0.25, y, w: 1.05, h: 0.75, fontFace: HF, fontSize: 11.5, bold: true, color: C.cyan, margin: 0, valign: "top" });
      s.addText(b, { x: M + 1.35, y, w: CW - 1.6, h: 0.8, fontFace: HF, fontSize: 10.5, color: C.ink, margin: 0, valign: "top" });
    });
    card(s, M, 8.05, CW, 4.1);
    s.addShape(pres.shapes.RECTANGLE, { x: M, y: 8.05, w: CW, h: 0.08, fill: { color: C.amber }, line: { color: C.amber } });
    s.addText("patch 补的", { x: M + 0.25, y: 8.25, w: 2.5, h: 0.35, fontFace: HF, fontSize: 14, bold: true, color: C.ink, margin: 0 });
    s.addText("1 个 patch · 15 个文件 · 约 950 行", { x: M + 0.25, y: 8.27, w: CW - 0.5, h: 0.32, fontFace: NF, fontSize: 10.5, color: C.muted, margin: 0, align: "right" });
    const patched = [
      ["bash ~400 行", "stdin 接 /dev/null，交互提示直接 EOF；按进程组杀；后台任务增量 wait，终端聚焦等待最长 30 分钟"],
      ["ContextOffloader ~300 行", "excludeTools 让 load_skill 永不卸载；卸载的 JSON 可按行搜索切片；恢复旧会话时修复超大历史结果"],
      ["fileEditor ~180 行", "str_replace 未命中返回有限上下文，零写入；新增 replace_all"],
      ["小补丁", "包根导出 DEFAULT_SUMMARIZATION_PROMPT；摘要过滤 thinking 推理块；OpenAI 适配器补 cache_write_tokens、溢出识别"],
    ];
    patched.forEach(([h, b], i) => {
      const y = 8.7 + i * 0.82;
      s.addText(h, { x: M + 0.25, y, w: CW - 0.5, h: 0.28, fontFace: HF, fontSize: 11.5, bold: true, color: C.amber, margin: 0 });
      s.addText(b, { x: M + 0.25, y: y + 0.28, w: CW - 0.5, h: 0.52, fontFace: HF, fontSize: 10.5, color: C.ink, margin: 0, valign: "top" });
    });
    s.addText("补丁都是 darwin 在自我迭代中撞到问题后自己写的。补的是边角，agent 循环、会话、压缩、编排这些主干没有动过。",
      { x: M, y: 12.25, w: CW, h: 0.45, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, italic: true, valign: "top" });
  }

  // ==== 19. DeepSWE 对照 =======================================================
  {
    const s = lightSlide("跟 Claude Code 跑同一批题", "DeepSWE 前 20 题 · 2026-09-05 / 09-08");
    s.addText("同一个模型（Bedrock 上的 Claude Opus 5）、同一批任务，只换 agent：darwin 是 commit 2240a3c，Claude Code 是 2.1.261。9 月 8 日两个 harness 各自把 effort 从 high 降到 medium 再跑一轮，其余不变。",
      { x: M, y: 2.0, w: CW, h: 1.0, fontFace: HF, fontSize: 12, color: C.muted, margin: 0, valign: "top" });
    const half = (CW - 0.3) / 2;
    [["darwin", C.cyan], ["Claude Code", C.ink]].forEach(([name, color], i) => {
      const x = M + i * (half + 0.3);
      card(s, x, 3.1, half, 1.5);
      s.addShape(pres.shapes.RECTANGLE, { x, y: 3.1, w: 0.09, h: 1.5, fill: { color }, line: { color } });
      s.addText(name, { x: x + 0.3, y: 3.2, w: half - 0.5, h: 0.35, fontFace: HF, fontSize: 13, color: C.muted, margin: 0 });
      s.addText([
        { text: "12/20", options: { fontFace: NF, fontSize: 28, bold: true, color } },
        { text: " high", options: { fontFace: HF, fontSize: 10, color: C.muted, breakLine: true } },
        { text: "13/20", options: { fontFace: NF, fontSize: 28, bold: true, color } },
        { text: " medium", options: { fontFace: HF, fontSize: 10, color: C.muted } },
      ], { x: x + 0.3, y: 3.5, w: half - 0.5, h: 1.05, margin: 0, valign: "top" });
    });
    const L = (t) => ({ text: t, options: { align: "left", color: C.muted } });
    const Hd = (t) => ({ text: t, options: { bold: true, align: "right" } });
    s.addTable([
      [{ text: "", options: { fill: { color: C.paper } } }, Hd("darwin high"), Hd("darwin medium"), Hd("CC high"), Hd("CC medium")],
      [L("成本"), "$138.92", "$83.97", "$149.29", "$94.42"],
      [L("成本变化"), "—", "−40%", "—", "−37%"],
      [L("input token"), "168.5 M", "99 M", "176.5 M", "113 M"],
      [L("output token"), "1477 K", "903 K", "1471 K", "966 K"],
      [L("耗时中位"), "18 min", "11 min", "18 min", "12 min"],
    ], {
      x: M, y: 4.85, w: CW, colW: [1.5, 1.25, 1.25, 1.25, 1.25], fontFace: HF, fontSize: 11, color: C.ink,
      border: { type: "solid", pt: 0.5, color: C.line }, fill: { color: C.card }, margin: 0.06, align: "right", rowH: 0.42,
    });
    s.addText([
      { text: "high：18 题结果一致。", options: { bold: true } },
      { text: "分歧两题方向相反：darwin 过了 abs-stepped-slices，Claude Code 过了 bandit-structured-nosec-directives。两边都没过的 7 题是当前模型的能力边界。缓存命中两边都是 98%。", options: { breakLine: true } },
      { text: " ", options: { breakLine: true, fontSize: 6 } },
      { text: "medium：省钱站得住，涨分不站。", options: { bold: true } },
      { text: "成本各降 40% / 37%，在两个互不相关的 harness 上复现。+1 分是噪声：Claude Code 在两个 effort 档间翻转 7 题、darwin 翻转 3 题，同配置两跑的基线就翻 6 题。medium 下换 harness 仍是 13 vs 13。high 比 medium 多花约 1.6 倍，没买到可测量的分数。", options: { breakLine: true } },
      { text: " ", options: { breakLine: true, fontSize: 6 } },
      { text: "局限：", options: { bold: true } },
      { text: "pass@1 单次采样；字典序前 20 题，不是随机抽样。能说的只是：在这个样本上，两个 effort 档下 harness 的影响都没有超出单次采样的噪声。" },
    ], { x: M, y: 7.6, w: CW, h: 4.9, fontFace: HF, fontSize: 12, color: C.ink, margin: 0, valign: "top", lineSpacingMultiple: 1.15 });
  }

  // ==== 20. RSI / Auto Research 是什么 =========================================
  {
    const s = lightSlide("两个容易混在一起的词，和一套对照坐标", "RSI · Auto Research", { size: 24 });
    const cols = [
      ["RSI 递归自我改进", "Good 1965 · Yudkowsky 2008", C.ink, [
        "系统改进自己，改进后的系统做出更好的改进，如此递归。",
        "今天的形态：模型改自己的权重，或改训练流水线和部署系统，得到更强的下一代。",
        "Weng 2026-07：近期可行的路从 harness 开始，不从权重开始。",
      ]],
      ["autoresearch", "Karpathy · 2026-03", C.amber, [
        "agent 只能改一个训练脚本 train.py；每次训练固定 5 分钟，指标 val_bpb。",
        "好了保留、差了回滚，一晚上约一百次实验。人不碰 Python，只改 program.md。",
        "Weng 拿它当“工作流自动化”模式最干净的例子。",
      ]],
      ["Darwin Gödel Machine", "Sakana AI · UBC · 2025-05", C.cyan, [
        "把“证明”换成“用 benchmark 实证”：档案库里采样一个 agent，让模型改出新版本，跑 SWE-bench，好的进库。",
        "SWE-bench 20.0% → 50.0%，Polyglot 14.2% → 30.7%。",
        "“达尔文”指档案库 + 选择：有种群、有分支。和本项目撞名，机制不同。",
      ]],
    ];
    const ch = 2.55, gap = 0.2;
    cols.forEach(([name, meta, color, items], i) => {
      const y = 2.0 + i * (ch + gap);
      card(s, M, y, CW, ch);
      s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: CW, h: 0.08, fill: { color }, line: { color } });
      s.addText(name, { x: M + 0.25, y: y + 0.22, w: 3.6, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color: C.ink, margin: 0 });
      s.addText(meta, { x: M + 3.7, y: y + 0.27, w: CW - 3.95, h: 0.32, fontFace: NF, fontSize: 10.5, color: C.muted, margin: 0, align: "right" });
      s.addText(bullets(items), { x: M + 0.25, y: y + 0.75, w: CW - 0.5, h: ch - 0.9, fontFace: HF, fontSize: 12.5, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 6, lineSpacingMultiple: 1.1 });
    });
    s.addText("对照坐标来自 Lilian Weng《Harness Engineering for Self-Improvement》（2026-07）。三个 harness 设计模式：工作流自动化、文件系统作为持久记忆、子 agent 和后台任务。优化对象的渐进线：提示词 → 结构化上下文 → 工作流 → harness 代码 → 优化器代码。自改进回路的参照：Self-Harness 的 propose–evaluate–accept，AHE 的七个可编辑组件和三层可观测性。下一页按这套坐标放 darwin。",
      { x: M, y: 10.35, w: CW, h: 2.2, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, valign: "top", lineSpacingMultiple: 1.1 });
  }

  // ==== 21. darwin 落在哪里 ====================================================
  {
    const s = lightSlide("darwin 落在哪里：有界自我改进", "RSI · Auto Research · 对照 · harness 层");
    // The landscape 5-column table, transposed: one card per row, four cells each.
    const rows = [
      ["改的对象", "一个训练脚本", "harness 的七个组件", "agent 自己的代码", "自己的代码库：七个组件都动过，含优化器 skill"],
      ["弱点从哪来", "固定目标下提假设", "多条轨迹聚类失败模式", "benchmark 失败日志", "骰子 + 同类研究 + 单会话轨迹反思"],
      ["评价", "一个标量 val_bpb", "留内 + 留外回归", "benchmark 分数", "typecheck + 130 真实测试 + Host 看 diff"],
      ["验证器位置", "回路外", "回路外，只读", "沙箱 + 监督", "回路内，同一仓库；人工门控兜底"],
      ["搜索结构", "单谱系爬山", "单 harness 逐轮合并", "档案库、多父代", "单谱系 git main，种群 1"],
      ["回路闭合", "一晚上全闭合", "全自动", "闭合", "人在边界：产品取舍、授权、停止"],
    ];
    const heads = ["autoresearch", "Self-Harness / AHE", "DGM", "darwin"];
    const rh = 1.22, rgap = 0.1, cellW = (CW - 0.5 - 0.2) / 2;
    rows.forEach(([label, ...cells], i) => {
      const y = 2.0 + i * (rh + rgap);
      card(s, M, y, CW, rh);
      s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: 0.07, h: rh, fill: { color: C.cyan }, line: { color: C.cyan } });
      s.addText(label, { x: M + 0.25, y: y + 0.08, w: CW - 0.5, h: 0.3, fontFace: HF, fontSize: 11.5, bold: true, color: C.muted, margin: 0 });
      cells.forEach((cell, k) => {
        const cx = M + 0.25 + (k % 2) * (cellW + 0.2), cy = y + 0.4 + Math.floor(k / 2) * 0.4;
        const isDarwin = k === 3;
        s.addText([
          { text: heads[k] + "  ", options: { fontFace: NF, fontSize: 9.5, color: isDarwin ? C.cyan : C.muted, bold: isDarwin } },
          { text: cell, options: { fontFace: HF, fontSize: 10.5, color: C.ink, bold: isDarwin } },
        ], { x: cx, y: cy, w: cellW, h: 0.4, margin: 0, valign: "top" });
      });
    });
    const diffs = [
      ["模型固定", "RSI 是智能改进智能；darwin 改的是模型外面那层 harness。DeepSWE 对照：换 harness 分数没超出噪声，上限就是模型的上限。"],
      ["验证器在回路内", "AHE 把 verifier 和模型配置设成只读；darwin 的测试和权限门在同一仓库里，靠 Host 重跑、人审 diff 兜住，没有从结构上解决。"],
      ["没有种群", "DGM 有档案库和多父代；darwin 每个验收通过的 commit 是唯一父代。多样性靠骰子补，负面结果靠低分和被拒方向留下。"],
    ];
    const dy0 = 2.0 + rows.length * (rh + rgap) + 0.15, dh = 0.82;
    diffs.forEach(([h, b], i) => {
      const y = dy0 + i * (dh + 0.08);
      s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: 0.07, h: dh, fill: { color: i === 2 ? C.amber : C.cyan }, line: { color: i === 2 ? C.amber : C.cyan } });
      s.addText(h, { x: M + 0.25, y, w: CW - 0.25, h: 0.28, fontFace: HF, fontSize: 12, bold: true, color: C.ink, margin: 0 });
      s.addText(b, { x: M + 0.25, y: y + 0.28, w: CW - 0.25, h: dh - 0.28, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, valign: "top" });
    });
  }

  // ==== 22. 下一步：Harbor 作为 fitness function ===============================
  {
    const s = lightSlide("下一步：给好坏一个数字", "未来方向 · 提案草稿");
    const cols = [
      ["现在缺什么", C.amber, [
        "backlog 的 Score 五个维度都是 1–5 的主观评级。",
        "验收标准是“没有回归”，不是“darwin 变强了”。",
        "反思只看自己的一次会话：评价者和被评价者是同一个系统。",
        "名字叫 darwin，却没有一个外部的、可复现的、量化的 fitness function。",
      ]],
      ["用 Harbor 补上", C.cyan, [
        "每个候选 commit 在固定模型、任务子集、参数下跑 Harbor，和 baseline 比 pass@1、成本、时长。",
        "快速层：5–8 题 smoke，触及 agent 核心的 commit 验收时跑。",
        "慢速层：Terminal-Bench 2.0 全部 89 题 + DeepSWE 全部 113 题，每次 release 刷新基线。",
        "研究 skill 加一条 bench 路径：从 reward = 0 的 trial 里挖 darwin 侧的缺陷。",
      ]],
      ["正好对上前一页的三个缺口", C.ink, [
        "留外集：一个 hold-out 子集永远不进 smoke。",
        "验证器在回路外：verifier 跑在独立容器里；任务内容和解法不进 skills、memory、AGENTS.md。",
        "标量信号：对 baseline 的差值，Evidence confidence 第一次有数字撑着。",
        "底线：只有同一模型、同一参数、不同 darwin commit 的差值才算 darwin 的信号。",
      ]],
    ];
    const ch = 2.6, gap = 0.2;
    cols.forEach(([name, color, items], i) => {
      const y = 2.0 + i * (ch + gap);
      card(s, M, y, CW, ch);
      s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: CW, h: 0.08, fill: { color }, line: { color } });
      s.addText(name, { x: M + 0.25, y: y + 0.22, w: CW - 0.5, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color: C.ink, margin: 0 });
      s.addText(bullets(items), { x: M + 0.25, y: y + 0.7, w: CW - 0.5, h: ch - 0.85, fontFace: HF, fontSize: 11.5, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 4 });
    });
    const stages = [["0", "submodule + 文档", true], ["1", "冒烟 1 + 1 题", false], ["2", "基线 n = 3", false], ["3", "接入 developer", false], ["4", "全量 → 基线", false], ["5", "轨迹反哺 fork", false]];
    const sw = (CW - 0.12 * 2) / 3, sy = 10.5, sh = 0.45;
    stages.forEach(([n, t, done], i) => {
      const x = M + (i % 3) * (sw + 0.12), y = sy + Math.floor(i / 3) * (sh + 0.1);
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: sw, h: sh, fill: { color: done ? C.ink : C.card }, line: { color: done ? C.ink : C.line, width: 0.75 } });
      s.addText([{ text: n + "  ", options: { fontFace: NF, bold: true, color: done ? C.cyanBright : C.cyan } }, { text: t, options: { color: done ? C.white : C.ink } }],
        { x: x + 0.12, y, w: sw - 0.24, h: sh, fontFace: HF, fontSize: 10.5, margin: 0, valign: "middle" });
    });
    s.addText("已到阶段 0：external/harbor submodule，darwin adapter 在 fork 里，方案在 docs/architecture/harbor-benchmark-rsi.md。风险：全量 DeepSWE 一次可能上百美元、数小时；单题 pass 在 run 间波动，小子集只看趋势和严重回归；Goodhart 靠 hold-out 和“任务内容不进记忆”来防。",
      { x: M, y: 11.65, w: CW, h: 1.0, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 23. 结语 ===============================================================
  {
    const s = darkSlide();
    s.addText("能不能叫“自进化”？", { x: M, y: 1.0, w: CW, h: 0.7, fontFace: HF, fontSize: 30, bold: true, color: C.white, margin: 0 });
    s.addText("我倾向于保守一点。", { x: M, y: 1.75, w: CW, h: 0.45, fontFace: HF, fontSize: 15, color: C.dim, margin: 0 });
    const cols = [
      ["它能做到的", C.cyanBright, ["在明确的边界内自己找方向", "自己实现、自己验收、自己记录", "把学到的东西传给下一代", "用新版本立刻验证上一版的改动"]],
      ["仍然是人的判断", C.amber, ["方向的质量", "边界的位置", "产品取舍与安全授权"]],
    ];
    cols.forEach(([head, color, items], i) => {
      const y = 2.6 + i * 2.75;
      s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: CW, h: 2.5, fill: { color: "1B2633" }, line: { color: "2A3A4D", width: 0.75 } });
      s.addShape(pres.shapes.RECTANGLE, { x: M, y, w: 0.09, h: 2.5, fill: { color }, line: { color } });
      s.addText(head, { x: M + 0.35, y: y + 0.2, w: CW - 0.6, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color, margin: 0 });
      s.addText(bullets(items), { x: M + 0.35, y: y + 0.7, w: CW - 0.6, h: 1.7, fontFace: HF, fontSize: 12.5, color: C.white, margin: 0, valign: "top", paraSpaceAfter: 6 });
    });
    s.addText("这个实验至少说明：在三万多行的仓库、三个星期的尺度上，这些判断之外的活是可以交出去的。三周多体验下来，大概有 10%–20% 的方向还是要我明确指引；等它自己探索，也许也能走到我想要的地方，但要花更长的时间和更多的成本。", { x: M, y: 8.3, w: CW, h: 1.5, fontFace: HF, fontSize: 13.5, color: C.white, margin: 0, valign: "top", lineSpacingMultiple: 1.15 });
    s.addText("想自己接着迭代", { x: M, y: 9.9, w: CW, h: 0.35, fontFace: HF, fontSize: 12, color: C.dim, margin: 0 });
    chip(s, "fork 这个 repo，然后  /self-evolution-research", M, 10.28, CW, { bg: "1B2633", size: 12.5, h: 0.48 });
    s.addText("想直接用", { x: M, y: 10.9, w: CW, h: 0.35, fontFace: HF, fontSize: 12, color: C.dim, margin: 0 });
    chip(s, "npm install -g strands-darwin", M, 11.28, CW, { bg: "1B2633", size: 12.5, h: 0.48 });
    s.addImage({ data: await icon(FaGithub, C.dim), x: M, y: 12.0, w: 0.3, h: 0.3 });
    s.addText("github.com/xiehust/strands-darwin  ·  代码、迭代日志、研究报告、反思报告", { x: M + 0.42, y: 11.97, w: CW - 0.42, h: 0.36, fontFace: NF, fontSize: 11, color: C.dim, margin: 0, valign: "middle" });
    footer(s, true);
  }

  // ---- notes + write ---------------------------------------------------------
  if (CAPTIONS.length !== pres.slides.length) {
    throw new Error(`captions (${CAPTIONS.length}) do not match slides (${pres.slides.length})`);
  }
  pres.slides.forEach((slide, i) => slide.addNotes(CAPTIONS[i]));
  await pres.writeFile({ fileName: OUT });
  console.log("wrote", OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
