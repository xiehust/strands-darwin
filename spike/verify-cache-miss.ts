/**
 * SER-074 — why the prompt cache missed, and the warm-cache switch notice.
 *
 * Free suite: no provider, no network. Two halves.
 *
 * The pure half drives `cacheMissCause` over synthetic call sequences under a fake
 * clock and both TTLs, and pins: every cause; the precedence when several apply;
 * every no-verdict branch (unreported counters, a fresh session's expected-cold first
 * call, a call that is not a miss, a miss after a call that was itself cold); the
 * miss threshold `CACHE_MISS_READ_FRACTION`; `describeCacheMissCause`'s TTL text;
 * `warmCacheSwitchNotice`'s exact wording and its silence when the cache is cold or
 * unknown; and the `CacheMissTracker` state machine (the "since last call" window
 * closes on every completed call, the resume flag settles after the first call).
 *
 * The runtime half drives a real offline `AgentRuntime` through
 * `setRuntimeModelFactoryForTest` with a model that reports scripted usage per call,
 * and proves the tracker's wiring without a model call: `changeThinkingEffort` marks
 * only when the effective level changes, `changeModel` marks, a non-compacting
 * `compact()` does not, `cacheMissReport()` and `cacheWarmth()` read the tracker,
 * both fall silent once the live plan has no Darwin-managed cache point (an OpenAI
 * target), and `/clear`'s successor starts empty.
 *
 * Run: pnpm tsx spike/verify-cache-miss.ts
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';

import {
  CACHE_MISS_READ_FRACTION,
  CacheMissTracker,
  cacheMissCause,
  describeCacheMissCause,
  isCacheMiss,
  promptCacheTtlMs,
  warmCacheSwitchNotice,
  type CacheCallFacts,
  type CacheInvalidatingEvent,
  type CacheMissInput,
} from '../src/agent/cache-miss.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath, type ModelChoice } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const OWNED_HOME = ownPrivateHome('cache-miss');

const FIVE_MINUTES = 5 * 60_000;
const ONE_HOUR = 60 * 60_000;
const T0 = 1_800_000_000_000;

function call(at: number, cacheRead: number | undefined, requestInput: number | undefined): CacheCallFacts {
  return { at, cacheRead, requestInput };
}

/** A warm call on a 100k conversation: nearly everything read from the cache. */
const WARM = call(T0, 96_000, 100_000);
/** A cold call on the same conversation one minute later: nothing read, all re-sent. */
const COLD = call(T0 + 60_000, 0, 100_000);

function input(overrides: Partial<CacheMissInput>): CacheMissInput {
  return {
    previous: WARM,
    current: COLD,
    events: new Set<CacheInvalidatingEvent>(),
    ttlMs: FIVE_MINUTES,
    firstCallAfterResume: false,
    ...overrides,
  };
}

function events(...names: CacheInvalidatingEvent[]): Set<CacheInvalidatingEvent> {
  return new Set(names);
}

// ---------------------------------------------------------------- the miss test

function missThreshold(): void {
  header('a miss is a call that read less than the fixed fraction of its own request');
  assert('the fraction is exported and fixed', CACHE_MISS_READ_FRACTION === 0.2);
  assert('a warm call is not a miss', !isCacheMiss(WARM));
  assert('a cold call is a miss', isCacheMiss(COLD));
  assert('exactly the fraction is not a miss (strictly below)', !isCacheMiss(call(T0, 20_000, 100_000)));
  assert('one token under the fraction is a miss', isCacheMiss(call(T0, 19_999, 100_000)));
  assert('an unreported cache read is unknown, never a miss', !isCacheMiss(call(T0, undefined, 100_000)));
  assert('an unreported request total is unknown, never a miss', !isCacheMiss(call(T0, 0, undefined)));
  assert('an empty request is not a miss', !isCacheMiss(call(T0, 0, 0)));
  assert('the TTL in ms: 5m, 1h, unset falls back to darwin\u2019s 1h default',
    promptCacheTtlMs('5m') === FIVE_MINUTES && promptCacheTtlMs('1h') === ONE_HOUR && promptCacheTtlMs(undefined) === ONE_HOUR);
}

// ---------------------------------------------------------------- no verdict

