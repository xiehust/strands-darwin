/**
 * Prompt caching — cache points on the system prompt, the tool list and the messages.
 *
 * No model calls: every assertion here is construction and string handling, so it
 * proves what darwin puts *into* the request. Whether Bedrock then reports a cache
 * hit is a live question (turn 1 writes, turn 2 reads) and deliberately out of scope.
 *
 * Two invariants carry the design:
 *   - Caching is enabled by naming the strategy ourselves, never by 'auto'. On a
 *     non-Claude model 'auto' makes the SDK call logger.warn -> console.warn, which
 *     writes straight into the Ink frame. The Nova case below asserts silence.
 *   - The system prompt is sealed into blocks only *after* SkillsPlugin has appended
 *     its catalogue, so the plugin only ever sees the string it demands, and the
 *     cache point lands at the end of the whole stable prefix.
 *
 * Run: pnpm tsx spike/verify-prompt-cache.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AppConfig } from '../src/config.js';
import { configPath, createModelFromConfig, supportsPromptCache } from '../src/config.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { composeSystemPrompt, sealSystemPromptForCaching } from '../src/agent/instructions.js';
import { Message, TextBlock } from '@strands-agents/sdk';

import { SKILLS_DIRNAME } from '../src/skills/loader.js';
import { SkillsPlugin } from '../src/skills/plugin.js';
import { darwinDir } from '../src/paths.js';
import { assert, header, report } from './shared.js';

const TMP_ROOT = '/tmp/darwin-prompt-cache-test';

const CLAUDE_ID = 'global.anthropic.claude-opus-5';
const NOVA_ID = 'us.amazon.nova-pro-v1:0';

function config(model: string): AppConfig {
  return {
    provider: 'bedrock',
    model,
    maxTokens: 8192,
    permissionMode: 'default',
    summaryRatio: 0.3,
    preserveRecentMessages: 10,
  };
}

/** Reaches the SDK's own gate: true means it injects the tools and messages cache points. */
function sdkCachingEnabled(model: unknown): boolean {
  return (model as { _shouldEnableCaching(): boolean })._shouldEnableCaching();
}

function gate(): void {
  header('supportsPromptCache — Claude only, decided by us and not by the SDK');

  assert('an Opus inference profile supports caching', supportsPromptCache(CLAUDE_ID));
  assert('a Haiku inference profile supports caching', supportsPromptCache('us.anthropic.claude-haiku-4-5-20251001-v1:0'));
  assert('a bare anthropic id supports caching', supportsPromptCache('anthropic.claude-sonnet-4-6'));
  assert('a Nova model does not', !supportsPromptCache(NOVA_ID));
  assert('a Titan model does not', !supportsPromptCache('amazon.titan-text-express-v1'));
}

async function toolsAndMessages(): Promise<void> {
  header('BedrockModel — cacheConfig drives the tools and messages cache points');

  const claude = await createModelFromConfig(config(CLAUDE_ID));
  const claudeConfig = claude.getConfig() as { cacheConfig?: { strategy?: string } };

  assert('a Claude model carries cacheConfig', claudeConfig.cacheConfig !== undefined);
  assert("the strategy is named 'anthropic', never 'auto'", claudeConfig.cacheConfig?.strategy === 'anthropic');
  assert('so the SDK will inject the tools and messages cache points', sdkCachingEnabled(claude));

  // The warn the SDK emits for an unsupported model under 'auto' would land in the
  // Ink frame. Naming the strategy ourselves must make that path unreachable.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(' '));
  let nova: Awaited<ReturnType<typeof createModelFromConfig>>;
  try {
    nova = await createModelFromConfig(config(NOVA_ID));
    sdkCachingEnabled(nova);
  } finally {
    console.warn = realWarn;
  }
  const novaConfig = nova.getConfig() as { cacheConfig?: unknown };

  assert('a non-Claude model carries no cacheConfig', novaConfig.cacheConfig === undefined);
  assert('and the SDK leaves its request uncached', !sdkCachingEnabled(nova));
  assert('nothing was written to console.warn (the Ink frame stays clean)', warnings.length === 0);
  if (warnings.length > 0) console.log(`  warnings: ${JSON.stringify(warnings)}`);
}

