/** Network/model-free SRF-018 web-search empty-result compatibility contract. */
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  Agent,
  McpClient,
  Model,
  Tool,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type ToolContext,
  type ToolResultBlock,
  type ToolStreamEvent,
} from '@strands-agents/sdk';
import { z } from 'zod';

import { SubagentTool } from '../src/agents/subagent-tool.js';
import { PermissionGate } from '../src/agent/permission.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import { WebSearchEmptyResults } from '../src/mcp/web-search-empty-results.js';
import { assert, header, report } from './shared.js';

const EMPTY_ERROR =
  "Error calling tool 'search': Upstream error: {'code': -32602, 'message': 'Tool returned no results'}";

type Mode = 'empty' | 'one' | 'many' | 'provider';

class NoCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.web-search-parent', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    throw new Error('the web-search compatibility suite must not call the parent model');
  }
}

class EmptySearchChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.web-search-child', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasResult = messages.some((message) => message.content.some((block) => block.type === 'toolResultBlock'));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'web-search_search', toolUseId: 'child-search-call' },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify({ query: 'child query', mode: 'empty' }) },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'child finished' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

type McpTool = Awaited<ReturnType<McpClient['listTools']>>[number];

interface Fixture {
  readonly agent: Agent;
  readonly searchClient: McpClient;
  readonly otherClient: McpClient;
  readonly clients: readonly McpClient[];
  readonly servers: readonly McpServer[];
  readonly calls: Map<string, number>;
  readonly foreignClient: McpClient;
  readonly discovery: { connect: number; list: number };
  readonly discovered: Map<string, { tool: McpTool; owner: McpClient }>;
}

