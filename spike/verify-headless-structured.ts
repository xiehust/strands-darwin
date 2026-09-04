/** Network-free public-protocol, lifecycle, privacy and text-compatibility checks. */
import nodeAssert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
  options: { signal?: 'SIGINT'; args?: string[]; traceFile?: string } = {},
): Promise<ProcessResult> {
  const args = ['--import', 'tsx', 'spike/fixtures/headless-cli.ts', '-p', 'fixture prompt'];
  if (outputFormat !== 'text') args.push('--output-format', outputFormat);
  args.push(...(options.args ?? []));
  const readyFile = path.join(os.tmpdir(), `darwin-headless-ready-${process.pid}-${Date.now()}-${Math.random()}`);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...BASE_ENV,
      DARWIN_HEADLESS_FIXTURE_MODE: mode,
      DARWIN_HEADLESS_RUNTIME_FIXTURE: FIXTURE,
      ...(options.signal === undefined ? {} : { DARWIN_HEADLESS_FIXTURE_READY: readyFile }),
      DARWIN_HEADLESS_FIXTURE_PROJECT_ROOT: FIXTURE_PROJECT_ROOT,
      ...(options.traceFile === undefined ? {} : { DARWIN_HEADLESS_FIXTURE_TRACE: options.traceFile }),
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
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n' +
      'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=fake.headless pricing=unavailable\n',
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
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n' +
      'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=fake.headless pricing=unavailable\n',
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
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n' +
      'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=fake.headless pricing=unavailable\n',
  });
  assert('text success/failure/interrupt stdout and stderr order are exact', true);
}


