/** Network-free checks for headless parsing, output, permissions and sessions. */
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import type { AgentStreamEvent } from '@strands-agents/sdk';

import { parseCliArgs, CliUsageError } from '../src/cli-args.js';
import { createHeadlessPermissionBridge, headlessField, runHeadlessTurn } from '../src/headless.js';
import { resolveSession, sessionPaths } from '../src/agent/session.js';
import { loadServersQuietly } from '../src/mcp/registry.js';
import { header, report } from './shared.js';

const ROOT = '/tmp/darwin-headless-test';

function event(value: unknown): AgentStreamEvent {
  return value as AgentStreamEvent;
}

async function parserContracts(): Promise<void> {
  header('headless CLI parser');
  assert.deepEqual(parseCliArgs(['-p', 'hello']), {
    prompt: 'hello',
    session: { kind: 'new' },
    permissionModeOverride: undefined,
  });
  assert.deepEqual(parseCliArgs(['--print', 'hello', '--continue']), {
    prompt: 'hello',
    session: { kind: 'continue' },
    permissionModeOverride: undefined,
  });
  assert.deepEqual(parseCliArgs(['-p', 'hello', '--continue', '--session', 'chosen_1']), {
    prompt: 'hello',
    session: { kind: 'id', sessionId: 'chosen_1' },
    permissionModeOverride: undefined,
  });
  assert.equal(parseCliArgs(['-p', 'x', '--permission-mode', 'auto', '--yolo']).permissionModeOverride, 'yolo');
  assert.equal(parseCliArgs(['-p', 'x', '--permission-mode', 'bogus', '--yolo']).permissionModeOverride, 'yolo');
  assert.equal(parseCliArgs(['-p', 'x', '--yolo', '--permission-mode', 'bogus']).permissionModeOverride, 'yolo');
  assert.equal(parseCliArgs(['-p', 'x', '--permission-mode', '--yolo']).permissionModeOverride, 'yolo');
  assert.throws(
    () => parseCliArgs(['-p', 'x', '--permission-mode', 'bogus', '--permission-mode', 'auto', '--yolo']),
    CliUsageError,
  );
  assert.deepEqual(parseCliArgs(['--resume']).session, { kind: 'continue' });

  for (const argv of [
    ['-p'], ['-p', ' '], ['-p', 'x', '--print', 'y'], ['--session'],
    ['-p', 'x', '--session', 'UPPER'], ['-p', 'x', '--session', 'one', '--session', 'two'],
    ['--continue'], ['--session', 'one'], ['--unknown'], ['bare'],
  ]) {
    assert.throws(() => parseCliArgs(argv), CliUsageError, argv.join(' '));
  }
}

async function outputContracts(): Promise<void> {
  header('headless output and immediate denial');
  const stderr: string[] = [];
  const bridge = createHeadlessPermissionBridge((text) => stderr.push(text));
  const decision = await bridge({
    toolName: 'bash', kind: 'execute', summary: 'bash execute: one\n two', details: [], input: {},
    risk: 'dangerous', riskReason: 'test', suggestions: [],
  });
  assert.deepEqual(decision, { allowed: false });
  assert.equal(stderr.join(''), 'permission denied — bash execute: one two\n');

  const runtime = {
    expandSlashCommand: async () => null,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield event({ type: 'contentBlockEvent', contentBlock: { type: 'textBlock', text: 'working\n' } });
      yield event({ type: 'beforeToolCallEvent', toolUse: {
        name: 'bash', toolUseId: 'tool-1', input: { mode: 'execute', command: 'printf one\nprintf two' },
      } });
      yield event({ type: 'afterToolCallEvent', toolUse: {
        name: 'bash', toolUseId: 'tool-1', input: {},
      }, result: { status: 'error', content: [{ type: 'textBlock', text: 'DENIED: no' }] } });
      yield event({ type: 'contentBlockEvent', contentBlock: { type: 'textBlock', text: 'done\n\n' } });
      yield event({ type: 'agentResultEvent', result: { stopReason: 'endTurn' } });
    },
  };

  const reply = await runHeadlessTurn(runtime, 'prompt', (text) => stderr.push(text));
  assert.equal(reply, 'working\ndone');
  assert.match(stderr.join(''), /tool bash — bash: printf one …\ntool bash — denied\n/u);
  assert.equal(headlessField(`a\n${'😀'.repeat(300)}`).includes('\n'), false);
  assert.ok([...headlessField('😀'.repeat(300))].length <= 240);

  await assert.rejects(() => runHeadlessTurn({
    expandSlashCommand: async () => null,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield event({ type: 'contentBlockEvent', contentBlock: { type: 'textBlock', text: 'partial' } });
      throw new Error('turn failed');
    },
  }, 'x', () => undefined), /turn failed/u);
}

