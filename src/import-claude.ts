/** Offline, prompt-only setup migration. Never imports runtime, SDK or configuration loaders. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

import { MAX_INSTRUCTIONS_BYTES } from './agent/instructions.js';
import { extensionRoots, userDarwinDir, userProjectDir } from './paths.js';
import { IMPORT_LIMITS, ImportProblem, ImportReader, verifySnapshot, writeImport, type ImportWrite } from './import-claude-files.js';
import { manualSettings, manualMcp } from './import-claude-snippets.js';

function text(data: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
  catch { throw new ImportProblem('invalid UTF-8; manual migration required'); }
}
function prompt(data: Buffer, fallback: string, agent: boolean): { name: string; data: Buffer } {
  const raw = text(data);
  // gray-matter also supports executable JS engines. Only an exact YAML opener is accepted.
  if (!/^---\r?\n/.test(raw)) throw new ImportProblem('requires YAML frontmatter with plain --- delimiters');
  let parsed: ReturnType<typeof matter>;
  try { parsed = matter(raw); } catch { throw new ImportProblem('invalid YAML frontmatter'); }
  const allowed = agent ? ['name', 'description', 'tools'] : ['name', 'description'];
  if (Object.keys(parsed.data).some(key => !allowed.includes(key))) throw new ImportProblem('unsupported frontmatter (hooks, model, tools, permissions or other semantics); migrate manually without dropping restrictions');
  if (agent && 'tools' in parsed.data && (!Array.isArray(parsed.data['tools']) || parsed.data['tools'].length !== 0)) throw new ImportProblem('nonempty/invalid Claude tools have no safe Darwin mapping; restrictions NOT removed');
  const name: unknown = parsed.data['name'] ?? (agent ? undefined : fallback);
  const description: unknown = parsed.data['description'];
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name) || typeof description !== 'string' || !description.trim() || !parsed.content.trim()) throw new ImportProblem('requires valid name, description and nonempty body');
  if (/!`|\$ARGUMENTS|\$\d|\$\{?CLAUDE/.test(parsed.content)) throw new ImportProblem('dynamic command/argument substitution is unsupported; manual migration required');
  // JSON strings are YAML scalars; no unsupported source fields survive.
  const header = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description.trim())}\n${agent && 'tools' in parsed.data ? 'tools: []\n' : ''}---\n`;
  return { name: name.toLowerCase(), data: Buffer.from(header + parsed.content) };
}
const builtinDirectory = fileURLToPath(new URL('./skills/builtin', import.meta.url));
const marker = '<!-- darwin import claude-code:';
const safeReason = (e: unknown): string => e instanceof ImportProblem ? e.message : 'unreadable or unsafe item; manual migration required';
export interface ImportPlan {
  reader: ImportReader;
  writes: ImportWrite[];
  lines: string[];
  incomplete: boolean;
}
function line(plan: ImportPlan, source: string, target: string, result: string): void {
  plan.lines.push(`${JSON.stringify(source)} -> ${JSON.stringify(target)}: ${result}`);
}
function attempt(plan: ImportPlan, source: string, target: string, action: () => void): void {
  try { action(); } catch (e) { plan.incomplete = true; line(plan, source, target, `MANUAL: ${safeReason(e)}`); }
}
function resourceTree(reader: ImportReader, root: string, depth = 0): Map<string, Buffer> {
  if (depth > IMPORT_LIMITS.depth) throw new ImportProblem('resource depth cap (6) exceeded');
  const files = new Map<string, Buffer>();
  for (const name of reader.list(root)) {
    // Do not even open hidden policy, credentials or session stores inside resources.
    if (name.startsWith('.') || /^(?:credentials?|secrets?|sessions?|history)(?:\.|$)/i.test(name) || /\.(?:pem|key|p12)$/i.test(name)) throw new ImportProblem('hidden/sensitive resource omitted; whole skill requires manual migration');
    const file = path.join(root, name);
    if (reader.kind(file) === 'directory') {
      for (const [child, data] of resourceTree(reader, file, depth + 1)) files.set(path.join(name, child), data);
    } else {
      const data = reader.read(file);
      if (data === undefined) throw new ImportProblem('resource disappeared');
      files.set(name, data);
    }
    if (files.size > 100) throw new ImportProblem('skill resource file cap (100) exceeded');
  }
  return files;
}

function claimedNames(plan: ImportPlan, projectRoot: string, agent: boolean): Map<string, string> {
  const claimed = new Map<string, string>();
  if (agent) claimed.set('general', 'built-in general');
  else for (const name of plan.reader.list(builtinDirectory)) claimed.set(name.toLowerCase(), 'built-in skill');
  for (const layer of extensionRoots(projectRoot)) {
    const dir = path.join(layer.root, agent ? 'agents' : 'skills');
    for (const name of plan.reader.list(dir)) {
      // Reserve names even for unsupported existing content: import never shadows it.
      const file = path.join(dir, name, ...(agent ? [] : ['SKILL.md']));
      if (agent && !name.endsWith('.md')) continue;
      const raw = plan.reader.read(file);
      if (!raw) continue;
      let key = agent ? name.slice(0, -3) : name;
      // Existing loaders may accept fields this importer intentionally refuses.
      // Still reserve their declared names; never reinterpret or modify them.
      try {
        const content = text(raw);
        if (!/^---\r?\n/.test(content)) throw new ImportProblem('unsupported existing definition; cannot safely inventory names');
        const value: unknown = matter(content).data['name'];
        if (typeof value === 'string' && value.trim()) key = value.trim();
      } catch { throw new ImportProblem('existing definition names cannot be safely inventoried; no imports in this category'); }
      if (!claimed.has(key.toLowerCase())) claimed.set(key.toLowerCase(), file);
    }
  }
  return claimed;
}

function extensions(plan: ImportPlan, source: string, destination: string, claimed: Map<string, string>, agent: boolean): void {
  const { reader } = plan;
  for (const entry of reader.list(source)) {
    const from = path.join(source, entry);
    const target = path.join(destination, entry);
    attempt(plan, from, target, () => {
      if (entry.startsWith('.') || /^(?:credentials?|secrets?|sessions?|history)(?:\.|$)/i.test(entry)) throw new ImportProblem('hidden/sensitive entry omitted without reading');
      if (agent && (!entry.endsWith('.md') || reader.kind(from) !== 'file')) throw new ImportProblem('only direct Markdown agents supported; nested definitions omitted');
      const sourceFile = agent ? from : path.join(from, 'SKILL.md');
      const raw = reader.read(sourceFile);
      if (!raw) throw new ImportProblem('missing prompt file');
      const parsed = prompt(raw, entry, agent);
      const targetFile = agent ? target : path.join(target, 'SKILL.md');
      const existing = claimed.get(parsed.name);
      if (existing && existing !== targetFile) throw new ImportProblem(`name collision/reservation at ${JSON.stringify(existing)}; no precedence override`);
      const files = agent ? new Map([[entry, parsed.data]]) : resourceTree(reader, from);
      if (!agent) files.set('SKILL.md', parsed.data);
      const pending: ImportWrite[] = [];
      let present = 0;
      for (const [relative, data] of files) {
        const dest = agent ? target : path.join(target, relative);
        const before = reader.read(dest);
        if (before) {
          if (!before.equals(data)) throw new ImportProblem('destination collision; existing bytes retained');
          present++;
        } else pending.push({ source: agent ? from : path.join(from, relative), target: dest, data });
      }
      if (!agent && reader.list(target).length) {
        const tree = resourceTree(reader, target);
        if (present !== files.size || tree.size !== files.size) throw new ImportProblem('existing skill directory differs; no merge/partial repair');
      }
      // Resources first: on an I/O failure, an incomplete new skill is not discoverable.
      pending.sort((a, b) => Number(a.target.endsWith('/SKILL.md')) - Number(b.target.endsWith('/SKILL.md')));
      plan.writes.push(...pending);
      claimed.set(parsed.name, targetFile);
      line(plan, from, target, pending.length ? `COPY ${pending.length} prompt/resource file(s)${agent && !/tools: \[\]/.test(parsed.data.toString()) ? '; unrestricted source agent inherits Darwin eligible tools' : ''}` : 'ALREADY PRESENT (identical)');
    });
  }
}

function instructions(plan: ImportPlan, projectRoot: string): void {
  const target = path.join(projectRoot, 'AGENTS.md');
  attempt(plan, projectRoot, target, () => {
    const before = plan.reader.read(target);
    let combined = before ?? Buffer.alloc(0);
    const additions: Buffer[] = [];
    const proposed: { source: string; bytes: number }[] = [];
    for (const relative of ['CLAUDE.md', '.claude/CLAUDE.md']) {
      const source = path.join(projectRoot, relative);
      const raw = plan.reader.read(source);
      if (!raw) continue;
      const body = text(raw);
      if (body.includes(marker)) throw new ImportProblem('source contains reserved import marker');
      const start = `${marker}${relative} -->`;
      const section = Buffer.from(`\n\n${start}\n## Imported from ${relative}\n\nLiteral prompt content; @ imports are not expanded.\n\n${body}\n<!-- end darwin import claude-code:${relative} -->\n`);
      if (combined.includes(section)) { line(plan, source, target, 'ALREADY PRESENT (identical section)'); continue; }
      if (combined.includes(start)) throw new ImportProblem('existing import section differs; review and merge manually');
      if (body.trim() && combined.includes(raw)) { line(plan, source, target, 'ALREADY PRESENT (literal body; no section added)'); continue; }
      combined = Buffer.concat([combined, section]);
      if (combined.length > MAX_INSTRUCTIONS_BYTES) throw new ImportProblem('AGENTS.md would exceed 32768-byte instruction cap; nothing appended');
      additions.push(section);
      proposed.push({ source, bytes: section.length });
    }
    for (const item of proposed) line(plan, item.source, target, `APPEND marked section (${item.bytes} bytes)`);
    if (additions.length) plan.writes.push({ source: projectRoot, target, data: Buffer.concat(additions), ...(before === undefined ? {} : { before }) });
  });
}

export function scanClaudeImport(projectRoot: string): ImportPlan {
  const plan: ImportPlan = { reader: new ImportReader(), writes: [], lines: [], incomplete: false };
  plan.lines.push('Claude Code setup migration: read-only plan; --apply writes prompt content ONLY.',
    'No model/network/hooks/tools/session startup. No history, chats, credentials, trust or executable configuration imported.',
    'Bounds: 400 entries (+ one overflow probe); 262144 bytes/file; 4194304 bytes per scan pass; skill depth 6 and 100 files; 100 MCP entries / rules per array; output 32768 bytes.',
    'Precedence unchanged: built-ins, project .darwin, project .agents, global .darwin, global .agents. Existing names are not shadowed.',
    'CLAUDE.md fallback remains supported when AGENTS.md is absent. @ imports stay literal, never expanded.',
    'Omitted without scanning: ~/.claude.json (mixed credentials/project state, including user MCP), sessions/history, plugins, commands, rules, managed/nested/additional-directory setup.',
    'Linux descriptor-safe file access only; other hosts require manual migration. Do not edit setup concurrently with apply.');
  const layers = extensionRoots(projectRoot).filter(layer => layer.kind === 'darwin');
  for (const agent of [false, true]) {
    attempt(plan, 'existing Darwin layers', agent ? 'agents' : 'skills', () => {
      const claimed = claimedNames(plan, projectRoot, agent);
      for (const layer of layers) {
        const source = path.join(path.dirname(layer.root), '.claude', agent ? 'agents' : 'skills');
        const target = path.join(layer.root, agent ? 'agents' : 'skills');
        attempt(plan, source, target, () => extensions(plan, source, target, claimed, agent));
      }
    });
  }
  instructions(plan, projectRoot);
  const globalClaude = path.join(path.dirname(userDarwinDir()), '.claude');
  const globalInstructions = path.join(globalClaude, 'CLAUDE.md');
  attempt(plan, globalInstructions, 'no global AGENTS.md loader', () => {
    if (plan.reader.read(globalInstructions)) line(plan, globalInstructions, 'no equivalent global instruction layer', 'MANUAL: not copied into project scope');
  });
  for (const source of [path.join(globalClaude, 'settings.json'), path.join(projectRoot, '.claude/settings.json'), path.join(projectRoot, '.claude/settings.local.json')]) {
    const target = path.join(userProjectDir(projectRoot), 'permission-rules.json');
    attempt(plan, source, target, () => {
      const data = plan.reader.read(source);
      if (data) for (const report of manualSettings(text(data))) line(plan, source, target, report);
    });
  }
  const mcpSource = path.join(projectRoot, '.mcp.json');
  const mcpTarget = path.join(layers[0]!.root, 'mcp.json');
  attempt(plan, mcpSource, mcpTarget, () => {
    const data = plan.reader.read(mcpSource);
    if (data) for (const report of manualMcp(text(data))) line(plan, mcpSource, mcpTarget, report);
  });
  plan.lines.push('Manual snippets are candidates, NOT a complete policy conversion. Merge only after reviewing omissions, restrictions and scope; never replace existing deny rules. Global permissions have no global Darwin rule store.',
    'Hooks are never converted or printed as commands. MCP snippets do not convey approval; root .mcp.json fallback and workspace trust remain unchanged. No config or trust file is written.');
  return plan;
}

export function formatImportPlan(plan: ImportPlan): string {
  const tail = `\n${plan.writes.length} planned file write(s); ${plan.incomplete ? 'some items require manual migration' : 'scan complete within stated scope'}.\n`;
  const lines: string[] = [];
  // Reserve room for the apply result, including one absolute failure path.
  let size = Buffer.byteLength(tail) + 8192;
  for (const raw of plan.lines) {
    const value = raw.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const n = Buffer.byteLength(value) + 1;
    if (size + n > IMPORT_LIMITS.outputBytes) {
      plan.incomplete = true;
      lines.push('OUTPUT CAP: remaining plan/snippets omitted; apply refused because the complete plan cannot be displayed.');
      break;
    }
    lines.push(value);
    size += n;
  }
  return lines.join('\n') + tail;
}

export function applyClaudeImport(plan: ImportPlan): { text: string; failed: boolean } {
  if (formatImportPlan(plan).includes('OUTPUT CAP:')) return { text: 'Apply refused: output cap; no writes.\n', failed: true };
  try { verifySnapshot(plan.reader); }
  catch (e) { return { text: `Apply refused before writes: ${safeReason(e)}.\n`, failed: true }; }
  let completed = 0;
  for (const item of plan.writes) {
    try { writeImport(item); completed++; }
    catch (e) {
      return { text: `Apply stopped at ${JSON.stringify(item.target)} after ${completed} completed file write(s): ${safeReason(e)}. Earlier writes and possibly partial current file/created directories remain; inspect before retry. No rollback or overwrite attempted.\n`, failed: true };
    }
  }
  return { text: `Applied ${completed} prompt/resource file write(s). Manual items/snippets were NOT applied. Source files unchanged.\n`, failed: false };
}