async function lifecycleObservations(): Promise<void> {
  header('structured headless — lifecycle observations are outside every output protocol');
  const cases = [
    ['success', 'success'],
    ['turn-failure', 'failure'],
    ['interrupt', 'cancelled'],
  ] as const;
  for (const [mode, outcome] of cases) {
    const traceFile = path.join(os.tmpdir(), `darwin-headless-lifecycle-${mode}-${process.pid}.jsonl`);
    rmSync(traceFile, { force: true });
    const result = await cli(mode, 'json', {
      traceFile,
      ...(mode === 'interrupt' ? { signal: 'SIGINT' as const } : {}),
    });
    const trace = (await readFile(traceFile, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    nodeAssert.deepEqual(
      trace.filter((record) => record.type === 'turnComplete'),
      [{ type: 'turnComplete', outcome, source: 'headless' }],
    );
    nodeAssert.equal(lines(result.stdout).at(-1)?.outcome, outcome);
    nodeAssert.doesNotMatch(result.stdout + result.stderr, /turnComplete|permissionRequest/u);
  }

  const traceFile = path.join(os.tmpdir(), `darwin-headless-lifecycle-permission-${process.pid}.jsonl`);
  rmSync(traceFile, { force: true });
  const permission = await cli('permission', 'json', { traceFile });
  const trace = (await readFile(traceFile, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  nodeAssert.deepEqual(
    trace.filter((record) => record.type === 'permissionRequest'),
    [{ type: 'permissionRequest', source: 'parent' }],
  );
  nodeAssert.doesNotMatch(permission.stdout + permission.stderr, /permissionRequest/u);
  assert('success/failure/cancelled and permission source publish exactly once without protocol output', true);
}

async function automaticContinuationProtocols(): Promise<void> {
  header('structured headless — one visible private continuation in every protocol');
  const traceFile = path.join(os.tmpdir(), `darwin-headless-continuation-${process.pid}.jsonl`);
  rmSync(traceFile, { force: true });
  const text = await cli('stream-interruption', 'text', { traceFile });
  nodeAssert.equal(text.code, 0);
  nodeAssert.equal(text.stdout, 'fixture answer\n');
  nodeAssert.match(text.stderr, /notice: model stream interrupted; continuing once from retained conversation/u);
  nodeAssert.doesNotMatch(text.stdout + text.stderr, /Darwin automatic continuation/u);

  const traced = (await readFile(traceFile, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const sends = traced.filter((record) => record.type === 'send');
  nodeAssert.equal(sends.length, 2);
  nodeAssert.equal(sends[0]?.input, 'fixture prompt');
  nodeAssert.match(String(sends[1]?.input), /Do not repeat completed work/u);
  nodeAssert.doesNotMatch(String(sends[1]?.input), /fixture prompt/u);

  const json = await cli('stream-interruption', 'json');
  const jsonRecords = lines(json.stdout);
  nodeAssert.equal(json.code, 0);
  nodeAssert.equal(jsonRecords.length, 1);
  nodeAssert.equal(jsonRecords[0]?.outcome, 'success');
  nodeAssert.equal(jsonRecords[0]?.continued, true);
  nodeAssert.equal(jsonRecords[0]?.result, 'fixture answer');
  nodeAssert.doesNotMatch(json.stdout, /Darwin automatic continuation/u);

  const stream = await cli('stream-interruption', 'stream-json');
  const records = lines(stream.stdout);
  nodeAssert.equal(stream.code, 0);
  nodeAssert.deepEqual(records.filter((record) => record.type === 'turn.started').length, 2);
  nodeAssert.deepEqual(records.filter((record) => record.type === 'turn.failed').length, 1);
  nodeAssert.deepEqual(records.filter((record) => record.type === 'turn.continuing').length, 1);
  nodeAssert.equal(records.at(-1)?.outcome, 'success');
  nodeAssert.equal(records.at(-1)?.continued, true);
  nodeAssert.doesNotMatch(stream.stdout, /Darwin automatic continuation|fixture prompt/u);

  const twice = await cli('stream-interruption-twice', 'stream-json');
  const twiceRecords = lines(twice.stdout);
  nodeAssert.equal(twice.code, 1);
  nodeAssert.equal(twiceRecords.filter((record) => record.type === 'turn.started').length, 2);
  nodeAssert.equal(twiceRecords.filter((record) => record.type === 'turn.continuing').length, 1);
  nodeAssert.equal(twiceRecords.at(-1)?.outcome, 'failure');
  assert('text, JSON and JSONL continuation semantics are visible, bounded and privacy-safe', true);
}


async function contextOverflowGuidance(): Promise<void> {
  header('structured headless — one bounded context-overflow projection in every failure path');
  const text = await cli('context-overflow', 'text');
  nodeAssert.equal(text.code, 1);
  nodeAssert.equal(text.stdout, '');
  nodeAssert.match(text.stderr, /error: prompt tokens .*\/compact.*narrower request.*\/clear/u);

  const json = await cli('context-overflow', 'json');
  const terminal = lines(json.stdout)[0]!;
  nodeAssert.equal(terminal.schemaVersion, 1);
  nodeAssert.equal(terminal.outcome, 'failure');
  const jsonError = (terminal.errors as { message: string; name: string }[])[0]!;
  nodeAssert.equal(jsonError.name, 'ContextWindowOverflowError');
  nodeAssert.match(jsonError.message, /\/compact.*narrower request.*\/clear/u);

  const stream = await cli('context-overflow', 'stream-json');
  const records = lines(stream.stdout);
  nodeAssert.equal(records.at(-1)?.outcome, 'failure');
  nodeAssert.equal(records.filter((record) => record.type === 'turn.continuing').length, 0);
  nodeAssert.equal(records.filter((record) => record.type === 'turn.started').length, 1);
  const streamError = (records.at(-1)?.errors as { message: string }[])[0]!;
  nodeAssert.equal(streamError.message, jsonError.message);

  const ordinary = await cli('turn-failure', 'json');
  const ordinaryMessage = ((lines(ordinary.stdout)[0]?.errors as { message: string }[])[0]?.message);
  nodeAssert.equal(ordinaryMessage, 'fixture turn failed');
  assert('text and schema-v1 structured failures share guidance while ordinary errors and no-loop ordering stay unchanged', true);
}


async function phaseControls(): Promise<void> {
  header('structured headless — phase controls precede the requested turn');
  const traceFile = path.join(os.tmpdir(), `darwin-headless-phase-${process.pid}.jsonl`);
  rmSync(traceFile, { force: true });
  const tuned = await cli('success', 'stream-json', {
    args: ['--max-model-calls', '20', '--context-offload', '--compact-before'],
    traceFile,
  });
  const traced = (await readFile(traceFile, 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  nodeAssert.deepEqual(traced.map((record) => record.type), ['create', 'compact', 'send', 'turnComplete']);
  nodeAssert.equal(traced[0]?.maxModelCalls, 20);
  nodeAssert.equal(traced[0]?.contextOffloadOverride, true);
  nodeAssert.deepEqual(lines(tuned.stdout).slice(0, 3).map((record) => record.type), [
    'session.resolved', 'run.started', 'turn.started',
  ]);

  rmSync(traceFile, { force: true });
  const failed = await cli('compact-failure', 'stream-json', {
    args: ['--compact-before'],
    traceFile,
  });
  const failedTrace = (await readFile(traceFile, 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const failedRecords = lines(failed.stdout);
  nodeAssert.deepEqual(failedTrace.map((record) => record.type), ['create', 'compact']);
  nodeAssert.ok(!failedRecords.some((record) => record.type === 'turn.started'));
  nodeAssert.equal((failedRecords.at(-1)?.errors as { stage: string }[])[0]?.stage, 'runtime');
  nodeAssert.equal(failedRecords.at(-1)?.outcome, 'failure');
  nodeAssert.equal(failed.code, 1);
  nodeAssert.equal(failed.stderr, '');
  rmSync(traceFile, { force: true });
  assert('runtime tuning reaches create, compaction precedes send, and compaction failure starts no turn', true);
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
    contextOffload: true,
    openaiApi: 'responses', modelChoices: [],
  };
  nodeAssert.deepEqual(
    structuredUsage({ inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0 }, config),
    { output: 7, cacheRead: 0 },
  );
  assert('reported zero remains zero while unsplittable/unknown metrics are absent', true);
}

async function childUsageProtocols(): Promise<void> {
  header('structured headless — child usage is additive in both protocols');

  // When dispatches reported usage, exactly two records follow `usage:` — which
  // itself stays byte-identical to the zero-dispatch run above.
  const text = await cli('child-usage', 'text');
  nodeAssert.deepEqual(text, {
    code: 0,
    stdout: 'fixture answer\n',
    stderr:
      'session: session-fixture\n' +
      'permission-mode: default\n' +
      'tool bash — bash: printf fixture\n' +
      'tool bash — ok\n' +
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n' +
      'usage-children: input=40 output=4 cacheRead=- cacheWrite=- dispatches=2\n' +
      'usage-total: input=52 output=7 cacheRead=0 cacheWrite=-\n' +
      'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=fake.headless pricing=unavailable\n',
  });
  assert('text mode appends usage-children and usage-total after the unchanged usage record, then the cost record', true);

  const json = await cli('child-usage', 'json');
  const record = lines(json.stdout)[0]!;
  nodeAssert.deepEqual(record['usage'], { input: 12, output: 3, cacheRead: 0 });
  nodeAssert.deepEqual(record['childUsage'], { input: 40, output: 4, dispatches: 2 });
  nodeAssert.deepEqual(record['totalUsage'], { input: 52, output: 7, cacheRead: 0 });
  assert('structured childUsage/totalUsage are additive beside the unchanged usage field', true);

  // Zero dispatches: the terminal record has no child fields at all — absent,
  // never an all-zero object.
  const base = await cli('success', 'json');
  const baseRecord = lines(base.stdout)[0]!;
  nodeAssert.equal('childUsage' in baseRecord, false);
  nodeAssert.equal('totalUsage' in baseRecord, false);
  nodeAssert.deepEqual(baseRecord['usage'], { input: 12, output: 3, cacheRead: 0 });
  assert('a run without reporting dispatches emits no child fields and an identical usage', true);
}

async function callStatsProtocols(): Promise<void> {
  header('structured headless — per-call stats are additive in both protocols');

  // When completed calls were observed, exactly one record follows `usage:` —
  // which itself stays byte-identical to the zero-call run below. The fixture's
  // openai/chat config makes the request total input + cacheRead: (40+100)/2 = 70.
  const text = await cli('call-stats', 'text');
  nodeAssert.deepEqual(text, {
    code: 0,
    stdout: 'fixture answer\n',
    stderr:
      'session: session-fixture\n' +
      'permission-mode: default\n' +
      'tool bash — bash: printf fixture\n' +
      'tool bash — ok\n' +
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n' +
      'cost: total=- input=- output=- cacheRead=- cacheWrite=- model=fake.headless pricing=unavailable\n' +
      'model-calls: calls=3 avgRequestInput=70 noTool=1 singleTool=2 multiTool=0\n',
  });
  assert('text mode appends model-calls after the unchanged usage and cost records', true);

  // A priced fixture: the runner reads `runtime.modelPrice` and the record carries
  // real four-decimal figures with the audited LiteLLM key. The fixture is openai/chat,
  // so cacheWrite stays unreported and the total honestly stays `-`.
  const priced = await cli('priced', 'text');
  nodeAssert.deepEqual(priced, {
    code: 0,
    stdout: 'fixture answer\n',
    stderr:
      'session: session-fixture\n' +
      'permission-mode: default\n' +
      'tool bash — bash: printf fixture\n' +
      'tool bash — ok\n' +
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n' +
      'cost: total=- input=0.0120 output=0.0300 cacheRead=0.0000 cacheWrite=- model=fake.headless pricing=openai/fake.headless\n',
  });
  assert('a priced run writes the bucket figures and the LiteLLM key, with an unreported bucket keeping total at `-`', true);

  // Two models in one run (the shape after a `/model` switch ran a turn): the record
  // cannot name one model or one key, so it says how many and `mixed` — each still one
  // `\S+` token — with each share priced at its own rates and summed; `usage:` unchanged.
  const mixedModels = await cli('mixed-models', 'text');
  nodeAssert.deepEqual(mixedModels, {
    code: 0,
    stdout: 'fixture answer\n',
    stderr:
      'session: session-fixture\n' +
      'permission-mode: default\n' +
      'tool bash — bash: printf fixture\n' +
      'tool bash — ok\n' +
      'usage: input=12 output=3 cacheRead=0 cacheWrite=-\n' +
      'cost: total=- input=0.0140 output=0.0400 cacheRead=0.0000 cacheWrite=- model=2-models pricing=mixed\n',
  });
  assert('a run over two models renders `model=2-models pricing=mixed` with each share at its own rates, usage untouched', true);

  const json = await cli('call-stats', 'json');
  const record = lines(json.stdout)[0]!;
  nodeAssert.deepEqual(record['usage'], { input: 12, output: 3, cacheRead: 0 });
  nodeAssert.deepEqual(record['callStats'], { calls: 3, avgRequestInput: 70, noTool: 1, singleTool: 2, multiTool: 0 });
  assert('structured callStats is additive beside the unchanged usage field', true);

  // Zero observed calls: the terminal record has no callStats field at all —
  // absent, never an all-zero object.
  const base = await cli('success', 'json');
  const baseRecord = lines(base.stdout)[0]!;
  nodeAssert.equal('callStats' in baseRecord, false);
  nodeAssert.deepEqual(baseRecord['usage'], { input: 12, output: 3, cacheRead: 0 });
  assert('a run without completed calls emits no callStats field and an identical usage', true);
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
await lifecycleObservations();
await automaticContinuationProtocols();
await contextOverflowGuidance();
await phaseControls();
await terminalLifecycle();
await sdkProjectionPrivacy();
usageContract();
await childUsageProtocols();
await callStatsProtocols();
boundsAndEscaping();
report();
