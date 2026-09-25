/**
 * The `/model` command: how an argument resolves to a configured model, and what
 * a live switch does to the session.
 *
 * Split in two on purpose. Resolution is pure, so it is exhaustive and free. The
 * switch is not: it replaces the model object on a live `Agent`, which is the part
 * that can only be proven by doing it — so that half makes real model calls and
 * asserts the conversation survived a change of provider. The offline half also
 * drives `changeModel` on a real runtime with a scripted model factory, to prove the
 * SRF-038 `modelChanged` trajectory record (once per success, never on failure).
 *
 * Run: pnpm tsx spike/verify-model-command.ts            (resolution only)
 *      pnpm tsx spike/verify-model-command.ts --live     (plus real model calls)
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  CachePointBlock,
  Model,
  TextBlock,
  type Agent,
  type BaseModelConfig,
  type Message,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { configPath, loadConfig, type ModelChoice } from '../src/config.js';
import { resolveModelChoice } from '../src/tui/App.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import {
  modelChangedOf,
  type ModelCallRecord,
  type ModelChangedRecord,
  type RunStartedRecord,
  type TurnEndedRecord,
} from '../src/trajectory/record.js';
import { formatReplay, replayRead } from '../src/trajectory/replay.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

// The fixture and the persisted-switch assertions both go through configPath(),
// which resolves under HOME rather than under the temp project root.
const OWNED_HOME = ownPrivateHome('model-command');

/** A catalogue shaped like a real one, without touching the filesystem. */
function choice(index: number, name: string, model: string, enabled = false): ModelChoice {
  return {
    index,
    name,
    enabled,
    fields: {
      provider: 'bedrock',
      model,
      maxTokens: 8192,
      promptCache: true,
      thinkingEffort: 'high',
    },
  };
}

const CHOICES: readonly ModelChoice[] = [
  choice(0, 'opus', 'global.anthropic.claude-opus-5', true),
  choice(1, 'sol', 'openai.gpt-5.6-sol'),
  choice(2, 'us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-sonnet-4-6'),
];

function resolution(): void {
  header('/model — resolving an argument to a configured model');

  assert(
    'global config fixtures resolve inside this suite\'s own HOME',
    configPath().startsWith(`${OWNED_HOME}${path.sep}`),
  );

  const byIndex = resolveModelChoice(CHOICES, '2');
  assert('a 1-based position selects an entry', byIndex !== 'ambiguous' && byIndex?.name === 'sol');
  assert('position 0 is not a position', resolveModelChoice(CHOICES, '0') === undefined);
  // Not merely out of range: "4" is a substring of "claude-sonnet-4-6", so falling
  // through to substring matching would silently select it.
  assert('a position past the end is not a match', resolveModelChoice(CHOICES, '4') === undefined);
  assert('an all-digits argument never matches a model id', resolveModelChoice(CHOICES, '6') === undefined);

  const byName = resolveModelChoice(CHOICES, 'sol');
  assert('an exact name selects an entry', byName !== 'ambiguous' && byName?.index === 1);
  const byCase = resolveModelChoice(CHOICES, 'SOL');
  assert('names are case-insensitive', byCase !== 'ambiguous' && byCase?.index === 1);

  const byModelId = resolveModelChoice(CHOICES, 'openai.gpt-5.6-sol');
  assert('a pasted model id selects an entry', byModelId !== 'ambiguous' && byModelId?.index === 1);
  const bySubstring = resolveModelChoice(CHOICES, 'sonnet');
  assert('a unique substring of the model id works', bySubstring !== 'ambiguous' && bySubstring?.index === 2);

  // "claude" is in two of the three model ids. Picking the first would switch to a
  // model the user did not name, so this must refuse instead.
  assert('an ambiguous substring is refused', resolveModelChoice(CHOICES, 'claude') === 'ambiguous');
  assert('no match is undefined, not a guess', resolveModelChoice(CHOICES, 'gemini') === undefined);

  // An exact name wins over being a substring of another entry: without this,
  // naming an entry exactly could still be "ambiguous".
  const shadowed: readonly ModelChoice[] = [choice(0, 'sol', 'a', true), choice(1, 'solar', 'b')];
  const exactWins = resolveModelChoice(shadowed, 'sol');
  assert('an exact name beats a longer name containing it', exactWins !== 'ambiguous' && exactWins?.index === 0);
}

