/** SER-095: real runtime, scripted SDK model and local HTTP transport; no model/network service.
 * Checklist: config/default/zero; first/later silence; thinking reset; waits excluded;
 * cancellation/cleanup/reuse; failure identity/trajectory/no retry; three headless protocols.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttp2Server, type ServerHttp2Stream } from 'node:http2';
import { once } from 'node:events';
import { BedrockModel, ConstantBackoff, Model, ModelThrottledError, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath, loadConfig, withModelChoice } from '../src/config.js';
import { StreamIdleError, MAX_STREAM_IDLE_TIMEOUT_SECONDS } from '../src/agent/stream-idle.js';
import { isRetryableModelError, setModelRetryScheduleForTest } from '../src/agent/model-retry.js';
import { isRetryableStreamInterruption, runWithStreamResumption } from '../src/agent/stream-resumption.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { ownPrivateHome } from './shared.js';
import { startTui } from './tui-driver.js';

ownPrivateHome('stream-idle');
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-stream-idle-'));
const LIMIT = 0.12;
const LONG = 300;

type Step = 'ok' | 'first' | 'later' | 'thinking' | 'text' | 'slow' | 'late' | 'final' | 'tool' | 'partial-tool' | 'throttle' | 'background';
class Fixture extends Model<BaseModelConfig> {
  calls = 0;
  active = 0;
  closed = 0;
  onAbort?: () => void;
  cleanupMs = 0;
  onClose?: () => void;
  closeError = false;
  constructor(readonly steps: Step[]) { super(); }
  updateConfig(): void {}
  getConfig(): BaseModelConfig { return { modelId: 'fixture.idle', contextWindowLimit: 32000 }; }
  async *stream(_messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const child = !options?.toolSpecs?.some(spec => spec.name === 'subagent');
    const step = child ? 'slow' : this.steps[this.calls++] ?? 'ok';
    this.active++;
    try {
      if (step === 'throttle') throw new ModelThrottledError('fixture throttle');
      if (step === 'first') await this.silence(options);
      if (step === 'slow') await delay(LONG, undefined, { signal: options?.cancelSignal });
      // Deliberately ignores abort but eventually settles: never detach its read.
      if (step === 'late') await delay(LONG);
      yield { type: 'modelMessageStartEvent', role: 'assistant' };
      if (step === 'tool' || step === 'partial-tool' || step === 'background') {
        const background = step === 'background';
        yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: background ? 'subagent' : 'bash', toolUseId: 'idle-tool' } };
        const input = background ? { task: 'count files', _background_execution: true } : { mode: 'execute', command: 'sleep 0.3; printf tool-done' };
        yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
        if (step === 'partial-tool') await this.silence(options);
        yield { type: 'modelContentBlockStopEvent' };
        yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
        return;
      }
      yield { type: 'modelContentBlockStartEvent' };
      if (step === 'thinking' || step === 'text') {
        for (let i = 0; i < 8; i++) {
          await delay(40, undefined, { signal: options?.cancelSignal });
          yield { type: 'modelContentBlockDeltaEvent', delta: step === 'thinking'
            ? { type: 'reasoningContentDelta', text: 'thinking' }
            : { type: 'textDelta', text: 'delayed text' } };
        }
        yield { type: 'modelContentBlockStopEvent' };
        yield { type: 'modelContentBlockStartEvent' };
      }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'healthy' } };
      if (step === 'later') await this.silence(options);
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
      if (step === 'final') await this.silence(options);
    } finally {
      this.active--;
      this.closed++;
      this.onClose?.();
      if (this.closeError) throw new Error('fixture cleanup failed');
    }
  }
  private async silence(options?: StreamOptions): Promise<void> {
    const signal = options?.cancelSignal;
    assert(signal);
    try { await delay(10_000, undefined, { signal }); }
    catch (error) {
      this.onAbort?.();
      await delay(this.cleanupMs);
      throw error;
    }
  }
}

async function configure(fields: Record<string, unknown> = {}): Promise<void> {
  await writeFile(configPath(), JSON.stringify({ provider: 'openai', model: 'fixture.idle', promptCache: false, contextOffload: false, memory: false, streamIdleTimeoutSeconds: LIMIT, ...fields }));
}
async function runtime(model: Model, fields: Record<string, unknown> = {}, permission = async () => ({ allowed: true })): Promise<AgentRuntime> {
  await configure(fields);
  setRuntimeModelFactoryForTest(async () => model);
  return AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: permission });
}
async function consume(rt: AgentRuntime) {
  const events = [];
  let failure: unknown;
  try { for await (const event of rt.send('fixture')) events.push(event); }
  catch (error) { failure = error; }
  return { events, failure };
}


async function contracts(): Promise<void> {
  await configure({ streamIdleTimeoutSeconds: undefined });
  const defaults = await loadConfig(root);
  assert.equal(defaults.streamIdleTimeoutSeconds, 120);
  assert.equal(withModelChoice(defaults, defaults.modelChoices[0]!).streamIdleTimeoutSeconds, 120);
  for (const value of [0, LIMIT, 1, MAX_STREAM_IDLE_TIMEOUT_SECONDS]) {
    await configure({ streamIdleTimeoutSeconds: value });
    assert.equal((await loadConfig(root)).streamIdleTimeoutSeconds, value);
  }
  for (const value of [-1, '120', null, MAX_STREAM_IDLE_TIMEOUT_SECONDS + 1]) {
    await configure({ streamIdleTimeoutSeconds: value });
    await assert.rejects(loadConfig(root), /streamIdleTimeoutSeconds/);
  }
  await writeFile(configPath(), JSON.stringify({ models: [{ provider: 'openai', model: 'fixture', enable: true, streamIdleTimeoutSeconds: 1 }] }));
  await assert.rejects(loadConfig(root), /streamIdleTimeoutSeconds/);
  console.log('PASS config defaults, zero, range and root-only placement');

  for (const step of ['first', 'later', 'partial-tool', 'final', 'late'] as const) {
    const model = new Fixture([step, 'ok']);
    const rt = await runtime(model);
    const start = Date.now();
    let continuing = 0;
    let seen: Awaited<ReturnType<typeof consume>> | undefined;
    let caught: unknown;
    try {
      await runWithStreamResumption('fixture', async () => {
        seen = await consume(rt);
        if (seen.failure) throw seen.failure;
      }, () => continuing++);
    } catch (error) { caught = error; }
    assert(caught instanceof StreamIdleError);
    assert.equal(caught.message, `stream idle for ${LIMIT}s`);
    assert.equal(seen?.events.find(event => event.type === 'afterModelCallEvent')?.error, caught);
    assert(!isRetryableStreamInterruption(caught));
    assert(!isRetryableModelError(caught));
    assert.equal(continuing, 0);
    assert.equal(model.calls, 1);
    assert.equal(model.active, 0);
    assert.equal(model.closed, 1);
    assert(Date.now() - start < 2000);
    assert(!seen?.events.some(event => event.type === 'beforeToolCallEvent'));
    assert.equal((await consume(rt)).failure, undefined);
    assert.equal(model.calls, 2);
    const file = rt.trajectoryStatus!.file;
    await rt.shutdown();
    const recorded = await readTrajectory(file);
    const ends = recorded.records.filter(record => record.type === 'turnEnded');
    assert.equal(ends[0]?.failure?.name, 'StreamIdleError');
    assert.equal(ends[0]?.failure?.message, `stream idle for ${LIMIT}s`);
    assert.equal(ends.length, 2);
    console.log(`PASS ${step}: bounded failure identity, recording, no continuation/tool, reuse`);
  }

  for (const step of ['ok', 'thinking', 'text', 'slow'] as const) {
    const model = new Fixture([step]);
    const rt = await runtime(model, step === 'slow' ? { streamIdleTimeoutSeconds: 0 } : {});
    const seen = await consume(rt);
    assert.equal(seen.failure, undefined);
    assert(seen.events.some(event => event.type === 'agentResultEvent' && event.result.stopReason === 'endTurn'));
    assert.equal(model.active, 0);
    await rt.shutdown();
  }
  console.log('PASS healthy stream, delayed text/thinking resets, zero disabled');

  for (const race of ['before', 'during-cleanup'] as const) {
    const model = new Fixture(['first', 'ok']);
    model.cleanupMs = 40;
    const rt = await runtime(model);
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    if (race === 'before') cancelTimer = setTimeout(() => rt.cancel(), 60);
    else model.onAbort = () => rt.cancel();
    const seen = await consume(rt);
    clearTimeout(cancelTimer);
    assert.equal(seen.failure, undefined);
    assert(seen.events.some(event => event.type === 'agentResultEvent' && event.result.stopReason === 'cancelled'));
    assert.equal(model.active, 0);
    assert.equal(model.closed, 1);
    assert.equal((await consume(rt)).failure, undefined);
    await rt.shutdown();
  }
  console.log('PASS cancel wins before deadline and during abort cleanup; later invocation usable');

  let prompts = 0;
  const model = new Fixture(['tool', 'ok']);
  const rt = await runtime(model, {}, async () => { prompts++; await delay(LONG); return { allowed: true }; });
  const seen = await consume(rt);
  assert.equal(seen.failure, undefined);
  assert.equal(prompts, 1);
  assert.equal(model.calls, 2);
  assert(seen.events.some(event => event.type === 'afterToolCallEvent'));
  await rt.shutdown();
  console.log('PASS permission and real shell waits longer than idle limit');

  setModelRetryScheduleForTest(() => ({ maxAttempts: 2, backoff: new ConstantBackoff({ delayMs: LONG }) }));
  const retryModel = new Fixture(['throttle', 'ok']);
  const retry = await runtime(retryModel);
  assert.equal((await consume(retry)).failure, undefined);
  assert.equal(retryModel.calls, 2);
  await retry.shutdown();
  setModelRetryScheduleForTest(undefined);
  console.log('PASS deliberate throttle wait excluded');

  const bgModel = new Fixture(['background', 'ok', 'ok']);
  const bg = await runtime(bgModel);
  const started = Date.now();
  assert.equal((await consume(bg)).failure, undefined);
  assert(Date.now() - started >= LONG);
  assert.equal(bgModel.active, 0);
  assert(bgModel.closed >= 3, 'parent plus child completed');
  await bg.shutdown();
  console.log('PASS background completion and child stream exceed parent idle limit');

  for (const action of ['pause', 'cancel', 'abandon'] as const) {
    const fixture = new Fixture(['thinking', 'ok']);
    const instance = await runtime(fixture);
    let first = true;
    for await (const event of instance.send('consumer boundary')) {
      if (event.type !== 'modelStreamUpdateEvent' || !first) continue;
      first = false;
      if (action === 'pause') await delay(LONG);
      if (action === 'cancel') instance.cancel();
      if (action === 'abandon') break;
    }
    assert.equal(fixture.active, 0, `${action}: iterator closed`);
    assert.equal(fixture.closed, 1);
    assert.equal((await consume(instance)).failure, undefined);
    await instance.shutdown();
  }
  console.log('PASS consumer backpressure excluded, between-yield cancel and abandonment cleanup');

  for (const cancel of [false, true]) {
    const fixture = new Fixture(['late', 'ok']);
    const instance = await runtime(fixture);
    fixture.closeError = true;
    if (cancel) fixture.onClose = () => instance.cancel();
    const seen = await consume(instance);
    assert.equal(fixture.active, 0);
    if (cancel) {
      assert.equal(seen.failure, undefined);
      assert(seen.events.some(event => event.type === 'agentResultEvent' && event.result.stopReason === 'cancelled'));
    } else assert(seen.failure instanceof StreamIdleError, 'cleanup error cannot replace idle identity');
    fixture.closeError = false;
    delete fixture.onClose;
    assert.equal((await consume(instance)).failure, undefined);
    await instance.shutdown();
  }
  console.log('PASS late-yield cleanup error preserves idle identity; user cancel in finally wins');
}

async function transport(): Promise<void> {
  setRuntimeModelFactoryForTest(undefined);
  let requests = 0;
  let closed = 0;
  let headers = true;
  const server = createServer((request, response) => {
    request.resume();
    requests++;
    response.on('close', () => closed++);
    if (headers) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
    }
    // Intentionally silent real transport. The client must disconnect itself.
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const baseURL = `http://127.0.0.1:${address.port}`;
  process.env['OPENAI_API_KEY'] = 'local-fixture';
  process.env['ANTHROPIC_API_KEY'] = 'local-fixture';
  try {
    for (const provider of (process.argv[2] === 'bedrock-tui' ? [] : ['openai', 'anthropic'] as const)) {
      for (headers of [true, false]) {
        for (const format of ['text', 'json', 'stream-json'] as const) {
          await configure({ provider, ...(provider === 'anthropic' ? { baseUrl: baseURL } : {}) });
          const before = requests;
          const result = await cli(format, { OPENAI_BASE_URL: baseURL });
          assert.equal(result.code, 1, result.stderr);
          assert.equal(result.stderr.split('\n').filter(line => line.startsWith('stream:')).length, 1, result.stderr);
          assert(result.stderr.includes(`stream: stream idle for ${LIMIT}s`));
          assert.equal(requests - before, 1, 'no provider retry or continuation');
          assert.equal(closed, requests, 'HTTP request closed before process exits');
          if (format === 'text') assert(result.stderr.includes('error: stream idle'));
          else {
            const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line));
            const finished = rows.at(-1);
            assert.equal(finished.outcome, 'failure', result.stdout);
            assert(result.stdout.includes('StreamIdleError'));
            assert(!finished.continued);
            // Ordinary terminal failures live in result.errors. turn.failed
            // is emitted only for the original interrupted turn before continuation.
            assert.equal(finished.errors[0].stage, 'turn');
            assert.equal(finished.errors[0].name, 'StreamIdleError');
            if (format === 'stream-json') {
              assert.equal(rows.filter(row => row.type === 'turn.failed').length, 0);
              assert.equal(rows.filter(row => row.type === 'turn.continuing').length, 0);
            }
          }
          console.log(`PASS ${provider}/${headers ? 'body' : 'pre-header'}/${format}: one diagnostic, failure, socket closed`);
          const cancelled = await cli(format, { OPENAI_BASE_URL: baseURL }, server);
          assert.equal(cancelled.code, 1);
          assert(!cancelled.stderr.includes('stream:'), cancelled.stderr);
          assert(!cancelled.stdout.includes('StreamIdleError'), cancelled.stdout);
          if (format !== 'text') assert.equal(JSON.parse(cancelled.stdout.trim().split('\n').at(-1)!).outcome, 'cancelled');
          assert.equal(closed, requests);
          console.log(`PASS ${provider}/${headers ? 'body' : 'pre-header'}/${format}: user cancel, no idle diagnostic`);
        }
      }
    }
    const h2 = createHttp2Server();
    const sessions = new Set<import('node:http2').ServerHttp2Session>();
    h2.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
    let h2Requests = 0;
    let h2Closed = 0;
    h2.on('stream', stream => {
      h2Requests++;
      stream.resume();
      stream.on('error', () => undefined);
      stream.on('close', () => h2Closed++);
      if (headers) (stream as ServerHttp2Stream).respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream' });
    });
    h2.listen(0, '127.0.0.1');
    await once(h2, 'listening');
    const h2Address = h2.address();
    assert(h2Address && typeof h2Address !== 'string');
    try {
      for (headers of [true, false]) {
        const model = new BedrockModel({ modelId: 'fixture.bedrock', region: 'us-west-2', clientConfig: {
          endpoint: `http://127.0.0.1:${h2Address.port}`, credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
          requestHandler: { requestTimeout: 5000 },
        } });
        const rt = await runtime(model);
        const seen = await consume(rt);
        assert(seen.failure instanceof StreamIdleError, String(seen.failure));
        await rt.shutdown();
        setRuntimeModelFactoryForTest(undefined);
        await delay(20);
        assert.equal(h2Closed, h2Requests);
        console.log(`PASS bedrock/${headers ? 'body' : 'pre-header'}: abort closes local HTTP/2 stream`);
      }
      assert.equal(h2Requests, 2);
    } finally {
      for (const session of sessions) session.destroy();
      h2.close();
    }

    await configure({ provider: 'openai', streamIdleTimeoutSeconds: 0.3 });
    headers = true;
    const tui = startTui({ cwd: root, env: { OPENAI_BASE_URL: baseURL }, cols: 100, rows: 24 });
    try {
      await tui.waitFor('you>', { timeoutMs: 10_000 });
      tui.submit('idle fixture');
      await tui.waitFor('turn failed: stream idle for 0.3s', { timeoutMs: 10_000 });
      await tui.waitUntil(() => !tui.frame.includes('working…'), { settleMs: 80, timeoutMs: 5000 });
      const from = tui.mark();
      tui.submit('second fixture');
      await tui.waitFor('turn failed: stream idle for 0.3s', { from, timeoutMs: 10_000 });
      await tui.waitUntil(() => !tui.frame.includes('working…'), { settleMs: 80, timeoutMs: 5000 });
      tui.submit('/exit');
      assert.equal(await tui.exitedWithin(5000), 0);
      console.log('PASS production TUI: visible terminal failure and next invocation usable');
    } finally { tui.kill(); }
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
async function cli(format: string, env: Record<string, string>, cancelOnRequest?: ReturnType<typeof createServer>) {
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.resolve(import.meta.dirname, '../src/cli.ts'), '-p', 'fixture', '--output-format', format], {
    cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { cancelTimer = setTimeout(() => child.kill('SIGINT'), 25); };
  cancelOnRequest?.once('request', cancel);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    clearTimeout(cancelTimer);
    cancelOnRequest?.off('request', cancel);
  }
}

try {
  if (process.argv[2] === undefined || process.argv[2] === 'contracts') await contracts();
  if (process.argv[2] !== 'contracts') await transport();
  console.log('stream idle: all contracts passed');
} finally {
  setRuntimeModelFactoryForTest(undefined);
  setModelRetryScheduleForTest(undefined);
  await rm(root, { recursive: true, force: true });
}
