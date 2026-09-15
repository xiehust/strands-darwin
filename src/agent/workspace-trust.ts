/**
 * Workspace trust for repository-supplied executable configuration (SER-090).
 *
 * A checkout can carry three things darwin would otherwise *arm at launch* with no
 * consent step: hook command files (`.darwin/hooks.json`, `.darwin/hooks/*.json`,
 * `.agents/hooks.json`, `.agents/hooks/*.json`, the `hooks` key of a committed
 * `.darwin/config.json`), MCP server definitions (`.darwin/mcp.json` or the root
 * `.mcp.json`, every stdio entry a process spawned before the first prompt) and the
 * legacy `permissionRules` fallback of a committed `.darwin/config.json`. This module
 * is the pure half of the gate: it *inventories* what the checkout would arm without
 * activating any of it, reads and writes the user-owned decision, and projects the
 * result for every driver. It spawns nothing, registers nothing and never imports the
 * runtime; the drivers (`cli-main.ts` interactive, `headless-runner.ts`, the dev REPL)
 * resolve trust here first and hand the decision to `AgentRuntime.create`, which
 * skips the held layers through `loadProjectPolicy`/`loadMcpClients` options.
 *
 * Two boundaries are load-bearing. The inventory shares one parse with activation:
 * `inventoryProjectPolicy` runs the same `loadHookLayer` the policy loads from and
 * `inventoryProjectMcpServers` the same declarative MCP reader, so a file listed here
 * is exactly a file startup would arm and there is no second grammar to drift. And
 * the decision lives in `~/.darwin/projects/<key>/trust.json` — `userProjectDir`, the
 * store every other user-owned project fact uses — so a committed file inside the
 * repository can never grant trust to itself: nothing under the project root is ever
 * read as a decision. A malformed decision file reads as "no decision" with a bounded
 * notice, never a crash and never a grant.
 *
 * User-global layers (`~/.darwin`, `~/.agents`), skills, custom commands and
 * instruction files are prompt content or user-owned and are deliberately not part
 * of the inventory: the gate is about what the *checkout* can execute or
 * pre-authorize, not about what it can say.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  inventoryProjectPolicy,
  type ProjectHookSourceInventory,
} from '../config.js';
import { inventoryProjectMcpServers, type ProjectMcpServerInventory } from '../mcp/registry.js';
import { userProjectDir } from '../paths.js';

export const TRUST_FILENAME = 'trust.json';

/** `~/.darwin/projects/<key>/trust.json` — user-owned, outside the repository. */
export function trustDecisionPath(projectRoot: string): string {
  return path.join(userProjectDir(projectRoot), TRUST_FILENAME);
}

/** The stored decision, exactly the file's shape. */
export interface TrustDecision {
  readonly trusted: boolean;
  /** ISO 8601 instant of the decision, as written by darwin. */
  readonly decidedAt: string;
}

/** Everything the checkout would arm, listed without arming any of it. */
export interface WorkspaceTrustInventory {
  readonly hookSources: readonly ProjectHookSourceInventory[];
  readonly mcpServers: readonly ProjectMcpServerInventory[];
  readonly legacyRules: { readonly file: string; readonly allow: number; readonly deny: number } | undefined;
  /**
   * Repository-supplied files the loaders could not parse, with their own message.
   * Still executable configuration the user should see: a trusted project fails
   * startup on them exactly as before (the loaders' `ConfigError`), an untrusted one
   * never reads them.
   */
  readonly problems: readonly { readonly file: string; readonly problem: string }[];
}

export type WorkspaceTrustState = 'trusted' | 'untrusted' | 'undecided';

/** The resolved gate input for one project, as the drivers hand it to the runtime. */
export interface WorkspaceTrust {
  readonly state: WorkspaceTrustState;
  readonly inventory: WorkspaceTrustInventory;
  /** Set when the stored decision file exists but could not be read as one (bounded). */
  readonly problem?: string;
}

/** Nothing to consent to: the ordinary project, which sees nothing new. */
export function inventoryIsEmpty(inventory: WorkspaceTrustInventory): boolean {
  return (
    inventory.hookSources.length === 0 &&
    inventory.mcpServers.length === 0 &&
    inventory.legacyRules === undefined &&
    inventory.problems.length === 0
  );
}