function noVerdict(): void {
  header('cacheMissCause — the no-verdict branches');
  assert('a warm call after a warm call has no verdict',
    cacheMissCause(input({ current: call(T0 + 60_000, 95_000, 100_000) })) === undefined);
  assert('unreported cache counters on the current call: no verdict even after /model',
    cacheMissCause(input({ current: call(T0 + 60_000, undefined, 100_000), events: events('model') })) === undefined);
  assert('unreported request total on the current call: no verdict',
    cacheMissCause(input({ current: call(T0 + 60_000, 0, undefined), events: events('model') })) === undefined);
  assert('a fresh session\u2019s first call is expected cold: no verdict',
    cacheMissCause(input({ previous: undefined, firstCallAfterResume: false })) === undefined);
  assert('\u2026even when /model ran before it',
    cacheMissCause(input({ previous: undefined, firstCallAfterResume: false, events: events('model') })) === undefined);
  assert('a cold call after a call that was itself cold is not a miss relative to a warm cache',
    cacheMissCause(input({ previous: call(T0, 0, 100_000) })) === undefined);
  assert('a previous call with unreported cache reads cannot vouch for warmth',
    cacheMissCause(input({ previous: call(T0, undefined, 100_000) })) === undefined);
}

// ---------------------------------------------------------------- each cause

function eachCause(): void {
  header('cacheMissCause — one cause per miss');
  assert('/model since the last call: model switched',
    cacheMissCause(input({ events: events('model') })) === 'model switched');
  assert('/effort since the last call: effort changed',
    cacheMissCause(input({ events: events('effort') })) === 'effort changed');
  assert('/compact since the last call: compacted',
    cacheMissCause(input({ events: events('compact') })) === 'compacted');
  assert('idle longer than a 5m TTL with no event: idle past cache TTL',
    cacheMissCause(input({ current: call(T0 + FIVE_MINUTES + 1, 0, 100_000) })) === 'idle past cache TTL');
  assert('exactly the TTL is not past it',
    cacheMissCause(input({ current: call(T0 + FIVE_MINUTES, 0, 100_000) })) === 'unknown');
  assert('the same gap under a 1h TTL is not idle: unknown',
    cacheMissCause(input({ current: call(T0 + FIVE_MINUTES + 1, 0, 100_000), ttlMs: ONE_HOUR })) === 'unknown');
  assert('past a 1h TTL: idle past cache TTL',
    cacheMissCause(input({ current: call(T0 + ONE_HOUR + 1, 0, 100_000), ttlMs: ONE_HOUR })) === 'idle past cache TTL');
  assert('the first call of a resumed session, cold: first request of a resumed session',
    cacheMissCause(input({ previous: undefined, firstCallAfterResume: true })) === 'first request of a resumed session');
  assert('the first call of a resumed session, warm (the previous run\u2019s cache still there): no verdict',
    cacheMissCause(input({ previous: undefined, current: WARM, firstCallAfterResume: true })) === undefined);
  assert('a cold call one minute after a warm one with nothing to blame: unknown',
    cacheMissCause(input({})) === 'unknown');
}

// ---------------------------------------------------------------- precedence

function precedence(): void {
  header('cacheMissCause — precedence when several causes apply');
  const late = call(T0 + ONE_HOUR, 0, 100_000);
  assert('model > effort > compact > idle',
    cacheMissCause(input({ current: late, events: events('compact', 'effort', 'model') })) === 'model switched');
  assert('effort > compact > idle',
    cacheMissCause(input({ current: late, events: events('compact', 'effort') })) === 'effort changed');
  assert('compact > idle',
    cacheMissCause(input({ current: late, events: events('compact') })) === 'compacted');
  assert('idle > resumed: an event on a resumed session\u2019s first call outranks the resume',
    cacheMissCause(input({ previous: undefined, firstCallAfterResume: true, events: events('compact') })) === 'compacted');
  assert('resumed > unknown', cacheMissCause(input({ previous: undefined, firstCallAfterResume: true })) === 'first request of a resumed session');
}

// ---------------------------------------------------------------- text

