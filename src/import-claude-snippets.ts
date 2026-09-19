/** Closed, deliberately small manual-only mappings; never evaluates or interpolates values. */
import { isValidRule } from './agent/permission-rules.js';
import { ImportProblem } from './import-claude-files.js';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parse(raw: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(raw); if (record(value)) return value; } catch { /* no source values in errors */ }
  throw new ImportProblem('invalid JSON object; values omitted');
}
const sensitive = /secret|token|password|credential|authorization|api.?key|private.?key|bearer|sk-[A-Za-z0-9]|AKIA/i;

export function manualSettings(raw: string): string[] {
  const settings = parse(raw);
  const lines = ['MANUAL settings: only permission candidates below; all other settings omitted (including hook commands, trust, env, model and tool policy).'];
  if ('hooks' in settings) lines.push('MANUAL hooks present: no command values printed, no safe automatic dialect conversion; review Darwin hooks separately.');
  if (!('permissions' in settings)) return lines;
  if (!record(settings['permissions'])) return [...lines, 'MANUAL invalid permissions; values omitted.'];
  const permissions = settings['permissions'];
  const mapped: Record<'allow' | 'deny', string[]> = { allow: [], deny: [] };
  let omitted = 0;
  for (const kind of ['allow', 'deny'] as const) {
    const rules = permissions[kind];
    if (rules === undefined) continue;
    if (!Array.isArray(rules)) { omitted++; continue; }
    if (rules.length > 100) lines.push(`MANUAL ${kind} rule cap (100): remaining entries omitted.`);
    for (const rule of rules.slice(0, 100)) {
      // Only whole Bash and exact, fixed public commands. No path/tool-name guesses,
      // Claude prefix syntax, arbitrary arguments or credential-bearing values.
      let candidate: string | undefined;
      if (rule === 'Bash' || rule === 'Bash(*)') candidate = 'bash';
      if (typeof rule === 'string') {
        const match = /^Bash\((git status|git diff|git log|pnpm test|pnpm typecheck|npm test)\)$/.exec(rule);
        if (match) candidate = `bash:${match[1]}`;
      }
      if (candidate && isValidRule(candidate)) mapped[kind].push(candidate);
      else omitted++;
    }
  }
  omitted += Object.keys(permissions).filter(key => key !== 'allow' && key !== 'deny').length;
  if (omitted) lines.push(`MANUAL ${omitted} unsupported/sensitive permission entries or fields omitted; inspect original locally, especially ask/deny restrictions. No redacted executable rules generated.`);
  if (mapped.allow.length || mapped.deny.length) lines.push(`REVIEW JSON (merge arrays, not a replacement policy; Bash lifecycle/deny semantics differ):\n${JSON.stringify(mapped, null, 2)}`);
  return lines;
}

export function manualMcp(raw: string): string[] {
  const config = parse(raw);
  if (!record(config['mcpServers'])) throw new ImportProblem('requires mcpServers object; values omitted');
  const lines: string[] = [];
  let index = 0;
  for (const [name, value] of Object.entries(config['mcpServers'])) {
    if (index >= 100) { lines.push('MANUAL MCP entry cap (100): remaining entries omitted.'); break; }
    index++;
    let entry: Record<string, unknown> | undefined;
    if (/^[A-Za-z0-9_-]{1,64}$/.test(name) && record(value) && !sensitive.test(JSON.stringify([name, value]))) {
      const keys = Object.keys(value);
      if (keys.every(key => ['type', 'command', 'args'].includes(key)) && (value['type'] === undefined || value['type'] === 'stdio') && typeof value['command'] === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value['command'])) {
        const args = value['args'];
        // Arguments can hide credentials anywhere: only the conventional npx package
        // launcher has a closed non-secret-bearing argument shape here.
        if (args === undefined || (Array.isArray(args) && args.length === 0)) entry = { command: value['command'], args: [] };
        else if (value['command'] === 'npx' && Array.isArray(args) && args.length === 2 && args[0] === '-y' && typeof args[1] === 'string' && /^@[a-z0-9-]+\/[a-z0-9-]+$/.test(args[1])) entry = { command: 'npx', args };
      }
      if (keys.every(key => ['type', 'url'].includes(key)) && ['http', 'streamable-http', 'sse'].includes(String(value['type'])) && typeof value['url'] === 'string') {
        try {
          const url = new URL(value['url']);
          if (/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:\/(?:mcp|sse)?)?$/.test(value['url']) && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && ['/', '/mcp', '/sse'].includes(url.pathname)) entry = { transport: value['type'] === 'sse' ? 'sse' : 'streamable-http', url: value['url'] };
        } catch { /* omitted */ }
      }
    }
    if (entry) lines.push(`REVIEW JSON (not enabled; merge server key only after reviewing source settings/disabled lists and trust):\n${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}`);
    else lines.push(`MANUAL MCP entry ${index} omitted: sensitive-bearing or unsupported shape (including env/headers/auth, arbitrary args/URL paths, interpolation or policy fields). Inspect/copy locally after review; no redacted runnable config generated.`);
  }
  if (!index) lines.push('No MCP entries.');
  return lines;
}
