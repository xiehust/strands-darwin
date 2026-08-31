/**
 * Pure presentation for `/status` — one consolidated read-only report of the live
 * session (SER-026), on the `/mcp` read-only-projection precedent.
 *
 * A formatter over state the runtime already holds, never a new information
 * channel: every field of {@link StatusFacts} comes from an existing accessor
 * (`runtime.config`, `runtime.promptCache`, `runtime.listMcpServers()`, …), this
 * module performs no I/O, no model call and no mutation, and its output is a
 * transcript notice — the live frame gains no row. The report may restate what the
 * header shows (model, mode): a scrolled-away header is exactly the use case.
 *
 * This module also owns the model-line suffix renderers the header uses
 * ({@link formatPromptCache}, {@link formatThinking}), moved here from `App.tsx`
 * so the header and `/status` cannot describe the same cache or effort state
 * differently.
 */
import type { ApprovalMode } from '../agent/permission.js';
import type { PromptCachePlan } from '../agent/prompt-cache.js';
import type { ContextEstimate, UsageTotals } from '../agent/runtime.js';
import type { ThinkingPlan } from '../agent/thinking.js';
import { formatUsageValue, sumUsage, usageBuckets } from '../agent/usage.js';
import { describeCallEfficiency, type SessionCallStats } from '../agent/call-stats.js';
import type { AppConfig } from '../config.js';
import type { McpServerStatus } from '../mcp/registry.js';
import type { TrajectoryStatus } from '../trajectory/writer.js';
import type { DiagnosticsStatus } from '../agent/diagnostics.js';
import { formatContextValue } from './context-format.js';

/**
 * Representative names shown per list (MCP servers, skills) before the report
 * says `… N more` — the `MAX_MCP_TOOL_NAMES` rule: bounded by construction,
 * never an unbounded dump into the transcript.
 */
export const MAX_STATUS_NAMES = 6;

/**
 * Everything `/status` states, as plain data. Each field names the accessor it
 * is read from so a new fact cannot arrive without an existing source.
 */
export interface StatusFacts {
  /** The live config (`runtime.config`) — moves with `/model`, unlike `info.config`. */
  config: AppConfig;
  /** `runtime.info.sessionId`. */
  sessionId: string;
  /** `runtime.info.resumed`. */
  resumed: boolean;
  /** The live cache plan (`runtime.promptCache`) — moves with `/model`. */
  promptCache: PromptCachePlan;
  /** The live thinking plan (`runtime.thinking`) — moves with `/effort`. */
  thinking: ThinkingPlan;
  /** The live mode (`runtime.permissionMode`) — moves with `/mode`. */
  mode: ApprovalMode;
  /** `runtime.allowRuleCount` — config rules plus grants accepted this session. */
  allowRuleCount: number;
  /** `runtime.listMcpServers()` — states as they are; this report connects nothing. */
  mcpServers: readonly McpServerStatus[];
  /** `runtime.info.skillNames`. */
  skillNames: readonly string[];
  /** `runtime.trajectoryStatus`; undefined when recording is off. */
  trajectory: TrajectoryStatus | undefined;
  /** `runtime.diagnosticsStatus`; undefined when the log is off (the default). */
  diagnostics: DiagnosticsStatus | undefined;
  /** `runtime.usage` — the SDK's per-process meter. */
  usage: UsageTotals;
  /**
   * `runtime.childUsage` — subagent/workflow child spend summed over the
   * dispatch registry, or undefined when no dispatch ever reported usage.
   */
  childUsage: { dispatches: number; usage: UsageTotals } | undefined;
  /**
   * `runtime.callStats` — per-model-call efficiency tallies, or undefined when
   * no completed call has been observed (which keeps the zero-call report
   * byte-identical, the childUsage convention).
   */
  callStats: SessionCallStats | undefined;
  /** True while a turn streams: the meter has not counted it yet, said out loud. */
  turnInFlight: boolean;
  /** The awaited `runtime.contextEstimate()`, or undefined when it failed. */
  context: ContextEstimate | undefined;
  /** Why the estimate is absent, when it is — degradation, never a failed report. */
  contextProblem?: string;
}

