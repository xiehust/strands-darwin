// Builds docs/blog/self-evolution-development.zh-CN.pptx from the blog content.
// Run: NODE_PATH=$(npm root -g) node docs/blog/slides/build-deck.cjs
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

const IMG = (name) => path.join(__dirname, "..", "images", name);

// `--lang=en` builds the English deck from the same layout code: every string that reaches
// a slide (text runs, table cells, chart labels, notes) is looked up in strings.en.json;
// strings missing from the dictionary are reported at the end so nothing ships untranslated.
const LANG = process.argv.includes("--lang=en") ? "en" : "zh";
const OUT = path.join(__dirname, "..", LANG === "en" ? "self-evolution-development.en.pptx" : "self-evolution-development.zh-CN.pptx");
const DICT = LANG === "en" ? require("./strings.en.json") : null;
const MISSING = new Set();
const HAS_CJK = /[\u3400-\u9fff\uff00-\uffef\u3000-\u303f]/;
const T = (t) => {
  if (!DICT || typeof t !== "string") return t;
  if (t in DICT) return DICT[t];
  if (HAS_CJK.test(t)) MISSING.add(t);
  return t;
};
// Every slide's text-bearing methods route their strings through T(). English runs about
// 15% longer than the Chinese it replaces, so body type (below 20 pt) is scaled down a little.
const scale = (o) => (DICT && o && typeof o.fontSize === "number" && o.fontSize < 20 ? { ...o, fontSize: Math.round(o.fontSize * 0.92 * 2) / 2 } : o);
function translateSlide(s) {
  const addText = s.addText.bind(s);
  s.addText = (text, opts) => addText(Array.isArray(text) ? text.map((r) => ({ ...r, text: T(r.text), options: scale(r.options) })) : T(text), scale(opts));
  const addTable = s.addTable.bind(s);
  s.addTable = (rows, opts) => addTable(rows.map((row) => row.map((c) => (typeof c === "string" ? T(c) : c && typeof c.text === "string" ? { ...c, text: T(c.text) } : c))), scale(opts));
  const addChart = s.addChart.bind(s);
  s.addChart = (type, data, opts) => addChart(type, data.map((d) => ({ ...d, name: T(d.name), labels: d.labels && d.labels.map(T) })), opts);
  return s;
}

// Palette: darwin's terminal (near-black + cyan + the yolo amber) on a warm paper.
const C = {
  ink: "0F1720",       // dark background / body text on light
  paper: "F7F5F0",     // light background
  card: "FFFFFF",
  cyan: "1493A8",      // accent on light
  cyanBright: "33C3E0",// accent on dark (the DARWIN logo colour)
  amber: "D97706",     // secondary accent (the yolo mode line)
  muted: "6B7280",
  line: "D9D4C7",
  white: "FFFFFF",
  dim: "9AA4B2",       // muted on dark
};
const HF = "Microsoft YaHei"; // Chinese heading/body
const NF = "Georgia";         // numbers / English display

const W = 10, H = 5.625, M = 0.5;

function svg(Icon, color, size = 256) {
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Icon, { color, size: String(size) }));
}
async function icon(Icon, color) {
  const png = await sharp(Buffer.from(svg(Icon, "#" + color))).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}
// Fit an image into a box, preserving aspect ratio; returns {x,y,w,h} centred in the box.
function fit(px, py, boxX, boxY, boxW, boxH) {
  const r = px / py;
  let w = boxW, h = w / r;
  if (h > boxH) { h = boxH; w = h * r; }
  return { x: boxX + (boxW - w) / 2, y: boxY + (boxH - h) / 2, w, h };
}
const shadow = () => ({ type: "outer", color: "000000", blur: 6, offset: 2, angle: 135, opacity: 0.10 });

