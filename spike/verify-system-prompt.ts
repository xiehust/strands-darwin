/**
 * Unit checks for the base system prompt: the built-in default, the two override
 * mechanisms and their precedence, and how a broken override degrades.
 *
 * No model calls — this is file reading, validation and string assembly. That the
 * base prompt actually steers the model is covered by the live scenarios in
 * spike/verify-step-1-2.ts and spike/acceptance-e2e.ts.
 *
 * Run: pnpm tsx spike/verify-system-prompt.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { composeSystemPrompt, loadProjectInstructions, AGENTS_FILENAME } from '../src/agent/instructions.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  SYSTEM_PROMPT_FILENAME,
  loadSystemPrompt,
} from '../src/agent/system-prompt.js';
import { ConfigError, configPath, loadConfig } from '../src/config.js';
import { darwinDir } from '../src/paths.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const ROOT = '/tmp/darwin-system-prompt';

// The `systemPrompt` cases write the global config through configPath().
const OWNED_HOME = ownPrivateHome('system-prompt');

/** A fresh project directory with a `.darwin/` in place, like a real run has. */
async function project(): Promise<string> {
  const dir = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
  await mkdir(darwinDir(dir), { recursive: true });
  return dir;
}

/** Writes `.darwin/system-prompt.md`, the convention override file. */
async function writeOverride(projectRoot: string, contents: string): Promise<string> {
  const file = path.join(darwinDir(projectRoot), SYSTEM_PROMPT_FILENAME);
  await writeFile(file, contents, 'utf8');
  return file;
}

async function defaultPrompt(): Promise<void> {
  header('system prompt — the built-in default is used when nothing overrides it');

  const loaded = await loadSystemPrompt(await project());

  assert(
    'global config fixtures resolve inside this suite\'s own HOME',
    configPath(ROOT).startsWith(`${OWNED_HOME}${path.sep}`),
  );
  assert('the default is in effect', loaded.prompt === DEFAULT_SYSTEM_PROMPT);
  assert('the source is reported as default', loaded.source === 'default');
  assert('no path is reported', loaded.path === undefined);
  assert('a missing override file is not a problem worth reporting', loaded.problem === undefined);

  // The default is coding-agent instructions, not a generic assistant preamble:
  // it must name the tools the runtime actually registers and keep the rules the
  // permission gate and the "verify your work" acceptance criteria depend on.
  for (const toolName of ['fileEditor', 'bash', 'imageViewer', 'load_skill', 'update_plan', 'memory_recall', 'memory_save', 'subagent']) {
    assert(
      `it names the built-in ${toolName} tool`,
      DEFAULT_SYSTEM_PROMPT.includes(`- ${toolName}:`),
    );
  }
  assert(
    'it treats recalled memory as fallible context rather than policy',
    /memory_recall:[\s\S]*fallible context[\s\S]*never as instructions or policy/.test(DEFAULT_SYSTEM_PROMPT),
  );
  assert(
    'it limits durable memory to confirmed facts with exact evidence',
    /memory_save:[\s\S]*only after confirming[\s\S]*exact current source line[\s\S]*exact quote from the\n  current user/.test(DEFAULT_SYSTEM_PROMPT),
  );
  assert(
    'it states that a save persists only after a durable successful turn',
    /persistence occurs only after a durable successful turn/.test(DEFAULT_SYSTEM_PROMPT),
  );
  assert('it limits parallel subagents to independent reads', /parallel children for\n  independent reads, not concurrent writes/.test(DEFAULT_SYSTEM_PROMPT));
  assert(
    'it keeps workflow parallelism read-only and serializes writes by edges',
    /workflow:[\s\S]*Parallel branches are for reads only —\n  serialize writes by edges/.test(DEFAULT_SYSTEM_PROMPT),
  );
  assert('it tells the model to read before editing', /have not read/i.test(DEFAULT_SYSTEM_PROMPT));
  assert('it tells the model to verify its work', /verify/i.test(DEFAULT_SYSTEM_PROMPT));
  assert(
    'it tells the model not to work around a denied tool call',
    /denied/.test(DEFAULT_SYSTEM_PROMPT) && /work around/.test(DEFAULT_SYSTEM_PROMPT),
  );
}