/**
 * Whether the interactive driver must ask before creating the runtime: no stored
 * decision and something to decide about. A stored answer — either one — is never
 * asked again; an empty inventory is never asked at all.
 */
export function needsTrustPrompt(trust: WorkspaceTrust): boolean {
  return trust.state === 'undecided' && !inventoryIsEmpty(trust.inventory);
}

/**
 * Whether the runtime arms the repository-supplied layers. Only an explicit
 * `trusted` answer does; `undecided` (headless, or the interactive Escape) holds them
 * exactly like a stored refusal — the layers are the risk, and "no answer yet" is not
 * consent.
 */
export function projectLayersArmed(trust: WorkspaceTrust): boolean {
  return trust.state === 'trusted';
}

/** Lists what the checkout would arm. Spawns nothing; a loader refusal becomes a `problems` row. */
export async function inventoryWorkspace(projectRoot: string): Promise<WorkspaceTrustInventory> {
  const [policy, mcp] = await Promise.all([
    inventoryProjectPolicy(projectRoot),
    inventoryProjectMcpServers(projectRoot),
  ]);
  return {
    hookSources: policy.hookSources,
    mcpServers: mcp.servers,
    legacyRules: policy.legacyRules,
    problems: [...policy.problems, ...(mcp.problem === undefined ? [] : [mcp.problem])],
  };
}

/** Longest decision-file problem the notice carries; the rest is the file's own business. */
const MAX_PROBLEM_CODE_POINTS = 200;

/**
 * Reads the stored decision. Absent → `undefined`; present but not `{ trusted:
 * boolean, decidedAt: string }` → `undefined` plus a bounded `problem`. Never throws:
 * a decision file that cannot be read is "no decision", which holds the layers back
 * and asks again — the safe direction.
 */
