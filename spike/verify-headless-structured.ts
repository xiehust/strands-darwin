/** Network-free public-protocol, lifecycle, privacy and text-compatibility checks. */
import nodeAssert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import {
  Agent,
  Message,
  Model,
  type AgentStreamEvent,
  type BaseModelConfig,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

import { parseCliArgs } from '../src/cli-args.js';
import {
  StructuredHeadlessWriter,
  runStructuredHeadlessTurn,
  structuredUsage,
} from '../src/headless-protocol.js';
import { installMaxTokensRecovery } from '../src/agent/max-tokens-recovery.js';
import type { AppConfig } from '../src/config.js';
import { assert, header, report } from './shared.js';

const FIXTURE = pathToFileURL(path.join(import.meta.dirname, 'fixtures/headless-runtime.ts')).href;
const BASE_ENV = { ...process.env };
const FIXTURE_PROJECT_ROOT = '/tmp/darwin-headless-explicit-project-root';

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function cli(
  mode: string,
  outputFormat: 'text' | 'json' | 'stream-json',
  options: { signal?: 'SIGINT' } = {},
): Promise<ProcessResult> {
  const args = ['--import', 'tsx', 'spike/fixtures/headless-cli.ts', '-p', 'fixture prompt'];
  if (outputFormat !== 'text') args.push('--output-format', outputFormat);
  const readyFile = path.join(os.tmpdir(), `darwin-headless-ready-${process.pid}-${Date.now()}-${Math.random()}`);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...BASE_ENV,
      DARWIN_HEADLESS_FIXTURE_MODE: mode,
      DARWIN_HEADLESS_RUNTIME_FIXTURE: FIXTURE,
      ...(options.signal === undefined ? {} : { DARWIN_HEADLESS_FIXTURE_READY: readyFile }),
      DARWIN_HEADLESS_FIXTURE_PROJECT_ROOT: FIXTURE_PROJECT_ROOT,
      DARWIN_HEADLESS_FIXTURE_EXPECTED_PROJECT_ROOT: FIXTURE_PROJECT_ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  if (options.signal !== undefined) {
    await waitUntil(() => existsSync(readyFile));
    child.kill(options.signal);
    rmSync(readyFile, { force: true });
  }
  const code = await Promise.race([
    new Promise<number | null>((resolve) => child.once('close', resolve)),
    new Promise<never>((_, reject) => setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`headless ${mode}/${outputFormat} did not exit`));
    }, 8_000)),
  ]);
  return { code, stdout, stderr };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for fixture startup');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function lines(stdout: string): Record<string, unknown>[] {
  const raw = stdout.split('\n').filter(Boolean);
  return raw.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function parserAndTextCompatibility(): Promise<void> {
  header('structured headless — parser and exact legacy text protocol');
  nodeAssert.equal(parseCliArgs(['-p', 'x']).outputFormat, 'text');
  nodeAssert.equal(parseCliArgs(['-p', 'x', '--output-format', 'json']).outputFormat, 'json');
  nodeAssert.throws(() => parseCliArgs(['--output-format', 'json']));
  const explicitRoot = await cli('success', 'json');
  nodeAssert.equal(lines(explicitRoot.stdout)[0]?.outcome, 'success');

  nodeAssert.throws(() => parseCliArgs(['-p', 'x', '--output-format', 'bad']));
  nodeAssert.throws(() => parseCliArgs(['-p', 'x', '--output-format', 'json', '--output-format', 'text']));
  assert('parser rejects invalid structured use and the explicit project root reaches runtime creation', true);

  const success = await cli('success', 'text');
  nodeAssert.deepEqual(success, {
    code: 0,
    stdout: 'fixture answer\n',
    stderr:
      'session: session-fixture\n' +
      'permission-mode: default\n' +
      'tool bash — bash: printf fixture\n' +
      'tool bash — ok\n' +
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n',
  });
  const failure = await cli('turn-failure', 'text');
  nodeAssert.deepEqual(failure, {
    code: 1,
    stdout: '',
    stderr:
      'session: session-fixture\n' +
      'permission-mode: default\n' +
      'tool bash — bash: printf fixture\n' +
      'tool bash — ok\n' +
      'error: fixture turn failed\n' +
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n',
  });
  const interrupted = await cli('interrupt', 'text', { signal: 'SIGINT' });
  nodeAssert.deepEqual(interrupted, {
    code: 1,
    stdout: '',
    stderr:
      'session: session-fixture\n' +
      'permission-mode: default\n' +
      'tool bash — bash: printf fixture\n' +
      'tool bash — ok\n' +
      'error: Interrupted.\n' +
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n',
  });
  assert('text success/failure/interrupt stdout and stderr order are exact', true);
}