function text(): void {
  header('describeCacheMissCause and warmCacheSwitchNotice — the exact strings');
  assert('the TTL cause names the configured TTL',
    describeCacheMissCause('idle past cache TTL', '5m') === 'idle past cache TTL (5m)' &&
    describeCacheMissCause('idle past cache TTL', '1h') === 'idle past cache TTL (1h)');
  assert('an unset TTL is darwin\u2019s 1h default', describeCacheMissCause('idle past cache TTL', undefined) === 'idle past cache TTL (1h)');
  assert('every other cause is its own text',
    describeCacheMissCause('model switched', '5m') === 'model switched' &&
    describeCacheMissCause('effort changed', '5m') === 'effort changed' &&
    describeCacheMissCause('compacted', '1h') === 'compacted' &&
    describeCacheMissCause('first request of a resumed session', '5m') === 'first request of a resumed session' &&
    describeCacheMissCause('unknown', '5m') === 'unknown');

  assert('the /model notice: age, tokens read last call, what follows',
    warmCacheSwitchNotice('model', { warm: true, ageMs: 42_000, lastCacheRead: 96_000 }) ===
      'cache is warm (42s ago, 96,000 tokens read last call): switching model re-reads the conversation uncached');
  assert('the /effort notice names effort and renders minutes',
    warmCacheSwitchNotice('effort', { warm: true, ageMs: 3 * 60_000 + 12_000, lastCacheRead: 1_234 }) ===
      'cache is warm (3m 12s ago, 1,234 tokens read last call): switching effort re-reads the conversation uncached');
  assert('an hour-scale age under a 1h TTL renders hours and minutes',
    warmCacheSwitchNotice('model', { warm: true, ageMs: 62 * 60_000, lastCacheRead: 10 })?.startsWith('cache is warm (1h 2m ago, 10 tokens') === true);
  assert('a cold cache prints nothing', warmCacheSwitchNotice('model', { warm: false, ageMs: 1_000, lastCacheRead: 96_000 }) === undefined);
  assert('no completed call prints nothing', warmCacheSwitchNotice('effort', undefined) === undefined);
}

// ---------------------------------------------------------------- tracker

function tracker(): void {
  header('CacheMissTracker — the since-last-call window and the resume flag');
  let ttl = FIVE_MINUTES;
  const fresh = new CacheMissTracker(() => ttl, false);
  assert('before any call there is no warmth and no miss',
    fresh.warmth(T0) === undefined && fresh.report().misses === 0 && fresh.report().lastMiss === undefined);
  assert('a fresh session\u2019s first cold call: no verdict', fresh.observe(call(T0, 0, 100_000)) === undefined);
  assert('a cold last call is not warm', fresh.warmth(T0 + 1_000)?.warm === false && fresh.warmth(T0 + 1_000)?.lastCacheRead === 0);
  assert('a warm call: no verdict', fresh.observe(call(T0 + 10_000, 96_000, 100_000)) === undefined);
  const warmth = fresh.warmth(T0 + 40_000);
  assert('warmth reads the last call: warm, its age, its cache read',
    warmth?.warm === true && warmth.ageMs === 30_000 && warmth.lastCacheRead === 96_000);
  assert('warmth expires with the TTL', fresh.warmth(T0 + 10_000 + FIVE_MINUTES)?.warm === false);
  ttl = ONE_HOUR;
  assert('the TTL is read live (a /model can change it)', fresh.warmth(T0 + 10_000 + FIVE_MINUTES)?.warm === true);
  ttl = FIVE_MINUTES;

  fresh.mark('effort');
  assert('a warm call after a mark: still no verdict, and the mark is consumed',
    fresh.observe(call(T0 + 20_000, 96_000, 100_000)) === undefined &&
    fresh.observe(call(T0 + 30_000, 0, 100_000)) === 'unknown');
  assert('the miss was counted with its facts', (() => {
    const { misses, lastMiss } = fresh.report();
    return misses === 1 && lastMiss?.cause === 'unknown' && lastMiss.at === T0 + 30_000 && lastMiss.cacheRead === 0 && lastMiss.requestInput === 100_000;
  })());
  fresh.observe(call(T0 + 40_000, 90_000, 100_000));
  fresh.mark('model');
  fresh.mark('compact');
  assert('several marks resolve by precedence and the count grows',
    fresh.observe(call(T0 + 50_000, 0, 100_000)) === 'model switched' && fresh.report().misses === 2 && fresh.report().lastMiss?.cause === 'model switched');

  const resumed = new CacheMissTracker(() => FIVE_MINUTES, true);
  assert('a resumed session\u2019s first cold call is blamed on the resume',
    resumed.observe(call(T0, 0, 100_000)) === 'first request of a resumed session');
  const resumedWarm = new CacheMissTracker(() => FIVE_MINUTES, true);
  assert('a resumed session whose first call reads is silent, and the flag settles',
    resumedWarm.observe(call(T0, 96_000, 100_000)) === undefined &&
    resumedWarm.observe(call(T0 + 1_000, 0, 100_000)) === 'unknown');
}

// ---------------------------------------------------------------- runtime

interface ScriptedUsage {
  inputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

/** Serves one scripted usage per call, in order; throws if the script runs out. */
class ScriptedModel extends Model<BaseModelConfig> {
  calls = 0;
  private conf: BaseModelConfig = { modelId: 'fake.scripted', contextWindowLimit: 200_000 };
  private readonly script: ScriptedUsage[] = [];

  next(usage: ScriptedUsage): void {
    this.script.push(usage);
  }

