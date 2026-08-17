/**
 * Config loading and provider switching.
 *
 * No model calls: this is parsing and construction, so it covers the error paths
 * a live run never reaches. Evidence for the acceptance criterion that changing
 * provider is a config-file change only.
 *
 * Run: pnpm tsx spike/verify-config.ts
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Model } from '@strands-agents/sdk';

import {
  ConfigError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  OFFLOAD_PREVIEW_TOKENS,
  appendAllowRule,
  configPath,
  createModelFromConfig,
  loadConfig,
  loadProjectPolicy,
  permissionRulesPath,
  saveEnabledModel,
  saveThinkingEffort,
  openAIContextWindowLimit,
  resolveRegion,
  withModelChoice,
} from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const ROOT = '/tmp/darwin-config-test';

// Every fixture below is written through configPath(), which resolves under HOME
// rather than under the directory passed to it — so without an owned HOME this
// suite overwrites the developer's real ~/.darwin/config.json, and the invalid
// fixtures leave darwin unable to start.
const OWNED_HOME = ownPrivateHome('config');

/**
 * Writes the config where darwin reads it — `~/.darwin/config.json`.
 * Built from `configPath()` so a future move cannot leave this harness testing a
 * path nothing reads. The per-case directory only names the project root that is
 * handed to the loader; the file itself is global, hence {@link OWNED_HOME}.
 */
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
    const isConfigError = error instanceof ConfigError;
    assert(what, isConfigError);
    return error instanceof Error ? error.message : String(error);
  }
}

async function defaults(): Promise<void> {
  header('config — defaults with no .darwin/config.json');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  // Asserted before anything is written: if this fails, every later fixture is
  // landing on the developer's own configuration.
  assert(
    'global config fixtures resolve inside this suite\'s own HOME',
    configPath(ROOT).startsWith(`${OWNED_HOME}${path.sep}`),
  );

  const config = await loadConfig(ROOT);
  console.log(`  ${config.provider} / ${config.model} (maxTokens ${config.maxTokens})`);

  assert('provider defaults to bedrock', config.provider === 'bedrock');
  assert(
    'model defaults to a cross-region inference profile',
    config.model === 'global.anthropic.claude-opus-5',
  );
  assert('a missing .darwin/config.json is not an error', true);

  // The preset is a catalogue, not a lone model: with no file at all `/model` must
  // still have something to switch between, and the entry in effect must be the
  // same one the flat fallbacks name.
  const names = config.modelChoices.map((choice) => choice.name);
  console.log(`  catalogue: ${names.join(', ')}`);
  assert('the defaults offer the whole preset catalogue', config.modelChoices.length === 5);
  assert(
    'exactly one preset entry is enabled…',
    config.modelChoices.filter((choice) => choice.enabled).length === 1,
  );
  assert(
    '…and it is the one the flat defaults name',
    config.modelChoices.find((choice) => choice.enabled)?.fields.model === config.model,
  );
  assert(
    'every preset entry carries its own short name',
    config.modelChoices.every((choice) => choice.name !== choice.fields.model),
  );
  // Region is deliberately unset on the Bedrock entries so AWS_REGION still
  // decides, but pinned on the Mantle one: that catalog is per-region.
  const mantle = config.modelChoices.find((choice) => choice.fields.bedrockMantle === true);
  assert('the Mantle entry pins its region and API', mantle?.fields.region === 'us-east-1' && mantle?.fields.openaiApi === 'responses');
  assert(
    'the Bedrock entries leave region to AWS_REGION',
    config.modelChoices
      .filter((choice) => choice.fields.provider === 'bedrock')
      .every((choice) => choice.fields.region === undefined),
  );

  // The old location is deliberately dead: a leftover root config.json must not
  // quietly keep configuring the agent after the move.
  await writeFile(path.join(ROOT, 'config.json'), '{ "model": "us.legacy.should-be-ignored" }', 'utf8');
  const stillDefault = await loadConfig(ROOT);
  assert('a root config.json is no longer read', stillDefault.model === config.model);

  // Every preset entry must construct, not just the enabled one — an entry `/model`
  // cannot switch to is a catalogue that lies about what this run can reach.
  const model = await createModelFromConfig(config);
  assert('default config builds a working model', model !== undefined);
  for (const choice of config.modelChoices) {
    const built = await createModelFromConfig(withModelChoice(config, choice));
    assert(`preset entry "${choice.name}" builds a model`, built !== undefined);
  }
}

