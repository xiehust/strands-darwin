/**
 * Offline contracts for the opt-in per-session diagnostics log.
 *
 * The one claim that would be worthless if faked is "the SDK's own `debug` output
 * reaches the file", so it is not faked: every capture assertion below drives a real
 * `Agent` with a real `PermissionGate` intervention and a scripted model, and the
 * lines that land in the file are the ones the SDK's `interventions/registry` really
 * logged. The same goes for the other direction — "off is off" is measured by running
 * the same real turn with no tap installed and finding no file — because the SDK's
 * root export map exposes `configureLogging` only, so there is no logger binding a
 * test could inspect instead. Real `warn` output comes from two real SDK sources as
 * well (`new BedrockModel({})`'s default-model nudge and `Model.estimateUtilization`'s
 * missing-window nudge), neither of which touches the network.
 *
 * No model call, no network, no writes outside this suite's own temp directories.
 *
 * Run: pnpm tsx spike/verify-diagnostics.ts
 */
import { mkdir, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  BedrockModel,
  Model,
  tool,
  type AgentStreamEvent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import { z } from 'zod';

import {
  DiagnosticsLog,
  MAX_DIAGNOSTICS_BYTES,
  MAX_DIAGNOSTIC_LINE_CHARS,
  formatDiagnosticLine,
} from '../src/agent/diagnostics.js';
import { PermissionGate } from '../src/agent/permission.js';
import {
  routeSdkLogs,
  setSdkVerboseSink,
  type SdkLogEntry,
  type SdkVerboseLogEntry,
} from '../src/agent/sdk-logging.js';
import { diagnosticsPath, trajectoryPath } from '../src/agent/session.js';
import { formatHeadlessDiagnosticsProblem } from '../src/headless.js';
import { withNoticeDiagnostics } from '../src/tui/App.js';
import { initialTurnState, turnReducer, type TurnAction } from '../src/tui/turn-state.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// `diagnosticsPath()` resolves under HOME like every other session path, so the suite
// owns its HOME before deriving one.
const OWNED_HOME = ownPrivateHome('diagnostics');

const ROOT = path.join(os.tmpdir(), 'darwin-diagnostics-project');
const RUN = {
  session: 'session-test',
  darwinVersion: '0.0.0-test',
  provider: 'bedrock',
  model: 'global.anthropic.claude-opus-5',
} as const;

/**
 * A model that calls one tool and then answers. No network.
 *
 * The tool call is not decoration: darwin's intervention is the `PermissionGate`,
 * which implements `onBeforeToolCall` only — and the SDK's registry skips (and so
 * never logs) a dispatch no handler implements. A turn with a tool call is therefore
 * the shape that produces real SDK `debug` output, and it is also the shape of every
 * real darwin turn.
 */
class ScriptedModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.diagnostics', contextWindowLimit: 200_000 };

  constructor(private readonly reply = 'scripted answer') {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const answered = messages.some((message) =>
      message.content.some((block) => block.type === 'toolResultBlock'),
    );
    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    if (!answered) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'echoTool', toolUseId: 'call-1' },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify({ note: 'hello' }) },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: this.reply } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

const echo = tool({
  name: 'echoTool',
  description: 'Returns its input for diagnostics tests.',
  inputSchema: z.object({ note: z.string() }),
  callback: ({ note }) => `echoed ${note}`,
});

/**
 * A model that never says how big its context window is.
 *
 * `Model.estimateUtilization` nudges about that once per process, at `warn` — a real
 * SDK warning reachable with no network, which is what the routing assertions need.
 */
class WindowlessModel extends ScriptedModel {
  override getConfig(): BaseModelConfig {
    return { modelId: 'fake.windowless' };
  }
}

/**
 * A real agent with the intervention darwin always installs.
 *
 * The gate is what makes this a *real* source of SDK `debug` output: the SDK's
 * intervention registry logs each dispatch it performs and each handler it evaluates,
 * and the scripted tool call above is what makes it perform one — so a turn here
 * produces the same lines a production turn does.
 */
function newAgent(): Agent {
  return new Agent({
    id: 'darwin',
    model: new ScriptedModel(),
    systemPrompt: 'diagnostics test',
    tools: [echo],
    printer: false,
    interventions: [new PermissionGate({ mode: 'yolo', projectRoot: ROOT, ask: async () => ({ allowed: true }) })],
  });
}

