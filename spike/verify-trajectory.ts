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

import { PermissionGate } from '../src/agent/permission.js';
import { startTurnSpend, type UsageTotals } from '../src/agent/usage.js';
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
  failureFromError,
  formatTurnFailure,
  parseRecordLine,
  turnFailureOf,
  turnOutcome,
  turnSpendOf,
  type TrajectoryRecord,
  type TurnEndedRecord,
  type TurnSpendMeter,
} from '../src/trajectory/record.js';
import { formatReplay, historyWithoutIds, replayRecords } from '../src/trajectory/replay.js';
import {
  MAX_MODEL_LABEL_CHARS,
  formatSpendSummary,
  summarizeSpend,
} from '../src/trajectory/spend.js';
import { searchTrajectories, UnknownSessionError } from '../src/trajectory/search.js';
import { recordStream } from '../src/trajectory/stream.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
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
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < text.length; index += 7) out.push(text.slice(index, index + 7));
  return out;
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
  options: { stopAfter?: number; spend?: TurnSpendMeter } = {},
): Promise<AgentStreamEvent[]> {
  const seen: AgentStreamEvent[] = [];
  for await (const event of recordStream(agent.stream(input), rec?.beginTurn(input, options.spend))) {
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
  // because a restart would make a real gap indistinguishable from a new run.
  const second = recorder(file);
  const agent3 = newAgent(new ScriptedModel('third answer'));
  await agent3.initialize();
  await recordedTurn(agent3, second, 'turn three');
  await second.close();

  const reread = await readTrajectory(file);
  assert(
    'a later process continues the sequence instead of restarting it',
    reread.records.map((r) => r.seq).every((seq, index) => seq === index),
  );
  assert('the later process wrote its own run header', count(reread.records, 'runStarted') === 2);
  assert('the earlier prefix is still byte-identical', sha256((await readFile(file)).subarray(0, afterSecond.byteLength)) === sha256(afterSecond));
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
    ['record.ts', 'reader.ts', 'replay.ts', 'search.ts', 'spend.ts', 'fork.ts', 'writer.ts', 'stream.ts'].map(
      async (name) => ({ name, text: stripComments(await readFile(path.join('src', 'trajectory', name), 'utf8')) }),
    ),
  );
  const offending = sources.filter(
    ({ text }) =>
      /\bnew Agent\b|\bnew BedrockModel\b|\bnew OpenAIModel\b|\bnew AnthropicModel\b/.test(text) ||
      /createModelFromConfig|\.stream\(|\.invoke\(/.test(text) ||
      /from '\.\.\/agent\/runtime\.js'/.test(text),
  );
  assert(
    'the read side constructs no agent or model and never invokes one',
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
    await damageTolerance();
    await caps();
    await degradation();
    await passThrough();
    await failedTurn();
    await failedTurnReadPaths();
    await turnSpend();
    await turnSpendReadPaths();
    await replayFidelity();
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