function runtimeAgent(runtime: AgentRuntime): Agent {
  return (runtime as unknown as { agent: Agent }).agent;
}

async function offlineCacheShapeSwitch(): Promise<void> {
  header('/model — cache mutation accepts only Darwin-owned prompt shapes');
  const root = await fixture();
  const runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });
  try {
    const target = runtime.modelChoices.find((entry) => entry.name === 'sol') as ModelChoice;
    const agent = runtimeAgent(runtime);
    agent.systemPrompt = [
      new TextBlock('base'),
      new TextBlock('<available_skills>\nNo skills are currently available.\n</available_skills>'),
      new TextBlock('<working-context>current</working-context>'),
      new CachePointBlock({ cacheType: 'default' }),
    ];
    const switched = await runtime.changeModel(target);
    await switched.saved;
    assert('valid official-skills shape removes the cache point for OpenAI', Array.isArray(agent.systemPrompt) && agent.systemPrompt.length === 3 && !(agent.systemPrompt.at(-1) instanceof CachePointBlock));

    const back = runtime.modelChoices.find((entry) => entry.name === 'opus') as ModelChoice;
    const returned = await runtime.changeModel(back);
    await returned.saved;
    assert('switching back restores one final cache point', Array.isArray(agent.systemPrompt) && agent.systemPrompt.length === 4 && agent.systemPrompt.at(-1) instanceof CachePointBlock);

    agent.systemPrompt = [new TextBlock('base'), new TextBlock('unknown second block')];
    let refusal = '';
    try {
      await runtime.changeModel(target);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    assert('unknown prompt arrays fail the switch explicitly', refusal.includes('Could not update the final cache point'));
    assert('failed switch keeps the previous live model', runtime.config.model === 'global.anthropic.claude-opus-5');
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}


/** Answers every call with one text block and provider usage; no network, no SDK loop change. */
class ScriptedModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'fake.model-command', contextWindowLimit: 200_000 };

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'scripted answer' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
  }
}

/** The `runStarted` keys a record carried before SRF-038 — the header must not grow one. */
const RUN_STARTED_KEYS = new Set([
  'v', 'seq', 't', 'turn', 'type', 'session', 'agentId', 'darwinVersion', 'provider', 'model',
  'permissionMode', 'thinkingEffort', 'resumed', 'restoredMessages', 'pid',
]);

/**
 * SRF-038 through the production seam: a real runtime with its trajectory recorder on
 * and a scripted model factory (no model call, no network). A successful switch writes
 * exactly one `modelChanged`; a failed factory and a refused cache shape write none;
 * `runStarted` keeps naming the startup model; later spend names the model that ran;
 * replay shows the switch as one line in transcript order.
 */