async function terminalLifecycle(): Promise<void> {
  header('structured headless — terminal lifecycle and clean channels');
  for (const [mode, outcome, stage] of [
    ['success', 'success', undefined],
    ['runtime-failure', 'failure', 'runtime'],
    ['turn-failure', 'failure', 'turn'],
    ['cleanup-failure', 'failure', 'cleanup'],
    ['persistence-failure', 'failure', 'persistence'],
  ] as const) {
    const run = await cli(mode, 'json');
    const records = lines(run.stdout);
    nodeAssert.equal(run.stderr, '');
    nodeAssert.equal(records.length, 1);
    const terminal = records[0]!;
    nodeAssert.equal(terminal.schemaVersion, 1);
    nodeAssert.equal(terminal.sequence, 1);
    nodeAssert.equal(terminal.type, 'result');
    nodeAssert.equal(terminal.outcome, outcome);
    nodeAssert.equal(run.code, outcome === 'success' ? 0 : 1);
    if (stage !== undefined) {
      nodeAssert.equal((terminal.errors as { stage: string }[])[0]?.stage, stage);
    }
  }

  const cancelled = await cli('interrupt', 'json', { signal: 'SIGINT' });
  const terminal = lines(cancelled.stdout)[0]!;
  nodeAssert.equal(cancelled.code, 1);
  nodeAssert.equal(cancelled.stderr, '');
  nodeAssert.equal(terminal.outcome, 'cancelled');
  const cancelledWithCleanup = await cli('interrupt-cleanup', 'json', { signal: 'SIGINT' });
  const cancelledCleanupTerminal = lines(cancelledWithCleanup.stdout)[0]!;
  nodeAssert.equal(cancelledCleanupTerminal.outcome, 'cancelled');
  nodeAssert.equal((cancelledCleanupTerminal.errors as { stage: string }[])[0]?.stage, 'cleanup');

  assert('JSON emits one terminal document for success, every caught failure stage and cancellation', true);

  const stream = await cli('success', 'stream-json');
  const records = lines(stream.stdout);
  nodeAssert.ok(records.some((record) => record.type === 'tool.started'));
  nodeAssert.ok(records.some((record) => record.type === 'tool.completed'));
  nodeAssert.equal(stream.stderr, '');
  nodeAssert.deepEqual(records.map((record) => record.sequence), records.map((_, index) => index + 1));
  nodeAssert.deepEqual(records.slice(0, 3).map((record) => record.type), [
    'session.resolved', 'run.started', 'turn.started',
  ]);
  nodeAssert.equal(records.at(-1)?.type, 'result');
  nodeAssert.equal(records.filter((record) => record.type === 'result').length, 1);
  const permission = await cli('permission', 'stream-json');
  const permissionRecords = lines(permission.stdout);
  nodeAssert.equal(permission.stderr, '');
  nodeAssert.equal(permissionRecords.filter((record) => record.type === 'permission.denied').length, 1);
  nodeAssert.ok(permission.stdout.includes('SECRET-PERMISSION-INPUT'));
  nodeAssert.ok(!permission.stdout.includes('SECRET-RAW-PERMISSION-INPUT'));

  assert('JSONL is live before terminal, monotonic, parseable and has one terminal result', true);
}

class AdversarialModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.adversarial', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: {
        type: 'reasoningContentDelta',
        text: 'SECRET-REASONING',
        signature: 'SECRET-SIGNATURE',
        redactedContent: new Uint8Array(Buffer.from('SECRET-REASONING-REDACTED')),
      },
    };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'BLOCKED-RAW-OUTPUT' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    yield {
      type: 'modelRedactionEvent',
      outputRedaction: {
        redactedContent: 'SECRET-GUARDRAIL-ORIGINAL',
        replaceContent: 'SAFE-REPLACEMENT',
      },
    };
  }
}

class MaxTokenModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.max', contextWindowLimit: 200_000 };
  private calls = 0;
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const first = this.calls === 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: first ? 'partial ' : 'finish' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: first ? 'maxTokens' : 'endTurn' };
  }
}

async function sdkProjectionPrivacy(): Promise<void> {
  header('structured headless — adversarial SDK privacy and post-redaction text');
  const agent = new Agent({ model: new AdversarialModel(), printer: false, systemPrompt: 'test' });
  const output: string[] = [];
  const writer = new StructuredHeadlessWriter('stream-json', (text) => output.push(text));
  writer.sessionResolved('session-adversarial');
  writer.runStarted({ permissionMode: 'default', resumed: false });
  writer.turnStarted();
  const result = await runStructuredHeadlessTurn({
    send: (input) => agent.stream(input),
    expandSlashCommand: async () => null,
  }, 'go', writer, () => 'bounded tool summary');
  writer.terminal({
    outcome: result.outcome,
    ...(result.reply === undefined ? {} : { result: result.reply }),
  });
  const serialized = output.join('');
  nodeAssert.ok(serialized.includes('SAFE-REPLACEMENT'));
  for (const secret of [
    'SECRET-REASONING', 'SECRET-SIGNATURE', 'SECRET-REASONING-REDACTED',
    'SECRET-GUARDRAIL-ORIGINAL', 'BLOCKED-RAW-OUTPUT',
  ]) nodeAssert.ok(!serialized.includes(secret), secret);
  for (const record of lines(serialized)) {
    nodeAssert.equal('agent' in record, false);
    nodeAssert.equal('invocationState' in record, false);
  }
  assert('only post-redaction completed TextBlocks are public; all private payloads are absent', true);

  const maxAgent = new Agent({ model: new MaxTokenModel(), printer: false, systemPrompt: 'test' });
  installMaxTokensRecovery(maxAgent);
  const maxOutput: string[] = [];
  const maxWriter = new StructuredHeadlessWriter('stream-json', (text) => maxOutput.push(text));
  const recovered = await runStructuredHeadlessTurn({
    send: (input) => maxAgent.stream(input),
    expandSlashCommand: async () => null,
  }, 'go', maxWriter, () => 'summary');
  nodeAssert.equal(recovered.reply, 'partial finish');
  assert('max-token recovery keeps each retained part exactly once', true);
}

function usageContract(): void {
  header('structured headless — usage unknown versus zero');
  const config: AppConfig = {
    provider: 'openai', model: 'fake', region: 'us-east-1', maxTokens: 100,
    permissionMode: 'default', promptCache: false, thinkingEffort: 'low',
    summaryRatio: 0.8, contextWarnRatio: 0.8, preserveRecentMessages: 4,
    openaiApi: 'responses', modelChoices: [],
  };
  nodeAssert.deepEqual(
    structuredUsage({ inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0 }, config),
    { output: 7, cacheRead: 0 },
  );
  assert('reported zero remains zero while unsplittable/unknown metrics are absent', true);
}

function boundsAndEscaping(): void {
  header('structured headless — bounds and one-line escaping');
  const output: string[] = [];
  const writer = new StructuredHeadlessWriter('stream-json', (text) => output.push(text));
  writer.sessionResolved('session-bounds');
  writer.assistantMessage(1, `${'😀'.repeat(8_001)}\nsecond-line`);
  writer.diagnostic({ source: 'sdk', level: 'warn', message: 'line one line two', truncated: true });
  writer.terminal({ outcome: 'success', result: 'complete\nresult' });
  const records = lines(output.join(''));
  const messages = records.filter((record) => record.type === 'assistant.message');
  nodeAssert.equal(messages.length, 2);
  nodeAssert.equal(messages.map((message) => message.text).join(''), `${'😀'.repeat(8_001)}\nsecond-line`);
  nodeAssert.equal(records.at(-1)?.result, 'complete\nresult');
  nodeAssert.equal(output.join('').split('\n').filter(Boolean).length, records.length);
  assert('long Unicode messages split without loss and JSON escaping keeps one object per line', true);
}

await parserAndTextCompatibility();
await terminalLifecycle();
await sdkProjectionPrivacy();
usageContract();
boundsAndEscaping();
report();