async function regionFallback(): Promise<void> {
  header('config — region fallback chain');

  const configured = resolveRegion('eu-west-1');
  assert('an explicit region wins', configured === 'eu-west-1');

  const previous = { region: process.env['AWS_REGION'], fallback: process.env['AWS_DEFAULT_REGION'] };
  try {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    assert('falls back to us-west-2 when nothing is set', resolveRegion() === 'us-west-2');

    process.env['AWS_DEFAULT_REGION'] = 'ap-southeast-2';
    assert('AWS_DEFAULT_REGION is used', resolveRegion() === 'ap-southeast-2');

    process.env['AWS_REGION'] = 'us-east-1';
    assert('AWS_REGION outranks AWS_DEFAULT_REGION', resolveRegion() === 'us-east-1');
  } finally {
    restoreEnv('AWS_REGION', previous.region);
    restoreEnv('AWS_DEFAULT_REGION', previous.fallback);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function providerSwitching(): Promise<void> {
  header('config — switching provider is a config change only');

  const bedrock = await loadConfig(
    await writeConfig('{ "provider": "bedrock", "model": "global.anthropic.claude-sonnet-4-6" }'),
  );
  assert('bedrock is selected from config', bedrock.provider === 'bedrock');
  const bedrockModel = await createModelFromConfig(bedrock);
  assert('a global. profile is accepted', bedrockModel !== undefined);
  assert(
    'bedrock native CountTokens is enabled',
    (bedrockModel.getConfig() as { useNativeTokenCount?: boolean }).useNativeTokenCount === true,
  );

  // Anthropic and OpenAI need peer dependencies this install does not carry. The
  // config path is still proven: it reaches provider construction and fails there
  // with an actionable install instruction, not a code error.
  const anthropic = await loadConfig(
    await writeConfig('{ "provider": "anthropic", "model": "claude-sonnet-4-6" }'),
  );
  assert('anthropic is selected from config', anthropic.provider === 'anthropic');
  const anthropicError = await expectConfigError(
    'anthropic reports its missing peer dependency as a ConfigError',
    () => createModelFromConfig(anthropic),
  );
  console.log(`  anthropic: ${anthropicError.split('\n')[0]}`);
  assert('anthropic error names the package to install', anthropicError.includes('@anthropic-ai/sdk'));

  const openai = await loadConfig(await writeConfig('{ "provider": "openai", "model": "gpt-5" }'));
  assert('openai is selected from config', openai.provider === 'openai');

  // The openai peer dependency *is* installed (Bedrock Mantle needs it), so this
  // reaches the real constructor. Without a credential the OpenAI SDK refuses to
  // build a client; the message names the env var, which is the actionable part.
  const savedKey = process.env['OPENAI_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  try {
    let keylessError = '';
    try {
      await createModelFromConfig(openai);
    } catch (error) {
      keylessError = error instanceof Error ? error.message : String(error);
    }
    assert('openai without a credential is refused', keylessError !== '');
    assert('the refusal names OPENAI_API_KEY', keylessError.includes('OPENAI_API_KEY'));

    process.env['DARWIN_TEST_OPENAI_KEY'] = 'sk-test';
    const keyed = await loadConfig(
      await writeConfig('{ "provider": "openai", "model": "gpt-5", "apiKeyEnv": "DARWIN_TEST_OPENAI_KEY" }'),
    );
    assert('openai builds once apiKeyEnv resolves', (await createModelFromConfig(keyed)) !== undefined);
    delete process.env['DARWIN_TEST_OPENAI_KEY'];

    // Mantle replaces the API key with AWS credentials, so this must build with no
    // key in the environment at all — the whole point of the pathway.
    const mantle = await loadConfig(
      await writeConfig(
        '{ "provider": "openai", "model": "openai.gpt-5.6-sol", "bedrockMantle": true, ' +
          '"openaiApi": "responses", "region": "us-east-1", "thinkingEffort": "max" }',
      ),
    );
    const mantleModel = await createModelFromConfig(mantle);
    const mantleConfig = mantleModel.getConfig() as {
      params?: Record<string, unknown>;
      contextWindowLimit?: number;
    };
    const mantleParams = mantleConfig.params;
    console.log(`  mantle params: ${JSON.stringify(mantleParams)}`);
    // The Responses API rejects the flat `reasoning_effort` outright, and Mantle
    // serves the whole ladder — so `max` must arrive nested and unclamped.
    assert(
      'mantle sends nested reasoning.effort, unclamped',
      JSON.stringify(mantleParams) === JSON.stringify({ reasoning: { effort: 'max' } }),
    );
    assert('mantle prefixed model id receives its known context window', mantleConfig.contextWindowLimit === 1_050_000);

    const chat = await loadConfig(
      await writeConfig(
        '{ "provider": "openai", "model": "gpt-5", "apiKeyEnv": "OPENAI_API_KEY", "thinkingEffort": "max" }',
      ),
    );
    process.env['OPENAI_API_KEY'] = 'sk-test';
    const chatConfig = (await createModelFromConfig(chat)).getConfig() as {
      params?: Record<string, unknown>;
      contextWindowLimit?: number;
    };
    assert(
      'native openai still sends flat reasoning_effort, clamped to high',
      JSON.stringify(chatConfig.params) === JSON.stringify({ reasoning_effort: 'high' }),
    );
    assert('other SDK-known OpenAI ids retain SDK metadata', chatConfig.contextWindowLimit === 272_000);

    const known = await loadConfig(
      await writeConfig(
        '{ "provider": "openai", "model": "gpt-5.6-sol", "apiKeyEnv": "OPENAI_API_KEY" }',
      ),
    );
    assert(
      'unprefixed known OpenAI ids use the same metadata lookup',
      (await createModelFromConfig(known)).getConfig().contextWindowLimit === 1_050_000,
    );
    const unknown = await loadConfig(
      await writeConfig(
        '{ "provider": "openai", "model": "custom-unknown", "apiKeyEnv": "OPENAI_API_KEY" }',
      ),
    );
    assert(
      'unknown OpenAI ids keep their window unknown',
      (await createModelFromConfig(unknown)).getConfig().contextWindowLimit === undefined,
    );
  } finally {
    restoreEnv('OPENAI_API_KEY', savedKey);
  }
  assert('the prefixed lookup normalizes only known ids', openAIContextWindowLimit('openai.custom-unknown') === undefined);

  // Both new keys are openai-only and mutually exclusive with a credential; each
  // mistake is rejected at load time rather than as an opaque SDK error later.
  const mantleOnBedrock = await expectConfigError('bedrockMantle on provider bedrock is rejected', async () =>
    loadConfig(
      await writeConfig('{ "provider": "bedrock", "model": "us.anthropic.claude-sonnet-4-6", "bedrockMantle": true }'),
    ),
  );
  assert('the error points at provider "openai"', mantleOnBedrock.includes('"openai"'));

  const mantleWithKey = await expectConfigError('bedrockMantle plus apiKeyEnv is rejected', async () =>
    loadConfig(
      await writeConfig('{ "provider": "openai", "model": "openai.gpt-5.6-sol", "bedrockMantle": true, "apiKeyEnv": "X" }'),
    ),
  );
  assert('the error names both keys', mantleWithKey.includes('bedrockMantle') && mantleWithKey.includes('apiKeyEnv'));

  const badApi = await expectConfigError('an unknown openaiApi is rejected', async () =>
    loadConfig(await writeConfig('{ "provider": "openai", "model": "gpt-5", "openaiApi": "grpc" }')),
  );
  assert('the error lists the valid api modes', /chat, responses/.test(badApi));

  await expectConfigError('openaiApi on provider bedrock is rejected', async () =>
    loadConfig(
      await writeConfig('{ "provider": "bedrock", "model": "us.anthropic.claude-sonnet-4-6", "openaiApi": "chat" }'),
    ),
  );
}

async function rejections(): Promise<void> {
  header('config — bad input is rejected with a usable message');

  const unknownProvider = await expectConfigError('an unknown provider is rejected', async () =>
    loadConfig(await writeConfig('{ "provider": "gemini" }')),
  );
  assert('the error lists the valid providers', /bedrock, anthropic, openai/.test(unknownProvider));

  await expectConfigError('malformed JSON is rejected', async () =>
    loadConfig(await writeConfig('{ "provider": ')),
  );

  await expectConfigError('a non-object config is rejected', async () =>
    loadConfig(await writeConfig('["bedrock"]')),
  );

  await expectConfigError('a wrongly typed field is rejected', async () =>
    loadConfig(await writeConfig('{ "maxTokens": "lots" }')),
  );

  // Out-of-range numbers parse fine as JSON but fail late and obscurely: a zero
  // token budget as a service error, a ratio above 1 as odd summarizer behaviour.
  const zeroTokens = await expectConfigError('maxTokens below 1 is rejected', async () =>
    loadConfig(await writeConfig('{ "maxTokens": 0 }')),
  );
  assert('the range error states the bound', zeroTokens.includes('at least 1'));

  await expectConfigError('summaryRatio above 1 is rejected', async () =>
    loadConfig(await writeConfig('{ "summaryRatio": 1.5 }')),
  );
  await expectConfigError('a negative preserveRecentMessages is rejected', async () =>
    loadConfig(await writeConfig('{ "preserveRecentMessages": -1 }')),
  );

  const inRange = await loadConfig(
    await writeConfig('{ "summaryRatio": 1, "preserveRecentMessages": 0, "maxTokens": 1 }'),
  );
  assert('values at the boundaries are accepted', inRange.summaryRatio === 1 && inRange.maxTokens === 1);

  // The service rejects bare ids, so catching it here beats a runtime failure.
  const bareModel = await loadConfig(
    await writeConfig('{ "provider": "bedrock", "model": "anthropic.claude-sonnet-4-6" }'),
  );
  const bareError = await expectConfigError(
    'a bare Bedrock model id (no inference profile) is rejected',
    () => createModelFromConfig(bareModel),
  );
  assert('the error explains the required prefix', bareError.includes('us.'));
  assert(
    'the error shows how to list available profiles',
    bareError.includes('list-inference-profiles'),
  );

  // Checked before the provider's dynamic import, so this is the user's own
  // config error and not the missing peer dependency being reported.
  const emptyKeyEnv = await loadConfig(
    await writeConfig('{ "provider": "bedrock", "apiKeyEnv": "DARWIN_DEFINITELY_UNSET" }'),
  );
  const keyError = await expectConfigError(
    'an apiKeyEnv pointing at an unset variable is rejected',
    () => createModelFromConfig({ ...emptyKeyEnv, provider: 'anthropic' }),
  );
  assert('the error names the empty variable', keyError.includes('DARWIN_DEFINITELY_UNSET'));
}

async function requestTimeout(): Promise<void> {
  header('config — Bedrock stream idle timeout');

  // Unset means darwin's default, not the SDK's 120s — the whole point of the
  // field is that the number in effect is one this codebase owns.
  const unset = await loadConfig(await writeConfig('{}'));
  assert('requestTimeoutMs is absent when unconfigured', unset.requestTimeoutMs === undefined);
  assert(
    `…and the built client idles out at the ${DEFAULT_REQUEST_TIMEOUT_MS}ms default`,
    (await resolvedRequestTimeout(await createModelFromConfig(unset))) === DEFAULT_REQUEST_TIMEOUT_MS,
  );

  const tuned = await loadConfig(await writeConfig('{ "requestTimeoutMs": 300000 }'));
  assert('a configured requestTimeoutMs is loaded', tuned.requestTimeoutMs === 300_000);
  assert(
    '…and reaches the smithy request handler',
    (await resolvedRequestTimeout(await createModelFromConfig(tuned))) === 300_000,
  );

  await expectConfigError('requestTimeoutMs below 1 is rejected', async () =>
    loadConfig(await writeConfig('{ "requestTimeoutMs": 0 }')),
  );
  await expectConfigError('a non-numeric requestTimeoutMs is rejected', async () =>
    loadConfig(await writeConfig('{ "requestTimeoutMs": "3m" }')),
  );

  // Bedrock-only: on the other providers the value never reaches a client, and a
  // timeout the user believes is in effect but is not would surface exactly like
  // the hang it exists to bound.
  const mismatch = await expectConfigError(
    'requestTimeoutMs on a non-bedrock provider is rejected',
    async () =>
      loadConfig(await writeConfig('{ "provider": "openai", "model": "gpt-5", "requestTimeoutMs": 60000 }')),
  );
  assert('…naming the offending provider', mismatch.includes('"openai"'));
}

/**
 * Digs the resolved idle timeout out of a constructed Bedrock model. Reaches
 * through two private layers (`BedrockModel._client`, the handler's deferred
 * config) on purpose: the value only matters if it arrives where the smithy
 * handler arms `stream.setTimeout()`, and nothing public reports that.
 */
async function resolvedRequestTimeout(model: Model): Promise<number | undefined> {
  const client = (model as unknown as { _client: { config: { requestHandler: unknown } } })._client;
  const handler = client.config.requestHandler as {
    config?: { requestTimeout?: number };
    configProvider?: Promise<{ requestTimeout?: number }>;
  };
  return (handler.config ?? (await handler.configProvider))?.requestTimeout;
}

async function permissionModes(): Promise<void> {
  header('config — permission mode');

  const absent = await loadConfig(await writeConfig('{}'));
  assert('permissionMode defaults to "default"', absent.permissionMode === 'default');

  const auto = await loadConfig(
    await writeConfig('{ "permissionMode": "auto", "classifierModel": "us.anthropic.claude-haiku-4-5" }'),
  );
  assert('a valid permissionMode is accepted', auto.permissionMode === 'auto');
  assert('classifierModel is carried through', auto.classifierModel === 'us.anthropic.claude-haiku-4-5');

  const plan = await loadConfig(await writeConfig('{ "permissionMode": "plan" }'));
  assert('plan is accepted', plan.permissionMode === 'plan');

  const yolo = await loadConfig(await writeConfig('{ "permissionMode": "yolo" }'));
  assert('yolo is accepted', yolo.permissionMode === 'yolo');

  const badMode = await expectConfigError('an unknown permissionMode is rejected', async () =>
    loadConfig(await writeConfig('{ "permissionMode": "strict" }')),
  );
  assert('the error lists the valid modes', /default, auto, plan, yolo/.test(badMode));

  await expectConfigError('an empty classifierModel is rejected', async () =>
    loadConfig(await writeConfig('{ "classifierModel": "" }')),
  );
}

async function permissionRules(): Promise<void> {
  header('config — permission allow rules');

  const absentRoot = path.join(ROOT, `rules-${Math.random().toString(36).slice(2)}`);
  const absent = await loadProjectPolicy(absentRoot);
  assert('permissionRules is absent by default', absent.allowRules.length === 0);

  await mkdir(path.join(absentRoot, '.darwin'), { recursive: true });
  await writeFile(path.join(absentRoot, '.darwin', 'config.json'),
    '{ "permissionRules": { "allow": ["bash:pnpm *", "fileEditor:src/**"] } }');
  const loaded = await loadProjectPolicy(absentRoot);
  assert(
    'legacy project rules are carried through in order',
    JSON.stringify(loaded.allowRules) === '["bash:pnpm *","fileEditor:src/**"]',
  );
  assert('legacy rules are identified for promotion', loaded.legacyRules);

  await writeFile(path.join(absentRoot, '.darwin', 'config.json'), '{ "permissionRules": {} }');
  const emptyRules = await loadProjectPolicy(absentRoot);
  assert('permissionRules without "allow" is empty, not an error', emptyRules.allowRules.length === 0);

  await expectConfigError('a non-object permissionRules is rejected', async () =>
    loadConfig(await writeConfig('{ "permissionRules": ["bash"] }')),
  );
  await expectConfigError('a non-array allow is rejected', async () =>
    loadConfig(await writeConfig('{ "permissionRules": { "allow": "bash" } }')),
  );
  await expectConfigError('a non-string rule is rejected', async () =>
    loadConfig(await writeConfig('{ "permissionRules": { "allow": [42] } }')),
  );

  // An unparseable rule would silently never match, leaving the user believing
  // they had stopped being asked.
  const badRule = await expectConfigError('a rule with an empty pattern is rejected', async () =>
    loadConfig(await writeConfig('{ "permissionRules": { "allow": ["bash:"] } }')),
  );
  assert('global config explains that rules are project-scoped', badRule.includes('project-scoped'));

  header('config — appending a rule');

  // Merged into the raw JSON: an unknown key from a newer darwin, and the user's
  // own settings, both have to survive the write.
  const root = await writeConfig(
    '{\n  "model": "us.anthropic.claude-sonnet-4-6",\n  "futureSetting": { "keep": true }\n}\n',
  );
  await appendAllowRule(root, 'bash:pnpm *');
  await appendAllowRule(root, 'fileEditor:src/**');
  await appendAllowRule(root, 'bash:pnpm *');

  const written = JSON.parse(await readFile(permissionRulesPath(root), 'utf8')) as { allow?: string[] };
  console.log(`  written: ${JSON.stringify(written)}`);

  const reloaded = await loadProjectPolicy(root);
  assert(
    'both rules are persisted, duplicates collapsed',
    JSON.stringify(reloaded.allowRules) === '["bash:pnpm *","fileEditor:src/**"]',
  );
  assert('application config is unchanged by rule persistence',
    (await loadConfig(root)).model === 'us.anthropic.claude-sonnet-4-6');

  // The prompt is the only writer today, but a rule that could never match must
  // not reach the file whatever calls it.
  await expectConfigError('appending a malformed rule is refused', () =>
    appendAllowRule(root, 'bash:'),
  );

  // First rule in a project that has no config file at all: the common case.
  const fresh = path.join(ROOT, `fresh-${Math.random().toString(36).slice(2)}`);
  await appendAllowRule(fresh, 'bash');
  const freshConfig = await loadProjectPolicy(fresh);
  assert(
    'a missing scoped rules file is created with the rule',
    JSON.stringify(freshConfig.allowRules) === '["bash"]',
  );
}

async function toolHooks(): Promise<void> {
  header('config — tool lifecycle hooks');

  const absent = await loadConfig(await writeConfig('{}'));
  assert('hooks are absent by default', absent.hooks === undefined);

  const hooks = {
    PreToolUse: [{ matcher: 'file*', hooks: [{ type: 'command', command: './check.sh' }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: './audit.sh' }] }],
  };
  const loaded = await loadConfig(await writeConfig(JSON.stringify({ hooks })));
  assert('single-model config preserves validated hook order', JSON.stringify(loaded.hooks) === JSON.stringify(hooks));

  const array = await loadConfig(await writeConfig(JSON.stringify({
    hooks,
    models: [
      { enable: true, name: 'one', model: 'us.anthropic.claude-sonnet-4-6' },
      { enable: false, name: 'two', model: 'global.anthropic.claude-opus-5' },
    ],
  })));
  assert('models config loads root session hooks', JSON.stringify(array.hooks) === JSON.stringify(hooks));
  const switched = withModelChoice(array, array.modelChoices[1] as NonNullable<(typeof array.modelChoices)[number]>);
  assert('/model preserves hooks as session config', switched.hooks === array.hooks);

  const cases: [string, unknown, string][] = [
    ['non-object hooks', [], '"hooks"'],
    ['unsupported event', { BeforeToolUse: [] }, 'BeforeToolUse'],
    ['non-array event', { PreToolUse: {} }, 'PreToolUse'],
    ['malformed matcher group', { PreToolUse: [null] }, 'PreToolUse[0]'],
    ['blank matcher', { PreToolUse: [{ matcher: ' ', hooks: [{ type: 'command', command: 'true' }] }] }, '.matcher'],
    ['empty command hooks', { PreToolUse: [{ matcher: '*', hooks: [] }] }, '.hooks'],
    ['unsupported hook type', { PreToolUse: [{ matcher: '*', hooks: [{ type: 'prompt', command: 'x' }] }] }, '.type'],
    ['blank hook command', { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '' }] }] }, '.command'],
  ];
  for (const [label, value, field] of cases) {
    const error = await expectConfigError(`${label} is rejected`, async () =>
      loadConfig(await writeConfig(JSON.stringify({ hooks: value }))),
    );
    assert(`${label} error names its config field`, error.includes(field));
  }

  const misplaced = await expectConfigError('hooks inside a model entry are rejected', async () =>
    loadConfig(await writeConfig(JSON.stringify({ models: [{ enable: true, model: 'x', hooks }] }))),
  );
  assert('misplaced hooks error says to use top level', misplaced.includes('"hooks"') && misplaced.includes('top level'));
}

