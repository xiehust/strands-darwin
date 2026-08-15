/**
 * Live proof that the cache points actually cache, through the real runtime.
 *
 * Only Bedrock's own accounting can settle this: a request that carries a cache
 * point it never gets to reuse looks identical from the inside. So two turns run
 * against a real model and the reported usage has to move the right way — tokens
 * written on the first turn, read on the second.
 *
 * The temp project is padded with a large AGENTS.md on purpose: Claude Sonnet will
 * not cache a prefix under ~1,024 tokens, and a test that depends on the built-in
 * prompt staying long enough would fail the day someone trims it.
 *
 * Not part of `pnpm test` (it makes model calls).
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-prompt-cache-live.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime } from '../src/agent/runtime.js';
import { configPath } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const ROOT = '/tmp/darwin-prompt-cache-live';

// The Sonnet fixture is written through configPath(), which resolves under HOME.
const OWNED_HOME = ownPrivateHome('prompt-cache-live');

/** Sonnet's minimum cacheable prefix is 1,024 tokens; this clears it comfortably. */
const PADDING_LINES = 400;

/**
 * A cheap turn: no tool call, no thinking, one word back. What is being measured
 * is the prompt prefix, not the answer.
 */
const TURNS = ['Reply with the single word: ready', 'Reply with the single word: again'];

interface TurnUsage {
  inputTokens: number;
  cacheWrite: number;
  cacheRead: number;
}

async function seedProject(): Promise<void> {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  // Sonnet, not the shared haiku id: Haiku's minimum cacheable prefix is larger,
  // and this check is about the mechanism rather than about a particular model.
  await mkdir(path.dirname(configPath(ROOT)), { recursive: true });
  await writeFile(
    configPath(ROOT),
    JSON.stringify({ model: 'us.anthropic.claude-sonnet-4-6', maxTokens: 64 }, null, 2),
    'utf8',
  );

  // The nonce matters: cache entries live for 5 minutes, so a byte-identical
  // prefix would still be warm from the previous run of this script and the first
  // turn would report a read where the test expects the write.
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const padding = Array.from(
    { length: PADDING_LINES },
    (_, index) =>
      `- Rule ${index + 1} (${nonce}): keep changes small, read before editing, and verify what you changed.`,
  ).join('\n');
  await writeFile(path.join(ROOT, 'AGENTS.md'), `# Project rules\n\n${padding}\n`, 'utf8');
}

/**
 * Usage reported for the turn that just ran.
 *
 * `accumulatedUsage` accumulates over the agent's whole lifetime, not per turn, so
 * every reading here is a delta against the previous turn — otherwise turn two
 * would appear to read twice as much as it did.
 */
async function runTurn(runtime: AgentRuntime, input: string, before: TurnUsage): Promise<TurnUsage> {
  const total: TurnUsage = { ...before };

  for await (const event of runtime.send(input)) {
    if (event.type !== 'agentResultEvent') continue;
    const usage = event.result.metrics?.accumulatedUsage;
    if (usage === undefined) continue;
    total.inputTokens = usage.inputTokens;
    total.cacheWrite = usage.cacheWriteInputTokens ?? 0;
    total.cacheRead = usage.cacheReadInputTokens ?? 0;
  }

  return total;
}

function delta(after: TurnUsage, before: TurnUsage): TurnUsage {
  return {
    inputTokens: after.inputTokens - before.inputTokens,
    cacheWrite: after.cacheWrite - before.cacheWrite,
    cacheRead: after.cacheRead - before.cacheRead,
  };
}

async function main(): Promise<void> {
  header('prompt cache (live) — tokens written, then read');

  assert(
    'the global config fixture resolves inside this suite\'s own HOME',
    configPath(ROOT).startsWith(`${OWNED_HOME}${path.sep}`),
  );
  await seedProject();
  const runtime = await AgentRuntime.create({
    projectRoot: ROOT,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });

  try {
    assert('the runtime reports caching on', runtime.info.promptCache.enabled);
    assert(
      'all three parts are cached for a bedrock claude model',
      runtime.info.promptCache.parts.length === 3,
    );

    const start: TurnUsage = { inputTokens: 0, cacheWrite: 0, cacheRead: 0 };
    const afterFirst = await runTurn(runtime, TURNS[0] as string, start);
    const first = delta(afterFirst, start);
    console.log(`  turn 1: input ${first.inputTokens}, write ${first.cacheWrite}, read ${first.cacheRead}`);
    assert('turn 1 writes the prefix to cache', first.cacheWrite > 0);
    assert('turn 1 has nothing to read yet', first.cacheRead === 0);

    const second = delta(await runTurn(runtime, TURNS[1] as string, afterFirst), afterFirst);
    console.log(`  turn 2: input ${second.inputTokens}, write ${second.cacheWrite}, read ${second.cacheRead}`);
    assert('turn 2 reads the cached prefix', second.cacheRead > 0);
    assert('the read covers the prefix, not a token or two', second.cacheRead >= 1024);
    // The point of the exercise: what used to be billed as fresh input is not.
    assert(
      'turn 2 charges fewer uncached input tokens than the cache it read',
      second.inputTokens < second.cacheRead,
    );
  } finally {
    await runtime.shutdown();
  }

  report();
}

await main();
