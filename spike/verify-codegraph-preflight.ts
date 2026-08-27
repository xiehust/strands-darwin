/** Network/model-free SRF-017 CodeGraph MCP preflight contract. */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  Agent,
  InterventionHandler,
  McpClient,
  Model,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type Tool,
  type ToolContext,
  type ToolResultBlock,
  type ToolStreamEvent,
} from '@strands-agents/sdk';
import { z } from 'zod';

import { CodeGraphPreflight } from '../src/mcp/codegraph-preflight.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';

import { assert, header, report } from './shared.js';

const require = createRequire(import.meta.url);
const emitWarning = process.emitWarning;
let DatabaseSync: typeof DatabaseSyncType;
try {
  process.emitWarning = (() => undefined) as typeof process.emitWarning;
  DatabaseSync = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
} finally {
  process.emitWarning = emitWarning;
}

class NoCallModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.codegraph-preflight', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    throw new Error('the CodeGraph preflight suite must not call a model');
  }
}

class SemanticChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.codegraph-child', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasResult = messages.some((message) => message.content.some((block) => block.type === 'toolResultBlock'));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'codegraph_search', toolUseId: 'child-codegraph-call' },
      };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{}' } };
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


interface McpFixture {
  readonly agent: Agent;
  readonly clients: readonly McpClient[];
  readonly servers: readonly McpServer[];
  readonly calls: Map<string, number>;
}

async function fixture(): Promise<McpFixture> {
  const calls = new Map<string, number>();
  const make = async (name: string, tools: readonly string[]): Promise<{ client: McpClient; server: McpServer }> => {
    const server = new McpServer({ name, version: '0.0.1' });
    for (const toolName of tools) {
      server.registerTool(toolName, {
        inputSchema: { projectPath: z.unknown().optional(), marker: z.string().optional() },
      }, ({ marker }) => {
        const key = `${name}:${toolName}`;
        calls.set(key, (calls.get(key) ?? 0) + 1);
        return { content: [{ type: 'text' as const, text: `${key}:${marker ?? 'none'}` }] };
      });
    }
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new McpClient({ transport: clientTransport, applicationName: name, prefix: name });
    return { client, server };
  };

  const codegraph = await make('codegraph', [
    'search', 'explore', 'node', 'callers', 'callees', 'impact', 'files', 'status', 'mystery',
  ]);
  const unrelated = await make('other', ['search']);
  const clients = [codegraph.client, unrelated.client];
  const agent = new Agent({ model: new NoCallModel(), tools: clients, printer: false });
  await agent.initialize();
  return { agent, clients, servers: [codegraph.server, unrelated.server], calls };
}

async function closeFixture(value: McpFixture): Promise<void> {
  await Promise.allSettled(value.clients.map((client) => client.disconnect()));
  await Promise.allSettled(value.servers.map((server) => server.close()));
}

async function createIndex(root: string, tables: readonly string[] = ['files', 'nodes', 'edges', 'schema_versions']): Promise<void> {
  const directory = path.join(root, '.codegraph');
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'codegraph.db'));
  try {
    for (const table of tables) database.exec(`CREATE TABLE ${table} (id INTEGER)`);
  } finally {
    database.close();
  }
}

async function runTool(
  agent: Agent,
  tool: Tool,
  input: unknown,
  toolUseId = 'preflight-call',
): Promise<{ events: ToolStreamEvent[]; result: ToolResultBlock }> {
  const context = {
    agent,
    invocationState: {},
    toolUse: { name: tool.name, toolUseId, input },
    interrupt: () => undefined,
  } as ToolContext;
  const stream = tool.stream(context);
  const events: ToolStreamEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
}

function text(result: ToolResultBlock): string {
  return result.content.flatMap((block) => block.type === 'textBlock' ? [block.text] : []).join('');
}

