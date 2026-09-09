/**
 * Offline contracts for the append-only session trajectory, and for the three
 * primitives that read it: search, fork and replay.
 *
 * Everything here runs against real SDK objects — a real `Agent` with a scripted
 * `Model`, a real `SessionManager` and `LocalFileStorage`, real files — and makes no
 * model call and no network request. The two properties that would be worthless if
 * faked are driven through the exact production code: the pass-through observer
 * (`recordStream`, which is all `AgentRuntime.send` does) is measured over a real
 * `Agent.stream()`, and replay goes through the same `turnReducer` the TUI uses.
 *
 * Run: pnpm tsx spike/verify-trajectory.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  Agent,
  Model,
  ModelError,
  SessionManager,
  tool,
  type BaseModelConfig,
  type AgentStreamEvent,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
  type Usage,
} from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { z } from 'zod';

import { allowAllBridge, PermissionGate } from '../src/agent/permission.js';
import {
  AgentRuntime,
  setRuntimeModelFactoryForTest,
  setRuntimeRecorderOverridesForTest,
} from '../src/agent/runtime.js';
import { startCallSpend, startTurnSpend, type UsageTotals } from '../src/agent/usage.js';
import { withSoleChoice, type AppConfig } from '../src/config.js';
import { CliUsageError, parseCliArgs } from '../src/cli-args.js';
import {
  isTrajectoryInvocation,
  parseTrajectoryArgs,
  runTrajectoryCommand,
} from '../src/cli-trajectory.js';
import {
  isValidSessionId,
  listSessionIds,
  resolveSession,
  sessionPaths,
  snapshotPath,
  trajectoryPath,
} from '../src/agent/session.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import { loadAgentDefinitions } from '../src/agents/loader.js';
import { formatTrajectoryReport } from '../src/tui/App.js';
import { initialTurnState, turnReducer } from '../src/tui/turn-state.js';
import { forkSession } from '../src/trajectory/fork.js';
import { describeDamage, readTrajectory, TrajectoryMissingError } from '../src/trajectory/reader.js';
import {
  MAX_FAILURE_SUMMARY_CHARS,
  MAX_FIELD_CHARS,
  MAX_RECORD_BYTES,
  MAX_REWIND_ORIGIN_CHARS,
  contextCompactedOf,
  failureFromError,
  formatTurnFailure,
  modelCallOf,
  parseRecordLine,
  permissionDecisionOf,
  rewindOriginOf,
  searchableText,
  turnFailureOf,
  turnOutcome,
  turnSpendOf,
  type CallSpendProjector,
  type ContextCompactedRecord,
  type ModelCallRecord,
  type PermissionDecisionRecord,
  type RunStartedRecord,
  type TrajectoryRecord,
  type TurnEndedRecord,
  type TurnSpendMeter,
} from '../src/trajectory/record.js';
import {
  formatContextCompacted,
  formatPermissionDecision,
  formatReplay,
  historyWithoutIds,
  replayRead,
  replayRecords,
} from '../src/trajectory/replay.js';
import {
  MAX_MODEL_LABEL_CHARS,
  formatSpendSummary,
  summarizeSpend,
} from '../src/trajectory/spend.js';
import { searchTrajectories, UnknownSessionError } from '../src/trajectory/search.js';
import { recordStream } from '../src/trajectory/stream.js';
import { TrajectoryRecorder, type RecorderRunInfo } from '../src/trajectory/writer.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// Every path below resolves under `~/.darwin/sessions/<project-key>/`, so the suite
// owns its HOME before anything derives one.
const OWNED_HOME = ownPrivateHome('trajectory');
const AGENT_ID = 'darwin';

const ROOT = path.join(os.tmpdir(), 'darwin-trajectory-project');

/** A model that answers with text, and optionally calls one tool first. */
class ScriptedModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.trajectory', contextWindowLimit: 200_000 };

  constructor(
    private readonly reply: string,
    private readonly toolCall?: { name: string; input: unknown },
    /** Emitted as a reasoning block before the answer, to prove it is never stored. */
    private readonly reasoning?: string,
    /** How the answer's message stops; a refusal-class reason models a provider block. */
    private readonly stopReason: 'endTurn' | 'contentFiltered' | 'guardrailIntervened' | 'refusal' = 'endTurn',
  ) {
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

    if (this.toolCall !== undefined && !answered) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: this.toolCall.name, toolUseId: 'call-1' },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.toolCall.input) },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }

    if (this.reasoning !== undefined) {
      yield { type: 'modelContentBlockStartEvent' };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'reasoningContentDelta', text: this.reasoning, signature: 'sig-abc' },
      };
      yield { type: 'modelContentBlockStopEvent' };
    }

    yield { type: 'modelContentBlockStartEvent' };
    // Split across deltas so the recorder's delta handling is exercised, and so a
    // cancelled turn has partial text to retain.
    for (const chunk of chunks(this.reply)) {
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: chunk } };
    }
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: this.stopReason };
  }
}

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += 7) out.push(text.slice(index, index + 7));
  return out;
}

/** Reads the trajectory synchronously with model invocation to prove the barrier. */
class InspectingModel extends ScriptedModel {
  invoked = false;
  seenInput = false;

  constructor(
    public file: string,
    public expectedInput: string,
  ) {
    super('answer after offline inspection');
  }

  override async *stream(
    messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.invoked = true;
    const read = await readTrajectory(this.file);
    this.seenInput = read.records.some(
      (record) => record.type === 'userInput' && record.text === this.expectedInput,
    );
    yield* super.stream(messages, options);
  }
}

const echo = tool({
  name: 'echoTool',
  description: 'Returns its input for trajectory tests.',
  inputSchema: z.object({ note: z.string() }),
  callback: ({ note }) => `echoed ${note}`,
});

/** A distinct class, so what the record names can be told apart from `Error`. */
class ProviderExplosion extends ModelError {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderExplosion';
  }
}

/**
 * A model that streams real text and then throws — the shape of a provider failing
 * mid-turn.
 *
 * It extends `ModelError` deliberately: measured on `@strands-agents/sdk@1.12.0`,
 * `Model.streamAggregated` rethrows a `ModelError` untouched but wraps anything else
 * in `new ModelError(message, { cause })`. Both paths are exercised below, because a
 * real Bedrock rejection takes the second one.
 */
class ThrowingModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.throwing', contextWindowLimit: 200_000 };

  constructor(
    private readonly thrown: unknown,
    private readonly before = 'text before the failure',
  ) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    for (const chunk of chunks(this.before)) {
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: chunk } };
    }
    throw this.thrown;
  }
}

/**
 * A model that reports token usage the way a provider does — through a
 * `modelMetadataEvent` — and can call a tool first, or throw on a chosen call.
 *
 * Deliberately not a fake meter: the events go through the real `Model` →
 * `Agent._invokeModel` path, so the numbers the record ends up holding were accumulated
 * by the SDK's own `Meter`, and a claim about the delta of `agent.metrics.accumulatedUsage`
 * is a claim about production code. `usage: undefined` on a step models a provider that
 * reported nothing for that call.
 */
interface MeteredStep {
  usage?: Usage;
  /** Emitted as a tool call, so one turn can contain two metered model calls. */
  toolCall?: { name: string; input: unknown };
  /** Thrown instead of finishing this call, after some text has already streamed. */
  throws?: unknown;
  text?: string;
}

class MeteredModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.metered', contextWindowLimit: 200_000 };
  private call = 0;

  constructor(private readonly script: readonly MeteredStep[]) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  /** Model calls made so far, so a test can prove a turn really had two cycles. */
  get calls(): number {
    return this.call;
  }

  override async *stream(): AsyncIterable<ModelStreamEvent> {
    const step = this.script[Math.min(this.call, this.script.length - 1)] as MeteredStep;
    this.call += 1;

    yield { type: 'modelMessageStartEvent', role: 'assistant' };

    if (step.toolCall !== undefined) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: step.toolCall.name, toolUseId: `call-${this.call}` },
      };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: { type: 'toolUseInputDelta', input: JSON.stringify(step.toolCall.input) },
      };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      // After the stop event, exactly where Bedrock puts it.
      if (step.usage !== undefined) yield { type: 'modelMetadataEvent', usage: step.usage };
      return;
    }

    yield { type: 'modelContentBlockStartEvent' };
    for (const chunk of chunks(step.text ?? 'a metered answer')) {
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: chunk } };
    }
    if (step.throws !== undefined) {
      // A call that throws reports no metadata, which is exactly what a rejected request
      // does: the SDK never accumulates usage for it, so the turn is billed nothing for it.
      throw step.throws;
    }
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    if (step.usage !== undefined) yield { type: 'modelMetadataEvent', usage: step.usage };
  }
}

/** A `Usage` as a provider reports it, with the cache counters only when named. */
function usage(
  inputTokens: number,
  outputTokens: number,
  cache?: { read?: number; write?: number },
): Usage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cache?.read === undefined ? {} : { cacheReadInputTokens: cache.read }),
    ...(cache?.write === undefined ? {} : { cacheWriteInputTokens: cache.write }),
  };
}

/** The config the spend projection is computed against; only provider/API matter to it. */
function spendConfig(provider: 'bedrock' | 'openai', openaiApi?: 'chat' | 'responses'): AppConfig {
  return withSoleChoice({
    provider,
    model: provider === 'openai' ? 'openai.gpt-5.6-sol' : 'global.anthropic.claude-opus-5',
    region: 'us-east-1',
    maxTokens: 1000,
    permissionMode: 'default',
    promptCache: false,
    promptCacheTtl: '5m',
    thinkingEffort: 'high',
    summaryRatio: 0.8,
    contextWarnRatio: 0.8,
    contextOffload: true,
    preserveRecentMessages: 4,
    ...(openaiApi === undefined ? {} : { openaiApi }),
  });
}

/**
 * The production meter over a real agent's meter: exactly what `AgentRuntime.send`
 * builds, so what is asserted below is the shipped projection and not a copy of it.
 */
function meterFor(agent: Agent, config: AppConfig = spendConfig('bedrock')): TurnSpendMeter {
  const read = (): UsageTotals => {
    const totals = agent.metrics.accumulatedUsage;
    return {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      ...(totals.cacheReadInputTokens !== undefined && {
        cacheReadInputTokens: totals.cacheReadInputTokens,
      }),
      ...(totals.cacheWriteInputTokens !== undefined && {
        cacheWriteInputTokens: totals.cacheWriteInputTokens,
      }),
    };
  };
  return startTurnSpend(read(), read, config);
}

function recorder(
  file: string,
  overrides: { openFile?: never; maxBytes?: number; openFileImpl?: unknown } = {},
): TrajectoryRecorder {
  return new TrajectoryRecorder({
    file,
    run: {
      session: 'session-test',
      agentId: AGENT_ID,
      darwinVersion: 'test',
      provider: 'bedrock',
      model: 'fake.trajectory',
      permissionMode: 'default',
      thinkingEffort: 'high',
      resumed: false,
      restoredMessages: 0,
    },
    ...(overrides.maxBytes === undefined ? {} : { maxBytes: overrides.maxBytes }),
    ...(overrides.openFileImpl === undefined
      ? {}
      : { openFile: overrides.openFileImpl as Parameters<typeof Object>[0] as never }),
  });
}

