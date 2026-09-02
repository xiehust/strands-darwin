/**
 * MCP server discovery from `.darwin/mcp.json`, or a project-root `.mcp.json`.
 *
 * This module is deliberately thin. The design anticipated hand-rolling transport
 * construction, but the SDK already covers all of it via
 * `McpClient.loadServers()`:
 *
 * - reads Claude Code's `.mcp.json` shape directly — its loader does
 *   `parsed.mcpServers ?? parsed`, so both the wrapped and bare forms work
 * - picks the transport from the fields present (`command` → stdio,
 *   `url` → streamable-http) and honours an explicit `transport`, including `sse`
 * - interpolates `${VAR}` / `${env:VAR}` in commands, args, env, urls and headers
 * - supports `disabled`, `prefix` and `toolFilters` per server
 *
 * So the things left for us are: treating a missing file as "no MCP", turning
 * per-server failures into warnings instead of a failed startup, and defaulting
 * each server's `prefix` to `<name>_` so tool names stay unique across servers
 * (see {@link withDefaultPrefixes}).
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { McpClient } from '@strands-agents/sdk';
import type { McpConnectionState, McpServerConfig } from '@strands-agents/sdk';

import { ConfigError } from '../config.js';
import { darwinDir, userDarwinDir } from '../paths.js';

/** Preferred location, alongside the rest of darwin's project state. */
export const MCP_CONFIG_FILENAME = 'mcp.json';

/**
 * Fallback in the project root: Claude Code's own file, in the same format, so an
 * existing one works without being copied or moved.
 */
export const ROOT_MCP_CONFIG_FILENAME = '.mcp.json';

export interface McpLoadResult {
  clients: McpClient[];
  /** Every contributing config path, global first and project second. */
  configPaths: string[];
  /** Server names whose global entry was replaced by the project layer. */
  overriddenServerNames: string[];
  /** Preferred display path, retained for compatibility. */
  configPath: string | undefined;
  /**
   * A root `.mcp.json` that exists but was not read because `.darwin/mcp.json`
   * took precedence. Surfaced so the header can say the fallback is inert rather
   * than leaving the user to wonder which file is in effect.
   */
  ignoredConfigPath: string | undefined;
}

/**
 * One configured server as `/mcp` reports it: name, state, and registered tool
 * names — never tool results, server output, or anything else that could turn the
 * report into a second path for server content into the conversation.
 */
export interface McpServerStatus {
  /** The config entry's server name (the SDK's `clientName` / `applicationName`). */
  name: string;
  state: McpConnectionState;
  /**
   * Agent-facing names of the tools the SDK registered from this server, sorted,
   * or undefined when they cannot be read (see {@link mcpServerStatuses}). Empty
   * for a server that failed to connect or exposed nothing.
   */
  toolNames: readonly string[] | undefined;
}

/**
 * A read-only projection of the live clients for the `/mcp` report.
 *
 * Reading state must not mutate state, and `listTools()` connects lazily — so it
 * is never called here. Tool names come from the client's `_registeredToolNames`,
 * the set the SDK itself populated when `agent.initialize()` listed and registered
 * this server's tools. That is a private field, read on the same narrow terms as
 * `_transport._serverParams` in {@link loadServersQuietly}: guarded so an SDK that
 * stops exposing it degrades to `toolNames: undefined` (stated as unavailable by
 * the formatter), never to a crash — and never to a connection attempt.
 */
export function mcpServerStatuses(clients: readonly McpClient[]): McpServerStatus[] {
  return clients.map((client) => {
    const registered = (client as unknown as { _registeredToolNames?: unknown })._registeredToolNames;
    const toolNames =
      registered instanceof Set && [...registered].every((name) => typeof name === 'string')
        ? [...(registered as Set<string>)].sort((a, b) => a.localeCompare(b))
        : undefined;
    return { name: client.clientName, state: client.connectionState, toolNames };
  });
}

/**
 * Every file `loadMcpClients` considers, in read order: the global config, the
 * preferred project config, and the project-root fallback. Exported so the `/mcp`
 * report can name where darwin looked when nothing is configured, from the same
 * derivation the loader uses rather than a second copy of it.
 */
export function mcpConfigCandidates(projectRoot: string): {
  global: string;
  preferred: string;
  fallback: string;
} {
  return {
    global: path.join(userDarwinDir(), MCP_CONFIG_FILENAME),
    preferred: path.join(darwinDir(projectRoot), MCP_CONFIG_FILENAME),
    fallback: path.join(projectRoot, ROOT_MCP_CONFIG_FILENAME),
  };
}

/**
 * Loads every enabled MCP server declared in `<projectRoot>/.darwin/mcp.json`,
 * falling back to `<projectRoot>/.mcp.json` when the first does not exist.
 *
 * Only one of the two is ever read: merging them would make the effective server
 * list depend on two files at once, and a user who wrote `.darwin/mcp.json`
 * expects that to be the answer.
 *
 * Returns an empty list when neither file is present — running without MCP is a
 * normal configuration, not an error.
 *
 * `continueOnError` is set for every server so one broken entry cannot stop the
 * agent from starting: a server that fails to spawn or connect is logged by the
 * SDK and its `listTools()` yields an empty list, leaving the rest working.
 *
 * An unreadable or malformed file is different from a server that will not start,
 * and is raised as a {@link ConfigError}: the user wrote a config that cannot be
 * understood at all, and silently continuing without their MCP servers would hide
 * a typo behind missing tools.
 */
