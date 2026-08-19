/** Focused, network-free verification for managed background bash jobs. */
import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Agent, Model, type BaseModelConfig, type InvokableTool, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import type { BashInput, BashOutput } from '@strands-agents/sdk/vended-tools/bash';

import {
  PermissionGate,
  assessRisk,
  classify,
  type AssessedPermissionRequest,
  type ApprovalMode,
  type SafetyClassifier,
} from '../src/agent/permission.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import { ToolHookGate } from '../src/hooks/tool-hooks.js';
import {
  BackgroundBashManager,
  createBackgroundBashTool,
  type BackgroundTaskStatus,
  type BackgroundWaitResult,
} from '../src/tools/background-bash.js';
import { assert, header, report } from './shared.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 3_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accept(value) && Date.now() < deadline) {
    await delay(20);
    value = await read();
  }
  return value;
}

function exists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}


class BashStartModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.background-hooks', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasResult = messages.some((message) => message.content.some((block) => block.type === 'toolResultBlock'));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'background-1' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"mode":"start","command":"sleep 1000"}' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

class ChildBackgroundModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.background-child', contextWindowLimit: 200_000 };
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const result = messages.flatMap((message) => message.content).find((block) => block.type === 'toolResultBlock');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (result === undefined) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'child-start' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: '{"mode":"start","command":"sleep 1000"}' } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    const text = JSON.stringify(result);
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function fakeConfig() {
  return {
    provider: 'bedrock',
    model: 'fake.background-child',
    region: 'us-west-2',
    maxTokens: 1000,
    permissionMode: 'yolo',
    promptCache: false,
    thinkingEffort: 'high',
    summaryRatio: 0.8, contextWarnRatio: 0.8,
    preserveRecentMessages: 4,
    modelChoices: [],
  } as const;
}

async function permissionAction(
  root: string,
  mode: ApprovalMode,
  input: { mode: 'start'; command: string },
  options: { allowRules?: readonly string[]; classifier?: SafetyClassifier } = {},
): Promise<{ action: { type: string; reason?: string }; asked: AssessedPermissionRequest[]; classified: AssessedPermissionRequest[] }> {
  const asked: AssessedPermissionRequest[] = [];
  const classified: AssessedPermissionRequest[] = [];
  const classifier = options.classifier === undefined ? undefined : async (request: AssessedPermissionRequest) => {
    classified.push(request);
    return options.classifier!(request);
  };
  const gate = new PermissionGate({
    mode,
    projectRoot: root,
    ask: async (request) => { asked.push(request); return { allowed: true }; },
    ...(options.allowRules === undefined ? {} : { allowRules: options.allowRules }),
    ...(classifier === undefined ? {} : { classifier }),
  });
  // `agent` is part of the real event and the gate reads its id for provenance;
  // a fixture without one would test a shape the SDK never produces.
  const event = { toolUse: { name: 'bash', input }, agent: { id: 'darwin' } } as never;
  const action = await gate.beforeToolCall(event) as { type: string; reason?: string };
  return { action, asked, classified };
}


