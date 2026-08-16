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
  SessionManager,
  tool,
  type BaseModelConfig,
  type AgentStreamEvent,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import { LocalFileStorage } from '@strands-agents/sdk/storage';
import { z } from 'zod';

import { PermissionGate } from '../src/agent/permission.js';
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
  MAX_FIELD_CHARS,
  MAX_RECORD_BYTES,
  parseRecordLine,
  type TrajectoryRecord,
} from '../src/trajectory/record.js';
import { formatReplay, historyWithoutIds, replayRecords } from '../src/trajectory/replay.js';
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
  options: { stopAfter?: number } = {},
): Promise<AgentStreamEvent[]> {
  const seen: AgentStreamEvent[] = [];
  for await (const event of recordStream(agent.stream(input), rec?.beginTurn(input))) {
    seen.push(event);
    if (options.stopAfter !== undefined && seen.length >= options.stopAfter) break;
  }
  return seen;
}

function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex');
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
    ['record.ts', 'reader.ts', 'replay.ts', 'search.ts', 'fork.ts', 'writer.ts', 'stream.ts'].map(
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

  const run = async (command: Parameters<typeof runTrajectoryCommand>[0]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runTrajectoryCommand(command, {
      projectRoot: ROOT,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join(''), err: err.join('') };
  };

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