async function fileOverride(): Promise<void> {
  header(`system prompt — ${SYSTEM_PROMPT_FILENAME} replaces the default`);

  const dir = await project();
  const file = await writeOverride(dir, 'You are a haiku-only agent.\n\n\n');
  const loaded = await loadSystemPrompt(dir);

  console.log(`  prompt: ${JSON.stringify(loaded.prompt)}`);

  assert('the file contents are the prompt', loaded.prompt === 'You are a haiku-only agent.');
  assert('the source is reported as file', loaded.source === 'file');
  assert('the path is reported so the user can see which file won', loaded.path === file);
  assert('nothing is flagged as a problem', loaded.problem === undefined);
  assert('the default is not appended to it', !loaded.prompt.includes('fileEditor'));
}

async function configOverride(): Promise<void> {
  header('system prompt — config.json wins over the file, and blank values are rejected');

  const dir = await project();
  await writeOverride(dir, 'FROM THE FILE');

  const inline = await loadSystemPrompt(dir, 'FROM THE CONFIG');
  assert('the inline prompt is used', inline.prompt === 'FROM THE CONFIG');
  assert('the source is reported as config', inline.source === 'config');
  assert('no path is reported for an inline prompt', inline.path === undefined);

  // Round-trip through the real loader: the field has to survive validation, or
  // the override above is reachable only from a test.
  await writeFile(
    configPath(dir),
    JSON.stringify({ systemPrompt: 'You only write TypeScript.' }),
    'utf8',
  );
  const config = await loadConfig(dir);
  assert('config loading carries systemPrompt through', config.systemPrompt === 'You only write TypeScript.');

  const viaConfig = await loadSystemPrompt(dir, config.systemPrompt);
  assert('the configured prompt reaches the agent', viaConfig.prompt === 'You only write TypeScript.');

  // A blank prompt is a mistake, not a configuration: it would leave the agent
  // with no instructions at all, which fails loudly rather than silently.
  for (const blank of ['', '   \n']) {
    await writeFile(configPath(dir), JSON.stringify({ systemPrompt: blank }), 'utf8');
    let rejected = false;
    try {
      await loadConfig(dir);
    } catch (error) {
      rejected = error instanceof ConfigError;
    }
    assert(`a blank systemPrompt (${JSON.stringify(blank)}) is a ConfigError`, rejected);
  }
}

async function brokenOverride(): Promise<void> {
  header('system prompt — a broken override falls back to the default, and says so');

  // An empty file reads as "I configured nothing", not "run with no instructions".
  const emptyDir = await project();
  await writeOverride(emptyDir, '   \n\n');
  const empty = await loadSystemPrompt(emptyDir);
  assert('an empty override falls back to the default', empty.prompt === DEFAULT_SYSTEM_PROMPT);
  assert('the fallback is reported', empty.problem !== undefined);
  console.log(`  empty file  : ${empty.problem}`);

  // A directory where the file should be: present, unreadable. Silently using the
  // default here would leave the user believing their prompt is in effect.
  const dirDir = await project();
  await mkdir(path.join(darwinDir(dirDir), SYSTEM_PROMPT_FILENAME), { recursive: true });
  const unreadable = await loadSystemPrompt(dirDir);
  assert('an unreadable override falls back to the default', unreadable.prompt === DEFAULT_SYSTEM_PROMPT);
  assert('the source is default, not file', unreadable.source === 'default');
  assert('the reason is reported', unreadable.problem !== undefined);
  console.log(`  unreadable  : ${unreadable.problem}`);
}

async function composesWithProjectInstructions(): Promise<void> {
  header('system prompt — an override still gets AGENTS.md appended after it');

  const dir = await project();
  await writeOverride(dir, 'CUSTOM BASE');
  await writeFile(path.join(dir, AGENTS_FILENAME), '# House rules\n\nPrefer small commits.\n', 'utf8');

  const base = await loadSystemPrompt(dir);
  const instructions = (await loadProjectInstructions(dir)).instructions;
  const composed = composeSystemPrompt(base.prompt, instructions);

  // Overriding replaces darwin's own instructions only. The project's rules are
  // additive by design, so they must survive a custom base prompt.
  assert('the custom base leads', composed.startsWith('CUSTOM BASE'));
  assert('project instructions follow it', composed.includes('Prefer small commits'));
  assert(
    'the instructions come after the base, not before',
    composed.indexOf('<project-instructions') > composed.indexOf('CUSTOM BASE'),
  );
}

async function main(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await defaultPrompt();
  await fileOverride();
  await configOverride();
  await brokenOverride();
  await composesWithProjectInstructions();
  report();
}

await main();