function tool(agent: Agent, name: string): Tool {
  const found = agent.tools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing fixture tool ${name}`);
  return found;
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
      } else if (entry.isSymbolicLink()) {
        rows.push(`l ${relative}`);
      } else {
        let digest: string;
        try {
          digest = createHash('sha256').update(await readFile(absolute)).digest('hex');
        } catch (error) {
          digest = `unreadable:${error instanceof Error && 'code' in error ? String(error.code) : 'error'}`;
        }
        rows.push(`f ${relative} ${info.mode.toString(8)} ${info.size} ${digest}`);
      }
    }
  };
  await walk(root);
  return rows.join('\n');
}

async function unavailableAndExplicitTargets(base: string): Promise<void> {
  header('CodeGraph preflight — unavailable current target and independent explicit targets');
  const current = path.join(base, 'current-uninitialized');
  const explicitReady = path.join(base, 'explicit-ready');
  const explicitAbsent = path.join(base, 'explicit-absent');
  const malformed = path.join(base, 'malformed');
  const invalidSchema = path.join(base, 'invalid-schema');
  const unreadable = path.join(base, 'unreadable');
  const symlinked = path.join(base, 'symlinked');
  await Promise.all([current, explicitReady, explicitAbsent, malformed, invalidSchema, unreadable].map((root) => mkdir(root)));
  await createIndex(explicitReady);
  await mkdir(path.join(malformed, '.codegraph'));
  await writeFile(path.join(malformed, '.codegraph', 'codegraph.db'), 'not sqlite');
  await createIndex(invalidSchema, ['files', 'nodes']);
  await createIndex(unreadable);
  await chmod(path.join(unreadable, '.codegraph', 'codegraph.db'), 0o000);
  await symlink(explicitReady, symlinked);

  let expectedFiles = await snapshot(base);
  const value = await fixture();
  try {
    const preflight = new CodeGraphPreflight(current);
    await preflight.primeCurrent();
    const replacements = preflight.apply(value.agent, value.clients);
    const search = tool(value.agent, 'codegraph_search');

    const first = await runTool(value.agent, search, { marker: 'current-1' });
    await createIndex(current);
    expectedFiles = await snapshot(base);
    const second = await runTool(value.agent, search, { marker: 'current-2' });
    assert('an uninitialized current target returns bounded successful guidance without MCP invocation',
      first.result.status === 'success' && text(first.result).includes('Use bash or fileEditor') &&
      [...text(first.result)].length < 600 && (value.calls.get('codegraph:search') ?? 0) === 0);
    assert('the current-target decision is cached for repeated fallback calls',
      text(second.result) === text(first.result) && (value.calls.get('codegraph:search') ?? 0) === 0);

    const explicit = await runTool(value.agent, search, { projectPath: explicitReady, marker: 'explicit-ready' });
    assert('an initialized explicit absolute target delegates independently',
      text(explicit.result) === 'codegraph:search:explicit-ready' && value.calls.get('codegraph:search') === 1);
    const absent = await runTool(value.agent, search, { projectPath: explicitAbsent, marker: 'absent' });
    assert('an uninitialized explicit target falls back without reaching MCP',
      absent.result.status === 'success' && text(absent.result).includes(JSON.stringify(explicitAbsent)) &&
      value.calls.get('codegraph:search') === 1);

    const malformedResult = await runTool(value.agent, search, { projectPath: malformed });
    const invalidSchemaResult = await runTool(value.agent, search, { projectPath: invalidSchema });
    const unreadableResult = await runTool(value.agent, search, { projectPath: unreadable });
    const symlinkResult = await runTool(value.agent, search, { projectPath: symlinked });
    assert('malformed, structurally invalid, unreadable, and symlinked index state fail closed',
      [malformedResult, invalidSchemaResult, unreadableResult, symlinkResult].every(({ result }) =>
        result.status === 'success' && text(result).includes('unavailable')) &&
      value.calls.get('codegraph:search') === 1);

    const unsafe: unknown[] = [
      null,
      'relative/project',
      `${explicitReady}/../explicit-ready`,
      42,
      `/${'x'.repeat(5000)}`,
      `/tmp/nul\0tail`,
    ];
    const unsafeResults = await Promise.all(unsafe.map((projectPath) =>
      runTool(value.agent, search, { projectPath })));
    assert('unsafe explicit paths are rejected locally and deterministically',
      unsafeResults.every(({ result }) => result.status === 'success' && text(result).includes('projectPath')) &&
      value.calls.get('codegraph:search') === 1);

    const semanticNames = ['search', 'explore', 'node', 'callers', 'callees', 'impact', 'files'];
    assert('all and only the known semantic CodeGraph tools were replaced',
      replacements === semanticNames.length && semanticNames.every((name) =>
        tool(value.agent, `codegraph_${name}`).constructor.name !== 'McpTool') &&
      tool(value.agent, 'codegraph_status').constructor.name === 'McpTool' &&
      tool(value.agent, 'codegraph_mystery').constructor.name === 'McpTool');
    await runTool(value.agent, tool(value.agent, 'codegraph_status'), { marker: 'status' });
    await runTool(value.agent, tool(value.agent, 'codegraph_mystery'), { marker: 'mystery' });
    await runTool(value.agent, tool(value.agent, 'other_search'), { marker: 'other' });
    assert('status, unknown CodeGraph tools, and unrelated clients remain ordinary MCP calls',
      value.calls.get('codegraph:status') === 1 && value.calls.get('codegraph:mystery') === 1 &&
      value.calls.get('other:search') === 1);

    const codegraphClient = value.clients.find((client) => client.clientName === 'codegraph');
    if (codegraphClient === undefined) throw new Error('missing CodeGraph fixture');
    await (codegraphClient as unknown as { _handleToolsChanged(): Promise<void> })._handleToolsChanged();
    const refreshedSearch = tool(value.agent, 'codegraph_search');
    const refreshed = await runTool(value.agent, refreshedSearch, {});
    assert('tools/list_changed preserves the parent preflight instead of restoring a raw MCP tool',
      refreshedSearch !== search && refreshedSearch.constructor.name !== 'McpTool' &&
      text(refreshed.result).includes('Use bash or fileEditor') && value.calls.get('codegraph:search') === 1);

    const registry: AgentDefinitionRegistry = {


      definitions: [{
        name: 'general',
        description: 'CodeGraph child probe',
        systemPrompt: 'Use the available semantic reader.',
        tools: undefined,
        file: undefined,
      }],
      problems: [],
    };
    let child: Agent | undefined;
    const subagents = new SubagentTool({
      registry,
      tools: value.agent.tools,
      intervention: new (class extends InterventionHandler { readonly name = 'allow'; })(),
      projectInstructions: undefined,
      config: {
        provider: 'bedrock', model: 'fake.child', region: 'us-west-2', maxTokens: 1000,
        permissionMode: 'yolo', promptCache: false, thinkingEffort: 'high', summaryRatio: 0.8,
        contextWarnRatio: 0.8, preserveRecentMessages: 4, modelChoices: [],
        contextOffload: true,
      },
      createModel: async () => new SemanticChildModel(),
      onChildInitialized: (initialized) => { child = initialized; },
    });
    const parent = new Agent({ model: new NoCallModel(), tools: [subagents.tool], printer: false });
    await parent.initialize();
    await parent.tool['subagent']?.invoke({ task: 'inspect without an initialized current index' });
    assert('a real child catalogue executes the same wrapped fallback without reaching MCP',
      child?.tools.find((candidate) => candidate.name === 'codegraph_search') === refreshedSearch &&
      child.messages.some((message) => message.content.some((block) =>
        block.type === 'toolResultBlock' && text(block).includes('Use bash or fileEditor'))) &&
      value.calls.get('codegraph:search') === 1);
    await subagents.shutdown();
  } finally {
    await closeFixture(value);
  }
  assert('preflight inspection and fallback create or rewrite no project files', await snapshot(base) === expectedFiles);
}

async function initializedCurrentPassThrough(base: string): Promise<void> {
  header('CodeGraph preflight — initialized current target is transparent');
  const root = path.join(base, 'current-ready');
  await mkdir(root);
  await createIndex(root);
  const before = await snapshot(root);
  const value = await fixture();
  try {
    const original = tool(value.agent, 'codegraph_search');
    const direct = await runTool(value.agent, original, { marker: 'same' }, 'same-id');
    const preflight = new CodeGraphPreflight(root);
    await preflight.primeCurrent();
    preflight.apply(value.agent, value.clients);
    const wrapped = tool(value.agent, 'codegraph_search');
    const delegated = await runTool(value.agent, wrapped, { marker: 'same' }, 'same-id');
    assert('usable current state preserves yielded events and final result bytes',
      JSON.stringify(delegated) === JSON.stringify(direct) && wrapped !== original);
    assert('usable current state reaches the real in-memory MCP server', value.calls.get('codegraph:search') === 2);
  } finally {
    await closeFixture(value);
  }
  assert('read-only validation leaves an initialized project byte-identical', await snapshot(root) === before);
}

const base = await mkdtemp(path.join(os.tmpdir(), 'darwin-codegraph-preflight-'));
try {
  await unavailableAndExplicitTargets(base);
  await initializedCurrentPassThrough(base);
  report();
} finally {
  await rm(base, { recursive: true, force: true });
}
