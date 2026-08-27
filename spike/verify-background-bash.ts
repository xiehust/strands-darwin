/** Focused, network-free verification for managed background bash jobs. */
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Agent, Model, type BaseModelConfig, type InvokableTool, type Message, type ModelStreamEvent } from '@strands-agents/sdk';
import { BashSessionError } from '@strands-agents/sdk/vended-tools/bash';
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
  createForegroundBashTool,
  type BackgroundStartResult,
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
  constructor(private readonly input: Record<string, unknown> = { mode: 'start', command: 'sleep 1000' }) { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const hasResult = messages.some((message) => message.content.some((block) => block.type === 'toolResultBlock'));
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (!hasResult) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'bash', toolUseId: 'background-1' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.input) } };
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
    contextOffload: true,
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

    const terminalFocused = await manager.start("printf 'one'; sleep .08; printf 'two'; sleep .08; exit 0");
    const terminalFocusedBefore = Date.now();
    const terminalFocusedResult = await manager.wait(terminalFocused.taskId, 1_000, undefined, false);
    assert(
      'terminal-focused wait retains intermediate output without waking until terminal state',
      terminalFocusedResult.reason === 'terminal' && terminalFocusedResult.status.state === 'succeeded' &&
        terminalFocusedResult.output.output === 'onetwo' && Date.now() - terminalFocusedBefore >= 120,
    );
    const terminalFocusedDrain = await manager.output(terminalFocused.taskId);
    assert('terminal-focused wait returns retained output exactly once', terminalFocusedDrain.output === '' && terminalFocusedDrain.startOffset === terminalFocusedResult.output.endOffset);

    const terminalTimeout = await manager.start("printf 'first'; sleep .06; printf 'second'; sleep 1000");
    const terminalTimeoutBefore = Date.now();
    const terminalTimeoutResult = await manager.wait(terminalTimeout.taskId, 140, undefined, false);
    assert(
      'terminal-focused wait aggregates output and remains bounded by finite timeout',
      terminalTimeoutResult.reason === 'timeout' && terminalTimeoutResult.status.state === 'running' &&
        terminalTimeoutResult.output.output === 'firstsecond' && Date.now() - terminalTimeoutBefore >= 110 && Date.now() - terminalTimeoutBefore < 350,
    );

    const bounded = await manager.start("node -e \"process.stdout.write('x'.repeat(70000))\"; sleep 1000");
    const boundedResult = await manager.wait(bounded.taskId, 100, undefined, false);
    const boundedRemainder = await manager.output(bounded.taskId);
    assert(
      'terminal-focused aggregation stays at the ordinary output cap and leaves later bytes on the shared cursor',
      boundedResult.reason === 'timeout' && boundedResult.output.output.length === 65_536 && boundedResult.output.hasMore &&
        boundedRemainder.output.length === 4_464 && boundedRemainder.startOffset === boundedResult.output.endOffset,
    );


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

    const terminalSplit = await manager.start("printf '\\342'; sleep .08; printf '\\202\\254'; sleep .08; exit 0");
    const terminalSplitResult = await manager.wait(terminalSplit.taskId, 1_000, undefined, false);
    assert(
      'terminal-focused aggregation preserves UTF-8 boundaries while output grows',
      terminalSplitResult.reason === 'terminal' && terminalSplitResult.output.output === '€' &&
        terminalSplitResult.output.startOffset === 0 && terminalSplitResult.output.endOffset === 3,
    );

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

    const sharedTerminal = await manager.start("node -e \"process.stdout.write('x'.repeat(65536))\"; sleep .08; printf 'theirs'; sleep 1000");
    const terminalWait = manager.wait(sharedTerminal.taskId, 200, undefined, false);
    await eventually(async () => (await readFile(sharedTerminal.outputPath)).length, (size) => size === 65_536);
    await delay(40);
    await eventually(async () => (await readFile(sharedTerminal.outputPath)).length, (size) => size > 65_536);
    const sharedOutput = await manager.output(sharedTerminal.taskId);
    const sharedTerminalResult = await terminalWait;
    assert(
      'terminal-focused wait and output keep disjoint shared-cursor ranges without an early changed wake',
      sharedTerminalResult.reason === 'timeout' && sharedTerminalResult.output.output.length === 65_536 &&
        sharedOutput.output === 'theirs' && sharedTerminalResult.output.endOffset === sharedOutput.startOffset,
    );


    const terminalCancellable = await manager.start("printf 'before-cancel'; sleep 1000");
    const terminalController = new AbortController();
    const terminalCancelledPromise = manager.wait(terminalCancellable.taskId, 30_000, terminalController.signal, false);
    setTimeout(() => terminalController.abort(), 60);
    const terminalCancelled = await terminalCancelledPromise;
    assert(
      'terminal-focused cancellation returns retained output promptly without stopping the task',
      terminalCancelled.reason === 'cancelled' && terminalCancelled.output.output === 'before-cancel' && exists(terminalCancellable.pid),
    );

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
  const shutdownTask = await shutdownManager.start("printf 'before-shutdown'; sleep 1000");
  const pending = shutdownManager.wait(shutdownTask.taskId, 30_000, undefined, false);
  await eventually(async () => (await readFile(shutdownTask.outputPath)).length, (size) => size > 0);
  const shutdownBefore = Date.now();
  const shutdown = shutdownManager.shutdown();
  const shutdownWait = await pending;
  await shutdown;
  assert(
    'shutdown releases terminal-focused wait with retained output and still reaps its process group',
    (shutdownWait.reason === 'shutdown' || shutdownWait.reason === 'terminal') && shutdownWait.output.output === 'before-shutdown' &&
      Date.now() - shutdownBefore < 1_300 && !exists(shutdownTask.pid),
  );
  await rm(shutdownRoot, { recursive: true, force: true });
}