/** Runs one real turn, collecting every event exactly as a caller would see it. */
async function runTurn(agent: Agent): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  for await (const event of agent.stream('hello')) events.push(event);
  return events;
}

/** Records what the SDK emitted, before any consumer sees it. */
async function* tee(
  source: AsyncIterable<AgentStreamEvent>,
  emitted: AgentStreamEvent[],
): AsyncIterable<AgentStreamEvent> {
  for await (const event of source) {
    emitted.push(event);
    yield event;
  }
}

async function caseDir(name: string): Promise<string> {
  const dir = path.join(ROOT, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Lines of a written log, without the trailing empty element. */
async function lines(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter((line) => line !== '');
}

// ---------------------------------------------------------------------------

async function paths(): Promise<void> {
  header('diagnostics — where the file lives');

  // Asserted before anything is written: if this fails, the rest of the suite is
  // writing into the developer's own ~/.darwin.
  assert(
    "session paths resolve inside this suite's own HOME",
    diagnosticsPath(ROOT, 'session-x').startsWith(`${OWNED_HOME}${path.sep}`),
  );

  const log = diagnosticsPath(ROOT, 'session-x');
  const record = trajectoryPath(ROOT, 'session-x');
  assert('the log is a sibling of the trajectory in the same session directory', path.dirname(log) === path.dirname(record));
  assert('…and it is named diagnostics.log', path.basename(log) === 'diagnostics.log');
  assert('nothing resolves into the project working tree', !log.startsWith(path.resolve(ROOT) + path.sep));
}

async function lineFormat(): Promise<void> {
  header('diagnostics — one event is one parseable line');

  const at = '2026-08-16T12:00:00.000Z';
  const line = formatDiagnosticLine(at, { source: 'sdk', level: 'debug', message: 'msg_idx=<3> | added cache point' });
  assert('the line ends with exactly one newline', line.endsWith('\n') && !line.slice(0, -1).includes('\n'));

  const [stamp = '', source = '', level = '', ...rest] = line.trimEnd().split(' ').filter((part) => part !== '');
  assert('it starts with an ISO timestamp', stamp === at && !Number.isNaN(Date.parse(stamp)));
  assert('then the source', source === 'sdk');
  assert('then the level', level === 'debug');
  assert('then the message after the delimiter', rest[0] === '—' && line.includes('— msg_idx=<3> | added cache point'));

  // A multi-line notice (the `/usage` table, say) must not be able to turn one event
  // into several lines a reader or a `grep -c` would miscount.
  const collapsed = formatDiagnosticLine(at, { source: 'darwin', level: 'info', message: 'token usage\n  input   12\n  output  3' });
  assert('a multi-line message is collapsed to one line', collapsed.split('\n').length === 2);
  assert('…keeping its words', collapsed.includes('token usage input 12 output 3'));

  const long = formatDiagnosticLine(at, { source: 'sdk', level: 'error', message: 'x'.repeat(20_000) });
  assert('an oversized message is capped', [...long].length < 20_000);
  assert('…and the line says it was cut, with the original size', long.includes('(truncated, 20000 code points)'));
  assert(
    '…keeping exactly the cap in code points',
    long.slice(long.indexOf('— ') + 2).startsWith('x'.repeat(MAX_DIAGNOSTIC_LINE_CHARS) + '…'),
  );

  // Multi-byte safety: the cap counts code points, so an emoji cannot be split.
  const emoji = formatDiagnosticLine(at, { source: 'sdk', level: 'debug', message: '🙂'.repeat(9_000) });
  assert('a multi-byte message is cut on a code-point boundary', !emoji.includes('\uFFFD'));

  assert('the default per-session budget is 8 MiB', MAX_DIAGNOSTICS_BYTES === 8 * 1024 * 1024);
}

async function sdkDebugCapture(): Promise<void> {
  header('diagnostics — the SDK debug output darwin used to discard');

  const dir = await caseDir('capture');
  const file = path.join(dir, 'diagnostics.log');
  const log = new DiagnosticsLog({ file, run: RUN });

  const rendered: SdkLogEntry[] = [];
  const restore = routeSdkLogs((entry) => rendered.push(entry));
  setSdkVerboseSink(log.sdkSink);
  let activeDuringRun = false;
  try {
    const agent = newAgent();
    await agent.initialize();
    await runTurn(agent);
    // Read before `close()`, which latches the log shut on purpose: "still logging"
    // is a claim about the session, not about the moment after it ended.
    activeDuringRun = log.status.active && log.status.problem === undefined;
  } finally {
    setSdkVerboseSink(undefined);
    restore();
  }
  await log.close();

  const written = await lines(file);
  const debugLines = written.filter((line) => / sdk    debug /.test(line));
  console.log(`  captured ${debugLines.length} sdk debug line(s); first: ${debugLines[0] ?? '(none)'}`);

  assert('the file was created by the first line', written.length > 0);
  assert('the SDK’s own debug output is in it', debugLines.length > 0);
  assert(
    '…including a line the SDK really logged for this turn',
    debugLines.some((line) => line.includes('| dispatching to 1 handler(s)')),
  );
  assert(
    '…and one naming the intervention it evaluated',
    debugLines.some((line) => /handler=<darwin:permission-gate>, event=<beforeToolCall> \| evaluating/.test(line)),
  );
  assert(
    'every line carries a timestamp a reader can parse',
    written.every((line) => !Number.isNaN(Date.parse(line.slice(0, 24)))),
  );
  assert(
    'the first line describes the run',
    (written[0] ?? '').includes(`diagnostics started · session ${RUN.session}`) &&
      (written[0] ?? '').includes(`${RUN.provider}/${RUN.model}`),
  );
  assert('…and states the budget up front', (written[0] ?? '').includes(`budget ${MAX_DIAGNOSTICS_BYTES} bytes`));
  assert('nothing was rendered to the user for a debug line', rendered.length === 0);
  assert('the log kept logging throughout the turn', activeDuringRun);
  assert('…and counts what it wrote', log.status.linesThisRun === written.length && log.status.bytesThisRun > 0);
  assert('a closed log stops accepting lines', !log.status.active && log.status.problem === undefined);
}

async function offIsOff(): Promise<void> {
  header('diagnostics — off is indistinguishable from before the feature existed');

  const dir = await caseDir('off');
  const file = path.join(dir, 'diagnostics.log');

  const rendered: SdkLogEntry[] = [];
  const restore = routeSdkLogs((entry) => rendered.push(entry));
  // No tap: exactly the production default, where `sdk-logging.ts` installs literal
  // no-ops for `debug`/`info`.
  try {
    const agent = newAgent();
    await agent.initialize();
    const events = await runTurn(agent);
    assert('the turn ran', events.some((event) => event.type === 'agentResultEvent'));
  } finally {
    restore();
  }

  assert('no diagnostics file was created anywhere', !(await exists(file)));
  const leftovers = await readFile(path.join(dir, 'diagnostics.log'), 'utf8').catch(() => '');
  assert('…not even an empty one', leftovers === '');
  assert('and no debug line reached the renderer', rendered.length === 0);
}

async function warnRouting(): Promise<void> {
  header('diagnostics — warn/error still reach the renderer, and now the file too');

  const dir = await caseDir('warn');
  const file = path.join(dir, 'diagnostics.log');
  const log = new DiagnosticsLog({ file, run: RUN });

  const rendered: SdkLogEntry[] = [];
  const tapped: SdkVerboseLogEntry[] = [];
  const restore = routeSdkLogs((entry) => rendered.push(entry));
  setSdkVerboseSink((entry) => {
    tapped.push(entry);
    log.sdkSink(entry);
  });
  try {
    // A real SDK warning, offline: constructing a Bedrock model without a model id
    // makes the SDK nudge about the default it picked. `warnOnce` dedupes per process,
    // so this fires exactly once — which is why it is used once, here.
    new BedrockModel({});
  } finally {
    setSdkVerboseSink(undefined);
    restore();
  }
  await log.close();

  console.log(`  rendered: ${rendered[0]?.message.slice(0, 90) ?? '(none)'}`);
  assert('the renderer still receives the SDK warning', rendered.length === 1 && rendered[0]?.level === 'warn');
  assert('the tap receives the same warning', tapped.length === 1 && tapped[0]?.message === rendered[0]?.message);
  const written = await lines(file);
  assert('…and it is in the file, labelled sdk warn', written.some((line) => / sdk    warn  /.test(line)));

  // The other half of the contract: with no tap, a real SDK warning still reaches the
  // renderer and still writes no file.
  const bare = await caseDir('warn-no-tap');
  const bareFile = path.join(bare, 'diagnostics.log');
  const alone: SdkLogEntry[] = [];
  const restoreBare = routeSdkLogs((entry) => alone.push(entry));
  try {
    // A second real SDK warning source, also offline and also `warnOnce`-guarded: a
    // model that never says how big its context window is gets nudged once.
    new ScriptedModel().estimateUtilization(1_000);
    new WindowlessModel().estimateUtilization(1_000);
  } finally {
    restoreBare();
  }
  assert('a real SDK warning still reaches the renderer with no tap installed', alone.length === 1);
  assert('…and a model that answers the question is not warned about', !(alone[0]?.message ?? '').includes('fake.diagnostics'));
  assert('…and wrote no file', !(await exists(bareFile)));
}

async function notices(): Promise<void> {
  header('diagnostics — darwin’s own notices, with their severity');

  const dir = await caseDir('notices');
  const file = path.join(dir, 'diagnostics.log');
  const log = new DiagnosticsLog({ file, run: RUN });

  const seen: TurnAction[] = [];
  const dispatch = withNoticeDiagnostics((action) => seen.push(action), log);

  const warned: TurnAction = { type: 'notice', text: 'trajectory: EACCES', severity: 'warn' };
  dispatch({ type: 'notice', text: 'loaded skill commit-message' });
  dispatch(warned);
  dispatch({ type: 'notice', text: 'turn failed: boom', severity: 'error' });
  dispatch({ type: 'userInput', text: 'not a notice' });
  await log.close();

  assert('every action still reaches the reducer', seen.length === 4);
  assert('…as the identical object', seen[1] === warned);
  // The reducer stays the one projection: replaying a record must not write a log.
  const state = seen.reduce((current, action) => turnReducer(current, action), initialTurnState);
  assert('…and the reducer still produces the same history', state.history.length === 4);

  const written = await lines(file);
  assert('a notice with no severity is written as info', written.some((line) => / darwin info  — loaded skill commit-message$/.test(line)));
  assert('a warn notice keeps its severity', written.some((line) => / darwin warn  — trajectory: EACCES$/.test(line)));
  assert('an error notice keeps its severity', written.some((line) => / darwin error — turn failed: boom$/.test(line)));
  assert('a non-notice action writes nothing', !written.some((line) => line.includes('not a notice')));

  // With no log, the dispatch is handed straight back: the default run's notice path
  // is not merely equivalent, it is the same function.
  const raw = (action: TurnAction): void => void action;
  assert('with no log the dispatch is returned unwrapped', withNoticeDiagnostics(raw, undefined) === raw);
}

async function writeFailure(): Promise<void> {
  header('diagnostics — an unwritable path degrades to one problem');

  const dir = await caseDir('unwritable');
  // A regular file where the log's directory should be. The real failure a user hits is
  // an unwritable home (EACCES), which cannot be arranged in a test without root; this
  // fails the same way at the same point — the first `mkdir` inside the first append.
  const blocker = path.join(dir, 'blocked');
  await writeFile(blocker, 'not a directory\n', 'utf8');
  const file = path.join(blocker, 'diagnostics.log');

  const log = new DiagnosticsLog({ file, run: RUN });
  let threw = false;
  try {
    log.write({ source: 'sdk', level: 'debug', message: 'throttled | error_message=<slow down>' });
    log.notice('a notice nobody will read', 'warn');
  } catch {
    threw = true;
  }
  await log.close();

  assert('writing never throws into the caller', !threw);
  assert('the failure is latched once', log.status.problem !== undefined && !log.status.active);
  assert('…naming the file and the reason', (log.status.problem ?? '').includes(file));
  console.log(`  problem: ${log.status.problem}`);

  const record = formatHeadlessDiagnosticsProblem(log.status);
  assert('headless reports it as one bounded record', record?.startsWith('diagnostics: ') === true);
  assert('…on one line', (record ?? '').split('\n').length === 1);
  assert('a run with no log has nothing to report', formatHeadlessDiagnosticsProblem(undefined) === undefined);

  // A later line is silently ignored rather than retried per event: the latch is what
  // stops one broken disk becoming a per-event error storm.
  log.write({ source: 'sdk', level: 'debug', message: 'later' });
  assert('later lines are dropped without a second problem', log.status.problem !== undefined);
}

async function budget(): Promise<void> {
  header('diagnostics — the byte budget stops it, and the file says so');

  const dir = await caseDir('budget');
  const file = path.join(dir, 'diagnostics.log');
  // Small enough that a handful of lines reaches it; the constant itself is 8 MiB, and
  // a bound that only appears after 8 MiB of real writes is a bound nothing tests.
  const log = new DiagnosticsLog({ file, run: RUN, maxBytes: 600 });

  for (let index = 0; index < 40; index += 1) {
    log.write({ source: 'sdk', level: 'debug', message: `line ${index} ${'y'.repeat(40)}` });
  }
  await log.close();

  const written = await lines(file);
  const last = written[written.length - 1] ?? '';
  console.log(`  ${written.length} line(s), last: ${last}`);
  assert('the stop is stated in the file itself', last.includes('diagnostics stopped: reached the 600-byte per-session budget'));
  assert('…and says nothing after it was written', last.includes('nothing after this line was written'));
  assert('the marker is the final line', written.filter((line) => line.includes('diagnostics stopped')).length === 1);
  assert('logging is latched off', !log.status.active);
  assert('…with a problem a caller can surface once', (log.status.problem ?? '').includes('reached its 600-byte budget'));
  assert('the file stayed inside its budget plus the marker', (await stat(file)).size < 600 + 200);

  // A second run appends to the same file and must see the bytes already there, or the
  // budget would restart on every process.
  const again = new DiagnosticsLog({ file, run: RUN, maxBytes: 600 });
  again.write({ source: 'sdk', level: 'debug', message: 'second run' });
  await again.close();
  assert('a later run inherits the file’s size, so the budget is per session', !again.status.active);
}

async function backpressure(): Promise<void> {
  header('diagnostics — a firehose drops lines, counts them, and writes it down');

  const dir = await caseDir('backpressure');
  const file = path.join(dir, 'diagnostics.log');

  // A gate the suite opens by hand, so the append chain is genuinely stuck while lines
  // arrive — which is the situation a slow disk creates during a long turn.
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunks: string[] = [];
  const gatedOpen = (async (target: string, flags: string) => {
    await gate;
    return {
      write: async (payload: string) => {
        chunks.push(payload);
        return { bytesWritten: Buffer.byteLength(payload, 'utf8'), buffer: payload };
      },
      read: async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }),
      close: async () => {
        void target;
        void flags;
      },
    };
  }) as unknown as typeof open;

  const log = new DiagnosticsLog({ file, run: RUN, openFile: gatedOpen, maxPendingBytes: 400 });
  for (let index = 0; index < 200; index += 1) {
    log.write({ source: 'sdk', level: 'debug', message: `flood ${index} ${'z'.repeat(60)}` });
  }
  assert('lines were dropped rather than buffered without bound', log.status.droppedLines > 0);
  console.log(`  dropped ${log.status.droppedLines} of 200 offered line(s) at a 400-byte pending bound`);

  release();
  await log.close();
  const text = chunks.join('');
  assert('the drop is written into the log, not swallowed', /darwin warn  — \d+ line\(s\) dropped: the writer could not keep up/.test(text));
  assert('…and the log is still usable afterwards', log.status.problem === undefined);
  assert('the lines that fit were still written', text.includes('flood 0'));
}

