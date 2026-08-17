/**
 * Prompt caching: the decision table, the config surface, and where the system
 * prompt cache point lands.
 *
 * No model calls — this is the part a live run cannot show you, because a request
 * that quietly carries no cache point looks exactly like one that does. The live
 * counterpart (`verify-prompt-cache-live.ts`) proves the tokens are actually
 * cached; this proves the wiring exists and is off when it must be.
 *
 * Run: pnpm tsx spike/verify-prompt-cache.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CachePointBlock, TextBlock } from '@strands-agents/sdk';

import {
  applySystemPromptCachePoint,
  bedrockCacheConfig,
  planPromptCache,
  type SystemPromptHolder,
} from '../src/agent/prompt-cache.js';
import {
  ConfigError,
  configPath,
  loadConfig,
  withSoleChoice,
  type AppConfig,
} from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const ROOT = '/tmp/darwin-prompt-cache-test';

// configPath() resolves under HOME, not under the directory handed to it.
const OWNED_HOME = ownPrivateHome('prompt-cache');

const CLAUDE_CONFIG: AppConfig = withSoleChoice({
  provider: 'bedrock',
  model: 'us.anthropic.claude-sonnet-4-6',
  maxTokens: 8192,
  summaryRatio: 0.3, contextWarnRatio: 0.8,
  preserveRecentMessages: 10,
  permissionMode: 'default',
  promptCache: true,
  thinkingEffort: 'high',
});

async function writeConfig(contents: string): Promise<string> {
  const dir = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
  const file = configPath(dir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
  return dir;
}

async function configSurface(): Promise<void> {
  header('prompt cache — config surface');

  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  assert(
    'global config fixtures resolve inside this suite\'s own HOME',
    configPath(ROOT).startsWith(`${OWNED_HOME}${path.sep}`),
  );

  const defaults = await loadConfig(ROOT);
  assert('caching is on with no config file', defaults.promptCache);
  assert('no TTL is set by default (provider default applies)', defaults.promptCacheTtl === undefined);

  const off = await loadConfig(await writeConfig('{ "promptCache": false }'));
  assert('promptCache: false is honoured', off.promptCache === false);

  const hour = await loadConfig(await writeConfig('{ "promptCacheTtl": "1h" }'));
  assert('a 1h TTL loads', hour.promptCacheTtl === '1h');

  // Both must fail loudly: a typo that silently disabled caching would only show
  // up on the bill, and a bad TTL only as a ValidationException mid-session.
  for (const [what, contents] of [
    ['a non-boolean promptCache is a ConfigError', '{ "promptCache": "yes" }'],
    ['an unsupported promptCacheTtl is a ConfigError', '{ "promptCacheTtl": "30m" }'],
  ] as const) {
    const dir = await writeConfig(contents);
    try {
      await loadConfig(dir);
      assert(what, false);
    } catch (error) {
      assert(what, error instanceof ConfigError);
      if (error instanceof ConfigError) console.log(`  ${error.message.split(': ').slice(1).join(': ')}`);
    }
  }
}

function decisionTable(): void {
  header('prompt cache — what each provider and model can cache');

  const claude = planPromptCache(CLAUDE_CONFIG);
  assert('bedrock claude caches all three parts', claude.parts.length === 3);
  assert('…including the tool schemas', claude.parts.includes('tools'));
  assert('…the system prompt', claude.parts.includes('system prompt'));
  assert('…and the conversation', claude.parts.includes('conversation'));
  assert('no problem is reported when caching is on', claude.problem === undefined);

  const disabled = planPromptCache({ ...CLAUDE_CONFIG, promptCache: false });
  assert('promptCache: false places no cache points', !disabled.enabled && disabled.parts.length === 0);
  assert('switching it off is silent, not a problem', disabled.problem === undefined);

  const nova = planPromptCache({ ...CLAUDE_CONFIG, model: 'us.amazon.nova-pro-v1:0' });
  assert('a non-Claude bedrock model caches nothing', !nova.enabled);
  assert('…and says why', nova.problem?.includes('nova-pro') === true);

  const anthropic = planPromptCache({ ...CLAUDE_CONFIG, provider: 'anthropic', model: 'claude-sonnet-4-6' });
  assert('the anthropic provider caches the system prompt', anthropic.parts.includes('system prompt'));
  assert(
    '…but not tools or conversation (no cacheConfig in AnthropicModelConfig)',
    anthropic.parts.length === 1,
  );

  const openai = planPromptCache({ ...CLAUDE_CONFIG, provider: 'openai', model: 'gpt-4o' });
  assert('darwin places no explicit cache points for openai', !openai.enabled);
  assert('provider-managed automatic caching is not reported as a problem', openai.problem === undefined);
}

function modelConfig(): void {
  header('prompt cache — the cacheConfig handed to BedrockModel');

  const enabled = bedrockCacheConfig(planPromptCache(CLAUDE_CONFIG));
  assert('claude gets a cacheConfig', enabled?.strategy === 'auto');
  assert('no TTL fields when none was configured', enabled?.toolsTTL === undefined);

  const ttl = bedrockCacheConfig(planPromptCache({ ...CLAUDE_CONFIG, promptCacheTtl: '1h' }));
  // Bedrock rejects an increasing TTL across tools → system → messages, so the one
  // configured value has to be stamped on every checkpoint identically.
  assert('a configured TTL reaches the tool checkpoint', ttl?.toolsTTL === '1h');
  assert('…and the message checkpoint, at the same value', ttl?.messagesTTL === '1h');

  assert(
    'a non-Claude model gets no cacheConfig at all (the SDK would warn to the console)',
    bedrockCacheConfig(planPromptCache({ ...CLAUDE_CONFIG, model: 'us.amazon.nova-pro-v1:0' })) === undefined,
  );
  assert(
    'the anthropic provider gets no bedrock cacheConfig',
    bedrockCacheConfig(planPromptCache({ ...CLAUDE_CONFIG, provider: 'anthropic' })) === undefined,
  );
}

function systemPromptCachePoint(): void {
  header('prompt cache — the system prompt cache point');

  const prompt = 'base prompt\n\n<project-instructions>…</project-instructions>\n\n<available-skills>…</available-skills>';
  const agent: SystemPromptHolder = { systemPrompt: prompt };
  const placed = applySystemPromptCachePoint(agent, planPromptCache(CLAUDE_CONFIG));

  assert('the cache point is placed', placed);
  const blocks = Array.isArray(agent.systemPrompt) ? agent.systemPrompt : [];
  assert('the prompt becomes exactly two blocks', blocks.length === 2);
  assert('the text comes first', blocks[0] instanceof TextBlock);
  assert('the whole assembled prompt is kept verbatim', (blocks[0] as TextBlock).text === prompt);
  assert('the cache point comes last, so everything is inside it', blocks[1] instanceof CachePointBlock);
  assert('no TTL is stamped when none was configured', (blocks[1] as CachePointBlock).ttl === undefined);

  const withTtl: SystemPromptHolder = { systemPrompt: prompt };
  applySystemPromptCachePoint(withTtl, planPromptCache({ ...CLAUDE_CONFIG, promptCacheTtl: '1h' }));
  const ttlBlocks = Array.isArray(withTtl.systemPrompt) ? withTtl.systemPrompt : [];
  assert('a configured TTL reaches the cache point', (ttlBlocks[1] as CachePointBlock).ttl === '1h');

  const untouched: SystemPromptHolder = { systemPrompt: prompt };
  assert('caching off reports no placement', !applySystemPromptCachePoint(untouched, planPromptCache({ ...CLAUDE_CONFIG, promptCache: false })));
  const uncachedBlocks = Array.isArray(untouched.systemPrompt) ? untouched.systemPrompt : [];
  assert('caching off keeps the text but removes cache blocks', uncachedBlocks.length === 1 && uncachedBlocks[0] instanceof TextBlock && uncachedBlocks[0].text === prompt);

  // Reapplying replaces the prior point rather than nesting or duplicating it.
  const already: SystemPromptHolder = { systemPrompt: [new TextBlock(prompt), new CachePointBlock({ cacheType: 'default' })] };
  assert('an already-cached known shape is refreshed', applySystemPromptCachePoint(already, planPromptCache(CLAUDE_CONFIG)));
  assert('refresh still leaves exactly one final cache point', Array.isArray(already.systemPrompt) && already.systemPrompt.length === 2 && already.systemPrompt[1] instanceof CachePointBlock);

  const empty: SystemPromptHolder = { systemPrompt: '   ' };
  assert(
    'an empty prompt gets no cache point (nothing to cache)',
    !applySystemPromptCachePoint(empty, planPromptCache(CLAUDE_CONFIG)),
  );
}

async function main(): Promise<void> {
  await configSurface();
  decisionTable();
  modelConfig();
  systemPromptCachePoint();
  report();
}

await main();
