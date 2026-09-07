/**
 * Headless mode: config resolution and the flags that gate it.
 *
 * No model calls. Everything here is the part of a headless run that happens
 * before the first token is spent, which is exactly the part whose failures are
 * silent: a config file that was never found still yields a *working* agent, just
 * not the one the caller asked for.
 *
 * Run: pnpm tsx spike/verify-headless.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { ConfigError, configPath, loadConfig, userConfigPath } from '../src/config.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-headless-test';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VALID = JSON.stringify({ provider: 'bedrock', model: 'global.anthropic.claude-opus-5' });

/** Points HOME at a scratch dir so the developer's own config cannot reach a case. */
async function withHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env['HOME'];
  process.env['HOME'] = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previous;
  }
}

async function writeJson(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

async function configPrecedence(): Promise<void> {
  header('headless config — ~/.darwin is opt-in, and never outranks the project');

  await rm(ROOT, { recursive: true, force: true });
  const home = path.join(ROOT, 'home');
  const proj = path.join(ROOT, 'proj');
  await mkdir(proj, { recursive: true });

  await withHome(home, async () => {
    await writeJson(userConfigPath(), VALID);

    // The default: a personal config must not reconfigure an arbitrary repository.
    const withoutOptIn = await loadConfig(proj);
    assert(
      'without the opt-in, ~/.darwin/config.json is ignored',
      withoutOptIn.model === 'us.anthropic.claude-sonnet-4-6',
    );

    const withOptIn = await loadConfig(proj, { includeUserConfig: true });
    assert(
      'with the opt-in, ~/.darwin/config.json is read',
      withOptIn.model === 'global.anthropic.claude-opus-5',
    );

    // A repository that pins its own model keeps winning; the fallback is a
    // fallback, not an override.
    await writeJson(
      configPath(proj),
      JSON.stringify({ provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6' }),
    );
    const both = await loadConfig(proj, { includeUserConfig: true });
    assert('the project config outranks the user config', both.model === 'us.anthropic.claude-sonnet-4-6');
  });
}

async function malformedIsLoud(): Promise<void> {
  header('headless config — a malformed fallback names its own path');

  const home = path.join(ROOT, 'home-bad');
  const proj = path.join(ROOT, 'proj-bad');
  await mkdir(proj, { recursive: true });

  await withHome(home, async () => {
    const userFile = userConfigPath();
    await writeJson(userFile, '{ not json');
    try {
      await loadConfig(proj, { includeUserConfig: true });
      assert('a malformed user config is an error', false);
    } catch (error) {
      assert('a malformed user config is a ConfigError', error instanceof ConfigError);
      assert(
        'the error names the user config, not the project path',
        error instanceof Error && error.message.includes(userFile),
      );
    }
  });
}

async function unknownKeysTolerated(): Promise<void> {
  header('headless config — a newer darwin’s keys are ignored, not rejected');

  const home = path.join(ROOT, 'home-newer');
  const proj = path.join(ROOT, 'proj-newer');
  await mkdir(proj, { recursive: true });

  await withHome(home, async () => {
    // A harness written against a later darwin writes keys this build has never
    // heard of. Tolerating them is what lets one config drive both; the cost is
    // that `thinkingEffort` here is inert, which is why a caller must not read a
    // config file as evidence of the effort a run used.
    await writeJson(
      userConfigPath(),
      JSON.stringify({
        provider: 'bedrock',
        model: 'global.anthropic.claude-opus-5',
        maxTokens: 64_000,
        permissionMode: 'yolo',
        thinkingEffort: 'high',
        promptCache: true,
      }),
    );
    const config = await loadConfig(proj, { includeUserConfig: true });
    assert('an unknown key does not fail the load', config.model === 'global.anthropic.claude-opus-5');
    assert('a key this build does know is still applied', config.maxTokens === 64_000);
    assert('permissionMode is applied', config.permissionMode === 'yolo');
    assert(
      'thinkingEffort is silently absent — this build has no such setting',
      !Object.prototype.hasOwnProperty.call(config, 'thinkingEffort'),
    );
  });
}

/** Runs the real CLI and resolves with its exit code and stderr. */
function runCli(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['tsx', 'src/cli.ts', ...args], {
      cwd: REPO,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function flagsAreCheckedBeforeSpending(): Promise<void> {
  header('headless flags — refused before a single model call');

  // A spend cap this build cannot honour must fail, not be ignored: ignoring it
  // breaches the caller's intent in the one direction they cannot detect after
  // the fact.
  const capped = await runCli(['-p', 'hello', '--max-model-calls', '5']);
  assert('--max-model-calls exits non-zero', capped.code === 1);
  assert('--max-model-calls says it is unsupported', capped.stderr.includes('not supported'));

  const badFormat = await runCli(['-p', 'hello', '--output-format', 'yaml']);
  assert('an unknown --output-format exits non-zero', badFormat.code === 1);
  assert('it lists the formats it accepts', badFormat.stderr.includes('stream-json'));

  const emptyPrompt = await runCli(['-p', '   ']);
  assert('an empty prompt exits non-zero', emptyPrompt.code === 1);

  const missingPrompt = await runCli(['-p', '--yolo']);
  assert('a missing prompt value exits non-zero', missingPrompt.code === 1);

  // Meaningless without -p, so it is a mistake worth surfacing rather than a
  // no-op that leaves the caller thinking they got JSON.
  const formatWithoutPrompt = await runCli(['--output-format', 'stream-json']);
  assert('--output-format without -p exits non-zero', formatWithoutPrompt.code === 1);
}

await configPrecedence();
await malformedIsLoud();
await unknownKeysTolerated();
await flagsAreCheckedBeforeSpending();
report();
