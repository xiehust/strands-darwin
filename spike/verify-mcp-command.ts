/**
 * SER-018 — `/mcp`: inspect configured MCP servers in-session.
 *
 * Free suite: no model call and no network. The healthy server is an in-process
 * `@modelcontextprotocol/sdk` `McpServer` over `InMemoryTransport`; the broken
 * one is a real `McpClient.loadServers` entry whose command cannot exist, taken
 * through the same `listTools()` the agent's `initialize()` performs — so the
 * projection is proved over the SDK's real `connected` / `failed` /
 * `disconnected` states, not stubs of them. The two hard rules are asserted
 * directly: reading the report never changes any client's connection state, and
 * a failed server is *stated* as failed instead of silently contributing zero
 * tools.
 *
 * Run: pnpm tsx spike/verify-mcp-command.ts
 */
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpClient } from '@strands-agents/sdk';

import { mcpConfigCandidates, mcpServerStatuses, type McpServerStatus } from '../src/mcp/registry.js';
import { formatMcpReport, MAX_MCP_TOOL_NAMES, type McpConfigSources } from '../src/tui/mcp-format.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// `mcpConfigCandidates` derives the global path under HOME; owned so the suite
// never names (or depends on) the developer's real ~/.darwin.
const HOME = ownPrivateHome('mcp-command');

const NO_SOURCES: McpConfigSources = {
  configPaths: [],
  overriddenServerNames: [],
  ignoredConfigPath: undefined,
  candidatePaths: ['/tmp/p/.darwin/mcp.json', '/tmp/p/.mcp.json'],
};

function status(partial: Partial<McpServerStatus> & { name: string }): McpServerStatus {
  return { state: 'connected', toolNames: [], ...partial };
}

/**
 * An in-process MCP server with `count` no-op tools, and a client connected to
 * it the same way the agent connects at startup: `listTools()`.
 */