/**
 * The `models` array: several model configurations in one file, one of them
 * switched on. The resolved AppConfig is deliberately identical in shape to the
 * single-model form, so these assertions are about *selection* and about the
 * mistakes the format makes possible.
 */
async function modelArray(): Promise<void> {
  header('config — models array, enabled by switch');

  const twoModels = (opusEnable: boolean, solEnable: boolean): string =>
    JSON.stringify({
      permissionMode: 'yolo',
      summaryRatio: 0.5,
      models: [
        {
          enable: opusEnable,
          provider: 'bedrock',
          model: 'global.anthropic.claude-opus-5',
          maxTokens: 64000,
          thinkingEffort: 'xhigh',
        },
        {
          enable: solEnable,
          provider: 'openai',
          model: 'openai.gpt-5.6-sol',
          bedrockMantle: true,
          openaiApi: 'responses',
          region: 'us-east-1',
          maxTokens: 32000,
        },
      ],
    });

  const first = await loadConfig(await writeConfig(twoModels(true, false)));
  assert('the enabled entry provides the provider', first.provider === 'bedrock');
  assert('…and the model', first.model === 'global.anthropic.claude-opus-5');
  assert('…and its own maxTokens', first.maxTokens === 64000);
  assert('…and its own thinkingEffort', first.thinkingEffort === 'xhigh');
  // The disabled entry must not contribute anything at all, or a model switch
  // would silently inherit settings from the model it replaced.
  assert('the disabled entry leaks no region', first.region === undefined);
  assert('the disabled entry leaks no bedrockMantle', first.bedrockMantle === undefined);
  assert('the disabled entry leaks no openaiApi', first.openaiApi === undefined);
  assert('root session keys still apply', first.permissionMode === 'yolo' && first.summaryRatio === 0.5);
  assert('the enabled entry builds a model', (await createModelFromConfig(first)) !== undefined);

  // Flipping the switch is the whole point: same file, different model, nothing
  // else moves.
  const second = await loadConfig(await writeConfig(twoModels(false, true)));
  assert('flipping enable selects the other entry', second.model === 'openai.gpt-5.6-sol');
  assert('…with its own provider', second.provider === 'openai');
  assert('…and its own transport', second.bedrockMantle === true && second.openaiApi === 'responses');
  assert('…and its own region', second.region === 'us-east-1');
  assert('…and its own maxTokens', second.maxTokens === 32000);
  assert('…while the session keys are unchanged', second.permissionMode === 'yolo');
  assert('the default effort applies where the entry omits it', second.thinkingEffort === 'high');

  // Neither zero nor two enabled may resolve: both would mean running a model
  // the file does not unambiguously name.
  const noneEnabled = await expectConfigError('no enabled model is rejected', async () =>
    loadConfig(await writeConfig(twoModels(false, false))),
  );
  assert('the error lists the candidates', noneEnabled.includes('claude-opus-5') && noneEnabled.includes('gpt-5.6-sol'));

  const bothEnabled = await expectConfigError('two enabled models are rejected', async () =>
    loadConfig(await writeConfig(twoModels(true, true))),
  );
  assert('the error says how many are enabled', bothEnabled.includes('2 models are enabled'));

  // `enable` defaults to false, so an entry without it is not silently active.
  await expectConfigError('an entry without enable is not active', async () =>
    loadConfig(
      await writeConfig('{ "models": [{ "provider": "bedrock", "model": "us.anthropic.claude-sonnet-4-6" }] }'),
    ),
  );

  await expectConfigError('a non-boolean enable is rejected', async () =>
    loadConfig(await writeConfig('{ "models": [{ "enable": "yes", "model": "x" }] }')),
  );

  await expectConfigError('an empty models array is rejected', async () =>
    loadConfig(await writeConfig('{ "models": [] }')),
  );

  await expectConfigError('a non-array models is rejected', async () =>
    loadConfig(await writeConfig('{ "models": { "enable": true } }')),
  );

  await expectConfigError('a non-object entry is rejected', async () =>
    loadConfig(await writeConfig('{ "models": ["us.anthropic.claude-sonnet-4-6"] }')),
  );

  // The two halves of the file may not overlap: with entries present there is no
  // precedence rule for a root-level model key, so it is refused by name.
  const strayModelKey = await expectConfigError('a model key beside "models" is rejected', async () =>
    loadConfig(
      await writeConfig(
        '{ "model": "us.anthropic.claude-sonnet-4-6", "models": [{ "enable": true, "model": "x" }] }',
      ),
    ),
  );
  assert('the error names the stray key', strayModelKey.includes('"model"'));
  assert('…and says where it belongs', /inside a "models" entry/.test(strayModelKey));

  const straySessionKey = await expectConfigError('a session key inside an entry is rejected', async () =>
    loadConfig(
      await writeConfig('{ "models": [{ "enable": true, "model": "x", "permissionMode": "yolo" }] }'),
    ),
  );
  assert('the error names the misplaced key', straySessionKey.includes('"permissionMode"'));
  assert('…and says to move it to the top level', /top level/.test(straySessionKey));

  // Entry fields go through exactly the same validators as the flat form, so a
  // bad value is caught with the entry's position in the message.
  const badEffort = await expectConfigError('an entry is validated like the flat form', async () =>
    loadConfig(
      await writeConfig('{ "models": [{ "enable": true, "model": "x", "thinkingEffort": "turbo" }] }'),
    ),
  );
  assert('the error points at the entry', badEffort.includes('models[0]'));

  const badMantle = await expectConfigError('per-entry cross-field rules still apply', async () =>
    loadConfig(
      await writeConfig(
        '{ "models": [{ "enable": true, "provider": "bedrock", "model": "us.anthropic.claude-sonnet-4-6", "bedrockMantle": true }] }',
      ),
    ),
  );
  assert('the cross-field error points at the entry', badMantle.includes('models[0]'));

  // /effort must persist into the enabled entry: written to the root it would be
  // rejected on the next load as a stray model key.
  const effortRoot = await writeConfig(twoModels(false, true));
  await saveThinkingEffort(effortRoot, 'low');
  const persisted = JSON.parse(await readFile(configPath(effortRoot), 'utf8')) as {
    thinkingEffort?: string;
    models: { model: string; thinkingEffort?: string }[];
  };
  assert('the level lands on the enabled entry', persisted.models[1]?.thinkingEffort === 'low');
  assert('…not on the root', persisted.thinkingEffort === undefined);
  assert('…and not on the disabled entry', persisted.models[0]?.thinkingEffort === 'xhigh');
  assert('the file still loads afterwards', (await loadConfig(effortRoot)).thinkingEffort === 'low');
}

