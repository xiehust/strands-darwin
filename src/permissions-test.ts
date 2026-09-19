/** SER-096: read-only matcher projection over recorded calls, never a permission gate. */
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { matchesAnyDenyRule, matchesAnyRule, parseRule } from './agent/permission-rules.js';
import { userProjectDir, userProjectSessionsDir } from './paths.js';
import { describeDamage, readTrajectory } from './trajectory/reader.js';

export const MAX_TEST_RULE_CHARS = 2_000;
export const MAX_TEST_SESSIONS = 20;
export const MAX_TEST_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TEST_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_TEST_ROWS = 20;
export const MAX_TEST_CELL_CHARS = 240;

/** Escape controls rather than deleting them: display never becomes the matcher input. */
export function testCell(value: unknown): string {
  const text = JSON.stringify(value) ?? '(unavailable)';
  const safe = text.replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const points = [...safe];
  return points.length <= MAX_TEST_CELL_CHARS ? safe : `${points.slice(0, MAX_TEST_CELL_CHARS).join('')}… [display clipped]`;
}

export function candidateProblem(rule: string): string | undefined {
  if ([...rule].length > MAX_TEST_RULE_CHARS) return `candidate exceeds ${MAX_TEST_RULE_CHARS} code points`;
  return parseRule(rule) === undefined ? 'expected <tool> or <tool>:<pattern>' : undefined;
}

export interface PermissionTestOptions {
  projectRoot: string;
  /** Omitted only for the project-scoped CLI observer. Never a path from the caller. */
  sessionId?: string;
  /** TUI captures the live deny list, not a reloaded policy. Undefined = CLI file policy. */
  denyRules?: readonly string[];
  recording?: 'active' | 'disabled' | 'stopped';
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Conservative: placeholders and the writer's reasoning/depth removal cannot prove exactness. */
function lossy(value: unknown, depth = 0): boolean {
  if (depth > 16) return true;
  if (typeof value === 'string') return /redact|\[depth-limited\]/iu.test(value);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, entry]) =>
    /redact|reasoning/iu.test(key) || lossy(entry, depth + 1));
}

/** Refuse symlink escapes rather than following another project's evidence. */
async function localSize(file: string): Promise<number> {
  if (await realpath(file) !== path.resolve(file)) throw new Error('symlink');
  const info = await stat(file);
  if (!info.isFile()) throw new Error('not a file');
  return info.size;
}