async function systemPrompt(): Promise<void> {
  header('sealSystemPromptForCaching — one cache point after the whole stable prefix');

  const sealed = sealSystemPromptForCaching('BASE PROMPT');

  assert('a string becomes a two-block array', Array.isArray(sealed) && sealed.length === 2);
  const blocks = sealed as ReadonlyArray<{ type: string; text?: string; cacheType?: string }>;
  assert('the first block is the text, byte for byte', blocks[0]?.type === 'textBlock' && blocks[0]?.text === 'BASE PROMPT');
  assert('the last block is a default cache point', blocks[1]?.type === 'cachePointBlock' && blocks[1]?.cacheType === 'default');

  header('ordering — sealed after the skills catalogue, so the prefix is whole');

  await rm(TMP_ROOT, { recursive: true, force: true });
  const skillDir = path.join(darwinDir(TMP_ROOT), SKILLS_DIRNAME, 'commit-message');
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: commit-message\ndescription: Write a commit message.\n---\n\n# Commit message\n\nUse the imperative mood.\n`,
    'utf8',
  );

  const plugin = await SkillsPlugin.load(TMP_ROOT);
  const composed = composeSystemPrompt('BASE PROMPT', {
    fragment: '<project-instructions>\nHOUSE RULES\n</project-instructions>',
    path: path.join(TMP_ROOT, 'AGENTS.md'),
    bytes: 42,
    truncated: false,
  });

  // Exactly the runtime's order: compose, let the plugin append while it is still a
  // string, then seal. The plugin never sees a block array, so its guard never fires.
  const fakeAgent = { systemPrompt: composed } as Parameters<SkillsPlugin['initAgent']>[0];
  plugin.initAgent(fakeAgent);
  const final = fakeAgent.systemPrompt;
  assert('the plugin still received a string', typeof final === 'string');

  const sealedFinal = sealSystemPromptForCaching(final as string);
  const text = (sealedFinal as ReadonlyArray<{ text?: string }>)[0]?.text ?? '';

  assert('the sealed text is exactly the string it replaced', text === final);
  assert('it still carries the base prompt', text.includes('BASE PROMPT'));
  assert('it still carries the project instructions', text.includes('HOUSE RULES'));
  assert('it still carries the skills catalogue', text.includes('commit-message'));
  assert(
    'in a fixed order: base, then instructions, then skills',
    text.indexOf('BASE PROMPT') < text.indexOf('HOUSE RULES') &&
      text.indexOf('HOUSE RULES') < text.indexOf('commit-message'),
  );

  header("SkillsPlugin's guard — still refusing to append after sealing");

  const sealedAgent = { systemPrompt: sealedFinal } as Parameters<SkillsPlugin['initAgent']>[0];
  let threw = false;
  try {
    plugin.initAgent(sealedAgent);
  } catch {
    threw = true;
  }
  assert('appending into a sealed prompt throws instead of guessing', threw);

  await rm(TMP_ROOT, { recursive: true, force: true });
}

/**
 * The wiring: a real AgentRuntime must hand the model a sealed prompt.
 *
 * Free — `create()` builds the Agent and initializes it, but the model is lazy, so
 * nothing here calls Bedrock. Reaches the private `agent` field on purpose: the
 * assertion is about what the SDK will be given, which is not otherwise observable.
 */
