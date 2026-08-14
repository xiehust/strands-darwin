/**
 * The `/model` command: how an argument resolves to a configured model, and what
 * a live switch does to the session.
 *
 * Split in two on purpose. Resolution is pure, so it is exhaustive and free. The
 * switch is not: it replaces the model object on a live `Agent`, which is the part
 * that can only be proven by doing it — so that half makes real model calls and
 * asserts the conversation survived a change of provider.
 *
 * Run: pnpm tsx spike/verify-model-command.ts            (resolution only)
 *      pnpm tsx spike/verify-model-command.ts --live     (plus real model calls)
 */
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AgentRuntime } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { configPath, loadConfig, type ModelChoice } from '../src/config.js';
import { resolveModelChoice } from '../src/tui/App.js';
import { assert, header, report } from './shared.js';

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
  if (process.argv.includes('--live')) await liveSwitch();
  else console.log('\n(skipping the live switch — pass --live to make real model calls)');
  report();
}

await main();