/** One recorded turn against a real Agent, returning the events the caller saw. */
async function recordedTurn(
  agent: Agent,
  rec: TrajectoryRecorder | undefined,
  input: string,
  options: { stopAfter?: number; spend?: TurnSpendMeter; callSpend?: CallSpendProjector } = {},
): Promise<AgentStreamEvent[]> {
  const seen: AgentStreamEvent[] = [];
  for await (const event of recordStream(
    agent.stream(input),
    rec?.beginTurn(input, options.spend, options.callSpend),
  )) {
    seen.push(event);
    if (options.stopAfter !== undefined && seen.length >= options.stopAfter) break;
  }
  return seen;
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** One `darwin trajectory <verb>` run against this suite's project, exit code included. */
async function runTrajectory(
  command: Parameters<typeof runTrajectoryCommand>[0],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTrajectoryCommand(command, {
    projectRoot: ROOT,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join('') };
}

function newAgent(model: Model, tools: unknown[] = [echo]): Agent {
  return new Agent({
    id: AGENT_ID,
    model,
    systemPrompt: 'trajectory test',
    tools: tools as never,
    printer: false,
  });
}

// ---------------------------------------------------------------------------

async function appendOnly(): Promise<void> {
  header('trajectory — two turns append, and the first turn stays byte-identical');

  const dir = path.join(ROOT, 'append');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');

  const agent = newAgent(new ScriptedModel('first answer'));
  await agent.initialize();
  const rec = recorder(file);

  await recordedTurn(agent, rec, 'turn one');
  await rec.close();
  const afterFirst = await readFile(file);
  const firstDigest = sha256(afterFirst);

  const agent2 = newAgent(new ScriptedModel('second answer'));
  await agent2.initialize();
  await recordedTurn(agent2, rec, 'turn two');
  await rec.close();
  const afterSecond = await readFile(file);

  assert(
    'the first turn\u2019s bytes are byte-identical after the second turn appends',
    sha256(afterSecond.subarray(0, afterFirst.byteLength)) === firstDigest,
  );
  assert('the file only grew', afterSecond.byteLength > afterFirst.byteLength);

  const read = await readTrajectory(file);
  const seqs = read.records.map((record) => record.seq);
  assert(
    'sequence numbers are contiguous from zero',
    seqs.every((seq, index) => seq === index),
  );
  assert('the run header is written exactly once per process', count(read.records, 'runStarted') === 1);
  assert('both turns are recorded', count(read.records, 'userInput') === 2);
  // A turn is appended in one write, so identical timestamps across a turn would mean
  // the record only *looks* like it carries timing. Stamped when observed instead.
  const stamps = read.records.map((record) => record.t);
  assert(
    'timestamps are observation times, not one shared flush time',
    new Set(stamps).size > 1 && stamps.every((value) => !Number.isNaN(Date.parse(value))),
  );
  assert(
    'timestamps never go backwards',
    stamps.every((value, index) => index === 0 || Date.parse(value) >= Date.parse(stamps[index - 1] as string)),
  );
  assert(
    'turn ordinals are 1-based and increase',
    read.records.filter((r) => r.type === 'userInput').map((r) => r.turn).join(',') === '1,2',
  );

  // A second *process* on the same file: numbering has to continue, not restart,
  // because a restart would make a real gap indistinguishable from a new run. The
  // same holds for turn ordinals since SRF-031 (`open()` is the seam the runtime awaits).
  const second = recorder(file);
  await second.open();
  const agent3 = newAgent(new ScriptedModel('third answer'));
  await agent3.initialize();
  await recordedTurn(agent3, second, 'turn three');
  await second.close();

  const reread = await readTrajectory(file);
  assert(
    'a later process continues the sequence instead of restarting it',
    reread.records.map((r) => r.seq).every((seq, index) => seq === index),
  );
  assert(
    'a later process continues the turn ordinals instead of restarting them',
    reread.records.filter((r) => r.type === 'userInput').map((r) => r.turn).join(',') === '1,2,3',
  );
  assert('the later process wrote its own run header', count(reread.records, 'runStarted') === 2);
  assert('the earlier prefix is still byte-identical', sha256((await readFile(file)).subarray(0, afterSecond.byteLength)) === sha256(afterSecond));
}

/**
 * A two-turn fresh file as the pre-SRF-031 writer produced it, with the fields that
 * cannot be stable across runs (`t`, `pid`, `ms`, the SDK's random `trackingId`)
 * replaced by fixed tokens. Captured from that writer, so a fresh session's records
 * are provably byte-identical (stamps aside) after turn numbers started being seeded
 * from the tail.
 */
const FRESH_TWO_TURN_GOLDEN = [
  '{"v":1,"seq":0,"t":"T","turn":0,"type":"runStarted","session":"session-test","agentId":"darwin","darwinVersion":"test","provider":"bedrock","model":"fake.trajectory","permissionMode":"default","thinkingEffort":"high","resumed":false,"restoredMessages":0,"pid":0}',
  '{"v":1,"seq":1,"t":"T","turn":1,"type":"userInput","text":"turn one"}',
  '{"v":1,"seq":2,"t":"T","turn":1,"type":"contentBlockEvent","data":{"type":"contentBlockEvent","contentBlock":{"text":"first answer"}}}',
  '{"v":1,"seq":3,"t":"T","turn":1,"type":"modelCall","attempt":1,"ms":0,"stopReason":"endTurn","contextTokens":104}',
  '{"v":1,"seq":4,"t":"T","turn":1,"type":"agentResultEvent","data":{"type":"agentResultEvent","result":{"type":"agentResult","stopReason":"endTurn","lastMessage":{"role":"assistant","content":[{"text":"first answer"}],"trackingId":"·"}}}}',
  '{"v":1,"seq":5,"t":"T","turn":1,"type":"turnEnded","stopReason":"endTurn","ms":0,"recorded":{"contentBlockEvent":1,"agentResultEvent":1},"dropped":{"beforeInvocationEvent":1,"messageAddedEvent":2,"beforeModelCallEvent":1,"modelStreamUpdateEvent":6,"modelMessageEvent":1,"afterModelCallEvent":1,"afterInvocationEvent":1}}',
  '{"v":1,"seq":6,"t":"T","turn":2,"type":"userInput","text":"turn two"}',
  '{"v":1,"seq":7,"t":"T","turn":2,"type":"contentBlockEvent","data":{"type":"contentBlockEvent","contentBlock":{"text":"second answer"}}}',
  '{"v":1,"seq":8,"t":"T","turn":2,"type":"modelCall","attempt":1,"ms":0,"stopReason":"endTurn","contextTokens":104}',
  '{"v":1,"seq":9,"t":"T","turn":2,"type":"agentResultEvent","data":{"type":"agentResultEvent","result":{"type":"agentResult","stopReason":"endTurn","lastMessage":{"role":"assistant","content":[{"text":"second answer"}],"trackingId":"·"}}}}',
  '{"v":1,"seq":10,"t":"T","turn":2,"type":"turnEnded","stopReason":"endTurn","ms":0,"recorded":{"contentBlockEvent":1,"agentResultEvent":1},"dropped":{"beforeInvocationEvent":1,"messageAddedEvent":2,"beforeModelCallEvent":1,"modelStreamUpdateEvent":6,"modelMessageEvent":1,"afterModelCallEvent":1,"afterInvocationEvent":1}}',
].map((line) => `${line}\n`).join('');

function normalizeStamps(text: string): string {
  return text
    .replace(/"t":"[^"]*"/g, '"t":"T"')
    .replace(/"pid":\d+/g, '"pid":0')
    .replace(/"ms":\d+/g, '"ms":0')
    .replace(/"trackingId":"[^"]*"/g, '"trackingId":"·"');
}

async function resumedTurnNumbers(): Promise<void> {
  header('trajectory — turn numbers are unique within one file: a resumed run continues them (SRF-031)');

  // A real session path, so the CLI readers can be pointed at the file below.
  const sessionId = 'session-20260908-095403918';
  const file = trajectoryPath(ROOT, sessionId);
  await rm(path.dirname(file), { recursive: true, force: true });

  const rec = recorder(file);
  await rec.open();
  assert('a fresh file seeds nothing: the first turn is still turn 1', rec.nextTurn === 1);
  const first = newAgent(new ScriptedModel('first answer'));
  await first.initialize();
  await recordedTurn(first, rec, 'turn one');
  await rec.close();
  const second = newAgent(new ScriptedModel('second answer'));
  await second.initialize();
  await recordedTurn(second, rec, 'turn two');
  await rec.close();
  const twoTurns = await readFile(file, 'utf8');
  assert(
    'a fresh file is byte-identical to the pre-seeding writer\u2019s two-turn output (stamps aside)',
    normalizeStamps(twoTurns) === FRESH_TWO_TURN_GOLDEN,
  );
  assert('the fresh two-turn file has no turn 0 record but the run header', (await readTrajectory(file)).records.every((r) => (r.turn === 0) === (r.type === 'runStarted')));

  // The resumed process: the seam is `open()` awaited before the first turn. The
  // ordinal is then assigned synchronously by `beginTurn`, *before* any append has
  // flushed — the timing the Host flagged — and it is already `max + 1`.
  const resumed = recorder(file);
  assert('before open, the recorder cannot know the file and would number from 1', resumed.nextTurn === 1);
  await resumed.open();
  assert('after open, nextTurn reports the continuation', resumed.nextTurn === 3);
  const recording = resumed.beginTurn('turn three');
  assert(
    'the first resumed turn is numbered max + 1 at beginTurn time, with nothing flushed yet',
    recording?.turn === 3 && (await readFile(file, 'utf8')) === twoTurns,
  );
  assert('nextTurn moved with the counter the record carries', resumed.nextTurn === 4);
  const third = newAgent(new ScriptedModel('third answer'));
  await third.initialize();
  for await (const _event of recordStream(third.stream('turn three'), recording)) {
    // Drain the real agent turn through the pass-through observer.
  }
  await resumed.close();

  const read = await readTrajectory(file);
  assert('the earlier prefix is byte-identical', (await readFile(file, 'utf8')).startsWith(twoTurns));
  assert('seq continues from the previous file end as before', read.records.every((r, index) => r.seq === index));
  const headers = read.records.filter((r) => r.type === 'runStarted');
  assert('the resumed run\u2019s header still carries turn 0', headers.length === 2 && headers.every((r) => r.turn === 0));
  const thirdRun = read.records.slice(read.records.findIndex((r) => r.type === 'runStarted' && r.seq > 0) + 1);
  assert(
    'every record of the resumed turn carries turn 3',
    thirdRun.length >= 3 && thirdRun.every((r) => r.turn === 3) && thirdRun.some((r) => r.type === 'userInput') && thirdRun.some((r) => r.type === 'turnEnded'),
  );
  const replayed = replayRecords(read.records);
  assert('replay lists turns 1..3 with no duplicate', replayed.turns.join(',') === '1,2,3');
  assert('replay prints one spend line per turn, not two for a turn number', replayed.turnSpend.map((entry) => entry.turn).join(',') === '1,2,3');
  const only = replayRecords(read.records, { turn: 3 });
  assert(
    'replaying turn 3 selects exactly the resumed turn',
    only.history.filter((item) => item.kind === 'user').length === 1 && only.history.some((item) => item.kind === 'user' && item.text === 'turn three'),
  );
  const cli = await runTrajectory({ verb: 'replay', sessionId, turn: 3, json: false });
  assert(
    '`trajectory replay --turn 3` selects exactly one turn on a two-run file',
    cli.code === 0 && cli.out.includes('turn three') && !cli.out.includes('turn one') && !cli.out.includes('turn two'),
  );
  const listed = await runTrajectory({ verb: 'list' });
  assert('`trajectory list` counts three distinct turns', (listed.out.split('\n').find((line) => line.startsWith(sessionId)) ?? '').includes('3 turn(s)'));

  // A resumed recorder's `!` command between turns names the last closed turn of the
  // file, not 0 — the ordinal the record type documents.
  const between = recorder(file);
  await between.open();
  between.recordShellCommand({ command: 'echo between', exitCode: 0, signal: null, timedOut: false, durationMs: 1, output: 'between' });
  await between.close();
  assert(
    'a between-turns record on a resumed recorder carries the last closed turn',
    (await readTrajectory(file)).records.findLast((r) => r.type === 'shellCommand')?.turn === 3,
  );

  // Degradation: a tail with no parseable record (garbage only) seeds nothing, so the
  // run starts at turn 1 and seq restarts at 0 exactly as it does today; the garbage
  // is preserved (never rewritten) and only the newline guard separates the runs.
  const garbageFile = path.join(ROOT, 'garbage-tail', 'trajectory.jsonl');
  await mkdir(path.dirname(garbageFile), { recursive: true });
  const garbage = '{"v":1,"seq":\nnot json at all\n{"turn":7}\n\u0000\u0001binary';
  await writeFile(garbageFile, garbage, 'utf8');
  const degraded = recorder(garbageFile);
  await degraded.open();
  assert('a garbage tail seeds nothing: the run starts at turn 1', degraded.nextTurn === 1);
  const after = newAgent(new ScriptedModel('answer after garbage'));
  await after.initialize();
  await recordedTurn(after, degraded, 'turn after garbage');
  await degraded.close();
  const damaged = await readTrajectory(garbageFile);
  assert('the garbage bytes are untouched', (await readFile(garbageFile, 'utf8')).startsWith(`${garbage}\n`));
  assert('seq restarts at 0 as today', damaged.records.map((r) => r.seq).join(',') === '0,1,2,3,4,5');
  assert('the run header carries turn 0 and the turn carries 1', damaged.records[0]?.turn === 0 && damaged.records.slice(1).every((r) => r.turn === 1));
  assert('the degradation costs no recording: the recorder has no problem', degraded.status.problem === undefined && degraded.status.active);
  assert('the unreadable lines are counted by the reader, never repaired', damaged.unreadableLines === 4);

  // A tail whose only well-formed record carries no numeric `turn` seeds nothing either.
  const noTurnFile = path.join(ROOT, 'no-turn-tail', 'trajectory.jsonl');
  await mkdir(path.dirname(noTurnFile), { recursive: true });
  await writeFile(noTurnFile, '{"v":1,"seq":41,"t":"x","turn":"nine","type":"userInput","text":"legacy"}\n', 'utf8');
  const noTurn = recorder(noTurnFile);
  await noTurn.open();
  assert('a non-numeric turn is ignored: turns start at 1, seq still continues', noTurn.nextTurn === 1);
  const afterNoTurn = newAgent(new ScriptedModel('answer'));
  await afterNoTurn.initialize();
  await recordedTurn(afterNoTurn, noTurn, 'after a turn-less tail');
  await noTurn.close();
  assert('seq continued from the well-formed record\u2019s seq', (await readTrajectory(noTurnFile)).records.at(-1)?.seq === 47);

  // A recorder that never opened (every pre-SRF-031 caller) behaves as today.
  const unopened = recorder(file);
  const fourth = unopened.beginTurn('turn opened before the tail is known');
  assert('an unopened recorder numbers from 1 like today — never a jump mid-flight', fourth?.turn === 1);
  const fourthAgent = newAgent(new ScriptedModel('fourth answer'));
  await fourthAgent.initialize();
  for await (const _event of recordStream(fourthAgent.stream('x'), fourth)) {
    // Drain.
  }
  await unopened.close();
  assert('and its next turn follows its own counter, as nextTurn said', unopened.nextTurn === 2);

  await rm(path.dirname(file), { recursive: true, force: true });
}

async function damageTolerance(): Promise<void> {
  header('trajectory — a partial trailing line is tolerated, and never glued to');

  const dir = path.join(ROOT, 'damage');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');

  const agent = newAgent(new ScriptedModel('answer alpha'));
  await agent.initialize();
  const rec = recorder(file);
  await recordedTurn(agent, rec, 'find marker-alpha');
  await rec.close();

  const whole = await readFile(file, 'utf8');
  const recordsBefore = (await readTrajectory(file)).records.length;
  // Simulate a write interrupted mid-line: keep every complete line plus half of one.
  const cut = whole.length - Math.floor(whole.split('\n').at(-2)?.length ?? 20 / 2);
  await truncate(file, Buffer.byteLength(whole.slice(0, cut), 'utf8'));

  const damaged = await readTrajectory(file);
  assert('a partial trailing line is reported', damaged.partialTrailingLine);
  assert(
    'every complete record before the damage is still readable',
    damaged.records.length === recordsBefore - 1 && damaged.unreadableLines === 0,
  );
  assert('the damage is describable in one line', (describeDamage(damaged) ?? '').includes('partial trailing line'));

  // Appending after the damage must not merge with the broken line.
  const agent2 = newAgent(new ScriptedModel('answer beta'));
  await agent2.initialize();
  const rec2 = recorder(file);
  await rec2.open();
  await recordedTurn(agent2, rec2, 'second run after damage');
  await rec2.close();

  const repaired = await readTrajectory(file);
  assert('the newline guard leaves exactly one unreadable line', repaired.unreadableLines === 1);
  assert('the new run\u2019s records parse', count(repaired.records, 'runStarted') === 2);
  assert('nothing is a partial line any more', !repaired.partialTrailingLine);
  assert(
    'the record after the damage carries a usable sequence number',
    (repaired.records.at(-1)?.seq ?? -1) > (repaired.records[0]?.seq ?? 0),
  );
  // The complete records before the cut still name turn 1, so the run after the
  // damage continues at turn 2 (SRF-031) — damage costs the partial line, not the seed.
  assert(
    'the run after a partial-line cut continues the turn numbering',
    repaired.records.find((r) => r.type === 'userInput' && r.text === 'second run after damage')?.turn === 2,
  );

  // An entirely missing file is a distinct, named condition — not an empty record.
  let missing = false;
  try {
    await readTrajectory(path.join(dir, 'absent.jsonl'));
  } catch (error) {
    missing = error instanceof TrajectoryMissingError;
  }
  assert('a missing file raises a named error rather than reading as empty', missing);
}

async function caps(): Promise<void> {
  header('trajectory — caps are enforced and every truncation is recorded');

  const dir = path.join(ROOT, 'caps');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');

  const huge = 'x'.repeat(MAX_FIELD_CHARS * 3);
  const agent = newAgent(new ScriptedModel('short answer', { name: 'echoTool', input: { note: huge } }));
  await agent.initialize();
  const rec = recorder(file);
  await recordedTurn(agent, rec, `prompt ${'p'.repeat(MAX_FIELD_CHARS * 2)}`);
  await rec.close();

  const read = await readTrajectory(file);
  const userInput = read.records.find((r) => r.type === 'userInput') as
    | (TrajectoryRecord & { text: string })
    | undefined;
  assert(
    'an oversized user input is capped to the field limit',
    [...(userInput?.text ?? '')].length === MAX_FIELD_CHARS,
  );
  assert(
    'the truncation is recorded with path, original and kept size',
    userInput?.trunc?.[0]?.path === 'text' &&
      userInput.trunc[0].kept === MAX_FIELD_CHARS &&
      userInput.trunc[0].chars > MAX_FIELD_CHARS,
  );

  const before = read.records.find((r) => r.type === 'beforeToolCallEvent');
  assert('an oversized tool input is capped', (before?.trunc?.length ?? 0) > 0);
  assert(
    'the truncation names the field inside the payload',
    (before?.trunc ?? []).some((entry) => entry.path.includes('input')),
  );
  const after = read.records.find((r) => r.type === 'afterToolCallEvent');
  assert('an oversized tool result is capped too', (after?.trunc?.length ?? 0) > 0);

  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '');
  assert(
    'no line exceeds the per-record byte cap',
    lines.every((line) => Buffer.byteLength(`${line}\n`, 'utf8') <= MAX_RECORD_BYTES),
  );

  // Reasoning: a real reasoning block, with real text and a signature, must leave
  // only its presence behind. Asserted against a turn that actually produced one —
  // checking a file with no reasoning in it would prove nothing.
  const reasoningFile = path.join(dir, 'reasoning.jsonl');
  const thinker = newAgent(new ScriptedModel('the public answer', undefined, 'PRIVATE-DELIBERATION-abc'));
  await thinker.initialize();
  const reasoningRec = recorder(reasoningFile);
  await recordedTurn(thinker, reasoningRec, 'think about it');
  await reasoningRec.close();

  const reasoningRaw = await readFile(reasoningFile, 'utf8');
  const reasoningRead = await readTrajectory(reasoningFile);
  assert(
    'the turn really produced a reasoning block',
    reasoningRead.records.some((r) => JSON.stringify(r).includes('"reasoning"')),
  );
  assert('reasoning text is never recorded', !reasoningRaw.includes('PRIVATE-DELIBERATION-abc'));
  assert('the reasoning signature is not recorded either', !reasoningRaw.includes('sig-abc'));
  assert('the public answer is still recorded', reasoningRaw.includes('the public answer'));
  assert(
    'a stripped reasoning block still replays',
    replayRecords(reasoningRead.records).history.some(
      (item) => item.kind === 'assistant' && item.text === 'the public answer',
    ),
  );

  // The budget: injected small so the latch is reachable without 64 MiB of writes.
  const budgetFile = path.join(dir, 'budget.jsonl');
  const small = recorder(budgetFile, { maxBytes: 512 });
  const agent2 = newAgent(new ScriptedModel('a'.repeat(600)));
  await agent2.initialize();
  await recordedTurn(agent2, small, 'fill the budget');
  await small.close();
  await recordedTurn(agent2, small, 'this turn is past the budget');
  await small.close();

  const budgetRead = await readTrajectory(budgetFile);
  assert(
    'reaching the byte budget appends a recordingStopped record',
    count(budgetRead.records, 'recordingStopped') === 1,
  );
  assert('the budget latch stops later turns being recorded', count(budgetRead.records, 'userInput') === 1);
  assert('the budget is surfaced as a problem', (small.status.problem ?? '').includes('budget'));
  assert('the record is still fully readable after the budget stop', budgetRead.unreadableLines === 0);
}

async function degradation(): Promise<void> {
  header('trajectory — a write failure degrades instead of throwing');

  const dir = path.join(ROOT, 'degrade');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');

  const failing = () => Promise.reject(new Error('EACCES: simulated read-only filesystem'));
  const rec = recorder(file, { openFileImpl: failing });

  const agent = newAgent(new ScriptedModel('answer despite the failure'));
  await agent.initialize();

  let threw: unknown;
  let seen: AgentStreamEvent[] = [];
  try {
    seen = await recordedTurn(agent, rec, 'a turn whose record cannot be written');
    await rec.close();
  } catch (error) {
    threw = error;
  }

  assert('the turn does not throw', threw === undefined);
  assert('the caller still saw a complete turn', seen.some((event) => event.type === 'agentResultEvent'));
  assert('the failure is latched as a problem', rec.status.problem?.includes('EACCES') === true);
  assert('recording is switched off after the failure', !rec.status.active);
  assert('the reported file path is the one that failed', rec.status.file === file);

  // A second turn must not retry per event or throw either.
  const seenAgain = await recordedTurn(agent, rec, 'a second turn after the failure');
  await rec.close();
  assert('later turns keep working', seenAgain.some((event) => event.type === 'agentResultEvent'));
  assert('the problem is not overwritten by later failures', rec.status.problem?.includes('EACCES') === true);

  const report_ = formatTrajectoryReport(rec.status, 'session-degraded');
  assert('the TUI report names the problem', report_.includes('problem') && report_.includes('EACCES'));
  assert(
    'the disabled case is reported as not recording',
    formatTrajectoryReport(undefined, 'session-x').includes('not recording'),
  );
}

async function passThrough(): Promise<void> {
  header('trajectory — recording does not alter the observed event stream');

  const dir = path.join(ROOT, 'passthrough');
  await rm(dir, { recursive: true, force: true });

  // A tee at the source: `emitted` is what the SDK produced, `seen` is what the
  // consumer got out of the observer. Identity comparison, not a re-run comparison —
  // two runs of an Agent legitimately differ (tracking ids, timings), so equality
  // between them would be the wrong claim and a flaky test.
  const emitted: AgentStreamEvent[] = [];
  async function* tee(source: AsyncIterable<AgentStreamEvent>): AsyncIterable<AgentStreamEvent> {
    for await (const event of source) {
      emitted.push(event);
      yield event;
    }
  }

  const agent = newAgent(new ScriptedModel('same answer', { name: 'echoTool', input: { note: 'hi' } }));
  await agent.initialize();
  const rec = recorder(path.join(dir, 'trajectory.jsonl'));

  const seen: AgentStreamEvent[] = [];
  for await (const event of recordStream(tee(agent.stream('do the thing')), rec.beginTurn('do the thing'))) {
    seen.push(event);
  }
  await rec.close();

  assert('no event is added or swallowed', seen.length === emitted.length && seen.length > 0);
  assert(
    'every event is the identical object the SDK emitted, in the same order',
    seen.every((event, index) => event === emitted[index]),
  );
  assert('a full turn still completes', seen.some((event) => event.type === 'agentResultEvent'));

  // And the same stream with no recorder at all yields the same event *types* in the
  // same order, so the observer is not shaping the loop through a side effect.
  const bare = newAgent(new ScriptedModel('same answer', { name: 'echoTool', input: { note: 'hi' } }));
  await bare.initialize();
  const withoutRecording = await recordedTurn(bare, undefined, 'do the thing');
  assert(
    'the event sequence is the same with recording off',
    withoutRecording.map((e) => e.type).join(',') === seen.map((e) => e.type).join(','),
  );

  // Stopping early (a cancelled turn, or a consumer that breaks) must still close
  // the turn and leave a valid record — and must not hang.
  const stopped = newAgent(new ScriptedModel('a much longer answer that will be cut off midway'));
  await stopped.initialize();
  const partialRec = recorder(path.join(dir, 'partial.jsonl'));
  const partial = await recordedTurn(stopped, partialRec, 'stop me early', { stopAfter: 3 });
  await partialRec.close();

  assert('an early break returns only what was consumed', partial.length === 3);
  const partialRead = await readTrajectory(path.join(dir, 'partial.jsonl'));
  assert(
    'the interrupted turn is still closed off in the record',
    count(partialRead.records, 'turnEnded') === 1,
  );
  assert('the interrupted record is valid, not truncated', !partialRead.partialTrailingLine);

  // Unrecorded event types are counted, so the record admits its own lossiness.
  const read = await readTrajectory(path.join(dir, 'trajectory.jsonl'));
  const ended = read.records.find((r) => r.type === 'turnEnded') as
    | (TrajectoryRecord & { dropped: Record<string, number>; recorded: Record<string, number> })
    | undefined;
  assert(
    'dropped event types are counted by type',
    (ended?.dropped['modelStreamUpdateEvent'] ?? 0) > 0 && (ended?.dropped['messageAddedEvent'] ?? 0) > 0,
  );
  assert(
    'recorded event types are counted too',
    (ended?.recorded['beforeToolCallEvent'] ?? 0) === 1 && (ended?.recorded['afterToolCallEvent'] ?? 0) === 1,
  );
}

async function failedTurn(): Promise<void> {
  header('trajectory — a turn whose stream throws says so, and still throws');

  const dir = path.join(ROOT, 'failed');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');
  const rec = recorder(file);

  // One file, three turns, one per outcome — because the claim is that a reader can
  // tell them apart from the file alone, which is only testable side by side.
  const clean = newAgent(new ScriptedModel('a clean answer'));
  await clean.initialize();
  await recordedTurn(clean, rec, 'turn one is clean');
  await rec.close();
  const afterClean = await readFile(file);

  // A real cancel, not a synthesised record: `agent.cancel()` while deltas are still
  // arriving, then the loop keeps consuming, which is what the TUI does on Ctrl+C.
  const cancelling = newAgent(new ScriptedModel('an answer long enough to be interrupted midway'));
  await cancelling.initialize();
  const cancelSeen: AgentStreamEvent[] = [];
  for await (const event of recordStream(
    cancelling.stream('turn two gets cancelled'),
    rec.beginTurn('turn two gets cancelled'),
  )) {
    cancelSeen.push(event);
    if (event.type === 'modelStreamUpdateEvent') cancelling.cancel();
  }
  await rec.close();
  assert(
    'the cancelled turn really ended as cancelled, without throwing',
    cancelSeen.some((event) => event.type === 'agentResultEvent' && event.result.stopReason === 'cancelled'),
  );

  // The failing turn. `ProviderExplosion extends ModelError`, so the SDK rethrows it
  // untouched and the identity claim is about darwin's seam, not about SDK wrapping.
  const thrown = new ProviderExplosion('the provider refused the request: simulated 400');
  const exploding = newAgent(new ThrowingModel(thrown));
  await exploding.initialize();
  const seen: AgentStreamEvent[] = [];
  let caught: unknown;
  try {
    for await (const event of recordStream(
      exploding.stream('turn three fails'),
      rec.beginTurn('turn three fails'),
    )) {
      seen.push(event);
    }
  } catch (error) {
    caught = error;
  }
  await rec.close();

  assert('the thrown error reaches the caller as the identical object', caught === thrown);
  assert(
    'with its class and message unchanged',
    caught instanceof ProviderExplosion &&
      caught.name === 'ProviderExplosion' &&
      caught.message === 'the provider refused the request: simulated 400',
  );
  assert('the events before the throw were still delivered', seen.length > 0);

  const read = await readTrajectory(file);
  const ends = read.records.filter((r): r is TurnEndedRecord => r.type === 'turnEnded');
  assert('all three turns are closed off in the record', ends.length === 3);
  assert(
    'the three outcomes are distinguishable from the file alone',
    ends.map((record) => turnOutcome(record)).join(',') === 'clean,cancelled,failed',
  );
  assert('the clean turn carries the SDK stop reason and no failure', ends[0]?.stopReason === 'endTurn' && turnFailureOf(ends[0] as TurnEndedRecord) === undefined);
  assert(
    'the cancelled turn is cancelled, not failed',
    ends[1]?.stopReason === 'cancelled' && turnFailureOf(ends[1] as TurnEndedRecord) === undefined,
  );
  const failure = turnFailureOf(ends[2] as TurnEndedRecord);
  assert('the failed turn names the error class', failure?.name === 'ProviderExplosion');
  assert(
    'the failed turn records the message',
    failure?.message === 'the provider refused the request: simulated 400',
  );
  // No invented stop reason: `'failed'` is not a value any provider produced, and the
  // field's contract is the SDK's own stop reason.
  assert('the failed turn invents no stop reason', ends[2]?.stopReason === undefined);
  assert(
    'the failing turn is still counted like any other',
    (ends[2]?.dropped['modelStreamUpdateEvent'] ?? 0) > 0 && typeof ends[2]?.ms === 'number',
  );
  assert(
    'the earlier turns\u2019 bytes are byte-identical after the failure is appended',
    sha256((await readFile(file)).subarray(0, afterClean.byteLength)) === sha256(afterClean),
  );

  // The wrapping path, which is the one a real provider takes: measured on
  // @strands-agents/sdk@1.12.0, `Model.streamAggregated` rethrows a ModelError as-is
  // but wraps anything else in `new ModelError(message, { cause })`. Without recording
  // the cause's class, every real provider failure would read as plain `ModelError`.
  class UnrecognizedClientException extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'UnrecognizedClientException';
    }
  }
  const wrappedFile = path.join(dir, 'wrapped.jsonl');
  const wrappedRec = recorder(wrappedFile);
  const provider = new UnrecognizedClientException('The security token included in the request is invalid');
  const wrapping = newAgent(new ThrowingModel(provider));
  await wrapping.initialize();
  let wrappedCaught: unknown;
  try {
    await recordedTurn(wrapping, wrappedRec, 'a turn the provider rejects');
  } catch (error) {
    wrappedCaught = error;
  }
  await wrappedRec.close();

  assert(
    'the SDK wraps a non-ModelError throw, and the caller sees that wrapper',
    wrappedCaught instanceof ModelError && (wrappedCaught as Error).cause === provider,
  );
  const wrappedEnd = (await readTrajectory(wrappedFile)).records.find(
    (r): r is TurnEndedRecord => r.type === 'turnEnded',
  );
  const wrappedFailure = turnFailureOf(wrappedEnd as TurnEndedRecord);
  assert('the record names the class the caller actually received', wrappedFailure?.name === 'ModelError');
  assert(
    'and keeps the wrapped provider class, which is the fact wrapping loses',
    wrappedFailure?.cause === 'UnrecognizedClientException',
  );
  assert(
    'the provider message survives wrapping',
    (wrappedFailure?.message ?? '').includes('security token'),
  );
  assert(
    'the rendered summary shows both classes',
    formatTurnFailure(wrappedFailure as never).startsWith('ModelError (cause UnrecognizedClientException): '),
  );

  // A recorder that fails *while* recording a failure still cannot fail the turn: the
  // caller gets the provider error, not the recorder's.
  const brokenRec = recorder(path.join(dir, 'unwritable.jsonl'), {
    openFileImpl: () => Promise.reject(new Error('EACCES: simulated read-only filesystem')),
  });
  const secondThrow = new ProviderExplosion('the provider failed while the recorder was broken');
  const doublyDoomed = newAgent(new ThrowingModel(secondThrow));
  await doublyDoomed.initialize();
  let doubleCaught: unknown;
  try {
    await recordedTurn(doublyDoomed, brokenRec, 'a failing turn with a broken recorder');
  } catch (error) {
    doubleCaught = error;
  }
  await brokenRec.close();
  assert('the caller still receives the provider error, not the recorder\u2019s', doubleCaught === secondThrow);
  assert('the recorder latched its own problem instead', brokenRec.status.problem?.includes('EACCES') === true);
  assert('and switched itself off', !brokenRec.status.active);

  // The caps apply to the failure like any other field, and the truncation is written
  // down on the same record.
  const cappedFile = path.join(dir, 'capped.jsonl');
  const cappedRec = recorder(cappedFile);
  const hugeMessage = 'e'.repeat(MAX_FIELD_CHARS * 3);
  const shouty = newAgent(new ThrowingModel(new ProviderExplosion(hugeMessage)));
  await shouty.initialize();
  try {
    await recordedTurn(shouty, cappedRec, 'a turn that fails very verbosely');
  } catch {
    // The propagation claim is asserted above; here only the record matters.
  }
  await cappedRec.close();
  const cappedEnd = (await readTrajectory(cappedFile)).records.find(
    (r): r is TurnEndedRecord => r.type === 'turnEnded',
  );
  assert(
    'an oversized failure message is capped to the field limit',
    [...(turnFailureOf(cappedEnd as TurnEndedRecord)?.message ?? '')].length === MAX_FIELD_CHARS,
  );
  assert(
    'the truncation is recorded, naming the field inside the failure',
    (cappedEnd?.trunc ?? []).some(
      (entry) => entry.path === 'failure.message' && entry.kept === MAX_FIELD_CHARS && entry.chars > MAX_FIELD_CHARS,
    ),
  );

  // Replay of a failed turn must equal the live history the TUI produced, which is why
  // the reconstructed notice repeats `runTurn`'s text and severity exactly rather than
  // inventing a replay-only line.
  const liveFile = path.join(dir, 'live.jsonl');
  const liveRec = recorder(liveFile);
  const liveInput = 'compare live and replay for a failed turn';
  const liveThrow = new ProviderExplosion('the provider hung up mid-answer');
  const liveAgent = newAgent(new ThrowingModel(liveThrow));
  await liveAgent.initialize();
  let live = turnReducer(initialTurnState, { type: 'userInput', text: liveInput });
  try {
    for await (const event of recordStream(liveAgent.stream(liveInput), liveRec.beginTurn(liveInput))) {
      live = turnReducer(live, { type: 'streamEvent', event });
    }
  } catch (error) {
    // Exactly what `runTurn` in src/tui/App.tsx does with a failed turn.
    live = turnReducer(live, {
      type: 'notice',
      text: `turn failed: ${error instanceof Error ? error.message : String(error)}`,
      severity: 'error',
    });
  } finally {
    live = turnReducer(live, { type: 'turnEnded' });
  }
  await liveRec.close();

  const liveRead = await readTrajectory(liveFile);
  const replayed = replayRecords(liveRead.records);
  assert(
    'a failed turn replays as the live history it produced, item for item',
    JSON.stringify(historyWithoutIds(replayed.history)) === JSON.stringify(historyWithoutIds(live.history)),
  );
  assert(
    'the reconstructed notice is the failure, as an error notice',
    replayed.history.some(
      (item) => item.kind === 'notice' && item.severity === 'error' && item.text === 'turn failed: the provider hung up mid-answer',
    ),
  );
  assert(
    'replay reports the failure separately, with the class the notice cannot carry',
    replayed.failures.length === 1 &&
      replayed.failures[0]?.turn === 1 &&
      replayed.failures[0]?.name === 'ProviderExplosion',
  );
  const transcript = formatReplay({ ...replayed, damage: undefined });
  assert('the transcript shows the failure notice', transcript.includes('note turn failed: the provider hung up mid-answer'));
  assert('and names the failed turn and its class', transcript.includes('turn 1 failed: ProviderExplosion:'));

  // Older records: a `v: 1` turnEnded written before this field existed must stay
  // readable, replay without a notice, and read as the clean turn it was.
  const legacyLine =
    '{"v":1,"seq":9,"t":"2026-08-16T00:00:00.000Z","turn":1,"type":"turnEnded",' +
    '"stopReason":"endTurn","ms":12,"recorded":{},"dropped":{}}';
  const legacy = parseRecordLine(legacyLine) as TurnEndedRecord | undefined;
  assert('a v:1 record without the field still parses', legacy?.type === 'turnEnded');
  const historicalGuardLine = legacyLine.replace(
    '"ms":12',
    '"completionGuardSuppressed":true,"ms":12',
  );
  const historicalGuard = parseRecordLine(historicalGuardLine) as TurnEndedRecord | undefined;
  assert('a historical v:1 completion-guard field is tolerated as unknown extra data',
    historicalGuard?.type === 'turnEnded' && turnOutcome(historicalGuard) === 'clean');
  assert('and reads as a clean turn', legacy !== undefined && turnOutcome(legacy) === 'clean');
  assert('with no failure to report', legacy !== undefined && turnFailureOf(legacy) === undefined);
  assert(
    'and replays with no failure notice',
    replayRecords([legacy as TrajectoryRecord]).failures.length === 0 &&
      !replayRecords([legacy as TrajectoryRecord]).history.some((item) => item.kind === 'notice'),
  );
  // Damaged or partial payloads: a failure with only a name is still a failure, and a
  // failure that is not an object at all is not silently treated as one.
  const halfLine = legacyLine.replace('"stopReason":"endTurn"', '"stopReason":null,"failure":{"name":"Boom"}');
  const half = parseRecordLine(halfLine) as TurnEndedRecord;
  assert('a half-present failure still reads as a failure', turnOutcome(half) === 'failed');
  const bogusLine = legacyLine.replace('"ms":12', '"failure":5,"ms":12');
  assert('a failure field that is not an object is not read as one', turnOutcome(parseRecordLine(bogusLine) as TurnEndedRecord) === 'clean');

  // The extraction rules, directly: the class wins over a declared name, a disagreement
  // is kept rather than resolved silently, and a non-Error throw is described honestly.
  class Renamed extends Error {}
  const renamed = new Renamed('a subclass that never set name');
  assert(
    'the class is preferred and a disagreeing name is kept',
    failureFromError(renamed).name === 'Renamed (name: Error)',
  );
  assert('a thrown string is described as one', failureFromError('bare string').name === 'non-error string');
  assert('a thrown string keeps its text', failureFromError('bare string').message === 'bare string');
  assert('a thrown null is described as null', failureFromError(null).name === 'non-error null');
  assert(
    'a value whose toString throws does not take the recorder with it',
    failureFromError({
      toString() {
        throw new Error('hostile');
      },
    }).message.includes('could not be converted'),
  );
}

