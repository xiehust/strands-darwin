/** Network-free checks for headless parsing, output, permissions and sessions. */
import nodeAssert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import type { AgentStreamEvent } from '@strands-agents/sdk';

import { resolveSession, sessionPaths } from '../src/agent/session.js';
import { NEVER_WITHDRAWN, PARENT_PERMISSION_SOURCE } from '../src/agent/permission.js';
import { parseCliArgs, CliUsageError } from '../src/cli-args.js';
import { usageErrorText } from '../src/cli-usage.js';
import type { AppConfig } from '../src/config.js';
import {
  PIPED_STDIN_FOOTER,
  PIPED_STDIN_MAX_BYTES,
  composeHeadlessPrompt,
  formatPipedStdinHeading,
  readPipedStdin,
  type PipedStdinSource,
} from '../src/headless-stdin.js';
import {
  createHeadlessPermissionBridge,
  formatHeadlessCallStats,
  formatHeadlessChildUsage,
  formatHeadlessCost,
  formatHeadlessPermissionMode,
  formatHeadlessTotalUsage,
  formatHeadlessUsage,
  headlessField,
  runHeadlessTurn,
} from '../src/headless.js';
import { loadServersQuietly } from '../src/mcp/registry.js';
import { assert as countedAssert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-headless-test';

function usageConfig(provider: 'bedrock' | 'openai', openaiApi?: 'chat' | 'responses'): AppConfig {
  return {
    provider,
    model: provider === 'openai' ? 'openai.gpt-5.6-sol' : 'global.anthropic.claude-opus-5',
    region: 'us-east-1',
    maxTokens: 1000,
    permissionMode: 'yolo',
    promptCache: true,
    promptCacheTtl: '5m',
    thinkingEffort: 'high',
    summaryRatio: 0.8,
    contextWarnRatio: 0.8,
    contextOffload: true,
    preserveRecentMessages: 4,
    ...(openaiApi !== undefined && { openaiApi }),
    modelChoices: [],
  };
}

/** Count every pre-existing strict assertion without weakening its comparison semantics. */
const assert: typeof nodeAssert = new Proxy(nodeAssert, {
  get(target, property, receiver) {
    const member = Reflect.get(target, property, receiver) as unknown;
    if (typeof member !== 'function') return member;
    return (...args: unknown[]) => {
      const label = `headless contract: ${String(property)}${typeof args.at(-1) === 'string' ? ` — ${String(args.at(-1))}` : ''}`;
      try {
        const result = (member as (...values: unknown[]) => unknown)(...args);
        if (result instanceof Promise) {
          return result.then(
            (value) => {
              countedAssert(label, true);
              return value;
            },
            () => {
              countedAssert(label, false);
              return undefined;
            },
          );
        }
        countedAssert(label, true);
        return result;
      } catch {
        countedAssert(label, false);
        return undefined;
      }
    };
  },
}) as typeof nodeAssert;

function event(value: unknown): AgentStreamEvent {
  return value as AgentStreamEvent;
}

async function parserContracts(): Promise<void> {
  header('headless CLI parser');
  assert.deepEqual(parseCliArgs(['-p', 'hello']), {
    prompt: 'hello',
    outputFormat: 'text',
    maxModelCalls: undefined,
    contextOffloadOverride: undefined,
    compactBefore: false,
    session: { kind: 'new' },
    permissionModeOverride: undefined,
  });
  assert.deepEqual(parseCliArgs(['--print', 'hello', '--continue']), {
    prompt: 'hello',
    outputFormat: 'text',
    maxModelCalls: undefined,
    contextOffloadOverride: undefined,
    compactBefore: false,
    session: { kind: 'continue' },
    permissionModeOverride: undefined,
  });
  assert.deepEqual(parseCliArgs(['-p', 'hello', '--continue', '--session', 'chosen_1']), {
    prompt: 'hello',
    outputFormat: 'text',
    maxModelCalls: undefined,
    contextOffloadOverride: undefined,
    compactBefore: false,
    session: { kind: 'id', sessionId: 'chosen_1' },
    permissionModeOverride: undefined,
  });
  assert.equal(parseCliArgs(['-p', 'x', '--permission-mode', 'plan']).permissionModeOverride, 'plan');
  assert.equal(parseCliArgs(['-p', 'x', '--output-format', 'json']).outputFormat, 'json');
  assert.equal(parseCliArgs(['--output-format', 'stream-json', '-p', 'x']).outputFormat, 'stream-json');

  assert.equal(parseCliArgs(['--permission-mode', 'plan']).permissionModeOverride, 'plan');
  assert.equal(parseCliArgs(['-p', 'x', '--permission-mode', 'plan', '--yolo']).permissionModeOverride, 'yolo');
  assert.equal(parseCliArgs(['-p', 'x', '--permission-mode', 'auto', '--yolo']).permissionModeOverride, 'yolo');
  assert.equal(parseCliArgs(['-p', 'x', '--permission-mode', 'bogus', '--yolo']).permissionModeOverride, 'yolo');
  assert.equal(parseCliArgs(['-p', 'x', '--yolo', '--permission-mode', 'bogus']).permissionModeOverride, 'yolo');
  assert.deepEqual(
    parseCliArgs(['-p', 'x', '--max-model-calls', '20', '--context-offload', '--compact-before']),
    {
      prompt: 'x',
      outputFormat: 'text',
      maxModelCalls: 20,
      contextOffloadOverride: true,
      compactBefore: true,
      session: { kind: 'new' },
      permissionModeOverride: undefined,
    },
  );

  assert.equal(parseCliArgs(['-p', 'x', '--permission-mode', '--yolo']).permissionModeOverride, 'yolo');
  assert.throws(
    () => parseCliArgs(['-p', 'x', '--permission-mode', 'bogus', '--permission-mode', 'auto', '--yolo']),
    CliUsageError,
  );
  assert.deepEqual(parseCliArgs(['--resume']).session, { kind: 'continue' });
  // Interactive `--session <id>` is accepted since trajectories became forkable: a
  // fork's id exists only on stdout, so a TUI that could not be pointed at one would
  // make the primitive unusable. The guard it replaced was a usage convention, not a
  // safety property — the alphabet is validated here and `resolveSession` still
  // refuses an id with no persisted snapshot.
  assert.deepEqual(parseCliArgs(['--session', 'forked_1']), {
    prompt: undefined,
    outputFormat: 'text',
    maxModelCalls: undefined,
    contextOffloadOverride: undefined,
    compactBefore: false,
    session: { kind: 'id', sessionId: 'forked_1' },
    permissionModeOverride: undefined,
  });
  assert.deepEqual(parseCliArgs(['--session', 'forked_1', '--yolo']).session, {
    kind: 'id',
    sessionId: 'forked_1',
  });

  for (const argv of [
    ['-p'], ['-p', ' '], ['-p', 'x', '--print', 'y'], ['--session'],
    ['-p', 'x', '--session', 'UPPER'], ['-p', 'x', '--session', 'one', '--session', 'two'],
    // `--continue` stays headless-only (`--resume` is its TUI spelling), and an
    // invalid id is still refused in either mode.
    ['--continue'], ['--session', 'UPPER'], ['--session', 'one', '--session', 'two'],
    ['--output-format', 'json'], ['-p', 'x', '--output-format'],
    ['-p', 'x', '--output-format', 'xml'],
    ['-p', 'x', '--output-format', 'json', '--output-format', 'text'],
    ['--max-model-calls', '2'], ['--context-offload'], ['--compact-before'],
    ['-p', 'x', '--max-model-calls'], ['-p', 'x', '--max-model-calls', '0'],
    ['-p', 'x', '--max-model-calls', '-1'], ['-p', 'x', '--max-model-calls', '1.5'],
    ['-p', 'x', '--max-model-calls', 'many'],
    ['-p', 'x', '--max-model-calls', '2', '--max-model-calls', '3'],
    ['-p', 'x', '--context-offload', '--context-offload'],
    ['-p', 'x', '--compact-before', '--compact-before'],
    ['--unknown'], ['bare'],
  ]) {
    assert.throws(() => parseCliArgs(argv), CliUsageError, argv.join(' '));
  }
}

async function outputContracts(): Promise<void> {
  header('headless output and immediate denial');
  assert.equal(formatHeadlessPermissionMode('plan'), 'permission-mode: plan');
  const stderr: string[] = [];
  const bridge = createHeadlessPermissionBridge((text) => stderr.push(text));
  const decision = await bridge({
    toolName: 'bash', kind: 'execute', summary: 'bash execute: one\n two', details: [], input: {},
    risk: 'dangerous', riskReason: 'test', source: PARENT_PERMISSION_SOURCE, suggestions: [],
    withdrawn: NEVER_WITHDRAWN,
  });
  assert.deepEqual(decision, { allowed: false });
  // The headless record is deliberately provenance-free: it is a machine-read
  // protocol line for a supervisor, not a prompt someone has to attribute.
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

  // A refusal ends the SDK turn normally. With no reply it is an error that names the
  // refusal; with partial text the text is still the reply and stderr states why it
  // stopped short. Neither is the generic "completed without an assistant reply".
  await assert.rejects(() => runHeadlessTurn({
    expandSlashCommand: async () => null,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield event({ type: 'agentResultEvent', result: { stopReason: 'refusal' } });
    },
  }, 'x', () => undefined), /declined this request \(stop_reason: refusal\)/u);
  const refusalStderr: string[] = [];
  const refusedReply = await runHeadlessTurn({
    expandSlashCommand: async () => null,
    async *send(): AsyncIterable<AgentStreamEvent> {
      yield event({ type: 'contentBlockEvent', contentBlock: { type: 'textBlock', text: 'I can help with' } });
      yield event({ type: 'agentResultEvent', result: { stopReason: 'refusal' } });
    },
  }, 'x', (text) => refusalStderr.push(text));
  assert.equal(refusedReply, 'I can help with');
  assert.match(refusalStderr.join(''), /model declined this request \(stop_reason: refusal\)/u);
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


async function usageRecordContracts(): Promise<void> {
  header('headless usage record');

  // The exact shape a supervisor parses. Anchored, single line, fixed field order.
  const full = formatHeadlessUsage({
    inputTokens: 123,
    outputTokens: 456,
    cacheReadInputTokens: 789,
    cacheWriteInputTokens: 12,
  }, usageConfig('bedrock'));
  assert.equal(full, 'usage: input=123 output=456 cacheRead=789 cacheWrite=12');
  assert.match(full, /^usage: input=\d+ output=\d+ cacheRead=\d+ cacheWrite=\d+$/u);
  countedAssert('a fully reported run renders every metric numerically', true);

  const responses = formatHeadlessUsage({
    inputTokens: 1200,
    outputTokens: 45,
    cacheReadInputTokens: 800,
    cacheWriteInputTokens: 300,
  }, usageConfig('openai', 'responses'));
  assert.equal(responses, 'usage: input=100 output=45 cacheRead=800 cacheWrite=300');
  countedAssert('OpenAI Responses emits mutually exclusive cost buckets', true);

  // Absent means absent: a provider that never reported cache activity must not
  // be summed as if it had read nothing.
  const partial = formatHeadlessUsage({ inputTokens: 5, outputTokens: 7 }, usageConfig('openai', 'chat'));
  assert.equal(partial, 'usage: input=5 output=7 cacheRead=- cacheWrite=-');
  countedAssert('unreported metrics render as - rather than a false zero', true);

  const readOnly = formatHeadlessUsage(
    { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0 },
    usageConfig('openai', 'responses'),
  );
  assert.equal(readOnly, 'usage: input=- output=7 cacheRead=0 cacheWrite=-');
  countedAssert('an unknown Responses subset keeps uncached input unknown', true);

  // The supervisor-facing regex from the developer skill must accept both forms.
  const skillPattern = /^usage: input=(\d+|-) output=(\d+|-) cacheRead=(\d+|-) cacheWrite=(\d+|-)$/u;
  assert.match(full, skillPattern);
  assert.match(responses, skillPattern);
  assert.match(partial, skillPattern);
  countedAssert('the documented supervisor pattern parses both forms', true);

  // Every line is one line: a record that wrapped would break anchored parsing.
  for (const line of [full, responses, partial, readOnly]) {
    assert.doesNotMatch(line, /\n/u);
  }
  countedAssert('records never contain an embedded newline', true);

  // Child/total records exist only when a dispatch reported usage — the caller
  // gates them on `runtime.childUsage` — and mirror the `usage:` record's shape:
  // same buckets, same fixed field order, same `-` for an unreported metric.
  const children = formatHeadlessChildUsage(
    { dispatches: 2, usage: { inputTokens: 40, outputTokens: 4 } },
    usageConfig('openai', 'chat'),
  );
  assert.equal(children, 'usage-children: input=40 output=4 cacheRead=- cacheWrite=- dispatches=2');
  assert.match(children, /^usage-children: input=(\d+|-) output=(\d+|-) cacheRead=(\d+|-) cacheWrite=(\d+|-) dispatches=\d+$/u);
  countedAssert('the children record states its dispatch count and keeps - for unknowns', true);

  const totalLine = formatHeadlessTotalUsage(
    { inputTokens: 163, outputTokens: 460, cacheReadInputTokens: 789, cacheWriteInputTokens: 12 },
    usageConfig('bedrock'),
  );
  assert.equal(totalLine, 'usage-total: input=163 output=460 cacheRead=789 cacheWrite=12');
  countedAssert('the total record mirrors the usage record field for field', true);

  for (const line of [children, totalLine]) {
    assert.doesNotMatch(line, /\n/u);
  }
  countedAssert('child and total records are single lines too', true);

  // The model-calls record exists only when a completed call was observed — the
  // caller gates it on `runtime.callStats` — with a fixed field order and `-` for
  // an average no call was metered for, never 0.
  const callsLine = formatHeadlessCallStats(
    {
      calls: 12,
      meteredCalls: 12,
      usage: { inputTokens: 1200, outputTokens: 240, cacheReadInputTokens: 46_800 },
      noTool: 2,
      singleTool: 8,
      multiTool: 2,
      recentToolUseCounts: [1, 1, 0, 1, 2, 1, 1, 1, 0, 1],
    },
    usageConfig('bedrock'),
  );
  assert.equal(callsLine, 'model-calls: calls=12 avgRequestInput=4000 noTool=2 singleTool=8 multiTool=2');
  assert.match(callsLine, /^model-calls: calls=\d+ avgRequestInput=(\d+|-) noTool=\d+ singleTool=\d+ multiTool=\d+$/u);
  countedAssert('the model-calls record has a fixed field order', true);
  const unmeteredLine = formatHeadlessCallStats(
    {
      calls: 3,
      meteredCalls: 0,
      usage: undefined,
      noTool: 1,
      singleTool: 2,
      multiTool: 0,
      recentToolUseCounts: [1, 1, 0],
    },
    usageConfig('bedrock'),
  );
  assert.equal(unmeteredLine, 'model-calls: calls=3 avgRequestInput=- noTool=1 singleTool=2 multiTool=0');
  countedAssert('an unmetered average is `-`, never 0', true);
  for (const line of [callsLine, unmeteredLine]) {
    assert.doesNotMatch(line, /\n/u);
  }
  countedAssert('model-calls records are single lines', true);

  // The parent `usage:` record itself never changes shape or content because
  // children ran: it is computed from the parent meter alone.
  assert.doesNotMatch(full, /dispatches|children|total/u);
  countedAssert('the parent usage record stays byte-compatible whatever children spent', true);

  // The cost record: its own line, fixed field order, four-decimal USD or `-`.
  const costPattern =
    /^cost: total=(\d+\.\d{4}|-) input=(\d+\.\d{4}|-) output=(\d+\.\d{4}|-) cacheRead=(\d+\.\d{4}|-) cacheWrite=(\d+\.\d{4}|-) model=\S+ pricing=\S+$/u;
  const priced = {
    kind: 'priced' as const,
    litellmKey: 'global.anthropic.claude-sonnet-5',
    rates: { inputCostPerToken: 2e-6, outputCostPerToken: 1e-5, cacheReadInputTokenCost: 2e-7, cacheCreationInputTokenCost: 2.5e-6 },
  };
  const costLine = formatHeadlessCost([
    {
      config: usageConfig('bedrock'),
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 },
      lookup: priced,
    },
  ]);
  assert.equal(
    costLine,
    'cost: total=3.1250 input=2.0000 output=1.0000 cacheRead=0.1000 cacheWrite=0.0250' +
      ' model=global.anthropic.claude-opus-5 pricing=global.anthropic.claude-sonnet-5',
  );
  assert.match(costLine, costPattern);
  countedAssert('a fully reported, priced run renders every bucket and the total in four-decimal USD', true);

  // An unreported bucket is `-`, and so is the total: a floor in `total=` would be read as the total.
  const partialCost = formatHeadlessCost([
    { config: usageConfig('openai', 'chat'), usage: { inputTokens: 1_000_000, outputTokens: 100_000 }, lookup: priced },
  ]);
  assert.equal(
    partialCost,
    'cost: total=- input=2.0000 output=1.0000 cacheRead=- cacheWrite=- model=openai.gpt-5.6-sol pricing=global.anthropic.claude-sonnet-5',
  );
  assert.match(partialCost, costPattern);
  countedAssert('an unreported bucket keeps its field and the total at `-`, never 0', true);

  const unavailableCost = formatHeadlessCost([
    { config: usageConfig('bedrock'), usage: { inputTokens: 5, outputTokens: 7 }, lookup: { kind: 'unavailable' } },
  ]);
  assert.equal(unavailableCost, 'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=global.anthropic.claude-opus-5 pricing=unavailable');
  const noPriceCost = formatHeadlessCost([
    { config: usageConfig('bedrock'), usage: { inputTokens: 5, outputTokens: 7 }, lookup: { kind: 'none' } },
  ]);
  assert.equal(noPriceCost, 'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=global.anthropic.claude-opus-5 pricing=none');

  // Several models in one run: the record cannot name one model or one key, so it
  // says how many and `mixed` — each still one `\S+` token for the skill's capture —
  // and every bucket is each share priced at its own rates, summed.
  const bedrockShare = {
    config: usageConfig('bedrock'),
    usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 500_000, cacheWriteInputTokens: 10_000 },
    lookup: priced,
  };
  const solShare = {
    config: usageConfig('openai', 'chat'),
    usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 },
    lookup: {
      kind: 'priced' as const,
      litellmKey: 'bedrock_mantle/openai.gpt-5.6-sol',
      rates: { inputCostPerToken: 1e-6, outputCostPerToken: 5e-6 },
    },
  };
  const mixed = formatHeadlessCost([bedrockShare, solShare]);
  assert.equal(
    mixed,
    'cost: total=4.6250 input=3.0000 output=1.5000 cacheRead=0.1000 cacheWrite=0.0250 model=2-models pricing=mixed',
  );
  assert.match(mixed, costPattern);
  countedAssert('two priced models render each share at its own rates, summed, as `model=2-models pricing=mixed`', true);
  // One unpriced model in the mix leaves every bucket unknown: a partial sum in a field would be read as the sum.
  const mixedUnpriced = formatHeadlessCost([bedrockShare, { ...solShare, lookup: { kind: 'none' as const } }]);
  assert.equal(mixedUnpriced, 'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=2-models pricing=mixed');
  countedAssert('an unpriced model in the mix makes every field `-`, never a smaller exact-looking sum', true);
  for (const line of [costLine, partialCost, unavailableCost, noPriceCost, mixed, mixedUnpriced]) {
    assert.match(line, costPattern);
    assert.doesNotMatch(line, /\n/u);
  }
  countedAssert('unavailable and no-price runs say why in `pricing=` with every figure `-`', true);
  // The usage record is untouched by the existence of the cost record.
  assert.equal(full, 'usage: input=123 output=456 cacheRead=789 cacheWrite=12');
  countedAssert('the anchored usage record stays byte-identical beside the cost record', true);
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
  // The exact parser message, then the one `--help` hint every usage error carries (SER-048).
  assert.match(stderr, /^error: -p expects a non-empty message\.\nRun `darwin --help` for usage\.\n$/u);
  assert.doesNotMatch(stderr, /\x1b\[/u);

  // A usage failure must not touch project state.
  await assert.rejects(() => readFile(path.join(ROOT, 'never-created')), /ENOENT/u);
}


