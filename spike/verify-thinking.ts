/**
 * Thinking effort: the decision table, the fields each provider gets, the config
 * surface, and the live `/effort` switch.
 *
 * No model calls. The part a live run cannot show you is the clamping: a request
 * that quietly thinks at `high` instead of the `xhigh` that was asked for looks
 * exactly like one that obeyed, and the alternative — letting the unsupported
 * level through — is a `ValidationException` on every turn.
 *
 * Run: pnpm tsx spike/verify-thinking.ts
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  claudeThinkingFields,
  DEFAULT_THINKING_EFFORT,
  isThinkingEffort,
  openaiThinkingParams,
  planThinking,
  THINKING_EFFORTS,
  type ThinkingEffort,
} from '../src/agent/thinking.js';
import {
  applyThinkingEffort,
  ConfigError,
  configPath,
  createModelFromConfig,
  loadConfig,
  saveThinkingEffort,
  withSoleChoice,
  type AppConfig,
} from '../src/config.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-thinking-test';

/** Sonnet 4.6: adaptive thinking, but not the two Opus-only levels. */
const SONNET: AppConfig = withSoleChoice({
  provider: 'bedrock',
  model: 'us.anthropic.claude-sonnet-4-6',
  maxTokens: 8192,
  summaryRatio: 0.3, contextWarnRatio: 0.8,
  preserveRecentMessages: 10,
  permissionMode: 'default',
  promptCache: true,
  thinkingEffort: 'high',
});

/** Opus 5: the whole ladder, `xhigh` and `max` included. */
const OPUS: AppConfig = { ...SONNET, model: 'global.anthropic.claude-opus-5' };

async function writeConfig(contents: string): Promise<string> {
  const dir = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
  const file = configPath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
  return dir;
}

async function expectConfigError(what: string, run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    assert(what, false);
    return '';
  } catch (error) {
    assert(what, error instanceof ConfigError);
    return error instanceof Error ? error.message : String(error);
  }
}

async function configSurface(): Promise<void> {
  header('thinking — config surface');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  const defaults = await loadConfig(ROOT);
  assert('effort defaults to high with no config file', defaults.thinkingEffort === 'high');
  assert('…which is the documented provider default', DEFAULT_THINKING_EFFORT === 'high');

  for (const effort of THINKING_EFFORTS) {
    const loaded = await loadConfig(await writeConfig(`{ "thinkingEffort": "${effort}" }`));
    assert(`${effort} loads`, loaded.thinkingEffort === effort);
  }

  // A typo is not intent: silently thinking at some other depth than the file says
  // is both a cost and a quality surprise, so this refuses to start.
  const bad = await expectConfigError('an unknown level is rejected', async () =>
    loadConfig(await writeConfig('{ "thinkingEffort": "hard" }')),
  );
  assert('the error lists every valid level', /low, medium, high, xhigh, max/.test(bad));

  await expectConfigError('a non-string level is rejected', async () =>
    loadConfig(await writeConfig('{ "thinkingEffort": 3 }')),
  );

  assert('isThinkingEffort accepts a level', isThinkingEffort('xhigh'));
  assert('isThinkingEffort rejects a near-miss', !isThinkingEffort('extra-high'));
  assert('isThinkingEffort rejects a non-string', !isThinkingEffort(3));
}

