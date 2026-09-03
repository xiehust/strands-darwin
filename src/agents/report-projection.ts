/**
 * One pure projection over a child's final report at the two seams where child
 * text becomes a parent tool result (`SubagentTool.run`, the `workflow` terminus).
 *
 * A child's report is model output the parent reads as a tool result. When that
 * text imitates darwin's own prompt framing (`<project-instructions>`,
 * `<available_skills>`, `<working-context>`, `<system-reminder>`) or a transcript
 * role line (`Human:` / `Assistant:`), the parent could mistake it for the
 * harness speaking. This module makes the imitation read as literal text — one
 * backslash inserted at the start of each such line — and prepends one bounded
 * marker line naming what matched. Permission-bypass vocabulary only earns the
 * marker; the text itself stays as written. Nothing is ever removed, reordered
 * or reworded, and a clean report is returned byte-identical, so the projected
 * string *is* the ordinary tool result: trajectory, replay, the retry guard and
 * dispatch records all see one value and no new record, notice or row exists.
 *
 * This is a report-level projection, **not a security boundary**: a tool call
 * the report leads the parent to make still goes through the permission gate,
 * and the parent model is free to read the escaped text. Idempotent
 * (`projectChildReport(projectChildReport(x)) === projectChildReport(x)`) and
 * O(n) over lines with anchored prefix checks only — no I/O, no backtracking
 * patterns. Peer evidence: Claude Code "Subagent output scanning" (v2.1.210).
 */

export type ReportPatternCategory = 'framing-tag' | 'transcript-role' | 'permission-vocabulary';

/** Fixed vocabulary, fixed order — the marker line is deterministic. */
const CATEGORY_ORDER: readonly ReportPatternCategory[] = ['framing-tag', 'transcript-role', 'permission-vocabulary'];

/** darwin's own framing tags (lower case; matched case-insensitively). */
const FRAMING_TAGS: readonly string[] = ['project-instructions', 'available_skills', 'working-context', 'system-reminder'];

/** Transcript role prefixes, exact case. */
const TRANSCRIPT_ROLES: readonly string[] = ['Human:', 'Assistant:'];

/** Permission-bypass vocabulary (lower case; matched case-insensitively anywhere). */
const PERMISSION_VOCABULARY: readonly string[] = [
  'alwaysallow',
  'permissionmode',
  '--dangerously',
  'bypasspermissions',
  'skip-permissions',
  '--yolo',
];

export const REPORT_MARKER_PREFIX = '[darwin: subagent report matched instruction-shaped pattern(s): ';
const REPORT_MARKER_SUFFIX = ']';

/**
 * Projects one child report. Returns the same string object when nothing matched.
 * Lines are split on `\n`; a trailing `\r` stays on its line, so CRLF input keeps
 * its line endings and the marker line borrows the report's own ending.
 */
export function projectChildReport(text: string): string {
  const lines = text.split('\n');
  const categories = new Set<ReportPatternCategory>();

  // A leading marker line from an earlier projection is recognized (exact
  // prefix, known categories only) and folded into this pass, so projecting
  // twice adds nothing and a marker never stacks. Anything else is report text.
  const existing = parseMarker(lines[0] ?? '');
  const bodyStart = existing === undefined ? 0 : 1;
  for (const category of existing ?? []) categories.add(category);

  let escaped = false;
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const category = lineCategory(line);
    if (category === undefined) continue;
    categories.add(category);
    const cut = leadingWhitespaceLength(line);
    lines[index] = `${line.slice(0, cut)}\\${line.slice(cut)}`;
    escaped = true;
  }

  if (mentionsPermissionVocabulary(text, bodyStart === 1 ? (lines[0]?.length ?? 0) + 1 : 0)) {
    categories.add('permission-vocabulary');
  }

  if (categories.size === 0) return text;
  if (!escaped && existing !== undefined && categories.size === existing.length) return text;

  const marker = `${REPORT_MARKER_PREFIX}${CATEGORY_ORDER.filter((c) => categories.has(c)).join(', ')}${REPORT_MARKER_SUFFIX}`;
  const eol = (lines[bodyStart] ?? '').endsWith('\r') ? '\r\n' : '\n';
  const projected = `${marker}${eol}${lines.slice(bodyStart).join('\n')}`;
  // A second pass over an already-projected report rebuilds the same bytes.
  return projected === text ? text : projected;
}

/** The category one line matches at its start, or `undefined` when it is plain text. */
function lineCategory(line: string): ReportPatternCategory | undefined {
  const rest = line.slice(leadingWhitespaceLength(line));
  if (rest.startsWith('<')) return isFramingTag(rest) ? 'framing-tag' : undefined;
  for (const role of TRANSCRIPT_ROLES) if (rest.startsWith(role)) return 'transcript-role';
  return undefined;
}

/** `<tag` or `</tag` followed by `>`, whitespace, `/` or end of line — case-insensitive. */
function isFramingTag(rest: string): boolean {
  const lower = rest.toLowerCase();
  const nameStart = lower.startsWith('</') ? 2 : 1;
  for (const tag of FRAMING_TAGS) {
    if (!lower.startsWith(tag, nameStart)) continue;
    const next = lower.charAt(nameStart + tag.length);
    if (next === '' || next === '>' || next === '/' || next === ' ' || next === '\t' || next === '\r') return true;
  }
  return false;
}

function leadingWhitespaceLength(line: string): number {
  let index = 0;
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index += 1;
  return index;
}

function mentionsPermissionVocabulary(text: string, from: number): boolean {
  const lower = text.slice(from).toLowerCase();
  return PERMISSION_VOCABULARY.some((word) => lower.includes(word));
}

/** Parses a line produced by this module; an unknown or non-canonical list means it is not ours. */
function parseMarker(line: string): ReportPatternCategory[] | undefined {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!trimmed.startsWith(REPORT_MARKER_PREFIX) || !trimmed.endsWith(REPORT_MARKER_SUFFIX)) return undefined;
  const inner = trimmed.slice(REPORT_MARKER_PREFIX.length, -REPORT_MARKER_SUFFIX.length);
  const listed = new Set(inner.split(', '));
  const canonical = CATEGORY_ORDER.filter((category) => listed.has(category));
  if (canonical.length === 0 || canonical.join(', ') !== inner) return undefined;
  return canonical;
}
