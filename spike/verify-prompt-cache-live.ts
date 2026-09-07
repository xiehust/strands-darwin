/**
 * Live proof that prompt caching works: turn 1 writes the cache, turn 2 reads it.
 *
 * COSTS REAL MODEL CALLS — two turns against a Claude inference profile. The free
 * suite (spike/verify-prompt-cache.ts) already proves the cache points are in the
 * request; only the provider can tell us they were honoured, which is why this is
 * a separate opt-in script.
 *
 * The fixture matters twice over. Anthropic only caches a prefix past a minimum
 * length, so the AGENTS.md below is padded well beyond it — a too-small prompt reports
 * zero cache tokens and looks like a bug in darwin. And the prefix carries a per-run
 * nonce, because a cache entry outlives the run (5 minutes): without it, a second run
 * inside the TTL starts warm and turn 1 *reads* the previous run's cache instead of
 * writing its own, which reads as a failure while nothing is wrong.
 *
 * Run: AWS_REGION=us-west-2 pnpm tsx spike/verify-prompt-cache-live.ts [modelId]
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Usage } from '@strands-agents/sdk';

import { AgentRuntime } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { configPath } from '../src/config.js';
import { assert, header, report } from './shared.js';

const ROOT = '/tmp/darwin-prompt-cache-live';
const MODEL = process.argv[2] ?? 'global.anthropic.claude-opus-5';

/** Padded past the provider's minimum cacheable prefix; content is irrelevant, size is not. */
function bigInstructions(nonce: string): string {
  const para =
    'The repository uses a strict review process. Every change is verified against ' +
    'the spike suites before it is committed, and the quality gate is a typecheck ' +
    'followed by the fast suites. Tools are approved through a permission gate that ' +
    'fails closed on anything it cannot classify as provably safe.\n\n';
  return `# House rules\n\nCACHE FIXTURE MARKER ${nonce}\n\n${para.repeat(40)}`;
}

function show(label: string, usage: Usage): void {
  console.log(
    `  ${label}: input=${usage.inputTokens} output=${usage.outputTokens} ` +
      `cacheWrite=${usage.cacheWriteInputTokens ?? 0} cacheRead=${usage.cacheReadInputTokens ?? 0}`,
  );
}

async function main(): Promise<void> {
  header(`prompt caching — live, ${MODEL}`);

  await rm(ROOT, { recursive: true, force: true });
  const file = configPath(ROOT);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ provider: 'bedrock', model: MODEL, maxTokens: 256 }), 'utf8');
  // A fresh nonce guarantees a cold cache, so turn 1 is always the write.
  const nonce = randomUUID();
  await writeFile(path.join(ROOT, 'AGENTS.md'), bigInstructions(nonce), 'utf8');
  console.log(`  fixture nonce: ${nonce}`);

  const runtime = await AgentRuntime.create({
    projectRoot: ROOT,
    resume: false,
    permissionBridge: allowAllBridge,
  });
  const agent = (runtime as unknown as { agent: { metrics: { agentInvocations: { usage: Usage }[] } } }).agent;

  try {
    for await (const _ of runtime.send('Reply with the single word: ready. Do not use any tools.')) {
      // Draining is the point; the text itself does not matter here.
    }
    const first = agent.metrics.agentInvocations[0]?.usage;
    assert('turn 1 reported usage', first !== undefined);
    if (first === undefined) return;
    show('turn 1', first);
    assert('turn 1 WROTE cache tokens', (first.cacheWriteInputTokens ?? 0) > 0);
    // Not asserting turn 1 read nothing: the tool list sits ahead of the system prompt
    // in the cached sequence and is byte-identical between runs, so a recent run can
    // legitimately serve it from cache even though this run's system prefix is new.

    for await (const _ of runtime.send('Reply with the single word: again. Do not use any tools.')) {
      // Same again: the second turn is where the cache should pay off.
    }
    const second = agent.metrics.agentInvocations[1]?.usage;
    assert('turn 2 reported usage', second !== undefined);
    if (second === undefined) return;
    show('turn 2', second);
    assert('turn 2 READ cache tokens', (second.cacheReadInputTokens ?? 0) > 0);
    // Both sides must be non-zero: `0 >= 0` would let an uncached run pass this.
    assert(
      'turn 2 read at least what turn 1 wrote (the whole prefix came back)',
      (first.cacheWriteInputTokens ?? 0) > 0 &&
        (second.cacheReadInputTokens ?? 0) >= (first.cacheWriteInputTokens ?? 0),
    );
    assert(
      'turn 2 billed far fewer fresh input tokens than it read from cache',
      second.inputTokens < (second.cacheReadInputTokens ?? 0),
    );
    // Turn 2 re-sends the same prefix, so it should write only the small increment
    // that turn 1's exchange added — not the prefix over again.
    assert(
      'turn 2 wrote only an increment, not the prefix again',
      (second.cacheWriteInputTokens ?? 0) * 4 < (first.cacheWriteInputTokens ?? 0),
    );
  } finally {
    await runtime.shutdown();
    await rm(ROOT, { recursive: true, force: true });
  }
}

await main();
report();