async function wrapperAndPermissionContracts(): Promise<void> {
  header('background bash — foreground delegation and permissions');
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-background-wrapper-'));
  const manager = new BackgroundBashManager(root, 'session-tool');
  const seen: Array<{ input: BashInput; context: unknown }> = [];
  const foreground = {
    name: 'bash', description: '', toolSpec: { name: 'bash', description: '', inputSchema: { type: 'object' } },
    invoke: async (input: BashInput, context?: unknown) => { seen.push({ input, context }); return input.mode === 'restart' ? 'Bash session restarted' : { output: 'delegated', error: '', cwd: root, exitCode: 0 }; },
  } as unknown as InvokableTool<BashInput, BashOutput | 'Bash session restarted'>;
  const wrapped = createBackgroundBashTool(manager, foreground);
  assert('provider-facing bash schema has a top-level object type', wrapped.toolSpec.inputSchema?.type === 'object');

  const startCommand = "printf 'dispatch-exact'";
  const startCalls: string[] = [];
  const startManager = {
    start: async (command: string) => {
      startCalls.push(command);
      return { taskId: `bg-start-${startCalls.length}`, pid: startCalls.length, outputPath: `/owned/start-${startCalls.length}.log` };
    },
  } as unknown as BackgroundBashManager;
  const startWrapped = createBackgroundBashTool(startManager, foreground);
  await startWrapped.invoke({ mode: 'start', command: startCommand });
  await startWrapped.invoke({ mode: 'start', command: startCommand, timeout: 0.01 });
  assert(
    'start accepts redundant timeout but dispatches only the identical command to manager.start',
    startCalls.length === 2 && startCalls.every((command) => command === startCommand) && seen.length === 0,
  );

  const realManager = new BackgroundBashManager(root, 'session-tool-timeout');
  const realWrapped = createBackgroundBashTool(realManager, foreground);
  const realStartCommand = "sleep 0.15; printf 'timeout-ignored'";
  const realStartBefore = Date.now();
  const realStart = await realWrapped.invoke({ mode: 'start', command: realStartCommand, timeout: 0.01 }) as BackgroundStartResult;
  await delay(50);
  const realStartDuring = await realManager.status(realStart.taskId);
  const realStartFinished = await realManager.wait(realStart.taskId, 3_000, undefined, false);
  assert(
    'redundant timeout neither prevents nor bounds a real background launch',
    realStartDuring.state === 'running' && realStartFinished.status.state === 'succeeded' &&
      realStartFinished.output.output === 'timeout-ignored' && Date.now() - realStartBefore >= 100,
  );
  await realManager.shutdown();

  const expectedTaskId = 'bg-00000000-0000-0000-0000-000000000000';
  const managementCalls: Array<{ mode: 'status' | 'output' | 'wait' | 'stop'; taskId: string; waitMs?: number; signal?: AbortSignal; wakeOnOutput?: boolean }> = [];
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
    wait: async (taskId: string, waitMs: number, signal?: AbortSignal, wakeOnOutput?: boolean) => {
      managementCalls.push({ mode: 'wait', taskId, waitMs, ...(signal === undefined ? {} : { signal }), ...(wakeOnOutput === undefined ? {} : { wakeOnOutput }) });
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
  await managementWrapped.invoke({ mode: 'wait', taskId: expectedTaskId, waitMs: 123, wakeOnOutput: false }, waitContext);
  assert(
    'management callbacks dispatch only lifecycle fields and never execute or reinterpret redundant command',
    managementCalls.length === 9 &&
      managementCalls.every((call, index) => call.mode === (['status', 'status', 'output', 'output', 'stop', 'stop', 'wait', 'wait', 'wait'] as const)[index] && call.taskId === expectedTaskId) &&
      managementCalls.slice(6).every((call) => call.waitMs === 123 && call.signal === waitController.signal) &&
      managementCalls[6]?.wakeOnOutput === undefined && managementCalls[7]?.wakeOnOutput === undefined && managementCalls[8]?.wakeOnOutput === false &&
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
    let misplacedWakeError = '';
    try { await wrapped.invoke({ mode: 'status', taskId: expectedTaskId, wakeOnOutput: false } as never); }
    catch (error) { misplacedWakeError = String(error); }
    assert('wakeOnOutput is accepted only in wait mode', misplacedWakeError.includes('wakeOnOutput is not accepted in status mode'));

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
    assert(
      'provider description states the exact bounded and terminal-focused wait semantics',
      managementWrapped.description.includes('integer from 1 to 30000') && managementWrapped.description.includes('incremental output') &&
        managementWrapped.description.includes('wakeOnOutput:false'),
    );
    const waitPermission = classify('bash', { mode: 'wait', taskId: expectedTaskId, waitMs: 123, wakeOnOutput: false, command: redundantCommand });
    assert('terminal-focused wait is permission-safe and cannot become command execution', waitPermission.kind === 'read' && waitPermission.summary.includes('bash wait') && assessRisk(waitPermission, root).risk === 'safe');

  assert('restart preserves the vended optional/unknown foreground input compatibility', compatibilityRestart === 'Bash session restarted');
  for (const blank of ['', '   \n']) {
    let blankError = '';
    try { await wrapped.invoke({ mode: 'start', command: blank, timeout: 30 }); } catch (error) { blankError = String(error); }
    assert('background start rejects blank commands', blankError.includes('command is required'));
  }
  const whitespaceExecute = await wrapped.invoke({ mode: 'execute', command: '   \n' }, context) as BashOutput;
  assert('execute preserves the vended whitespace-command compatibility', whitespaceExecute.output === 'delegated');


  assert('execute and restart delegate return values unchanged', (execute as BashOutput).output === 'delegated' && (execute as BashOutput).exitCode === 0 && restart === 'Bash session restarted');
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

  const startInput = { mode: 'start', command: 'pnpm test' } as const;
  const startInputWithTimeout = { ...startInput, timeout: 30 } as const;
  const start = classify('bash', startInput);
  const startWithTimeout = classify('bash', startInputWithTimeout);
  assert(
    'redundant start timeout does not affect permission classification or command presentation',
    start.kind === 'execute' && assessRisk(start, root).risk === 'dangerous' &&
      startWithTimeout.kind === start.kind && startWithTimeout.summary === start.summary &&
      JSON.stringify(startWithTimeout.details) === JSON.stringify(start.details) && startWithTimeout.input === startInputWithTimeout,
  );
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
  const backgroundInputWithTimeout = { ...backgroundInput, timeout: 30 } as const;
  permission = await permissionAction(root, 'auto', backgroundInputWithTimeout, { classifier: safeClassifier });
  assert(
    'auto mode preserves the raw redundant timeout input for classification without changing start semantics',
    permission.action.type === 'proceed' && permission.classified[0]?.input === backgroundInputWithTimeout &&
      permission.classified[0]?.details.some((detail) => detail.label === 'Timeout') === false && permission.asked.length === 0,
  );

  const unsafeClassifier: SafetyClassifier = async () => ({ safe: false, reason: 'needs confirmation' });
  permission = await permissionAction(root, 'auto', backgroundInput, { classifier: unsafeClassifier });
  assert('auto mode prompts for classifier-unsafe background start', permission.classified.length === 1 && permission.asked.length === 1);

  permission = await permissionAction(root, 'auto', backgroundInput, {
    allowRules: ['bash:pnpm test *'],
    classifier: async () => { throw new Error('matching rule should skip classifier'); },
  });
  assert('existing bash pattern rule allows matching background start before classifier or prompt', permission.action.type === 'proceed' && permission.action.reason?.includes('bash:pnpm test *') === true && permission.classified.length === 0 && permission.asked.length === 0);

  const hookFile = path.join(root, 'hooks.log');
  const preHookInput = path.join(root, 'pre-hook-input.json');
  const postHookInput = path.join(root, 'post-hook-input.json');
  const hookStartInput = { mode: 'start', command: 'sleep 1000', timeout: 30 } as const;
  const gate = new PermissionGate({ mode: 'default', projectRoot: root, ask: async () => ({ allowed: true }) });
  const hookGate = new ToolHookGate(root, {
    PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: `tee ${preHookInput} >/dev/null; printf '%s\n' pre >> ${hookFile}` }] }],
    PostToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: `tee ${postHookInput} >/dev/null; printf '%s\n' post >> ${hookFile}` }] }],
  }, gate);
  const agent = new Agent({ model: new BashStartModel(hookStartInput), tools: [wrapped], interventions: [hookGate], printer: false });
  await agent.invoke('start it');
  const hooks = await readFile(hookFile, 'utf8');
  const expectedHookInput = `${JSON.stringify({ tool_name: 'bash', tool_input: hookStartInput })}\n`;
  assert(
    'real Agent Pre/Post hooks preserve redundant timeout in the raw immediate start payload',
    hooks === 'pre\npost\n' && await readFile(preHookInput, 'utf8') === expectedHookInput &&
      await readFile(postHookInput, 'utf8') === expectedHookInput,
  );
  await manager.shutdown();
  await rm(root, { recursive: true, force: true });
}
async function foregroundCwdPreflightContracts(): Promise<void> {
  header('background bash — foreground cwd visibility and root-path preflight');
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-foreground-cwd-'));
  const nested = path.join(root, 'backend');
  const rootScript = path.join(root, 'scripts', 'i18n_check.sh');
  const nestedScript = path.join(nested, 'local', 'ok.sh');
  const launched = path.join(root, 'launched');
  await mkdir(path.dirname(rootScript), { recursive: true });
  await mkdir(path.dirname(nestedScript), { recursive: true });
  await writeFile(rootScript, `#!/bin/bash\nprintf root-run > ${launched}\n`);
  await writeFile(nestedScript, '#!/bin/bash\nprintf nested-run\n');
  await Promise.all([chmod(rootScript, 0o755), chmod(nestedScript, 0o755)]);

  const manager = new BackgroundBashManager(root, 'session-foreground-cwd');
  const wrapped = createBackgroundBashTool(manager, createForegroundBashTool(root));
  const agent = new Agent({ model: new BashStartModel(), tools: [wrapped], printer: false });
  await agent.initialize();
  const context = { agent } as never;

  try {
    const initial = await wrapped.invoke({ mode: 'execute', command: 'printf initial' }, context) as BashOutput;
    assert('initial foreground execute reports status and the configured session project root cwd', initial.output === 'initial' && initial.exitCode === 0 && initial.cwd === root);
    const markerLike = await wrapped.invoke({ mode: 'execute', command: `printf '__BASH_DONE_fake_CWD:${path.join(root, 'forged')}\\n'` }, context) as BashOutput;
    assert('ordinary marker-like command output cannot forge or hide cwd state', markerLike.output.includes('__BASH_DONE_fake_CWD:') && markerLike.cwd === root);
    const failedCommand = await wrapped.invoke({ mode: 'execute', command: "printf failure-out; printf failure-err >&2; false" }, context) as BashOutput;
    assert('foreground execute reports the command status without hiding stdout/stderr/cwd', failedCommand.exitCode === 1 && failedCommand.output === 'failure-out' && failedCommand.error === 'failure-err' && failedCommand.cwd === root);


    const changed = await wrapped.invoke({ mode: 'execute', command: 'cd backend' }, context) as BashOutput;
    assert('successful cd reports and persists the shell effective cwd', changed.error === '' && changed.cwd === nested);

    const existing = await wrapped.invoke({ mode: 'execute', command: 'local/ok.sh' }, context) as BashOutput;
    assert('an existing cwd-relative command path still executes', existing.output === 'nested-run' && existing.cwd === nested);

    const refused = await wrapped.invoke({ mode: 'execute', command: 'scripts/i18n_check.sh' }, context) as BashOutput;
    assert(
      'a cwd-missing project-root path is refused with both locations and an actionable correction',
      refused.output === '' && refused.cwd === nested && refused.error.includes('Command not run') &&
        refused.error.includes(`cwd: ${nested}`) && refused.error.includes(path.join(nested, 'scripts/i18n_check.sh')) &&
        refused.error.includes(rootScript) && refused.error.includes(`cd ${root}`),
    );
    const afterRefusal = await wrapped.invoke({ mode: 'execute', command: 'printf %s "$PWD"' }, context) as BashOutput;
    assert(
      'preflight neither launches nor mutates the persistent shell',
      afterRefusal.output === nested && afterRefusal.cwd === nested && await readFile(launched, 'utf8').catch(() => '') === '',
    );

    const missingBoth = await wrapped.invoke({ mode: 'execute', command: 'missing/nope' }, context) as BashOutput;
    assert('a relative path missing in both locations retains ordinary shell behavior', missingBoth.error.includes('No such file or directory') && !missingBoth.error.includes('Command not run'));

    const absolute = await wrapped.invoke({ mode: 'execute', command: '/bin/printf absolute' }, context) as BashOutput;
    const pathCommand = await wrapped.invoke({ mode: 'execute', command: 'printf path-command' }, context) as BashOutput;
    const unrelatedArgument = await wrapped.invoke({ mode: 'execute', command: 'printf %s scripts/i18n_check.sh' }, context) as BashOutput;
    const quoted = await wrapped.invoke({ mode: 'execute', command: `bash -c '${rootScript}'` }, context) as BashOutput;
    const option = await wrapped.invoke({ mode: 'execute', command: 'cd -- backend' }, context) as BashOutput;
    const redirected = await wrapped.invoke({ mode: 'execute', command: `scripts/i18n_check.sh > ${path.join(root, 'redirected')}` }, context) as BashOutput;
    const substituted = await wrapped.invoke({ mode: 'execute', command: 'scripts/$(printf i18n_check).sh' }, context) as BashOutput;
    assert(
      'absolute and PATH commands plus unrelated arguments are unchanged',
      absolute.output === 'absolute' && pathCommand.output === 'path-command' && unrelatedArgument.output === 'scripts/i18n_check.sh',
    );
    assert(
      'quoted/options/redirection/substitution shapes fail open to ordinary shell execution',
      quoted.cwd === nested && option.error.includes('No such file or directory') && redirected.error.includes('No such file or directory') &&
        substituted.error.includes('No such file or directory') && await readFile(launched, 'utf8') === 'root-run',
    );

    await wrapped.invoke({ mode: 'execute', command: 'cd backend' }, context);
    const refusedCd = await wrapped.invoke({ mode: 'execute', command: 'cd backend' }, context) as BashOutput;
    assert('the evidenced repeated cd shape is refused before shell mutation', refusedCd.cwd === nested && refusedCd.error.includes(path.join(nested, 'backend')) && refusedCd.error.includes(path.join(root, 'backend')));

    const restart = await wrapped.invoke({ mode: 'restart' }, context);
    assert('explicit restart visibly reports the reset session project root cwd', restart === `Bash session restarted\ncwd: ${root}`);
    const restarted = await wrapped.invoke({ mode: 'execute', command: 'printf restarted' }, context) as BashOutput;
    assert('execute after restart starts at the configured project root', restarted.output === 'restarted' && restarted.cwd === root);

    const background = await wrapped.invoke({ mode: 'start', command: 'pwd' }, context) as BackgroundStartResult;
    const backgroundDone = await manager.wait(background.taskId, 3_000, undefined, false);
    assert('background lifecycle modes bypass foreground cwd projection and preflight', backgroundDone.status.state === 'succeeded' && backgroundDone.output.output.trim() === root);

    const hookInput = { mode: 'execute', command: 'scripts/i18n_check.sh' } as const;
    const hookLog = path.join(root, 'foreground-hooks.log');
    const preHookInput = path.join(root, 'foreground-pre.json');
    const postHookInput = path.join(root, 'foreground-post.json');
    const asked: AssessedPermissionRequest[] = [];
    const gate = new PermissionGate({ mode: 'default', projectRoot: root, ask: async (request) => { asked.push(request); return { allowed: true }; } });
    const hookGate = new ToolHookGate(root, {
      PreToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: `tee ${preHookInput} >/dev/null; printf '%s\\n' pre >> ${hookLog}` }] }],
      PostToolUse: [{ matcher: 'bash', hooks: [{ type: 'command', command: `tee ${postHookInput} >/dev/null; printf '%s\\n' post >> ${hookLog}` }] }],
    }, gate);
    const hookAgent = new Agent({ model: new BashStartModel(hookInput), tools: [wrapped], interventions: [hookGate], printer: false });
    await hookAgent.initialize();
    await wrapped.invoke({ mode: 'execute', command: 'cd backend' }, { agent: hookAgent } as never);
    await hookAgent.invoke('run it');
    const expectedHookInput = `${JSON.stringify({ tool_name: 'bash', tool_input: hookInput })}\n`;
    assert(
      'permission and Pre/Post hooks receive the exact raw execute input before foreground preflight',
      JSON.stringify(asked[0]?.input) === JSON.stringify(hookInput) && await readFile(hookLog, 'utf8') === 'pre\npost\n' &&
        await readFile(preHookInput, 'utf8') === expectedHookInput && await readFile(postHookInput, 'utf8') === expectedHookInput,
    );
  } finally {
    await wrapped.invoke({ mode: 'restart' }, context);
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}