/**
 * The `/status` report: one aligned label block, transcript-history only.
 *
 * Honesty rules carried over from the reports it consolidates: unknown metrics
 * read `not reported`, never 0 (`usageBuckets`, the SER-007/SER-022 rule); token
 * scope is this run, with the resumed and in-flight caveats `/usage` states; a
 * failed MCP server is stated as failed exactly as `/mcp` states it, never
 * omitted. Exported for the free spike, like `formatMcpReport`.
 */
export function formatStatusReport(facts: StatusFacts): string {
  const rows: [string, string][] = [
    [
      'model',
      `${facts.config.provider}/${facts.config.model}` +
        `${formatPromptCache(facts.promptCache)}${formatThinking(facts.thinking)}`,
    ],
    ['session', `${facts.sessionId}${facts.resumed ? ' (resumed)' : ''}`],
    ['mode', describeMode(facts.mode, facts.allowRuleCount)],
    ['mcp', describeMcpServers(facts.mcpServers)],
    ['skills', describeNames(facts.skillNames)],
    ['trajectory', describeTrajectory(facts.trajectory)],
    ['diagnostics', describeDiagnostics(facts.diagnostics)],
    ['tokens', describeTokens(facts)],
    [
      'context',
      facts.context === undefined
        ? `unavailable — ${facts.contextProblem ?? 'no estimate'}`
        : formatContextValue(facts.context),
    ],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(([label, value]) => `  ${label.padEnd(labelWidth)}  ${value}`);
  // Child spend rides directly under the tokens row as `label: value` lines
  // rather than table rows, so today's aligned block stays byte-identical when
  // no dispatch reported usage — the additive-everywhere contract.
  if (facts.childUsage !== undefined) {
    const { dispatches, usage } = facts.childUsage;
    const tokensIndex = rows.findIndex(([label]) => label === 'tokens');
    lines.splice(
      tokensIndex + 1,
      0,
      `  usage (subagents, ${dispatches} dispatch${dispatches === 1 ? '' : 'es'}): ${describeCounters(usage, facts.config)}`,
      `  usage (session total): ${describeCounters(sumUsage([facts.usage, usage]), facts.config)}`,
    );
  }
  // Per-call efficiency rides the same additive convention, one bounded line from
  // the shared `describeCallEfficiency` renderer (the same arithmetic the /usage
  // efficiency section derives from), directly under the token block.
  if (facts.callStats !== undefined) {
    const tokensIndex = rows.findIndex(([label]) => label === 'tokens');
    lines.splice(
      tokensIndex + 1 + (facts.childUsage === undefined ? 0 : 2),
      0,
      `  model calls: ${describeCallEfficiency(facts.callStats, facts.config)}`,
    );
  }
  return ['status — this session', ...lines].join('\n');
}

/**
 * The header's own wording for the three mode states, so `/status` and the header
 * row cannot disagree about what the mode does — plus the live rule count, which
 * `/permissions` can expand.
 */
function describeMode(mode: ApprovalMode, allowRuleCount: number): string {
  if (mode === 'yolo') return 'yolo — every tool call runs without confirmation';
  if (mode === 'plan') {
    return (
      'plan — read-only; write and execute calls are denied' +
      (allowRuleCount > 0 ? ` · ${allowRuleCount} allow rule(s) ignored` : '')
    );
  }
  return `${mode}${allowRuleCount > 0 ? ` · ${allowRuleCount} allow rule(s)` : ''}`;
}

/**
 * Every server with its state on one bounded line. States use `/mcp`'s own
 * vocabulary — a failed server is *stated* as failed, never omitted — and `/mcp`
 * remains the report with per-server tool listings and config provenance.
 */
function describeMcpServers(servers: readonly McpServerStatus[]): string {
  if (servers.length === 0) return 'none configured';
  const shown = servers.slice(0, MAX_STATUS_NAMES).map((server) => {
    switch (server.state) {
      case 'connected':
        return `${server.name} connected (${describeToolCount(server.toolNames)})`;
      case 'failed':
        return `${server.name} failed — could not connect`;
      case 'disconnected':
        return `${server.name} not connected`;
    }
  });
  const remainder = servers.length - shown.length;
  const suffix = remainder > 0 ? ` … ${remainder} more` : '';
  return `${servers.length} server${servers.length === 1 ? '' : 's'} — ${shown.join(', ')}${suffix} (details: /mcp)`;
}

/** A connected server's tool count, without inventing one the SDK cannot read. */
function describeToolCount(toolNames: readonly string[] | undefined): string {
  if (toolNames === undefined) return 'tool names unavailable';
  return `${toolNames.length} tool${toolNames.length === 1 ? '' : 's'}`;
}

/** Count plus representative names, bounded like the server list. */
function describeNames(names: readonly string[]): string {
  if (names.length === 0) return 'none';
  const shown = names.slice(0, MAX_STATUS_NAMES);
  const remainder = names.length - shown.length;
  const suffix = remainder > 0 ? ` … ${remainder} more` : '';
  return `${names.length} — ${shown.join(', ')}${suffix}`;
}

/** `formatTrajectoryReport`'s states at line scale; the file is the useful fact. */
function describeTrajectory(status: TrajectoryStatus | undefined): string {
  if (status === undefined) return 'not recording (trajectory: false)';
  return `${status.active ? 'recording' : 'stopped'} — ${status.file}`;
}

/** Off is the default and stated as such; on names the file so it can be read. */
function describeDiagnostics(status: DiagnosticsStatus | undefined): string {
  if (status === undefined) return 'off';
  return `${status.active ? 'logging' : 'stopped'} — ${status.file}`;
}

/**
 * Process token spend on one line, from `usageBuckets` directly: an unreported
 * metric stays `not reported` — never 0 — whatever the provider.
 */
function describeTokens(facts: StatusFacts): string {
  const counters = describeCounters(facts.usage, facts.config);
  // "This run" is the honest scope: the SDK's meter is per-process, so a resumed
  // session's earlier spend is simply not knowable here — /usage's exact bargain.
  const scope = facts.resumed ? 'this run; earlier runs not counted' : 'this run';
  const inFlight = facts.turnInFlight ? ' (the turn in flight is not counted yet)' : '';
  return `${counters} — ${scope}${inFlight}`;
}

/**
 * The four counters of one meter, in the tokens row's own vocabulary and order —
 * shared with the child/session-total lines so the three cannot drift apart.
 */
function describeCounters(usage: UsageTotals, config: AppConfig): string {
  const buckets = usageBuckets(usage, config);
  return [
    `input ${formatUsageValue(buckets.input)}`,
    `output ${formatUsageValue(buckets.output)}`,
    `cache read ${formatUsageValue(buckets.cacheRead)}`,
    `cache write ${formatUsageValue(buckets.cacheWrite)}`,
  ].join(' · ');
}

/** Plain cache state for notices that give prompt caching its own labelled row. */
export function formatPromptCacheState(plan: PromptCachePlan): string {
  if (plan.problem !== undefined) return plan.problem;
  if (plan.automatic) return 'auto';
  return plan.enabled ? plan.parts.join(', ') : 'off';
}

/**
 * Cache state as a suffix on the model line rather than a line of its own — see the
 * comment in `Header`. Provider-managed caching is stated as automatic; truly off
 * remains empty because it is either the user's choice or reported as a warning.
 */
export function formatPromptCache(plan: PromptCachePlan): string {
  if (plan.automatic) return ' · cache auto';
  if (!plan.enabled) return '';
  const ttl = plan.ttl ?? 'on';
  // Only the anthropic provider ends up with a single part, and "cache on" there
  // would overstate what is actually being cached.
  return plan.parts.length === 1 ? ` · cache ${ttl} (${plan.parts[0]})` : ` · cache ${ttl}`;
}

/**
 * Thinking depth as a suffix on the model line — same reasoning as
 * {@link formatPromptCache}. Always shown: unlike caching there is no "off" state
 * to stay quiet about, and the level is worth knowing *before* spending a turn at
 * it. A clamped level shows what will actually happen, not what was asked for; the
 * reason is the yellow line in `Header`.
 */
export function formatThinking(plan: ThinkingPlan): string {
  if (!plan.enabled || plan.effective === undefined) return ' · no thinking';
  return ` · effort ${plan.effective}`;
}