/**
 * The catalogue `/model` switches between, and the file write behind it. The
 * command's own resolution and rendering are covered by `verify-model-command.ts`;
 * this is the config side.
 */
async function modelCatalogue(): Promise<void> {
  header('config — model catalogue and switching');

  const file = JSON.stringify({
    models: [
      { enable: true, name: 'opus', provider: 'bedrock', model: 'global.anthropic.claude-opus-5' },
      {
        enable: false,
        name: 'sol',
        provider: 'openai',
        model: 'openai.gpt-5.6-sol',
        bedrockMantle: true,
        openaiApi: 'responses',
        region: 'us-east-1',
      },
    ],
  });

  const config = await loadConfig(await writeConfig(file));
  assert('every entry is listed, in file order', config.modelChoices.length === 2);
  assert('…with its index', config.modelChoices.map((c) => c.index).join() === '0,1');
  assert('…and its name', config.modelChoices.map((c) => c.name).join() === 'opus,sol');
  assert('exactly one is marked enabled', config.modelChoices.filter((c) => c.enabled).length === 1);
  assert('the enabled one is the one in effect', config.modelChoices[0]?.enabled === true);
  // The disabled entry's fields have to be complete, since /model builds from them
  // without re-reading the file.
  assert('a disabled entry carries its own fields', config.modelChoices[1]?.fields.bedrockMantle === true);
  assert('…including defaults it did not set', config.modelChoices[1]?.fields.maxTokens === 64_000);

  // The single-model form must present the same shape, so the runtime never has to
  // ask which form the file used.
  const flat = await loadConfig(await writeConfig('{ "model": "us.anthropic.claude-sonnet-4-6" }'));
  assert('the flat form is a one-entry catalogue', flat.modelChoices.length === 1);
  assert('…enabled', flat.modelChoices[0]?.enabled === true);
  assert('…named after its model id', flat.modelChoices[0]?.name === 'us.anthropic.claude-sonnet-4-6');

  // A name is what /model addresses, so a duplicate would hide an entry.
  const duplicate = await expectConfigError('duplicate names are rejected', async () =>
    loadConfig(
      await writeConfig(
        '{ "models": [{ "enable": true, "name": "x", "model": "a" }, { "name": "X", "model": "b" }] }',
      ),
    ),
  );
  assert('the duplicate error names both positions', /models\[0\] and models\[1\]/.test(duplicate));

  // Every entry is validated at load, not at switch time: a broken disabled entry
  // would otherwise turn /model into a failure mid-session.
  const badDisabled = await expectConfigError('a broken disabled entry is rejected at load', async () =>
    loadConfig(
      await writeConfig(
        '{ "models": [{ "enable": true, "model": "us.anthropic.claude-sonnet-4-6" }, ' +
          '{ "model": "b", "thinkingEffort": "turbo" }] }',
      ),
    ),
  );
  assert('…naming the entry that is broken', badDisabled.includes('models[1]'));

  // Switching rewrites the switch itself: one true, the rest explicitly false.
  const switchRoot = await writeConfig(file);
  await saveEnabledModel(switchRoot, 1);
  const after = JSON.parse(await readFile(configPath(switchRoot), 'utf8')) as {
    models: { name: string; enable: boolean }[];
  };
  assert('the target is switched on', after.models[1]?.enable === true);
  assert('the previous one is switched off explicitly', after.models[0]?.enable === false);
  const reloaded = await loadConfig(switchRoot);
  assert('reloading picks the new model', reloaded.model === 'openai.gpt-5.6-sol');
  assert('…and its transport', reloaded.bedrockMantle === true && reloaded.region === 'us-east-1');

  await expectConfigError('enabling an out-of-range entry is refused', () =>
    saveEnabledModel(switchRoot, 7),
  );

  // Nothing to switch between in the flat form, and saying so beats writing a
  // "models" array the user never asked for.
  const flatRoot = await writeConfig('{ "model": "us.anthropic.claude-sonnet-4-6" }');
  const flatSwitch = await expectConfigError('switching a single-model file is refused', () =>
    saveEnabledModel(flatRoot, 0),
  );
  assert('…and it says how to get a catalogue', flatSwitch.includes('"models"'));
}

