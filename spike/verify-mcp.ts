/**
 * MCP verification against a real stdio server.
 *
 * Uses `@modelcontextprotocol/server-everything`, whose `get-sum` tool is
 * trivially checkable: ask for 17 + 25 and the answer must be 42.
 *
 * Covers: tool discovery, an actual call, that MCP calls are gated by the
 * permission policy, and that one unreachable server does not stop startup.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-mcp.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { AgentRuntime } from '../src/agent/runtime.js';
import type { PermissionDecision, PermissionRequest } from '../src/agent/permission.js';
import { loadMcpClients } from '../src/mcp/registry.js';
import { assert, header, report } from './shared.js';

const PROJECT_ROOT = '/tmp/darwin-mcp-proj';

/**
 * Written to the project root as `.mcp.json`, in Claude Code's format and exactly
 * where that tool puts it — so this also covers the fallback config location
 * being live-usable, not merely resolvable.
 */
const MCP_CONFIG = {
  mcpServers: {
    everything: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    },
  },
};

/** Same, plus a server that cannot possibly start. */
const MCP_CONFIG_WITH_BROKEN = {
  mcpServers: {
    everything: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
    },
    broken: {
      command: 'this-command-does-not-exist-anywhere',
      args: [],
    },
  },
};

async function writeProject(config: unknown): Promise<void> {
  await rm(PROJECT_ROOT, { recursive: true, force: true });
  await mkdir(PROJECT_ROOT, { recursive: true });
  await writeFile(path.join(PROJECT_ROOT, '.mcp.json'), JSON.stringify(config, null, 2), 'utf8');
}

function recordingBridge(decision: boolean) {
  const seen: PermissionRequest[] = [];
  const bridge = async (request: PermissionRequest): Promise<PermissionDecision> => {
    seen.push(request);
    return { allowed: decision };
  };
  return { bridge, seen };
}

async function runTurn(runtime: AgentRuntime, input: string) {
  const text: string[] = [];
  const toolCalls: string[] = [];

  for await (const event of runtime.send(input)) {
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event.type === 'modelContentBlockDeltaEvent' &&
      event.event.delta.type === 'textDelta'
    ) {
      text.push(event.event.delta.text);
    }
    if (event.type === 'beforeToolCallEvent') toolCalls.push(event.toolUse.name);
  }
  return { text: text.join(''), toolCalls };
}

/** No config file at all must be a normal, quiet startup. */
async function noConfig(): Promise<void> {
  header('no .mcp.json — starts normally with no MCP');

  await rm(PROJECT_ROOT, { recursive: true, force: true });
  await mkdir(PROJECT_ROOT, { recursive: true });

  const result = await loadMcpClients(PROJECT_ROOT);

  assert('no clients loaded', result.clients.length === 0);
  assert('no config path reported', result.configPath === undefined);
}

async function discoveryAndCall(): Promise<void> {
  header('stdio server — discovery, invocation, and permission gating');

  await writeProject(MCP_CONFIG);
  const { bridge, seen } = recordingBridge(true);

  const runtime = await AgentRuntime.create({
    projectRoot: PROJECT_ROOT,
    session: { kind: 'new' },
    permissionBridge: bridge,
  });

  try {
    const toolNames = runtime.info.toolNames;
    console.log(`  mcp config : ${runtime.info.mcpConfigPath}`);
    console.log(`  servers    : ${runtime.info.mcpServerCount}`);
    console.log(`  tools      : ${toolNames.join(', ')}`);

    assert('config file was found', runtime.info.mcpConfigPath !== undefined);
    assert('one server configured', runtime.info.mcpServerCount === 1);
    assert('MCP tools were discovered and registered', toolNames.includes('everything_get-sum'));
    assert('local vended tools are still present', toolNames.includes('bash') && toolNames.includes('fileEditor'));
    assert('more than just the local tools are registered', toolNames.length > 2);

    const turn = await runTurn(
      runtime,
      'Use the "everything_get-sum" tool to add 17 and 25. Report only the number it returns.',
    );

    console.log(`  tool calls : ${JSON.stringify(turn.toolCalls)}`);
    console.log(`  answer     : ${turn.text.trim().slice(0, 160)}`);
    console.log(`  prompted   : ${JSON.stringify(seen.map((r) => `${r.toolName}:${r.kind}`))}`);

    assert('the MCP tool was actually called', turn.toolCalls.includes('everything_get-sum'));
    assert('the MCP tool returned the right answer', turn.text.includes('42'));
    assert('the MCP call was gated by a permission prompt', seen.some((r) => r.toolName === 'everything_get-sum'));
    assert(
      'unknown/MCP tools are classified as execute (fail-closed default)',
      seen.find((r) => r.toolName === 'everything_get-sum')?.kind === 'execute',
    );
    assert(
      'the prompt exposes the tool input for rendering',
      (seen.find((r) => r.toolName === 'everything_get-sum')?.details.length ?? 0) > 0,
    );
  } finally {
    await runtime.shutdown();
  }
}

/** Denying an MCP call must behave like denying any other tool. */
async function deniedMcpCall(): Promise<void> {
  header('stdio server — denying an MCP call');

  await writeProject(MCP_CONFIG);
  const { bridge, seen } = recordingBridge(false);

  const runtime = await AgentRuntime.create({
    projectRoot: PROJECT_ROOT,
    session: { kind: 'new' },
    permissionBridge: bridge,
  });

  try {
    const turn = await runTurn(runtime, 'Use the "everything_get-sum" tool to add 17 and 25.');
    console.log(`  prompted : ${JSON.stringify(seen.map((r) => r.toolName))}`);
    console.log(`  answer   : ${turn.text.trim().slice(0, 200)}`);

    assert('the MCP call was prompted', seen.some((r) => r.toolName === 'everything_get-sum'));
    assert('agent produced a closing message after denial', turn.text.trim().length > 0);
  } finally {
    await runtime.shutdown();
  }
}

/** A broken server entry must not take the whole startup down. */
async function brokenServerTolerated(): Promise<void> {
  header('one unreachable server — startup survives');

  await writeProject(MCP_CONFIG_WITH_BROKEN);
  const { bridge } = recordingBridge(true);

  const runtime = await AgentRuntime.create({
    projectRoot: PROJECT_ROOT,
    session: { kind: 'new' },
    permissionBridge: bridge,
  });

  try {
    const toolNames = runtime.info.toolNames;
    console.log(`  servers : ${runtime.info.mcpServerCount}`);
    console.log(`  tools   : ${toolNames.join(', ')}`);

    assert('both servers were configured', runtime.info.mcpServerCount === 2);
    assert('startup completed despite the broken server', true);
    assert('the working server still contributed its tools', toolNames.includes('everything_get-sum'));
    assert('local tools unaffected', toolNames.includes('bash'));
  } finally {
    await runtime.shutdown();
  }
}

async function main(): Promise<void> {
  await noConfig();
  await discoveryAndCall();
  await deniedMcpCall();
  await brokenServerTolerated();
  report();
}

await main();
