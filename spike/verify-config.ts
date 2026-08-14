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
  const openaiError = await expectConfigError(
    'openai reports its missing peer dependency as a ConfigError',
    () => createModelFromConfig(openai),
  );
  console.log(`  openai: ${openaiError.split('\n')[0]}`);
  assert('openai error names the package to install', openaiError.includes('openai'));
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

async function main(): Promise<void> {
  await defaults();
  await regionFallback();
  await providerSwitching();
  await rejections();
  await permissionModes();
  await permissionRules();
  report();
}

await main();