async function main() {
  const pres = new pptxgen();
  const addSlide = pres.addSlide.bind(pres);
  pres.addSlide = (...a) => translateSlide(addSlide(...a));
  pres.layout = "LAYOUT_16x9";
  pres.title = T("Self Evolution Development —— 自进化迭代开发的实验");
  pres.author = "darwin";

  // ---- shared pieces --------------------------------------------------------
  function lightSlide(title, kicker) {
    const s = pres.addSlide();
    s.background = { color: C.paper };
    // motif: one cyan bar on the left edge
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.12, h: H, fill: { color: C.cyan }, line: { color: C.cyan } });
    if (kicker) s.addText(kicker, { x: M, y: 0.32, w: 6, h: 0.3, fontFace: NF, fontSize: 11, color: C.cyan, charSpacing: 2, margin: 0 });
    s.addText(title, { x: M, y: 0.58, w: 9, h: 0.7, fontFace: HF, fontSize: 30, bold: true, color: C.ink, margin: 0 });
    // footer
    s.addText("Self Evolution Development · darwin", { x: M, y: H - 0.38, w: 5, h: 0.25, fontFace: NF, fontSize: 9, color: C.muted, margin: 0 });
    return s;
  }
  function darkSlide() {
    const s = pres.addSlide();
    s.background = { color: C.ink };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.12, h: H, fill: { color: C.cyanBright }, line: { color: C.cyanBright } });
    return s;
  }
  // A step slide: kicker = the step, title = the problem this step had to solve,
  // one cyan line under it = the answer. Content starts at y ≈ 1.75.
  function problemSlide(step, problem, solution) {
    const s = pres.addSlide();
    s.background = { color: C.paper };
    s.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.12, h: H, fill: { color: C.cyan }, line: { color: C.cyan } });
    s.addText(step, { x: M, y: 0.32, w: 6, h: 0.3, fontFace: NF, fontSize: 11, color: C.cyan, charSpacing: 2, margin: 0 });
    s.addText("问题", { x: M, y: 0.62, w: 0.7, h: 0.3, fontFace: HF, fontSize: 11, color: C.muted, margin: 0, valign: "middle" });
    s.addText(problem, { x: M + 0.7, y: 0.55, w: 8.3, h: 0.5, fontFace: HF, fontSize: 24, bold: true, color: C.ink, margin: 0, valign: "middle" });
    s.addText("解法", { x: M, y: 1.12, w: 0.7, h: 0.3, fontFace: HF, fontSize: 11, color: C.muted, margin: 0, valign: "middle" });
    s.addText(solution, { x: M + 0.7, y: 1.1, w: 8.3, h: 0.34, fontFace: HF, fontSize: 14, bold: true, color: C.cyan, margin: 0, valign: "middle" });
    s.addText("Self Evolution Development · darwin", { x: M, y: H - 0.38, w: 5, h: 0.25, fontFace: NF, fontSize: 9, color: C.muted, margin: 0 });
    return s;
  }
  // A dark divider announcing one of the two layers of the story.
  function dividerSlide(index, title, body) {
    const s = darkSlide();
    s.addText(index, { x: M, y: 1.3, w: 9, h: 0.4, fontFace: NF, fontSize: 13, color: C.cyanBright, charSpacing: 3, margin: 0 });
    s.addText(title, { x: M, y: 1.75, w: 9, h: 0.9, fontFace: HF, fontSize: 34, bold: true, color: C.white, margin: 0 });
    s.addText(body, { x: M, y: 2.8, w: 8.2, h: 1.4, fontFace: HF, fontSize: 14, color: C.dim, margin: 0, valign: "top" });
    return s;
  }
  // a terminal-style chip: dark pill with monospace text
  function chip(s, text, x, y, w, opts = {}) {
    const h = opts.h || 0.34;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, fill: { color: opts.bg || C.ink }, line: { color: opts.bg || C.ink }, rectRadius: 0.06 });
    s.addText(text, { x: x + 0.08, y, w: w - 0.16, h, fontFace: "Consolas", fontSize: opts.size || 11, color: opts.fg || C.cyanBright, valign: "middle", margin: 0 });
  }
  function card(s, x, y, w, h) {
    s.addShape(pres.shapes.RECTANGLE, { x, y, w, h, fill: { color: C.card }, line: { color: C.line, width: 0.75 }, shadow: shadow() });
  }
  async function iconRow(s, Icon, x, y, w, head, body, opts = {}) {
    const d = opts.d || 0.46;
    s.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: opts.circle || C.cyan }, line: { color: opts.circle || C.cyan } });
    s.addImage({ data: await icon(Icon, C.white), x: x + d * 0.25, y: y + d * 0.25, w: d * 0.5, h: d * 0.5 });
    s.addText(head, { x: x + d + 0.18, y: y - 0.04, w: w - d - 0.18, h: 0.34, fontFace: HF, fontSize: 14, bold: true, color: C.ink, margin: 0 });
    s.addText(body, { x: x + d + 0.18, y: y + 0.3, w: w - d - 0.18, h: opts.bodyH || 0.7, fontFace: HF, fontSize: 11, color: C.muted, valign: "top", margin: 0 });
  }
  function stat(s, x, y, w, num, label, opts = {}) {
    // num may be a string or [numberPart, unitPart]; the unit renders in the CJK face at a smaller size
    const runs = Array.isArray(num)
      ? [{ text: num[0], options: { fontFace: NF } }, { text: num[1], options: { fontFace: HF, fontSize: Math.round((opts.size || 40) * 0.55) } }]
      : num;
    s.addText(runs, { x, y, w, h: 0.75, fontFace: NF, fontSize: opts.size || 40, bold: true, color: opts.color || C.cyan, margin: 0, align: opts.align || "left", valign: "bottom" });
    s.addText(label, { x, y: y + 0.74, w, h: 0.5, fontFace: HF, fontSize: 11, color: opts.labelColor || C.muted, margin: 0, align: opts.align || "left", valign: "top" });
  }

  // ==== 1. Title ==============================================================
  {
    const s = darkSlide();
    s.addText("Self Evolution", { x: M, y: 1.0, w: 5.2, h: 0.8, fontFace: NF, fontSize: 44, bold: true, color: C.white, margin: 0 });
    s.addText("Development", { x: M, y: 1.7, w: 5.2, h: 0.8, fontFace: NF, fontSize: 44, bold: true, color: C.cyanBright, margin: 0 });
    s.addText("自进化迭代开发的实验", { x: M, y: 2.62, w: 5.2, h: 0.5, fontFace: HF, fontSize: 22, color: C.white, margin: 0 });
    s.addText("让一个 coding agent 接手自己的开发，三个星期后发生了什么", { x: M, y: 3.2, w: 4.9, h: 0.6, fontFace: HF, fontSize: 12.5, color: C.dim, margin: 0 });
    chip(s, "you> /self-evolution-research", M, 4.25, 3.6, { bg: "1B2633" });
    s.addText("2026-08-13 → 2026-09-06 · github.com/xiehust/strands-darwin", { x: M, y: H - 0.5, w: 6, h: 0.3, fontFace: NF, fontSize: 10, color: C.dim, margin: 0 });
    const f = fit(1242, 434, 5.5, 1.55, 4.0, 2.6);
    // frame gives the tightly cropped screenshot some breathing room
    s.addShape(pres.shapes.RECTANGLE, { x: f.x - 0.12, y: f.y - 0.12, w: f.w + 0.24, h: f.h + 0.24, fill: { color: "1B2633" }, line: { color: "2A3A4D", width: 0.75 } });
    s.addImage({ path: IMG("00-welcome.png"), ...f });
  }

  // ==== 2. 起因 ===============================================================
  {
    const s = lightSlide("想验证两件事", "起因");
    s.addText("现在的模型和 agent 框架，够不够让一个 coding agent 接手自己的开发——从提需求、实现、测试、验收到提交整条链都由它自己跑，人只在边界上做决定。",
      { x: M, y: 1.4, w: 5.1, h: 0.95, fontFace: HF, fontSize: 13, color: C.ink, margin: 0, valign: "top" });
    await iconRow(s, FaSearch, M, 2.45, 5.1, "受 Auto Research 和 agent 自我改进的启发", "Karpathy 的 autoresearch、Sakana 的 Darwin Gödel Machine 都在问同一个问题：把改进的循环交给 agent 之后，人还需要留在哪里。", { bodyH: 0.6 });
    await iconRow(s, FaLayerGroup, M, 3.4, 5.1, "顺带压测 Strands SDK", "权限拦截、上下文压缩和卸载、子 agent 编排、多模型切换、会话恢复，它都声称支持，但没有一个足够复杂的项目同时压过。", { bodyH: 0.6, circle: "50808E" });
    await iconRow(s, FaCodeBranch, M, 4.35, 5.1, "基线固定在 v0.0.1", "8 月 13 日用 Claude Code 搭出来，之后每一次提交都由当时最新的 darwin 自己写。", { bodyH: 0.45, circle: C.amber });
    // right: the rule as a dark callout
    s.addShape(pres.shapes.RECTANGLE, { x: 6.0, y: 1.45, w: 3.5, h: 2.95, fill: { color: C.ink }, line: { color: C.ink } });
    s.addText("规则只有一条", { x: 6.3, y: 1.7, w: 3.0, h: 0.4, fontFace: HF, fontSize: 12, color: C.dim, margin: 0 });
    s.addText("每一版通过验收的 darwin，就是开发下一版的工具。", { x: 6.3, y: 2.12, w: 3.0, h: 0.95, fontFace: HF, fontSize: 17, bold: true, color: C.white, margin: 0, valign: "top" });
    s.addText("代码库本身就是实验和测试环境。", { x: 6.3, y: 3.15, w: 3.0, h: 0.4, fontFace: HF, fontSize: 13, color: C.cyanBright, margin: 0 });
    chip(s, "git tag v0.0.1  # 2026-08-13", 6.3, 3.75, 2.9, { bg: "1B2633" });
  }

  // ==== 3. 路线图（两层问题） ==================================================
  // Defined below as addRouteSlide(); called here so it precedes the baseline slide.
  await addRouteSlide();

  // ==== 4. 第一步：基线 =======================================================
  {
    const s = lightSlide("用 Claude Code 搭一个基线", "第一步 · 2026-08-13");
    s.addText("给 Claude Code 的提示词只有一句：", { x: M, y: 1.4, w: 4.4, h: 0.3, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0 });
    s.addShape(pres.shapes.RECTANGLE, { x: M, y: 1.75, w: 4.4, h: 0.95, fill: { color: C.ink }, line: { color: C.ink } });
    s.addText("使用 strands sdk ts 版，搭建一个 tui 的简单的单体 agent 模式的 coding agent MVP，支持 skills，mcp 等基础功能。",
      { x: M + 0.2, y: 1.75, w: 4.0, h: 0.95, fontFace: HF, fontSize: 11, italic: true, color: C.white, margin: 0, valign: "middle" });
    s.addText("PRD 里定下一条原则：能用 SDK 的就不自己造。两天、19 个 commit，v0.0.1 出来了。验收标准是能改真实代码——在一个真的 git 仓库里对话，agent 读文件、改文件、跑命令，独立完成一次小修改。",
      { x: M, y: 2.85, w: 4.4, h: 1.1, fontFace: HF, fontSize: 11, color: C.ink, margin: 0, valign: "top" });
    stat(s, M, 3.95, 1.4, "19", "commit", { size: 28 });
    stat(s, M + 1.45, 3.95, 1.5, "~3,100", "行 TypeScript", { size: 28 });
    stat(s, M + 3.0, 3.95, 1.4, "18", "验证脚本", { size: 28 });
    // right: what v0.0.1 shipped
    card(s, 5.3, 1.4, 4.2, 3.55);
    s.addText("v0.0.1 有什么", { x: 5.55, y: 1.52, w: 3.7, h: 0.35, fontFace: HF, fontSize: 13, bold: true, color: C.ink, margin: 0 });
    const items = [
      ["复用 SDK", "Bedrock 上的 Claude；bash / fileEditor 工具；SessionManager 会话和 --resume；SDK 的对话压缩"],
      ["MCP", "SDK McpClient，stdio 和 Streamable HTTP，沿用 .mcp.json 格式"],
      ["权限", "读放行，写和执行前弹 y/n；SDK hook 拦截，不改 agent loop。次日加 default / auto / yolo"],
      ["Skills（唯一自建）", "TS SDK 当时没有 Skills：扫 SKILL.md，load_skill 按需加载，/skill-name 手动触发"],
      ["TUI 与项目层", "Ink 消息流、工具面板、确认框；预载 AGENTS.md，配置收进 .darwin/"],
    ];
    items.forEach(([h, b], i) => {
      const y = 1.95 + i * 0.6;
      s.addText(h, { x: 5.55, y, w: 1.1, h: 0.55, fontFace: HF, fontSize: 10.5, bold: true, color: i === 3 ? C.amber : C.cyan, margin: 0, valign: "top" });
      s.addText(b, { x: 6.65, y, w: 2.7, h: 0.58, fontFace: HF, fontSize: 9.5, color: C.muted, margin: 0, valign: "top" });
    });
  }

  // ==== (route slide body; slide order is decided by the call above) ============
  async function addRouteSlide() {
    const s = lightSlide("两层问题，七步", "路线");
    s.addText("回头看，三周的迭代其实在回答两个问题。第一个是迭代方向从哪来：从人一条条提，逐步过渡到 darwin 自己定。第二个是方向定了之后，每一轮怎么做好。",
      { x: M, y: 1.35, w: 9, h: 0.6, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0, valign: "top" });
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
    let ly = 2.05;
    for (const [name, color, steps] of layers) {
      s.addShape(pres.shapes.RECTANGLE, { x: M, y: ly, w: 0.06, h: 1.4, fill: { color }, line: { color } });
      s.addText(name, { x: M + 0.2, y: ly, w: 5, h: 0.3, fontFace: HF, fontSize: 12, bold: true, color, margin: 0 });
      const n = steps.length, gap = 0.12, w = (W - 2 * M - 0.2 - gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) {
        const [step, head, body, Icon] = steps[i];
        const x = M + 0.2 + i * (w + gap), d = 0.34;
        s.addShape(pres.shapes.OVAL, { x, y: ly + 0.4, w: d, h: d, fill: { color }, line: { color } });
        s.addImage({ data: await icon(Icon, C.white), x: x + d * 0.25, y: ly + 0.4 + d * 0.25, w: d * 0.5, h: d * 0.5 });
        s.addText(step, { x: x + d + 0.1, y: ly + 0.4, w: w - d - 0.1, h: d, fontFace: NF, fontSize: 9, color: C.muted, margin: 0, valign: "middle" });
        s.addText(head, { x, y: ly + 0.8, w: w + 0.1, h: 0.26, fontFace: HF, fontSize: 9.5, bold: true, color: C.ink, margin: 0 });
        s.addText(body, { x, y: ly + 1.06, w, h: 0.36, fontFace: HF, fontSize: 8.5, color: C.muted, margin: 0, valign: "top" });
      }
      ly += 1.6;
    }
  }

  // ==== 4b. 分隔：第一层 =======================================================
  {
    dividerSlide("第一层", "迭代方向从哪来？", "自我迭代最难的一步是决定下一步改什么。这一层讲方向来源怎么一步步从人手里交出去：人自己提，换成另一个 agent 提，再到 darwin 能给自己派活，最后 darwin 自己研究、自己排优先级，并用随机性避免只盯着一处看。");
  }

  // ==== 5. 第二、三步 =========================================================
  {
    const s = problemSlide("第二步 · 第三步", "方向全靠我一条条提，人成了瓶颈", "先让 Claude Code 扮演开发者替我提需求，每个需求用最新的 darwin 去做");
    s.addText([
      { text: "第二步：", options: { bold: true, color: C.cyan } },
      { text: "我在 darwin 仓库里启动 darwin，一条条提需求：system prompt 可配置、prompt caching、/usage、通配符权限、/effort。验证了一个前提：darwin 改自己的源码不会把自己弄坏。但方向只有一个来源，就是我。", options: { breakLine: true } },
      { text: " ", options: { breakLine: true, fontSize: 6 } },
      { text: "第三步：", options: { bold: true, color: C.cyan } },
      { text: "提需求很花时间，而且我提的不见得比模型提得好。8 月 14 日晚上给 Claude Code 一条指令：" },
    ], { x: M, y: 1.7, w: 4.3, h: 2.0, fontFace: HF, fontSize: 11.5, color: C.ink, margin: 0, valign: "top" });
    s.addShape(pres.shapes.RECTANGLE, { x: M, y: 3.75, w: 4.3, h: 0.85, fill: { color: C.ink }, line: { color: C.ink } });
    s.addText("现在开始你扮演一个开发者，不要修改 repo 中的任何代码，只负责提出需求，用 darwin 来迭代自己……迭代下一个需求时，用最新的 darwin 启动去迭代。",
      { x: M + 0.2, y: 3.75, w: 3.9, h: 0.85, fontFace: HF, fontSize: 10.5, color: C.white, margin: 0, valign: "middle", italic: true });
    const f = fit(2278, 962, 5.1, 1.75, 4.4, 2.1);
    s.addImage({ path: IMG("01-cc-as-developer.png"), ...f });
    s.addText("Claude Code 以开发者口吻提出的前六个需求。第 6 条 /compact 由第 5 条刚接入的模型驱动完成。方向来源从人换成了另一个 agent，但还是在 darwin 外面。",
      { x: 5.1, y: 3.95, w: 4.4, h: 0.8, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 6. 第四步 /developer ==================================================
  {
    const s = problemSlide("第四步", "darwin 只能被别人驱动，不能给自己派活", "把 headless 模式、后台 bash、完成通知组装成 /developer：一个 darwin 监督另一个");
    const flow = [
      ["Host darwin", "定范围和授权"],
      ["headless 子进程", "研究、实现、检查、提交"],
      ["Host 独立验收", "自己看 diff、跑测试"],
      ["pnpm build", "构建新版本"],
      ["下一轮", "新 darwin 起子进程"],
    ];
    const n = flow.length, arrow = 0.28, bw = (W - 2 * M - arrow * (n - 1)) / n, by = 1.75, bh = 1.1;
    for (let i = 0; i < n; i++) {
      const x = M + i * (bw + arrow);
      const dark = i === 0 || i === 2;
      s.addShape(pres.shapes.RECTANGLE, { x, y: by, w: bw, h: bh, fill: { color: dark ? C.ink : C.card }, line: { color: dark ? C.ink : C.line, width: 0.75 }, shadow: shadow() });
      s.addText(flow[i][0], { x: x + 0.1, y: by + 0.12, w: bw - 0.2, h: 0.4, fontFace: HF, fontSize: 12.5, bold: true, color: dark ? C.cyanBright : C.ink, margin: 0 });
      s.addText(flow[i][1], { x: x + 0.1, y: by + 0.55, w: bw - 0.2, h: 0.5, fontFace: HF, fontSize: 10, color: dark ? C.dim : C.muted, margin: 0, valign: "top" });
      if (i < n - 1) s.addText("→", { x: x + bw, y: by + 0.33, w: arrow, h: 0.45, fontFace: NF, fontSize: 18, color: C.cyan, align: "center", margin: 0 });
    }
    s.addText("验收不过 → 在同一个子会话里继续修正；验收通过 → 这个版本接手下一轮。这一步本身不产生方向，但它让 darwin 有了执行方向的引擎，后面两步才成为可能。",
      { x: M, y: 3.0, w: 9, h: 0.6, fontFace: HF, fontSize: 11, color: C.ink, margin: 0, valign: "top" });
    chip(s, "/developer 开始自我迭代，优化 TUI 交互，迭代至少 5 轮", M, 3.7, 5.6, { size: 10.5 });
    s.addText("第一次运行的结果：5 轮必做 + 1 轮验收发现的修复，六个 commit。验收发现的两个问题都不是子进程造成的，但只看子进程汇报会漏掉。",
      { x: M, y: 4.15, w: 5.6, h: 0.8, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, valign: "top" });
    const shotH = 1.25, shotW = shotH * 1638 / 856;
    s.addImage({ path: IMG("03-first-developer-batch.png"), x: W - M - shotW, y: 3.68, w: shotW, h: shotH, shadow: shadow() });
  }

  // ==== 7. 第五步 找方向 ======================================================
  {
    const s = problemSlide("第五步", "每一批还得我说一句“这批做什么”", "让 darwin 自己研究、自己排优先级：/self-evolution-research + backlog + 评分门槛");
    await iconRow(s, FaClipboardCheck, M, 1.8, 4.4, "先看 backlog", "读 docs/research/backlog_index.md，有没做完的方向就先做，没有才开始研究。", { bodyH: 0.6 });
    await iconRow(s, FaSearch, M, 2.8, 4.4, "研究同类产品", "Claude Code、Codex、DeepSeek harness、PenguinHarness……对照 darwin 当前的代码和架构，每次最多提 5 个方向。", { bodyH: 0.75 });
    await iconRow(s, FaBalanceScale, M, 3.95, 4.4, "过门槛才进 backlog", "低于 6 分的不进；报告里记一笔“考虑过，拒绝”。进了 backlog 的方向逐个交给 developer 实现。", { bodyH: 0.75, circle: C.amber });
    // right: score formula card
    card(s, 5.3, 1.75, 4.2, 3.0);
    s.addText("五个维度，各打 1 到 5 分", { x: 5.55, y: 1.9, w: 3.7, h: 0.35, fontFace: HF, fontSize: 12, color: C.muted, margin: 0 });
    const dims = ["重要性", "架构契合", "证据可信度", "实现难度", "风险"];
    dims.forEach((d, i) => chip(s, d, 5.55 + (i % 3) * 1.25, 2.3 + Math.floor(i / 3) * 0.42, 1.15, { bg: i < 3 ? C.cyan : "B45309", fg: C.white, size: 10, h: 0.32 }));
    s.addText("Score = 2×重要性 + 契合 + 证据 − 难度 − 风险", { x: 5.55, y: 3.2, w: 3.8, h: 0.4, fontFace: "Consolas", fontSize: 11, bold: true, color: C.ink, margin: 0 });
    s.addText("MINIMUM_IMPLEMENTATION_SCORE = 6", { x: 5.55, y: 3.6, w: 3.7, h: 0.35, fontFace: "Consolas", fontSize: 11, color: C.cyan, margin: 0 });
    s.addText("全部维度打平均分正好是 6：一个平平无奇的方向不值得一次迭代。分数不能事后改，改评分要有记录。", { x: 5.55, y: 4.0, w: 3.7, h: 0.7, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 8. 第六步 骰子 ========================================================
  {
    const s = problemSlide("第六步", "让模型自己选方向，会陷进局部最优", "借随机梯度下降的思路：给选择加一点随机扰动，摇骰子决定这次往哪看");
    s.addText("模型自己选研究什么，每次都去看同类产品，提出来的总是别人已有的功能；让它自查，它只挑最熟的那块看。这和优化里的局部最优是一回事：每一步都朝当前看起来最好的方向走，就再也看不到别处。",
      { x: M, y: 1.7, w: 4.6, h: 0.95, fontFace: HF, fontSize: 11, color: C.ink, margin: 0, valign: "top" });
    s.addText("随机数必须由脚本产生，模型自己“随便选一个”时给出的并不随机。", { x: M, y: 2.65, w: 4.6, h: 0.35, fontFace: HF, fontSize: 10, color: C.muted, margin: 0, valign: "top" });
    s.addChart(pres.charts.DOUGHNUT, [{
      name: "研究路径", labels: ["同类产品 peer", "TUI 自查", "开放式 open", "SDK 未用能力", "可观测性"], values: [50, 20, 15, 10, 5],
    }], {
      x: M - 0.1, y: 2.95, w: 4.0, h: 2.15, holeSize: 55,
      chartColors: [C.ink, C.cyan, C.amber, "50808E", "6B7280"],
      showLegend: true, legendPos: "r", legendFontSize: 9, legendColor: C.ink,
      showPercent: true, showValue: false, dataLabelColor: C.white, dataLabelFontSize: 9,
      chartArea: { fill: { color: C.paper } },
    });
    // right: rules card
    card(s, 5.4, 1.7, 4.1, 3.3);
    s.addText("摇出来的结果算数，skill 里定了几条规矩", { x: 5.6, y: 1.8, w: 3.7, h: 0.35, fontFace: HF, fontSize: 13, bold: true, color: C.ink, margin: 0 });
    s.addText([
      { text: "一次研究只摇一次，读任何资料之前摇。", options: { bullet: { indent: 12 }, breakLine: true } },
      { text: "输出原样抄进报告，不能改写。", options: { bullet: { indent: 12 }, breakLine: true } },
      { text: "不喜欢也不能重摇；没发现就如实写“没有发现”，不悄悄换路。", options: { bullet: { indent: 12 }, breakLine: true } },
      { text: "人用 --path 指定时，报告里必须留着 path-source: override。", options: { bullet: { indent: 12 }, breakLine: true } },
      { text: "骰子只决定证据从哪来，不改变评分、门槛和交付方式。", options: { bullet: { indent: 12 } } },
    ], { x: 5.6, y: 2.2, w: 3.75, h: 1.8, fontFace: HF, fontSize: 10.5, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 4 });
    s.addShape(pres.shapes.RECTANGLE, { x: 5.6, y: 4.15, w: 3.7, h: 0.7, fill: { color: C.ink }, line: { color: C.ink } });
    s.addText("“Rolling after reading is choosing.”", { x: 5.75, y: 4.15, w: 3.4, h: 0.4, fontFace: NF, fontSize: 12, italic: true, color: C.cyanBright, margin: 0, valign: "middle" });
    s.addText("先读了再摇，就等于挑。", { x: 5.75, y: 4.5, w: 3.4, h: 0.3, fontFace: HF, fontSize: 10, color: C.dim, margin: 0 });
  }

  // ==== 9. 骰子带来了什么 =====================================================
  {
    const s = lightSlide("跳出局部最优之后，看见了什么", "第六步 · 结果");
    s.addText("加了骰子之后，backlog 里开始出现看别家产品看不出来的方向。每条路径的方向都对照 docs/research/ 里记录的研究路径核过。",
      { x: M, y: 1.4, w: 9, h: 0.45, fontFace: HF, fontSize: 11.5, color: C.muted, margin: 0 });
    const cols = [
      ["tui", "TUI 自查", C.cyan, ["Esc 关闭弹层", "按词移动光标", "撤销删词", "终端提醒铃"]],
      ["observability", "可观测性", "50808E", ["失败回合写进记录", "每回合 token 花费", "可选的诊断日志"]],
      ["sdk", "SDK 未用能力", C.ink, ["官方 AgentSkills 替换手写核心", "SDK Graph 上的 workflow DAG", "结构化 headless 输出"]],
      ["open", "开放式", C.amber, ["/compact 不收缩时会一直循环", "SDK 默认模型重试：等待看不见、不能取消", "未知 config key 给出 did-you-mean"]],
    ];
    const gap = 0.3, cw = (W - 2 * M - gap * 3) / 4, cy = 2.0, ch = 2.5;
    cols.forEach(([id, name, color, items], i) => {
      const x = M + i * (cw + gap);
      card(s, x, cy, cw, ch);
      s.addShape(pres.shapes.RECTANGLE, { x, y: cy, w: cw, h: 0.08, fill: { color }, line: { color } });
      chip(s, `path: ${id}`, x + 0.15, cy + 0.25, cw - 0.3, { bg: color, fg: C.white, size: 9.5, h: 0.3 });
      s.addText(name, { x: x + 0.15, y: cy + 0.65, w: cw - 0.3, h: 0.35, fontFace: HF, fontSize: 13, bold: true, color: C.ink, margin: 0 });
      s.addText(items.map((t, k) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: k < items.length - 1 } })),
        { x: x + 0.15, y: cy + 1.05, w: cw - 0.3, h: ch - 1.2, fontFace: HF, fontSize: 10, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 4 });
    });
    s.addText("到这里，方向来源完成了从人到 darwin 的交接：人只留下权重、门槛和什么算“值得做”这几条规则。",
      { x: M, y: 4.65, w: 9, h: 0.4, fontFace: HF, fontSize: 11, color: C.ink, margin: 0, italic: true });
  }

  // ==== 9b. 分隔：第二层 =======================================================
  {
    dividerSlide("第二层", "方向定了之后，每一轮怎么做好？", "有了方向，还要让每一轮的执行越来越顺：弯路少一点、token 省一点、验收不被糊弄。这一层讲 darwin 怎么从自己的运行记录里找改进点，三周里踩过哪些坑、改了什么，以及是哪几件事让这个循环没有失控。");
  }

  // ==== 10. 第七步 反思 =======================================================
  {
    const s = problemSlide("第七步", "过程里的弯路没人看见，同样的错会一直犯", "让 darwin 读自己的运行轨迹，打分、找原因，把改进点写回 backlog");
    s.addText("每个会话都有一份只追加的 trajectory.jsonl：用户输入、每次工具调用、模型返回、token、回合结束原因。它原本是给回放和导出用的，也正好是反思的材料。/self-reflection 起一个新的 headless darwin 读它，按模板写反思：",
      { x: M, y: 1.7, w: 4.5, h: 1.0, fontFace: HF, fontSize: 11, color: C.ink, margin: 0, valign: "top" });
    const items = [
      ["1", "给完成度打分", "完美 / 高 / 中 / 低，各有明确定义。十次里有四次打了“低”。"],
      ["2", "找 darwin 自己的问题", "哪些弯路能靠改提示词、工具描述、上下文管理、agent 编排避免。"],
      ["3", "同一套评分和门槛", "值得做的写进 backlog，交给 developer；重复的标记重复，不再入队。"],
    ];
    items.forEach(([n, head, body], i) => {
      const y = 2.8 + i * 0.75;
      s.addShape(pres.shapes.OVAL, { x: M, y, w: 0.42, h: 0.42, fill: { color: i === 2 ? C.amber : C.cyan }, line: { color: i === 2 ? C.amber : C.cyan } });
      s.addText(n, { x: M, y, w: 0.42, h: 0.42, fontFace: NF, fontSize: 14, bold: true, color: C.white, align: "center", valign: "middle", margin: 0 });
      s.addText(head, { x: M + 0.6, y: y - 0.04, w: 3.9, h: 0.3, fontFace: HF, fontSize: 12.5, bold: true, color: C.ink, margin: 0 });
      s.addText(body, { x: M + 0.6, y: y + 0.26, w: 3.9, h: 0.5, fontFace: HF, fontSize: 10, color: C.muted, margin: 0, valign: "top" });
    });
    const f = fit(1119, 747, 5.3, 1.75, 4.2, 2.5);
    s.addImage({ path: IMG("06-reflection-scores.png"), ...f, shadow: shadow() });
    s.addText("第一次反思找出两条：流中断后一个 11 分钟的回合卡死等人输 continue；bash status 多传一个字段白花一次调用。SRF-003 证据不足被拒，理由写明，不靠改分硬过门槛。",
      { x: 5.3, y: 4.35, w: 4.2, h: 0.75, fontFace: HF, fontSize: 10, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 10. 闭环 ==============================================================
  {
    const s = darkSlide();
    s.addText("到这里，循环就完整了", { x: M, y: 0.5, w: 9, h: 0.6, fontFace: HF, fontSize: 28, bold: true, color: C.white, margin: 0 });
    const nodes = [
      ["研究 / 反思", "产生方向", FaCompass],
      ["评分过门槛", "进 backlog", FaBalanceScale],
      ["developer", "监督 headless 子进程", FaRobot],
      ["独立验收", "Host 自己看 diff、跑测试", FaClipboardCheck],
      ["pnpm build", "新版本接手下一轮", FaSyncAlt],
    ];
    const n = nodes.length, gap = 0.35, bw = (W - 2 * M - gap * (n - 1)) / n, by = 1.75, bh = 1.7;
    for (let i = 0; i < n; i++) {
      const x = M + i * (bw + gap);
      s.addShape(pres.shapes.RECTANGLE, { x, y: by, w: bw, h: bh, fill: { color: "1B2633" }, line: { color: "2A3A4D", width: 0.75 } });
      const d = 0.5;
      s.addShape(pres.shapes.OVAL, { x: x + 0.15, y: by + 0.15, w: d, h: d, fill: { color: i === 4 ? C.amber : C.cyanBright }, line: { color: i === 4 ? C.amber : C.cyanBright } });
      s.addImage({ data: await icon(nodes[i][2], C.ink), x: x + 0.15 + d * 0.25, y: by + 0.15 + d * 0.25, w: d * 0.5, h: d * 0.5 });
      s.addText(nodes[i][0], { x: x + 0.15, y: by + 0.75, w: bw - 0.3, h: 0.4, fontFace: HF, fontSize: 13, bold: true, color: C.white, margin: 0 });
      s.addText(nodes[i][1], { x: x + 0.15, y: by + 1.12, w: bw - 0.3, h: 0.5, fontFace: HF, fontSize: 10, color: C.dim, margin: 0, valign: "top" });
      if (i < n - 1) s.addText("→", { x: x + bw, y: by + 0.6, w: gap, h: 0.5, fontFace: NF, fontSize: 18, color: C.cyanBright, align: "center", margin: 0 });
    }
    // return arrow: a line under the boxes from last to first
    s.addShape(pres.shapes.LINE, { x: M + bw / 2, y: by + bh + 0.3, w: (W - 2 * M) - bw, h: 0, line: { color: C.amber, width: 1.5, dashType: "dash", beginArrowType: "triangle" } });
    s.addText("新版本回到起点，继续研究下一个方向", { x: M, y: by + bh + 0.4, w: 9, h: 0.35, fontFace: HF, fontSize: 11, color: C.amber, align: "center", margin: 0 });
    s.addText("人保留的：给方向、产品取舍、安全边界、授权 push。其余的，darwin 自己跑。", { x: M, y: 4.55, w: 9, h: 0.4, fontFace: HF, fontSize: 12.5, color: C.white, margin: 0, align: "center" });
  }

  // ==== 11. 坑：token =========================================================
  {
    const s = lightSlide("最先碰到的问题：token 烧得太快", "第二层 · 踩坑 1");
    const stats = [["706", "次模型调用"], [["29.6", " 万"], "output token"], [["3.98", " 亿"], "cache read token"], ["1.11", "每次调用平均只发的工具数"]];
    stats.forEach(([n, l], i) => stat(s, M + i * 2.3, 1.4, 2.2, n, l, { size: 34, color: i === 3 ? C.amber : C.cyan }));
    s.addText("8 月 17 日统计的一个批次。同一个子会话从 planning 续到第四轮修正，每次调用读取的缓存上下文从 23 万涨到 79 万；最后一轮只产出 3111 个 output token，却读了 1740 万缓存。Planning 阶段单独占 37% 的 output。",
      { x: M, y: 2.75, w: 5.0, h: 1.1, fontFace: HF, fontSize: 11, color: C.ink, margin: 0, valign: "top" });
    s.addText([
      { text: "改法 · 流程  ", options: { bold: true, color: C.cyan } },
      { text: "不再拆 planning child 和 implementation child 各审一次；一个完整 worker 自己走完研究、实现、检查、提交，Host 只在最后独立验收。", options: { breakLine: true } },
      { text: "改法 · 提示词  ", options: { bold: true, color: C.cyan } },
      { text: "互不依赖的读取、搜索、检查在同一条消息里批量发出。现在一个方向典型花费 1–16 美元、12–170 次调用。" },
    ], { x: M, y: 3.85, w: 5.0, h: 1.2, fontFace: HF, fontSize: 10.5, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 4 });
    const f = fit(683, 341, 5.8, 2.75, 3.7, 1.85);
    s.addImage({ path: IMG("05-context-growth.png"), ...f, shadow: shadow() });
    s.addText("后期的修正本身不贵，贵的是它们一直带着前面所有的历史。", { x: 5.8, y: 4.65, w: 3.7, h: 0.4, fontFace: HF, fontSize: 10, color: C.muted, margin: 0, italic: true });
  }

  // ==== 12. 坑：其余四个 ======================================================
  {
    const s = lightSlide("另外四个教训", "第二层 · 踩坑 2");
    const items = [
      [FaHourglassHalf, C.cyan, "监督子进程比子进程干活还贵", "一个批次 390 次工具调用，322 次是 Host 在轮询两个子进程的 status 和 output，每醒一次都是一轮带全上下文的模型调用。先改成阻塞式 wait，最长能等 30 分钟；最后反过来：后台任务 start 后立即返回，Host 可以结束回合，任务结束时一条 <task-notification> 进入提示队列，会话空闲时唤醒模型。"],
      [FaBalanceScale, C.amber, "反思要敢打低分", "十次里四次“低”：结论形成了没发出去、轨迹定位不匹配、最后一个回合没闭合。未闭合那条变成了 SRF-012：反思只对已闭合的回合打分。"],
      [FaRedoAlt, C.ink, "同一个错，不换假设就别再试", "一次服务端校验失败，darwin 换着参数连试了六种变体，12 分钟、1.1 万 output token，直到被人取消。反思提出 SRF-016 重试守卫：同一失败签名第二次要说出有证据的新假设，第三次停下汇报，第四次直接拒绝执行。"],
      [FaLayerGroup, "50808E", "流程框架也会变成拖累", "Trellis 前三周有用；切到 Claude Fable 5.1 后，模型自己会读 AGENTS.md、跑 spike 再改代码，Trellis 成了第二本规则手册。9 月 4 日整层移除，只留下那句原则。"],
    ];
    const gap = 0.25, cw = (W - 2 * M - gap) / 2, ch = 1.6;
    for (let i = 0; i < 4; i++) {
      const x = M + (i % 2) * (cw + gap), y = 1.45 + Math.floor(i / 2) * (ch + gap);
      card(s, x, y, cw, ch);
      const d = 0.46;
      s.addShape(pres.shapes.OVAL, { x: x + 0.2, y: y + 0.2, w: d, h: d, fill: { color: items[i][1] }, line: { color: items[i][1] } });
      s.addImage({ data: await icon(items[i][0], C.white), x: x + 0.2 + d * 0.25, y: y + 0.2 + d * 0.25, w: d * 0.5, h: d * 0.5 });
      s.addText(items[i][2], { x: x + 0.8, y: y + 0.2, w: cw - 1.0, h: 0.4, fontFace: HF, fontSize: 13, bold: true, color: C.ink, margin: 0 });
      s.addText(items[i][3], { x: x + 0.8, y: y + 0.6, w: cw - 1.0, h: ch - 0.7, fontFace: HF, fontSize: 9.5, color: C.muted, margin: 0, valign: "top" });
    }
  }

  // ==== 13. 为什么能一直跑下去 ================================================
  {
    const s = lightSlide("为什么能一直跑下去", "第二层 · 机制");
    const rows = [
      [FaFileAlt, C.cyan, "该记的东西都写进文件", "每个会话从零开始，上一代只能靠文件传给下一代。AGENTS.md 预载进系统提示，一张表列着哪些约束不能破坏、代码在哪、用哪个脚本验证（32 KB 上限）。每批必须往 iteration-log 追加一条。“Specs injected, not remembered.”"],
      [FaVial, C.cyan, "测试不用 mock", "spike/ 下一百三十来个脚本：真实 pty 驱动 TUI、真的 git 仓库、直接调模型。pnpm test 跑其中 100 个免模型套件。子进程说“测试过了”，Host 用同一条命令得到同一个答案。"],
      [FaUserShield, C.cyan, "提前说好哪些事归人管", "产品取舍、安全边界、授权是人的。工作树不干净、起点无法验证、验收反复失败、前提被证伪——整批停下并记录原因。darwin 在没人在场时知道该停在哪。"],
      [FaSyncAlt, C.amber, "每一轮都用刚改出来的 darwin 做下一轮", "验收通过、提交后立刻 build，下一个方向就由新 darwin 来做。改动一提交就进入实际工作：改得好下一轮顺一些，改坏了下一轮就会撞上它。每次改进的结果，反过来决定下一次改进的质量。"],
    ];
    const gap = 0.2, cw = (W - 2 * M - gap) / 2, ch = 1.62;
    for (let i = 0; i < 4; i++) {
      const x = M + (i % 2) * (cw + gap), y = 1.4 + Math.floor(i / 2) * (ch + gap);
      const last = i === 3;
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: cw, h: ch, fill: { color: last ? C.ink : C.card }, line: { color: last ? C.ink : C.line, width: 0.75 }, shadow: shadow() });
      const d = 0.44;
      s.addShape(pres.shapes.OVAL, { x: x + 0.2, y: y + 0.2, w: d, h: d, fill: { color: rows[i][1] }, line: { color: rows[i][1] } });
      s.addImage({ data: await icon(rows[i][0], last ? C.ink : C.white), x: x + 0.2 + d * 0.25, y: y + 0.2 + d * 0.25, w: d * 0.5, h: d * 0.5 });
      s.addText(rows[i][2], { x: x + 0.78, y: y + 0.18, w: cw - 0.95, h: 0.4, fontFace: HF, fontSize: 12.5, bold: true, color: last ? C.white : C.ink, margin: 0 });
      s.addText(rows[i][3], { x: x + 0.78, y: y + 0.58, w: cw - 0.95, h: ch - 0.68, fontFace: HF, fontSize: 9.5, color: last ? C.dim : C.muted, margin: 0, valign: "top" });
    }
  }

  // ==== 14. 现在的样子 ========================================================
  {
    const s = lightSlide("三个星期之后", "现在的样子 · 2026-08-13 → 09-06");
    const stats = [
      ["672", "commit"], ["99", "受监督的迭代批次"], ["95", "backlog 方向 · 93 done"],
      ["~37,000", "行 TypeScript（src/）"], ["~130", "spike 脚本 · 100 个进 pnpm test"], ["20 / 10", "研究报告 / 反思报告"],
    ];
    const gap = 0.25, cw = (W - 2 * M - gap * 2) / 3, ch = 1.25;
    stats.forEach(([n, l], i) => {
      const x = M + (i % 3) * (cw + gap), y = 1.45 + Math.floor(i / 3) * (ch + gap);
      card(s, x, y, cw, ch);
      s.addText(n, { x: x + 0.2, y: y + 0.12, w: cw - 0.4, h: 0.65, fontFace: NF, fontSize: 32, bold: true, color: i === 2 ? C.amber : C.cyan, margin: 0 });
      s.addText(l, { x: x + 0.2, y: y + 0.78, w: cw - 0.4, h: 0.4, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, valign: "top" });
    });
    s.addText("基线之后的实现代码都是 darwin 写的。功能：流式 Markdown 和文件 diff、四种权限模式、可恢复会话和轨迹回放、subagent 和 workflow DAG、hook 和 MCP、headless 结构化输出、多模型切换、agent 管理的项目记忆，以及三个自进化 skill。",
      { x: M, y: 4.5, w: 9, h: 0.7, fontFace: HF, fontSize: 10.5, color: C.ink, margin: 0, valign: "top" });
  }

  // ==== 16. Strands SDK 用到了什么、补了什么 ==================================
  {
    const s = lightSlide("Strands SDK：用到了什么，补了什么", "SDK 压测结果");
    s.addText("runtime.ts 是唯一构造 Agent 的地方，只做装配；agent 循环一次都没有 fork 过。不够的地方集中在自带工具和插件的细节，用一个 pnpm patch 补齐。",
      { x: M, y: 1.4, w: 9, h: 0.45, fontFace: HF, fontSize: 11, color: C.muted, margin: 0, valign: "top" });
    // left: used
    card(s, M, 1.95, 4.9, 2.9);
    s.addShape(pres.shapes.RECTANGLE, { x: M, y: 1.95, w: 4.9, h: 0.08, fill: { color: C.cyan }, line: { color: C.cyan } });
    s.addText("原生用上的", { x: M + 0.2, y: 2.12, w: 4.5, h: 0.3, fontFace: HF, fontSize: 12.5, bold: true, color: C.ink, margin: 0 });
    const used = [
      ["模型", "BedrockModel / AnthropicModel / OpenAIModel（Mantle）；Model.updateConfig() 会话中途换 effort 和模型；CachePointBlock"],
      ["工具", "bash、fileEditor、httpRequest 直接注册；McpClient（stdio + Streamable HTTP）"],
      ["上下文", "SummarizingConversationManager 做 /compact；ContextOffloader 默认开；SessionManager + LocalFileStorage；checkpoint 做 /rewind"],
      ["控制", "InterventionHandler 做权限门；模型、工具、调用三类 hook；InvokeModelStage 中间件 + ExponentialBackoff 做限流重试"],
      ["多 agent", "默认并发执行器跑 subagent；Graph 跑 workflow DAG；backgroundTasks 做后台委派；官方 AgentSkills"],
    ];
    used.forEach(([h, b], i) => {
      const y = 2.48 + i * 0.47;
      s.addText(h, { x: M + 0.2, y, w: 0.75, h: 0.45, fontFace: HF, fontSize: 9.5, bold: true, color: C.cyan, margin: 0, valign: "top" });
      s.addText(b, { x: M + 0.95, y, w: 3.75, h: 0.46, fontFace: HF, fontSize: 8.5, color: C.ink, margin: 0, valign: "top" });
    });
    // right: patched
    const px = M + 4.9 + 0.2, pw = W - M - px;
    card(s, px, 1.95, pw, 2.9);
    s.addShape(pres.shapes.RECTANGLE, { x: px, y: 1.95, w: pw, h: 0.08, fill: { color: C.amber }, line: { color: C.amber } });
    s.addText("patch 补的", { x: px + 0.2, y: 2.12, w: 2.4, h: 0.3, fontFace: HF, fontSize: 12.5, bold: true, color: C.ink, margin: 0 });
    s.addText("1 个 patch · 15 个文件 · 约 950 行", { x: px + 0.2, y: 2.12, w: pw - 0.4, h: 0.3, fontFace: NF, fontSize: 9.5, color: C.muted, margin: 0, align: "right" });
    const patched = [
      ["bash ~400 行", "stdin 接 /dev/null，交互提示直接 EOF；按进程组杀；后台任务增量 wait，终端聚焦等待最长 30 分钟"],
      ["ContextOffloader ~300 行", "excludeTools 让 load_skill 永不卸载；卸载的 JSON 可按行搜索切片；恢复旧会话时修复超大历史结果"],
      ["fileEditor ~180 行", "str_replace 未命中返回有限上下文，零写入；新增 replace_all"],
      ["小补丁", "包根导出 DEFAULT_SUMMARIZATION_PROMPT；摘要过滤 thinking 推理块；OpenAI 适配器补 cache_write_tokens、溢出识别"],
    ];
    patched.forEach(([h, b], i) => {
      const y = 2.45 + i * 0.56;
      s.addText(h, { x: px + 0.2, y, w: pw - 0.4, h: 0.22, fontFace: HF, fontSize: 9.5, bold: true, color: C.amber, margin: 0 });
      s.addText(b, { x: px + 0.2, y: y + 0.22, w: pw - 0.4, h: 0.36, fontFace: HF, fontSize: 8.5, color: C.ink, margin: 0, valign: "top" });
    });
    s.addText("补丁都是 darwin 在自我迭代中撞到问题后自己写的。补的是边角，agent 循环、会话、压缩、编排这些主干没有动过。",
      { x: M, y: 4.92, w: 9, h: 0.25, fontFace: HF, fontSize: 9.5, color: C.muted, margin: 0, italic: true });
  }

  // ==== 17. DeepSWE 对照 ======================================================
  {
    const s = lightSlide("跟 Claude Code 跑同一批题", "DeepSWE 前 20 题 · 2026-09-05 / 09-08");
    s.addText("同一个模型（Bedrock 上的 Claude Opus 5）、同一批任务，只换 agent：darwin 是 commit 2240a3c，Claude Code 是 2.1.261。9 月 8 日两个 harness 各自把 effort 从 high 降到 medium 再跑一轮，其余不变。",
      { x: M, y: 1.35, w: 9, h: 0.55, fontFace: HF, fontSize: 10.5, color: C.muted, margin: 0, valign: "top" });
    // two headline cards: one per effort level — same score, darwin cheaper
    const half = (W - 2 * M - 0.3) / 2;
    [["effort high · 09-05", "12/20 vs 12/20", "darwin 成本低 7%", C.cyan], ["effort medium · 09-08", "13/20 vs 13/20", "darwin 成本低 11%", C.amber]].forEach(([name, score, note, color], i) => {
      const x = M + i * (half + 0.3);
      card(s, x, 1.9, half, 0.85);
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.9, w: 0.08, h: 0.85, fill: { color }, line: { color } });
      s.addText(name, { x: x + 0.3, y: 1.95, w: half - 0.5, h: 0.26, fontFace: NF, fontSize: 10.5, color: C.muted, margin: 0 });
      s.addText([
        { text: score, options: { fontFace: NF, fontSize: 22, bold: true, color: C.ink } },
        { text: "   ", options: { fontFace: HF, fontSize: 12 } },
        { text: note, options: { fontFace: HF, fontSize: 12, bold: true, color } },
      ], { x: x + 0.3, y: 2.18, w: half - 0.5, h: 0.5, margin: 0, valign: "middle" });
    });
    const L = (t) => ({ text: t, options: { align: "left", color: C.muted } });
    const Hd = (t) => ({ text: t, options: { bold: true, align: "right" } });
    s.addTable([
      [{ text: "", options: { fill: { color: C.paper } } }, Hd("darwin high"), Hd("darwin medium"), Hd("Claude Code high"), Hd("Claude Code medium")],
      [L("成本"), "$138.92", "$83.97（−40%）", "$149.29", "$94.42（−37%）"],
      [L("input token · 缓存命中"), "168.5 M · 98%", "99 M · 98%", "176.5 M · 98%", "113 M · 98%"],
      [L("output token"), "1477 K", "903 K（−39%）", "1471 K", "966 K（−34%）"],
      [L("单题耗时 · 中位"), "11–33 min · 18", "5–31 min · 11", "8–45 min · 18", "6–23 min · 12"],
    ], {
      x: M, y: 2.9, w: 9.0, colW: [2.0, 1.75, 1.75, 1.75, 1.75], fontFace: HF, fontSize: 8.5, color: C.ink,
      border: { type: "solid", pt: 0.5, color: C.line }, fill: { color: C.card }, margin: 0.04, align: "right", rowH: 0.24,
    });
    s.addText([
      { text: "结论：能力差不多，darwin 更省。", options: { bold: true } },
      { text: "high 和 medium 两个档下，darwin 与 Claude Code 得分都相同（12 vs 12、13 vs 13），成本分别低 7% 和 11%，差在 input token 上。high 那轮 18 题结果一致，分歧两题方向相反、各赢一题。", options: { breakLine: true } },
      { text: "局限：", options: { bold: true } },
      { text: "pass@1 单次采样；字典序前 20 题，不是随机抽样；1–2 题的差距都在同配置两跑翻 6 题的噪声之内。" },
    ], { x: M, y: 4.3, w: 4.35, h: 0.85, fontFace: HF, fontSize: 9, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 3 });
    s.addText([
      { text: "附带发现：Opus 5 的 medium 性价比远高于 high。", options: { bold: true, color: C.amber } },
      { text: "两个 harness 各自把 effort 从 high 降到 medium，成本降 40% / 37%，分数 12 → 13 都没有变差；同一方向和量级在两个互不相关的 harness 上复现。DeepSWE 这类任务上，high 多花约 1.6 倍成本，没有买到可测量的分数。" },
    ], { x: 5.15, y: 4.3, w: 4.35, h: 0.85, fontFace: HF, fontSize: 9, color: C.ink, margin: 0, valign: "top" });
  }

  // ==== 17. RSI / Auto Research 是什么 =======================================
  {
    const s = lightSlide("两个容易混在一起的词，和一套对照坐标", "RSI · Auto Research");
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
    const gap = 0.25, cw = (W - 2 * M - gap * 2) / 3, cy = 1.45, ch = 2.75;
    cols.forEach(([name, meta, color, items], i) => {
      const x = M + i * (cw + gap);
      card(s, x, cy, cw, ch);
      s.addShape(pres.shapes.RECTANGLE, { x, y: cy, w: cw, h: 0.08, fill: { color }, line: { color } });
      s.addText(name, { x: x + 0.18, y: cy + 0.2, w: cw - 0.36, h: 0.35, fontFace: HF, fontSize: 13, bold: true, color: C.ink, margin: 0 });
      s.addText(meta, { x: x + 0.18, y: cy + 0.55, w: cw - 0.36, h: 0.25, fontFace: NF, fontSize: 9.5, color: C.muted, margin: 0 });
      s.addText(items.map((t, k) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: k < items.length - 1 } })),
        { x: x + 0.18, y: cy + 0.9, w: cw - 0.36, h: ch - 1.0, fontFace: HF, fontSize: 9.5, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 4 });
    });
    s.addText("对照坐标来自 Lilian Weng《Harness Engineering for Self-Improvement》（2026-07）。三个 harness 设计模式：工作流自动化、文件系统作为持久记忆、子 agent 和后台任务。优化对象的渐进线：提示词 → 结构化上下文 → 工作流 → harness 代码 → 优化器代码。自改进回路的参照：Self-Harness 的 propose–evaluate–accept，AHE 的七个可编辑组件和三层可观测性。下一页按这套坐标放 darwin。",
      { x: M, y: 4.4, w: 9, h: 0.6, fontFace: HF, fontSize: 9.5, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 18. darwin 与四类 RSI 模式 ==============================================
  // Four families of self-improving loops (Weng 2026; the "four families, one recipe"
  // framing), each with darwin's relation to it; then the shared recipe with darwin's
  // status on each of its four steps.
  {
    const s = lightSlide("darwin 与四类 RSI 模式：区别和定位", "RSI · 四类模式 · 对照");
    const fams = [
      ["01", "反思式文本进化", "GEPA · ACE · MCE", C.cyan, "改的只是提示词和上下文：便宜、样本高效，可编辑面小。", "不属于", "darwin 改的是代码，不只是自然语言。"],
      ["02", "程序与工作流搜索", "ADAS · AFlow · AlphaEvolve · ShinkaEvolve", C.amber, "代码是搜索空间，能长出不显然的设计；需要快而客观的自动评价器。", "不属于", "没有候选池，也没有自动评价器。"],
      ["03", "自修改 harness", "DGM · Self-Harness · AHE", C.ink, "agent 改自己的 harness，收益最大；风险也最高：抽象边界被破、reward hacking。", "darwin 在这里", "改自己的 harness 代码，七个组件都动过；单谱系、人工门控的有界变体。"],
      ["04", "元优化器", "STOP · Meta-Harness", "50808E", "优化改进者本身，最通用；最耗算力，质量受基础模型上限约束。", "沾一点边", "三个自进化 skill 就是优化器，也在被改；但没有候选 harness 池。"],
    ];
    const gap = 0.2, cw = (W - 2 * M - gap * 3) / 4, cy = 1.35, ch = 2.15;
    fams.forEach(([n, name, members, color, desc, rel, note], i) => {
      const x = M + i * (cw + gap), here = i === 2;
      s.addShape(pres.shapes.RECTANGLE, { x, y: cy, w: cw, h: ch, fill: { color: here ? C.ink : C.card }, line: { color: here ? C.ink : C.line, width: 0.75 }, shadow: shadow() });
      s.addShape(pres.shapes.RECTANGLE, { x, y: cy, w: cw, h: 0.08, fill: { color: here ? C.cyanBright : color }, line: { color: here ? C.cyanBright : color } });
      s.addText(n, { x: x + 0.15, y: cy + 0.16, w: 0.7, h: 0.3, fontFace: NF, fontSize: 15, bold: true, color: here ? C.cyanBright : color, margin: 0 });
      s.addText(name, { x: x + 0.15, y: cy + 0.44, w: cw - 0.3, h: 0.3, fontFace: HF, fontSize: 12.5, bold: true, color: here ? C.white : C.ink, margin: 0 });
      s.addText(members, { x: x + 0.15, y: cy + 0.74, w: cw - 0.3, h: 0.3, fontFace: NF, fontSize: 8, color: here ? C.dim : C.muted, margin: 0, valign: "top" });
      s.addText(desc, { x: x + 0.15, y: cy + 1.02, w: cw - 0.3, h: 0.6, fontFace: HF, fontSize: 8.5, color: here ? C.dim : C.muted, margin: 0, valign: "top" });
      s.addShape(pres.shapes.LINE, { x: x + 0.15, y: cy + 1.62, w: cw - 0.3, h: 0, line: { color: here ? "2A3A4D" : C.line, width: 0.75 } });
      s.addText([
        { text: here ? "● " : i === 3 ? "◐ " : "○ ", options: { bold: true, color: here ? C.cyanBright : i === 3 ? C.amber : C.muted } },
        { text: rel, options: { bold: true, color: here ? C.cyanBright : i === 3 ? C.amber : C.muted } },
        { text: "  " },
        { text: note, options: { color: here ? C.white : C.ink } },
      ], { x: x + 0.15, y: cy + 1.66, w: cw - 0.3, h: 0.47, fontFace: HF, fontSize: 8.5, margin: 0, valign: "top" });
    });
    // the shared recipe, with darwin's status on each step
    s.addText("四类共用一套配方，darwin 走完了前两步，后两步差着：", { x: M, y: 3.65, w: 9, h: 0.28, fontFace: HF, fontSize: 10.5, bold: true, color: C.ink, margin: 0 });
    const steps = [
      ["自己轨迹里的证据", true, "trajectory.jsonl + 反思；单会话，不跨会话聚类"],
      ["有界的编辑", true, "评分门槛、授权范围、承重决策表"],
      ["留外效用门", false, "只有回归测试和人审 diff，没有留外任务集"],
      ["评价器和权限在回路外", false, "测试和权限门在同一仓库，靠人工门控兜住"],
    ];
    const arrow = 0.28, bw = (W - 2 * M - arrow * 3) / 4, by = 3.98, bh = 0.78;
    steps.forEach(([head, ok, body], i) => {
      const x = M + i * (bw + arrow), col = ok ? C.cyan : C.amber;
      s.addShape(pres.shapes.RECTANGLE, { x, y: by, w: bw, h: bh, fill: { color: C.card }, line: { color: C.line, width: 0.75 } });
      s.addShape(pres.shapes.RECTANGLE, { x, y: by, w: 0.06, h: bh, fill: { color: col }, line: { color: col } });
      s.addText([{ text: ok ? "✓ " : "✗ ", options: { color: col, bold: true } }, { text: head, options: { bold: true, color: C.ink } }],
        { x: x + 0.16, y: by + 0.06, w: bw - 0.24, h: 0.26, fontFace: HF, fontSize: 10, margin: 0 });
      s.addText(body, { x: x + 0.16, y: by + 0.33, w: bw - 0.24, h: 0.42, fontFace: HF, fontSize: 8.5, color: C.muted, margin: 0, valign: "top" });
      if (i < steps.length - 1) s.addText("→", { x: x + bw, y: by + 0.2, w: arrow, h: 0.4, fontFace: NF, fontSize: 14, color: C.muted, align: "center", margin: 0 });
    });
    s.addText("定位：第三类里的有界、单谱系、人工门控变体——模型固定，harness 的上限就是模型的上限；缺的两步正是下一页 Harbor 要补的。",
      { x: M, y: 4.88, w: 9, h: 0.32, fontFace: HF, fontSize: 10, color: C.ink, margin: 0, italic: true });
  }

  // ==== 18b. 下一步：Harbor 作为 fitness function ==============================
  {
    const s = lightSlide("下一步：给好坏一个数字", "未来方向 · 提案草稿");
    const gap = 0.22, cw = (W - 2 * M - gap * 2) / 3, cy = 1.4, ch = 2.55;
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
    cols.forEach(([name, color, items], i) => {
      const x = M + i * (cw + gap);
      card(s, x, cy, cw, ch);
      s.addShape(pres.shapes.RECTANGLE, { x, y: cy, w: cw, h: 0.08, fill: { color }, line: { color } });
      s.addText(name, { x: x + 0.18, y: cy + 0.2, w: cw - 0.36, h: 0.35, fontFace: HF, fontSize: 13, bold: true, color: C.ink, margin: 0 });
      s.addText(items.map((t, k) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: k < items.length - 1 } })),
        { x: x + 0.18, y: cy + 0.6, w: cw - 0.36, h: ch - 0.7, fontFace: HF, fontSize: 9, color: C.ink, margin: 0, valign: "top", paraSpaceAfter: 3 });
    });
    // stage strip
    const stages = [["0", "submodule + 文档", true], ["1", "冒烟 1 + 1 题", false], ["2", "基线 n = 3", false], ["3", "接入 developer", false], ["4", "全量 → 基线", false], ["5", "轨迹反哺 fork", false]];
    const sw = (W - 2 * M - 0.12 * 5) / 6, sy = 4.12;
    stages.forEach(([n, t, done], i) => {
      const x = M + i * (sw + 0.12);
      s.addShape(pres.shapes.RECTANGLE, { x, y: sy, w: sw, h: 0.42, fill: { color: done ? C.ink : C.card }, line: { color: done ? C.ink : C.line, width: 0.75 } });
      s.addText([{ text: n + "  ", options: { fontFace: NF, bold: true, color: done ? C.cyanBright : C.cyan } }, { text: t, options: { color: done ? C.white : C.ink } }],
        { x: x + 0.1, y: sy, w: sw - 0.2, h: 0.42, fontFace: HF, fontSize: 8.5, margin: 0, valign: "middle" });
    });
    s.addText("已到阶段 0：external/harbor submodule，darwin adapter 在 fork 里，方案在 docs/architecture/harbor-benchmark-rsi.md。风险：全量 DeepSWE 一次可能上百美元、数小时；单题 pass 在 run 间波动，小子集只看趋势和严重回归；Goodhart 靠 hold-out 和“任务内容不进记忆”来防。",
      { x: M, y: 4.66, w: 9, h: 0.45, fontFace: HF, fontSize: 8.5, color: C.muted, margin: 0, valign: "top" });
  }

  // ==== 19. 结语 ==============================================================
  {
    const s = darkSlide();
    s.addText("能不能叫“自进化”？", { x: M, y: 0.55, w: 9, h: 0.6, fontFace: HF, fontSize: 28, bold: true, color: C.white, margin: 0 });
    s.addText("我倾向于保守一点。", { x: M, y: 1.15, w: 9, h: 0.4, fontFace: HF, fontSize: 14, color: C.dim, margin: 0 });
    const cols = [
      ["它能做到的", C.cyanBright, ["在明确的边界内自己找方向", "自己实现、自己验收、自己记录", "把学到的东西传给下一代", "用新版本立刻验证上一版的改动"]],
      ["仍然是人的判断", C.amber, ["方向的质量", "边界的位置", "产品取舍与安全授权"]],
    ];
    cols.forEach(([head, color, items], i) => {
      const x = M + i * 4.6;
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.7, w: 4.4, h: 1.75, fill: { color: "1B2633" }, line: { color: "2A3A4D", width: 0.75 } });
      s.addShape(pres.shapes.RECTANGLE, { x, y: 1.7, w: 0.08, h: 1.75, fill: { color }, line: { color } });
      s.addText(head, { x: x + 0.3, y: 1.82, w: 3.9, h: 0.35, fontFace: HF, fontSize: 13.5, bold: true, color, margin: 0 });
      s.addText(items.map((t, k) => ({ text: t, options: { bullet: { indent: 12 }, breakLine: k < items.length - 1 } })),
        { x: x + 0.3, y: 2.2, w: 3.9, h: 1.2, fontFace: HF, fontSize: 11, color: C.white, margin: 0, valign: "top", paraSpaceAfter: 4 });
    });
    s.addText("这个实验至少说明：在三万多行的仓库、三个星期的尺度上，这些判断之外的活是可以交出去的。三周多体验下来，大概有 10%–20% 的方向还是要我明确指引；等它自己探索，也许也能走到我想要的地方，但要花更长的时间和更多的成本。", { x: M, y: 3.55, w: 9, h: 0.6, fontFace: HF, fontSize: 11.5, color: C.white, margin: 0, valign: "top" });
    // two ways in
    s.addText("想自己接着迭代", { x: M, y: 4.22, w: 2.2, h: 0.3, fontFace: HF, fontSize: 11, color: C.dim, margin: 0, valign: "middle" });
    chip(s, "fork 这个 repo，然后  /self-evolution-research", M + 2.2, 4.2, 4.6, { bg: "1B2633" });
    s.addText("想直接用", { x: M, y: 4.62, w: 2.2, h: 0.3, fontFace: HF, fontSize: 11, color: C.dim, margin: 0, valign: "middle" });
    chip(s, "npm install -g strands-darwin", M + 2.2, 4.6, 4.6, { bg: "1B2633" });
    s.addImage({ data: await icon(FaGithub, C.dim), x: M, y: 5.08, w: 0.26, h: 0.26 });
    s.addText("github.com/xiehust/strands-darwin  ·  代码、迭代日志、研究报告、反思报告", { x: M + 0.36, y: 5.05, w: 8, h: 0.32, fontFace: NF, fontSize: 10.5, color: C.dim, margin: 0, valign: "middle" });
  }

  // ---- captions: one short paragraph per slide, in slide order ----------------
  // Single-sourced in slides/captions.cjs (shared with build-deck-portrait.cjs). Written into
  // each slide's speaker notes and into slides/wechat-captions.zh-CN.md, for publishing the deck
  // as images with a caption under each one. The English deck takes captions.en.cjs and writes
  // no captions file.
  const { CAPTIONS } = require(LANG === "en" ? "./captions.en.cjs" : "./captions.cjs");
  if (CAPTIONS.length !== pres.slides.length) {
    throw new Error(`captions (${CAPTIONS.length}) do not match slides (${pres.slides.length})`);
  }
  pres.slides.forEach((slide, i) => slide.addNotes(CAPTIONS[i]));
  if (LANG === "zh") {
    const captionsMd = [
      "# 公众号图文配文",
      "",
      "每页幻灯片配一段文字，顺序与 `self-evolution-development.zh-CN.pptx` 一致。同样的文字也写在了每页的演讲者备注里。",
      "",
      ...CAPTIONS.map((c, i) => `## 第 ${i + 1} 页\n\n${c}\n`),
    ].join("\n");
    require("node:fs").writeFileSync(path.join(__dirname, "wechat-captions.zh-CN.md"), captionsMd);
  }

  await pres.writeFile({ fileName: OUT });
  console.log("wrote", OUT);
  if (MISSING.size) {
    console.error(`untranslated strings (${MISSING.size}):`);
    for (const m of MISSING) console.error("  " + JSON.stringify(m));
    process.exitCode = 1;
  }
  if (LANG === "zh") console.log("wrote", path.join(__dirname, "wechat-captions.zh-CN.md"));
}

main().catch((e) => { console.error(e); process.exit(1); });
