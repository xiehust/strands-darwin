/** Saved-session discovery is one bounded transcript notice, never a runtime switch. */
import { formatAge, readSessions, type SessionsReadModel } from '../cli-sessions.js';
import { describeHolderLocation } from '../agent/session.js';

export const MAX_SESSIONS_SCAN_ENTRIES = 200;
export const MAX_SESSIONS_ROWS = 20;
export const MAX_SESSION_CELL_POINTS = 100;

/** Every cell, including legacy IDs and holder hosts, is single-line and terminal-safe. */
export function sessionCell(value: string, limit = MAX_SESSION_CELL_POINTS): string {
  const clean = value.replace(/[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const points = [...clean];
  return points.length > limit ? `${points.slice(0, limit - 1).join('')}…` : clean;
}

/** Newest activity is only global when the scan was complete. IDs remain resume handles. */
export function formatSessionsReport(model: SessionsReadModel, now = Date.now()): string {
  const shown = model.rows.slice(0, MAX_SESSIONS_ROWS);
  const lines = [model.scanCapped
    ? 'sessions — this project · newest activity among inspected entries only'
    : 'sessions — this project · newest activity first'];
  if (shown.length === 0) {
    lines.push(model.scanCapped ? 'no resumable sessions among inspected entries' : 'no resumable sessions in this project');
  }
  for (const row of shown) {
    const id = sessionCell(row.id);
    const age = sessionCell(formatAge(now - row.activeAt));
    const prompt = sessionCell(row.firstPrompt ?? '(not recorded)');
    const last = row.isLast ? '  (last)' : '';
    const open = row.openIn === undefined ? '' : `  (open ${sessionCell(describeHolderLocation(row.openIn))})`;
    const label = row.label === undefined ? '' : `  label: ${sessionCell(JSON.stringify(row.label))}`;
    lines.push(`  ${id}  ${age}  ${prompt}${last}${open}${label}`);
  }
  if (model.skipped > 0) {
    lines.push(`${model.skipped} inspected session(s) without a restorable snapshot not listed — darwin trajectory list shows them`);
  }
  if (model.rows.length > shown.length) {
    lines.push(`… ${model.rows.length - shown.length} more inspected resumable session(s) not shown (display limit ${MAX_SESSIONS_ROWS})`);
  }
  if (model.scanCapped) {
    lines.push(`… scan limit ${MAX_SESSIONS_SCAN_ENTRIES} enumerated entries reached; additional entries not inspected (count unknown); use darwin sessions for the complete listing`);
  }
  lines.push('resume one by ID with: darwin --resume <id>');
  return lines.join('\n');
}

export async function readSessionsReport(projectRoot: string, now = Date.now()): Promise<string> {
  return formatSessionsReport(await readSessions(projectRoot, MAX_SESSIONS_SCAN_ENTRIES), now);
}