async function observer(): Promise<void> {
  header('diagnostics — the tap cannot touch a turn');

  const dir = await caseDir('observer');
  const file = path.join(dir, 'diagnostics.log');

  const bare = newAgent();
  await bare.initialize();
  const withoutTap = await runTurn(bare);

  // A tee at the source: `emitted` is what the SDK produced, `seen` is what the
  // consumer got. Identity comparison on one run, not equality between two — two runs
  // of an Agent legitimately differ (tracking ids, timings), so comparing them whole
  // would be both the wrong claim and a flaky test. Across runs only the shape is
  // compared, which is what "nothing was added, dropped or reordered" means.
  const emitted: AgentStreamEvent[] = [];
  const log = new DiagnosticsLog({ file, run: RUN });
  setSdkVerboseSink(log.sdkSink);
  const seen: AgentStreamEvent[] = [];
  try {
    const agent = newAgent();
    await agent.initialize();
    for await (const event of tee(agent.stream('hello'), emitted)) seen.push(event);
  } finally {
    setSdkVerboseSink(undefined);
  }
  await log.close();

  assert('every event the SDK produced reached the consumer', seen.length === emitted.length);
  assert('…as the identical objects, in order', seen.every((event, index) => event === emitted[index]));
  assert(
    'the event sequence is the same as a run with no tap installed',
    seen.map((event) => event.type).join(',') === withoutTap.map((event) => event.type).join(','),
  );
  assert('…and there were events to compare', seen.length > 0);
  assert('the tap did record that turn', (await lines(file)).some((line) => / sdk    debug /.test(line)));

  // The internal catch, exercised: an entry that cannot be formatted must cost the log,
  // never the caller.
  const hostile = new DiagnosticsLog({ file: path.join(dir, 'hostile.log'), run: RUN });
  let threw = false;
  try {
    hostile.write({
      source: 'sdk',
      level: 'debug',
      get message(): string {
        throw new Error('message getter exploded');
      },
    });
  } catch {
    threw = true;
  }
  await hostile.close();
  assert('a line that cannot be formatted does not throw into the caller', !threw);
  assert('…it latches the log instead', hostile.status.problem?.includes('message getter exploded') === true);
}

