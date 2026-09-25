/**
 * Background-task wake (SER-069) — a finished `bash start` job wakes the agent as one
 * ordinary queued turn. Free: a real pty, the real TUI, a local fixture model
 * (`spike/fixtures/task-wake-cli.ts`), no provider and no network.
 *
 * What only the full state machine can show, and what this suite pins:
 *
 * 1. **idle**       — a job finishing while idle yields exactly one queued wake, one
 *                     drained turn whose model request carries the `<task-notification>`
 *                     text, one `taskNotification` record and no `userInput` for it.
 * 2. **suppressed** — a job whose terminal state a completed turn already returned
 *                     through `bash wait` yields no wake and no extra model call.
 * 3. **mid-turn**   — a job finishing while the model stream is open is listed as a
 *                     queued wake (own busy-hint word) and drained only after the turn ends.
 * 4. **clear**      — a wake queued while `/clear` assembles its successor is dropped
 *                     with the queue; the successor never receives it.
 * 5. **permission** — (second session, `default` mode) a wake enqueued while a
 *                     permission prompt is open is delivered after the prompt resolves
 *                     and the turn ends — the drain-race pin.
 * 6. **config off** — (third session, `backgroundTaskWake: false`) the completion notice
 *                     appears and nothing else: no queue row, no wake turn, no record.
 * 7. **delegation** — (fourth session, SER-070) a background `subagent` outlives its
 *                     dispatching turn; `/clear` is refused locally while it is tracked; its
 *                     settlement while idle yields exactly one `delegation wake ·` turn whose
 *                     request carries the SDK's `strands_background_task_result` pair (the
 *                     notification never repeats the report); one `taskNotification` record
 *                     with `source: 'delegation'`; `/clear` succeeds once nothing is tracked.
 * 8. **collapsed**  — 19 real completed jobs occupy one summary row, keep typed messages visible
 *                     across resize, retain /tasks details and drain in unchanged FIFO order.
 * 9. **list**       — (sixth session, SRF-033) a completed `bash list` returns terminal jobs
 *                     through the SDK's `{ $value: [...] }` envelope: none of them wakes a turn
 *                     or a model request; a job still running at the list wakes once; a failed
 *                     or a cancelled (Ctrl+C) list turn commits nothing, so every wake behind it drains.
 * 10. **offload**   — (seventh session, SRF-036, `maxResultTokens` just above the preview) a terminal
 *                     `wait` the real `ContextOffloader` replaced with its preview, in a completed turn,
 *                     wakes no turn and no model request; a small wait stays whole and suppresses as
 *                     before; an offloaded `list` suppresses the job its preview names and still wakes
 *                     the one it cut off; a cancelled offloaded-wait turn commits nothing, so it wakes.
 *
 * Before the pty sessions, a free non-pty section drives the real `bash` tool through real
 * SDK agents (scripted model only) to prove the ledger reads the enveloped `list` result,
 * commits only at `endTurn`, and ignores unrelated tools, non-success results and malformed
 * envelopes (non-array `$value`, extra keys, nested envelopes) produced by the SDK's own
 * serialization. A second one adds a real `ContextOffloader` (the runtime's configuration)
 * and the ledger's own `install` hook: an offloaded terminal `wait` commits at `endTurn`
 * only, an offloaded `list` commits only the ids its preview names, and an unrelated tool,
 * a foreground `execute` and an error result — each offloaded or not — commit nothing.
 *
 * Every model request also carries the `bash` tool spec, so the log doubles as proof of
 * the per-runtime wording: the wake variant of the still-running-timeout sentence in the
 * sessions above, the no-wake variant (byte-identical to the pre-wake text) with the key off.
 *
 * Waits are anchored with `mark()` (see `spike/verify-tui.ts`): Ink redraws the whole
 * frame constantly, so an unanchored wait matches an older frame. Idle is detected as
 * the newest `you>` after the newest `working…`, settled for 400 ms. The model-call log
 * the fixture appends (`wake-model-calls.jsonl`) is the proof of what the model was
 * asked; the session's `trajectory.jsonl` is the proof of what was recorded.
 *
 * Run: pnpm tsx spike/verify-task-wake.ts
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Agent, Model, tool } from '@strands-agents/sdk';
import type { AgentStreamEvent, BaseModelConfig, Message, ModelStreamEvent, StreamOptions } from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { ContextOffloader } from '@strands-agents/sdk/vended-plugins/context-offloader';
import { z } from 'zod';

import { OFFLOAD_PREVIEW_TOKENS } from '../src/config.js';
import { sessionPaths, trajectoryPath } from '../src/agent/session.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { TerminalDeliveryLedger, terminalTaskIdsInToolResult } from '../src/agent/task-terminal-delivery.js';
import { BackgroundBashManager, createBackgroundBashTool } from '../src/tools/background-bash.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { formatReplay, replayRead } from '../src/trajectory/replay.js';
import type { TaskNotificationRecord, TrajectoryRecord } from '../src/trajectory/record.js';
import { QUEUED_MARKER } from '../src/tui/prompt-queue.js';
import { backgroundCompletionSentence } from '../src/tools/background-wait-contract.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui, type TuiSession } from './tui-driver.js';

const HOME = ownPrivateHome('task-wake');
const ROOT = path.join(HOME, 'project');
const ENTRY = path.join(REPO_ROOT, 'spike/fixtures/task-wake-cli.ts');
const CALLS = path.join(ROOT, 'wake-model-calls.jsonl');
const BLOCK_CHECKPOINT = path.join(ROOT, 'wake-block-checkpoint');
const BLOCK_RELEASE = path.join(ROOT, 'wake-block-release');
const CLEAR_RELEASE = path.join(ROOT, 'wake-clear-release');
const CLEAR_ARM = path.join(ROOT, 'wake-clear-arm');
const CANCEL_CHECKPOINT = path.join(ROOT, 'wake-cancel-checkpoint');
const EXIT_TIMEOUT_MS = 30_000;
const WAKE_ROW = 'notifications · ';
const WAKE_NOTICE = 'task wake · bg-';
const DELEGATION_WAKE_NOTICE = 'delegation wake · ';

async function writeConfig(extra: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(HOME, '.darwin'), { recursive: true });
  await writeFile(path.join(HOME, '.darwin/config.json'), JSON.stringify({
    provider: 'bedrock',
    model: 'us.anthropic.invalid-task-wake-fixture',
    permissionMode: 'yolo',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    trajectory: true,
    memory: false,
    ...extra,
  }));
}

async function resetProject(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await rm(sessionPaths(ROOT).sessionsDir, { recursive: true, force: true });
}

interface ModelCall {
  call: number;
  userText: string;
  bashDescription?: string;
  /** `parent` sees the delegation tools; a background child (SER-070) does not. */
  role: 'parent' | 'child';
  /** Task ids of the SDK's delivered `strands_background_task_result` pairs in the request. */
  pairTaskIds: string[];
}