async function runtimeWiring(): Promise<void> {
  header('AgentRuntime — the prompt reaches the SDK sealed, and only for Claude');

  async function promptFor(model: string): Promise<unknown> {
    const root = path.join(TMP_ROOT, `runtime-${model.replace(/[^a-z0-9]+/gi, '-')}`);
    const file = configPath(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ provider: 'bedrock', model }), 'utf8');
    await writeFile(path.join(root, 'AGENTS.md'), '# House rules\n\nHOUSE RULES\n', 'utf8');
    const runtime = await AgentRuntime.create({ projectRoot: root, resume: false, permissionBridge: allowAllBridge });
    const prompt = (runtime as unknown as { agent: { systemPrompt: unknown } }).agent.systemPrompt;
    await runtime.shutdown();
    return prompt;
  }

  await rm(TMP_ROOT, { recursive: true, force: true });

  const claudePrompt = await promptFor(CLAUDE_ID);
  const blocks = claudePrompt as ReadonlyArray<{ type?: string; text?: string }>;
  assert('a Claude session hands the SDK a block array', Array.isArray(claudePrompt));
  assert('whose last block is the cache point', blocks[blocks.length - 1]?.type === 'cachePointBlock');
  assert('and whose text still carries AGENTS.md', blocks[0]?.text?.includes('HOUSE RULES') === true);

  const novaPrompt = await promptFor(NOVA_ID);
  assert('a non-Claude session is left as a plain string', typeof novaPrompt === 'string');
  assert('with its instructions intact', (novaPrompt as string).includes('HOUSE RULES'));

  await rm(TMP_ROOT, { recursive: true, force: true });
}

/**
 * The payload itself: all three cache points present in one formatted request.
 *
 * `_formatRequest` is what the SDK hands to Bedrock Converse. Calling it directly
 * proves the cache points reach the wire without spending a model call, which is
 * the difference between "the flag is set" and "the request is cached".
 */
async function formattedRequest(): Promise<void> {
  header('the Bedrock request — cache points on system, tools and messages');

  const model = await createModelFromConfig(config(CLAUDE_ID));
  const messages = [
    new Message({ role: 'user', content: [new TextBlock('first question')] }),
    new Message({ role: 'assistant', content: [new TextBlock('first answer')] }),
    new Message({ role: 'user', content: [new TextBlock('second question')] }),
  ];
  const request = (
    model as unknown as { _formatRequest(m: unknown, o: unknown): Record<string, any> }
  )._formatRequest(messages, {
    systemPrompt: sealSystemPromptForCaching('SEALED SYSTEM PROMPT'),
    toolSpecs: [{ name: 'bash', description: 'run a command', inputSchema: { type: 'object' } }],
  });

  const system = (request['system'] ?? []) as ReadonlyArray<Record<string, unknown>>;
  assert('system carries its text', system.some((b) => b['text'] === 'SEALED SYSTEM PROMPT'));
  assert('system ends with a cache point', system[system.length - 1]?.['cachePoint'] !== undefined);

  const tools = (request['toolConfig']?.tools ?? []) as ReadonlyArray<Record<string, unknown>>;
  assert('the tool list is present', tools.some((t) => t['toolSpec'] !== undefined));
  assert('the tool list ends with a cache point', tools[tools.length - 1]?.['cachePoint'] !== undefined);

  const wire = request['messages'] as ReadonlyArray<{ role: string; content: ReadonlyArray<Record<string, unknown>> }>;
  const lastUser = [...wire].reverse().find((m) => m.role === 'user');
  assert('the last user message ends with a cache point', lastUser?.content[lastUser.content.length - 1]?.['cachePoint'] !== undefined);
  assert(
    'earlier messages are left alone',
    wire[0]?.content.every((b) => b['cachePoint'] === undefined) === true,
  );

  console.log(`  system blocks: ${JSON.stringify(system)}`);
  console.log(`  tool blocks  : ${tools.length} (last: ${JSON.stringify(tools[tools.length - 1])})`);
}

gate();
await toolsAndMessages();
await systemPrompt();
await runtimeWiring();
await formattedRequest();
report();