async function managerContracts(): Promise<void> {
  header('background bash — launch, output, status, stop');
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-background-'));
  const manager = new BackgroundBashManager(root, 'session-same');
  try {
    assert('an empty manager lists no tasks', (await manager.list()).length === 0);
    const terminalEvents: BackgroundTaskStatus[] = [];
    const unsubscribe = manager.subscribe((task) => { terminalEvents.push(task); });

    const before = Date.now();
    const started = await manager.start("printf 'out\\n'; sleep .15; printf 'err\\n' >&2; exit 7");
    assert('start returns before delayed command completes', Date.now() - before < 140);
    assert('start returns opaque id, pid, and absolute log path', started.taskId.startsWith('bg-') && started.pid > 0 && path.isAbsolute(started.outputPath));

    const terminal = await eventually(() => manager.status(started.taskId), (status) => status.state !== 'running');
    await eventually(async () => terminalEvents.length, (count) => count === 1);
    assert('failure publishes exactly one terminal snapshot with metadata', terminalEvents[0]?.taskId === started.taskId && terminalEvents[0].exitCode === 7);
    const listedAfterFailure = await manager.list();
    assert('list retains the full status contract and command', listedAfterFailure.length === 1 && listedAfterFailure[0]?.command === "printf 'out\\n'; sleep .15; printf 'err\\n' >&2; exit 7" && listedAfterFailure[0].outputPath === started.outputPath);

    assert('nonzero command reaches failed with exit metadata', terminal.state === 'failed' && terminal.exitCode === 7 && terminal.finishedAt !== null);
    const output = await manager.output(started.taskId);
    assert('stdout and stderr share retained file', output.output === 'out\nerr\n' && (await readFile(started.outputPath, 'utf8')) === output.output);

    const large = await manager.start("node -e \"process.stdout.write('a'.repeat(65535) + '€' + 'z')\"");
    await eventually(() => manager.status(large.taskId), (status) => status.state === 'succeeded');
    const launchOrder = await manager.list();
    assert('list order is deterministic launch order', launchOrder[0]?.taskId === started.taskId && launchOrder[1]?.taskId === large.taskId);

    const [first, second] = await Promise.all([manager.output(large.taskId), manager.output(large.taskId)]);
    assert('concurrent reads consume disjoint ordered cursor ranges', first.startOffset === 0 && second.startOffset === first.endOffset);
    assert('UTF-8 boundary is complete and hasMore leads to remainder', first.output.endsWith('€') && first.hasMore && second.output === 'z' && !second.hasMore);


    const split = await manager.start("printf '\\342'; sleep .15; printf '\\202\\254'; sleep 1000");
    await eventually(async () => (await readFile(split.outputPath)).length, (size) => size === 1);
    const partial = await manager.output(split.taskId);
    assert('growing log withholds an incomplete UTF-8 code point and cursor', partial.output === '' && partial.startOffset === 0 && partial.endOffset === 0 && partial.hasMore);
    const completed = await eventually(() => manager.output(split.taskId), (chunk) => chunk.output !== '');
    assert('later read returns the split code point intact without replacement', completed.output === '€' && completed.startOffset === 0 && completed.endOffset === 3);
    await manager.stop(split.taskId);

    const malformed = await manager.start("printf '\\377'");
    await eventually(() => manager.status(malformed.taskId), (status) => status.state === 'succeeded');
    assert('malformed bytes at terminal EOF cannot stall cursor', (await manager.output(malformed.taskId)).output === '�');

    const childFile = path.join(root, 'descendant.pid');
    const running = await manager.start(`sleep 1000 & echo $! > ${childFile}; wait`);
    const descendant = Number((await eventually(() => readFile(childFile, 'utf8').catch(() => ''), Boolean)).trim());
    const [stop1, stop2] = await Promise.all([manager.stop(running.taskId), manager.stop(running.taskId)]);
    assert('concurrent stop is idempotent and stable', stop1.state === 'stopped' && stop2.state === 'stopped');
    await eventually(async () => exists(descendant), (alive) => !alive);
    await eventually(async () => terminalEvents.filter((event) => event.taskId === running.taskId).length, (count) => count === 1);
    assert('concurrent stop publishes exactly one stopped event', terminalEvents.filter((event) => event.taskId === running.taskId && event.state === 'stopped').length === 1);

    assert('stop reaps the process-group descendant', !exists(descendant));

    const stubbornChildFile = path.join(root, 'stubborn-descendant.pid');
    const stubborn = await manager.start(
      `trap '' TERM; /bin/bash -c 'trap "" TERM; echo $$ > ${stubbornChildFile}; while :; do sleep 1; done' & wait`,
    );
    const stubbornChild = Number((await eventually(() => readFile(stubbornChildFile, 'utf8').catch(() => ''), Boolean)).trim());
    const stubbornBefore = Date.now();
    const stubbornStopped = await manager.stop(stubborn.taskId);
    const stubbornElapsed = Date.now() - stubbornBefore;
    assert('explicit stop escalates against a TERM-ignoring process group', stubbornStopped.state === 'stopped' && !exists(stubborn.pid) && !exists(stubbornChild));
    assert('TERM-to-KILL stop remains within its fixed bound', stubbornElapsed >= 450 && stubbornElapsed < 1_300);


    const escapedFile = path.join(root, 'natural-descendant.pid');
    const natural = await manager.start(`trap '' TERM; sleep 1000 & echo $! > ${escapedFile}; exit 0`);
    const escaped = Number((await eventually(() => readFile(escapedFile, 'utf8').catch(() => ''), Boolean)).trim());
    const naturalTerminal = await eventually(() => manager.status(natural.taskId), (status) => status.state !== 'running', 3_000);
    assert('natural leader exit cleans stubborn descendants before success', naturalTerminal.state === 'succeeded' && !exists(escaped));
    await eventually(async () => terminalEvents.filter((event) => event.taskId === natural.taskId).length, (count) => count === 1);
    assert('natural success publishes exactly once', terminalEvents.filter((event) => event.taskId === natural.taskId && event.state === 'succeeded').length === 1);

    unsubscribe();
    const afterUnsubscribe = await manager.start('true');
    await eventually(() => manager.status(afterUnsubscribe.taskId), (status) => status.state === 'succeeded');
    assert('unsubscribe suppresses later terminal events', terminalEvents.every((event) => event.taskId !== afterUnsubscribe.taskId));

    let isolatedDelivered = false;
    manager.subscribe(() => { throw new Error('listener failure'); });
    manager.subscribe(async () => { throw new Error('async listener failure'); });
    const unsubscribeIsolated = manager.subscribe(() => { isolatedDelivered = true; });
    const isolated = await manager.start('true');
    await eventually(() => manager.status(isolated.taskId), (status) => status.state === 'succeeded');
    await eventually(async () => isolatedDelivered, Boolean);
    assert('listener failures do not suppress cleanup or other listeners', isolatedDelivered);
    unsubscribeIsolated();

    let closeFailureDelivered = false;
    const snapshotCloseFailure = new BackgroundBashManager(root, 'session-snapshot-close-failure', async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      if (args[1] !== 'wx') {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          await originalClose();
          throw new Error('synthetic snapshot close failure');
        };
      }
      return handle;
    });
    snapshotCloseFailure.subscribe(() => { closeFailureDelivered = true; });
    const closeFailureTask = await snapshotCloseFailure.start('true');
    const closeFailureStatus = await eventually(
      () => snapshotCloseFailure.status(closeFailureTask.taskId),
      (status) => status.state === 'succeeded',
    );
    await eventually(async () => closeFailureDelivered, Boolean);
    assert('diagnostic handle close failure degrades metadata without suppressing the event', closeFailureStatus.outputBytes === null && closeFailureDelivered);
    await snapshotCloseFailure.shutdown();



    const deleted = await manager.start('printf retained');
    await eventually(() => manager.status(deleted.taskId), (status) => status.state === 'succeeded');
    await unlink(deleted.outputPath);
    const metadata = await manager.status(deleted.taskId);
    assert('status survives externally deleted log', metadata.outputBytes === null);
    let deletedError = '';
    try { await manager.output(deleted.taskId); } catch (error) { deletedError = String(error); }
    assert('deleted log fails clearly', deletedError.includes(deleted.outputPath));

    let unknownError = '';
    try { await manager.output('../../etc/passwd'); } catch (error) { unknownError = String(error); }
    assert('malformed id is rejected without becoming a path', unknownError.includes('Invalid background bash task id'));
    const secret = path.join(root, 'secret.txt');
    const secretHandle = await open(secret, 'w');
    await secretHandle.writeFile('do-not-read');
    await secretHandle.close();
    const replaced = await manager.start('printf original');
    await eventually(() => manager.status(replaced.taskId), (status) => status.state === 'succeeded');
    await unlink(replaced.outputPath);
    await symlink(secret, replaced.outputPath);
    let replacedError = '';
    try { await manager.output(replaced.taskId); } catch (error) { replacedError = String(error); }
    assert('replaced log cannot turn safe output into arbitrary file read', replacedError.includes(replaced.outputPath));



    const resumed = new BackgroundBashManager(root, 'session-same');
    const collisionA = await manager.start('true');
    const collisionB = await resumed.start('true');
    assert('same resumed session never overwrites a prior log', collisionA.outputPath !== collisionB.outputPath);
    await resumed.shutdown();
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}


