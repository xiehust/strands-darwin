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
  DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MODEL_KEYS,
  OFFLOAD_PREVIEW_TOKENS,
  DEFAULT_MAX_RESULT_TOKENS,
  SESSION_KEYS,
  appendAllowRule,
  configPath,
  createModelFromConfig,
  loadConfig,
  loadProjectPolicy,
  permissionRulesPath,
  saveEnabledModel,
  saveThinkingEffort,
  openAIContextWindowLimit,
  resolveAnthropicBaseUrl,
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
  assert('learned project memory is enabled when the config file is missing', config.memory === true);
  assert('durable context offload is enabled when the config file is missing', config.contextOffload === true);

  // The preset is a catalogue, not a lone model: with no file at all `/model` must
  // still have something to switch between, and the entry in effect must be the
  // same one the flat fallbacks name.
  const names = config.modelChoices.map((choice) => choice.name);
  console.log(`  catalogue: ${names.join(', ')}`);
  assert('the defaults offer the whole preset catalogue', config.modelChoices.length === 6);
  assert(
    'the defaults include Claude Fable 5.1',
    config.modelChoices.some((choice) => choice.fields.model === 'global.anthropic.claude-fable-5-1'),
  );
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

  // The first /model switch in a new installation must materialize the preset
  // catalogue rather than treating the still-missing file as an explicit flat config.
  await saveEnabledModel(ROOT, 5);
  const savedDefaults = JSON.parse(await readFile(configPath(ROOT), 'utf8')) as {
    models: { name?: string; model?: string; enable?: boolean }[];
  };
  assert('the first preset switch creates the full models array', savedDefaults.models.length === 6);
  assert('the selected preset is enabled in the new file', savedDefaults.models[5]?.enable === true);
  assert(
    'every other preset is explicitly disabled in the new file',
    savedDefaults.models.slice(0, 5).every((entry) => entry.enable === false),
  );
  const savedDefaultReload = await loadConfig(ROOT);
  assert('the first preset switch survives a reload', savedDefaultReload.model === 'openai.gpt-5.6-sol');

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

  // The Anthropic peer *is* installed, so the config path reaches the real
  // constructor. The base URL decision is darwin's (`baseUrl` → ANTHROPIC_BASE_URL
  // → client default), so it is asserted here without any network.
  const savedAnthropicKey = process.env['ANTHROPIC_API_KEY'];
  const savedAnthropicBase = process.env['ANTHROPIC_BASE_URL'];
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['ANTHROPIC_BASE_URL'];
  try {
    const anthropic = await loadConfig(
      await writeConfig('{ "provider": "anthropic", "model": "claude-sonnet-4-6" }'),
    );
    assert('anthropic is selected from config', anthropic.provider === 'anthropic');
    const keyless = await expectConfigError(
      'anthropic without a credential is refused as a ConfigError',
      () => createModelFromConfig(anthropic),
    );
    assert('the refusal names ANTHROPIC_API_KEY and apiKeyEnv', keyless.includes('ANTHROPIC_API_KEY') && keyless.includes('apiKeyEnv'));
    assert('no base URL resolves with neither baseUrl nor env', resolveAnthropicBaseUrl(anthropic) === undefined);

    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
    const anthropicModel = await createModelFromConfig(anthropic);
    assert('anthropic builds once ANTHROPIC_API_KEY is set', anthropicModel !== undefined);
    // The SDK's own cacheConfig carries the three cache points (tools, system
    // prompt, last user message); darwin only hands it the shared TTL.
    const anthropicCache = (anthropicModel.getConfig() as { cacheConfig?: unknown }).cacheConfig;
    assert('anthropic gets a cacheConfig with no TTL by default', JSON.stringify(anthropicCache) === '{}');
    const hourly = await loadConfig(
      await writeConfig('{ "provider": "anthropic", "model": "claude-sonnet-4-6", "promptCacheTtl": "1h" }'),
    );
    const hourlyCache = ((await createModelFromConfig(hourly)).getConfig() as { cacheConfig?: unknown }).cacheConfig;
    assert('promptCacheTtl reaches the anthropic cacheConfig', JSON.stringify(hourlyCache) === JSON.stringify({ ttl: '1h' }));
    const uncached = await loadConfig(
      await writeConfig('{ "provider": "anthropic", "model": "claude-sonnet-4-6", "promptCache": false }'),
    );
    const uncachedCache = ((await createModelFromConfig(uncached)).getConfig() as { cacheConfig?: unknown }).cacheConfig;
    assert('promptCache: false leaves anthropic without a cacheConfig', uncachedCache === undefined);

    process.env['ANTHROPIC_BASE_URL'] = 'https://relay.example.test';
    assert('ANTHROPIC_BASE_URL is used when baseUrl is absent', resolveAnthropicBaseUrl(anthropic) === 'https://relay.example.test');
    assert('anthropic builds against the env base URL', (await createModelFromConfig(anthropic)) !== undefined);

    const withBase = await loadConfig(
      await writeConfig(
        '{ "provider": "anthropic", "model": "claude-sonnet-4-6", "baseUrl": "https://gateway.example.test/v1" }',
      ),
    );
    assert('baseUrl is accepted for anthropic', withBase.baseUrl === 'https://gateway.example.test/v1');
    assert('baseUrl wins over ANTHROPIC_BASE_URL', resolveAnthropicBaseUrl(withBase) === 'https://gateway.example.test/v1');
    assert('anthropic builds against the configured base URL', (await createModelFromConfig(withBase)) !== undefined);
    assert('baseUrl is a model key', (MODEL_KEYS as readonly string[]).includes('baseUrl'));

    const badUrl = await expectConfigError(
      'a non-http(s) baseUrl is refused',
      async () => loadConfig(await writeConfig('{ "provider": "anthropic", "model": "claude-sonnet-4-6", "baseUrl": "gateway.example.test" }')),
    );
    assert('the refusal names baseUrl and the value', badUrl.includes('"baseUrl"') && badUrl.includes('gateway.example.test'));
    for (const provider of ['bedrock', 'openai']) {
      const model = provider === 'bedrock' ? 'global.anthropic.claude-sonnet-4-6' : 'gpt-5';
      const wrongProvider = await expectConfigError(
        `baseUrl on provider ${provider} is refused`,
        async () => loadConfig(await writeConfig(`{ "provider": "${provider}", "model": "${model}", "baseUrl": "https://x.example.test" }`)),
      );
      assert(`the ${provider} refusal names the anthropic-only rule`, wrongProvider.includes('only applies to provider "anthropic"'));
    }
  } finally {
    if (savedAnthropicKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedAnthropicKey;
    if (savedAnthropicBase === undefined) delete process.env['ANTHROPIC_BASE_URL'];
    else process.env['ANTHROPIC_BASE_URL'] = savedAnthropicBase;
  }

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

  // Rules live in their own project-scoped file, so the user's own settings in
  // the global config have to be untouched by the write. (An unknown
  // forward-compatibility key used to sit here; unknown keys are now refused —
  // see unknownKeys() — so a known one stands in.)
  const root = await writeConfig(
    '{\n  "model": "us.anthropic.claude-sonnet-4-6",\n  "thinkingEffort": "low"\n}\n',
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
  const untouched = await loadConfig(root);
  assert('application config is unchanged by rule persistence',
    untouched.model === 'us.anthropic.claude-sonnet-4-6' && untouched.thinkingEffort === 'low');

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
    TurnComplete: [{ matcher: 'interactive', hooks: [{ type: 'command', command: './done.sh' }] }],
    PermissionRequest: [{ matcher: 'parent', hooks: [{ type: 'command', command: './notify.sh' }] }],
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
    ['unknown group field', { TurnComplete: [{ matcher: '*', extra: true, hooks: [{ type: 'command', command: 'true' }] }] }, '.extra'],
    ['unknown command field', { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'true', extra: true }] }] }, '.extra'],
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

