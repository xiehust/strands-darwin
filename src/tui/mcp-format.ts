import type { McpServerStatus } from '../mcp/registry.js';

/**
 * Tool names shown per server before the report says `… N more`. MCP tool
 * listings can be large — OpenCode warns about exactly this cost — so the report
 * is bounded by construction, never an unbounded dump.
 */
export const MAX_MCP_TOOL_NAMES = 8;

/** The config provenance the report states alongside the servers. */
export interface McpConfigSources {
  /** Every contributing config path, global first and project second. */
  configPaths: readonly string[];
  /** Server names whose global entry was replaced by the project layer. */
  overriddenServerNames: readonly string[];
  /** Root `.mcp.json` left unread because `.darwin/mcp.json` took precedence. */
  ignoredConfigPath: string | undefined;
  /** Every file darwin looked for, named when nothing is configured. */
  candidatePaths: readonly string[];
}

/**
 * The `/mcp` report: every configured server with its connection state and a
 * bounded list of registered tool names, then the config source(s) in effect.
 *
 * Pure text over an already-taken projection — this function reads no client and
 * so cannot connect one. A failed server is stated as failed and contributing no
 * tools, never omitted: silently missing tools are the problem this report
 * exists to answer. Exported for the free spike, like `formatUsageReport`.
 */
export function formatMcpReport(
  servers: readonly McpServerStatus[],
  sources: McpConfigSources,
): string {
  if (servers.length === 0) {
    const looked =
      sources.configPaths.length > 0
        ? `config read: ${sources.configPaths.join(', ')} — it defines no enabled servers`
        : `looked for ${sources.candidatePaths.join(', ')}`;
    return `no MCP servers configured\n  ${looked}`;
  }

  const nameWidth = Math.max(...servers.map((server) => server.name.length));
  const rows = servers.map(
    (server) => `  ${server.name.padEnd(nameWidth)}  ${describeServer(server)}`,
  );
  return [`mcp servers (${servers.length})`, ...rows, ...sourceLines(sources)].join('\n');
}

/** One server's state and bounded tool listing, on the row its name labels. */
function describeServer(server: McpServerStatus): string {
  switch (server.state) {
    case 'connected':
      return `connected · ${describeTools(server.toolNames)}`;
    case 'failed':
      // continueOnError swallowed the connection failure at startup; the SDK said
      // so once at log level and the server has contributed zero tools since.
      return 'failed — could not connect; contributing no tools (restart darwin to retry)';
    case 'disconnected':
      // Never connected (or already disconnected). Stated honestly rather than
      // connecting to count tools: reading state must not mutate state.
      return 'not connected — tools unknown (no connection attempted by this report)';
  }
}

/** Registered tool names, capped with an explicit remainder — or their absence. */
function describeTools(toolNames: readonly string[] | undefined): string {
  if (toolNames === undefined) return 'tool names unavailable in this SDK build';
  if (toolNames.length === 0) return 'no tools';
  const shown = toolNames.slice(0, MAX_MCP_TOOL_NAMES);
  const remainder = toolNames.length - shown.length;
  const suffix = remainder > 0 ? ` … ${remainder} more` : '';
  return `${toolNames.length} tool${toolNames.length === 1 ? '' : 's'}: ${shown.join(', ')}${suffix}`;
}

/** Which file(s) produced this server list, and which were overridden or ignored. */
function sourceLines(sources: McpConfigSources): string[] {
  const labels = sources.configPaths.map((configPath, index, all) => {
    const label = all.length === 2 ? (index === 0 ? ' (global)' : ' (project)') : '';
    return `  config: ${configPath}${label}`;
  });
  const overrides =
    sources.overriddenServerNames.length > 0
      ? [`  project config overrides global for: ${sources.overriddenServerNames.join(', ')}`]
      : [];
  const ignored =
    sources.ignoredConfigPath === undefined
      ? []
      : [`  ignored: ${sources.ignoredConfigPath} — .darwin/mcp.json takes precedence`];
  return [...labels, ...overrides, ...ignored];
}