async function contextWarnRatioField(): Promise<void> {
  header('config — contextWarnRatio field');
  const def = await loadConfig(await writeConfig('{}'));
  assert('default is 0.8', def.contextWarnRatio === 0.8);
  const off = await loadConfig(await writeConfig('{ "contextWarnRatio": 0 }'));
  assert('0 is accepted (disables the warning)', off.contextWarnRatio === 0);
  const custom = await loadConfig(await writeConfig('{ "contextWarnRatio": 0.9 }'));
  assert('a value between 0 and 1 is accepted', custom.contextWarnRatio === 0.9);
  await expectConfigError('a value above 1 is rejected', async () =>
    loadConfig(await writeConfig('{ "contextWarnRatio": 1.1 }')),
  );
  await expectConfigError('a negative value is rejected', async () =>
    loadConfig(await writeConfig('{ "contextWarnRatio": -0.1 }')),
  );
}

async function contextOffloadFields(): Promise<void> {
  header('config — context offload fields');
  const def = await loadConfig(await writeConfig('{}'));
  assert('contextOffload is absent (off) by default', def.contextOffload === undefined);
  assert('maxResultTokens is absent by default', def.maxResultTokens === undefined);

  const on = await loadConfig(await writeConfig('{ "contextOffload": true }'));
  assert('the flag is accepted', on.contextOffload === true);

  const sized = await loadConfig(
    await writeConfig('{ "contextOffload": true, "maxResultTokens": 4000 }'),
  );
  assert('a threshold alongside the flag is accepted', sized.maxResultTokens === 4000);

  // Rejected rather than ignored: a threshold the user believes is in effect but
  // is not looks exactly like the bloat it was written to bound.
  const orphan = await expectConfigError('a threshold without the flag is refused', async () =>
    loadConfig(await writeConfig('{ "maxResultTokens": 4000 }')),
  );
  assert('…and the error names the flag it needs', orphan.includes('contextOffload'));
  await expectConfigError('a zero threshold is refused', async () =>
    loadConfig(await writeConfig('{ "contextOffload": true, "maxResultTokens": 0 }')),
  );

  // The offloader keeps an inline preview per offloaded result and rejects a
  // threshold that does not clear it. Caught as a ConfigError here rather than a
  // raw constructor throw at startup.
  const atPreview = await expectConfigError(
    'a threshold equal to the preview size is refused',
    async () =>
      loadConfig(
        await writeConfig(`{ "contextOffload": true, "maxResultTokens": ${OFFLOAD_PREVIEW_TOKENS} }`),
      ),
  );
  assert('…and the error states the limit', atPreview.includes(String(OFFLOAD_PREVIEW_TOKENS)));
  assert('…and names the smallest usable value',
    atPreview.includes(String(OFFLOAD_PREVIEW_TOKENS + 1)));
  assert('…and says why the floor exists', /preview/i.test(atPreview));

  await expectConfigError('a threshold below the preview size is refused', async () =>
    loadConfig(await writeConfig('{ "contextOffload": true, "maxResultTokens": 1 }')),
  );

  const justAbove = await loadConfig(
    await writeConfig(`{ "contextOffload": true, "maxResultTokens": ${OFFLOAD_PREVIEW_TOKENS + 1} }`),
  );
  assert('the smallest usable threshold is accepted',
    justAbove.maxResultTokens === OFFLOAD_PREVIEW_TOKENS + 1);
}