export async function loadMcpClients(
  projectRoot: string,
  options: { quietStdioStderr?: boolean } = {},
): Promise<McpLoadResult> {
  const { servers, ...sources } = await readMcpServerConfigs(projectRoot);
  if (servers === undefined) return { clients: [], ...sources };

  const prefixed = withDefaultPrefixes(servers);
  const clients = options.quietStdioStderr === true
    ? await loadServersQuietly(prefixed)
    : await McpClient.loadServers(prefixed, { continueOnError: true });
  return { clients, ...sources };
}

/** The declarative half of {@link loadMcpClients}: which files were read, and what they declare. */
export interface McpServerConfigs extends Omit<McpLoadResult, 'clients'> {
  /**
   * Every declared server, project layer over global, exactly as written (no default
   * prefix, no `${VAR}` interpolation — the SDK does both at connect time). `undefined`
   * when no config file exists at all, which is the ordinary "no MCP" answer.
   */
  servers: Record<string, McpServerConfig> | undefined;
}

/**
 * Reads and merges the MCP config files without constructing a single client:
 * nothing is spawned and nothing connects. `darwin doctor` reports from this;
 * {@link loadMcpClients} builds on it. An unreadable or malformed file is the same
 * {@link ConfigError} startup raises.
 */
export async function readMcpServerConfigs(projectRoot: string): Promise<McpServerConfigs> {
  const { global, preferred, fallback } = mcpConfigCandidates(projectRoot);

  const [hasGlobal, hasPreferred, hasFallback] = await Promise.all([
    exists(global), exists(preferred), exists(fallback),
  ]);
  const projectConfig = hasPreferred ? preferred : hasFallback ? fallback : undefined;
  const ignoredConfigPath = hasPreferred && hasFallback ? fallback : undefined;
  if (!hasGlobal && projectConfig === undefined) {
    return { servers: undefined, configPaths: [], overriddenServerNames: [], configPath: undefined, ignoredConfigPath };
  }

  const sources = [...new Set([hasGlobal ? global : undefined, projectConfig].filter(
    (source): source is string => source !== undefined,
  ))];
  let servers: Record<string, McpServerConfig> = {};
  const overriddenServerNames: string[] = [];
  for (const source of sources) {
    try {
      const raw: unknown = JSON.parse(await readFile(source, 'utf8'));
      const layer = unwrapServers(raw);
      if (source === projectConfig) {
        overriddenServerNames.push(...Object.keys(layer).filter((name) => name in servers));
      }
      servers = { ...servers, ...layer };
    } catch (error) {
      throw new ConfigError(
        `${source} could not be loaded: ${error instanceof Error ? error.message : String(error)}\n` +
          `Expected Claude Code's format: { "mcpServers": { "<name>": { "command": ..., "args": [...] } } }`,
      );
    }
  }
  return {
    servers,
    configPaths: sources,
    overriddenServerNames,
    configPath: projectConfig ?? (hasGlobal ? global : undefined),
    ignoredConfigPath,
  };
}

/**
 * The MCP stdio transport inherits child stderr by default. In headless mode
 * that would let arbitrary server banners violate the bounded progress protocol.
 * The declarative SDK loader has no stderr option, but its transport has not
 * spawned yet here, so switch only that spawn parameter to `ignore`.
 */
export async function loadServersQuietly(
  servers: Record<string, McpServerConfig>,
): Promise<McpClient[]> {
  const clients = await McpClient.loadServers(servers, { continueOnError: true });
  for (const client of clients) {
    const transport = (client as unknown as {
      _transport?: { _serverParams?: { stderr?: string } };
    })._transport;
    if (transport?._serverParams !== undefined) transport._serverParams.stderr = 'ignore';
  }
  return clients;
}

/** Mirrors the SDK loader's own unwrapping: both the wrapped and bare forms work. */
function unwrapServers(parsed: unknown): Record<string, McpServerConfig> {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('top-level value must be an object');
  }
  const record = parsed as Record<string, unknown>;
  const inner = 'mcpServers' in record ? record['mcpServers'] : record;
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    throw new Error('"mcpServers" must be an object mapping server names to entries');
  }
  return inner as Record<string, McpServerConfig>;
}

/**
 * Gives every server whose entry has no `prefix` key a `<name>_` tool-name prefix.
 *
 * Two MCP servers are free to expose identically named tools (`browser_close`
 * exists in more than one published server), and a server may even use a name our
 * built-ins hold (`bash`). The SDK's tool registry treats any duplicate as a fatal
 * `ToolValidationError` during `agent.initialize()`, taking the whole TUI down with
 * it — so uniqueness has to be manufactured before registration, which is exactly
 * what Claude Code's `mcp__<server>__` convention does.
 *
 * An explicit `prefix` is always respected, including `""` for a user who wants
 * bare names back (e.g. to keep them short for a model's tool-name length limit)
 * and accepts the collision risk for their particular set of servers.
 */
export function withDefaultPrefixes(
  servers: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => [
      name,
      // The SDK renders agent-facing names as `<prefix>_<toolName>`, so the
      // default prefix is the bare server name: everything → everything_get-sum.
      typeof entry === 'object' && entry !== null && !('prefix' in entry)
        ? { ...entry, prefix: name }
        : entry,
    ]),
  );
}

/**
 * Disconnects every client, tolerating individual failures.
 *
 * Called on shutdown, where the useful outcome is "release every child process
 * we can" — one uncooperative server must not leave the others running.
 */
export async function disconnectAll(
  clients: readonly McpClient[],
  options: { throwOnError?: boolean } = {},
): Promise<void> {
  const results = await Promise.allSettled(clients.map((client) => client.disconnect()));
  const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
  if (options.throwOnError === true && failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} MCP disconnect operation(s) failed`);
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