async function sessionContracts(): Promise<void> {
  header('headless session selection');
  await rm(ROOT, { recursive: true, force: true });
  const paths = sessionPaths(ROOT);
  const fresh = await resolveSession(ROOT, { kind: 'new' }, 'darwin');
  assert.match(fresh.sessionId, /^session-[a-z0-9_-]+$/u);
  assert.equal(fresh.restoreRequested, false);

  await mkdir(paths.stateDir, { recursive: true });
  await writeFile(paths.pointerFile, JSON.stringify({ sessionId: 'pointed', updatedAt: 'now' }));
  const pointedSnapshot = path.join(paths.sessionsDir, 'session', 'pointed', 'scopes', 'agent', 'darwin', 'snapshots', 'snapshot_latest.json');
  await mkdir(path.dirname(pointedSnapshot), { recursive: true });
  await writeFile(pointedSnapshot, '{}');
  assert.deepEqual(await resolveSession(ROOT, { kind: 'continue' }, 'darwin'), {
    sessionId: 'pointed', restoreRequested: true,
  });

  const selected = 'chosen-session';
  const snapshot = path.join(paths.sessionsDir, 'session', selected, 'scopes', 'agent', 'darwin', 'snapshots', 'snapshot_latest.json');
  await mkdir(path.dirname(snapshot), { recursive: true });
  await writeFile(snapshot, '{}');
  assert.deepEqual(await resolveSession(ROOT, { kind: 'id', sessionId: selected }, 'darwin'), {
    sessionId: selected, restoreRequested: true,
  });
  await assert.rejects(
    () => resolveSession(ROOT, { kind: 'id', sessionId: 'missing' }, 'darwin'),
    /does not exist/u,
  );
}

async function mcpStderrContract(): Promise<void> {
  header('headless MCP stderr isolation');
  const clients = await loadServersQuietly({
    noisy: {
      command: process.execPath,
      args: ['-e', `process.stderr.write('arbitrary\\nmultiline\\nserver banner\\n'); setInterval(() => {}, 1000)`],
    },
  });
  const transport = (clients[0] as unknown as {
    _transport?: { _serverParams?: { stderr?: string } };
  })._transport;
  assert.equal(transport?._serverParams?.stderr, 'ignore');
  await Promise.allSettled(clients.map((client) => client.disconnect()));
}


async function usageProcessContract(): Promise<void> {
  header('headless usage failure process');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', '-p'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const result = await Promise.race([
    new Promise<{ code: number | null }>((resolve) => child.once('close', (code) => resolve({ code }))),
    new Promise<never>((_, reject) => setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('headless usage process did not exit within 5s'));
    }, 5_000)),
  ]);
  assert.equal(result.code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /^error: -p expects a non-empty message\.\n$/u);
  assert.doesNotMatch(stderr, /\x1b\[/u);

  // A usage failure must not touch project state.
  await assert.rejects(() => readFile(path.join(ROOT, 'never-created')), /ENOENT/u);
}

await parserContracts();
await outputContracts();
await sessionContracts();
await mcpStderrContract();
await usageProcessContract();
report();