async function trajectoryField(): Promise<void> {
  header('config — session trajectory recording');
  const def = await loadConfig(await writeConfig('{}'));
  // Absent means on: the loader stores only what the file said, so the recorder
  // treats `undefined` and `true` alike and `false` stays distinguishable.
  assert('trajectory is absent by default (recording is on)', def.trajectory === undefined);

  const off = await loadConfig(await writeConfig('{ "trajectory": false }'));
  assert('recording can be switched off', off.trajectory === false);
  const on = await loadConfig(await writeConfig('{ "trajectory": true }'));
  assert('recording can be asked for explicitly', on.trajectory === true);

  await expectConfigError('a non-boolean trajectory value is refused', async () =>
    loadConfig(await writeConfig('{ "trajectory": "yes" }')),
  );

  // Session-scoped, so it must survive /model and must be refused inside an entry:
  // recording that silently applied to one model and not another would be a lie the
  // record itself could not reveal.
  const withModels = await loadConfig(
    await writeConfig(
      '{ "trajectory": false, "models": [{ "enable": true, "provider": "bedrock", "model": "global.anthropic.claude-opus-5" }] }',
    ),
  );
  assert('trajectory survives the models array form', withModels.trajectory === false);
  const misplaced = await expectConfigError('trajectory inside a models entry is refused', async () =>
    loadConfig(
      await writeConfig(
        '{ "models": [{ "enable": true, "provider": "bedrock", "model": "global.anthropic.claude-opus-5", "trajectory": true }] }',
      ),
    ),
  );
  assert('…and the error names the key', misplaced.includes('trajectory'));
}