async function runtimeCreateFailureUnwinds(): Promise<void> {
  header('diagnostics — AgentRuntime.create failure unwinds the installed tap');
  const root = await caseDir('runtime-create-failure');
  const configDir = path.join(OWNED_HOME, '.darwin');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'bedrock',
      model: 'global.anthropic.claude-opus-5',
      region: 'us-west-2',
      maxTokens: 1024,
      diagnostics: true,
      permissionMode: 'yolo',
    }),
  );

  const { AgentRuntime, setRuntimeCreateCheckpointForTest } = await import('../src/agent/runtime.js');
  setRuntimeCreateCheckpointForTest(() => {
    throw new Error('injected AgentRuntime.create failure after initialization');
  });
  let sessionId = '';
  let failure = '';
  try {
    await AgentRuntime.create({
      projectRoot: root,
      session: { kind: 'new' },
      onSessionResolved: (resolved) => { sessionId = resolved; },
      permissionBridge: async () => ({ allowed: true }),
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    setRuntimeCreateCheckpointForTest(undefined);
  }
  assert('the injected startup failure reaches the caller', failure.includes('injected AgentRuntime.create failure'));
  const file = diagnosticsPath(root, sessionId);
  const before = (await stat(file)).size;
  assert('startup diagnostics were flushed before failure returned', before > 0);

  // A real local Agent tool call emits SDK debug lines. If create left its verbose
  // tap installed, this would append to the failed runtime's log.
  await runTurn(newAgent());

  const fakeClient = { disconnect: async () => { throw new Error('cleanup mcp'); } };
  const fakeBackground = { shutdown: async () => { throw new Error('cleanup bash'); } };
  const aggregateLog = new DiagnosticsLog({ file: path.join(root, 'aggregate-unwind.log'), run: RUN });
  setSdkVerboseSink(aggregateLog.sdkSink);
  await AgentRuntime.unwindCreate(
    aggregateLog,
    [fakeClient as never],
    fakeBackground as never,
  );
  assert('startup unwind settles every cleanup even when peers fail', aggregateLog.status.active === false);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert('the failed runtime log is closed and the SDK tap is reset', (await stat(file)).size === before);
}


async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  await paths();
  await lineFormat();
  await sdkDebugCapture();
  await offIsOff();
  await warnRouting();
  await notices();
  await runtimeCreateFailureUnwinds();

  await writeFailure();
  await budget();
  await backpressure();
  await observer();
  report();
}

await main();