function decisionTable(): void {
  header('thinking — what each model and provider gets');

  const opusMax = planThinking(OPUS, 'max');
  assert('Opus serves max unchanged', opusMax.effective === 'max' && opusMax.problem === undefined);
  assert('Opus serves xhigh unchanged', planThinking(OPUS, 'xhigh').effective === 'xhigh');

  const sonnetHigh = planThinking(SONNET, 'high');
  assert('Sonnet 4.6 thinks adaptively', sonnetHigh.enabled && sonnetHigh.effective === 'high');
  assert('…with nothing to report', sonnetHigh.problem === undefined);

  // The whole reason this module exists: xhigh on Sonnet is not degraded by the
  // API, it fails the request.
  const clamped = planThinking(SONNET, 'xhigh');
  assert('xhigh on Sonnet is clamped, not sent', clamped.effective === 'high');
  assert('…the request was remembered', clamped.requested === 'xhigh');
  assert('…and the clamp is reported', clamped.problem?.includes('Opus only') === true);
  // Measured, against the AWS page, which claims max is Opus-only as well: Sonnet
  // 4.6 accepts max and rejects only xhigh. Clamping max too would quietly sell the
  // user less thinking than the service was willing to give them.
  const sonnetMax = planThinking(SONNET, 'max');
  assert('max on Sonnet is sent as-is', sonnetMax.effective === 'max');
  assert('…with nothing to report', sonnetMax.problem === undefined);

  // Adaptive thinking arrived with Claude 4.6; older Claude models reject it.
  const old = planThinking({ ...SONNET, model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' }, 'high');
  assert('a pre-4.6 Claude model gets no thinking at all', !old.enabled && old.effective === undefined);
  assert('…and says why', old.problem?.includes('adaptive thinking') === true);

  const nova = planThinking({ ...SONNET, model: 'us.amazon.nova-pro-v1:0' }, 'low');
  assert('a non-Claude Bedrock model gets no thinking', !nova.enabled);

  // Version suffixes are why matching is by substring: an exact-id table would
  // stop recognizing a model the day AWS appends one.
  assert(
    'a suffixed Opus id is still recognized as Opus',
    planThinking({ ...SONNET, model: 'us.anthropic.claude-opus-4-6-v1:0' }, 'max').effective === 'max',
  );

  const anthropic = planThinking({ ...OPUS, provider: 'anthropic', model: 'claude-opus-4-6' }, 'xhigh');
  assert('the anthropic provider plans the same way', anthropic.effective === 'xhigh');

  const openai = planThinking({ ...SONNET, provider: 'openai', model: 'gpt-5' }, 'medium');
  assert('openai passes low/medium/high through', openai.effective === 'medium');
  const openaiClamped = planThinking({ ...SONNET, provider: 'openai', model: 'gpt-5' }, 'max');
  assert('…and clamps what reasoning_effort has no name for', openaiClamped.effective === 'high');
  assert('…saying so', openaiClamped.problem?.includes('openai') === true);
}

function requestFields(): void {
  header('thinking — the fields handed to the provider');

  const fields = claudeThinkingFields(planThinking(OPUS, 'max')) as Record<string, unknown>;
  const thinking = fields['thinking'] as Record<string, unknown>;
  const outputConfig = fields['output_config'] as Record<string, unknown>;

  // Never `enabled`/`budget_tokens`: the newest models reject that form outright,
  // and switching thinking modes mid-session would invalidate the message cache.
  assert('thinking is adaptive', thinking['type'] === 'adaptive');
  // Nested inside `thinking` this is a ValidationException, not a warning.
  assert('effort sits in its own output_config object', outputConfig['effort'] === 'max');
  assert('effort is NOT inside thinking', thinking['effort'] === undefined);

  const clamped = claudeThinkingFields(planThinking(SONNET, 'xhigh')) as Record<string, unknown>;
  assert(
    'a clamped plan sends the level the model can serve',
    (clamped['output_config'] as Record<string, unknown>)['effort'] === 'high',
  );

  assert(
    'a model that cannot think adaptively gets no fields at all',
    claudeThinkingFields(planThinking({ ...SONNET, model: 'us.amazon.nova-pro-v1:0' }, 'low')) === undefined,
  );

  const openai = openaiThinkingParams(planThinking({ ...SONNET, provider: 'openai', model: 'gpt-5' }, 'low'));
  assert('openai gets reasoning_effort', openai?.['reasoning_effort'] === 'low');
  assert(
    'openai gets no thinking/output_config keys',
    openai !== undefined && !('thinking' in openai) && !('output_config' in openai),
  );
}

async function liveSwitch(): Promise<void> {
  header('thinking — /effort reconfigures the live model');

  const model = await createModelFromConfig(OPUS);
  const initial = (model.getConfig() as { additionalRequestFields?: Record<string, unknown> })
    .additionalRequestFields;
  assert(
    'the model is built already thinking at the configured level',
    (initial?.['output_config'] as Record<string, unknown> | undefined)?.['effort'] === 'high',
  );

  const plan = applyThinkingEffort(model, OPUS, 'max');
  const after = model.getConfig() as {
    additionalRequestFields?: Record<string, unknown>;
    modelId?: string;
    maxTokens?: number;
    cacheConfig?: unknown;
  };
  assert('the new level is returned', plan.effective === 'max');
  assert(
    'the live model now carries it',
    (after.additionalRequestFields?.['output_config'] as Record<string, unknown> | undefined)?.['effort'] ===
      'max',
  );
  // updateConfig merges, so a change of depth must not cost the model everything
  // else it was constructed with — that is what makes /effort safe mid-session.
  assert('the model id survives the update', after.modelId === OPUS.model);
  assert('the token budget survives', after.maxTokens === OPUS.maxTokens);
  assert('the cache config survives', after.cacheConfig !== undefined);

  // Down the ladder as well as up, and a clamp still reaches the model.
  applyThinkingEffort(model, OPUS, 'low');
  assert(
    'switching down works too',
    (
      (model.getConfig() as { additionalRequestFields?: Record<string, unknown> }).additionalRequestFields?.[
        'output_config'
      ] as Record<string, unknown> | undefined
    )?.['effort'] === 'low',
  );

  const sonnet = await createModelFromConfig(SONNET);
  const clamped = applyThinkingEffort(sonnet, SONNET, 'xhigh');
  assert('a clamp is reported by the live switch', clamped.problem !== undefined);
  assert(
    'and the model gets the usable level, not the asked-for one',
    (
      (sonnet.getConfig() as { additionalRequestFields?: Record<string, unknown> })
        .additionalRequestFields?.['output_config'] as Record<string, unknown> | undefined
    )?.['effort'] === 'high',
  );

  // A model that cannot think adaptively must end up with no thinking key at all,
  // not with a stale one from an earlier level.
  const nova = await createModelFromConfig({ ...SONNET, model: 'us.amazon.nova-pro-v1:0' });
  applyThinkingEffort(nova, { ...SONNET, model: 'us.amazon.nova-pro-v1:0' }, 'high');
  const novaFields = (nova.getConfig() as { additionalRequestFields?: unknown }).additionalRequestFields;
  assert('a non-thinking model is left with no thinking fields', novaFields === undefined);
}

async function persistence(): Promise<void> {
  header('thinking — /effort is remembered');

  // Merged into the raw JSON: an unknown key from a newer darwin and the user's own
  // settings both have to survive the write, same rule as appendAllowRule.
  const root = await writeConfig(
    '{\n  "model": "global.anthropic.claude-opus-5",\n  "futureSetting": { "keep": true }\n}\n',
  );
  await saveThinkingEffort(root, 'xhigh');

  const written = JSON.parse(await readFile(configPath(root), 'utf8')) as Record<string, unknown>;
  assert('the level is written', written['thinkingEffort'] === 'xhigh');
  assert('unrelated known keys survive', written['model'] === 'global.anthropic.claude-opus-5');
  assert('unknown keys survive', JSON.stringify(written['futureSetting']) === '{"keep":true}');

  const reloaded = await loadConfig(root);
  assert('the written level loads back', reloaded.thinkingEffort === 'xhigh');

  // Overwrites rather than accumulating: unlike an allow-rule there is only ever
  // one level in force.
  await saveThinkingEffort(root, 'low');
  assert('a second change replaces the first', (await loadConfig(root)).thinkingEffort === 'low');

  const fresh = path.join(ROOT, `fresh-${Math.random().toString(36).slice(2)}`);
  await saveThinkingEffort(fresh, 'medium');
  assert(
    'a missing config file is created with the level',
    (await loadConfig(fresh)).thinkingEffort === 'medium',
  );

  await expectConfigError('saving a level that does not exist is refused', () =>
    saveThinkingEffort(root, 'turbo' as ThinkingEffort),
  );
  assert('…and the global file is untouched', (await loadConfig(root)).thinkingEffort === 'medium');
}

async function main(): Promise<void> {
  await configSurface();
  decisionTable();
  requestFields();
  await liveSwitch();
  await persistence();
  report();
}

await main();