async function failedTurnReadPaths(): Promise<void> {
  header('trajectory — list, replay and search report a failed turn');

  const paths = sessionPaths(ROOT);
  await rm(paths.sessionsDir, { recursive: true, force: true });

  const sessionId = 'session-20260816-300000';
  const rec = recorder(trajectoryPath(ROOT, sessionId));
  const clean = newAgent(new ScriptedModel('a clean answer first'));
  await clean.initialize();
  await recordedTurn(clean, rec, 'a clean turn');
  await rec.close();

  // Four failures, so the `+N more` bound is exercised, and two of them pathological:
  // a message at the field cap and a name at the field cap. A bound that only holds
  // for short messages is not a bound.
  const hostileName = new Error('a failure whose class name is pathological');
  Object.defineProperty(hostileName, 'name', { value: 'N'.repeat(MAX_FIELD_CHARS * 2) });
  const thrown: unknown[] = [
    new ProviderExplosion('ThrottlingException-lookalike: too many requests'),
    new ProviderExplosion(`a very long provider complaint: ${'m'.repeat(MAX_FIELD_CHARS * 2)}`),
    hostileName,
    new ProviderExplosion('the fourth failure, which the list only counts'),
  ];
  for (const [index, error] of thrown.entries()) {
    const agent = newAgent(new ThrowingModel(error));
    await agent.initialize();
    try {
      await recordedTurn(agent, rec, `failing turn ${index + 1}`);
    } catch {
      // The propagation claim is asserted in failedTurn(); this section is about reading.
    }
    await rec.close();
  }

  const listed = await runTrajectory({ verb: 'list' });
  const row = listed.out.split('\n').find((line) => line.startsWith(sessionId)) ?? '';
  assert('list exits 0 with a failed turn in the record', listed.code === 0 && row !== '');
  assert('list says how many turns failed', row.includes('4 failed turn(s)'));
  assert('list names a failed turn and its class', row.includes('turn 2 ProviderExplosion: ThrottlingException-lookalike'));
  assert('list counts the failures it did not name', row.includes('+1 more'));
  const clause = row.slice(row.indexOf('failed turn(s): ') + 'failed turn(s): '.length);
  const rendered = clause.split('; ');
  assert(
    'every named failure stays inside the summary bound, message or name however long',
    rendered.every((entry) => [...entry].length <= MAX_FAILURE_SUMMARY_CHARS + 'turn 99 '.length + ' +1 more'.length),
  );
  assert(
    'the row is one line and carries no unbounded payload',
    !row.includes('\n') && !row.includes('m'.repeat(200)) && !row.includes('N'.repeat(200)),
  );

  const replayed = await runTrajectory({ verb: 'replay', sessionId, json: false });
  assert('replay exits 0 over a record containing failures', replayed.code === 0);
  assert(
    'replay shows the failure as the notice the TUI showed',
    replayed.out.includes('note turn failed: ThrottlingException-lookalike: too many requests'),
  );
  assert('replay names the failed turn and its class', replayed.out.includes('turn 2 failed: ProviderExplosion:'));
  assert('replay reports every failed turn', ['turn 2', 'turn 3', 'turn 4', 'turn 5'].every((label) => replayed.out.includes(`${label} failed:`)));
  const asJson = await runTrajectory({ verb: 'replay', sessionId, json: true });
  assert(
    'replay --json carries the failure in the history it prints',
    asJson.code === 0 &&
      (JSON.parse(asJson.out) as { kind: string; text?: string }[]).some(
        (item) => item.kind === 'notice' && (item.text ?? '').startsWith('turn failed: ThrottlingException-lookalike'),
      ),
  );
  const oneTurn = await runTrajectory({ verb: 'replay', sessionId, turn: 2, json: false });
  assert('replaying just the failed turn reports just that failure', oneTurn.code === 0 && oneTurn.out.includes('turn 2 failed:') && !oneTurn.out.includes('turn 3 failed:'));

  // Search: the failure text is content the record holds, so it is searchable — the
  // "which session hit this provider error" question.
  const byClass = await searchTrajectories(ROOT, 'ProviderExplosion', AGENT_ID);
  assert('a failure class is searchable', byClass.hitCount >= 1);
  assert(
    'the hit is the turnEnded record that closed the failed turn',
    byClass.sessions[0]?.hits.every((hit) => hit.type === 'turnEnded') === true,
  );
  const byMessage = await searchTrajectories(ROOT, 'too many requests', AGENT_ID, { type: 'turnEnded' });
  assert('the failure message is searchable too', byMessage.hitCount >= 1);
  assert(
    'the excerpt shows the failure',
    (byMessage.sessions[0]?.hits[0]?.excerpt ?? '').includes('ProviderExplosion'),
  );
}