async function memoryHorizonField(): Promise<void> {
  header('config — generated memory horizon');
  const def = await loadConfig(await writeConfig('{}'));
  assert('generated memory expires after 28 days by default', def.memoryHorizonDays === 28);
  const off = await loadConfig(await writeConfig('{ "memoryHorizonDays": 0 }'));
  assert('0 deliberately disables age expiry', off.memoryHorizonDays === 0);
  const custom = await loadConfig(await writeConfig('{ "memoryHorizonDays": 90 }'));
  assert('a conservative whole-day override is accepted', custom.memoryHorizonDays === 90);
  for (const value of ['-1', '366', '1.5', '"28"', 'true']) {
    await expectConfigError(`invalid memory horizon ${value} is rejected`, async () =>
      loadConfig(await writeConfig(`{ "memoryHorizonDays": ${value} }`)),
    );
  }
  const misplaced = await expectConfigError('memory horizon is rejected inside a model entry', async () =>
    loadConfig(await writeConfig('{ "models": [{ "model": "global.anthropic.claude-opus-5", "enable": true, "memoryHorizonDays": 7 }] }')),
  );
  assert('the misplaced error names the top-level key', misplaced.includes('memoryHorizonDays') && misplaced.includes('top level'));
  const switched = withModelChoice(custom, custom.modelChoices[0]!);
  assert('a /model switch preserves the generated memory horizon', switched.memoryHorizonDays === 90);
}