async function modelCalls(): Promise<ModelCall[]> {
  try {
    return (await readFile(CALLS, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ModelCall);
  } catch {
    return [];
  }
}

/** True when every request's `bash` spec carries exactly the per-runtime completion sentence. */
function bashSpecsSay(calls: readonly ModelCall[], completionWakes: boolean): boolean {
  const expected = backgroundCompletionSentence(completionWakes);
  const other = backgroundCompletionSentence(!completionWakes);
  return calls.length > 0 && calls.every((call) =>
    call.bashDescription !== undefined && call.bashDescription.includes(expected) && !call.bashDescription.includes(other));
}

/** The wake calls (model requests whose newest user text is a `<task-notification>`) naming `marker`'s job. */
function wakeCallsFor(calls: readonly ModelCall[], marker: string): ModelCall[] {
  return calls.filter((call) => call.userText.includes('<task-notification') && call.userText.includes(marker));
}

async function waitForFile(file: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

function waitForIdle(tui: TuiSession, from: number, timeoutMs = 30_000): Promise<void> {
  return tui.waitUntil((screen) => {
    const tail = screen.slice(from);
    return tail.lastIndexOf('you>') > tail.lastIndexOf('working…') && tail.includes('you>');
  }, { timeoutMs, label: 'an idle prompt', settleMs: 400 });
}

/** Submits one prompt and waits for its turn to start and end; returns the mark taken before it. */
async function runPrompt(tui: TuiSession, text: string): Promise<number> {
  const mark = tui.mark();
  tui.submit(text);
  await tui.waitFor('working…', { timeoutMs: 30_000, from: mark });
  await waitForIdle(tui, mark);
  return mark;
}

/** True when the newest frame is the permission box rather than the input box. */
function awaitsPermission(frame: string): boolean {
  const tail = frame.trimEnd().slice(-600);
  return tail.includes('allow?') && !/you>\s*$/.test(tail);
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function sessionRecords(): Promise<{ id: string; records: TrajectoryRecord[] }[]> {
  const dir = sessionPaths(ROOT).sessionsDir;
  const entries = (await readdir(dir)).filter((name) => name.startsWith('session-')).sort();
  const out: { id: string; records: TrajectoryRecord[] }[] = [];
  for (const id of entries) {
    try {
      out.push({ id, records: (await readTrajectory(trajectoryPath(ROOT, id))).records });
    } catch {
      // a session directory without a record (none expected here)
    }
  }
  return out;
}

/** One scripted model step for the ledger section's real SDK agents. */
type ScriptStep =
  | { readonly tool: string; readonly input: unknown }
  | { readonly text: string }
  | { readonly fail: string }
  | { readonly holdUntilCancel: true };

/** Plays `steps` in order, one per model call; the SDK loop, tools and serialization stay real. */
class ScriptModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.task-wake-ledger', contextWindowLimit: 200_000 };
  private index = 0;

  constructor(private readonly steps: readonly ScriptStep[]) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }

  override async *stream(_messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const step = this.steps[this.index] ?? { text: 'done' };
    this.index += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if ('tool' in step) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: step.tool, toolUseId: `ledger-${this.index}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(step.input) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    if ('fail' in step) throw new Error(step.fail);
    if ('holdUntilCancel' in step) {
      const signal = options?.cancelSignal;
      await new Promise<void>((resolve) => {
        if (signal === undefined || signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'text' in step ? step.text : 'held' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

interface LedgerTurn {
  readonly stopReason: string | undefined;
  readonly failed: boolean;
  /** Each `afterToolCallEvent`'s tool name and result, exactly as the SDK emitted them. */
  readonly results: { name: string; status: string; content: readonly unknown[] }[];
}

/**
 * One turn fed to a ledger exactly as `AgentRuntime.send` feeds its own: every stream
 * event observed, then `closeTurn` with completed = `endTurn`.
 */
async function ledgerTurn(
  agent: Agent,
  ledger: TerminalDeliveryLedger,
  onEvent?: (event: AgentStreamEvent) => void,
): Promise<LedgerTurn> {
  let stopReason: string | undefined;
  let failed = false;
  const results: LedgerTurn['results'] = [];
  try {
    for await (const event of agent.stream('go')) {
      ledger.observe(event);
      const loose = event as unknown as {
        type: string;
        toolUse?: { name: string };
        result?: { status: string; content: readonly unknown[]; stopReason?: string };
      };
      if (loose.type === 'afterToolCallEvent' && loose.toolUse !== undefined && loose.result !== undefined) {
        results.push({ name: loose.toolUse.name, status: String(loose.result.status), content: loose.result.content });
      }
      if (loose.type === 'agentResultEvent') stopReason = loose.result?.stopReason;
      onEvent?.(event);
    }
  } catch {
    failed = true;
  }
  ledger.closeTurn(!failed && stopReason === 'endTurn');
  return { stopReason, failed, results };
}

/** The JSON payload of one SDK tool result, or undefined. */
function jsonOf(content: readonly unknown[]): unknown {
  const block = content[0] as { type?: string; json?: unknown } | undefined;
  return content.length === 1 && block?.type === 'jsonBlock' ? block.json : undefined;
}

/**
 * SRF-033 — the real `list` path. `createBackgroundBashTool` returns `manager.list()` (an
 * array) and the SDK's `FunctionTool` delivers it as `{ $value: [...] }`; the ledger must
 * read that envelope, and only that exact envelope, from successful `bash` results only,
 * committing only at `endTurn`. Real manager, real jobs, real SDK agent loop and tool
 * serialization; only the model is scripted. The pty session below proves the drain.
 */
async function ledgerRealSdkSection(): Promise<void> {
  header('task wake — the ledger reads the SDK-enveloped bash list result (real tool path)');
  await resetProject();
  const manager = new BackgroundBashManager(ROOT, 'session-ledger');
  try {
    const succeeded = (await manager.start('exit 0')).taskId;
    const failed = (await manager.start('exit 3')).taskId;
    const stopped = (await manager.start('sleep 30')).taskId;
    const running = (await manager.start('sleep 30')).taskId;
    await manager.wait(succeeded, 10_000, undefined, false);
    await manager.wait(failed, 10_000, undefined, false);
    await manager.stop(stopped);
    const states = new Map((await manager.list()).map((task) => [task.taskId, task.state]));
    assert('the fixture jobs are in the three terminal states and one running',
      states.get(succeeded) === 'succeeded' && states.get(failed) === 'failed' &&
        states.get(stopped) === 'stopped' && states.get(running) === 'running');
    const terminal = [succeeded, failed, stopped];
    const bash = createBackgroundBashTool(manager);

    // Completed turn: bash list, then endTurn.
    const ledger = new TerminalDeliveryLedger();
    let pendingSeenBeforeClose = false;
    const agent = new Agent({
      model: new ScriptModel([{ tool: 'bash', input: { mode: 'list' } }, { text: 'listed' }]),
      tools: [bash],
      printer: false,
    });
    const listTurn = await ledgerTurn(agent, ledger, (event) => {
      if (event.type === 'afterToolCallEvent') pendingSeenBeforeClose = terminal.some((id) => ledger.has(id));
    });
    const listResult = listTurn.results.find((result) => result.name === 'bash');
    const envelope = jsonOf(listResult?.content ?? []);
    const enveloped = typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope) &&
      Object.keys(envelope).length === 1 && Array.isArray((envelope as { $value?: unknown }).$value);
    assert('the real SDK tool path delivers list as one JsonBlock whose only key is $value, holding the four snapshots',
      listResult?.status === 'success' && enveloped &&
        ((envelope as { $value: unknown[] }).$value).length === 4);
    assert('the list turn completed with endTurn', listTurn.stopReason === 'endTurn' && !listTurn.failed);
    assert('the ledger read the three terminal ids from the enveloped result',
      JSON.stringify(terminalTaskIdsInToolResult('bash', listResult ?? { status: 'error', content: [] }).sort()) ===
        JSON.stringify([...terminal].sort()));
    assert('ids stay pending until the turn closes (none delivered at the tool result)', !pendingSeenBeforeClose);
    assert('the completed turn committed every terminal id', terminal.every((id) => ledger.has(id)));
    assert('the running job listed in the same result is not delivered', !ledger.has(running));

    // Failed and cancelled turns: the same real list result, never committed.
    const failedLedger = new TerminalDeliveryLedger();
    const failedTurn = await ledgerTurn(new Agent({
      model: new ScriptModel([{ tool: 'bash', input: { mode: 'list' } }, { fail: 'fixture model failure after list' }]),
      tools: [bash],
      printer: false,
    }), failedLedger);
    assert('a turn that fails after the list result commits nothing',
      failedTurn.failed && failedTurn.results.length === 1 && terminal.every((id) => !failedLedger.has(id)));

    const cancelledLedger = new TerminalDeliveryLedger();
    const cancelAgent = new Agent({
      model: new ScriptModel([{ tool: 'bash', input: { mode: 'list' } }, { holdUntilCancel: true }]),
      tools: [bash],
      printer: false,
    });
    const cancelledTurn = await ledgerTurn(cancelAgent, cancelledLedger, (event) => {
      if (event.type === 'afterToolCallEvent') setTimeout(() => cancelAgent.cancel(), 50);
    });
    assert('a turn cancelled after the list result commits nothing',
      cancelledTurn.stopReason !== 'endTurn' && cancelledTurn.results.length === 1 &&
        terminal.every((id) => !cancelledLedger.has(id)));

    // An unrelated tool returning the very same array through the same SDK envelope.
    const unrelatedLedger = new TerminalDeliveryLedger();
    const jobs = tool({
      name: 'jobs',
      description: 'Lists the fixture jobs.',
      inputSchema: z.object({}),
      callback: async () => manager.list(),
    });
    const unrelatedTurn = await ledgerTurn(new Agent({
      model: new ScriptModel([{ tool: 'jobs', input: {} }, { text: 'listed' }]),
      tools: [jobs],
      printer: false,
    }), unrelatedLedger);
    assert('an unrelated tool whose SDK-enveloped result carries the same snapshots delivers nothing',
      unrelatedTurn.stopReason === 'endTurn' && enveloped &&
        JSON.stringify(jsonOf(unrelatedTurn.results[0]?.content ?? [])) === JSON.stringify(envelope) &&
        terminal.every((id) => !unrelatedLedger.has(id)));

    // Malformed envelopes, each produced by a `bash`-named tool through the SDK's own serialization.
    const snapshot = (await manager.status(succeeded)) as unknown;
    const malformed: { label: string; value: unknown }[] = [
      { label: '$value is a snapshot, not an array', value: { $value: snapshot } },
      { label: '$value alongside an extra key', value: { $value: [snapshot], note: 'extra' } },
      { label: 'an envelope nested in the array', value: [{ $value: [snapshot] }] },
      { label: 'an envelope nested in $value', value: { $value: { $value: [snapshot] } } },
      { label: '$value is a string', value: { $value: JSON.stringify([snapshot]) } },
    ];
    let malformedIndex = 0;
    const fakeBash = tool({
      name: 'bash',
      description: 'Returns one malformed list shape per call.',
      inputSchema: z.object({ mode: z.string() }),
      callback: async () => malformed[malformedIndex++]?.value,
    });
    const malformedLedger = new TerminalDeliveryLedger();
    const malformedTurn = await ledgerTurn(new Agent({
      model: new ScriptModel([...malformed.map(() => ({ tool: 'bash', input: { mode: 'list' } })), { text: 'done' }]),
      tools: [fakeBash],
      printer: false,
    }), malformedLedger);
    const nestedJson = jsonOf(malformedTurn.results[2]?.content ?? []);
    assert('the SDK wrapped the nested-array case itself as an envelope around an envelope',
      JSON.stringify(nestedJson) === JSON.stringify({ $value: [{ $value: [snapshot] }] }));
    for (const [index, entry] of malformed.entries()) {
      const result = malformedTurn.results[index];
      assert(`malformed envelope is not unwrapped: ${entry.label}`,
        result?.status === 'success' && terminalTaskIdsInToolResult('bash', result).length === 0);
    }
    assert('a completed turn of malformed envelopes delivered nothing',
      malformedTurn.stopReason === 'endTurn' && !malformedLedger.has(succeeded));

    // The shapes that already counted still count; non-bash / non-success never do.
    const envelopeContent = listResult?.content ?? [];
    const snap = snapshot as { taskId: string };
    const ids = (name: string, status: string, content: readonly unknown[]): string[] =>
      terminalTaskIdsInToolResult(name, { status, content });
    assert('a bare array of snapshots still counts', ids('bash', 'success', [{ type: 'jsonBlock', json: [snapshot] }])[0] === snap.taskId);
    assert('a direct snapshot (status/stop) still counts', ids('bash', 'success', [{ type: 'jsonBlock', json: snapshot }])[0] === snap.taskId);
    assert('a wait result still counts',
      ids('bash', 'success', [{ type: 'jsonBlock', json: { reason: 'terminal', status: snapshot, output: {} } }])[0] === snap.taskId);
    assert('the envelope carried as JSON text counts like the JsonBlock',
      ids('bash', 'success', [{ type: 'textBlock', text: JSON.stringify(envelope) }]).length === 3);
    assert('an error-status bash result with the envelope counts for nothing', ids('bash', 'error', envelopeContent).length === 0);
    assert('another tool name with the envelope counts for nothing', ids('bash_list', 'success', envelopeContent).length === 0);
  } finally {
    await manager.shutdown();
  }
}

/** A real SDK `ContextOffloader` configured as the runtime configures it, at the smallest usable threshold. */
function smallOffloader(dir: string): ContextOffloader {
  return new ContextOffloader({
    storage: new LocalFileStorage(dir),
    evictAfterCycles: null,
    excludeTools: ['load_skill'],
    maxResultTokens: OFFLOAD_PREVIEW_TOKENS + 1,
  });
}

/** The offloader's replacement: one text block opening with its `[Offloaded:` marker. */
function offloadPreview(content: readonly unknown[] | undefined): string | undefined {
  const block = content?.[0] as { type?: string; text?: unknown } | undefined;
  return block?.type === 'textBlock' && typeof block.text === 'string' && block.text.startsWith('[Offloaded:')
    ? block.text
    : undefined;
}

async function untilTerminal(manager: BackgroundBashManager, ids: readonly string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const states = await Promise.all(ids.map(async (id) => (await manager.status(id)).state));
    if (states.every((state) => state !== 'running')) return;
    await settle(20);
  }
  throw new Error('fixture jobs never reached a terminal state');
}

/**
 * SRF-036 — the ledger reads the pre-offload `bash` result. A real `ContextOffloader`
 * (runtime configuration, `maxResultTokens` just above the preview) replaces each
 * oversized result with its preview before the stream yields it; the ledger's
 * `install` hook (the runtime's own registration) keeps the original's terminal ids,
 * and `observe` commits one only where the preview names it exactly, at `endTurn`.
 */
async function ledgerOffloadSection(): Promise<void> {
  header('task wake — the ledger reads the pre-offload bash result (real ContextOffloader, SRF-036)');
  await resetProject();
  const manager = new BackgroundBashManager(ROOT, 'session-offload-ledger');
  const listManager = new BackgroundBashManager(ROOT, 'session-offload-list');
  const dir = path.join(ROOT, 'offload-ledger');
  const bash = createBackgroundBashTool(manager);
  const agentWith = (ledger: TerminalDeliveryLedger, steps: readonly ScriptStep[], tools: Agent['tools'] = [bash]): Agent => {
    const agent = new Agent({ model: new ScriptModel(steps), tools, plugins: [smallOffloader(dir)], printer: false });
    ledger.install(agent);
    return agent;
  };
  const bigJob = async (label: string): Promise<string> => (await manager.start(`sleep 0.2; seq 1 3000; echo ${label}`)).taskId;
  const waitStep = (taskId: string): ScriptStep => ({ tool: 'bash', input: { mode: 'wait', taskId, waitMs: 10_000, wakeOnOutput: false } });
  try {
    // Completed turn: an offloaded terminal wait.
    const waited = await bigJob('offload-a');
    const ledger = new TerminalDeliveryLedger();
    let pendingSeenBeforeClose = false;
    const turn = await ledgerTurn(agentWith(ledger, [waitStep(waited), { text: 'waited' }]), ledger, (event) => {
      if (event.type === 'afterToolCallEvent') pendingSeenBeforeClose = ledger.has(waited);
    });
    const result = turn.results.find((entry) => entry.name === 'bash');
    const preview = offloadPreview(result?.content);
    assert('the terminal wait result reached the stream as the offloader\'s one-block preview',
      result?.status === 'success' && result.content.length === 1 && preview !== undefined);
    assert('the model-visible preview opens with the terminal reason and names the task id',
      preview?.includes('"reason": "terminal"') === true && preview.includes(waited));
    assert('the stream-side result alone yields no terminal id (the pre-SRF-036 failure mechanism)',
      result !== undefined && terminalTaskIdsInToolResult('bash', result).length === 0);
    assert('the offloaded wait turn completed with endTurn', turn.stopReason === 'endTurn' && !turn.failed);
    assert('the offloaded id stays pending until the turn closes', !pendingSeenBeforeClose);
    assert('the completed turn committed the offloaded wait\'s terminal id', ledger.has(waited));

    // Control: a small wait under the same offloader stays whole and counts as before.
    const small = (await manager.start('echo offload-small')).taskId;
    const smallLedger = new TerminalDeliveryLedger();
    const smallTurn = await ledgerTurn(agentWith(smallLedger, [waitStep(small), { text: 'waited' }]), smallLedger);
    assert('a small wait result is not offloaded (one JsonBlock) and its completed turn commits it',
      jsonOf(smallTurn.results[0]?.content ?? []) !== undefined && smallTurn.stopReason === 'endTurn' && smallLedger.has(small));

    // Failed and cancelled turns forget an offloaded wait.
    const failedJob = await bigJob('offload-failed');
    const failedLedger = new TerminalDeliveryLedger();
    const failedTurn = await ledgerTurn(agentWith(failedLedger, [waitStep(failedJob), { fail: 'fixture failure after offloaded wait' }]), failedLedger);
    assert('a turn that fails after an offloaded wait commits nothing',
      failedTurn.failed && offloadPreview(failedTurn.results[0]?.content) !== undefined && !failedLedger.has(failedJob));
    const cancelledJob = await bigJob('offload-cancelled');
    const cancelledLedger = new TerminalDeliveryLedger();
    const cancelAgent = agentWith(cancelledLedger, [waitStep(cancelledJob), { holdUntilCancel: true }]);
    const cancelledTurn = await ledgerTurn(cancelAgent, cancelledLedger, (event) => {
      if (event.type === 'afterToolCallEvent') setTimeout(() => cancelAgent.cancel(), 50);
    });
    assert('a turn cancelled after an offloaded wait commits nothing',
      cancelledTurn.stopReason !== 'endTurn' && offloadPreview(cancelledTurn.results[0]?.content) !== undefined &&
        !cancelledLedger.has(cancelledJob));

    // An offloaded list: the id inside the preview counts, the id beyond it does not.
    const listBash = createBackgroundBashTool(listManager);
    const seen = (await listManager.start(`echo list-seen; : ${'x'.repeat(5_000)}`)).taskId;
    const hidden = (await listManager.start('echo list-hidden')).taskId;
    await untilTerminal(listManager, [seen, hidden]);
    const original = terminalTaskIdsInToolResult('bash', { status: 'success', content: [{ type: 'jsonBlock', json: { $value: await listManager.list() } }] });
    assert('the original list result carries both jobs as terminal',
      original.length === 2 && original.includes(seen) && original.includes(hidden));
    const listLedger = new TerminalDeliveryLedger();
    const listTurn = await ledgerTurn(agentWith(listLedger, [{ tool: 'bash', input: { mode: 'list' } }, { text: 'listed' }], [listBash]), listLedger);
    const listPreview = offloadPreview(listTurn.results[0]?.content);
    assert('the list result was offloaded; its preview names the first job but not the second',
      listPreview?.includes(seen) === true && !listPreview.includes(hidden));
    assert('the completed list turn committed the id the preview names', listLedger.has(seen));
    assert('the terminal id beyond the preview was not committed, so its wake still fires', !listLedger.has(hidden));

    // Unrelated tool, foreground execute and error results contribute nothing, offloaded or not.
    const unrelatedJob = await bigJob('offload-unrelated');
    const unrelatedLedger = new TerminalDeliveryLedger();
    const waitTool = tool({
      name: 'jobs_wait',
      description: 'Waits for a fixture job.',
      inputSchema: z.object({}),
      callback: async () => manager.wait(unrelatedJob, 10_000, undefined, false),
    });
    const unrelatedTurn = await ledgerTurn(agentWith(unrelatedLedger, [{ tool: 'jobs_wait', input: {} }, { text: 'done' }], [waitTool]), unrelatedLedger);
    assert('an unrelated tool\'s offloaded wait-shaped result, naming the id, delivers nothing',
      offloadPreview(unrelatedTurn.results[0]?.content)?.includes(unrelatedJob) === true &&
        unrelatedTurn.stopReason === 'endTurn' && !unrelatedLedger.has(unrelatedJob));

    const snapshotFile = path.join(ROOT, 'terminal-snapshot.json');
    await writeFile(snapshotFile, JSON.stringify(await manager.status(small)));
    const executeLedger = new TerminalDeliveryLedger();
    const executeTurn = await ledgerTurn(agentWith(executeLedger, [
      { tool: 'bash', input: { mode: 'execute', command: `cat ${snapshotFile}; seq 1 3000` } },
      { text: 'done' },
    ]), executeLedger);
    assert('a foreground execute whose offloaded output prints a terminal snapshot delivers nothing',
      offloadPreview(executeTurn.results[0]?.content)?.includes(small) === true &&
        executeTurn.stopReason === 'endTurn' && !executeLedger.has(small));

    const errorPayload = JSON.stringify({ reason: 'terminal', status: await manager.status(waited), output: {} });
    const failingBash = tool({
      name: 'bash',
      description: 'Fails with a terminal wait payload in its message.',
      inputSchema: z.object({ mode: z.string() }),
      callback: async () => { throw new Error(`${errorPayload}\n${'y'.repeat(8_000)}`); },
    });
    const errorLedger = new TerminalDeliveryLedger();
    const errorTurn = await ledgerTurn(agentWith(errorLedger, [{ tool: 'bash', input: { mode: 'wait' } }, { text: 'done' }], [failingBash]), errorLedger);
    assert('an error bash result naming a terminal id delivers nothing',
      errorTurn.results[0]?.status === 'error' && errorTurn.stopReason === 'endTurn' && !errorLedger.has(waited));

    // Observer discipline and turn scoping of candidates, on the ledger's own seams.
    const bare = new TerminalDeliveryLedger();
    let threw = false;
    try {
      bare.candidate(undefined as never);
      bare.candidate({ toolUse: null, result: null } as never);
      bare.observe({ type: 'afterToolCallEvent', toolUse: { name: 'bash', toolUseId: 'x' }, result: { status: 'success', content: null } } as never);
      bare.observe(undefined as never);
    } catch {
      threw = true;
    }
    assert('candidate and observe never throw on malformed events', !threw);
    const originalWait = { status: 'success', content: [{ type: 'jsonBlock', json: { reason: 'terminal', status: await manager.status(waited), output: {} } }] };
    const replaced = { status: 'success', content: [{ type: 'textBlock', text: `[Offloaded: 1 blocks] ${waited}` }] };
    const afterEvent = (result: unknown): never => ({ type: 'afterToolCallEvent', toolUse: { name: 'bash', toolUseId: 'stale-1' }, result }) as never;
    bare.candidate(afterEvent(originalWait));
    bare.closeTurn(false);
    bare.observe(afterEvent(replaced));
    bare.closeTurn(true);
    assert('a candidate whose turn closed before its stream event is forgotten, never carried into a later turn', !bare.has(waited));
    bare.candidate(afterEvent(originalWait));
    bare.observe(afterEvent({ status: 'error', content: replaced.content }));
    bare.closeTurn(true);
    assert('a replacement that is no longer a success commits no candidate', !bare.has(waited));
  } catch (error) {
    assert(`the offload ledger section ran to completion (threw: ${error instanceof Error ? error.message : String(error)})`, false);
  } finally {
    await manager.shutdown();
    await listManager.shutdown();
  }
}

async function mainSession(): Promise<void> {
  header('task wake — idle, suppressed, mid-turn and /clear in one session (yolo)');
  await resetProject();
  await writeConfig({});
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });

    // --- 1. idle: the job ends after the turn; exactly one wake, one turn. ---
    const idleMark = await runPrompt(tui, 'start-idle idle-marker-alpha');
    const idleCallsBefore = (await modelCalls()).length;
    assert('the starting turn is over before the idle job ends (2 model calls: start, text)', idleCallsBefore === 2);
    await tui.waitFor('background task bg-', { timeoutMs: 20_000, from: idleMark });
    await tui.waitFor(WAKE_NOTICE, { timeoutMs: 20_000, from: idleMark, settleMs: 200 });
    await tui.waitFor('acknowledged wake for bg-', { timeoutMs: 20_000, from: idleMark });
    await waitForIdle(tui, idleMark);
    await settle(1_500);
    let calls = await modelCalls();
    const idleWakes = wakeCallsFor(calls, 'idle-marker-alpha');
    assert('exactly one model request carried the notification for the idle job', idleWakes.length === 1);
    assert('the wake turn was one turn: exactly one model call after the start turn', calls.length === 3);
    const idleText = idleWakes[0]?.userText ?? '';
    assert('the notification names the task, its state and exit code in an actionable vocabulary',
      /<task-notification task="bg-[0-9a-f-]{36}" state="succeeded" exitCode="0" signal="" elapsed="\d+s">/.test(idleText) &&
        idleText.includes('command: sleep 2; echo idle-marker-alpha') &&
        idleText.includes('bash output') && idleText.endsWith('</task-notification>'));
    assert('the notification carries the output tail', idleText.includes('\nidle-marker-alpha\n'));
    const idleScreen = tui.screen.slice(idleMark);
    assert('exactly one wake notice row was written for the idle job',
      idleScreen.split(WAKE_NOTICE).length - 1 === 1);
    assert('the wake notice names the job as sent to the model',
      /task wake · bg-[0-9a-f]{8} succeeded — sleep 2; echo idle-marker-alpha → sent to the model as this turn/.test(idleScreen));
    assert('the wake never appeared as a typed `you>` row', !idleScreen.includes('you> <task-notification'));
    assert('every request so far carried the wake variant of the bash completion sentence, never the no-wake one',
      bashSpecsSay(calls, true));

    // --- 2. suppressed: the model already consumed the terminal state via `wait`. ---
    const waitMark = tui.mark();
    tui.submit('start-and-wait wait-marker-beta');
    await tui.waitFor('waited job wait-marker-beta to its end', { timeoutMs: 30_000, from: waitMark });
    await waitForIdle(tui, waitMark);
    await settle(2_000);
    calls = await modelCalls();
    assert('the wait turn made three calls (start, wait, text) and nothing followed it', calls.length === 6);
    assert('no model request carried a notification for the waited job', wakeCallsFor(calls, 'wait-marker-beta').length === 0);
    const waitScreen = tui.screen.slice(waitMark);
    assert('the completion notice still appeared for the waited job', waitScreen.includes('background task bg-'));
    // The job ends while the `wait` turn is open, so its wake is listed for the rest
    // of that turn; the drain then finds the turn completed with the terminal state
    // delivered and drops it — nothing sent, no wake notice, no row left behind.
    assert('no wake notice was written for the waited job', !waitScreen.includes(WAKE_NOTICE));
    assert('the suppressed wake left the listing at idle', !tui.frame.includes(WAKE_ROW));

    // --- 3. mid-turn: the job ends while the model stream is open. ---
    const blockMark = tui.mark();
    tui.submit('start-then-block block-marker-gamma');
    await waitForFile(BLOCK_CHECKPOINT);
    await tui.waitFor(WAKE_ROW, { timeoutMs: 20_000, from: blockMark, settleMs: 300 });
    const busyFrame = tui.frame;
    assert('the notification summary is shown while the turn is still streaming',
      busyFrame.includes(WAKE_ROW) && busyFrame.includes('working…'));
    assert('the busy hint names a pending notification, not a queued job', busyFrame.includes('· 1 notification pending'));
    assert('the summary states the outcome, delivery timing and detail command without a payload dump',
      busyFrame.includes('notifications · 1 pending (1 succeeded) · after this turn · /tasks') &&
        !busyFrame.includes(`${QUEUED_MARKER} [task`) && !busyFrame.includes('<task-notification'));
    calls = await modelCalls();
    assert('nothing was injected mid-stream: no wake request while the turn is open',
      wakeCallsFor(calls, 'block-marker-gamma').length === 0 && calls.length === 8);
    await writeFile(BLOCK_RELEASE, 'go\n');
    await tui.waitFor('acknowledged wake for bg-', { timeoutMs: 30_000, from: blockMark });
    await waitForIdle(tui, blockMark);
    await settle(1_000);
    calls = await modelCalls();
    assert('after the turn ended the wake drained as exactly one more model call',
      wakeCallsFor(calls, 'block-marker-gamma').length === 1 && calls.length === 9);
    assert('the drained wake row left the listing', !tui.frame.includes(WAKE_ROW));

    // --- 4. /clear: a wake queued during successor assembly is dropped. ---
    await runPrompt(tui, 'start-clear-window clear-marker-delta');
    await writeFile(CLEAR_ARM, 'arm\n');
    const clearSubmit = tui.mark();
    tui.submit('/clear');
    await tui.waitFor(WAKE_ROW, { timeoutMs: 20_000, from: clearSubmit, settleMs: 300 });
    assert('a wake queued while /clear assembles its successor is visible, not lost silently',
      tui.frame.includes(WAKE_ROW));
    await writeFile(CLEAR_RELEASE, 'go\n');
    await tui.waitFor('cleared — new session', { timeoutMs: 30_000, from: clearSubmit, settleMs: 300 });
    await settle(2_000);
    assert('/clear dropped the pending wake with the queue', !tui.frame.includes(WAKE_ROW));
    calls = await modelCalls();
    assert('the successor never received the dropped wake',
      wakeCallsFor(calls, 'clear-marker-delta').length === 0);
    assert('no wake notice was written after /clear', !tui.screen.slice(clearSubmit).includes(WAKE_NOTICE));

    tui.submit('/exit');
    assert('the session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }

  header('task wake — the trajectory: taskNotification records, never userInput');
  const sessions = await sessionRecords();
  const first = sessions[0];
  assert('the original session was recorded (the /clear successor may or may not have written a file yet)',
    first !== undefined && sessions.length <= 2);
  const records = first?.records ?? [];
  const wakes = records.filter((record): record is TaskNotificationRecord => record.type === 'taskNotification');
  const userInputs = records.filter((record) => record.type === 'userInput');
  assert('exactly two taskNotification records: the idle job and the mid-turn job', wakes.length === 2);
  assert('the records carry the job fields and the exact model-facing text',
    wakes.every((wake) => /^bg-[0-9a-f-]{36}$/.test(wake.taskId) && wake.state === 'succeeded' && wake.exitCode === 0 &&
      wake.signal === null && wake.text.startsWith('<task-notification ') && wake.text.includes(wake.taskId)));
  assert('their commands are the two jobs, in order',
    wakes[0]?.command === 'sleep 2; echo idle-marker-alpha' && wakes[1]?.command === 'sleep 0.5; echo block-marker-gamma');
  assert('no userInput line carries the wake text',
    !userInputs.some((record) => record.type === 'userInput' && record.text.includes('task-notification')));
  assert('a wake turn has no userInput of its own',
    wakes.every((wake) => !userInputs.some((record) => record.turn === wake.turn)));
  assert('the typed prompts are the four userInput lines (/clear is local and never sent)',
    userInputs.length === 4 && userInputs.every((record) => record.type === 'userInput' && record.text.startsWith('start-')));
  const closed = records.filter((record) => record.type === 'turnEnded');
  assert('each wake turn closed like any other turn', wakes.every((wake) => closed.some((record) => record.turn === wake.turn)));
  assert('the successor holds no taskNotification',
    sessions.slice(1).every((session) => session.records.every((record) => record.type !== 'taskNotification')));

  const replay = formatReplay(replayRead(await readTrajectory(trajectoryPath(ROOT, first?.id ?? ''))));
  assert('replay prints the wake through the same reducer row the live session showed',
    replay.split('\n').filter((line) => line.startsWith('  note task wake · bg-')).length === 2 &&
      replay.includes('succeeded — sleep 2; echo idle-marker-alpha → sent to the model as this turn'));
  assert('replay never prints the wake as a you> row', !replay.includes('you> <task-notification'));
}

async function permissionSession(): Promise<void> {
  header('task wake — a wake enqueued under an open permission prompt is delivered after it resolves (default mode)');
  await resetProject();
  await writeConfig({ permissionMode: 'default' });
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
    const mark = tui.mark();
    tui.submit('start-then-permission perm-marker-epsilon');
    await tui.waitFor('working…', { timeoutMs: 30_000, from: mark });
    // `default` mode asks for the `bash start` itself (`sleep` is not on the static
    // safe list): approve it, then the gated foreground command's prompt is the one
    // that stays open while the job finishes.
    await tui.waitUntil(() => awaitsPermission(tui.frame) && tui.frame.includes('bash: sleep 1.5; echo perm-marker-epsilon'), {
      timeoutMs: 30_000, label: 'the bash start permission prompt', settleMs: 300,
    });
    tui.send('y');
    await tui.waitUntil(() => awaitsPermission(tui.frame) && tui.frame.includes('gated-perm-marker-epsilon'), {
      timeoutMs: 30_000, label: 'the gated command permission prompt', settleMs: 300,
    });
    assert('the gated command\'s permission prompt is open while the job runs',
      tui.frame.includes('gated-perm-marker-epsilon') && tui.frame.includes('allow?'));
    await tui.waitFor(WAKE_ROW, { timeoutMs: 20_000, from: mark, settleMs: 300 });
    const promptFrame = tui.frame;
    assert('the wake is queued while the permission prompt is still open — held, not sent',
      promptFrame.includes(WAKE_ROW) && promptFrame.includes('allow?'));
    const callsBefore = await modelCalls();
    assert('no model request carried the notification while the prompt was open',
      wakeCallsFor(callsBefore, 'perm-marker-epsilon').length === 0);
    tui.send('y');
    await tui.waitFor('gated command done for perm-marker-epsilon', { timeoutMs: 30_000, from: mark });
    await tui.waitFor('acknowledged wake for bg-', { timeoutMs: 30_000, from: mark });
    await waitForIdle(tui, mark);
    await settle(1_000);
    const calls = await modelCalls();
    const wakeCalls = wakeCallsFor(calls, 'perm-marker-epsilon');
    assert('after the prompt resolved and the turn ended, the wake drained as exactly one model call',
      wakeCalls.length === 1 && wakeCalls[0]!.call === calls.length);
    assert('the wake turn came after the approved edit turn', (wakeCalls[0]?.call ?? 0) > callsBefore.length);
    assert('the wake left the listing once sent', !tui.frame.includes(WAKE_ROW));
    tui.submit('/exit');
    assert('the permission session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}

async function configOffSession(): Promise<void> {
  header('task wake — backgroundTaskWake: false keeps the notice-only behaviour');
  await resetProject();
  await writeConfig({ backgroundTaskWake: false });
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
    const mark = await runPrompt(tui, 'start-idle off-marker-zeta');
    await tui.waitFor('background task bg-', { timeoutMs: 20_000, from: mark, settleMs: 300 });
    await settle(2_500);
    const screen = tui.screen.slice(mark);
    assert('the completion notice appears as before the feature',
      /background task bg-[0-9a-f]{8} succeeded in \d+s — sleep 2; echo off-marker-zeta/.test(screen));
    assert('no wake row and no wake notice', !screen.includes(WAKE_ROW) && !screen.includes(WAKE_NOTICE));
    const calls = await modelCalls();
    assert('the model was called for the start turn only', calls.length === 2 && wakeCallsFor(calls, 'off-marker-zeta').length === 0);
    assert('with the key off every request carried the no-wake bash completion sentence, never the wake one',
      bashSpecsSay(calls, false));
    tui.submit('/exit');
    assert('the config-off session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
  const sessions = await sessionRecords();
  assert('the config-off record holds no taskNotification',
    sessions.length === 1 && sessions[0]!.records.every((record) => record.type !== 'taskNotification'));
}

async function delegationSession(): Promise<void> {
  header('task wake — a background delegation settles while idle: one wake, the SDK attaches the report (SER-070)');
  await resetProject();
  await writeConfig({});
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
    const mark = await runPrompt(tui, 'delegate-idle deleg-marker-eta');
    let calls = await modelCalls();
    const parentCalls = calls.filter((call) => call.role === 'parent');
    assert('the dispatching turn ended after the ack: two parent calls (subagent, text), the child still running',
      parentCalls.length === 2 && parentCalls[1]?.pairTaskIds.length === 0 && tui.screen.slice(mark).includes('dispatched deleg-marker-eta'));
    assert('the ack row names the task and the live delegation row survives the turn',
      /delegated in background \(task [0-9a-f-]{8,}/.test(tui.screen.slice(mark))
      && /count deleg-marker-eta · background \(\d+s/.test(tui.frame));

    // `/clear` while the delegation is tracked is a local refusal, not a new session.
    const clearMark = tui.mark();
    tui.submit('/clear');
    await tui.waitFor('/clear refused', { timeoutMs: 10_000, from: clearMark, settleMs: 200 });
    // Word-wrapped at 120 columns: rejoin the wrapped lines before matching the sentence.
    const refusal = tui.screen.slice(clearMark).replace(/\s*\r?\n\s*/g, ' ');
    assert('/clear is refused locally, naming the task, the dispatch id and both exits',
      /\/clear refused — a background delegation is still tracked: subagent #deleg\d+ \(task [0-9a-f-]{36}, running\)/.test(refusal)
      && refusal.includes('/agents cancel <id>') && refusal.includes('wait for the completion wake'));
    await settle(300);
    assert('the session is unchanged: no "cleared — new session", the same child still runs',
      !refusal.includes('cleared — new session') && (await modelCalls()).length === calls.length);

    // The child settles while idle → exactly one delegation wake → one turn carrying the pair.
    await tui.waitFor(DELEGATION_WAKE_NOTICE, { timeoutMs: 20_000, from: mark, settleMs: 200 });
    await tui.waitFor('acknowledged wake for ', { timeoutMs: 20_000, from: mark });
    await waitForIdle(tui, mark);
    await settle(1_500);
    calls = await modelCalls();
    const wakeCalls = calls.filter((call) => call.role === 'parent' && call.userText.includes('<task-notification'));
    const childCalls = calls.filter((call) => call.role === 'child');
    assert('exactly one child ran and exactly one wake request was made', childCalls.length === 1 && wakeCalls.length === 1);
    assert('no further model call followed the wake turn', calls.length === 4);
    const wakeText = wakeCalls[0]?.userText ?? '';
    const taskId = /task="([0-9a-f-]{36})"/.exec(wakeText)?.[1];
    assert('the notification names the delegation, its state and elapsed time, and points at the SDK pair — never the report',
      taskId !== undefined && /<task-notification task="[0-9a-f-]{36}" tool="subagent" state="succeeded" elapsed="\d+s">/.test(wakeText)
      && wakeText.includes('delegation: subagent general#deleg') && wakeText.includes('strands_background_task_result')
      && !wakeText.includes('child counted') && wakeText.endsWith('</task-notification>'));
    assert('the wake turn\'s request carried the SDK\'s result pair for that task — attached by the SDK, not copied by darwin',
      taskId !== undefined && wakeCalls[0]?.pairTaskIds.length === 1 && wakeCalls[0].pairTaskIds[0] === taskId);
    const screen = tui.screen.slice(mark);
    assert('exactly one delegation wake notice row was written', screen.split(DELEGATION_WAKE_NOTICE).length - 1 === 1);
    assert('the wake notice names the delegation as sent to the model',
      /delegation wake · [0-9a-f]{8} succeeded — subagent general#deleg\d+: count deleg-marker-eta → sent to the model as this turn/
        .test(screen.replace(/\s*\r?\n\s*/g, ' ')));
    assert('the delegation row closed as the background result row with the child\'s report',
      screen.includes('· background result') && screen.includes('child counted deleg-marker-eta'));
    assert('the wake never appeared as a typed `you>` row', !screen.includes('you> <task-notification'));
    assert('no live delegation row is left', !/count deleg-marker-eta · background \(\d+s/.test(tui.frame));

    // Nothing tracked any more: `/clear` now succeeds (the window is not armed here).
    const clearAgain = tui.mark();
    tui.submit('/clear');
    await tui.waitFor('cleared — new session', { timeoutMs: 30_000, from: clearAgain, settleMs: 300 });
    tui.submit('/exit');
    assert('the delegation session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
  const sessions = await sessionRecords();
  const records = sessions[0]?.records ?? [];
  const wakes = records.filter((record): record is TaskNotificationRecord => record.type === 'taskNotification');
  assert('one taskNotification record with source: delegation, the label as command, null exit metadata',
    wakes.length === 1 && wakes[0]?.source === 'delegation' && /^[0-9a-f-]{36}$/.test(wakes[0].taskId)
    && wakes[0].command.startsWith('subagent general#deleg') && wakes[0].state === 'succeeded'
    && wakes[0].exitCode === null && wakes[0].signal === null && wakes[0].text.startsWith('<task-notification '));
  assert('the wake turn has no userInput of its own', !records.some((record) => record.type === 'userInput' && record.turn === wakes[0]?.turn));
  const replay = formatReplay(replayRead(await readTrajectory(trajectoryPath(ROOT, sessions[0]?.id ?? ''))));
  assert('replay prints the delegation wake notice and the background result row through the same reducer',
    replay.split('\n').filter((line) => line.startsWith(`  note ${DELEGATION_WAKE_NOTICE}`)).length === 1
    && replay.includes('· background result') && replay.includes('child counted deleg-marker-eta'));
}

/** Polls the model-call log until `predicate` holds; returns the calls it held on. */
async function waitForCalls(predicate: (calls: ModelCall[]) => boolean, label: string, timeoutMs = 30_000): Promise<ModelCall[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const calls = await modelCalls();
    if (predicate(calls)) return calls;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await settle(50);
  }
}

/**
 * SRF-033 — a completed `bash list` delivered terminal jobs' states through the SDK's
 * `{ $value: [...] }` envelope, so their queued wakes are dropped at the drain; a job
 * still running at the list wakes once when it ends; a failed or cancelled list turn
 * commits nothing, so every queued wake behind it still drains as its own turn.
 */
async function listSession(): Promise<void> {
  header('task wake — a completed bash list (SDK $value envelope) suppresses the wakes of the jobs it returned');
  await resetProject();
  await writeConfig({});
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });

    // --- completed: three terminal jobs listed, one job still running at the list. ---
    const listMark = tui.mark();
    tui.submit('start-list-complete list-marker-eta');
    await tui.waitFor('listed 3 terminal list-marker-eta jobs from a $value list result', { timeoutMs: 30_000, from: listMark });
    await waitForIdle(tui, listMark);
    let calls = await modelCalls();
    assert('the list turn made six model calls (four starts, the list, the answer) and the model saw the $value envelope',
      calls.length === 6);
    calls = await waitForCalls((all) => wakeCallsFor(all, 'list-marker-eta-late').length === 1, 'the late job\'s wake');
    await waitForIdle(tui, listMark);
    await settle(2_000);
    calls = await modelCalls();
    for (const index of [0, 1, 2]) {
      assert(`no model request carried a notification for listed terminal job ${index}`,
        wakeCallsFor(calls, `list-marker-eta-done-${index}`).length === 0);
    }
    assert('the job still running at the list woke exactly one turn after it ended',
      wakeCallsFor(calls, 'list-marker-eta-late').length === 1 && calls.length === 7);
    const listScreen = tui.screen.slice(listMark);
    assert('the only wake notice is the late job\'s',
      listScreen.split(WAKE_NOTICE).length - 1 === 1 &&
        /task wake · bg-[0-9a-f]{8} succeeded — sleep 3; echo list-marker-eta-late/.test(listScreen));
    assert('the suppressed wakes left the listing at idle', !tui.frame.includes(WAKE_ROW));

    // --- failed: the list result reached the model, but the turn failed. ---
    const failMark = tui.mark();
    const beforeFail = calls.length;
    tui.submit('start-list-fail list-marker-theta');
    calls = await waitForCalls((all) =>
      wakeCallsFor(all, 'list-marker-theta-done-0').length === 1 && wakeCallsFor(all, 'list-marker-theta-done-1').length === 1,
    'both wakes behind the failed list turn');
    await waitForIdle(tui, failMark);
    await settle(1_500);
    calls = await modelCalls();
    assert('the failed list turn was visible as a failure', tui.screen.slice(failMark).includes('model failure after list'));
    assert('a failed list turn commits nothing: each listed job still woke exactly one turn',
      wakeCallsFor(calls, 'list-marker-theta-done-0').length === 1 &&
        wakeCallsFor(calls, 'list-marker-theta-done-1').length === 1 &&
        calls.length === beforeFail + 4 + 2);

    // --- cancelled: the list result reached the model, then Ctrl+C cancels the turn. ---
    const cancelMark = tui.mark();
    const beforeCancel = calls.length;
    tui.submit('start-list-cancel list-marker-iota');
    await waitForFile(CANCEL_CHECKPOINT, 30_000);
    await settle(300);
    tui.send('\u0003');
    await tui.waitFor('interrupted — press ctrl+c again to exit', { timeoutMs: 10_000, from: cancelMark });
    calls = await waitForCalls((all) =>
      wakeCallsFor(all, 'list-marker-iota-done-0').length === 1 && wakeCallsFor(all, 'list-marker-iota-done-1').length === 1,
    'both wakes behind the cancelled list turn');
    await waitForIdle(tui, cancelMark);
    await settle(1_500);
    calls = await modelCalls();
    assert('a cancelled list turn commits nothing: each listed job still woke exactly one turn',
      wakeCallsFor(calls, 'list-marker-iota-done-0').length === 1 &&
        wakeCallsFor(calls, 'list-marker-iota-done-1').length === 1 &&
        calls.length === beforeCancel + 4 + 2);

    tui.submit('/exit');
    assert('the list session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }

  const records = (await sessionRecords())[0]?.records ?? [];
  const wakes = records.filter((record): record is TaskNotificationRecord => record.type === 'taskNotification');
  assert('the trajectory holds exactly the five delivered wakes (late, two after the failure, two after the cancel)',
    wakes.length === 5 && wakes.filter((wake) => wake.command.includes('list-marker-eta-done')).length === 0);
}

/**
 * SRF-036 — the real runtime's `ContextOffloader` at `maxResultTokens` just above the
 * preview replaces a terminal `wait` result with its preview; the ledger's pre-offload
 * hook still sees the original, so a completed turn suppresses that job's wake. Controls
 * in the same offloading session: a small wait stays whole and suppresses as before, an
 * offloaded `list` suppresses the job its preview names and still wakes the one it cut
 * off, and a cancelled turn after an offloaded wait commits nothing, so the job wakes.
 */
async function offloadSession(): Promise<void> {
  header('task wake — an offloaded terminal wait suppresses its wake (real ContextOffloader, SRF-036)');
  await resetProject();
  await writeConfig({ maxResultTokens: OFFLOAD_PREVIEW_TOKENS + 1 });
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });

    // --- completed: the terminal wait reached the model as the offloader's preview. ---
    const bigMark = tui.mark();
    tui.submit('start-and-wait-big offload-marker-kappa');
    await tui.waitFor('waited big job offload-marker-kappa to its end through an offloaded preview', { timeoutMs: 30_000, from: bigMark });
    await waitForIdle(tui, bigMark);
    await settle(2_000);
    let calls = await modelCalls();
    assert('the offloaded wait turn made three calls (start, wait, text) and nothing followed it', calls.length === 3);
    assert('no model request carried a notification for the offloaded-wait job', wakeCallsFor(calls, 'offload-marker-kappa').length === 0);
    const bigScreen = tui.screen.slice(bigMark);
    assert('the completion notice still appeared for the offloaded-wait job', bigScreen.includes('background task bg-'));
    assert('no wake notice was written for the offloaded-wait job', !bigScreen.includes(WAKE_NOTICE));
    assert('the suppressed offloaded-wait wake left the listing at idle', !tui.frame.includes(WAKE_ROW));

    // --- control: a small wait under the same offloader stays whole and suppresses as before. ---
    const smallMark = tui.mark();
    tui.submit('start-and-wait offload-marker-lambda');
    await tui.waitFor('waited job offload-marker-lambda to its end', { timeoutMs: 30_000, from: smallMark });
    await waitForIdle(tui, smallMark);
    await settle(2_000);
    calls = await modelCalls();
    const smallScreen = tui.screen.slice(smallMark);
    assert('the small wait reached the model whole (no offloaded preview)', !smallScreen.includes('lambda to its end through'));
    assert('the whole-result wait suppressed its wake as before', calls.length === 6 &&
      wakeCallsFor(calls, 'offload-marker-lambda').length === 0 && !smallScreen.includes(WAKE_NOTICE));

    // --- offloaded list: the job the preview names is suppressed, the one it cut off wakes. ---
    const listMark = tui.mark();
    tui.submit('start-list-offload offload-marker-mu');
    await tui.waitFor('list offload-marker-mu offloaded: seen id in preview, hidden id not in preview', { timeoutMs: 30_000, from: listMark });
    calls = await waitForCalls((all) => wakeCallsFor(all, 'offload-marker-mu-hidden').length === 1, 'the cut-off job\'s wake');
    await waitForIdle(tui, listMark);
    await settle(2_000);
    calls = await modelCalls();
    assert('the job whose id the list preview named woke no turn', wakeCallsFor(calls, 'offload-marker-mu-seen').length === 0);
    assert('the job cut off by the list preview woke exactly one turn',
      wakeCallsFor(calls, 'offload-marker-mu-hidden').length === 1 && calls.length === 6 + 4 + 1);
    const listScreen = tui.screen.slice(listMark);
    assert('the only wake notice after the list is the cut-off job\'s',
      listScreen.split(WAKE_NOTICE).length - 1 === 1 && listScreen.includes('echo offload-marker-mu-hidden'));

    // --- cancelled: the offloaded wait reached the model, then Ctrl+C cancels the turn. ---
    const cancelMark = tui.mark();
    const beforeCancel = calls.length;
    tui.submit('start-and-wait-big-cancel offload-marker-nu');
    await waitForFile(CANCEL_CHECKPOINT, 30_000);
    assert('the cancelled turn\'s model saw the offloaded preview',
      (await readFile(CANCEL_CHECKPOINT, 'utf8')).includes('offload-marker-nu to its end through an offloaded preview'));
    await settle(300);
    tui.send('\u0003');
    await tui.waitFor('interrupted — press ctrl+c again to exit', { timeoutMs: 10_000, from: cancelMark });
    calls = await waitForCalls((all) => wakeCallsFor(all, 'offload-marker-nu').length === 1, 'the wake behind the cancelled offloaded wait');
    await waitForIdle(tui, cancelMark);
    await settle(1_500);
    calls = await modelCalls();
    assert('a cancelled offloaded-wait turn commits nothing: the job still woke exactly one turn',
      wakeCallsFor(calls, 'offload-marker-nu').length === 1 && calls.length === beforeCancel + 3 + 1);

    tui.submit('/exit');
    assert('the offload session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }

  const records = (await sessionRecords())[0]?.records ?? [];
  const wakes = records.filter((record): record is TaskNotificationRecord => record.type === 'taskNotification');
  assert('the trajectory holds exactly the two delivered wakes (the cut-off list job, the cancelled wait)',
    wakes.length === 2 && wakes.some((wake) => wake.command.includes('offload-marker-mu-hidden')) &&
      wakes.some((wake) => wake.command.includes('offload-marker-nu')));
}

async function collapsedNotificationsSession(): Promise<void> {
  header('task wake — nineteen completions share one row without changing delivery');
  await resetProject();
  await writeConfig({});
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 120, rows: 40 });
  try {
    await tui.waitFor('you>', { timeoutMs: 60_000, settleMs: 300 });
    tui.submit('start-many-block bulk-marker');
    await waitForFile(BLOCK_CHECKPOINT);
    await tui.waitUntil(() => tui.frame.includes('notifications · 19 pending'), {
      timeoutMs: 20_000, label: 'nineteen collapsed notifications', settleMs: 300,
    });
    assert('nineteen settled jobs occupy exactly one live notification row, with failure first',
      tui.frame.split('\n').filter((row) => row.startsWith(WAKE_ROW)).length === 1 &&
      tui.frame.includes('(1 failed, 18 succeeded) · after this turn · /tasks') &&
      !tui.frame.includes(`${QUEUED_MARKER} [task`));
    tui.submit('after-bulk');
    await tui.waitUntil(() => tui.frame.includes('queued · after-bulk'), {
      timeoutMs: 10_000, label: 'typed prompt beside notifications', settleMs: 300,
    });
    tui.resize(60, 24);
    await tui.waitUntil(() => tui.frame.includes('notifications · 19 pending') && tui.frame.includes('queued · after-bulk'), {
      timeoutMs: 10_000, label: 'collapsed queue in a narrow terminal', settleMs: 300,
    });
    assert('the narrow frame retains the notification count and the typed message',
      tui.frame.includes('notifications · 19 pending') && tui.frame.includes('queued · after-bulk'));
    tui.resize(120, 40);
    const detailsMark = tui.mark();
    tui.submit('/tasks');
    await tui.waitFor('bulk-marker-18', { from: detailsMark, timeoutMs: 10_000, settleMs: 300 });
    assert('/tasks still exposes the collapsed jobs while busy without sending a model request',
      (await modelCalls()).length === 20 && tui.frame.includes('notifications · 19 pending'));
    await writeFile(BLOCK_RELEASE, 'go\n');
    await tui.waitUntil(() => !tui.frame.includes('working…') && !tui.frame.includes(WAKE_ROW) &&
      !tui.frame.includes('queued · after-bulk'), {
      timeoutMs: 30_000, label: 'the notification queue fully drained', settleMs: 500,
    });
    const calls = await modelCalls();
    assert('all nineteen notifications drain once and the queued user prompt keeps its FIFO position',
      wakeCallsFor(calls, 'bulk-marker').length === 19 && calls.length === 40 && calls.at(-1)?.userText === 'after-bulk');
    tui.submit('/exit');
    assert('the collapsed-notification session exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}

async function main(): Promise<void> {
  try {
    await ledgerRealSdkSection();
    await ledgerOffloadSection();
    await mainSession();
    await permissionSession();
    await configOffSession();
    await delegationSession();
    await collapsedNotificationsSession();
    await listSession();
    await offloadSession();
  } finally {
    await rm(HOME, { recursive: true, force: true });
  }
  report();
}

await main();