async function turnSpend(): Promise<void> {
  header('trajectory — every turn records what it cost, and unknown never becomes zero');

  const dir = path.join(ROOT, 'spend');
  await rm(dir, { recursive: true, force: true });

  // One agent, one meter, two turns — the first of them two model calls — because the
  // claim is about a *turn's* delta of a *process's* lifetime accumulator, and neither
  // half of that is observable with one agent per turn.
  const first = usage(100, 20, { read: 50, write: 10 });
  const second = usage(200, 30, { read: 5, write: 1 });
  const third = usage(300, 40, { read: 7, write: 2 });
  const model = new MeteredModel([
    { usage: first, toolCall: { name: 'echoTool', input: { note: 'metered' } } },
    { usage: second, text: 'the answer after the tool call' },
    { usage: third, text: 'the second turn answer' },
  ]);
  const agent = newAgent(model);
  await agent.initialize();

  const file = path.join(dir, 'trajectory.jsonl');
  const rec = recorder(file);
  await recordedTurn(agent, rec, 'turn one, two model calls', { spend: meterFor(agent) });
  await rec.close();
  const afterFirst = await readFile(file);
  await recordedTurn(agent, rec, 'turn two, one model call', { spend: meterFor(agent) });
  await rec.close();

  assert('the first turn really made two model calls', model.calls === 3);
  const read = await readTrajectory(file);
  const ends = read.records.filter((r): r is TurnEndedRecord => r.type === 'turnEnded');
  const spends = ends.map((record) => turnSpendOf(record));
  assert('both turns recorded a spend', spends.length === 2 && spends.every((spend) => spend !== undefined));

  const turnOne = spends[0];
  assert(
    'a turn\u2019s spend is the sum of its own model calls, not the process total',
    turnOne?.input === first.inputTokens + second.inputTokens &&
      turnOne?.output === first.outputTokens + second.outputTokens &&
      turnOne?.cacheRead === 50 + 5 &&
      turnOne?.cacheWrite === 10 + 1,
  );
  const turnTwo = spends[1];
  assert(
    'the second turn records only its own call, with no carry-over from the first',
    turnTwo?.input === 300 && turnTwo?.output === 40 && turnTwo?.cacheRead === 7 && turnTwo?.cacheWrite === 2,
  );
  assert(
    'the spend is attributed to the model that incurred it, on the same line',
    turnOne?.provider === 'bedrock' && turnOne?.model === 'global.anthropic.claude-opus-5',
  );

  // The reconciliation rule: per metric, the recorded turns sum to the process meter.
  const meter = agent.metrics.accumulatedUsage;
  const summary = summarizeSpend(read.records);
  assert(
    'the recorded turns reconcile with the process meter, metric by metric',
    summary.input.total === meter.inputTokens &&
      summary.output.total === meter.outputTokens &&
      summary.cacheRead.total === meter.cacheReadInputTokens &&
      summary.cacheWrite.total === meter.cacheWriteInputTokens,
  );
  assert('the summary counts both turns and nothing unknown', summary.turnsWithSpend === 2 && summary.turnsUnknown === 0);
  assert('one model means one attribution group', summary.models.length === 1 && summary.models[0]?.turns === 2);
  assert(
    'the earlier turn\u2019s bytes are byte-identical after the second turn appends',
    sha256((await readFile(file)).subarray(0, afterFirst.byteLength)) === sha256(afterFirst),
  );

  // Why the field had to exist: the recorded `agentResultEvent` drops `metrics` (the SDK's
  // `toJSON()` excludes it by design) while `Message.toJSON()` keeps `metadata`, so what a
  // file already held was the **final model call's** usage — not the turn's. Pinned here so
  // the reason survives an SDK upgrade rather than living in a commit message.
  const resultRecord = read.records.find((record) => record.type === 'agentResultEvent') as unknown as {
    data: { result: { metrics?: unknown; lastMessage?: { metadata?: { usage?: Usage } } } };
  };
  const lastCall = resultRecord.data.result.lastMessage?.metadata?.usage;
  assert('a recorded agentResultEvent carries no metrics at all', resultRecord.data.result.metrics === undefined);
  assert(
    'what it does carry is the final model call, not the turn',
    lastCall?.inputTokens === second.inputTokens && lastCall?.outputTokens === second.outputTokens,
  );
  assert(
    'so the turn-scoped number can only come from the meter, and differs from it',
    (turnOne?.input ?? 0) > (lastCall?.inputTokens ?? 0),
  );

  // A provider that reports no cache counters at all: the keys must be *absent*, because
  // “not reported” and “zero” are different provider statements.
  const silentFile = path.join(dir, 'silent.jsonl');
  const silentRec = recorder(silentFile);
  const silentModel = new MeteredModel([{ usage: usage(11, 3), text: 'no cache counters here' }]);
  const silentAgent = newAgent(silentModel);
  await silentAgent.initialize();
  await recordedTurn(silentAgent, silentRec, 'unreported cache metrics', { spend: meterFor(silentAgent) });
  await silentRec.close();
  const silentLine = (await readFile(silentFile, 'utf8'))
    .split('\n')
    .find((line) => line.includes('"turnEnded"')) as string;
  assert(
    'an unreported metric is an absent key, not a zero',
    silentLine.includes('"spend"') && !silentLine.includes('cacheRead') && !silentLine.includes('cacheWrite'),
  );
  const silentSpend = turnSpendOf(
    (await readTrajectory(silentFile)).records.find((r): r is TurnEndedRecord => r.type === 'turnEnded') as TurnEndedRecord,
  );
  assert(
    'the reader keeps it unknown rather than inventing zero',
    silentSpend?.input === 11 && silentSpend.output === 3 && silentSpend.cacheRead === undefined,
  );
  const silentRendered = formatSpendSummary(summarizeSpend((await readTrajectory(silentFile)).records));
  assert(
    'the report renders an unreported metric as `-`',
    silentRendered.includes('input=11 output=3 cacheRead=- cacheWrite=-'),
  );

  // The case `usageBuckets` exists for: OpenAI Responses reports cache activity as
  // *subsets* of its input total, so with one subset missing the uncached remainder cannot
  // be computed without guessing. It stays absent all the way to the report rather than
  // being guessed at or zeroed.
  const splitFile = path.join(dir, 'unsplittable.jsonl');
  const splitRec = recorder(splitFile);
  const splitAgent = newAgent(new MeteredModel([{ usage: usage(900, 12, { read: 300 }), text: 'responses answer' }]));
  await splitAgent.initialize();
  await recordedTurn(splitAgent, splitRec, 'an unsplittable input total', {
    spend: meterFor(splitAgent, spendConfig('openai', 'responses')),
  });
  await splitRec.close();
  const splitRecords = (await readTrajectory(splitFile)).records;
  const splitSpend = turnSpendOf(splitRecords.find((r): r is TurnEndedRecord => r.type === 'turnEnded') as TurnEndedRecord);
  assert(
    'uncached input stays absent when a Responses cache subset is missing',
    splitSpend?.input === undefined && splitSpend?.cacheRead === 300 && splitSpend?.output === 12,
  );
  assert(
    'and the report says `-` for it rather than guessing a remainder',
    formatSpendSummary(summarizeSpend(splitRecords)).includes('input=- output=12 cacheRead=300 cacheWrite=-'),
  );

  // And the other statement: a provider that reports zero. Same rendering path, different
  // answer, which is the whole reason the distinction is kept on disk.
  const zeroFile = path.join(dir, 'zero.jsonl');
  const zeroRec = recorder(zeroFile);
  const zeroAgent = newAgent(new MeteredModel([{ usage: usage(11, 3, { read: 0, write: 0 }), text: 'cold cache' }]));
  await zeroAgent.initialize();
  await recordedTurn(zeroAgent, zeroRec, 'a measured zero', { spend: meterFor(zeroAgent) });
  await zeroRec.close();
  const zeroRecords = (await readTrajectory(zeroFile)).records;
  const zeroSpend = turnSpendOf(zeroRecords.find((r): r is TurnEndedRecord => r.type === 'turnEnded') as TurnEndedRecord);
  assert('a provider-reported zero stays a zero', zeroSpend?.cacheRead === 0 && zeroSpend.cacheWrite === 0);
  assert(
    'and renders as 0, distinguishably from `-`',
    formatSpendSummary(summarizeSpend(zeroRecords)).includes('cacheRead=0 cacheWrite=0'),
  );

  // A failed turn: the tokens of the calls that completed were billed, so they are
  // recorded — beside the failure, on the same line.
  const failFile = path.join(dir, 'failed.jsonl');
  const failRec = recorder(failFile);
  const thrown = new ProviderExplosion('the provider refused the second call');
  const failAgent = newAgent(
    new MeteredModel([
      { usage: usage(70, 8, { read: 3, write: 1 }), toolCall: { name: 'echoTool', input: { note: 'before the failure' } } },
      { throws: thrown },
    ]),
  );
  await failAgent.initialize();
  let caught: unknown;
  try {
    await recordedTurn(failAgent, failRec, 'a turn that fails after paying', { spend: meterFor(failAgent) });
  } catch (error) {
    caught = error;
  }
  await failRec.close();
  assert('the thrown error still reaches the caller as the identical object', caught === thrown);
  const failEnd = (await readTrajectory(failFile)).records.find(
    (r): r is TurnEndedRecord => r.type === 'turnEnded',
  ) as TurnEndedRecord;
  const failSpend = turnSpendOf(failEnd);
  assert('a failed turn records its failure', turnFailureOf(failEnd)?.name === 'ProviderExplosion');
  assert(
    'and records the spend it incurred before failing, on the same line',
    failSpend?.input === 70 && failSpend.output === 8 && failSpend.cacheRead === 3 && failSpend.cacheWrite === 1,
  );
  assert('the outcome is still read as failed', turnOutcome(failEnd) === 'failed');

  // A turn whose *first* call is rejected: nothing was billed. That is a measured zero,
  // not an unknown, and the difference is what a supervisor needs to see.
  const brokeFile = path.join(dir, 'broke.jsonl');
  const brokeRec = recorder(brokeFile);
  const brokeAgent = newAgent(new MeteredModel([{ throws: new ProviderExplosion('rejected outright') }]));
  await brokeAgent.initialize();
  try {
    await recordedTurn(brokeAgent, brokeRec, 'a turn that never billed', { spend: meterFor(brokeAgent) });
  } catch {
    // Propagation is asserted above.
  }
  await brokeRec.close();
  const brokeEnd = (await readTrajectory(brokeFile)).records.find(
    (r): r is TurnEndedRecord => r.type === 'turnEnded',
  ) as TurnEndedRecord;
  const brokeSpend = turnSpendOf(brokeEnd);
  assert(
    'a turn nothing billed records zeros rather than nothing',
    brokeSpend !== undefined && brokeSpend.input === 0 && brokeSpend.output === 0,
  );
  assert('with the two cache counters still unreported', brokeSpend?.cacheRead === undefined);

  // A cancelled turn: whatever completed before the cancel was billed too.
  const cancelFile = path.join(dir, 'cancelled.jsonl');
  const cancelRec = recorder(cancelFile);
  const cancelAgent = newAgent(
    new MeteredModel([
      {
        usage: usage(60, 9, { read: 2, write: 0 }),
        toolCall: { name: 'echoTool', input: { note: 'before the cancel' } },
      },
      { usage: usage(1, 1), text: 'an answer long enough to be interrupted midway' },
    ]),
  );
  await cancelAgent.initialize();
  for await (const event of recordStream(
    cancelAgent.stream('a cancelled turn'),
    cancelRec.beginTurn('a cancelled turn', meterFor(cancelAgent)),
  )) {
    if (event.type === 'afterToolCallEvent') cancelAgent.cancel();
  }
  await cancelRec.close();
  const cancelEnd = (await readTrajectory(cancelFile)).records.find(
    (r): r is TurnEndedRecord => r.type === 'turnEnded',
  ) as TurnEndedRecord;
  assert('a cancelled turn is still cancelled', turnOutcome(cancelEnd) === 'cancelled');
  assert(
    'and still records what it spent before the cancel',
    turnSpendOf(cancelEnd)?.input === 60 && turnSpendOf(cancelEnd)?.output === 9,
  );

  // The invariant that makes reading a live meter safe: a meter that throws costs the
  // spend field and nothing else — not the turn, not the record, not the session.
  const brokenFile = path.join(dir, 'broken-meter.jsonl');
  const brokenRec = recorder(brokenFile);
  const brokenAgent = newAgent(new MeteredModel([{ usage: usage(5, 5), text: 'the turn still works' }]));
  await brokenAgent.initialize();
  const brokenMeter: TurnSpendMeter = {
    read: () => {
      throw new Error('the meter exploded');
    },
  };
  const seen = await recordedTurn(brokenAgent, brokenRec, 'a turn with a broken meter', { spend: brokenMeter });
  await brokenRec.close();
  assert('a throwing meter does not fail the turn', seen.some((event) => event.type === 'agentResultEvent'));
  const brokenEnd = (await readTrajectory(brokenFile)).records.find(
    (r): r is TurnEndedRecord => r.type === 'turnEnded',
  ) as TurnEndedRecord;
  assert('the turn is still closed off with its own fields', brokenEnd.stopReason === 'endTurn' && typeof brokenEnd.ms === 'number');
  assert('the spend reads as unknown, not as zero', turnSpendOf(brokenEnd) === undefined);
  assert(
    'and recording is neither stopped nor blamed',
    brokenRec.status.problem === undefined && brokenRec.status.active,
  );

  // A model id is configuration, so it is as unbounded as any other user string: capped
  // on the record, with the cut written down, and bounded again when rendered.
  const longFile = path.join(dir, 'long-model.jsonl');
  const longRec = recorder(longFile);
  const longAgent = newAgent(new MeteredModel([{ usage: usage(2, 2), text: 'long model id' }]));
  await longAgent.initialize();
  const longConfig: AppConfig = { ...spendConfig('bedrock'), model: 'm'.repeat(MAX_FIELD_CHARS * 2) };
  await recordedTurn(longAgent, longRec, 'a pathological model id', {
    spend: meterFor(longAgent, longConfig),
  });
  await longRec.close();
  const longEnd = (await readTrajectory(longFile)).records.find(
    (r): r is TurnEndedRecord => r.type === 'turnEnded',
  ) as TurnEndedRecord;
  assert(
    'the model label is capped on the record with its truncation recorded',
    [...(turnSpendOf(longEnd)?.model ?? '')].length === MAX_FIELD_CHARS &&
      (longEnd.trunc ?? []).some((entry) => entry.path === 'spend.model'),
  );
  const longReplay = formatReplay({
    ...replayRecords((await readTrajectory(longFile)).records),
    damage: undefined,
  });
  const longLine = longReplay.split('\n').find((line) => line.includes('turn 1 spend:')) as string;
  assert(
    'and the rendered line stays bounded',
    [...longLine].length <= MAX_MODEL_LABEL_CHARS + 120,
  );
}

async function turnSpendReadPaths(): Promise<void> {
  header('trajectory — list and replay report spend, and say unknown when it is unknown');

  const paths = sessionPaths(ROOT);
  await rm(paths.sessionsDir, { recursive: true, force: true });

  // Two processes appending to one session, each with its own model: turn ordinals
  // restart per process (a pre-existing property), so this also pins that the aggregate
  // counts turn *records* rather than distinct ordinals.
  const sessionId = 'session-20260816-400000';
  const file = trajectoryPath(ROOT, sessionId);
  const firstRun = recorder(file);
  const opusAgent = newAgent(new MeteredModel([{ usage: usage(120, 15, { read: 40, write: 5 }), text: 'opus answer' }]));
  await opusAgent.initialize();
  await recordedTurn(opusAgent, firstRun, 'ask opus', { spend: meterFor(opusAgent) });
  await firstRun.close();

  const secondRun = recorder(file);
  const gptAgent = newAgent(new MeteredModel([{ usage: usage(80, 25), text: 'gpt answer' }]));
  await gptAgent.initialize();
  // Chat Completions reports no cache counters, so this turn's two cache metrics are
  // unreported while the first turn's are known — the partial-total case.
  await recordedTurn(gptAgent, secondRun, 'ask gpt', { spend: meterFor(gptAgent, spendConfig('openai', 'chat')) });
  await secondRun.close();

  const records = (await readTrajectory(file)).records;
  const summary = summarizeSpend(records);
  assert('both turn records are counted, though both are ordinal 1', summary.turnsWithSpend === 2);
  assert('the file is reported as holding two models', summary.models.length === 2);
  assert('a metric only one turn reported is summed and the gap counted', summary.cacheRead.total === 40 && summary.cacheRead.unreportedTurns === 1);
  assert('a metric every turn reported is a plain sum', summary.output.total === 40 && summary.output.unreportedTurns === 0);

  const listed = await runTrajectory({ verb: 'list' });
  const row = listed.out.split('\n').find((line) => line.startsWith(sessionId)) ?? '';
  assert('list exits 0 and reports the session spend', listed.code === 0 && row.includes('spend: input=200'));
  assert('list marks a partly reported metric rather than hiding the gap', row.includes('cacheRead=40(+1 unreported)'));
  assert('list says a total covers more than one model', row.includes('2 models:'));
  assert('the spend clause keeps the row one bounded line', !row.includes('\n') && [...row].length < 400);

  const replayed = await runTrajectory({ verb: 'replay', sessionId, json: false });
  assert('replay exits 0 and reports per-turn spend', replayed.code === 0 && replayed.out.includes('turn 1 spend: input=120 output=15 cacheRead=40 cacheWrite=5'));
  assert(
    'replay reports the aggregate over the turns it replayed',
    replayed.out.includes('session spend: input=200 output=40 cacheRead=40(+1 unreported)'),
  );
  assert(
    'replay breaks a mixed total down per model',
    replayed.out.includes('bedrock/global.anthropic.claude-opus-5: input=120') &&
      replayed.out.includes('openai/openai.gpt-5.6-sol: input=80'),
  );
  const oneTurn = await runTrajectory({ verb: 'replay', sessionId, turn: 1, json: false });
  assert('a filtered replay reports the spend of what it replayed', oneTurn.code === 0 && oneTurn.out.includes('session spend:'));
  const asJson = await runTrajectory({ verb: 'replay', sessionId, json: true });
  assert(
    'replay --json keeps printing history and nothing else',
    asJson.code === 0 && Array.isArray(JSON.parse(asJson.out)),
  );
  const again = await runTrajectory({ verb: 'replay', sessionId, json: false });
  assert('the report is deterministic over the same bytes', again.out === replayed.out);

  // A record written before this field existed. Not synthesised loosely: these are `v: 1`
  // lines of exactly the shape darwin wrote before spend, and they must read as unknown —
  // a session that cost real money must never be reported as a free one.
  const legacyId = 'session-20260816-410000';
  const legacyFile = trajectoryPath(ROOT, legacyId);
  await mkdir(path.dirname(legacyFile), { recursive: true });
  await writeFile(
    legacyFile,
    [
      '{"v":1,"seq":0,"t":"2026-08-16T10:00:00.000Z","turn":0,"type":"runStarted","session":"session-20260816-410000","agentId":"darwin","darwinVersion":"0.0.1","provider":"bedrock","model":"global.anthropic.claude-opus-5","permissionMode":"default","thinkingEffort":"high","resumed":false,"restoredMessages":0,"pid":1}',
      '{"v":1,"seq":1,"t":"2026-08-16T10:00:01.000Z","turn":1,"type":"userInput","text":"an old question"}',
      '{"v":1,"seq":2,"t":"2026-08-16T10:00:02.000Z","turn":1,"type":"turnEnded","stopReason":"endTurn","ms":1200,"recorded":{"agentResultEvent":1},"dropped":{}}',
      '{"v":1,"seq":3,"t":"2026-08-16T10:00:03.000Z","turn":2,"type":"userInput","text":"a second old question"}',
      '{"v":1,"seq":4,"t":"2026-08-16T10:00:04.000Z","turn":2,"type":"turnEnded","stopReason":"endTurn","ms":900,"recorded":{"agentResultEvent":1},"dropped":{}}',
      '',
    ].join('\n'),
    'utf8',
  );
  const legacyRecords = (await readTrajectory(legacyFile)).records;
  assert('a pre-spend v:1 file still parses in full', legacyRecords.length === 5);
  const legacySummary = summarizeSpend(legacyRecords);
  assert(
    'its turns are counted as unknown, not as zero-cost',
    legacySummary.turnsWithSpend === 0 && legacySummary.turnsUnknown === 2 && legacySummary.input.total === undefined,
  );
  const legacyRow =
    (await runTrajectory({ verb: 'list' })).out.split('\n').find((line) => line.startsWith(legacyId)) ?? '';
  assert('list says the spend is unknown', legacyRow.includes('spend: unknown') && !legacyRow.includes('input=0'));
  const legacyReplay = await runTrajectory({ verb: 'replay', sessionId: legacyId, json: false });
  assert('replay of a pre-spend record exits 0', legacyReplay.code === 0);
  assert(
    'and says per-turn and in total that nothing measured it',
    legacyReplay.out.includes('turn 1 spend: unknown (not recorded)') &&
      legacyReplay.out.includes('session spend: unknown over 2 turn(s)'),
  );
  assert('with no fabricated zero anywhere in the report', !legacyReplay.out.includes('input=0'));

  // A damaged or foreign spend payload: still unknown rather than a confident zero.
  const brokenRecord = parseRecordLine(
    '{"v":1,"seq":9,"t":"2026-08-16T10:00:05.000Z","turn":3,"type":"turnEnded","stopReason":"endTurn","ms":5,' +
      '"recorded":{},"dropped":{},"spend":{"provider":"bedrock","model":"m","input":"lots","output":null}}',
  ) as TurnEndedRecord;
  assert('a spend whose numbers are not numbers reads as unknown', turnSpendOf(brokenRecord) === undefined);
}