async function diagnosticsField(): Promise<void> {
  header('config — opt-in session diagnostics log');
  const def = await loadConfig(await writeConfig('{}'));
  // Absent means off, the opposite default from `trajectory` and for the reason stated
  // on the field: the SDK's debug output interpolates provider payloads, so a log
  // nobody asked for could put conversation-derived material on disk.
  assert('diagnostics is absent by default (the log is off)', def.diagnostics === undefined);

  const on = await loadConfig(await writeConfig('{ "diagnostics": true }'));
  assert('the log can be asked for', on.diagnostics === true);
  const off = await loadConfig(await writeConfig('{ "diagnostics": false }'));
  assert('…and switched off explicitly, which stays distinguishable from absent', off.diagnostics === false);

  const bad = await expectConfigError('a non-boolean diagnostics value is refused', async () =>
    loadConfig(await writeConfig('{ "diagnostics": "verbose" }')),
  );
  assert('…and the error names the field', bad.includes('diagnostics'));

  // Session-scoped like `trajectory`: it must survive `/model`, and an entry carrying
  // it is refused rather than ignored — a log that silently applied to one model and
  // not another is exactly the kind of surprise a debugging tool must not spring.
  const withModels = await loadConfig(
    await writeConfig(
      '{ "diagnostics": true, "models": [{ "enable": true, "provider": "bedrock", "model": "global.anthropic.claude-opus-5" }] }',
    ),
  );
  assert('diagnostics survives the models array form', withModels.diagnostics === true);
  const misplaced = await expectConfigError('diagnostics inside a models entry is refused', async () =>
    loadConfig(
      await writeConfig(
        '{ "models": [{ "enable": true, "provider": "bedrock", "model": "global.anthropic.claude-opus-5", "diagnostics": true }] }',
      ),
    ),
  );
  assert('…and that error names the key too', misplaced.includes('diagnostics'));

  // A model switch keeps it, which is what "session-scoped" has to mean in practice.
  const switched = withModelChoice(withModels, withModels.modelChoices[0]!);
  assert('a /model switch preserves it', switched.diagnostics === true);
}

async function main(): Promise<void> {
  await defaults();
  await regionFallback();
  await providerSwitching();
  await modelArray();
  await modelCatalogue();
  await rejections();
  await requestTimeout();
  await contextWarnRatioField();
  await contextOffloadFields();
  await trajectoryField();
  await diagnosticsField();
  await permissionModes();
  await permissionRules();
  await toolHooks();
  report();
}

await main();