async function connectedFixture(
  name: string,
  count: number,
): Promise<{ client: McpClient; server: McpServer }> {
  const server = new McpServer({ name, version: '0.0.1' });
  for (let index = 0; index < count; index += 1) {
    server.registerTool(`tool-${String(index).padStart(2, '0')}`, {}, () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient({
    transport: clientTransport,
    applicationName: name,
    prefix: name,
    continueOnError: true,
  });
  await client.listTools();
  return { client, server };
}

async function testProjection(): Promise<void> {
  header('mcpServerStatuses — the projection over real SDK clients');

  // Healthy: an in-memory server with 10 tools, connected via listTools() as
  // agent.initialize() does.
  const { client: healthy } = await connectedFixture('everything', 10);
  // Broken: a stdio entry whose command cannot exist, loaded exactly as the
  // registry loads it (continueOnError) and taken through the same listTools().
  const [broken] = await McpClient.loadServers(
    { broken: { command: 'this-command-does-not-exist-anywhere', args: [], prefix: 'broken' } },
    { continueOnError: true },
  );
  if (broken === undefined) throw new Error('loadServers returned no client');
  const brokenTools = await broken.listTools();
  assert('the broken server yields zero tools (the silent failure /mcp exists to name)', brokenTools.length === 0);
  // Never-connected: constructed but no operation has touched it.
  const [neverConnected] = await McpClient.loadServers(
    { idle: { command: 'true', args: [], prefix: 'idle' } },
    { continueOnError: true },
  );
  if (neverConnected === undefined) throw new Error('loadServers returned no client');

  const statuses = mcpServerStatuses([healthy, broken, neverConnected]);
  assert('every configured server appears, none omitted', statuses.length === 3);

  const [h, b, n] = statuses as [McpServerStatus, McpServerStatus, McpServerStatus];
  assert('the healthy server is named from its config entry', h.name === 'everything');
  assert('the healthy server reads connected', h.state === 'connected');
  assert('the healthy server lists its registered agent-facing tool names',
    h.toolNames !== undefined && h.toolNames.length === 10 && h.toolNames[0] === 'everything_tool-00');
  assert('tool names are sorted for a deterministic report',
    h.toolNames !== undefined && [...h.toolNames].every((toolName, i) => i === 0 || (h.toolNames as string[])[i - 1]!.localeCompare(toolName) <= 0));

  assert('the failed server is stated as failed, not omitted', b.name === 'broken' && b.state === 'failed');
  assert('the failed server carries zero tool names', b.toolNames !== undefined && b.toolNames.length === 0);

  assert('a never-connected server reads disconnected', n.state === 'disconnected');

  // Reading state must not mutate state: take the projection again and compare
  // the live getters — nothing was connected, reconnected or disconnected by it.
  mcpServerStatuses([healthy, broken, neverConnected]);
  assert('the projection never connects a disconnected client', neverConnected.connectionState === 'disconnected');
  assert('the projection never retries a failed client', broken.connectionState === 'failed');
  assert('the projection never drops a connected client', healthy.connectionState === 'connected');

  // The guarded private read degrades, never throws or probes: a client shaped
  // without the field reports names as unavailable.
  const alien = Object.create(McpClient.prototype) as McpClient;
  Object.defineProperty(alien, '_registeredToolNames', { value: 'not-a-set' });
  Object.defineProperty(alien, '_clientName', { value: 'future' });
  Object.defineProperty(alien, '_state', { value: 'connected' });
  const [futureStatus] = mcpServerStatuses([alien]);
  assert('an unreadable tool-name field degrades to undefined, not a crash',
    futureStatus !== undefined && futureStatus.toolNames === undefined && futureStatus.name === 'future');

  await healthy.disconnect();
}

function testFormatter(): void {
  header('formatMcpReport — bounded, states everything, invents nothing');

  // Zero servers, no file at all: a normal state naming where darwin looked.
  const empty = formatMcpReport([], NO_SOURCES);
  assert('no servers reads as a normal notice', empty.startsWith('no MCP servers configured'));
  assert('the empty report names every file darwin looked for',
    empty.includes('/tmp/p/.darwin/mcp.json') && empty.includes('/tmp/p/.mcp.json'));

  // Zero servers but a config was read: the file is named instead of the search.
  const emptyConfigured = formatMcpReport([], { ...NO_SOURCES, configPaths: ['/tmp/p/.darwin/mcp.json'] });
  assert('an empty config is distinguished from a missing one',
    emptyConfigured.includes('config read: /tmp/p/.darwin/mcp.json') && emptyConfigured.includes('no enabled servers'));

  // One healthy and one broken server: both named, the broken one as failed.
  const mixed = formatMcpReport(
    [
      status({ name: 'everything', toolNames: ['everything_echo', 'everything_get-sum'] }),
      status({ name: 'broken', state: 'failed' }),
    ],
    { ...NO_SOURCES, configPaths: ['/tmp/p/.mcp.json'] },
  );
  assert('the report counts its servers', mixed.includes('mcp servers (2)'));
  assert('the healthy server lists its tools with the count',
    mixed.includes('connected · 2 tools: everything_echo, everything_get-sum'));
  assert('the failed server is stated as failed', mixed.includes('failed — could not connect'));
  assert('the failed server states it contributes no tools', mixed.includes('contributing no tools'));
  assert('the config file in effect is named', mixed.includes('config: /tmp/p/.mcp.json'));

  // The listing is bounded: MAX_MCP_TOOL_NAMES shown, remainder stated.
  const many = formatMcpReport(
    [status({ name: 's', toolNames: Array.from({ length: MAX_MCP_TOOL_NAMES + 4 }, (_, i) => `s_t${String(i).padStart(2, '0')}`) })],
    NO_SOURCES,
  );
  assert('a long tool listing is capped with an explicit remainder', many.includes('… 4 more'));
  assert('the cap still states the true total', many.includes(`${MAX_MCP_TOOL_NAMES + 4} tools:`));
  assert('no tool beyond the cap is dumped', !many.includes(`s_t${String(MAX_MCP_TOOL_NAMES).padStart(2, '0')}`));

  // Honesty rows: disconnected is not probed, unavailable is not invented.
  const honest = formatMcpReport(
    [status({ name: 'idle', state: 'disconnected' }), status({ name: 'future', toolNames: undefined })],
    NO_SOURCES,
  );
  assert('a never-connected server is stated, not probed', honest.includes('not connected'));
  assert('unreadable tool names are stated as unavailable', honest.includes('tool names unavailable'));
  assert('a connected server with nothing registered says so',
    formatMcpReport([status({ name: 'bare' })], NO_SOURCES).includes('connected · no tools'));

  // Source provenance: layered configs are labelled, overrides and the ignored
  // root fallback are named.
  const layered = formatMcpReport([status({ name: 'a' })], {
    configPaths: ['/home/u/.darwin/mcp.json', '/tmp/p/.darwin/mcp.json'],
    overriddenServerNames: ['a'],
    ignoredConfigPath: '/tmp/p/.mcp.json',
    candidatePaths: [],
  });
  assert('both contributing configs are named with their layer',
    layered.includes('config: /home/u/.darwin/mcp.json (global)') &&
      layered.includes('config: /tmp/p/.darwin/mcp.json (project)'));
  assert('overridden server names are stated', layered.includes('project config overrides global for: a'));
  assert('an ignored root .mcp.json is stated as inert',
    layered.includes('ignored: /tmp/p/.mcp.json — .darwin/mcp.json takes precedence'));
}

function testCandidates(): void {
  header('mcpConfigCandidates — one derivation of where darwin looks');
  const candidates = mcpConfigCandidates('/tmp/proj');
  assert('the global candidate lives under the owned HOME', candidates.global.startsWith(HOME));
  assert('the preferred candidate is the project .darwin/mcp.json', candidates.preferred === '/tmp/proj/.darwin/mcp.json');
  assert('the fallback candidate is the project-root .mcp.json', candidates.fallback === '/tmp/proj/.mcp.json');
}

async function main(): Promise<void> {
  await testProjection();
  testFormatter();
  testCandidates();
  report();
}

await main();