async function modelCallRecords(): Promise<void> {
  header('trajectory — every completed model call leaves one bounded record, priced per call');

  const dir = path.join(ROOT, 'model-calls');
  await rm(dir, { recursive: true, force: true });

  // One turn, two completed model calls (tool cycle + answer), driven through a real
  // Agent so the recorded events are the SDK's own before/afterModelCallEvent pair.
  const first = usage(100, 20, { read: 50, write: 10 });
  const second = usage(200, 30, { read: 5, write: 1 });
  const model = new MeteredModel([
    { usage: first, toolCall: { name: 'echoTool', input: { note: 'per call' } } },
    { usage: second, text: 'the answer after the tool call' },
  ]);
  const agent = newAgent(model);
  await agent.initialize();

  const file = path.join(dir, 'trajectory.jsonl');
  const rec = recorder(file);
  await recordedTurn(agent, rec, 'one turn, two calls', {
    spend: meterFor(agent),
    callSpend: startCallSpend(spendConfig('bedrock')),
  });
  await rec.close();

  const read = await readTrajectory(file);
  const calls = read.records.filter((r): r is ModelCallRecord => r.type === 'modelCall');
  assert('one modelCall record per completed call, in order', calls.length === 2);
  const [callOne, callTwo] = calls.map((record) => modelCallOf(record));
  assert('both calls belong to the turn and carry the SDK 1-indexed attempt count',
    calls.every((record) => record.turn === 1) && callOne?.attempt === 1 && callTwo?.attempt === 1);
  assert('ms is time since turn start, a finite non-negative number per call',
    (callOne?.ms ?? -1) >= 0 && (callTwo?.ms ?? -1) >= (callOne?.ms ?? 0));
  assert('each call records the stop reason the SDK reported for it',
    callOne?.stopReason === 'toolUse' && callTwo?.stopReason === 'endTurn');
  assert('spend is the call\u2019s own counters, not the running turn delta',
    callOne?.spend?.input === 100 && callOne.spend.output === 20 &&
    callOne.spend.cacheRead === 50 && callOne.spend.cacheWrite === 10 &&
    callTwo?.spend?.input === 200 && callTwo.spend.output === 30 &&
    callTwo.spend.cacheRead === 5 && callTwo.spend.cacheWrite === 1);
  assert('the per-call spend carries the same attribution vocabulary as turnEnded.spend',
    callOne?.spend?.provider === 'bedrock' && callOne.spend.model === 'global.anthropic.claude-opus-5');
  assert('contextTokens is the agent loop\u2019s request estimate for each call — present here, and never 0',
    calls.every((record) => {
      const reading = modelCallOf(record);
      return reading.contextTokens !== undefined && reading.contextTokens > 0;
    }));
  assert('the second call\u2019s estimate reflects the grown context, not a stale first reading',
    (callTwo?.contextTokens ?? 0) > (callOne?.contextTokens ?? 0));

  const end = read.records.find((r): r is TurnEndedRecord => r.type === 'turnEnded');
  const callSeqs = calls.map((record) => record.seq);
  assert('call records precede the closing record in the same buffered batch',
    end !== undefined && callSeqs.every((seq) => seq < end.seq));
  assert('the raw afterModelCallEvent stays a counted drop — the projection is not a fifth recorded event type',
    (end?.dropped['afterModelCallEvent'] ?? 0) >= 2 && end?.recorded['afterModelCallEvent'] === undefined);
  assert('a modelCall line parses through the envelope validator',
    parseRecordLine(JSON.stringify(calls[0]))?.type === 'modelCall');

  // A provider that reports no usage for the call: the record exists, the price does not.
  const silentFile = path.join(dir, 'silent.jsonl');
  const silentRec = recorder(silentFile);
  const silentAgent = newAgent(new MeteredModel([{ text: 'no usage reported' }]));
  await silentAgent.initialize();
  await recordedTurn(silentAgent, silentRec, 'unmetered call', {
    callSpend: startCallSpend(spendConfig('bedrock')),
  });
  await silentRec.close();
  const silentLine = (await readFile(silentFile, 'utf8'))
    .split('\n')
    .find((line) => line.includes('"modelCall"')) as string;
  assert('an unmetered call\u2019s spend is an absent key, never zeros',
    silentLine !== undefined && !silentLine.includes('"spend"'));

  // No projector injected at all (a legacy caller): the call lines still exist, unpriced.
  const bareFile = path.join(dir, 'bare.jsonl');
  const bareRec = recorder(bareFile);
  const bareAgent = newAgent(new MeteredModel([{ usage: usage(11, 3), text: 'metered but unprojected' }]));
  await bareAgent.initialize();
  await recordedTurn(bareAgent, bareRec, 'no projector');
  await bareRec.close();
  const bareCalls = (await readTrajectory(bareFile)).records.filter((r) => r.type === 'modelCall');
  assert('without a projector the record is written with spend absent',
    bareCalls.length === 1 && modelCallOf(bareCalls[0] as ModelCallRecord).spend === undefined);

  // A failed attempt records nothing: the first call completed, the second threw.
  const failFile = path.join(dir, 'failed.jsonl');
  const failRec = recorder(failFile);
  const thrown = new ProviderExplosion('the provider refused the second call');
  const failAgent = newAgent(
    new MeteredModel([
      { usage: first, toolCall: { name: 'echoTool', input: { note: 'before the failure' } } },
      { throws: thrown },
    ]),
  );
  await failAgent.initialize();
  let caught: unknown;
  try {
    await recordedTurn(failAgent, failRec, 'fails on the second call', {
      spend: meterFor(failAgent),
      callSpend: startCallSpend(spendConfig('bedrock')),
    });
  } catch (error) {
    caught = error;
  }
  await failRec.close();
  assert('the thrown error still reaches the caller as the identical object', caught === thrown);
  const failRead = await readTrajectory(failFile);
  const failCalls = failRead.records.filter((r): r is ModelCallRecord => r.type === 'modelCall');
  const failEnd = failRead.records.find((r): r is TurnEndedRecord => r.type === 'turnEnded');
  assert('only the completed call is recorded; the failed attempt leaves no call line',
    failCalls.length === 1 && modelCallOf(failCalls[0] as ModelCallRecord).spend?.input === 100);
  assert('the failed attempt stays visible where it belongs: turnEnded.failure',
    failEnd !== undefined && turnOutcome(failEnd) === 'failed');

  // Replay: the call lines are a bounded projection beside the spend report, and the
  // reconstructed history is untouched — the live TUI never drew a row for them.
  const replayed = replayRecords(read.records);
  const withoutCalls = replayRecords(read.records.filter((record) => record.type !== 'modelCall'));
  assert('modelCall records add no history item to replay',
    JSON.stringify(historyWithoutIds(replayed.history)) === JSON.stringify(historyWithoutIds(withoutCalls.history)));
  assert('replay collects one entry per call', replayed.modelCalls.length === 2);
  const formatted = formatReplay({ ...replayed, damage: undefined });
  assert('formatReplay prints one bounded line per completed call',
    formatted.includes('turn 1 model call (attempt 1,') &&
    formatted.includes('stop toolUse') &&
    formatted.includes('stop endTurn') &&
    formatted.includes('input=100 output=20 cacheRead=50 cacheWrite=10'));
  const callLines = formatted.split('\n').filter((line) => line.includes('model call (attempt'));
  assert('each call line is one bounded line', callLines.length === 2 && callLines.every((line) => [...line].length < 400));
  assert('a file without modelCall records renders formatReplay byte-identically to before the type existed',
    !formatReplay({ ...withoutCalls, damage: undefined }).includes('model call (attempt'));

  // A defensively read damaged payload degrades to unknown, never to invented zeros.
  const junk = modelCallOf({
    v: 1, seq: 9, t: 'now', turn: 2, type: 'modelCall',
    attempt: 'x', ms: Number.NaN, stopReason: 7, contextTokens: 'big', spend: { provider: 3 },
  } as unknown as ModelCallRecord);
  assert('a damaged modelCall payload reads as unknown fields, not zeros',
    junk.turn === 2 && junk.attempt === 0 && junk.ms === 0 &&
    junk.stopReason === undefined && junk.contextTokens === undefined && junk.spend === undefined);
}

/**
 * SRF-027: a successful `/compact` leaves one bounded `contextCompacted` record —
 * counts and a flag, never summary or focus text — and readers treat it as the anchor
 * drop that makes the next `modelCall.contextTokens` stale.
 */
async function contextCompactedRecords(): Promise<void> {
  header('trajectory — a successful /compact leaves one bounded contextCompacted record');

  const dir = path.join(ROOT, 'compacted');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');
  const rec = recorder(file);

  // Synchronous like `recordShellCommand`: composed and buffered before any I/O.
  let settledBeforeReturn = true;
  const pending = new Promise<void>((resolve) => setImmediate(() => { settledBeforeReturn = false; resolve(); }));
  rec.recordContextCompacted({ messagesBefore: 12, messagesAfter: 5, estimatedTokensBefore: 705408, focused: true });
  assert('recordContextCompacted returns synchronously — no await on the record path', settledBeforeReturn);
  await pending;
  rec.recordContextCompacted({ messagesBefore: 8, messagesAfter: 3, focused: false });
  // Malformed counts are refused at the writer: the message counts are the record's
  // whole claim, so none of these produces a line.
  rec.recordContextCompacted({ messagesBefore: -1, messagesAfter: 3, focused: false });
  rec.recordContextCompacted({ messagesBefore: 2.5, messagesAfter: 3, focused: false });
  rec.recordContextCompacted({ messagesBefore: 1e300, messagesAfter: 3, focused: false });
  rec.recordContextCompacted({ messagesBefore: Number.NaN, messagesAfter: 3, focused: false });
  // An estimate that is 0, negative, fractional or huge is unknown: an absent key.
  rec.recordContextCompacted({ messagesBefore: 9, messagesAfter: 4, estimatedTokensBefore: 0, focused: false });
  rec.recordContextCompacted({ messagesBefore: 9, messagesAfter: 4, estimatedTokensBefore: -5, focused: false });
  rec.recordContextCompacted({ messagesBefore: 9, messagesAfter: 4, estimatedTokensBefore: 1e300, focused: false });
  await rec.close();
  assert('recording compactions reports no problem', rec.status.problem === undefined);

  const raw = await readFile(file, 'utf8');
  const lines = raw.split('\n').filter((line) => line.includes('"contextCompacted"'));
  const read = await readTrajectory(file);
  const compactions = read.records.filter((r): r is ContextCompactedRecord => r.type === 'contextCompacted');
  assert('one line per accepted compaction and none for a refused count', compactions.length === 5 && lines.length === 5);
  assert('every compaction line parses through the envelope validator',
    lines.every((line) => parseRecordLine(line)?.type === 'contextCompacted'));
  assert('the record carries the last closed turn ordinal, like shellCommand (0 before any turn)',
    compactions.every((record) => record.turn === 0));

  const [focusedOne, plain, zero, negative, huge] = compactions.map((record) => contextCompactedOf(record));
  assert('the record round-trips writer → reader → normalizer',
    focusedOne?.messagesBefore === 12 && focusedOne.messagesAfter === 5 &&
    focusedOne.estimatedTokensBefore === 705408 && focusedOne.focused === true);
  assert('an unfocused compaction reads focused: false with the estimate absent',
    plain?.messagesBefore === 8 && plain.messagesAfter === 3 && plain.focused === false &&
    plain.estimatedTokensBefore === undefined);
  assert('an absent estimate is an absent key in the bytes, never 0',
    lines[1] !== undefined && !lines[1].includes('estimatedTokens') && lines[1].includes('"before":{"messages":8}'));
  assert('a 0, negative or huge estimate is written as absence, and reads back absent',
    [zero, negative, huge].every((reading) => reading !== undefined && reading.estimatedTokensBefore === undefined) &&
    lines.slice(2).every((line) => !line.includes('estimatedTokens')));
  assert('the record holds exactly the envelope plus before/after/focused — no text field at all',
    compactions.every((record) =>
      Object.keys(record).sort().join(',') === 'after,before,focused,seq,t,turn,type,v'));

  // The reader on damaged or foreign payloads: reject the claim, never half-read it.
  const damaged = (payload: Record<string, unknown>) =>
    contextCompactedOf({ v: 1, seq: 9, t: 'now', turn: 2, type: 'contextCompacted', ...payload } as unknown as ContextCompactedRecord);
  assert('a negative or non-integer count rejects the record',
    damaged({ before: { messages: -1 }, after: { messages: 3 }, focused: false }) === undefined &&
    damaged({ before: { messages: 2.5 }, after: { messages: 3 }, focused: false }) === undefined);
  assert('a huge or stringy count rejects the record',
    damaged({ before: { messages: 1e300 }, after: { messages: 3 }, focused: false }) === undefined &&
    damaged({ before: { messages: '12' }, after: { messages: 3 }, focused: false }) === undefined);
  assert('a missing before/after object rejects the record',
    damaged({ before: null, after: { messages: 3 }, focused: false }) === undefined &&
    damaged({ before: { messages: 3 }, focused: false }) === undefined);
  const foreign = damaged({
    before: { messages: 12, estimatedTokens: 'lots' }, after: { messages: 5 }, focused: 'yes',
    summary: 'a summary nobody should have written', focus: 'nor this',
  });
  assert('a foreign payload keeps the counts, degrades the estimate to absence and a non-boolean focused to false',
    foreign !== undefined && foreign.messagesBefore === 12 && foreign.messagesAfter === 5 &&
    foreign.estimatedTokensBefore === undefined && foreign.focused === false && foreign.turn === 2);
  assert('extra text fields are not carried into the reading',
    foreign !== undefined && !('summary' in foreign) && !('focus' in foreign));
  assert('a zero estimate reads as absent, never 0',
    damaged({ before: { messages: 12, estimatedTokens: 0 }, after: { messages: 5 }, focused: true })?.estimatedTokensBefore === undefined);
  assert('the record contributes no searchable text — there are no words in it',
    searchableText(compactions[0] as TrajectoryRecord).length === 0);

  // Replay and spend: the notice in transcript order, and the anchor drop on the
  // first call after it — the second call is labelled normally again.
  const at = '2026-09-05T07:00:00.000Z';
  const call = (seq: number, turn: number, contextTokens: number): TrajectoryRecord =>
    ({ v: 1, seq, t: at, turn, type: 'modelCall', attempt: 1, ms: 10, stopReason: 'endTurn', contextTokens }) as TrajectoryRecord;
  const closing = (seq: number, turn: number): TrajectoryRecord =>
    ({ v: 1, seq, t: at, turn, type: 'turnEnded', stopReason: 'endTurn', ms: 20, recorded: {}, dropped: {} }) as TrajectoryRecord;
  const compaction = { ...(compactions[0] as ContextCompactedRecord), seq: 4, turn: 1 };
  const session: TrajectoryRecord[] = [
    { v: 1, seq: 1, t: at, turn: 1, type: 'userInput', text: 'first prompt' } as TrajectoryRecord,
    call(2, 1, 100),
    closing(3, 1),
    compaction,
    { v: 1, seq: 5, t: at, turn: 2, type: 'userInput', text: 'second prompt' } as TrajectoryRecord,
    call(6, 2, 705408),
    call(7, 2, 46647),
    closing(8, 2),
  ];
  const replayed = replayRecords(session);
  const transcript = formatReplay({ ...replayed, damage: undefined });
  const noteLine = '  note context compacted: 12 → 5 messages · ~705408 tokens before · focused';
  assert('formatReplay prints the compaction as one bounded notice line',
    transcript.split('\n').includes(noteLine));
  assert('the notice sits in transcript order — after the first turn, before the second prompt',
    transcript.indexOf('you> first prompt') < transcript.indexOf(noteLine) &&
    transcript.indexOf(noteLine) < transcript.indexOf('you> second prompt'));
  assert('an unfocused compaction without an estimate prints only the counts',
    formatContextCompacted({ turn: 0, messagesBefore: 8, messagesAfter: 3, focused: false }) === 'context compacted: 8 → 3 messages');
  const [before, stale, fresh] = replayed.modelCalls;
  assert('the call before the compaction keeps its estimate',
    before?.contextTokens === 100 && before.contextReset === undefined);
  assert('the first call after the compaction drops the stale SDK projection and says why',
    stale?.contextReset === 'compaction' && stale.contextTokens === undefined);
  assert('the second call after the compaction is labelled normally',
    fresh?.contextTokens === 46647 && fresh.contextReset === undefined);
  const callLines = transcript.split('\n').filter((line) => line.includes('model call (attempt'));
  assert('the call lines say `context: reset by compaction` exactly once, and never print the stale number',
    callLines.length === 3 &&
    callLines.filter((line) => line.includes('context: reset by compaction')).length === 1 &&
    callLines.some((line) => line.includes('context ~100 tokens')) &&
    callLines.some((line) => line.includes('context ~46647 tokens')) &&
    callLines.every((line) => !line.includes('705408')));

  // A record whose counts do not validate neither prints nor drops the anchor.
  const unreadable = { ...compaction, before: { messages: -1 } } as unknown as TrajectoryRecord;
  const withUnreadable = replayRecords(session.map((record) => (record === compaction ? unreadable : record)));
  assert('an unreadable compaction record prints nothing and leaves every call labelled normally',
    !formatReplay({ ...withUnreadable, damage: undefined }).includes('context compacted') &&
    withUnreadable.modelCalls.every((entry) => entry.contextReset === undefined && entry.contextTokens !== undefined));
  // Files without the record keep their transcript byte for byte.
  const without = replayRecords(session.filter((record) => record !== compaction));
  assert('a file without the record renders formatReplay byte-identically to before the type existed',
    !formatReplay({ ...without, damage: undefined }).includes('compact') &&
    without.modelCalls.every((entry) => entry.contextReset === undefined));
  assert('a --turn replay of the turn the compaction closed shows its line; other turns do not',
    formatReplay({ ...replayRecords(session, { turn: 1 }), damage: undefined }).includes(noteLine) &&
    !formatReplay({ ...replayRecords(session, { turn: 2 }), damage: undefined }).includes('context compacted'));
}

/**
 * SER-079: one bounded `permissionDecision` record per settled gate decision — inside
 * the turn, keyed to the call by `toolUseId`, never the input; replay prints one line
 * for a prompted or denied decision and nothing for a silent approval.
 */