// ---------------------------------------------------------------------------
// SER-050 — piped stdin appended to the -p prompt as one delimited block.
// ---------------------------------------------------------------------------

function source(chunks: readonly (string | Uint8Array)[], isTTY?: boolean): PipedStdinSource {
  const readable = Readable.from([...chunks], { objectMode: true });
  return { isTTY, [Symbol.asyncIterator]: () => readable[Symbol.asyncIterator]() };
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function pipedStdinUnitContracts(): Promise<void> {
  header('piped stdin — reader and composer (SER-050)');

  // A terminal is never iterated: the iterator here would throw if it were touched.
  const tty: PipedStdinSource = {
    isTTY: true,
    [Symbol.asyncIterator]() {
      throw new Error('a TTY stdin must never be read');
    },
  };
  assert.equal(await readPipedStdin(tty), undefined);
  countedAssert('a TTY stdin resolves undefined without touching the stream', true);

  // /dev/null, immediate EOF and whitespace-only bytes are all "no input".
  assert.equal(await readPipedStdin(source([])), undefined);
  assert.equal(await readPipedStdin(source([' \n\t\n'])), undefined);
  assert.equal(await readPipedStdin(source([Buffer.from('\n'), Buffer.from('  ')])), undefined);
  countedAssert('empty and whitespace-only stdin resolve undefined', true);

  // Real text: the raw byte count is what the heading states, across chunk shapes.
  assert.deepEqual(await readPipedStdin(source(['alpha beta'])), { text: 'alpha beta', bytes: 10 });
  assert.deepEqual(
    await readPipedStdin(source([Buffer.from('hé'), Buffer.from('llo\n')])),
    { text: 'héllo\n', bytes: 7 },
  );
  const halves = Buffer.from('é');
  assert.deepEqual(
    await readPipedStdin(source([halves.subarray(0, 1), halves.subarray(1)])),
    { text: 'é', bytes: 2 },
  );
  countedAssert('bytes are counted raw and multi-byte sequences split across chunks decode whole', true);

  // The composed prompt: argument untouched, one blank line, one fenced block.
  const composed = composeHeadlessPrompt('review this', { text: 'alpha beta', bytes: 10 });
  assert.equal(
    composed,
    `review this\n\n${formatPipedStdinHeading(10)}\nalpha beta\n${PIPED_STDIN_FOOTER}`,
    'composed prompt',
  );
  assert.equal(formatPipedStdinHeading(10), '--- piped stdin (10 bytes) ---');
  assert.equal(PIPED_STDIN_FOOTER, '--- end of piped stdin ---');
  assert.equal(
    composeHeadlessPrompt('p', { text: 'x\n', bytes: 2 }),
    `p\n\n${formatPipedStdinHeading(2)}\nx\n${PIPED_STDIN_FOOTER}`,
    'trailing newline kept',
  );
  assert.equal(
    composeHeadlessPrompt('p', { text: 'x', bytes: 1 }).endsWith(`\nx\n${PIPED_STDIN_FOOTER}`),
    true,
  );
  assert.equal(composeHeadlessPrompt('review this', undefined), 'review this');
  assert.equal(occurrences(composed, '--- piped stdin ('), 1);
  assert.equal(occurrences(composed, PIPED_STDIN_FOOTER), 1);
  countedAssert('the block is appended once, the argument is untouched, and a trailing newline is added only when missing', true);

  // Over the cap: refused as a usage error, and the read stops at the first byte past it.
  assert.equal(PIPED_STDIN_MAX_BYTES, 256 * 1024);
  await assert.rejects(
    () => readPipedStdin(source(['abcdefgh', 'i']), 8),
    (error: unknown) => error instanceof CliUsageError
      && error.message === 'piped standard input exceeds the 8-byte cap for -p; pipe less (for example through head -c) or name a path in the message instead.',
  );
  let yielded = 0;
  let released = false;
  const endless: PipedStdinSource = {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          yielded += 1;
          yield Buffer.alloc(1024, 0x61);
        }
      } finally {
        released = true;
      }
    },
  };
  await assert.rejects(() => readPipedStdin(endless, 4096), CliUsageError);
  assert.equal(yielded, 5);
  assert.equal(released, true);
  countedAssert('a producer past the cap is abandoned after one extra chunk, never drained', true);

  // Binary: refused, never encoded.
  await assert.rejects(
    () => readPipedStdin(source([Buffer.from([0x68, 0xff, 0xfe, 0x69])])),
    (error: unknown) => error instanceof CliUsageError
      && error.message === 'piped standard input is not UTF-8 text; -p accepts text only.',
  );
  await assert.rejects(
    () => readPipedStdin(source(['text\u0000more'])),
    (error: unknown) => error instanceof CliUsageError
      && error.message === 'piped standard input contains NUL bytes; -p accepts text only.',
  );
  countedAssert('invalid UTF-8 and NUL bytes are refused as usage errors', true);

  // Structural: the reader has exactly one caller, the headless runner; interactive code
  // never names process.stdin.
  const src = path.resolve('src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/u.test(entry.name)) files.push(full);
    }
  };
  walk(src);
  const importers: string[] = [];
  const stdinUsers: string[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (/from '\.\.?\/(?:.*\/)?headless-stdin\.js'/u.test(text)) importers.push(path.relative(src, file));
    if (/process\.stdin/u.test(text)) stdinUsers.push(path.relative(src, file));
  }
  assert.deepEqual(importers, ['headless-runner.ts']);
  assert.deepEqual(stdinUsers.sort(), ['dev-repl.ts', 'headless-runner.ts', 'headless-stdin.ts']);
  assert.equal(stdinUsers.some((file) => file === 'cli.ts' || file.startsWith('tui/')), false);
  countedAssert('only the headless runner reaches the reader; cli.ts and the TUI never touch process.stdin', true);
}

