/**
 * MCP server discovery from `.mcp.json`.
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
 * So the only things left for us are: treating a missing file as "no MCP", and
 * turning per-server failures into warnings instead of a failed startup.
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

import { McpClient } from '@strands-agents/sdk';

import { ConfigError } from '../config.js';

export const MCP_CONFIG_FILENAME = '.mcp.json';

export interface McpLoadResult {
  clients: McpClient[];
  /** Absolute path read, or undefined when no config file exists. */
  configPath: string | undefined;
}

/**
 * Loads every enabled MCP server declared in `<projectRoot>/.mcp.json`.
 *
 * Returns an empty list when the file is absent — running without MCP is a
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
export async function loadMcpClients(projectRoot: string): Promise<McpLoadResult> {
  const configPath = path.join(projectRoot, MCP_CONFIG_FILENAME);

  if (!(await exists(configPath))) {
    return { clients: [], configPath: undefined };
  }

  try {
    const clients = await McpClient.loadServers(configPath, { continueOnError: true });
    return { clients, configPath };
  } catch (error) {
    throw new ConfigError(
      `${configPath} could not be loaded: ${error instanceof Error ? error.message : String(error)}\n` +
        `Expected Claude Code's format: { "mcpServers": { "<name>": { "command": ..., "args": [...] } } }`,
    );
  }
}

/**
 * Disconnects every client, tolerating individual failures.
 *
 * Called on shutdown, where the useful outcome is "release every child process
 * we can" — one uncooperative server must not leave the others running.
 */
export async function disconnectAll(clients: readonly McpClient[]): Promise<void> {
  await Promise.allSettled(clients.map((client) => client.disconnect()));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