async function permissionDecisionRecords(): Promise<void> {
  header('trajectory — a settled permission decision leaves one bounded permissionDecision record');

  // Writer level: the record rides the open turn, caps its strings, drops out of turn.
  const dir = path.join(ROOT, 'permission');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');
  const rec = recorder(file);
  const base = {
    toolUseId: 'call-a', toolName: 'bash', kind: 'execute', risk: 'dangerous', mode: 'default', source: 'parent',
  } as const;
  const longRule = `bash:${'x'.repeat(MAX_FIELD_CHARS + 1000)}`;

  rec.recordPermissionDecision({ ...base, toolUseId: 'before-any-turn', outcome: 'safe', promptedUser: false });
  const turn = rec.beginTurn('a prompt');
  let settledBeforeReturn = true;
  const pending = new Promise<void>((resolve) => setImmediate(() => { settledBeforeReturn = false; resolve(); }));
  rec.recordPermissionDecision({ ...base, outcome: 'user-approved', rule: 'bash:pnpm *', promptedUser: true });
  assert('recordPermissionDecision returns synchronously — no await on the record path', settledBeforeReturn);
  await pending;
  turn?.recordPermissionDecision({ ...base, toolUseId: 'call-b', outcome: 'deny-rule', rule: longRule, promptedUser: false });
  rec.recordPermissionDecision({ ...base, toolUseId: 'call-c', toolName: 'fileEditor', kind: 'read', risk: 'safe', outcome: 'safe', promptedUser: false });
  rec.recordPermissionDecision({
    ...base, toolUseId: 'call-d', source: 'explorer#d1', outcome: 'user-denied', promptedUser: true,
  });
  turn?.end();
  rec.recordPermissionDecision({ ...base, toolUseId: 'after-the-turn', outcome: 'yolo', promptedUser: false });
  await rec.close();
  assert('recording decisions reports no problem', rec.status.problem === undefined);

  const raw = await readFile(file, 'utf8');
  const read = await readTrajectory(file);
  const decisions = read.records.filter((r): r is PermissionDecisionRecord => r.type === 'permissionDecision');
  assert('one line per in-turn decision; the two that arrived with no open turn were dropped',
    decisions.length === 4 && !raw.includes('before-any-turn') && !raw.includes('after-the-turn'));
  assert('every decision line parses through the envelope validator and carries the turn ordinal',
    decisions.every((record) => parseRecordLine(JSON.stringify(record))?.type === 'permissionDecision' && record.turn === 1));
  assert('the decisions sit inside the turn, between userInput and turnEnded, in observation order',
    read.records.findIndex((r) => r.type === 'userInput') < read.records.findIndex((r) => r.type === 'permissionDecision') &&
    read.records.findLastIndex((r) => r.type === 'permissionDecision') < read.records.findIndex((r) => r.type === 'turnEnded') &&
    decisions.map((r) => r.toolUseId).join() === 'call-a,call-b,call-c,call-d');
  const [approved, ruleDenied, silent, childDenied] = decisions;
  assert('the record round-trips writer → reader → validator',
    permissionDecisionOf(approved!)?.outcome === 'user-approved' && permissionDecisionOf(approved!)?.rule === 'bash:pnpm *' &&
    permissionDecisionOf(approved!)?.promptedUser === true && permissionDecisionOf(approved!)?.mode === 'default');
  assert('the rule field is capped at MAX_FIELD_CHARS with the truncation written down',
    [...(ruleDenied?.rule ?? '')].length === MAX_FIELD_CHARS &&
    ruleDenied?.trunc?.some((t) => t.path === 'rule' && t.kept === MAX_FIELD_CHARS && t.chars === [...longRule].length) === true);
  assert('a decision without a rule has no rule key; a child decision keeps its source label',
    !('rule' in silent!) && childDenied?.source === 'explorer#d1' && childDenied.outcome === 'user-denied');
  assert('the record holds exactly the envelope plus the audit fields — no input, arguments, command or path',
    decisions.every((record) => {
      const keys = Object.keys(record).filter((key) => key !== 'rule' && key !== 'trunc').sort().join(',');
      return keys === 'kind,mode,outcome,promptedUser,risk,seq,source,t,toolName,toolUseId,turn,type,v';
    }) && !raw.includes('"input"') && !raw.includes('"command"'));
  assert('the record contributes its tool name, outcome and rule to search — nothing else',
    searchableText(approved!).join('|') === 'bash|user-approved|bash:pnpm *' &&
    searchableText(silent!).join('|') === 'fileEditor|safe');

  // The reader on damaged or foreign payloads: reject the claim, never half-read it.
  const damaged = (payload: Record<string, unknown>) =>
    permissionDecisionOf({ v: 1, seq: 9, t: 'now', turn: 2, type: 'permissionDecision', ...payload } as unknown as PermissionDecisionRecord);
  const full = { toolUseId: 'x', toolName: 'bash', kind: 'execute', risk: 'dangerous', mode: 'default', source: 'parent', outcome: 'user-denied', promptedUser: true };
  assert('an unknown outcome or a missing tool name rejects the record',
    damaged({ ...full, outcome: 'bogus' }) === undefined && damaged({ ...full, outcome: 7 }) === undefined &&
    damaged({ ...full, toolName: '' }) === undefined && damaged({ ...full, toolName: undefined }) === undefined);
  const foreign = damaged({ ...full, kind: 'delete', risk: 'meh', mode: 3, source: '', rule: 12, promptedUser: 'yes', input: { command: 'rm' } });
  assert('a foreign payload degrades kind/risk/mode/source fail-closed, drops a non-string rule and a non-boolean flag',
    foreign !== undefined && foreign.kind === 'execute' && foreign.risk === 'dangerous' && foreign.mode === 'unknown' &&
    foreign.source === 'parent' && !('rule' in foreign) && foreign.promptedUser === false && foreign.turn === 2);
  assert('extra fields are not carried into the reading', foreign !== undefined && !('input' in foreign));
  assert('searchableText of an unreadable decision is empty',
    searchableText({ v: 1, seq: 1, t: 'now', turn: 1, type: 'permissionDecision', outcome: 'bogus', toolName: 'bash' } as unknown as TrajectoryRecord).length === 0);

  // Replay: one line for a prompted or denied decision, nothing for a silent one.
  const at = '2026-09-08T07:00:00.000Z';
  const decision = (seq: number, turn: number, fields: Record<string, unknown>): TrajectoryRecord =>
    ({ v: 1, seq, t: at, turn, type: 'permissionDecision', ...full, toolUseId: `c${seq}`, ...fields }) as TrajectoryRecord;
  const closing = (seq: number, turn: number): TrajectoryRecord =>
    ({ v: 1, seq, t: at, turn, type: 'turnEnded', stopReason: 'endTurn', ms: 20, recorded: {}, dropped: {} }) as TrajectoryRecord;
  const silentOnes = [
    decision(2, 1, { outcome: 'safe', risk: 'safe', kind: 'read', toolName: 'fileEditor', promptedUser: false }),
    decision(3, 1, { outcome: 'yolo', mode: 'yolo', promptedUser: false }),
    decision(4, 1, { outcome: 'allow-rule', rule: 'bash:pnpm *', promptedUser: false }),
    decision(5, 1, { outcome: 'classifier', mode: 'auto', promptedUser: false }),
  ];
  const visibleOnes = [
    decision(6, 1, { outcome: 'user-approved', rule: 'fileEditor:src/**', toolName: 'fileEditor', kind: 'write', promptedUser: true }),
    decision(7, 1, { outcome: 'deny-rule', rule: 'bash:git push --force*', promptedUser: false }),
    decision(8, 1, { outcome: 'user-denied', source: 'explorer#d1', promptedUser: true }),
    decision(9, 1, { outcome: 'plan-denied', mode: 'plan', promptedUser: false }),
    decision(10, 1, { outcome: 'write-scope-denied', toolName: 'fileEditor', kind: 'write', source: 'general#n1', promptedUser: false }),
    decision(11, 1, { outcome: 'restart-limit-denied', promptedUser: true }),
    decision(12, 1, { outcome: 'yolo', mode: 'yolo', promptedUser: true }),
    decision(13, 1, { outcome: 'user-approved', promptedUser: true }),
  ];
  const unreadable = [
    decision(14, 1, { outcome: 'bogus' }),
    decision(15, 1, { toolName: 7 }),
  ];
  const prompt: TrajectoryRecord = { v: 1, seq: 1, t: at, turn: 1, type: 'userInput', text: 'first prompt' } as TrajectoryRecord;
  const second: TrajectoryRecord = { v: 1, seq: 17, t: at, turn: 2, type: 'userInput', text: 'second prompt' } as TrajectoryRecord;
  const session = [prompt, ...silentOnes, ...visibleOnes, ...unreadable, closing(16, 1), second, closing(18, 2)];
  const transcript = formatReplay({ ...replayRecords(session), damage: undefined });
  const lines = transcript.split('\n');
  const expected = [
    '  note permission · fileEditor · approved by user (rule granted fileEditor:src/**)',
    '  note permission · bash · denied by deny rule bash:git push --force*',
    '  note permission · bash · denied by user · explorer#d1',
    '  note permission · bash · denied by plan mode',
    '  note permission · fileEditor · denied by workflow write scope · general#n1',
    '  note permission · bash · denied after repeated mode changes',
    '  note permission · bash · approved by yolo mode · prompted',
    '  note permission · bash · approved by user',
  ];
  assert('formatReplay prints one bounded note per prompted or denied decision, in transcript order',
    expected.every((line) => lines.includes(line)) &&
    expected.map((line) => lines.indexOf(line)).every((index, i, all) => i === 0 || index > all[i - 1]!));
  assert('exactly the eight visible decisions print — silent approvals and unreadable lines print nothing',
    lines.filter((line) => line.includes('permission ·')).length === 8 &&
    !transcript.includes('statically safe') && !transcript.includes('allow rule') && !transcript.includes('classifier') &&
    !transcript.includes('bogus'));
  assert('the notes sit inside their turn — after the first prompt, before the second',
    lines.indexOf('you> first prompt') < lines.indexOf(expected[0]!) &&
    lines.indexOf(expected[7]!) < lines.indexOf('you> second prompt'));
  const withoutAny = formatReplay({ ...replayRecords([prompt, closing(16, 1), second, closing(18, 2)]), damage: undefined });
  const silentOnly = formatReplay({ ...replayRecords([prompt, ...silentOnes, ...unreadable, closing(16, 1), second, closing(18, 2)]), damage: undefined });
  assert('a session with only silent approvals renders byte-identically to one with no decision records',
    silentOnly === withoutAny && !withoutAny.includes('permission'));
  assert('a --turn replay shows only that turn\u2019s decisions',
    formatReplay({ ...replayRecords(session, { turn: 1 }), damage: undefined }).includes(expected[1]!) &&
    !formatReplay({ ...replayRecords(session, { turn: 2 }), damage: undefined }).includes('permission ·'));
  assert('replay counted nothing as dropped for the decision lines', replayRecords(session).droppedRecords === 0);
  assert('a silent outcome formats without the prompted marker; a long rule and a line break are bounded to one row',
    formatPermissionDecision({ turn: 1, toolUseId: 'x', toolName: 'bash', kind: 'execute', risk: 'dangerous', mode: 'default', source: 'parent', outcome: 'allow-rule', rule: 'bash:pnpm *', promptedUser: false })
      === 'permission · bash · approved by allow rule bash:pnpm *' &&
    (() => {
      const line = formatPermissionDecision({ turn: 1, toolUseId: 'x', toolName: 'bash', kind: 'execute', risk: 'dangerous', mode: 'default', source: 'parent', outcome: 'deny-rule', rule: `bash:${'y'.repeat(500)}\nmore`, promptedUser: false });
      return !line.includes('\n') && [...line].length < 260 && line.endsWith('…');
    })());

  // Runtime level: a real offline runtime, a prompted call, and the record's toolUseId
  // equal to the recorded beforeToolCallEvent's for the same call.
  const projectDir = path.join(ROOT, 'permission-runtime');
  await mkdir(projectDir, { recursive: true });
  let sessionId = '';
  // `true` is not on the safe-command list, so `default` mode prompts and the
  // allow-all bridge answers: the outcome is `user-approved`, `promptedUser` true.
  setRuntimeModelFactoryForTest(async () => new ScriptedModel('ran it', { name: 'bash', input: { mode: 'execute', command: 'true' } }));
  let runtime: AgentRuntime | undefined;
  try {
    runtime = await AgentRuntime.create({
      projectRoot: projectDir,
      session: { kind: 'new' },
      permissionBridge: allowAllBridge,
      onSessionResolved: (resolved) => { sessionId = resolved; },
    });
    const seen: AgentStreamEvent[] = [];
    for await (const event of runtime.send('run true')) seen.push(event);
    await runtime.shutdown();
    runtime = undefined;

    const recorded = await readTrajectory(trajectoryPath(projectDir, sessionId));
    const before = recorded.records.find((r) => r.type === 'beforeToolCallEvent');
    const beforeId = ((before as { data?: { toolUse?: { toolUseId?: unknown } } } | undefined)?.data?.toolUse?.toolUseId);
    const audits = recorded.records.filter((r): r is PermissionDecisionRecord => r.type === 'permissionDecision');
    assert('the real runtime recorded exactly one permissionDecision for its one tool call',
      audits.length === 1 && recorded.records.filter((r) => r.type === 'beforeToolCallEvent').length === 1);
    assert('its toolUseId equals the recorded beforeToolCallEvent\u2019s for the same call',
      typeof beforeId === 'string' && beforeId !== '' && audits[0]?.toolUseId === beforeId);
    assert('the runtime decision reads user-approved, prompted, parent, bash/execute/dangerous, mode default',
      audits[0]?.outcome === 'user-approved' && audits[0].promptedUser === true && audits[0].source === 'parent' &&
      audits[0].toolName === 'bash' && audits[0].kind === 'execute' && audits[0].risk === 'dangerous' && audits[0].mode === 'default');
    assert('the record sits in the turn the call belongs to', audits[0]?.turn === before?.turn);
    const modelVisible = JSON.stringify(seen.map((event) => (event as { toJSON?: () => unknown }).toJSON?.() ?? event));
    assert('nothing the model or driver saw mentions the audit — it is log-only',
      !modelVisible.includes('permissionDecision') && !modelVisible.includes('user-approved'));
    const realTranscript = formatReplay({ ...replayRecords(recorded.records), damage: undefined });
    assert('trajectory replay of the real session prints the one permission line',
      realTranscript.includes('  note permission · bash · approved by user'));
    // The gate runs inside the SDK's hook dispatch, before the stream yields the
    // `beforeToolCallEvent`, so the note lands just ahead of the tool row it judged.
    assert('the note precedes the tool row it belongs to, and the tool really ran',
      realTranscript.indexOf('note permission · bash') < realTranscript.indexOf('tool bash [') &&
      realTranscript.includes('tool bash [ok]'));
  } finally {
    await runtime?.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
}

async function rewindOriginRecords(): Promise<void> {
  header('trajectory — a /rewind successor\u2019s runStarted names its origin; every other header is byte-identical');

  const dir = path.join(ROOT, 'rewind-origin');
  await rm(dir, { recursive: true, force: true });
  const baseRun = {
    session: 'session-successor',
    agentId: AGENT_ID,
    darwinVersion: 'test',
    provider: 'bedrock',
    model: 'fake.trajectory',
    permissionMode: 'default',
    thinkingEffort: 'high',
    resumed: false,
    restoredMessages: 2,
  };
  // One header per recorder: an out-of-turn record is the cheapest way to make the
  // writer emit it without an Agent, exactly as `/compact` before any turn would.
  async function headerLine(name: string, extra: { rewindFrom?: unknown } = {}): Promise<string> {
    const file = path.join(dir, name, 'trajectory.jsonl');
    const rec = new TrajectoryRecorder({ file, run: { ...baseRun, ...extra } as RecorderRunInfo });
    rec.recordContextCompacted({ messagesBefore: 2, messagesAfter: 1, focused: false });
    await rec.close();
    const first = (await readFile(file, 'utf8')).split('\n')[0] ?? '';
    if (!first.includes('"type":"runStarted"')) throw new Error(`${name}: the first line is not the run header`);
    return first;
  }
  const withoutTimestamp = (line: string): string => line.replace(/"t":"[^"]*"/, '"t":"<t>"');
  const keysOf = (line: string): string => Object.keys(JSON.parse(line) as object).join(',');
  const BASE_KEYS = 'v,seq,t,turn,type,session,agentId,darwinVersion,provider,model,permissionMode,thinkingEffort,resumed,restoredMessages,pid';

  const origin = { session: 'session-source', snapshotId: 'snap-0123456789abcdef' };
  const plain = await headerLine('plain');
  const explicitlyAbsent = await headerLine('explicit-undefined', { rewindFrom: undefined });
  const rewound = await headerLine('rewound', { rewindFrom: origin });
  assert('a header written without the option has no rewindFrom key at all — its key set is today\u2019s',
    !plain.includes('rewindFrom') && keysOf(plain) === BASE_KEYS);
  assert('an option passed as undefined writes the same bytes as no option (timestamp aside)',
    withoutTimestamp(explicitlyAbsent) === withoutTimestamp(plain));
  assert('a successor header carries the origin as one nested object, before pid',
    rewound.includes('"restoredMessages":2,"rewindFrom":{"session":"session-source","snapshotId":"snap-0123456789abcdef"},"pid":') &&
    keysOf(rewound) === BASE_KEYS.replace('restoredMessages,pid', 'restoredMessages,rewindFrom,pid'));
  const parsedRewound = parseRecordLine(rewound) as RunStartedRecord;
  assert('the record round-trips writer → parser → validator',
    parsedRewound.type === 'runStarted' && parsedRewound.rewindFrom !== undefined &&
    JSON.stringify(rewindOriginOf(parsedRewound.rewindFrom)) === JSON.stringify(origin));
  assert('resumed/restoredMessages semantics are untouched: a successor is still resumed: false with its restored count',
    parsedRewound.resumed === false && parsedRewound.restoredMessages === 2);

  // Malformed origins are dropped whole at the writer; the rest of the header is intact.
  const malformed: Record<string, unknown> = {
    'empty-session': { session: '', snapshotId: 'snap' },
    'missing-snapshot': { session: 'session-source' },
    'oversize-snapshot': { session: 'session-source', snapshotId: 'x'.repeat(MAX_REWIND_ORIGIN_CHARS + 1) },
    'oversize-session': { session: 's'.repeat(MAX_REWIND_ORIGIN_CHARS + 1), snapshotId: 'snap' },
    'numeric-session': { session: 7, snapshotId: 'snap' },
    'string-origin': 'session-source/snap',
    'array-origin': ['session-source', 'snap'],
    'null-origin': null,
  };
  for (const [name, value] of Object.entries(malformed)) {
    const line = await headerLine(name, { rewindFrom: value });
    assert(`a malformed origin (${name}) is dropped and the header is otherwise today\u2019s bytes`,
      withoutTimestamp(line) === withoutTimestamp(plain));
  }
  const atCap = { session: '🙂'.repeat(MAX_REWIND_ORIGIN_CHARS), snapshotId: 's' };
  assert('the bound is counted in code points and inclusive: exactly the cap is accepted, one more is not',
    JSON.stringify(rewindOriginOf(atCap)) === JSON.stringify(atCap) &&
    rewindOriginOf({ ...atCap, session: '🙂'.repeat(MAX_REWIND_ORIGIN_CHARS + 1) }) === undefined);
  assert('the reader carries only the two ids, never a foreign field',
    JSON.stringify(rewindOriginOf({ ...origin, prompt: 'never recorded' })) === JSON.stringify(origin));
  assert('the reader rejects a half-valid pair whole rather than half-reading it',
    rewindOriginOf({ session: 'session-source', snapshotId: '' }) === undefined &&
    rewindOriginOf({ snapshotId: 'snap' }) === undefined && rewindOriginOf(undefined) === undefined);

  // Replay: the origin is a clause on the existing header line, never a new line.
  const at = '2026-09-05T01:43:47.068Z';
  const run = (fields: Record<string, unknown>): TrajectoryRecord =>
    ({ v: 1, seq: 0, t: at, turn: 0, type: 'runStarted', ...baseRun, pid: 1, ...fields }) as TrajectoryRecord;
  const body: TrajectoryRecord[] = [
    { v: 1, seq: 1, t: at, turn: 1, type: 'userInput', text: 'branched prompt' } as TrajectoryRecord,
    { v: 1, seq: 2, t: at, turn: 1, type: 'turnEnded', stopReason: 'endTurn', ms: 20, recorded: {}, dropped: {} } as TrajectoryRecord,
  ];
  const transcriptOf = (first: TrajectoryRecord): string[] =>
    formatReplay({ ...replayRecords([first, ...body]), damage: undefined }).split('\n');
  const plainHeader = `--- run ${at} · bedrock/fake.trajectory`;
  assert('a header without the field prints exactly as before',
    transcriptOf(run({}))[0] === plainHeader && transcriptOf(run({}))[1] === 'you> branched prompt');
  assert('a successor header prints the origin as one clause on the same line',
    transcriptOf(run({ rewindFrom: origin }))[0] === `${plainHeader} · rewound from session-source snapshot snap-0123456789abcdef` &&
    transcriptOf(run({ rewindFrom: origin }))[1] === 'you> branched prompt');
  assert('the clause follows ` · resumed` in the header\u2019s own style when both are set',
    transcriptOf(run({ resumed: true, rewindFrom: origin }))[0] === `${plainHeader} · resumed · rewound from session-source snapshot snap-0123456789abcdef`);
  assert('a hand-edited malformed origin prints as if absent — the reader and writer share one validator',
    transcriptOf(run({ rewindFrom: { session: 'session-source' } }))[0] === plainHeader &&
    transcriptOf(run({ rewindFrom: { session: 'session-source', snapshotId: 'x'.repeat(MAX_REWIND_ORIGIN_CHARS + 1) } }))[0] === plainHeader);
  assert('replayRecords exposes the origin on the run, and omits the key when absent',
    JSON.stringify(replayRecords([run({ rewindFrom: origin }), ...body]).runs[0]?.rewindFrom) === JSON.stringify(origin) &&
    !('rewindFrom' in (replayRecords([run({}), ...body]).runs[0] ?? {})));
  assert('a --turn replay keeps the origin on its header — runStarted is exempt from the turn filter',
    formatReplay({ ...replayRecords([run({ rewindFrom: origin }), ...body], { turn: 1 }), damage: undefined }).split('\n')[0]?.endsWith('snapshot snap-0123456789abcdef') === true);
  assert('the origin contributes no searchable text — ids are not words anyone searches the transcript for',
    searchableText(run({ rewindFrom: origin })).length === 0);
}

async function replayFidelity(): Promise<void> {
  header('trajectory — replay reconstructs the live history with no model call');

  const dir = path.join(ROOT, 'replay');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');

  const model = new ScriptedModel('the assistant reply', { name: 'echoTool', input: { note: 'marker-note' } });
  const agent = newAgent(model);
  await agent.initialize();
  const rec = recorder(file);

  // The live projection: exactly what the TUI does with the same events.
  let live = turnReducer(initialTurnState, { type: 'userInput', text: 'please echo marker-note' });
  for await (const event of recordStream(agent.stream('please echo marker-note'), rec.beginTurn('please echo marker-note'))) {
    live = turnReducer(live, { type: 'streamEvent', event });
  }
  live = turnReducer(live, { type: 'turnEnded' });
  await rec.close();

  const read = await readTrajectory(file);
  const replayed = replayRecords(read.records);

  assert(
    'replayed history equals the live history, item for item',
    JSON.stringify(historyWithoutIds(replayed.history)) === JSON.stringify(historyWithoutIds(live.history)),
  );
  assert('the assistant reply is reconstructed', replayed.history.some((item) => item.kind === 'assistant' && item.text === 'the assistant reply'));
  assert(
    'the tool row keeps its name, status and preview',
    replayed.history.some(
      (item) => item.kind === 'tool' && item.name === 'echoTool' && item.status === 'ok' && item.preview.includes('marker-note'),
    ),
  );
  assert('the run is described', replayed.runs.length === 1 && replayed.runs[0]?.model === 'bedrock/fake.trajectory');

  const again = replayRecords(read.records);
  assert(
    'replay is deterministic over the same bytes',
    JSON.stringify(historyWithoutIds(again.history)) === JSON.stringify(historyWithoutIds(replayed.history)),
  );

  const text = formatReplay({ ...replayed, damage: undefined });
  assert('the text transcript contains the user turn', text.includes('you> please echo marker-note'));
  assert('the text transcript contains the tool row', text.includes('tool echoTool [ok]'));

  // A per-turn view, and an honest answer for a turn the record does not have.
  const agent2 = newAgent(new ScriptedModel('second turn reply'));
  await agent2.initialize();
  await recordedTurn(agent2, rec, 'second question');
  await rec.close();
  const both = await readTrajectory(file);
  const turnTwo = replayRecords(both.records, { turn: 2 });
  assert('a single turn can be replayed alone', turnTwo.history.filter((item) => item.kind === 'user').length === 1);
  assert('the recorded turn list is reported', replayRecords(both.records).turns.join(',') === '1,2');

  // A record whose payload a cap removed is counted, never invented.
  const withDropped: TrajectoryRecord[] = [
    ...both.records,
    { v: 1, seq: 999, t: new Date().toISOString(), turn: 3, type: 'contentBlockEvent' } as TrajectoryRecord,
  ];
  const dropped = replayRecords(withDropped);
  assert('a payload-less record is counted, not guessed at', dropped.droppedRecords === 1);

  // No model call. Two halves, because either alone would be weak: structurally,
  // the read side constructs no agent and no model; functionally, a replay is
  // correct with the AWS environment sabotaged, so nothing it does can be reaching
  // a provider.
  const sources = await Promise.all(
    ['record.ts', 'reader.ts', 'replay.ts', 'search.ts', 'spend.ts', 'fork.ts', 'writer.ts', 'stream.ts', 'prompt-history.ts', 'export.ts', 'resume-recap.ts'].map(
      async (name) => ({ name, text: stripComments(await readFile(path.join('src', 'trajectory', name), 'utf8')) }),
    ),
  );
  const offending = sources.filter(
    ({ text }) =>
      /\bnew Agent\b|\bnew BedrockModel\b|\bnew OpenAIModel\b|\bnew AnthropicModel\b/.test(text) ||
      /createModelFromConfig|\.stream\(|\.invoke\(/.test(text) ||
      /from '\.\.\/agent\/runtime\.js'/.test(text) ||
      // SER-079: the permission record is spelled structurally; the gate stays out.
      /from '\.\.\/agent\/permission\.js'|from '\.\.\/hooks\//.test(text),
  );
  assert(
    'the read side constructs no agent or model, never invokes one, and imports no gate',
    offending.length === 0,
  );
  assert(
    'the scan really looked at code (the comments mentioning streams were stripped)',
    sources.some(({ name }) => name === 'stream.ts') &&
      !sources.find(({ name }) => name === 'stream.ts')!.text.includes('Agent.stream()'),
  );

  const savedEnv = { ...process.env };
  process.env['AWS_REGION'] = 'xx-nowhere-1';
  process.env['AWS_ENDPOINT_URL'] = 'http://127.0.0.1:1';
  process.env['AWS_ACCESS_KEY_ID'] = 'invalid';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'invalid';
  process.env['AWS_PROFILE'] = 'does-not-exist';
  try {
    const sabotaged = replayRecords((await readTrajectory(file)).records);
    assert(
      'replay is correct with no usable credentials, region or endpoint',
      JSON.stringify(historyWithoutIds(sabotaged.history)) ===
        JSON.stringify(historyWithoutIds(replayRecords(both.records).history)),
    );
  } finally {
    process.env = savedEnv;
  }
}

async function refusalReplay(): Promise<void> {
  header('trajectory — a refusal-class turn replays with one answer-slot line naming the stop reason');

  const dir = path.join(ROOT, 'refusal-replay');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');

  // SRF-029: the real recorder over a real Agent whose provider ends the turn with
  // Bedrock's `contentFiltered` after one visible character — the shape of session
  // `session-20260908-095403918`, whose replay read `darwin> 直` and nothing else.
  const filtered = newAgent(new ScriptedModel('直', undefined, undefined, 'contentFiltered'));
  await filtered.initialize();
  const rec = recorder(file);
  await recordedTurn(filtered, rec, '用户A是否有可能访问到用户B的文件？');
  await rec.close();

  const read = await readTrajectory(file);
  const resultRecord = read.records.find((record) => record.type === 'agentResultEvent') as unknown as {
    data: { result: { stopReason: string } };
  };
  assert('the record carries the SDK stop reason as it arrived', resultRecord.data.result.stopReason === 'contentFiltered');

  const replayed = replayRecords(read.records);
  const text = formatReplay({ ...replayed, damage: undefined });
  const lines = text.split('\n');
  const partial = lines.indexOf('darwin> 直');
  assert('the partial text the turn streamed is still there', partial > 0);
  assert(
    'the one refusal line follows it, in the answer slot, naming the reason actually received',
    lines[partial + 1] === 'darwin> (model declined this request — stop_reason: contentFiltered)',
  );
  assert('exactly one refusal line', lines.filter((line) => line.includes('model declined this request')).length === 1);
  assert('it never says refusal, the Anthropic word', !text.includes('stop_reason: refusal'));
  assert(
    'the model-call line still names the stop at the foot of the report',
    lines.some((line) => line.startsWith('  turn 1 model call') && line.includes('stop contentFiltered')),
  );
  assert(
    'the line is an assistant history item, not a note (the resume recap seeds it as one)',
    replayed.history.some((item) => item.kind === 'assistant' && item.text === '(model declined this request — stop_reason: contentFiltered)'),
  );

  // `/export` is `formatReplay(replayRead(...))` byte for byte, so it inherits the line
  // without a formatter of its own: prove it against the read result, not the records.
  const exported = formatReplay(replayRead(read));
  assert('the export projection carries the identical line', exported.split('\n')[partial + 1] === lines[partial + 1]);

  // The same line for a Guardrail stop and for the Anthropic word, each naming its own
  // reason — distinguishable by construction, from a synthetic record each.
  for (const stopReason of ['guardrailIntervened', 'refusal'] as const) {
    const synthetic = replayRecords([
      parseRecordLine('{"v":1,"seq":1,"t":"2026-09-08T10:00:01.000Z","turn":1,"type":"userInput","text":"q"}') as TrajectoryRecord,
      parseRecordLine(
        `{"v":1,"seq":2,"t":"2026-09-08T10:00:02.000Z","turn":1,"type":"agentResultEvent","data":{"result":{"stopReason":"${stopReason}"}}}`,
      ) as TrajectoryRecord,
      parseRecordLine(
        `{"v":1,"seq":3,"t":"2026-09-08T10:00:03.000Z","turn":1,"type":"turnEnded","stopReason":"${stopReason}","ms":5,"recorded":{"agentResultEvent":1},"dropped":{}}`,
      ) as TrajectoryRecord,
    ]);
    assert(
      `a ${stopReason} stop with no text at all replays as the user row and the one refusal line`,
      formatReplay({ ...synthetic, damage: undefined }).startsWith(
        `you> q\ndarwin> (model declined this request — stop_reason: ${stopReason})\n`,
      ),
    );
  }

  // An `endTurn` fixture is byte-identical to what replay printed before the line
  // existed: the transcript below is the pre-SRF-029 output for these records, pinned.
  const endTurnRecords = [
    '{"v":1,"seq":0,"t":"2026-09-08T10:00:00.000Z","turn":0,"type":"runStarted","session":"session-20260908-000000000","agentId":"darwin","darwinVersion":"0.0.1","provider":"bedrock","model":"fake.trajectory","permissionMode":"default","thinkingEffort":"high","resumed":false,"restoredMessages":0,"pid":1}',
    '{"v":1,"seq":1,"t":"2026-09-08T10:00:01.000Z","turn":1,"type":"userInput","text":"an ordinary question"}',
    '{"v":1,"seq":2,"t":"2026-09-08T10:00:02.000Z","turn":1,"type":"contentBlockEvent","data":{"contentBlock":{"text":"an ordinary answer"}}}',
    '{"v":1,"seq":3,"t":"2026-09-08T10:00:03.000Z","turn":1,"type":"agentResultEvent","data":{"result":{"stopReason":"endTurn"}}}',
    '{"v":1,"seq":4,"t":"2026-09-08T10:00:04.000Z","turn":1,"type":"turnEnded","stopReason":"endTurn","ms":900,"recorded":{"contentBlockEvent":1,"agentResultEvent":1},"dropped":{}}',
  ].map((line) => parseRecordLine(line) as TrajectoryRecord);
  const endTurn = formatReplay({ ...replayRecords(endTurnRecords), damage: undefined });
  assert(
    'an endTurn turn replays byte-identically to before the refusal line existed',
    endTurn ===
      [
        '--- run 2026-09-08T10:00:00.000Z · bedrock/fake.trajectory',
        'you> an ordinary question',
        'darwin> an ordinary answer',
        '  turn 1 spend: unknown (not recorded)',
        '  session spend: unknown over 1 turn(s)',
      ].join('\n'),
  );
  // And a `maxTokens` stop — the model finishing on its own terms — earns no line either.
  const maxTokens = formatReplay({
    ...replayRecords(
      endTurnRecords.map((record) =>
        record.type === 'agentResultEvent'
          ? (parseRecordLine(
              '{"v":1,"seq":3,"t":"2026-09-08T10:00:03.000Z","turn":1,"type":"agentResultEvent","data":{"result":{"stopReason":"maxTokens"}}}',
            ) as TrajectoryRecord)
          : record,
      ),
    ),
    damage: undefined,
  });
  assert('a maxTokens stop is not a refusal and adds nothing', !maxTokens.includes('declined') && maxTokens === endTurn);
}

async function searchContracts(): Promise<void> {
  header('trajectory — search finds a known event and reports a miss honestly');

  const paths = sessionPaths(ROOT);
  await rm(paths.sessionsDir, { recursive: true, force: true });

  const sessionId = 'session-20260816-000001';
  const rec = recorder(trajectoryPath(ROOT, sessionId));
  const agent = newAgent(new ScriptedModel('the needle is here', { name: 'echoTool', input: { note: 'needle-in-tool-input' } }));
  await agent.initialize();
  await recordedTurn(agent, rec, 'look for the needle');
  await rec.close();

  const byAssistant = await searchTrajectories(ROOT, 'needle is here', AGENT_ID);
  assert('a known assistant phrase is found', byAssistant.hitCount >= 1);
  assert(
    'the hit names its session, sequence and record type',
    byAssistant.sessions[0]?.hits[0]?.sessionId === sessionId &&
      typeof byAssistant.sessions[0]?.hits[0]?.seq === 'number' &&
      byAssistant.sessions[0]?.hits[0]?.type !== undefined,
  );
  assert('the excerpt contains the match', (byAssistant.sessions[0]?.hits[0]?.excerpt ?? '').includes('needle'));

  const byToolInput = await searchTrajectories(ROOT, 'NEEDLE-IN-TOOL-INPUT', AGENT_ID);
  assert('matching is case-insensitive and covers tool input', byToolInput.hitCount >= 1);
  assert(
    'a type filter narrows to one kind of record',
    (await searchTrajectories(ROOT, 'needle', AGENT_ID, { type: 'beforeToolCallEvent' })).sessions
      .flatMap((session) => session.hits)
      .every((hit) => hit.type === 'beforeToolCallEvent'),
  );
  assert(
    'a limit bounds the reported hits',
    (await searchTrajectories(ROOT, 'needle', AGENT_ID, { limit: 1 })).hitCount === 1,
  );

  const noMatch = await searchTrajectories(ROOT, 'no-such-text-anywhere', AGENT_ID);
  assert('zero matches is an empty result, not an error', noMatch.hitCount === 0);

  // A session with a snapshot but no record: named, not reported as "no matches".
  const recorded = 'session-20260816-000002';
  await mkdir(path.dirname(snapshotPath(ROOT, recorded, AGENT_ID)), { recursive: true });
  await writeFile(snapshotPath(ROOT, recorded, AGENT_ID), '{}', 'utf8');
  const mixed = await searchTrajectories(ROOT, 'needle', AGENT_ID);
  assert('a session with no record is named rather than counted as empty', mixed.withoutRecord.includes(recorded));

  let unknown = false;
  try {
    await searchTrajectories(ROOT, 'needle', AGENT_ID, { sessionId: 'session-does-not-exist' });
  } catch (error) {
    unknown = error instanceof UnknownSessionError;
  }
  assert('an unknown session id is refused rather than searched as empty', unknown);

  const ids = await listSessionIds(ROOT);
  assert('session listing finds both sessions, newest first', ids[0] === recorded && ids.includes(sessionId));
}

async function forkContracts(): Promise<void> {
  header('trajectory — fork copies a session and leaves the source untouched');

  const paths = sessionPaths(ROOT);
  await rm(paths.sessionsDir, { recursive: true, force: true });

  // A real session: a real SessionManager snapshot plus a real trajectory.
  const sourceId = 'session-20260816-100000';
  const storage = new LocalFileStorage(paths.sessionsDir);
  const source = new Agent({
    id: AGENT_ID,
    model: new ScriptedModel('remember the passphrase moonlight'),
    systemPrompt: 'fork test',
    tools: [echo],
    sessionManager: new SessionManager({ sessionId: sourceId, storage, saveLatestOn: 'invocation' }),
    printer: false,
  });
  await source.initialize();
  const rec = recorder(trajectoryPath(ROOT, sourceId));
  await recordedTurn(source, rec, 'what is the passphrase?');
  await rec.close();

  // An offload directory, so the copy-or-fail rule is exercised.
  const offload = path.join(paths.sessionsDir, sourceId, 'offload');
  await mkdir(offload, { recursive: true });
  await writeFile(path.join(offload, 'ref-1.json'), '{"offloaded":true}', 'utf8');
  // And a background log, which must NOT be copied.
  const background = path.join(paths.sessionsDir, sourceId, 'background');
  await mkdir(background, { recursive: true });
  await writeFile(path.join(background, 'task.log'), 'not copied', 'utf8');

  const snapshotBefore = sha256(await readFile(snapshotPath(ROOT, sourceId, AGENT_ID)));
  const trajectoryBefore = await readFile(trajectoryPath(ROOT, sourceId));
  const pointerBefore = await readFile(paths.pointerFile).catch(() => Buffer.from(''));

  const forked = await forkSession(ROOT, sourceId, AGENT_ID);

  assert('the fork has a fresh, valid session id', forked.sessionId !== sourceId && isValidSessionId(forked.sessionId));
  assert(
    'the source snapshot is byte-identical after the fork',
    sha256(await readFile(snapshotPath(ROOT, sourceId, AGENT_ID))) === snapshotBefore,
  );
  assert(
    'the source trajectory is byte-identical after the fork',
    sha256(await readFile(trajectoryPath(ROOT, sourceId))) === sha256(trajectoryBefore),
  );
  assert(
    'the fork\u2019s snapshot is a verbatim copy',
    sha256(await readFile(snapshotPath(ROOT, forked.sessionId, AGENT_ID))) === snapshotBefore,
  );
  assert(
    'offload files are carried over',
    (await readFile(path.join(paths.sessionsDir, forked.sessionId, 'offload', 'ref-1.json'), 'utf8')).includes('offloaded'),
  );
  assert(
    'background logs are not carried over',
    !(await exists(path.join(paths.sessionsDir, forked.sessionId, 'background'))),
  );
  assert(
    'the resume pointer is untouched',
    sha256(await readFile(paths.pointerFile).catch(() => Buffer.from(''))) === sha256(pointerBefore),
  );

  const forkRead = await readTrajectory(trajectoryPath(ROOT, forked.sessionId));
  const forkBytes = await readFile(trajectoryPath(ROOT, forked.sessionId));
  assert(
    'the fork\u2019s record begins with the source\u2019s bytes',
    sha256(forkBytes.subarray(0, trajectoryBefore.byteLength)) === sha256(trajectoryBefore),
  );
  const marker = forkRead.records.find((record) => record.type === 'forkedFrom') as
    | (TrajectoryRecord & { session: string; sourceSeq: number })
    | undefined;
  assert('the fork marker names its source', marker?.session === sourceId);
  assert('the fork marker records where the copy ended', (marker?.sourceSeq ?? -1) >= 0);
  assert(
    'the source record has no fork marker',
    !(await readTrajectory(trajectoryPath(ROOT, sourceId))).records.some((r) => r.type === 'forkedFrom'),
  );

  // Usable: darwin's own strict selector resolves it, and a fresh Agent restores it.
  const resolved = await resolveSession(ROOT, { kind: 'id', sessionId: forked.sessionId }, AGENT_ID);
  assert('the fork resolves as an existing session', resolved.sessionId === forked.sessionId && resolved.restoreRequested);

  const restored = new Agent({
    id: AGENT_ID,
    model: new ScriptedModel('continuing'),
    systemPrompt: 'ignored on restore',
    tools: [echo],
    sessionManager: new SessionManager({ sessionId: forked.sessionId, storage, saveLatestOn: 'invocation' }),
    printer: false,
  });
  await restored.initialize();
  assert('the fork restores the source conversation', restored.messages.length === source.messages.length);
  assert(
    'the restored conversation still contains the source\u2019s content',
    JSON.stringify(restored.messages).includes('passphrase'),
  );

  // Continuing the fork appends to the fork only.
  const forkRec = recorder(trajectoryPath(ROOT, forked.sessionId));
  await recordedTurn(restored, forkRec, 'a turn in the fork');
  await forkRec.close();
  assert(
    'the source record is still untouched after the fork is used',
    sha256(await readFile(trajectoryPath(ROOT, sourceId))) === sha256(trajectoryBefore),
  );
  const afterUse = await readTrajectory(trajectoryPath(ROOT, forked.sessionId));
  assert('the fork\u2019s own turn is appended after the marker', count(afterUse.records, 'userInput') === 2);
  assert('the fork record stays readable', afterUse.unreadableLines === 0 && !afterUse.partialTrailingLine);
  assert(
    'the fork continues the source\u2019s sequence numbering',
    (afterUse.records.at(-1)?.seq ?? 0) > (marker?.seq ?? 0),
  );

  // A source that cannot be restored is refused before anything is created.
  let refused = '';
  try {
    await forkSession(ROOT, 'session-20260816-999999', AGENT_ID);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  assert('forking a session with no snapshot is refused', refused.includes('no restorable snapshot'));
}

async function childIsolation(): Promise<void> {
  header('trajectory — subagent transcripts never enter the record');

  const dir = path.join(ROOT, 'child');
  await rm(dir, { recursive: true, force: true });
  const file = path.join(dir, 'trajectory.jsonl');

  const registry = await loadAgentDefinitions(path.join(dir, 'project'), ['echoTool']);
  const childConfig = {
    provider: 'bedrock',
    model: 'fake.child',
    maxTokens: 1000,
    permissionMode: 'yolo',
    promptCache: false,
    thinkingEffort: 'high',
    summaryRatio: 0.8,
    contextWarnRatio: 0.8,
    contextOffload: true,
    preserveRecentMessages: 4,
    modelChoices: [],
  } as never;

  /**
   * The child does real internal work: a tool call carrying a marker, and a
   * reasoning block, neither of which appears in the report it returns. If child
   * events reached the record by any path, that marker is how it would show.
   */
  const runDelegation = async (rec: TrajectoryRecorder | undefined): Promise<Agent> => {
    const gate = new PermissionGate({ mode: 'yolo', projectRoot: dir, ask: async () => ({ allowed: true }) });
    const subagents = new SubagentTool({
      registry,
      tools: [echo],
      intervention: gate,
      projectInstructions: undefined,
      config: childConfig,
      createModel: async () =>
        new ScriptedModel(
          'summary: done',
          { name: 'echoTool', input: { note: 'CHILD-ONLY-MARKER' } },
          'CHILD-PRIVATE-THOUGHT',
        ),
    });
    const parent = new Agent({
      id: AGENT_ID,
      model: new ScriptedModel('parent done', { name: 'subagent', input: { task: 'delegate this' } }),
      systemPrompt: 'child isolation test',
      tools: [subagents.tool],
      printer: false,
    });
    await parent.initialize();
    await recordedTurn(parent, rec, 'delegate some work');
    await rec?.close();
    await subagents.shutdown();
    return parent;
  };

  const rec = recorder(file);
  const recorded = await runDelegation(rec);
  const unrecorded = await runDelegation(undefined);

  const raw = await readFile(file, 'utf8');
  const read = await readTrajectory(file);

  assert(
    'the parent\u2019s own delegation call is recorded',
    read.records.some((r) => r.type === 'beforeToolCallEvent' && JSON.stringify(r).includes('subagent')),
  );
  assert(
    'the child\u2019s returned report is recorded (it is already parent context)',
    raw.includes('summary: done'),
  );
  assert('a child tool call never reaches the record', !raw.includes('CHILD-ONLY-MARKER'));
  // Measured, and not a trajectory bug: `SubagentTool` returns `AgentResult.toString()`,
  // which renders a child's reasoning as "💭 Reasoning:" text, so a child's thinking
  // already enters the *parent conversation* today, independently of recording. The
  // rule the record must keep is therefore the exact one: it contains what parent
  // context contains, and nothing more. Darwin's own model reasoning is still
  // stripped (asserted in the caps section); a child's arrives as ordinary tool
  // result text and is recorded as such.
  assert(
    'the record contains a child\u2019s reasoning only where parent context already does',
    raw.includes('CHILD-PRIVATE-THOUGHT') === stableMessages(recorded).includes('CHILD-PRIVATE-THOUGHT'),
  );
  assert(
    'that pathway is the tool result, not a recorded child event',
    read.records.filter((r) => JSON.stringify(r).includes('CHILD-PRIVATE-THOUGHT')).every(
      (r) => r.type === 'afterToolCallEvent' || r.type === 'contentBlockEvent' || r.type === 'agentResultEvent',
    ),
  );
  assert(
    'the record holds exactly one turn — the parent\u2019s',
    count(read.records, 'userInput') === 1 &&
      count(read.records, 'turnEnded') === 1 &&
      count(read.records, 'runStarted') === 1,
  );
  assert(
    'no record was attributed to a child turn',
    read.records.every((record) => record.turn <= 1),
  );
  assert(
    'the recorded and unrecorded parent conversations are identical',
    stableMessages(recorded) === stableMessages(unrecorded),
  );
  assert(
    'the parent conversation carries only the child\u2019s report',
    stableMessages(recorded).includes('summary: done') && !stableMessages(recorded).includes('CHILD-ONLY-MARKER'),
  );
}

async function runtimeInputBarrier(): Promise<void> {
  header('trajectory — runtime makes current input durable before invocation');

  const dir = path.join(ROOT, 'runtime-barrier');
  await mkdir(dir, { recursive: true });
  let sessionId = '';
  const current = 'current input visible at invocation';
  const model = new InspectingModel('', current);
  setRuntimeModelFactoryForTest(async () => model);
  let runtime: AgentRuntime | undefined;
  try {
    runtime = await AgentRuntime.create({
      projectRoot: dir,
      session: { kind: 'new' },
      permissionBridge: allowAllBridge,
      onSessionResolved: (resolved) => {
        sessionId = resolved;
      },
    });
    const file = trajectoryPath(dir, sessionId);
    model.file = file;

    for await (const _event of runtime.send('prior input')) {
      // Drain the real runtime turn.
    }
    await runtime.shutdown();
    runtime = undefined;
    const prefix = await readFile(file);

    model.expectedInput = current;
    model.invoked = false;
    model.seenInput = false;
    runtime = await AgentRuntime.create({
      projectRoot: dir,
      session: { kind: 'id', sessionId },
      permissionBridge: allowAllBridge,
    });
    for await (const _event of runtime.send(current)) {
      // The model performs the concurrent offline read at invocation.
    }
    assert('the real AgentRuntime invokes the scripted offline model', model.invoked);
    assert('the invocation-time offline read sees the current userInput', model.seenInput);
    await runtime.shutdown();
    runtime = undefined;

    const complete = await readFile(file);
    assert(
      'the earlier trajectory prefix remains byte-identical',
      complete.subarray(0, prefix.length).equals(prefix),
    );
    const read = await readTrajectory(file);
    assert(
      'split input/event appends retain contiguous sequence numbers',
      read.records.every((record, index) => record.seq === index),
    );
    const currentTurn = read.records.find(
      (record) => record.type === 'userInput' && record.text === current,
    )?.turn;
    assert(
      'the completed current turn still has ordinary records',
      currentTurn !== undefined &&
        read.records.some((record) => record.turn === currentTurn && record.type === 'turnEnded'),
    );
    // SRF-031 through the production seam: `AgentRuntime.create()` awaited the
    // recorder's `open()`, so the resumed process's first prompt — numbered before
    // its own first append flushed — continues the file's turns instead of
    // restarting at 1, and the resumed header keeps turn 0.
    assert('the resumed runtime\u2019s first turn is numbered max + 1 (turn 2), not 1', currentTurn === 2);
    const resumedHeader = read.records.find((record) => record.type === 'runStarted' && record.seq > 0);
    assert(
      'the resumed run header carries turn 0 and says resumed',
      resumedHeader?.turn === 0 && (resumedHeader as { resumed?: unknown }).resumed === true,
    );
    assert('the two turns of the two runs carry distinct ordinals', new Set(read.records.filter((r) => r.type === 'userInput').map((r) => r.turn)).size === 2);
  } finally {
    await runtime?.shutdown();
    setRuntimeModelFactoryForTest(undefined);
    setRuntimeRecorderOverridesForTest(undefined);
  }
}

async function runtimeInputBarrierDegradation(): Promise<void> {
  header('trajectory — input barrier failure and timeout cannot prevent invocation');

  const invokeThrough = async (
    name: string,
    openFileImpl: unknown,
  ): Promise<{ invoked: boolean; problem: string | undefined; elapsed: number }> => {
    const dir = path.join(ROOT, `runtime-${name}`);
    await mkdir(dir, { recursive: true });
    const model = new ScriptedModel(`answer after ${name}`);
    setRuntimeModelFactoryForTest(async () => model);
    setRuntimeRecorderOverridesForTest({
      openFile: openFileImpl as never,
      inputDurabilityTimeoutMs: 20,
    });
    const runtime = await AgentRuntime.create({
      projectRoot: dir,
      session: { kind: 'new' },
      permissionBridge: allowAllBridge,
    });
    let invoked = false;
    const original = model.stream.bind(model);
    model.stream = async function* (...args: Parameters<ScriptedModel['stream']>) {
      invoked = true;
      yield* original(...args);
    };
    const started = Date.now();
    try {
      for await (const _event of runtime.send(`input for ${name}`)) {
        // Drain the real runtime turn.
      }
      await runtime.shutdown();
      return {
        invoked,
        problem: runtime.trajectoryStatus?.problem,
        elapsed: Date.now() - started,
      };
    } finally {
      setRuntimeModelFactoryForTest(undefined);
      setRuntimeRecorderOverridesForTest(undefined);
    }
  };

  const failed = await invokeThrough(
    'write-failure',
    () => Promise.reject(new Error('EACCES: barrier write refused')),
  );
  assert('a barrier write failure still allows model invocation', failed.invoked);
  assert('the barrier write failure is visible in trajectory status', failed.problem?.includes('EACCES') === true);

  const timedOut = await invokeThrough('timeout', () => new Promise(() => undefined));
  assert('a bounded barrier timeout still allows model invocation', timedOut.invoked);
  assert('the timeout is visible in trajectory status', timedOut.problem?.includes('timed out') === true);
  assert('timeout also bounds runtime shutdown', timedOut.elapsed < 1000);
}

/**
 * A parent's messages with the SDK's random tracking ids removed, so two runs of
 * the same scripted conversation are comparable.
 */
function stableMessages(agent: Agent): string {
  return JSON.stringify(agent.messages).replace(/"trackingId":"[^"]*"/g, '"trackingId":"·"');
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function count(records: readonly TrajectoryRecord[], type: string): number {
  return records.filter((record) => record.type === type).length;
}

/**
 * Removes block and line comments so a source scan asserts something about code.
 *
 * Needed because these modules *document* the streams they deliberately do not
 * touch, and a scan that matched prose would have failed on an accurate comment —
 * which is the sort of test that gets "fixed" by deleting the explanation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function cliContracts(): Promise<void> {
  header('trajectory — the subcommand surface');

  assert('the subcommand is recognised only in first position', isTrajectoryInvocation(['trajectory', 'list']));
  assert('an ordinary run is not a trajectory invocation', !isTrajectoryInvocation(['-p', 'hi', 'trajectory']));

  assert('list parses', parseTrajectoryArgs(['list']).verb === 'list');
  const search = parseTrajectoryArgs(['search', 'needle', '--session', 'session-a', '--limit', '5']);
  assert(
    'search parses its query and flags',
    search.verb === 'search' && search.query === 'needle' && search.sessionId === 'session-a' && search.limit === 5,
  );
  const replayCommand = parseTrajectoryArgs(['replay', 'session-a', '--turn', '2', '--json']);
  assert(
    'replay parses its session, turn and json flag',
    replayCommand.verb === 'replay' && replayCommand.turn === 2 && replayCommand.json,
  );
  assert('fork parses one id', parseTrajectoryArgs(['fork', 'session-a']).verb === 'fork');

  // Every one of these must be a usage error, not a silently different operation.
  for (const argv of [
    [] as string[],
    ['bogus'],
    ['list', 'extra'],
    ['search'],
    ['search', '--session', 'session-a'],
    ['search', 'needle', '--sesion', 'x'],
    ['search', 'needle', '--limit', 'many'],
    ['search', 'needle', '--limit', '0'],
    ['replay'],
    ['replay', 'UPPER'],
    ['replay', 'session-a', '--turn'],
    ['fork'],
    ['fork', 'session-a', 'session-b'],
  ]) {
    let usage = false;
    try {
      parseTrajectoryArgs(argv);
    } catch (error) {
      usage = error instanceof CliUsageError;
    }
    assert(`\`${argv.join(' ') || '(nothing)'}\` is a usage error`, usage);
  }

  // And the interactive `--session` pairing the fork needs, without weakening the rest.
  assert(
    '--session is accepted for the TUI so a fork can be opened',
    parseCliArgs(['--session', 'session-forked']).session.kind === 'id',
  );
  assert(
    '--session still works headlessly',
    parseCliArgs(['-p', 'hi', '--session', 'session-forked']).session.kind === 'id',
  );
  for (const argv of [['--continue'], ['--session'], ['--session', 'UPPER'], ['bare']]) {
    let usage = false;
    try {
      parseCliArgs(argv);
    } catch (error) {
      usage = error instanceof CliUsageError;
    }
    assert(`\`${argv.join(' ')}\` remains a usage error`, usage);
  }

  // The verbs, run against a real recorded project through the same entry point the
  // CLI uses, so exit codes are asserted rather than assumed.
  const paths = sessionPaths(ROOT);
  await rm(paths.sessionsDir, { recursive: true, force: true });
  const sessionId = 'session-20260816-200000';
  const storage = new LocalFileStorage(paths.sessionsDir);
  const agent = new Agent({
    id: AGENT_ID,
    model: new ScriptedModel('cli answer with cli-needle'),
    systemPrompt: 'cli test',
    tools: [echo],
    sessionManager: new SessionManager({ sessionId, storage, saveLatestOn: 'invocation' }),
    printer: false,
  });
  await agent.initialize();
  const rec = recorder(trajectoryPath(ROOT, sessionId));
  await recordedTurn(agent, rec, 'ask the cli question');
  await rec.close();

  const run = async (command: Parameters<typeof runTrajectoryCommand>[0]) => runTrajectory(command);

  const listed = await run({ verb: 'list' });
  assert('list exits 0 and names the session', listed.code === 0 && listed.out.includes(sessionId));
  assert('list reports record and turn counts', /\d+ record\(s\), \d+ turn\(s\)/.test(listed.out));

  const hit = await run({ verb: 'search', query: 'cli-needle' });
  assert('a search hit exits 0 and prints the match', hit.code === 0 && hit.out.includes('cli-needle'));
  const miss = await run({ verb: 'search', query: 'not-in-any-record' });
  assert('zero matches exits 0 with an explicit line', miss.code === 0 && miss.out.includes('no matches'));
  // Two different honest answers, both exit 1: a session darwin has never heard of,
  // and a session that exists but was never recorded.
  const unknownSession = await run({ verb: 'search', query: 'x', sessionId: 'session-20260816-999999' });
  assert(
    'searching an unknown session exits 1 and says it does not exist',
    unknownSession.code === 1 && unknownSession.err.includes('does not exist in this project'),
  );

  const snapshotOnly = 'session-20260816-210000';
  await mkdir(path.dirname(snapshotPath(ROOT, snapshotOnly, AGENT_ID)), { recursive: true });
  await writeFile(snapshotPath(ROOT, snapshotOnly, AGENT_ID), '{}', 'utf8');
  const unrecordedSession = await run({ verb: 'search', query: 'x', sessionId: snapshotOnly });
  assert(
    'searching a real but unrecorded session exits 1 and names the missing record',
    unrecordedSession.code === 1 && unrecordedSession.err.includes('no trajectory recorded'),
  );
  const listedMixed = await run({ verb: 'list' });
  assert(
    'list distinguishes a snapshot-only session from a recorded one',
    listedMixed.out.includes('no trajectory recorded (snapshot only)'),
  );

  const replayed = await run({ verb: 'replay', sessionId, json: false });
  assert('replay exits 0 and prints the transcript', replayed.code === 0 && replayed.out.includes('you> ask the cli question'));
  const asJson = await run({ verb: 'replay', sessionId, json: true });
  assert(
    'replay --json prints parseable history',
    asJson.code === 0 && Array.isArray(JSON.parse(asJson.out)) && JSON.parse(asJson.out).length > 0,
  );
  const badTurn = await run({ verb: 'replay', sessionId, turn: 9, json: false });
  assert('replaying a turn the record lacks exits 1', badTurn.code === 1 && badTurn.err.includes('no turn 9'));
  const noRecord = await run({ verb: 'replay', sessionId: 'session-20260816-999999', json: false });
  assert('replaying an unrecorded session exits 1', noRecord.code === 1);

  const forkRun = await run({ verb: 'fork', sessionId });
  assert('fork exits 0', forkRun.code === 0);
  const newId = forkRun.out.trim();
  assert('fork prints only the new id on stdout', isValidSessionId(newId) && !forkRun.out.includes('forked'));
  assert('fork explains itself on stderr', forkRun.err.includes('forked') && forkRun.err.includes('--session'));
  assert('the forked session is replayable', (await run({ verb: 'replay', sessionId: newId, json: false })).code === 0);
  const forkMissing = await run({ verb: 'fork', sessionId: 'session-20260816-999999' });
  assert('forking a nonexistent session exits 1', forkMissing.code === 1 && forkMissing.err.startsWith('error:'));
}

async function main(): Promise<void> {
  assert(
    'session state resolves inside this suite\u2019s own HOME',
    sessionPaths(ROOT).sessionsDir.startsWith(`${OWNED_HOME}${path.sep}`),
  );
  assert(
    'a record line parses back to the record it encoded',
    parseRecordLine('{"v":1,"seq":0,"t":"now","turn":1,"type":"userInput","text":"x"}')?.type === 'userInput',
  );
  assert('a damaged line is refused rather than half-parsed', parseRecordLine('{"v":1,"seq"') === undefined);
  assert('a line without a type is not a record', parseRecordLine('{"v":1,"seq":0}') === undefined);

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  try {
    await appendOnly();
    await resumedTurnNumbers();
    await runtimeInputBarrier();
    await runtimeInputBarrierDegradation();
    await damageTolerance();
    await caps();
    await degradation();
    await passThrough();
    await failedTurn();
    await failedTurnReadPaths();
    await turnSpend();
    await turnSpendReadPaths();
    await modelCallRecords();
    await contextCompactedRecords();
    await permissionDecisionRecords();
    await rewindOriginRecords();
    await replayFidelity();
    await refusalReplay();
    await searchContracts();
    await forkContracts();
    await childIsolation();
    await cliContracts();
  } finally {
    await rm(ROOT, { recursive: true, force: true });
  }
  report();
}

await main();