async function waitContracts(): Promise<void> {
  header('background bash — bounded wait with incremental output');
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-background-wait-'));
  const manager = new BackgroundBashManager(root, 'session-wait');
  try {
    const immediate = await manager.start("printf 'ready\\n'; sleep 1000");
    await eventually(async () => (await readFile(immediate.outputPath)).length, (size) => size > 0);
    const immediateBefore = Date.now();
    const immediateResult = await manager.wait(immediate.taskId, 500);
    assert('wait returns immediately with newly available output', immediateResult.reason === 'output' && immediateResult.output.output === 'ready\n' && Date.now() - immediateBefore < 200);

    const quiet = await manager.start('sleep 1000');
    const timeoutBefore = Date.now();
    const timedOut = await manager.wait(quiet.taskId, 80);
    const timeoutElapsed = Date.now() - timeoutBefore;
    assert('quiet wait returns empty running snapshot only at its finite timeout', timedOut.reason === 'timeout' && timedOut.status.state === 'running' && timedOut.output.output === '' && timeoutElapsed >= 60 && timeoutElapsed < 300);

    const terminal = await manager.start('sleep .08; exit 0');
    const terminalBefore = Date.now();
    const terminalResult = await manager.wait(terminal.taskId, 1_000);
    assert('wait wakes promptly on terminal transition', terminalResult.reason === 'terminal' && terminalResult.status.state === 'succeeded' && Date.now() - terminalBefore < 500);

    const growing = await manager.start("sleep .05; printf 'one'; sleep .08; printf 'two'; sleep 1000");
    const first = await manager.wait(growing.taskId, 500);
    const second = await manager.wait(growing.taskId, 500);
    assert('successive waits consume incremental output once and in order', first.output.output === 'one' && second.output.output === 'two' && first.output.endOffset === second.output.startOffset);

    const split = await manager.start("printf '\\342'; sleep .08; printf '\\202\\254'; sleep 1000");
    await eventually(async () => (await readFile(split.outputPath)).length, (size) => size === 1);
    const splitResult = await manager.wait(split.taskId, 500);
    assert('wait holds a growing UTF-8 suffix until it can return one complete code point', splitResult.reason === 'output' && splitResult.output.output === '€' && splitResult.output.startOffset === 0 && splitResult.output.endOffset === 3);

    const concurrent = await manager.start("printf 'shared'; sleep 1000");
    await eventually(async () => (await readFile(concurrent.outputPath)).length, (size) => size === 6);
    const [waited, polled] = await Promise.all([
      manager.wait(concurrent.taskId, 80),
      manager.output(concurrent.taskId),
    ]);
    const concurrentChunks = [waited.output, polled].sort((left, right) => left.startOffset - right.startOffset);
    assert(
      'concurrent wait/output share one cursor without duplicate or skipped bytes',
      concurrentChunks.map((chunk) => chunk.output).join('') === 'shared' && concurrentChunks[0]?.endOffset === concurrentChunks[1]?.startOffset,
    );

    const competing = await manager.start("sleep .08; printf 'winner'; sleep 1000");
    const competingWaits = await Promise.all([
      manager.wait(competing.taskId, 500),
      manager.wait(competing.taskId, 500),
    ]);
    assert(
      'concurrent waits return on shared cursor state change instead of idling to timeout',
      competingWaits.some((result) => result.reason === 'output' && result.output.output === 'winner') &&
        competingWaits.some((result) => result.reason === 'changed' && result.output.output === ''),
    );

    const cancellable = await manager.start('sleep 1000');
    const controller = new AbortController();
    const cancelBefore = Date.now();
    const cancelledPromise = manager.wait(cancellable.taskId, 30_000, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const cancelled = await cancelledPromise;
    assert('caller cancellation releases wait promptly without stopping its task', cancelled.reason === 'cancelled' && cancelled.status.state === 'running' && Date.now() - cancelBefore < 300 && exists(cancellable.pid));

    for (const badWait of [0, 30_001, 1.5, Number.NaN]) {
      let waitError = '';
      try { await manager.wait(quiet.taskId, badWait); } catch (error) { waitError = String(error); }
      assert('manager rejects wait bounds even outside provider validation', waitError.includes('integer from 1 to 30000'));
    }
    let invalidId = '';
    try { await manager.wait('not-owned', 10); } catch (error) { invalidId = String(error); }
    let unknownId = '';
    try { await manager.wait('bg-00000000-0000-0000-0000-000000000000', 10); } catch (error) { unknownId = String(error); }
    assert('wait rejects a well-formed id outside this runtime', unknownId.includes('Unknown background bash task'));

    assert('wait preserves the manager task-id authority boundary', invalidId.includes('Invalid background bash task id'));
  } finally {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }

  const shutdownRoot = await mkdtemp(path.join(tmpdir(), 'darwin-background-wait-shutdown-'));
  const shutdownManager = new BackgroundBashManager(shutdownRoot, 'session-wait-shutdown');
  const shutdownTask = await shutdownManager.start('sleep 1000');
  const pending = shutdownManager.wait(shutdownTask.taskId, 30_000);
  await delay(40);
  const shutdownBefore = Date.now();
  const shutdown = shutdownManager.shutdown();
  const shutdownWait = await pending;
  await shutdown;
  assert('shutdown releases pending wait and still reaps its process group', (shutdownWait.reason === 'shutdown' || shutdownWait.reason === 'terminal') && Date.now() - shutdownBefore < 1_300 && !exists(shutdownTask.pid));
  await rm(shutdownRoot, { recursive: true, force: true });
}

async function wrapperAndPermissionContracts(): Promise<void> {
  header('background bash — foreground delegation and permissions');
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-background-wrapper-'));
  const manager = new BackgroundBashManager(root, 'session-tool');
  const seen: Array<{ input: BashInput; context: unknown }> = [];
  const foreground = {
    name: 'bash', description: '', toolSpec: { name: 'bash', description: '', inputSchema: { type: 'object' } },
    invoke: async (input: BashInput, context?: unknown) => { seen.push({ input, context }); return input.mode === 'restart' ? 'Bash session restarted' : { output: 'delegated', error: '' }; },
  } as unknown as InvokableTool<BashInput, BashOutput | 'Bash session restarted'>;
  const wrapped = createBackgroundBashTool(manager, foreground);
  assert('provider-facing bash schema has a top-level object type', wrapped.toolSpec.inputSchema?.type === 'object');

  const expectedTaskId = 'bg-00000000-0000-0000-0000-000000000000';
  const managementCalls: Array<{ mode: 'status' | 'output' | 'wait' | 'stop'; taskId: string; waitMs?: number; signal?: AbortSignal }> = [];
  const managementStatus: BackgroundTaskStatus = {
    taskId: expectedTaskId, state: 'running', command: 'original', pid: 1,
    startedAt: '2026-08-19T00:00:00.000Z', finishedAt: null, exitCode: null,
    signal: null, outputPath: '/owned/output.log', outputBytes: 0,
  };
  const managementManager = {
    status: async (taskId: string) => { managementCalls.push({ mode: 'status', taskId }); return managementStatus; },
    output: async (taskId: string) => {
      managementCalls.push({ mode: 'output', taskId });
      return { taskId, output: 'owned output', startOffset: 0, endOffset: 12, hasMore: false, outputPath: '/owned/output.log' };
    },
    wait: async (taskId: string, waitMs: number, signal?: AbortSignal) => {
      managementCalls.push({ mode: 'wait', taskId, waitMs, ...(signal === undefined ? {} : { signal }) });
      return {
        reason: 'timeout', status: managementStatus,
        output: { taskId, output: '', startOffset: 0, endOffset: 0, hasMore: false, outputPath: '/owned/output.log' },
      } satisfies BackgroundWaitResult;
    },
    stop: async (taskId: string) => { managementCalls.push({ mode: 'stop', taskId }); return managementStatus; },
  } as unknown as BackgroundBashManager;
  const managementWrapped = createBackgroundBashTool(managementManager, foreground);
  const redundantCommand = 'bg-alternate-id; echo must-not-run';
  for (const mode of ['status', 'output', 'stop'] as const) {
    const withoutCommand = await managementWrapped.invoke({ mode, taskId: expectedTaskId });
    const withCommand = await managementWrapped.invoke({ mode, taskId: expectedTaskId, command: redundantCommand } as never);
    assert(`${mode} ignores redundant command without changing the manager result`, JSON.stringify(withCommand) === JSON.stringify(withoutCommand));
  }
  const waitController = new AbortController();
  const waitContext = { agent: { cancelSignal: waitController.signal } } as never;
  const waited = await managementWrapped.invoke({ mode: 'wait', taskId: expectedTaskId, waitMs: 123 }, waitContext) as BackgroundWaitResult;
  const waitedWithCommand = await managementWrapped.invoke({ mode: 'wait', taskId: expectedTaskId, waitMs: 123, command: redundantCommand } as never, waitContext);
  assert('wait ignores redundant command without changing the manager result', JSON.stringify(waitedWithCommand) === JSON.stringify(waited));
  assert(
    'management callbacks dispatch only lifecycle fields and never execute or reinterpret redundant command',
    managementCalls.length === 8 &&
      managementCalls.every((call, index) => call.mode === (['status', 'status', 'output', 'output', 'stop', 'stop', 'wait', 'wait'] as const)[index] && call.taskId === expectedTaskId) &&
      managementCalls.slice(6).every((call) => call.waitMs === 123 && call.signal === waitController.signal) &&
      seen.length === 0,
  );

  const context = { marker: true } as never;
    const listed = await wrapped.invoke({ mode: 'list' }) as BackgroundTaskStatus[];
    assert('bash list requires no task id and returns an empty list', listed.length === 0);
    for (const smuggled of [
      { mode: 'list', command: 'echo smuggled' },
      { mode: 'list', timeout: 1 },
      { mode: 'list', taskId: 'bg-x' },
    ]) {
      let listShapeError = '';
      try { await wrapped.invoke(smuggled as never); } catch (error) { listShapeError = String(error); }
      assert('bash list rejects irrelevant fields', listShapeError.includes('not accepted'));
    }
    let unknownFieldError = '';
    try { await wrapped.invoke({ mode: 'status', taskId: expectedTaskId, arbitrary: 'smuggled' } as never); }
    catch (error) { unknownFieldError = String(error); }
    assert('bash rejects arbitrary unknown fields', unknownFieldError.includes('Unrecognized key'));

  const execute = await wrapped.invoke({ mode: 'execute', command: 'echo hi', timeout: 9 }, context);
  const restart = await wrapped.invoke({ mode: 'restart' }, context);
  const compatibilityRestart = await wrapped.invoke({ mode: 'restart', command: 'ignored', timeout: 3, taskId: 'ignored' } as never, context);

    for (const invalidWait of [
      { mode: 'wait', taskId: expectedTaskId },
      { mode: 'wait', taskId: expectedTaskId, waitMs: 0 },
      { mode: 'wait', taskId: expectedTaskId, waitMs: 30_001 },
      { mode: 'wait', waitMs: 10 },
      { mode: 'status', taskId: expectedTaskId, waitMs: 10 },
    ]) {
      let waitShapeError = '';
      try { await managementWrapped.invoke(invalidWait as never); } catch (error) { waitShapeError = String(error); }
      assert('bash wait rejects missing, out-of-bound, and irrelevant wait fields', waitShapeError.includes('waitMs') || waitShapeError.includes('taskId'));
    }
    assert('provider description states the exact bounded wait semantics', managementWrapped.description.includes('integer from 1 to 30000') && managementWrapped.description.includes('incremental output'));
    const waitPermission = classify('bash', { mode: 'wait', taskId: expectedTaskId, waitMs: 123, command: redundantCommand });
    assert('wait is permission-safe and cannot become command execution', waitPermission.kind === 'read' && waitPermission.summary.includes('bash wait') && assessRisk(waitPermission, root).risk === 'safe');

  assert('restart preserves the vended optional/unknown foreground input compatibility', compatibilityRestart === 'Bash session restarted');
  for (const blank of ['', '   \n']) {
    let blankError = '';
    try { await wrapped.invoke({ mode: 'start', command: blank }); } catch (error) { blankError = String(error); }
    assert('background start rejects blank commands', blankError.includes('command is required'));
  }
  const whitespaceExecute = await wrapped.invoke({ mode: 'execute', command: '   \n' }, context) as BashOutput;
  assert('execute preserves the vended whitespace-command compatibility', whitespaceExecute.output === 'delegated');


  assert('execute and restart delegate return values unchanged', (execute as BashOutput).output === 'delegated' && restart === 'Bash session restarted');
  assert('delegation forwards exact input and caller context', seen.length === 4 && seen[0]?.context === context && seen[0]?.input.mode === 'execute');

  const sdkWrapped = createBackgroundBashTool(manager);
  const parentAgent = new Agent({ model: new BashStartModel(), tools: [sdkWrapped], printer: false });
  const childAgent = new Agent({ model: new BashStartModel(), tools: [sdkWrapped], printer: false });
  await Promise.all([parentAgent.initialize(), childAgent.initialize()]);
  const parentContext = { agent: parentAgent } as never;
  const childContext = { agent: childAgent } as never;
  await sdkWrapped.invoke({ mode: 'execute', command: 'export OWNER=parent' }, parentContext);
  await sdkWrapped.invoke({ mode: 'execute', command: 'export OWNER=child' }, childContext);
  const parentOwner = await sdkWrapped.invoke({ mode: 'execute', command: 'printf "$OWNER"' }, parentContext) as BashOutput;
  const childOwner = await sdkWrapped.invoke({ mode: 'execute', command: 'printf "$OWNER"' }, childContext) as BashOutput;
  assert('real SDK foreground bash persists independently per Agent', parentOwner.output === 'parent' && childOwner.output === 'child');
  await Promise.all([
    parentAgent.tool.bash?.invoke({ mode: 'restart' }),
    childAgent.tool.bash?.invoke({ mode: 'restart' }),
  ]);

  const subagents = new SubagentTool({
    registry: {
      definitions: [{ name: 'general', description: 'background child', systemPrompt: 'Start the requested job.', tools: ['bash'], file: undefined }],
      problems: [],
    },
    tools: [sdkWrapped],
    intervention: new PermissionGate({ mode: 'yolo', projectRoot: root, ask: async () => ({ allowed: true }) }),
    projectInstructions: undefined,
    config: fakeConfig(),
    createModel: async () => new ChildBackgroundModel(),
  });
  const parent = new Agent({ model: new BashStartModel(), tools: [subagents.tool, sdkWrapped], printer: false });
  await parent.initialize();
  const reportText = JSON.stringify(await parent.tool.subagent?.invoke({ task: 'start background work' }));
  const taskId = reportText.match(/bg-[0-9a-f-]{36}/)?.[0];
  const parentView = taskId === undefined ? undefined : await sdkWrapped.invoke({ mode: 'status', taskId }) as BackgroundTaskStatus;
  assert('real SubagentTool child starts a task visible through the parent tool', taskId !== undefined && parentView?.state === 'running');
  assert('SubagentTool child foreground cleanup leaves its background task running', parentView !== undefined && exists(parentView.pid));
  if (taskId !== undefined) await manager.stop(taskId);
  await subagents.shutdown();

  const start = classify('bash', { mode: 'start', command: 'pnpm test' });
  assert('start has normal execute permission semantics', start.kind === 'execute' && assessRisk(start, root).risk === 'dangerous');
  for (const mode of ['restart', 'list', 'status', 'output', 'wait', 'stop'] as const) {
    const request = classify('bash', mode === 'restart' || mode === 'list' ? { mode } : { mode, taskId: 'bg-x' });
    assert(`${mode} is statically safe`, request.kind === 'read' && assessRisk(request, root).risk === 'safe');
  }

  const backgroundInput = { mode: 'start', command: 'pnpm test -- --runInBand' } as const;
  let permission = await permissionAction(root, 'default', backgroundInput);
  assert('default mode asks for background start and preserves command details', permission.action.type === 'proceed' && permission.asked.length === 1 && permission.asked[0]?.details.some((detail) => detail.value === backgroundInput.command) === true);

  permission = await permissionAction(root, 'yolo', backgroundInput);
  assert('yolo mode allows background start without asking', permission.action.type === 'proceed' && permission.asked.length === 0);

  const safeClassifier: SafetyClassifier = async () => ({ safe: true, reason: 'test command is allowed' });
  permission = await permissionAction(root, 'auto', backgroundInput, { classifier: safeClassifier });
  assert('auto mode sends background start to its classifier and skips the prompt on safe verdict', permission.action.type === 'proceed' && permission.classified[0]?.input === backgroundInput && permission.asked.length === 0);

  const unsafeClassifier: SafetyClassifier = async () => ({ safe: false, reason: 'needs confirmation' });
  permission = await permissionAction(root, 'auto', backgroundInput, { classifier: unsafeClassifier });
  assert('auto mode prompts for classifier-unsafe background start', permission.classified.length === 1 && permission.asked.length === 1);

  permission = await permissionAction(root, 'auto', backgroundInput, {
    allowRules: ['bash:pnpm test *'],
    classifier: async () => { throw new Error('matching rule should skip classifier'); },
  });
  assert('existing bash pattern rule allows matching background start before classifier or prompt', permission.action.type === 'proceed' && permission.action.reason?.includes('bash:pnpm test *') === true && permission.classified.length === 0 && permission.asked.length === 0);

  const hookFile = path.join(root, 'hooks.log');
  const gate = new PermissionGate({ mode: 'default', projectRoot: root, ask: async () => ({ allowed: true }) });
  const hookGate = new ToolHookGate(root, {
    PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: `printf '%s\n' pre >> ${hookFile}` }] }],
    PostToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: `printf '%s\n' post >> ${hookFile}` }] }],
  }, gate);
  const agent = new Agent({ model: new BashStartModel(), tools: [wrapped], interventions: [hookGate], printer: false });
  await agent.invoke('start it');
  const hooks = await readFile(hookFile, 'utf8');
  assert('real Agent Pre/Post hooks wrap the immediate start call', hooks === 'pre\npost\n');
  await manager.shutdown();
  await rm(root, { recursive: true, force: true });
}