async function maxConcurrentSubagentsField(): Promise<void> {
  header('config — maxConcurrentSubagents field');
  const def = await loadConfig(await writeConfig('{}'));
  assert(`default is ${DEFAULT_MAX_CONCURRENT_SUBAGENTS}`,
    def.maxConcurrentSubagents === 8 && def.maxConcurrentSubagents === DEFAULT_MAX_CONCURRENT_SUBAGENTS);
  const custom = await loadConfig(await writeConfig('{ "maxConcurrentSubagents": 3 }'));
  assert('a positive whole-number override is accepted', custom.maxConcurrentSubagents === 3);
  const wide = await loadConfig(await writeConfig('{ "maxConcurrentSubagents": 64 }'));
  assert('there is no upper bound', wide.maxConcurrentSubagents === 64);
  for (const value of ['0', '-1', '1.5', '"8"']) {
    const message = await expectConfigError(`invalid cap ${value} is a ConfigError (refuses to start)`, async () =>
      loadConfig(await writeConfig(`{ "maxConcurrentSubagents": ${value} }`)),
    );
    assert(`the ${value} error names the field`, message.includes('maxConcurrentSubagents'));
  }
  const misplaced = await expectConfigError('the cap is rejected inside a model entry', async () =>
    loadConfig(await writeConfig('{ "models": [{ "model": "global.anthropic.claude-opus-5", "enable": true, "maxConcurrentSubagents": 2 }] }')),
  );
  assert('the misplaced error names the top-level key', misplaced.includes('maxConcurrentSubagents') && misplaced.includes('top level'));
  const switched = withModelChoice(custom, custom.modelChoices[0]!);
  assert('a /model switch preserves the cap', switched.maxConcurrentSubagents === 3);
}