/** Only the user-owned project rules file; no config, hooks, trust, or SDK loader. */
async function readDenies(projectRoot: string): Promise<{ rules?: readonly string[]; notice: string }> {
  const file = path.join(userProjectDir(projectRoot), 'permission-rules.json');
  try {
    if (await localSize(file) > 256 * 1024) return { notice: 'deny policy unavailable: file exceeds 256 KiB' };
    const record = object(JSON.parse(await readFile(file, 'utf8')));
    if (record === undefined) return { notice: 'deny policy unavailable: damaged rules file' };
    const deny = record['deny'] === undefined ? [] : record['deny'];
    if (!Array.isArray(deny) || deny.some(rule => typeof rule !== 'string' || parseRule(rule) === undefined)) {
      return { notice: 'deny policy unavailable: invalid deny rules' };
    }
    return { rules: deny, notice: `deny policy: current project permission-rules.json (${deny.length} deny rules); legacy config not consulted` };
  } catch (error) {
    return { notice: (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'deny policy unavailable: project permission-rules.json missing; legacy config not consulted'
      : 'deny policy unavailable: unreadable, damaged, or symlinked project rules file' };
  }
}

async function evidenceIds(options: PermissionTestOptions): Promise<{ ids: string[]; notice?: string }> {
  if (options.sessionId !== undefined) {
    return /^[a-z0-9_-]{1,128}$/.test(options.sessionId)
      ? { ids: [options.sessionId] } : { ids: [], notice: 'invalid session id; no evidence read' };
  }
  const root = userProjectSessionsDir(options.projectRoot);
  try {
    if (await realpath(root) !== path.resolve(root)) return { ids: [], notice: 'symlinked project store not read' };
    const entries = await readdir(root, { withFileTypes: true });
    const ids = entries.filter(entry => entry.isDirectory() && entry.name !== 'session' && /^[a-z0-9_-]{1,128}$/.test(entry.name))
      .map(entry => entry.name).sort().reverse();
    const omitted = entries.length - ids.length + Math.max(0, ids.length - MAX_TEST_SESSIONS);
    return { ids: ids.slice(0, MAX_TEST_SESSIONS), ...(omitted === 0 ? {} : { notice: `${omitted} store entries omitted (non-trajectory directories, symlinks, invalid ids, or session cap)` }) };
  } catch {
    return { ids: [], notice: 'project trajectory store missing or unreadable' };
  }
}

export async function permissionTestReport(rule: string, options: PermissionTestOptions): Promise<string> {
  const problem = candidateProblem(rule);
  if (problem !== undefined) return `permissions test: parse invalid — ${problem}`;
  const parsed = parseRule(rule)!;
  const scope = options.sessionId === undefined ? 'current project; trajectory directories only, reverse-lexical session ids'
    : `current interactive session ${testCell(options.sessionId)} only`;
  const lines = [
    `permissions test: parse valid · tool ${testCell(parsed.toolName)} · pattern ${parsed.pattern === undefined ? '(whole tool)' : testCell(parsed.pattern)}`,
    `scope: ${scope} · project ${testCell(options.projectRoot)}`,
    'Matcher results only; not execution approval. Safe/plan/yolo, hooks and other gate policy are not simulated.',
    'Evidence: persisted recorded pairs only; buffered/live calls, unrecorded/disabled periods and child inputs may be absent. No complete-history claim.',
  ];
  const policy = options.denyRules === undefined ? await readDenies(options.projectRoot)
    : { rules: options.denyRules, notice: `deny policy: current session snapshot (${options.denyRules.length} deny rules)` };
  lines.push(policy.notice);
  if (options.recording !== undefined) lines.push(`recording: ${options.recording}; no flush or live transcript read`);
  const found = await evidenceIds(options);
  if (found.notice !== undefined) lines.push(`omission: ${found.notice}`);
  let bytes = 0;
  let exact = 0;
  let matched = 0;
  let beaten = 0;
  let unknown = 0;
  let hidden = 0;
  const rows: string[] = [];
  const notices = new Set<string>();
  for (const id of found.ids) {
    const file = path.join(userProjectSessionsDir(options.projectRoot), id, 'trajectory.jsonl');
    try {
      const size = await localSize(file);
      if (size > MAX_TEST_FILE_BYTES || bytes + size > MAX_TEST_TOTAL_BYTES) {
        notices.add('files omitted: per-file 2 MiB or total 8 MiB read budget exceeded');
        continue;
      }
      const read = await readTrajectory(file, Math.min(MAX_TEST_FILE_BYTES, MAX_TEST_TOTAL_BYTES - bytes));
      bytes += read.bytes;
      const damage = describeDamage(read);
      if (damage !== undefined) notices.add(`damaged evidence: ${damage}`);
      const seen = new Set<string>();
      const paired = new Set<string>();
      const decisions = new Set<string>();
      let previous = 0;
      for (const record of read.records) {
        if (!Number.isSafeInteger(record.seq) || record.seq !== previous + 1) notices.add('sequence gaps/invalid ordering: evidence may be missing');
        previous = record.seq;
        if (record.type === 'recordingStopped') notices.add('recording stopped: later calls unavailable');
        if (record.type === 'permissionDecision') decisions.add(`${record.turn}:${record.toolUseId}`);
        const raw = record as unknown as Record<string, unknown>;
        if (raw['dropped'] === 'record-too-large') { unknown += 1; continue; }
        const data = object(raw['data']);
        const block = object(data?.['contentBlock']);
        // The before-event wraps ToolUseBlock.toJSON(), which itself wraps toolUse.
        const use = record.type === 'beforeToolCallEvent' ? object(object(data?.['toolUse'])?.['toolUse'])
          : record.type === 'contentBlockEvent' ? object(block?.['toolUse']) : undefined;
        if (use === undefined) {
          if (record.type === 'beforeToolCallEvent' || (record.type === 'contentBlockEvent' &&
            (block === undefined || Object.hasOwn(block, 'toolUse')))) unknown += 1;
          continue;
        }
        const callKey = `${record.turn}:${use['toolUseId']}`;
        paired.add(callKey);
        if ((raw['trunc'] !== undefined && (!Array.isArray(raw['trunc']) || raw['trunc'].length > 0)) ||
          [raw, data, block, use].some(part => Object.keys(part ?? {}).some(key => /redact/iu.test(key))) ||
          lossy(use['input']) || lossy(use['name']) || typeof use['name'] !== 'string' ||
          use['name'] === '' || !Object.hasOwn(use, 'input')) {
          unknown += 1;
          continue;
        }
        const target = { toolName: use['name'], input: use['input'] };
        const key = JSON.stringify(target);
        if (seen.has(key)) continue;
        seen.add(key);
        exact += 1;
        const allow = matchesAnyRule([rule], target, options.projectRoot) !== undefined;
        const deny = policy.rules === undefined ? undefined : matchesAnyDenyRule(policy.rules, target, options.projectRoot);
        if (allow) matched += 1;
        if (allow && deny !== undefined) beaten += 1;
        if (rows.length >= MAX_TEST_ROWS) { hidden += 1; continue; }
        rows.push(`${testCell(id)} seq ${record.seq} · ${testCell(target.toolName)} ${testCell(target.input)} · allow ${allow ? 'match' : 'no match'} · ${policy.rules === undefined ? 'deny unknown' : deny === undefined ? 'deny no match' : `${allow ? 'deny beats candidate allow' : 'deny matches (candidate does not)'} ${testCell(deny)}`}`);
      }
      if ([...decisions].some(key => !paired.has(key))) notices.add('permission decisions without recorded input (including children): exact pairs unavailable');
    } catch {
      notices.add('trajectory missing, unreadable, damaged, or symlinked: exact pairs unavailable');
    }
  }
  lines.push(...rows);
  lines.push(`Recorded distinct pairs per session: ${exact} exact; candidate matches ${matched}; deny beats ${policy.rules === undefined ? 'unknown' : beaten}; ${unknown} lossy/invalid records not evaluated.`);
  if (unknown > 0) notices.add('truncated, redacted/placeholder, dropped or malformed input: match and no-match are unknown; original input is never recovered');
  if (exact === 0) notices.add('no exact recorded pairs available; not proof of no matching calls');
  if (hidden > 0) notices.add(`${hidden} evaluated pairs not displayed (row cap ${MAX_TEST_ROWS})`);
  // Damage counts can differ per file; even diagnostics have a fixed output budget.
  lines.push(...[...notices].slice(0, 8).map(notice => `omission: ${notice}`));
  if (notices.size > 8) lines.push(`omission: ${notices.size - 8} further evidence notices not displayed`);
  lines.push(`limits: ${MAX_TEST_SESSIONS} sessions, 2 MiB/file, 8 MiB total; ${MAX_TEST_ROWS} pair rows; ${MAX_TEST_CELL_CHARS} code points/cell (clipping is display-only).`);
  return lines.join('\n');
}
