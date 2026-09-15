/**
 * Text for the workspace-trust surfaces (SER-090): the startup modal's rows and the
 * transcript notice a declined project gets. Pure functions over the resolved
 * `WorkspaceTrust` / `WorkspaceTrustReport` — no file read, no client, no runtime —
 * so the free spike can pin the exact rows the pty scenario then sees.
 *
 * The modal is bounded by construction: a fixed frame of four rows (title, intro,
 * consequence, decision) and item rows that share whatever the terminal has left, one
 * `<Text>` per row, the overflow stated as `… N more` rather than drawn off the
 * viewport. It renders before `App` exists, so it competes with nothing — but the
 * frame-budget rule that whatever is redrawn must fit the terminal applies to it as
 * to every live surface.
 */
import path from 'node:path';

import type { WorkspaceTrust, WorkspaceTrustReport } from '../agent/workspace-trust.js';
import { describeHeld, trustDecisionPath } from '../agent/workspace-trust.js';

/** Rows the modal always draws: title, intro, consequence, decision. */
export const TRUST_PROMPT_FIXED_ROWS = 4;
/** Fewest item rows the modal keeps even on a short terminal (one item, or the `… N more` row). */
export const TRUST_PROMPT_MIN_ITEM_ROWS = 1;
/** Longest item row before it is cut with an ellipsis — a shell command line can be arbitrarily long. */
export const TRUST_ROW_CODE_POINTS = 240;

export interface TrustPromptRows {
  readonly title: string;
  readonly intro: string;
  /** Inventory rows, already bounded to `maxRows - TRUST_PROMPT_FIXED_ROWS` with an `… N more` tail. */
  readonly items: readonly string[];
  /** How many inventory rows the bound cut, stated on the last item row. */
  readonly hidden: number;
  readonly consequence: string;
  readonly decision: string;
}

/** Every inventory row unbounded, in the order the modal shows them: hooks, MCP servers, rules, unreadable files. */
export function trustInventoryRows(trust: WorkspaceTrust, projectRoot: string): string[] {
  const { inventory } = trust;
  const rel = (file: string): string => displayRelative(file, projectRoot);
  const rows: string[] = [];
  for (const source of inventory.hookSources) {
    const events = Object.entries(source.eventCounts).map(([event, count]) => `${event} ×${count}`);
    rows.push(`hooks   ${rel(source.file)} (${source.dialect}${events.length === 0 ? '' : ` · ${events.join(', ')}`})`);
  }
  for (const server of inventory.mcpServers) {
    const what = server.command !== undefined
      ? [server.command, ...(server.args ?? [])].map(quoteArg).join(' ')
      : server.url ?? '(no command or url)';
    rows.push(`mcp     ${server.name} — ${what}${server.disabled === true ? ' (disabled)' : ''} (${rel(server.file)})`);
  }
  if (inventory.legacyRules !== undefined) {
    const { file, allow, deny } = inventory.legacyRules;
    rows.push(`rules   ${rel(file)} — ${allow} allow, ${deny} deny (legacy permissionRules fallback)`);
  }
  for (const problem of inventory.problems) {
    rows.push(`unreadable  ${rel(problem.file)} — ${problem.problem}`);
  }
  return rows.map(boundRow);
}

/**
 * The modal's rows for a terminal of `maxRows` rows. Item rows get what the fixed
 * frame leaves (never fewer than `TRUST_PROMPT_MIN_ITEM_ROWS`); when the inventory
 * does not fit, the last visible row is the count of what it hides.
 */
export function trustPromptRows(
  trust: WorkspaceTrust,
  projectRoot: string,
  maxRows: number,
): TrustPromptRows {
  const all = trustInventoryRows(trust, projectRoot);
  const budget = Math.max(TRUST_PROMPT_MIN_ITEM_ROWS, maxRows - TRUST_PROMPT_FIXED_ROWS);
  let items: string[];
  let hidden = 0;
  if (all.length <= budget) {
    items = all;
  } else {
    const shown = Math.max(0, budget - 1);
    hidden = all.length - shown;
    items = [...all.slice(0, shown), `… ${hidden} more (listed by /status once the session starts)`];
  }
  const problem = trust.problem === undefined ? '' : ` · ${trust.problem}`;
  return {
    title: 'trust this project?',
    intro: `${projectRoot} carries executable configuration darwin would arm now:${problem}`,
    items,
    hidden,
    consequence:
      'accept → hooks run, MCP servers spawn, legacy rules apply; decline → all of it is held back. ' +
      `remembered in ${trustDecisionPath(projectRoot)}`,
    decision: 'trust? y accept · n decline · esc decline for this session only (nothing stored)',
  };
}

/**
 * The one transcript notice a session with held layers gets: what was held and why,
 * plus how to change the answer. Undefined when nothing is held — a trusted project or
 * an empty inventory adds no line.
 */
export function formatTrustNotice(report: WorkspaceTrustReport, projectRoot: string): string | undefined {
  const held = describeHeld(report, projectRoot);
  const problem = report.problem === undefined ? '' : ` · ${report.problem}`;
  if (held === undefined) return problem === '' ? undefined : `trust:${problem}`;
  const how = report.state === 'untrusted'
    ? `delete ${trustDecisionPath(projectRoot)} and restart to be asked again`
    : 'restart darwin to be asked again';
  return `trust: ${held} — ${how}${problem}`;
}

function displayRelative(file: string, projectRoot: string): string {
  const relative = path.relative(projectRoot, file);
  const inside = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return inside ? relative : file;
}

function quoteArg(value: string): string {
  return /^[\w./:@%=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function boundRow(row: string): string {
  const points = [...row];
  return points.length <= TRUST_ROW_CODE_POINTS ? row : `${points.slice(0, TRUST_ROW_CODE_POINTS - 1).join('')}…`;
}