const FIXTURE_RUNTIME = pathToFileURL(path.resolve('spike/fixtures/headless-runtime.ts')).href;
const FIXTURE_PROJECT_ROOT = '/tmp/darwin-headless-stdin-project-root';

interface FixtureRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The fixture runtime's trace records, or `undefined` when no runtime was created. */
  trace: Record<string, unknown>[] | undefined;
}

/**
 * Spawns the fixture headless driver (real `runHeadlessProcess`, scripted runtime) with
 * either `/dev/null` on fd 0 — exactly how every pre-existing harness and the developer
 * skill's `bash start` children launch it — or a real pipe carrying `stdin`.
 */
async function fixtureRun(
  stdin: 'ignore' | string | Buffer,
  outputFormat: 'text' | 'json' | 'stream-json' = 'text',
): Promise<FixtureRun> {
  const traceFile = path.join(os.tmpdir(), `darwin-headless-stdin-${process.pid}-${Date.now()}-${Math.random()}.jsonl`);
  rmSync(traceFile, { force: true });
  const args = ['--import', 'tsx', 'spike/fixtures/headless-cli.ts', '-p', 'fixture prompt'];
  if (outputFormat !== 'text') args.push('--output-format', outputFormat);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DARWIN_HEADLESS_FIXTURE_MODE: 'success',
      DARWIN_HEADLESS_RUNTIME_FIXTURE: FIXTURE_RUNTIME,
      DARWIN_HEADLESS_FIXTURE_PROJECT_ROOT: FIXTURE_PROJECT_ROOT,
      DARWIN_HEADLESS_FIXTURE_EXPECTED_PROJECT_ROOT: FIXTURE_PROJECT_ROOT,
      DARWIN_HEADLESS_FIXTURE_TRACE: traceFile,
    },
    stdio: [stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  if (stdin !== 'ignore') {
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(stdin);
  }
  const code = await Promise.race([
    new Promise<number | null>((resolve) => child.once('close', resolve)),
    new Promise<never>((_, reject) => setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`headless stdin fixture (${outputFormat}) did not exit within 15s`));
    }, 15_000)),
  ]);
  const trace = existsSync(traceFile)
    ? (await readFile(traceFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    : undefined;
  rmSync(traceFile, { force: true });
  return { code, stdout, stderr, trace };
}

function sendInputs(run: FixtureRun): unknown[] {
  return (run.trace ?? []).filter((record) => record.type === 'send').map((record) => record.input);
}

async function pipedStdinProcessContracts(): Promise<void> {
  header('piped stdin — real pipe through the headless runner (SER-050)');

  // Baseline: /dev/null on fd 0, the shape every existing harness spawns.
  const ignored = await fixtureRun('ignore');
  assert.equal(ignored.code, 0);
  assert.equal(ignored.stdout, 'fixture answer\n', 'ignore stdout');
  assert.equal(
    ignored.stderr,
    'session: session-fixture\n' +
    'permission-mode: default\n' +
    'tool bash — bash: printf fixture\n' +
    'tool bash — ok\n' +
    'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n' +
    'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=fake.headless pricing=unavailable\n',
    'ignore stderr',
  );
  assert.deepEqual(sendInputs(ignored), ['fixture prompt']);
  countedAssert('stdio ignore keeps the exact pre-SER-050 stdout, stderr and model-facing prompt', true);

  // Immediate EOF and whitespace-only pipes are indistinguishable from /dev/null.
  for (const [label, bytes] of [['an empty pipe', ''], ['a whitespace-only pipe', ' \n\t\n']] as const) {
    const run = await fixtureRun(bytes);
    assert.equal(run.code, 0, label);
    assert.equal(run.stdout, ignored.stdout, `${label} stdout`);
    assert.equal(run.stderr, ignored.stderr, `${label} stderr`);
    assert.deepEqual(sendInputs(run), ['fixture prompt'], label);
  }
  countedAssert('empty and whitespace-only stdin add no block and print no notice', true);

  // Real text: appended exactly once; everything else byte-identical to the baseline.
  const piped = await fixtureRun('alpha beta\n');
  const expected = composeHeadlessPrompt('fixture prompt', { text: 'alpha beta\n', bytes: 11 });
  assert.equal(piped.code, 0);
  assert.equal(piped.stdout, ignored.stdout, 'piped stdout');
  assert.equal(piped.stderr, ignored.stderr, 'piped stderr');
  assert.deepEqual(sendInputs(piped), [expected]);
  assert.equal(occurrences(expected, 'alpha beta'), 1);
  assert.equal(occurrences(expected, formatPipedStdinHeading(11)), 1);
  assert.equal(occurrences(expected, PIPED_STDIN_FOOTER), 1);
  assert.equal(expected.startsWith('fixture prompt\n\n--- piped stdin (11 bytes) ---\n'), true);
  countedAssert('piped text reaches send() exactly once inside the one delimited block', true);

  // Over the cap: a usage error before any runtime exists, in the text protocol …
  const overCap = await fixtureRun(Buffer.alloc(PIPED_STDIN_MAX_BYTES + 1, 0x61));
  assert.equal(overCap.code, 2);
  assert.equal(overCap.stdout, '');
  assert.equal(
    overCap.stderr,
    usageErrorText(`piped standard input exceeds the ${PIPED_STDIN_MAX_BYTES}-byte cap for -p; pipe less (for example through head -c) or name a path in the message instead.`),
    'over-cap stderr',
  );
  assert.equal(overCap.trace, undefined);
  countedAssert('one byte over the cap is refused with exit 2, empty stdout and no runtime', true);

  // … and in a structured format too: usage failure has no structured output contract.
  const overCapJson = await fixtureRun(Buffer.alloc(PIPED_STDIN_MAX_BYTES + 1, 0x61), 'json');
  assert.equal(overCapJson.code, 2);
  assert.equal(overCapJson.stdout, '');
  assert.equal(overCapJson.stderr, overCap.stderr, 'over-cap json stderr');
  assert.equal(overCapJson.trace, undefined);
  countedAssert('the refusal is the same human usage error under --output-format json', true);

  // Exactly at the cap is accepted.
  const atCap = await fixtureRun(Buffer.alloc(PIPED_STDIN_MAX_BYTES, 0x61));
  assert.equal(atCap.code, 0);
  assert.equal(sendInputs(atCap).length, 1);
  assert.equal(String(sendInputs(atCap)[0]).includes(formatPipedStdinHeading(PIPED_STDIN_MAX_BYTES)), true);
  countedAssert('input exactly at the cap is accepted', true);

  // Structured envelopes: unchanged apart from the composed prompt, which they never echo.
  for (const format of ['json', 'stream-json'] as const) {
    const base = await fixtureRun('ignore', format);
    const withPipe = await fixtureRun('alpha beta\n', format);
    assert.equal(base.code, 0, format);
    assert.equal(withPipe.code, 0, format);
    const strip = (text: string): string => text.replace(/"timestamp":"[^"]+"/gu, '"timestamp":"T"');
    assert.equal(strip(withPipe.stdout), strip(base.stdout), `${format} stdout`);
    assert.equal(withPipe.stderr, base.stderr, `${format} stderr`);
    assert.doesNotMatch(withPipe.stdout, /alpha beta|piped stdin|fixture prompt/u, format);
    assert.deepEqual(sendInputs(base), ['fixture prompt'], format);
    assert.deepEqual(sendInputs(withPipe), [expected], format);
  }
  countedAssert('json and stream-json output is identical with or without a pipe, and neither echoes the prompt', true);
}

await parserContracts();
await outputContracts();
await sessionContracts();
await mcpStderrContract();
await usageRecordContracts();
await usageProcessContract();
await pipedStdinUnitContracts();
await pipedStdinProcessContracts();
report();
