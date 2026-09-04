/**
 * Trajectory cost — `trajectory list` and `trajectory replay` price a recorded session
 * per model, offline, from the price cache alone.
 *
 * Free suite: no model call, no network, no runtime. The records are written by hand in
 * the exact `v: 1` shape darwin writes (a `runStarted`, then `userInput`/`turnEnded`
 * pairs whose `spend` names the model that incurred it), so the claim under test is the
 * reader's, not the recorder's. Proves:
 *
 * - a priced single-model session gets one bounded `cost:` clause in `list` and a
 *   `session cost:` line in `replay`, at that model's rates;
 * - two models are each priced at their own rates and summed, with a per-model figure
 *   beside each per-model token row in `replay`;
 * - a model the cache does not price (`litellmKey: null`, or no entry) makes the total a
 *   floor that names it — never 0, never dropped;
 * - no cache file at all reads as unknown, not 0; a bucket only some turns reported is
 *   priced over the reported part and said to be partial; turns without spend make the
 *   total a floor;
 * - the readers never fetch or write: the cache file's bytes and mtime are unchanged,
 *   `HOME` is private, and a `fetch` that throws is never reached;
 * - `replayRead` without prices carries no cost, so `/export` stays a projection of the
 *   record alone.
 *
 * Run: pnpm tsx spike/verify-trajectory-cost.ts
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { trajectoryPath } from '../src/agent/session.js';
import { runTrajectoryCommand } from '../src/cli-trajectory.js';
import { COST_BASIS_LABEL } from '../src/pricing/cost.js';
import { MODEL_PRICES_SCHEMA_VERSION, MODEL_PRICES_SOURCE_URL, type ModelPriceCache } from '../src/pricing/model-prices.js';
import { readTrajectory } from '../src/trajectory/reader.js';
import { formatReplay, replayRead } from '../src/trajectory/replay.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const OWNED_HOME = ownPrivateHome('trajectory-cost');
const ROOT = path.join(os.tmpdir(), 'darwin-trajectory-cost-project');

const OPUS = 'global.anthropic.claude-opus-5';
const SOL = 'openai.gpt-5.6-sol';

/** Sonnet-class rates as LiteLLM lists Opus 5's row (verbatim, 2026-09-04). */
const OPUS_RATES = { inputCostPerToken: 2e-6, outputCostPerToken: 1e-5, cacheReadInputTokenCost: 2e-7, cacheCreationInputTokenCost: 2.5e-6 };
const SOL_RATES = { inputCostPerToken: 1e-6, outputCostPerToken: 5e-6 };

let seq = 0;
function record(turn: number, body: Record<string, unknown>): string {
  seq += 1;
  return JSON.stringify({ v: 1, seq, t: `2026-09-04T10:00:${String(seq).padStart(2, '0')}.000Z`, turn, ...body });
}

interface Spend {
  provider: string;
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** A session file: one run header, then one closed turn per spend (`undefined` = no spend recorded). */
async function writeSession(id: string, turns: readonly (Spend | undefined)[]): Promise<string> {
  seq = 0;
  const file = trajectoryPath(ROOT, id);
  await mkdir(path.dirname(file), { recursive: true });
  const lines = [
    record(0, {
      type: 'runStarted', session: id, agentId: 'darwin', darwinVersion: '0.0.1', provider: 'bedrock', model: OPUS,
      permissionMode: 'default', thinkingEffort: 'high', resumed: false, restoredMessages: 0, pid: 1,
    }),
  ];
  turns.forEach((spend, index) => {
    const turn = index + 1;
    lines.push(record(turn, { type: 'userInput', text: `question ${turn}` }));
    lines.push(record(turn, {
      type: 'turnEnded', stopReason: 'endTurn', ms: 1000, recorded: { agentResultEvent: 1 }, dropped: {},
      ...(spend !== undefined && { spend }),
    }));
  });
  await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

async function writeCache(file: string, models: ModelPriceCache['models']): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const cache: ModelPriceCache = { version: MODEL_PRICES_SCHEMA_VERSION, source: MODEL_PRICES_SOURCE_URL, models };
  await writeFile(file, JSON.stringify(cache), 'utf8');
}

async function run(
  command: Parameters<typeof runTrajectoryCommand>[0],
  pricesFile: string,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runTrajectoryCommand(command, {
    projectRoot: ROOT,
    pricesFile,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join('') };
}

function row(listing: string, id: string): string {
  return listing.split('\n').find((line) => line.startsWith(id)) ?? '';
}

async function main(): Promise<void> {
  header('trajectory cost — list and replay price a record per model, offline');
  assert('this suite owns its HOME', os.homedir() === OWNED_HOME);
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });

  // Any path that could reach the network must fail loudly: the readers own no fetch.
  const originalFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    throw new Error('the trajectory readers must never fetch');
  }) as typeof fetch;

  const prices = path.join(OWNED_HOME, 'prices', 'model-prices.json');
  await writeCache(prices, {
    [OPUS]: { litellmKey: OPUS, fetchedAt: '2026-09-04T00:00:00.000Z', ...OPUS_RATES },
    [SOL]: { litellmKey: `bedrock_mantle/${SOL}`, fetchedAt: '2026-09-04T00:00:00.000Z', ...SOL_RATES },
    'us.made-up.model': { litellmKey: null, fetchedAt: '2026-09-04T00:00:00.000Z' },
  });
  const cacheBefore = await stat(prices);
  const cacheBytes = await readFile(prices);

  try {
    // 1. One priced model: the figures from the session-and-state docs, exactly.
    const single = 'session-20260904-100001';
    await writeSession(single, [{ provider: 'bedrock', model: OPUS, input: 412, output: 1350, cacheRead: 130961, cacheWrite: 398 }]);
    const singleCost = 412 * 2e-6 + 1350 * 1e-5 + 130961 * 2e-7 + 398 * 2.5e-6;
    const listed = await run({ verb: 'list' }, prices);
    const singleRow = row(listed.out, single);
    assert('list exits 0 and appends one cost clause after the spend clause',
      listed.code === 0 && singleRow.includes(`, cost: ≈ $${singleCost.toFixed(4)} (${COST_BASIS_LABEL})`) &&
      singleRow.indexOf('spend: ') < singleRow.indexOf('cost: '));
    assert('the row stays one bounded line', !singleRow.includes('\n') && [...singleRow].length < 400);
    const replayed = await run({ verb: 'replay', sessionId: single, json: false }, prices);
    const replayLines = replayed.out.split('\n');
    const spendAt = replayLines.findIndex((line) => line.startsWith('  session spend:'));
    assert('replay prints session cost directly under session spend, at that model\u2019s rates',
      replayed.code === 0 && replayLines[spendAt + 1] === `  session cost: ≈ $${singleCost.toFixed(4)} (${COST_BASIS_LABEL})`);
    assert('a single model has no per-model breakdown', !replayed.out.includes(`bedrock/${OPUS}:`));

    // 2. Two priced models: each at its own rates, summed and counted; replay breaks it down.
    const two = 'session-20260904-100002';
    await writeSession(two, [
      { provider: 'bedrock', model: OPUS, input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 10_000 },
      { provider: 'openai', model: SOL, input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
    ]);
    const twoRow = row((await run({ verb: 'list' }, prices)).out, two);
    assert('list prices two models each at its own rates and counts them',
      twoRow.includes(`cost: ≈ $4.6250 (2 models; ${COST_BASIS_LABEL})`));
    assert('…not the first model\u2019s rates over the whole total', !twoRow.includes('$6.3750') && !twoRow.includes('$3.0000 ('));
    const twoReplay = (await run({ verb: 'replay', sessionId: two, json: false }, prices)).out;
    assert('replay states the mixed session cost',
      twoReplay.includes(`  session cost: ≈ $4.6250 (2 models; ${COST_BASIS_LABEL})`));
    assert('…and puts each model\u2019s own figure beside its token row',
      twoReplay.includes(`    bedrock/${OPUS}: input=1000000 output=100000 cacheRead=500000 cacheWrite=10000 over 1 turn(s) · cost ≈ $3.1250 (${COST_BASIS_LABEL})`) &&
      twoReplay.includes(`    openai/${SOL}: input=1000000 output=100000 cacheRead=0 cacheWrite=0 over 1 turn(s) · cost ≈ $1.5000 (${COST_BASIS_LABEL})`));

    // 3. One model unpriced (`litellmKey: null`) and one the cache never saw: floors that name them.
    const unpriced = 'session-20260904-100003';
    await writeSession(unpriced, [
      { provider: 'bedrock', model: OPUS, input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 10_000 },
      { provider: 'bedrock', model: 'us.made-up.model', input: 500, output: 50, cacheRead: 0, cacheWrite: 0 },
    ]);
    const unpricedRow = row((await run({ verb: 'list' }, prices)).out, unpriced);
    assert('an unpriced model makes the list total a floor that names it, never 0 and never dropped',
      unpricedRow.includes(`cost: ≥ $3.1250 (2 models; no price for us.made-up.model; ${COST_BASIS_LABEL})`));
    const unpricedReplay = (await run({ verb: 'replay', sessionId: unpriced, json: false }, prices)).out;
    assert('replay names the unpriced model on its own row too',
      unpricedReplay.includes(`  session cost: ≥ $3.1250 (2 models; no price for us.made-up.model; ${COST_BASIS_LABEL})`) &&
      unpricedReplay.includes('    bedrock/us.made-up.model: input=500 output=50 cacheRead=0 cacheWrite=0 over 1 turn(s) · cost unknown (no price for us.made-up.model)'));
    const unseen = 'session-20260904-100004';
    await writeSession(unseen, [
      { provider: 'bedrock', model: OPUS, input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 10_000 },
      { provider: 'anthropic', model: 'claude-never-fetched', input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
    ]);
    assert('a model the cache never recorded is unavailable, and named because it is one of two',
      row((await run({ verb: 'list' }, prices)).out, unseen)
        .includes(`cost: ≥ $3.1250 (2 models; price unavailable for claude-never-fetched; ${COST_BASIS_LABEL})`));

    // 4. No cache file: everything is unknown — the same words the live surfaces use, never $0.
    const missing = path.join(OWNED_HOME, 'prices', 'absent.json');
    const noCacheRow = row((await run({ verb: 'list' }, missing)).out, single);
    assert('no cache file reads unknown, not 0',
      noCacheRow.includes('cost: unknown (price unavailable)') && !noCacheRow.includes('$'));
    const noCacheReplay = (await run({ verb: 'replay', sessionId: two, json: false }, missing)).out;
    assert('replay without a cache says so per model as well',
      noCacheReplay.includes('  session cost: unknown (price unavailable for global.anthropic.claude-opus-5, openai.gpt-5.6-sol)') &&
      noCacheReplay.includes(`    openai/${SOL}: input=1000000 output=100000 cacheRead=0 cacheWrite=0 over 1 turn(s) · cost unknown (price unavailable)`));
    const damaged = path.join(OWNED_HOME, 'prices', 'damaged.json');
    await writeFile(damaged, '{not json', 'utf8');
    assert('a damaged cache reads as empty, never a crash',
      (await run({ verb: 'list' }, damaged)).code === 0 && row((await run({ verb: 'list' }, damaged)).out, single).includes('cost: unknown (price unavailable)'));

    // 5. An unreported bucket, a partly reported bucket, and a turn nothing measured: floors, said.
    const gaps = 'session-20260904-100005';
    await writeSession(gaps, [
      { provider: 'bedrock', model: OPUS, input: 1_000_000, output: 100_000, cacheRead: 500_000, cacheWrite: 10_000 },
      { provider: 'bedrock', model: OPUS, input: 0, output: 0 },
      undefined,
    ]);
    const gapsRow = row((await run({ verb: 'list' }, prices)).out, gaps);
    assert('a bucket only some turns reported is priced over the reported part and said to be partial, and unknown turns make it a floor',
      gapsRow.includes(`cost: ≥ $3.1250 (cacheRead partly reported, cacheWrite partly reported; 1 turn(s) unknown; ${COST_BASIS_LABEL})`));
    const unreported = 'session-20260904-100006';
    await writeSession(unreported, [{ provider: 'openai', model: SOL, input: 1_000_000, output: 100_000 }]);
    assert('a never-reported bucket is a floor naming the bucket, never priced as 0',
      row((await run({ verb: 'list' }, prices)).out, unreported)
        .includes(`cost: ≥ $1.5000 (cacheRead not reported, cacheWrite not reported; ${COST_BASIS_LABEL})`));

    // A session without any spend has nothing to price: the spend clause already says unknown.
    const legacy = 'session-20260904-100007';
    await writeSession(legacy, [undefined, undefined]);
    const legacyRow = row((await run({ verb: 'list' }, prices)).out, legacy);
    assert('a record without spend gets no cost clause and no fabricated figure',
      legacyRow.includes('spend: unknown') && !legacyRow.includes('cost:') && !legacyRow.includes('$'));
    const legacyReplay = (await run({ verb: 'replay', sessionId: legacy, json: false }, prices)).out;
    assert('replay of such a record prints no session cost line', !legacyReplay.includes('session cost') && legacyReplay.includes('session spend: unknown over 2 turn(s)'));

    // Determinism and the filtered replay.
    const again = (await run({ verb: 'replay', sessionId: two, json: false }, prices)).out;
    assert('the priced report is deterministic over the same bytes and cache', again === twoReplay);
    const oneTurn = await run({ verb: 'replay', sessionId: two, turn: 2, json: false }, prices);
    assert('a filtered replay prices the turn it replayed',
      oneTurn.code === 0 && oneTurn.out.includes(`  session cost: ≈ $1.5000 (${COST_BASIS_LABEL})`));
    const asJson = await run({ verb: 'replay', sessionId: two, json: true }, prices);
    assert('replay --json still prints history and nothing else', asJson.code === 0 && Array.isArray(JSON.parse(asJson.out)));

    // 6. The export path: replayRead without prices carries no cost, byte for byte as before.
    const read = await readTrajectory(trajectoryPath(ROOT, two));
    const unpricedResult = replayRead(read);
    assert('replayRead without prices carries no cost, so /export stays a projection of the record alone',
      unpricedResult.cost === undefined && !formatReplay(unpricedResult).includes('cost'));
    assert('…while the same read with prices does', replayRead(read, { prices: JSON.parse(cacheBytes.toString('utf8')) as ModelPriceCache }).cost !== undefined);

    // 7. Never a fetch, never a write.
    const cacheAfter = await stat(prices);
    assert('the price cache was never written: same bytes, same mtime',
      cacheAfter.mtimeMs === cacheBefore.mtimeMs && (await readFile(prices)).equals(cacheBytes));
    assert('the readers never reached fetch', fetched === 0);
    assert('no cache file was created where none existed', !(await stat(missing).then(() => true, () => false)));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(ROOT, { recursive: true, force: true });
  }
}

await main();
report();
