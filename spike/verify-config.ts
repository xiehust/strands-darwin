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

import {
  ConfigError,
  appendAllowRule,
  configPath,
  createModelFromConfig,
  loadConfig,
  resolveRegion,
  saveThinkingEffort,
} from '../src/config.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-config-test';

/**
 * Writes the config where darwin reads it — `<projectRoot>/.darwin/config.json`.
 * Built from `configPath()` so a future move cannot leave this harness testing a
 * path nothing reads.
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

  const config = await loadConfig(ROOT);
  console.log(`  ${config.provider} / ${config.model} (maxTokens ${config.maxTokens})`);

  assert('provider defaults to bedrock', config.provider === 'bedrock');
  assert(
    'model defaults to a cross-region inference profile',
    config.model === 'us.anthropic.claude-sonnet-4-6',
  );
  assert('a missing .darwin/config.json is not an error', true);

  // The old location is deliberately dead: a leftover root config.json must not
  // quietly keep configuring the agent after the move.
  await writeFile(path.join(ROOT, 'config.json'), '{ "model": "us.legacy.should-be-ignored" }', 'utf8');
  const stillDefault = await loadConfig(ROOT);
  assert('a root config.json is no longer read', stillDefault.model === config.model);

  // The model must actually construct from defaults, or "works out of the box" is a lie.
  const model = await createModelFromConfig(config);
  assert('default config builds a working model', model !== undefined);
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
  assert('a global. profile is accepted', (await createModelFromConfig(bedrock)) !== undefined);

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
    const mantleParams = (mantleModel.getConfig() as { params?: Record<string, unknown> }).params;
    console.log(`  mantle params: ${JSON.stringify(mantleParams)}`);
    // The Responses API rejects the flat `reasoning_effort` outright, and Mantle
    // serves the whole ladder — so `max` must arrive nested and unclamped.
    assert(
      'mantle sends nested reasoning.effort, unclamped',
      JSON.stringify(mantleParams) === JSON.stringify({ reasoning: { effort: 'max' } }),
    );

    const chat = await loadConfig(
      await writeConfig(
        '{ "provider": "openai", "model": "gpt-5", "apiKeyEnv": "OPENAI_API_KEY", "thinkingEffort": "max" }',
      ),
    );
    process.env['OPENAI_API_KEY'] = 'sk-test';
    const chatParams = (
      (await createModelFromConfig(chat)).getConfig() as { params?: Record<string, unknown> }
    ).params;
    assert(
      'native openai still sends flat reasoning_effort, clamped to high',
      JSON.stringify(chatParams) === JSON.stringify({ reasoning_effort: 'high' }),
    );
  } finally {
    restoreEnv('OPENAI_API_KEY', savedKey);
  }

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

async function permissionModes(): Promise<void> {
  header('config — permission mode');

  const absent = await loadConfig(await writeConfig('{}'));
  assert('permissionMode defaults to "default"', absent.permissionMode === 'default');

  const auto = await loadConfig(
    await writeConfig('{ "permissionMode": "auto", "classifierModel": "us.anthropic.claude-haiku-4-5" }'),
  );
  assert('a valid permissionMode is accepted', auto.permissionMode === 'auto');
  assert('classifierModel is carried through', auto.classifierModel === 'us.anthropic.claude-haiku-4-5');

  const yolo = await loadConfig(await writeConfig('{ "permissionMode": "yolo" }'));
  assert('yolo is accepted', yolo.permissionMode === 'yolo');

  const badMode = await expectConfigError('an unknown permissionMode is rejected', async () =>
    loadConfig(await writeConfig('{ "permissionMode": "strict" }')),
  );
  assert('the error lists the valid modes', /default, auto, yolo/.test(badMode));

  await expectConfigError('an empty classifierModel is rejected', async () =>
    loadConfig(await writeConfig('{ "classifierModel": "" }')),
  );
}

async function permissionRules(): Promise<void> {
  header('config — permission allow rules');

  const absent = await loadConfig(await writeConfig('{}'));
  assert('permissionRules is absent by default', absent.permissionRules === undefined);

  const loaded = await loadConfig(
    await writeConfig('{ "permissionRules": { "allow": ["bash:pnpm *", "fileEditor:src/**"] } }'),
  );
  assert(
    'rules are carried through in order',
    JSON.stringify(loaded.permissionRules?.allow) === '["bash:pnpm *","fileEditor:src/**"]',
  );

  const emptyRules = await loadConfig(await writeConfig('{ "permissionRules": {} }'));
  assert('permissionRules without "allow" is empty, not an error', emptyRules.permissionRules?.allow.length === 0);

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
  assert('the error shows the expected rule shape', badRule.includes('<tool>:<pattern>'));

  header('config — appending a rule');

  // Merged into the raw JSON: an unknown key from a newer darwin, and the user's
  // own settings, both have to survive the write.
  const root = await writeConfig(
    '{\n  "model": "us.anthropic.claude-sonnet-4-6",\n  "futureSetting": { "keep": true }\n}\n',
  );
  await appendAllowRule(root, 'bash:pnpm *');
  await appendAllowRule(root, 'fileEditor:src/**');
  await appendAllowRule(root, 'bash:pnpm *');

  const written = JSON.parse(await readFile(configPath(root), 'utf8')) as Record<string, unknown>;
  console.log(`  written: ${JSON.stringify(written['permissionRules'])}`);

  const reloaded = await loadConfig(root);
  assert(
    'both rules are persisted, duplicates collapsed',
    JSON.stringify(reloaded.permissionRules?.allow) === '["bash:pnpm *","fileEditor:src/**"]',
  );
  assert('unrelated known keys survive', reloaded.model === 'us.anthropic.claude-sonnet-4-6');
  assert(
    'unknown keys survive',
    JSON.stringify(written['futureSetting']) === '{"keep":true}',
  );

  // The prompt is the only writer today, but a rule that could never match must
  // not reach the file whatever calls it.
  await expectConfigError('appending a malformed rule is refused', () =>
    appendAllowRule(root, 'bash:'),
  );

  // First rule in a project that has no config file at all: the common case.
  const fresh = path.join(ROOT, `fresh-${Math.random().toString(36).slice(2)}`);
  await appendAllowRule(fresh, 'bash');
  const freshConfig = await loadConfig(fresh);
  assert(
    'a missing config file is created with the rule',
    JSON.stringify(freshConfig.permissionRules?.allow) === '["bash"]',
  );
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

async function main(): Promise<void> {
  await defaults();
  await regionFallback();
  await providerSwitching();
  await modelArray();
  await rejections();
  await permissionModes();
  await permissionRules();
  report();
}

await main();