export async function readTrustDecision(
  projectRoot: string,
): Promise<{ decision: TrustDecision | undefined; problem?: string }> {
  const file = trustDecisionPath(projectRoot);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return { decision: undefined };
    return { decision: undefined, problem: `${file} could not be read: ${bounded(describe(error))}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { decision: undefined, problem: `${file} is not valid JSON: ${bounded(describe(error))}` };
  }
  if (
    typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)['trusted'] !== 'boolean' ||
    typeof (parsed as Record<string, unknown>)['decidedAt'] !== 'string'
  ) {
    return {
      decision: undefined,
      problem: `${file} is not a trust decision (expected { "trusted": boolean, "decidedAt": string }); treated as undecided`,
    };
  }
  const record = parsed as Record<string, unknown>;
  return { decision: { trusted: record['trusted'] as boolean, decidedAt: record['decidedAt'] as string } };
}

/** Stores the user's answer. Creates the user-owned project directory; never touches the repository. */
export async function writeTrustDecision(
  projectRoot: string,
  trusted: boolean,
  now: () => Date = () => new Date(),
): Promise<TrustDecision> {
  const decision: TrustDecision = { trusted, decidedAt: now().toISOString() };
  const file = trustDecisionPath(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
  return decision;
}

/** The inventory and the stored decision together — what every driver starts from. */
export async function resolveWorkspaceTrust(projectRoot: string): Promise<WorkspaceTrust> {
  const [inventory, stored] = await Promise.all([inventoryWorkspace(projectRoot), readTrustDecision(projectRoot)]);
  const state: WorkspaceTrustState =
    stored.decision === undefined ? 'undecided' : stored.decision.trusted ? 'trusted' : 'untrusted';
  return { state, inventory, ...(stored.problem === undefined ? {} : { problem: stored.problem }) };
}

/** A trust value with a different state and the same inventory — the interactive answer. */
export function withTrustState(trust: WorkspaceTrust, state: WorkspaceTrustState): WorkspaceTrust {
  return { ...trust, state };
}

/**
 * What the runtime reports about the decision it applied: the state and, when the
 * layers were held, exactly which ones. Plain data for `runtime.info`, `/status`,
 * `/mcp`, the transcript notice and the headless `trust:` line / `run.started.trust`.
 * Empty `held` lists for a trusted project or an empty inventory.
 */
export interface WorkspaceTrustReport {
  readonly state: WorkspaceTrustState;
  readonly heldHookFiles: readonly string[];
  readonly heldMcpServers: readonly { readonly name: string; readonly file: string }[];
  readonly heldLegacyRules: { readonly file: string; readonly allow: number; readonly deny: number } | undefined;
  /** Repository-supplied files that were unreadable and therefore also held. */
  readonly heldProblems: readonly { readonly file: string; readonly problem: string }[];
  readonly problem?: string;
}

/** Projects the decision the runtime applied; a caller that passed no decision vouches for the checkout. */
export function workspaceTrustReport(trust: WorkspaceTrust | undefined): WorkspaceTrustReport {
  if (trust === undefined || projectLayersArmed(trust)) {
    return {
      state: 'trusted',
      heldHookFiles: [],
      heldMcpServers: [],
      heldLegacyRules: undefined,
      heldProblems: [],
      ...(trust?.problem === undefined ? {} : { problem: trust.problem }),
    };
  }
  const { inventory } = trust;
  return {
    state: trust.state,
    heldHookFiles: inventory.hookSources.map((source) => source.file),
    heldMcpServers: inventory.mcpServers.map((server) => ({ name: server.name, file: server.file })),
    heldLegacyRules: inventory.legacyRules,
    heldProblems: inventory.problems,
    ...(trust.problem === undefined ? {} : { problem: trust.problem }),
  };
}

/** Anything at all held back — the condition for the transcript notice and the headless line. */
export function holdsAnything(report: WorkspaceTrustReport): boolean {
  return (
    report.heldHookFiles.length > 0 ||
    report.heldMcpServers.length > 0 ||
    report.heldLegacyRules !== undefined ||
    report.heldProblems.length > 0
  );
}

/** Held items named per list before `… N more` — the `MAX_STATUS_NAMES` rule. */
export const MAX_HELD_NAMES = 6;

/**
 * The held layers as bounded labels, project-relative: `hooks: .darwin/hooks.json`,
 * `mcp: probe (.mcp.json)`, `rules: .darwin/config.json (2 allow, 1 deny)`,
 * `unreadable: .agents/hooks.json`. One vocabulary for the transcript notice, the
 * headless `trust:` line and `run.started.trust.held`, so the three cannot disagree.
 */
export function heldLabels(report: WorkspaceTrustReport, projectRoot: string): string[] {
  const relative = (file: string): string => {
    const rel = path.relative(projectRoot, file);
    return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? file : rel;
  };
  const labels: string[] = [];
  labels.push(...bound(report.heldHookFiles.map((file) => `hooks: ${relative(file)}`)));
  labels.push(...bound(report.heldMcpServers.map((server) => `mcp: ${server.name} (${relative(server.file)})`)));
  if (report.heldLegacyRules !== undefined) {
    const { file, allow, deny } = report.heldLegacyRules;
    labels.push(`rules: ${relative(file)} (${allow} allow, ${deny} deny)`);
  }
  labels.push(...bound(report.heldProblems.map((problem) => `unreadable: ${relative(problem.file)}`)));
  return labels;
}

/** One sentence for the drivers: what was held and why, or nothing when nothing was. */
export function describeHeld(report: WorkspaceTrustReport, projectRoot: string): string | undefined {
  if (!holdsAnything(report)) return undefined;
  const why = report.state === 'untrusted'
    ? 'project not trusted'
    : 'project trust undecided';
  return `${why} — held back: ${heldLabels(report, projectRoot).join(', ')}`;
}

function bound(items: readonly string[]): string[] {
  if (items.length <= MAX_HELD_NAMES) return [...items];
  return [...items.slice(0, MAX_HELD_NAMES), `… ${items.length - MAX_HELD_NAMES} more`];
}

function bounded(text: string): string {
  const points = [...text];
  return points.length <= MAX_PROBLEM_CODE_POINTS ? text : `${points.slice(0, MAX_PROBLEM_CODE_POINTS).join('')}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