async function fixture(): Promise<Fixture> {
  const calls = new Map<string, number>();
  const discovery = { connect: 0, list: 0 };
  const discovered = new Map<string, { tool: McpTool; owner: McpClient }>();
  const make = async (name: string, prefix = name): Promise<{ client: McpClient; server: McpServer }> => {
    const server = new McpServer({ name, version: '0.0.1' });
    server.registerTool('search', {
      inputSchema: { query: z.string(), mode: z.enum(['empty', 'one', 'many', 'provider']) },
    }, ({ query, mode }) => {
      calls.set(`${prefix}:${mode}`, (calls.get(`${prefix}:${mode}`) ?? 0) + 1);
      if (mode === 'empty') return { isError: true, content: [{ type: 'text' as const, text: EMPTY_ERROR }] };
      if (mode === 'provider') {
        return { isError: true, content: [{ type: 'text' as const, text: 'Provider service unavailable' }] };
      }
      const results = mode === 'one'
        ? [{ title: 'one', url: 'https://example.test/one' }]
        : [{ title: 'one', url: 'https://example.test/one' }, { title: 'two', url: 'https://example.test/two' }];
      return { content: [{ type: 'text' as const, text: JSON.stringify({ query, results, totalResults: results.length }) }] };
    });
    server.registerTool('status', { inputSchema: {} }, () => ({
      isError: true, content: [{ type: 'text' as const, text: EMPTY_ERROR }],
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new McpClient({ transport: clientTransport, applicationName: name, prefix });
    const connect = client.connect.bind(client);
    const listTools = client.listTools.bind(client);
    client.connect = (...args) => { discovery.connect++; return connect(...args); };
    client.listTools = async (...args) => {
      discovery.list++;
      const tools = await listTools(...args);
      for (const tool of tools) discovered.set(tool.name, { tool, owner: client });
      return tools;
    };
    return { client, server };
  };

  const search = await make('web-search');
  const other = await make('other');
  const foreign = await make('web-search', 'foreign');
  const clients = [search.client, other.client];
  const agent = new Agent({ model: new NoCallModel(), tools: [...clients, foreign.client], printer: false });
  await agent.initialize();
  return {
    agent,
    searchClient: search.client,
    otherClient: other.client,
    clients,
    servers: [search.server, other.server, foreign.server],
    calls,
    foreignClient: foreign.client,
    discovery,
    discovered,
  };
}

async function closeFixture(value: Fixture): Promise<void> {
  await Promise.allSettled([...value.clients, value.foreignClient].map((client) => client.disconnect()));
  await Promise.allSettled(value.servers.map((server) => server.close()));
  assert('all real MCP clients still disconnect through their ordinary lifecycle',
    [...value.clients, value.foreignClient].every((client) => client.connectionState === 'disconnected'));
  const discoveryBefore = JSON.stringify(value.discovery);
  assert('the public getter returns each original disconnected owner without connection or discovery',
    value.discovered.size > 0 && [...value.discovered.values()].every(({ tool, owner }) =>
      tool.mcpClient === owner && owner.connectionState === 'disconnected') &&
    JSON.stringify(value.discovery) === discoveryBefore);
}

async function runTool(
  agent: Agent,
  tool: Tool,
  input: unknown,
  toolUseId = 'search-call',
): Promise<{ events: ToolStreamEvent[]; result: ToolResultBlock }> {
  const context = {
    agent,
    invocationState: {},
    toolUse: { name: tool.name, toolUseId, input },
    interrupt: () => undefined,
    cancelSignal: new AbortController().signal,
  } as ToolContext;
  const stream = tool.stream(context);
  const events: ToolStreamEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

function tool(agent: Agent, name: string): Tool {
  const found = agent.tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing fixture tool ${name}`);
  return found;
}

function text(result: ToolResultBlock): string {
  return result.content.flatMap((block) => block.type === 'textBlock' ? [block.text] : []).join('');
}

async function snapshot(root: string): Promise<string> {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const info = await lstat(absolute);
      if (entry.isDirectory()) {
        rows.push(`d ${relative} ${info.mode.toString(8)}`);
        await walk(absolute);
      } else {
        const digest = createHash('sha256').update(await readFile(absolute)).digest('hex');
        rows.push(`f ${relative} ${info.mode.toString(8)} ${info.size} ${digest}`);
      }
    }
  };
  await walk(root);
  return rows.join('\n');
}

async function contract(root: string): Promise<void> {
  header('Web search — zero hits are successful without weakening true errors');
  const before = await snapshot(root);
  const value = await fixture();
  try {
    const original = tool(value.agent, 'web-search_search');
    const oneBefore = await runTool(value.agent, original, { query: 'one query', mode: 'one' }, 'one-id');
    const manyBefore = await runTool(value.agent, original, { query: 'many query', mode: 'many' }, 'many-id');
    const providerBefore = await runTool(value.agent, original, { query: 'provider query', mode: 'provider' });
    const malformedBefore = await runTool(value.agent, original, { mode: 'empty' });
    const status = tool(value.agent, 'web-search_status');

    const foreign = tool(value.agent, 'foreign_search');
    const other = tool(value.agent, 'other_search');
    class LocalSearch extends Tool {
      constructor(readonly name: string) { super(); }
      readonly description = original.description;
      get toolSpec() { return { ...original.toolSpec, name: this.name }; }
      stream(context: ToolContext) { return original.stream(context); }
    }
    const local = new LocalSearch('local_search');
    const lookalike = new LocalSearch('lookalike_search');
    let lookalikeOwnerReads = 0;
    Object.defineProperty(lookalike, 'mcpClient', {
      get: () => { lookalikeOwnerReads++; return value.searchClient; },
    });
    value.agent.toolRegistry.addOrReplace([local, lookalike]);
    const discoveryBefore = JSON.stringify(value.discovery);
    const discovered = value.discovered.get(original.name);
    const discoveredForeign = value.discovered.get(foreign.name);
    assert('discovered tools expose their exact original owners, even with the same client name',
      discovered?.tool === original && discovered.tool.mcpClient === value.searchClient &&
      discoveredForeign?.tool === foreign && discoveredForeign.tool.mcpClient === value.foreignClient &&
      value.foreignClient.clientName === value.searchClient.clientName);
    const policy = new WebSearchEmptyResults();
    assert('only the configured web-search server tool is replaced', policy.apply(value.agent, value.clients) === 1);
    const wrapped = tool(value.agent, 'web-search_search');
    assert('repeat apply preserves wrapper identity and makes no connection or listTools call',
      policy.apply(value.agent, value.clients) === 0 && tool(value.agent, wrapped.name) === wrapped &&
      JSON.stringify(value.discovery) === discoveryBefore);
    assert('foreign owners and plain/non-MCP lookalikes remain untouched without reading their owner',
      tool(value.agent, foreign.name) === foreign && tool(value.agent, other.name) === other &&
      tool(value.agent, local.name) === local && tool(value.agent, lookalike.name) === lookalike &&
      lookalikeOwnerReads === 0);
    const statusResult = await runTool(value.agent, status, {});
    assert('a non-search tool on the configured client remains identical and its error is not normalized',
      tool(value.agent, status.name) === status && statusResult.result.status === 'error' &&
      text(statusResult.result) === EMPTY_ERROR);
    const foreignEmpty = await runTool(value.agent, foreign, { query: 'foreign query', mode: 'empty' });
    assert('a same-name foreign client keeps its real server error unnormalized',
      foreignEmpty.result.status === 'error' && text(foreignEmpty.result) === EMPTY_ERROR &&
      value.calls.get('foreign:empty') === 1);
    const empty = await runTool(value.agent, wrapped, { query: 'no matches query', mode: 'empty' });
    assert('a verified zero-hit outcome becomes successful actionable empty JSON',
      empty.result.status === 'success' &&
      text(empty.result) === JSON.stringify({ query: 'no matches query', results: [], totalResults: 0 }) &&
      empty.result.error === undefined && value.calls.get('web-search:empty') === 1);

    const oneAfter = await runTool(value.agent, wrapped, { query: 'one query', mode: 'one' }, 'one-id');
    const manyAfter = await runTool(value.agent, wrapped, { query: 'many query', mode: 'many' }, 'many-id');
    assert('one and many result payloads pass through byte-equivalently',
      JSON.stringify(oneAfter) === JSON.stringify(oneBefore) && JSON.stringify(manyAfter) === JSON.stringify(manyBefore));

    const provider = await runTool(value.agent, wrapped, { query: 'provider query', mode: 'provider' });
    const malformed = await runTool(value.agent, wrapped, { mode: 'empty' });
    assert('provider and malformed-input errors preserve their original bytes and events',
      JSON.stringify(provider) === JSON.stringify(providerBefore) &&
      JSON.stringify(malformed) === JSON.stringify(malformedBefore));
    const callTool = value.searchClient.callTool.bind(value.searchClient);
    value.searchClient.callTool = async () => { throw new Error('transport timed out'); };
    const transport = await runTool(value.agent, wrapped, { query: 'timeout query', mode: 'empty' });
    value.searchClient.callTool = callTool;
    assert('provider, malformed-input, and transport failures remain errors',
      provider.result.status === 'error' && text(provider.result) === 'Provider service unavailable' &&
      malformed.result.status === 'error' && text(malformed.result).includes('Input validation error') &&
      transport.result.status === 'error' && transport.result.error?.message === 'transport timed out');

    const otherEmpty = await runTool(value.agent, other, { query: 'other query', mode: 'empty' });
    assert('an unrelated client with the same server tool name is untouched',
      other.constructor.name === 'McpTool' && otherEmpty.result.status === 'error' && text(otherEmpty.result) === EMPTY_ERROR);

    const beforeRefresh = { ...value.discovery };
    await (value.searchClient as unknown as { _handleToolsChanged(): Promise<void> })._handleToolsChanged();
    const refreshed = tool(value.agent, 'web-search_search');
    assert('refresh performs only its ordinary list/connect and repeat apply leaves the refreshed wrapper stable',
      policy.apply(value.agent, value.clients) === 0 && tool(value.agent, refreshed.name) === refreshed &&
      value.discovery.list === beforeRefresh.list + 1 && value.discovery.connect === beforeRefresh.connect + 1 &&
      tool(value.agent, foreign.name) === foreign && tool(value.agent, lookalike.name) === lookalike &&
      lookalikeOwnerReads === 0);
    const refreshedEmpty = await runTool(value.agent, refreshed, { query: 'refreshed query', mode: 'empty' });
    assert('tools/list_changed preserves normalization instead of restoring a raw MCP tool',
      refreshed !== wrapped && refreshed.constructor.name !== 'McpTool' && refreshedEmpty.result.status === 'success');

    const registry: AgentDefinitionRegistry = {
      definitions: [{
        name: 'general',
        description: 'Web-search child probe',
        systemPrompt: 'Use web search.',
        tools: undefined,
        projectInstructions: true,
        file: undefined,
      }],
      problems: [],
    };
    let child: Agent | undefined;
    let allowCalls = true;
    let permissionRequests = 0;
    const gate = new PermissionGate({
      mode: 'default', projectRoot: root,
      ask: async () => { permissionRequests++; return { allowed: allowCalls }; },
    });
    const subagents = new SubagentTool({
      registry,
      tools: value.agent.tools,
      intervention: gate,
      projectInstructions: undefined,
      config: {
        provider: 'bedrock', model: 'fake.child', region: 'us-west-2', maxTokens: 1000,
        permissionMode: 'yolo', promptCache: false, thinkingEffort: 'high', summaryRatio: 0.8,
        contextWarnRatio: 0.8, preserveRecentMessages: 4, modelChoices: [],
        contextOffload: true,
      },
      createModel: async () => new EmptySearchChildModel(),
      onChildInitialized: (initialized) => { child = initialized; },
    });
    const parent = new Agent({ model: new NoCallModel(), tools: [subagents.tool], printer: false });
    await parent.initialize();
    await parent.tool['subagent']?.invoke({ task: 'search for an absent result' });
    assert('a real child catalogue executes the identical successful empty-result policy',
      child?.tools.find((candidate) => candidate.name === 'web-search_search') === refreshed &&
      child.messages.some((message) => message.content.some((block) =>
        block.type === 'toolResultBlock' && block.status === 'success' &&
        text(block) === JSON.stringify({ query: 'child query', results: [], totalResults: 0 }))));
    allowCalls = false;
    const callsBeforeDenial = value.calls.get('web-search:empty');
    const deniedParent = new Agent({
      model: new EmptySearchChildModel(), tools: [refreshed], interventions: [gate], printer: false,
    });
    await deniedParent.invoke('search with permission denied');
    await parent.tool['subagent']?.invoke({ task: 'search with permission denied' });
    assert('the shared permission gate denies parent and child calls before MCP or normalization',
      permissionRequests === 3 && [deniedParent, child].every((agent) => agent?.messages.some((message) =>
        message.content.some((block) => block.type === 'toolResultBlock' && block.status === 'error'))) &&
      value.calls.get('web-search:empty') === callsBeforeDenial);
    await subagents.shutdown();
  } finally {
    await closeFixture(value);
  }
  assert('the compatibility policy and test mutate no project files', await snapshot(root) === before);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-web-search-empty-'));
try {
  await contract(root);
  report();
} finally {
  await rm(root, { recursive: true, force: true });
}