async function foregroundShellExitContracts(): Promise<void> {
  header('background bash — foreground shell exit recovery and serialization');
  const root = await mkdtemp(path.join(tmpdir(), 'darwin-foreground-exit-'));
  const manager = new BackgroundBashManager(root, 'session-foreground-exit');
  const wrapped = createBackgroundBashTool(manager);
  const agent = new Agent({ model: new BashStartModel(), tools: [wrapped], printer: false });
  await agent.initialize();
  const context = { agent } as never;

  try {
    const configured = createBackgroundBashTool(manager, createForegroundBashTool(root));
    const configuredAgent = new Agent({ model: new BashStartModel(), tools: [configured], printer: false });
    await configuredAgent.initialize();
    const configuredContext = { agent: configuredAgent } as never;
    await configured.invoke({ mode: 'execute', command: 'cd /tmp' }, configuredContext);
    const configuredExit = await configured.invoke({ mode: 'execute', command: 'exit 0' }, configuredContext) as BashOutput;
    assert('configured exit-0 replacement reports the last effective cwd', configuredExit.cwd === '/tmp');
    const configuredReplacement = await configured.invoke({ mode: 'execute', command: 'pwd' }, configuredContext) as BashOutput;
    assert('configured exit-0 replacement resets to the session project root', configuredReplacement.output === root && configuredReplacement.cwd === root);
    await configured.invoke({ mode: 'restart' }, configuredContext);

    // This is the measured SRF-004 shape: one model message can dispatch several
    // foreground tool calls at once. The unpatched SDK attached every invocation's
    // listeners to one shell and sentinel, so all three received alpha's output or
    // all failed when gamma closed the shell.
    const parallel = await Promise.all([
      wrapped.invoke({ mode: 'execute', command: "printf 'alpha-out\\n'; printf 'alpha-err\\n' >&2; sleep 0.04" }, context),
      wrapped.invoke({ mode: 'execute', command: "printf 'beta-out\\n'; printf 'beta-err\\n' >&2; sleep 0.02" }, context),
      wrapped.invoke({ mode: 'execute', command: "printf 'gamma-out\\n'; printf 'gamma-err\\n' >&2; exit 0" }, context),
    ]) as BashOutput[];
    assert('parallel foreground calls retain invocation-owned stdout without duplicates',
      parallel.map((value) => value.output).join('|') === 'alpha-out|beta-out|gamma-out');
    assert('parallel foreground calls retain invocation-owned stderr without cross-attribution',
      parallel[0]?.error === 'alpha-err' && parallel[1]?.error === 'beta-err' && parallel[2]?.error.startsWith('gamma-err\n') === true);
    assert('exit code 0 is success with a visible non-fatal restart notice and last effective cwd',
      parallel[2]?.error.includes('Persistent bash shell exited with code 0') === true &&
      parallel[2]?.error.includes('restart before the next command') === true && parallel[2]?.cwd === process.cwd());

    const replacement = await wrapped.invoke({ mode: 'execute', command: "printf 'replacement-out\\n'; printf 'replacement-err\\n' >&2" }, context) as BashOutput;
    assert('the next foreground call uses a healthy replacement persistent shell',
      replacement.output === 'replacement-out' && replacement.error === 'replacement-err');

    await wrapped.invoke({ mode: 'execute', command: 'export FOREGROUND_STATE=kept' }, context);
    const persistent = await wrapped.invoke({ mode: 'execute', command: 'printf %s "$FOREGROUND_STATE"' }, context) as BashOutput;
    assert('ordinary foreground calls still persist shell state', persistent.output === 'kept' && persistent.error === '');
    assert('explicit foreground restart remains compatible',
      await wrapped.invoke({ mode: 'restart' }, context) === 'Bash session restarted');
    const restarted = await wrapped.invoke({ mode: 'execute', command: 'printf %s "${FOREGROUND_STATE-unset}"' }, context) as BashOutput;
    assert('explicit restart still replaces persistent shell state', restarted.output === 'unset');

    const failures = [
      {
        command: "printf 'nonzero-out\\n'; printf 'nonzero-err\\n' >&2; exit 7",
        message: 'code 7', exitCode: 7, signal: null, output: 'nonzero-out', error: 'nonzero-err',
      },
      {
        command: "printf 'signal-out\\n'; printf 'signal-err\\n' >&2; kill -TERM $$",
        message: 'signal SIGTERM', exitCode: null, signal: 'SIGTERM', output: 'signal-out', error: 'signal-err',
      },
    ] as const;
    for (const expected of failures) {
      let caught: unknown;
      try { await wrapped.invoke({ mode: 'execute', command: expected.command }, context); }
      catch (error) { caught = error; }
      const failure = caught as BashSessionError;
      assert('nonzero and signalled foreground exits remain BashSessionError failures',
        failure instanceof BashSessionError && failure.message.includes(expected.message));
      assert('foreground exit failures preserve true metadata, captured output, and last effective cwd',
        failure.exitCode === expected.exitCode && failure.signal === expected.signal &&
        failure.output === expected.output && failure.error === expected.error && failure.cwd === process.cwd());
    }

    const afterFailures = await wrapped.invoke({ mode: 'execute', command: 'echo recovered' }, context) as BashOutput;
    assert('foreground queue continues after nonzero and signalled failures', afterFailures.output === 'recovered');
  } finally {
    await wrapped.invoke({ mode: 'restart' }, context);
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  }
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
await foregroundCwdPreflightContracts();
await foregroundShellExitContracts();
await shutdownAndExitContracts();
report();