async function contextOffloadFields(): Promise<void> {
  header('config — context offload fields');

  const def = await loadConfig(await writeConfig('{}'));
  assert('contextOffload is on by default', def.contextOffload === true);
  assert(
    'maxResultTokens defaults to the darwin threshold, not the SDK 2500',
    def.maxResultTokens === DEFAULT_MAX_RESULT_TOKENS,
  );

  const off0 = await loadConfig(await writeConfig('{ "contextOffload": false }'));
  assert(
    'no threshold is resolved when offloading is off — absence, not a contradiction',
    off0.maxResultTokens === undefined,
  );

  const on = await loadConfig(await writeConfig('{ "contextOffload": true }'));
  assert('the flag is accepted', on.contextOffload === true);

  const off = await loadConfig(await writeConfig('{ "contextOffload": false }'));
  assert('explicit false persistently opts out', off.contextOffload === false);

  const switchedOff = withModelChoice(off, off.modelChoices[0]!);
  assert('a /model switch preserves the persistent opt-out', switchedOff.contextOffload === false);

  const sizedByDefault = await loadConfig(await writeConfig('{ "maxResultTokens": 4000 }'));
  assert('a threshold is accepted with default-on offload', sizedByDefault.maxResultTokens === 4000);

  const sizedExplicitly = await loadConfig(
    await writeConfig('{ "contextOffload": true, "maxResultTokens": 4000 }'),
  );
  assert('a threshold alongside explicit true is accepted', sizedExplicitly.maxResultTokens === 4000);

  // Rejected rather than ignored only for an explicit opt-out: a threshold the
  // user believes is in effect must never silently coexist with disabled offload.
  const incompatible = await expectConfigError('a threshold with explicit false is refused', async () =>
    loadConfig(await writeConfig('{ "contextOffload": false, "maxResultTokens": 4000 }')),
  );
  assert('…and the error names the conflicting flag', incompatible.includes('contextOffload'));
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

async function memoryField(): Promise<void> {
  header('config — learned project memory');

  const defaultOn = await loadConfig(await writeConfig('{}'));
  assert('omitting memory enables learned project memory', defaultOn.memory === true);

  const off = await loadConfig(await writeConfig('{ "memory": false }'));
  assert('explicit false opts out of learned project memory', off.memory === false);

  const implicitOff = await loadConfig(await writeConfig('{ "trajectory": false }'));
  assert('omitted memory follows an explicit trajectory opt-out',
    implicitOff.trajectory === false && implicitOff.memory === false);

  const incompatible = await expectConfigError('explicit memory requires its trajectory source', async () =>
    loadConfig(await writeConfig('{ "memory": true, "trajectory": false }')),
  );
  assert('the incompatible error names both fields',
    incompatible.includes('memory') && incompatible.includes('trajectory'));

  const bad = await expectConfigError('a non-boolean memory value is refused', async () =>
    loadConfig(await writeConfig('{ "memory": "yes" }')),
  );
  assert('the invalid memory error explains the boolean shape',
    bad.includes('memory') && bad.includes('true or false'));

  const misplaced = await expectConfigError('memory inside a models entry is refused', async () =>
    loadConfig(await writeConfig(
      '{ "models": [{ "enable": true, "provider": "bedrock", "model": "global.anthropic.claude-opus-5", "memory": false }] }',
    )),
  );
  assert('the misplaced memory error names the top-level placement',
    misplaced.includes('memory') && misplaced.includes('top level'));

  const switched = withModelChoice(defaultOn, defaultOn.modelChoices[0]!);
  assert('a /model switch preserves default-on memory', switched.memory === true);
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

async function terminalBellField(): Promise<void> {
  header('config — terminal attention bell');
  const def = await loadConfig(await writeConfig('{}'));
  // Off by default: a signal nobody asked for is an annoyance, and the default
  // path must stay byte-identical to before the feature existed.
  assert('the bell is off by default', def.terminalBell === false);

  const on = await loadConfig(await writeConfig('{ "terminalBell": true }'));
  assert('the bell can be switched on', on.terminalBell === true);
  const off = await loadConfig(await writeConfig('{ "terminalBell": false }'));
  assert('explicit false is accepted', off.terminalBell === false);

  const bad = await expectConfigError('a non-boolean terminalBell value is refused', async () =>
    loadConfig(await writeConfig('{ "terminalBell": "loud" }')),
  );
  assert('…and the error names the field', bad.includes('terminalBell'));

  // Session-scoped: it survives /model, and a models entry carrying it is refused
  // rather than ignored — a bell that silently applied to one model and not
  // another would ring (or stay silent) against the file's stated intent.
  const withModels = await loadConfig(
    await writeConfig(
      '{ "terminalBell": true, "models": [{ "enable": true, "provider": "bedrock", "model": "global.anthropic.claude-opus-5" }] }',
    ),
  );
  assert('terminalBell survives the models array form', withModels.terminalBell === true);
  const misplaced = await expectConfigError('terminalBell inside a models entry is refused', async () =>
    loadConfig(
      await writeConfig(
        '{ "models": [{ "enable": true, "provider": "bedrock", "model": "global.anthropic.claude-opus-5", "terminalBell": true }] }',
      ),
    ),
  );
  assert('…and that error names the key', misplaced.includes('terminalBell'));

  const switched = withModelChoice(withModels, withModels.modelChoices[0]!);
  assert('a /model switch preserves the bell', switched.terminalBell === true);
}

/**
 * Unknown keys are refused, not ignored (SER-049). A key in neither half of the
 * schema is never read, so before this a misspelled `thinkingEfort` loaded
 * cleanly and silently kept the default — the exact silent no-op the config
 * rows of `error-handling.md` exist to prevent.
 */
async function unknownKeys(): Promise<void> {
  header('config — unknown keys are refused, naming the key, its place and the nearest known key');

  const file = configPath(ROOT);

  const misspelled = await expectConfigError('a misspelled root key is refused', async () =>
    loadConfig(await writeConfig('{ "thinkingEfort": "high", "promptCache": true }')),
  );
  assert('the error names the config file', misspelled.startsWith(`${file}: `));
  assert('…and the unknown key', misspelled.includes('"thinkingEfort"'));
  assert('…and where it was found', misspelled.includes('at the top level'));
  assert('…and suggests the key that was meant', misspelled.includes('did you mean "thinkingEffort"?'));
  assert('…and says why it is refused rather than ignored', /refused rather than ignored/.test(misspelled));

  const entryKey = await expectConfigError('an unknown key inside a models entry is refused', async () =>
    loadConfig(
      await writeConfig(
        JSON.stringify({
          models: [
            { enable: true, name: 'opus', model: 'global.anthropic.claude-opus-5' },
            { enable: false, name: 'gpt-5.6-sol', provider: 'openai', model: 'openai.gpt-5.6-sol', temprature: 0.2 },
          ],
        }),
      ),
    ),
  );
  assert('the entry error names the key', entryKey.includes('"temprature"'));
  assert('…and the entry position', entryKey.includes('in models[1]'));
  assert('…and the entry name', entryKey.includes('models[1] ("gpt-5.6-sol")'));
  assert('…without a suggestion when nothing is close', !entryKey.includes('did you mean'));

  // No escape hatch: the file has one reader, so a tolerated `$schema` would be
  // the first accepted-but-ignored key of the class this check removes.
  const schema = await expectConfigError('a stray "$schema" at the root is refused', async () =>
    loadConfig(await writeConfig('{ "$schema": "https://example.invalid/darwin.json", "model": "x" }')),
  );
  assert('the "$schema" error names the key', schema.includes('"$schema"') && schema.includes('at the top level'));
  assert('…without a suggestion', !schema.includes('did you mean'));

  const two = await expectConfigError('two unknown keys are reported together', async () =>
    loadConfig(
      await writeConfig(
        '{ "permisionMode": "yolo", "models": [{ "enable": true, "model": "x", "maxToken": 100 }] }',
      ),
    ),
  );
  assert('one message names the root key', two.includes('"permisionMode" at the top level (did you mean "permissionMode"?)'));
  assert('…and the entry key', two.includes('"maxToken" in models[0] (did you mean "maxTokens"?)'));
  assert('…in the plural', two.includes('unknown keys ') && two.endsWith('remove them.'));
  assert('…an unnamed entry is addressed by position alone', !two.includes('models[0] ("'));

  // Near misses: a transposition (Damerau) and a case slip both resolve.
  const transposed = await expectConfigError('a transposed key gets a suggestion', async () =>
    loadConfig(await writeConfig('{ "promptCahce": false }')),
  );
  assert('the transposition suggests promptCache', transposed.includes('did you mean "promptCache"?'));

  const lowercase = await expectConfigError('a case slip is still an unknown key', async () =>
    loadConfig(await writeConfig('{ "permissionmode": "yolo" }')),
  );
  assert('…with the correctly cased key suggested', lowercase.includes('did you mean "permissionMode"?'));

  const far = await expectConfigError('an unknown key with no close match is refused', async () =>
    loadConfig(await writeConfig('{ "favouriteColour": "green" }')),
  );
  assert('…without a suggestion', far.includes('"favouriteColour" at the top level') && !far.includes('did you mean'));
  assert('…in the singular', far.includes('unknown key "favouriteColour"') && far.endsWith('remove it.'));

  // `enable` is array-form only, so at the root it is as unknown as any typo.
  const enableAtRoot = await expectConfigError('"enable" at the root is unknown', async () =>
    loadConfig(await writeConfig('{ "enable": true, "model": "x" }')),
  );
  assert('the root "enable" error names it', enableAtRoot.includes('"enable" at the top level'));

  // Precedence: the misplaced-known-key messages are more specific and win when
  // both problems are present, and their wording is unchanged.
  const misplacedFirst = await expectConfigError('a misplaced known key still gets its own message', async () =>
    loadConfig(
      await writeConfig('{ "model": "x", "bogus": 1, "models": [{ "enable": true, "model": "y", "nope": 1 }] }'),
    ),
  );
  assert(
    'the misplaced message wins over the unknown-key message',
    /"model" belongs inside a "models" entry, not next to "models"/.test(misplacedFirst) &&
      !misplacedFirst.includes('unknown key'),
  );
  const sessionInEntry = await expectConfigError('a session key in an entry still gets its own message', async () =>
    loadConfig(
      await writeConfig('{ "bogus": 1, "models": [{ "enable": true, "model": "y", "trajectory": false }] }'),
    ),
  );
  assert(
    'the entry message is unchanged and wins',
    /models\[0\] carries "trajectory", which applies to the whole session/.test(sessionInEntry) &&
      !sessionInEntry.includes('unknown key'),
  );

  // Bounded: a pasted foreign file names at most ten keys and counts the rest.
  const flood: Record<string, number> = {};
  for (let i = 0; i < 14; i++) flood[`zzz_unknown_${i}`] = i;
  const flooded = await expectConfigError('many unknown keys are refused in one bounded message', async () =>
    loadConfig(await writeConfig(JSON.stringify(flood))),
  );
  assert('…naming ten and counting the rest', flooded.includes('"zzz_unknown_9"') &&
    !flooded.includes('"zzz_unknown_10"') && flooded.includes('… and 4 more'));
}

/**
 * The documented key tables and the schema must agree in both directions: with
 * unknown keys refused, a documented key the schema lacks is a setting nobody
 * can write, and a schema key the docs lack is a setting nobody can find.
 */
async function contextWindowLimitField(): Promise<void> {
  header('config — contextWindowLimit overrides the SDK and Mantle tables');

  const windowOf = (model: Model): number | undefined =>
    (model.getConfig() as { contextWindowLimit?: number }).contextWindowLimit;

  // Absent: the SDK table decides, and an id it does not know stays unknown.
  const known = await loadConfig(await writeConfig('{ "provider": "bedrock", "model": "global.anthropic.claude-sonnet-4-6" }'));
  assert('an SDK-known bedrock id resolves its window from the table', windowOf(await createModelFromConfig(known)) === 1_000_000);
  const unknown = await loadConfig(await writeConfig('{ "provider": "bedrock", "model": "us.example.mystery-model-v1" }'));
  assert('an unknown id has no window without the field', windowOf(await createModelFromConfig(unknown)) === undefined);
  assert('the field is absent from the loaded config when unset', unknown.contextWindowLimit === undefined);

  // Present: the explicit value wins on every provider.
  const bedrock = await loadConfig(
    await writeConfig('{ "provider": "bedrock", "model": "us.example.mystery-model-v1", "contextWindowLimit": 400000 }'),
  );
  assert('contextWindowLimit loads as a model field', bedrock.contextWindowLimit === 400000);
  assert('bedrock passes the configured window to the model', windowOf(await createModelFromConfig(bedrock)) === 400000);
  const overridden = await loadConfig(
    await writeConfig('{ "provider": "bedrock", "model": "global.anthropic.claude-sonnet-4-6", "contextWindowLimit": 200000 }'),
  );
  assert('an explicit window beats the SDK table', windowOf(await createModelFromConfig(overridden)) === 200000);

  const savedKey = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
  try {
    const anthropic = await loadConfig(
      await writeConfig('{ "provider": "anthropic", "model": "claude-sonnet-4-6", "contextWindowLimit": 500000 }'),
    );
    assert('anthropic passes the configured window to the model', windowOf(await createModelFromConfig(anthropic)) === 500000);
  } finally {
    if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedKey;
  }

  const mantle = await loadConfig(
    await writeConfig(
      '{ "provider": "openai", "model": "openai.gpt-5.6-sol", "bedrockMantle": true, "openaiApi": "responses", ' +
        '"region": "us-east-1", "contextWindowLimit": 128000 }',
    ),
  );
  assert("an explicit window beats darwin's Mantle table", windowOf(await createModelFromConfig(mantle)) === 128000);

  // Refusals name the key and the rule.
  for (const [what, value, needle] of [
    ['a fractional window is refused', '1000.5', 'whole number'],
    ['a zero window is refused', '0', 'at least 1'],
    ['a string window is refused', '"200k"', 'finite number'],
  ] as const) {
    const message = await expectConfigError(
      what,
      async () => loadConfig(await writeConfig(`{ "provider": "bedrock", "model": "global.anthropic.claude-sonnet-4-6", "contextWindowLimit": ${value} }`)),
    );
    assert(`…and says why (${needle})`, message.includes('"contextWindowLimit"') && message.includes(needle));
  }
}

async function documentedKeys(): Promise<void> {
  header('config — every documented key is known, every known key is documented');

  const docs = ['docs/user-guide/configuration.md', 'docs/user-guide/configuration.zh-CN.md'];
  const expected = new Set<string>([...MODEL_KEYS, ...SESSION_KEYS, 'models', 'enable']);
  for (const doc of docs) {
    const text = await readFile(path.resolve(doc), 'utf8');
    // The two field tables: rows whose first cell is a backticked key. Stops at
    // the next `##` heading so the caching / effort tables are not swept in.
    const tables = /^## (Model fields|模型字段)\n([\s\S]*?)^## (Session fields|会话字段)\n([\s\S]*?)^## /m.exec(text);
    assert(`${doc} has the model and session field tables`, tables !== null);
    if (tables === null) continue;
    const keysOf = (table: string): string[] =>
      [...table.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1] as string);
    const modelDocumented = keysOf(tables[2] as string);
    const sessionDocumented = keysOf(tables[4] as string);
    const documented = new Set([...modelDocumented, ...sessionDocumented]);

    const undocumented = [...expected].filter((key) => !documented.has(key));
    const unknownToSchema = [...documented].filter((key) => !expected.has(key));
    assert(`${doc}: every schema key is documented (${undocumented.join(', ') || 'none missing'})`, undocumented.length === 0);
    assert(`${doc}: every documented key is in the schema (${unknownToSchema.join(', ') || 'none unknown'})`, unknownToSchema.length === 0);
    assert(`${doc}: model table lists only model keys plus models/enable`,
      modelDocumented.every((key) => (MODEL_KEYS as readonly string[]).includes(key) || key === 'models' || key === 'enable'));
    assert(`${doc}: session table lists only session keys`,
      sessionDocumented.every((key) => (SESSION_KEYS as readonly string[]).includes(key)));
    assert(`${doc} states the unknown-key rule`, /unknown key|未知(的)?键|未知字段/i.test(text));
  }

  // And they load: one flat Bedrock file carrying every model and session key
  // (the Bedrock-only `requestTimeoutMs` forces the provider, which excludes the
  // OpenAI-only `openaiApi` and the Anthropic-only `baseUrl` — the latter loads in
  // `providerSwitching`), plus the array form carrying `openaiApi` and
  // `models`/`enable`/`name`. The fixture's key set is asserted against the
  // schema so a key added to either list has to be exercised here too.
  const flatFixture = {
    provider: 'bedrock',
    name: 'sonnet',
    model: 'us.anthropic.claude-sonnet-4-6',
    region: 'us-west-2',
    apiKeyEnv: 'UNUSED_KEY',
    bedrockMantle: false,
    maxTokens: 4096,
    contextWindowLimit: 250000,
    thinkingEffort: 'low',
    promptCache: true,
    promptCacheTtl: '5m',
    classifierModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    requestTimeoutMs: 1000,
    permissionMode: 'plan',
    hooks: {},
    summaryRatio: 0.5,
    preserveRecentMessages: 4,
    contextWarnRatio: 0.7,
    contextOffload: true,
    maxResultTokens: 2000,
    terminalBell: false,
    trajectory: true,
    diagnostics: false,
    memory: true,
    memoryHorizonDays: 7,
    maxConcurrentSubagents: 4,
    systemPrompt: 'You are terse.',
  };
  const flatKeys = [...MODEL_KEYS, ...SESSION_KEYS].filter((key) => key !== 'openaiApi' && key !== 'baseUrl');
  assert(
    'the flat fixture carries every schema key but openaiApi and baseUrl',
    JSON.stringify([...Object.keys(flatFixture)].sort()) === JSON.stringify([...flatKeys].sort()),
  );
  const flat = await loadConfig(await writeConfig(JSON.stringify(flatFixture)));
  assert('a flat file using every documented Bedrock-compatible key loads',
    flat.model === 'us.anthropic.claude-sonnet-4-6' && flat.permissionMode === 'plan' && flat.requestTimeoutMs === 1000);
  assert('the flat file carries its contextWindowLimit', flat.contextWindowLimit === 250000);

  const array = await loadConfig(
    await writeConfig(
      JSON.stringify({
        models: [
          { enable: false, name: 'sonnet', model: 'us.anthropic.claude-sonnet-4-6' },
          {
            enable: true,
            name: 'sol',
            provider: 'openai',
            model: 'openai.gpt-5.6-sol',
            bedrockMantle: true,
            openaiApi: 'responses',
            region: 'us-east-1',
          },
        ],
        permissionMode: 'default',
      }),
    ),
  );
  assert('an array file using models/enable/name and the OpenAI-only keys loads', array.openaiApi === 'responses' && array.name === 'sol');
}

async function main(): Promise<void> {
  await defaults();
  await regionFallback();
  await providerSwitching();
  await modelArray();
  await modelCatalogue();
  await rejections();
  await unknownKeys();
  await documentedKeys();
  await requestTimeout();
  await contextWindowLimitField();
  await contextWarnRatioField();
  await memoryHorizonField();
  await maxConcurrentSubagentsField();
  await contextOffloadFields();
  await memoryField();
  await trajectoryField();
  await diagnosticsField();
  await terminalBellField();
  await permissionModes();
  await permissionRules();
  await toolHooks();
  report();
}

await main();