async function shutdownAndExitContracts(): Promise<void> {
  header('background bash — bounded shutdown and process exit fallback');
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-background-shutdown-'));
  const manager = new BackgroundBashManager(root, 'session-shutdown');
  const running = await Promise.all([manager.start('sleep 1000'), manager.start('sleep 1000')]);
  const starts = Array.from({ length: 24 }, () => manager.start('sleep 1000'));
  // Wait only for the first spawn confirmation, leaving the rest of the launch set
  // unsettled when shutdown latches and takes responsibility for the whole race.
  await Promise.any(starts);
  const before = Date.now();
  const shutdown = manager.shutdown();
  const raced = await Promise.allSettled(starts);
  await shutdown;
  const racedSpawned = raced.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
  assert('shutdown synchronizes with in-flight starts and is bounded', Date.now() - before < 1_300);
  assert('shutdown reaps every already-running process group', running.every((task) => !exists(task.pid)));
  const racedAlive = await eventually(
    async () => racedSpawned.filter((task) => exists(task.pid)).map((task) => task.pid),
    (pids) => pids.length === 0,
    1_000,
  );
  assert('shutdown reaps every successfully spawned raced PID', racedSpawned.length > 0 && racedAlive.length === 0);
  let closedError = '';
  try { await manager.start('true'); } catch (error) { closedError = String(error); }
  assert('shutdown latch prevents later starts', closedError.includes('shutting down'));
  await rm(root, { recursive: true, force: true });

  for (const scenario of ['exit', 'shutdown', 'forced', 'SIGINT', 'SIGTERM'] as const) {
    const probeRoot = await mkdtemp(path.join(tmpdir(), `darwin-background-${scenario.toLowerCase()}-`));
    const mode = scenario.startsWith('SIG') ? 'signal' : scenario;
    const child = spawn(process.execPath, ['--import', 'tsx', 'spike/probe-background-bash-exit.ts', mode, probeRoot], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    await eventually(async () => stdout, (value) => value.includes('READY'), 3_000);
    const leader = Number((await readFile(path.join(probeRoot, 'leader.pid'), 'utf8')).trim());
    const descendant = Number((await readFile(path.join(probeRoot, 'child.pid'), 'utf8')).trim());
    if (scenario === 'SIGINT' || scenario === 'SIGTERM') child.kill(scenario);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`probe ${scenario} did not exit`)); }, 3_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await eventually(async () => exists(leader) || exists(descendant), (alive) => !alive, 2_000);
    assert(`${scenario} leaves neither registered leader nor descendant`, !exists(leader) && !exists(descendant));
    await rm(probeRoot, { recursive: true, force: true });
  }

  let launchedOnCloseFailure = 0;
  const closeFailureRoot = await mkdtemp(path.join(tmpdir(), 'darwin-background-close-failure-'));
  const closeFailureManager = new BackgroundBashManager(closeFailureRoot, 'session-close-failure', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      const originalClose = handle.close.bind(handle);
      let first = true;
      handle.close = async () => {
        if (first) {
          first = false;
          // Let the spawned shell write its PID so the regression can prove that
          // the exposed process group, not merely the promise, was cleaned up.
          await delay(100);
          await originalClose();
          throw new Error('synthetic close failure');
        }
      };
    }
    return handle;
  });
  const closeFailurePid = path.join(closeFailureRoot, 'close-failure.pid');
  let closeFailure = '';
  try {
    const result = await closeFailureManager.start(`echo $$ > ${closeFailurePid}; sleep 1000`);
    launchedOnCloseFailure = result.pid;
  } catch (error) {
    closeFailure = String(error);
    launchedOnCloseFailure = Number(await readFile(closeFailurePid, 'utf8').catch(() => '0'));
  }
  assert('post-spawn log close failure rejects start', closeFailure.includes('synthetic close failure'));
  await eventually(async () => launchedOnCloseFailure > 0 && exists(launchedOnCloseFailure), (alive) => !alive);
  assert('post-spawn log close failure reaps the exposed process group', launchedOnCloseFailure > 0 && !exists(launchedOnCloseFailure));

  let setupHandleClosed = false;
  let setupSpawned = false;
  const setupFailureRoot = await mkdtemp(path.join(tmpdir(), 'darwin-background-setup-failure-'));
  const setupFailureManager = new BackgroundBashManager(setupFailureRoot, 'session-setup-failure', async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      const originalClose = handle.close.bind(handle);
      handle.close = async () => { setupHandleClosed = true; await originalClose(); };
      handle.stat = async () => { throw new Error('synthetic stat failure'); };
    }
    return handle;
  });
  try { await setupFailureManager.start(`echo spawned > ${path.join(setupFailureRoot, 'spawned')}`); }
  catch (error) { assert('pre-spawn metadata failure is surfaced', String(error).includes('synthetic stat failure')); }
  setupSpawned = await readFile(path.join(setupFailureRoot, 'spawned'), 'utf8').then(() => true, () => false);
  assert('pre-spawn metadata failure closes its log handle and spawns nothing', setupHandleClosed && !setupSpawned);
  await setupFailureManager.shutdown();
  await rm(setupFailureRoot, { recursive: true, force: true });

  await closeFailureManager.shutdown();
  await rm(closeFailureRoot, { recursive: true, force: true });

}

await managerContracts();
await waitContracts();
await wrapperAndPermissionContracts();
await shutdownAndExitContracts();
report();