async function offlineModelChangedRecord(): Promise<void> {
  header('/model — a successful switch is recorded once in the trajectory; a failed one never');
  const root = await fixture();
  const scripted = async (): Promise<Model<BaseModelConfig>> => new ScriptedModel();
  setRuntimeModelFactoryForTest(scripted as never);
  const runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });
  let shut = false;
  try {
    const opus = runtime.modelChoices.find((entry) => entry.name === 'opus') as ModelChoice;
    const sol = runtime.modelChoices.find((entry) => entry.name === 'sol') as ModelChoice;

    // 1. Before any turn: the case the origin session hit (seq 0 said one model, every
    // later record another).
    const toSol = await runtime.changeModel(sol);
    await toSol.saved;

    // 2. A failed factory: the session stays on sol and nothing is recorded.
    setRuntimeModelFactoryForTest(async () => { throw new Error('scripted factory failure'); });
    let factoryError = '';
    try {
      await runtime.changeModel(opus);
    } catch (error) {
      factoryError = error instanceof Error ? error.message : String(error);
    }
    setRuntimeModelFactoryForTest(scripted as never);
    assert('a failed factory rejects the switch and leaves the live model', factoryError === 'scripted factory failure' && runtime.config.model === 'openai.gpt-5.6-sol');

    // 3. A refused switch: an unknown prompt shape throws before the swap.
    const agent = runtimeAgent(runtime);
    const prompt = agent.systemPrompt as NonNullable<Agent['systemPrompt']>;
    agent.systemPrompt = [new TextBlock('base'), new TextBlock('unknown second block')];
    let refusal = '';
    try {
      await runtime.changeModel(opus);
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    agent.systemPrompt = prompt;
    assert('a refused cache shape rejects the switch and leaves the live model', refusal.includes('Could not update the final cache point') && runtime.config.model === 'openai.gpt-5.6-sol');

    // 4. One turn on the switched model, then a switch back after it.
    for await (const _event of runtime.send('hello after the switch')) { /* drain */ }
    const back = await runtime.changeModel(opus);
    await back.saved;

    const file = runtime.trajectoryStatus?.file ?? '';
    await runtime.shutdown();
    shut = true;

    const read = await readTrajectory(file);
    const changes = read.records.filter((record): record is ModelChangedRecord => record.type === 'modelChanged');
    const readings = changes.map((record) => modelChangedOf(record));
    assert('exactly two modelChanged records — one per successful switch, none for the failed or refused one', changes.length === 2);
    assert('the first says bedrock/opus → openai/sol at turn 0, with the new plan\u2019s effective effort',
      readings[0]?.turn === 0 &&
      readings[0].from.provider === 'bedrock' && readings[0].from.model === 'global.anthropic.claude-opus-5' &&
      readings[0].to.provider === 'openai' && readings[0].to.model === 'openai.gpt-5.6-sol' &&
      readings[0].thinkingEffort === toSol.thinking.effective && typeof toSol.thinking.effective === 'string');
    assert('the switch back carries the turn it followed and the reverse labels',
      readings[1]?.turn === 1 && readings[1].from.model === 'openai.gpt-5.6-sol' && readings[1].to.model === 'global.anthropic.claude-opus-5' &&
      readings[1].thinkingEffort === back.thinking.effective);
    const started = read.records.find((record): record is RunStartedRecord => record.type === 'runStarted');
    assert('runStarted still names the startup model, with no key it did not carry before',
      read.records.filter((record) => record.type === 'runStarted').length === 1 &&
      started?.provider === 'bedrock' && started.model === 'global.anthropic.claude-opus-5' &&
      Object.keys(started).every((key) => RUN_STARTED_KEYS.has(key)));
    const ended = read.records.find((record): record is TurnEndedRecord => record.type === 'turnEnded');
    const call = read.records.find((record): record is ModelCallRecord => record.type === 'modelCall');
    assert('the turn after the switch is billed to the model that ran — spend and modelCall say openai/sol',
      ended?.spend?.provider === 'openai' && ended.spend.model === 'openai.gpt-5.6-sol' &&
      call?.spend?.provider === 'openai' && call.spend.model === 'openai.gpt-5.6-sol');
    const order = read.records.map((record) => record.type);
    assert('file order: runStarted, the switch, the turn, then the switch back',
      order.indexOf('runStarted') < order.indexOf('modelChanged') && order.indexOf('modelChanged') < order.indexOf('userInput') &&
      order.lastIndexOf('modelChanged') > order.indexOf('turnEnded'));

    const transcript = formatReplay(replayRead(read)).split('\n');
    const toLine = `  note model changed: bedrock/global.anthropic.claude-opus-5 → openai/openai.gpt-5.6-sol${toSol.thinking.effective === undefined ? '' : ` · thinking effort ${toSol.thinking.effective}`}`;
    const backLine = `  note model changed: openai/openai.gpt-5.6-sol → bedrock/global.anthropic.claude-opus-5${back.thinking.effective === undefined ? '' : ` · thinking effort ${back.thinking.effective}`}`;
    assert('replay shows each switch as one note line in transcript order around the turn',
      transcript.filter((line) => line.includes('model changed')).length === 2 &&
      transcript.indexOf(toLine) !== -1 && transcript.indexOf(toLine) < transcript.indexOf('you> hello after the switch') &&
      transcript.indexOf(backLine) > transcript.indexOf('darwin> scripted answer'));
    assert('the replay run header is still runStarted\u2019s label',
      transcript[0]?.endsWith(' · bedrock/global.anthropic.claude-opus-5') === true);
  } finally {
    if (!shut) await runtime.shutdown();
    setRuntimeModelFactoryForTest(undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** A project root with two models configured, `opus` enabled. */
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-model-cmd-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(
    configPath(root),
    JSON.stringify(
      {
        permissionMode: 'yolo',
        models: [
          {
            enable: true,
            name: 'opus',
            provider: 'bedrock',
            model: 'global.anthropic.claude-opus-5',
            region: 'us-west-2',
            maxTokens: 8192,
          },
          {
            enable: false,
            name: 'sol',
            provider: 'openai',
            model: 'openai.gpt-5.6-sol',
            bedrockMantle: true,
            openaiApi: 'responses',
            region: 'us-east-1',
            maxTokens: 8192,
          },
        ],
      },
      null,
      2,
    ),
  );
  return root;
}

/** Consumes a turn, returning the assistant text. */
async function turn(runtime: AgentRuntime, input: string): Promise<string> {
  let text = '';
  for await (const event of runtime.send(input)) {
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event.type === 'modelContentBlockDeltaEvent' &&
      event.event.delta.type === 'textDelta'
    ) {
      text += event.event.delta.text;
    }
  }
  return text.trim().replace(/\s+/g, ' ');
}

async function liveSwitch(): Promise<void> {
  header('/model — switching a live session across providers');

  const root = await fixture();
  const runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });

  try {
    assert('the session starts on the enabled entry', runtime.config.model === 'global.anthropic.claude-opus-5');
    assert('…and can cache, being Claude', runtime.promptCache.enabled);
    assert('the catalogue offers both', runtime.modelChoices.length === 2);

    // Something specific to remember, so "the conversation survived" is checked
    // against a fact only the pre-switch turn could know.
    const first = await turn(runtime, 'Remember the codeword violet-42. Reply with just: stored.');
    console.log(`  turn 1 (opus): ${first.slice(0, 60)}`);

    const target = runtime.modelChoices.find((c) => c.name === 'sol') as ModelChoice;
    const result = await runtime.changeModel(target);
    await result.saved;
    console.log(`  switched → ${result.choice.name} (${result.choice.fields.provider})`);

    assert('the live config is the new entry', runtime.config.model === 'openai.gpt-5.6-sol');
    assert('…with its own transport', runtime.config.bedrockMantle === true);
    // The leak that a naive spread would cause: opus set region us-west-2, and sol
    // needs us-east-1 or it 404s.
    assert('…and its own region, not the old one', runtime.config.region === 'us-east-1');
    assert('the catalogue marks the new entry live', result.choice.enabled);
    assert('…and only it', runtime.modelChoices.filter((c) => c.enabled).length === 1);
    assert('darwin-managed caching is off on the new provider', !runtime.promptCache.enabled);
    assert('the new provider reports its automatic cache', runtime.promptCache.automatic);
    assert(
      'provider-managed automatic caching is not reported as a problem',
      runtime.promptCache.problem === undefined,
    );

    const second = await turn(runtime, 'What was the codeword? Reply with just the codeword.');
    console.log(`  turn 2 (sol) : ${second.slice(0, 60)}`);
    assert('the conversation survived the provider change', /violet-42/i.test(second));

    // A tool call after the switch: the new provider has to accept the tool schemas
    // and the old provider's tool history in the same request.
    const third = await turn(runtime, 'Run "echo switched-ok" with bash and quote its output.');
    console.log(`  turn 3 (sol) : ${third.slice(0, 60)}`);
    assert('tools still work after the switch', /switched-ok/.test(third));

    const onDisk = JSON.parse(await readFile(configPath(root), 'utf8')) as {
      models: { name: string; enable: boolean }[];
    };
    assert('the switch was persisted', onDisk.models[1]?.enable === true);
    assert('…and the old entry switched off', onDisk.models[0]?.enable === false);
    assert('a reload agrees with the session', (await loadConfig(root)).model === 'openai.gpt-5.6-sol');

    // Back again, to prove the reverse direction is not a one-way door.
    const back = runtime.modelChoices.find((c) => c.name === 'opus') as ModelChoice;
    const returned = await runtime.changeModel(back);
    await returned.saved;
    assert('switching back restores the provider', runtime.config.provider === 'bedrock');
    assert('…and caching comes back with it', runtime.promptCache.enabled);
    const fourth = await turn(runtime, 'Still the same conversation — what was the codeword?');
    console.log(`  turn 4 (opus): ${fourth.slice(0, 60)}`);
    assert('the conversation survived the way back too', /violet-42/i.test(fourth));
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  resolution();
  await offlineCacheShapeSwitch();
  await offlineModelChangedRecord();
  if (process.argv.includes('--live')) await liveSwitch();
  else console.log('\n(skipping the live switch — pass --live to make real model calls)');
  report();
}

await main();