  override updateConfig(next: BaseModelConfig): void {
    this.conf = { ...this.conf, ...next };
  }

  override getConfig(): BaseModelConfig {
    return this.conf;
  }

  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    const usage = this.script.shift();
    if (usage === undefined) throw new Error('scripted usage exhausted');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield {
      type: 'modelMetadataEvent',
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: 7,
        totalTokens: usage.inputTokens + 7,
        ...(usage.cacheReadInputTokens !== undefined && { cacheReadInputTokens: usage.cacheReadInputTokens }),
        ...(usage.cacheWriteInputTokens !== undefined && { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
      },
    };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

/** Two Claude models (so a switch keeps caching on) and one OpenAI model (so a switch turns it off). */
async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-cache-miss-'));
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(
    configPath(root),
    JSON.stringify({
      permissionMode: 'yolo',
      trajectory: false,
      models: [
        { enable: true, name: 'opus', provider: 'bedrock', model: 'global.anthropic.claude-opus-5', region: 'us-west-2', maxTokens: 8192 },
        { enable: false, name: 'sonnet', provider: 'bedrock', model: 'global.anthropic.claude-sonnet-5', region: 'us-west-2', maxTokens: 8192 },
        { enable: false, name: 'sol', provider: 'openai', model: 'openai.gpt-5.6-sol', bedrockMantle: true, openaiApi: 'responses', region: 'us-east-1', maxTokens: 8192 },
      ],
    }, null, 2),
  );
  return root;
}

async function turn(runtime: AgentRuntime, model: ScriptedModel, usage: ScriptedUsage): Promise<void> {
  model.next(usage);
  for await (const _event of runtime.send('next')) {
    // Consume the ordinary stream; the tracker observes inside it.
  }
}

async function runtimeTracking(): Promise<void> {
  header('runtime — the tracker is fed by send(), marked by the session\u2019s own events, silent off Claude');
  assert('this suite writes its own global config fixture', configPath().startsWith(`${OWNED_HOME}${path.sep}`));

  const model = new ScriptedModel();
  setRuntimeModelFactoryForTest(async () => model);
  const root = await fixture();
  let runtime = await AgentRuntime.create({
    projectRoot: root,
    session: { kind: 'new' },
    permissionBridge: allowAllBridge,
  });
  try {
    assert('caching is on for the fixture\u2019s Claude model, on darwin\u2019s 1h default', runtime.promptCache.enabled && runtime.promptCache.ttl === '1h');
    assert('before any call: no misses, no warmth',
      runtime.cacheMissReport().misses === 0 && runtime.cacheMissReport().lastMiss === undefined && runtime.cacheWarmth(Date.now()) === undefined);

    // Call 1: the expected-cold first call writes the cache.
    await turn(runtime, model, { inputTokens: 1_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 50_000 });
    assert('a fresh session\u2019s first cold call is not a miss', runtime.cacheMissReport().misses === 0);
    assert('a cold last call is not warm', runtime.cacheWarmth(Date.now())?.warm === false);

    // Call 2: warm.
    await turn(runtime, model, { inputTokens: 500, cacheReadInputTokens: 50_000, cacheWriteInputTokens: 500 });
    const warmth = runtime.cacheWarmth(Date.now());
    assert('after a warm call the cache is warm, with that call\u2019s read',
      warmth?.warm === true && warmth.lastCacheRead === 50_000 && warmth.ageMs < 60_000);
    assert('the warmth outlives a 5m gap on the default 1h TTL', runtime.cacheWarmth(Date.now() + FIVE_MINUTES + 1_000)?.warm === true);
    assert('the warmth expires with the default 1h TTL', runtime.cacheWarmth(Date.now() + ONE_HOUR + 1_000)?.warm === false);
    assert('the /model notice would print now',
      warmCacheSwitchNotice('model', warmth)?.endsWith('tokens read last call): switching model re-reads the conversation uncached') === true);

    // A repeated level changes nothing sent, so it must not be blamed.
    const same = runtime.changeThinkingEffort('high');
    await same.saved;
    assert('/effort to the current level reports no effective change', same.effectiveChanged === false);
    await turn(runtime, model, { inputTokens: 500, cacheReadInputTokens: 50_500, cacheWriteInputTokens: 500 });
    assert('\u2026and a warm call after it records no miss', runtime.cacheMissReport().misses === 0);

    // A real effort change, then a cold call: effort changed.
    const lowered = runtime.changeThinkingEffort('low');
    await lowered.saved;
    assert('/effort to a new level reports an effective change', lowered.effectiveChanged === true);
    await turn(runtime, model, { inputTokens: 51_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 51_000 });
    const afterEffort = runtime.cacheMissReport();
    assert('the cold call after /effort is blamed on the effort change',
      afterEffort.misses === 1 && afterEffort.lastMiss?.cause === 'effort changed' &&
      afterEffort.lastMiss.cacheRead === 0 && afterEffort.lastMiss.requestInput === 102_000);

    // Warm again, then a non-compacting compact(): nothing to blame, so the next
    // cold call is `unknown` — a no-op pass must not be called a compaction.
    await turn(runtime, model, { inputTokens: 500, cacheReadInputTokens: 51_000, cacheWriteInputTokens: 500 });
    const noop = await runtime.compact();
    assert('a short conversation compacts nothing', noop.compacted === false);
    await turn(runtime, model, { inputTokens: 52_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 52_000 });
    assert('a cold call after a no-op compact reads unknown, not compacted',
      runtime.cacheMissReport().misses === 2 && runtime.cacheMissReport().lastMiss?.cause === 'unknown');

    // Warm again, then a Claude-to-Claude /model: model switched, tracker still live.
    await turn(runtime, model, { inputTokens: 500, cacheReadInputTokens: 52_000, cacheWriteInputTokens: 500 });
    const sonnet = runtime.modelChoices.find((entry) => entry.name === 'sonnet') as ModelChoice;
    await (await runtime.changeModel(sonnet)).saved;
    assert('caching stays on across a Claude-to-Claude switch', runtime.promptCache.enabled);
    await turn(runtime, model, { inputTokens: 53_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 53_000 });
    assert('the cold call after /model is blamed on the switch',
      runtime.cacheMissReport().misses === 3 && runtime.cacheMissReport().lastMiss?.cause === 'model switched');

    // Unreported counters: a call whose usage carries no cache fields is unknown, not a miss.
    await turn(runtime, model, { inputTokens: 500, cacheReadInputTokens: 53_000, cacheWriteInputTokens: 500 });
    await turn(runtime, model, { inputTokens: 54_000 });
    assert('a call with unreported cache counters adds no miss', runtime.cacheMissReport().misses === 3);
    assert('\u2026and cannot vouch for warmth', runtime.cacheWarmth(Date.now())?.warm === false);

    // OpenAI: provider-managed caching, no Darwin cache point — both reads fall silent.
    const sol = runtime.modelChoices.find((entry) => entry.name === 'sol') as ModelChoice;
    await (await runtime.changeModel(sol)).saved;
    assert('the OpenAI plan has no Darwin-managed cache point', !runtime.promptCache.enabled && runtime.promptCache.automatic);
    assert('cacheMissReport is empty off Claude',
      runtime.cacheMissReport().misses === 0 && runtime.cacheMissReport().lastMiss === undefined);
    assert('cacheWarmth is absent off Claude', runtime.cacheWarmth(Date.now()) === undefined);

    // Back on Claude the session's history is still there.
    await (await runtime.changeModel(runtime.modelChoices.find((entry) => entry.name === 'opus') as ModelChoice)).saved;
    assert('the tracker kept its history while silent', runtime.cacheMissReport().misses === 3);

    // A real compaction (the conversation is long enough now), then a cold call:
    // compacted. The summarizer's own call runs outside send(), so it is not observed.
    await turn(runtime, model, { inputTokens: 500, cacheReadInputTokens: 55_000, cacheWriteInputTokens: 500 });
    model.next({ inputTokens: 2_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 });
    const compacted = await runtime.compact();
    assert('a long conversation really compacts', compacted.compacted === true && compacted.messagesAfter < compacted.messagesBefore);
    assert('the summarizer\u2019s call is not a tracked call', runtime.cacheMissReport().misses === 3);
    await turn(runtime, model, { inputTokens: 20_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 20_000 });
    assert('the cold call after a real compaction is blamed on it',
      runtime.cacheMissReport().misses === 4 && runtime.cacheMissReport().lastMiss?.cause === 'compacted');

    // /clear's successor starts empty.
    const successor = await runtime.startNewSession();
    runtime = successor;
    assert('/clear\u2019s successor runtime starts with no misses and no warmth',
      successor.cacheMissReport().misses === 0 && successor.cacheMissReport().lastMiss === undefined && successor.cacheWarmth(Date.now()) === undefined);
  } finally {
    await runtime.shutdown();
    setRuntimeModelFactoryForTest(undefined);
    await rm(root, { recursive: true, force: true });
  }
}

missThreshold();
noVerdict();
eachCause();
precedence();
text();
tracker();
await runtimeTracking();
report();
