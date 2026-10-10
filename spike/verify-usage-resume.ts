/**
 * Session usage survives real SDK snapshots, fresh Agents and model switches.
 * Scripted SDK models, real runtime/storage, private HOME; no provider or network.
 * Run: pnpm tsx spike/verify-usage-resume.ts
 */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AfterInvocationEvent, HookOrder, Model, type Agent, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';
import { spawnSync } from 'node:child_process';
import type { SubagentDispatchRegistry } from '../src/agents/dispatch-registry.js';
import { allowAllBridge } from '../src/agent/permission.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { snapshotPath } from '../src/agent/session.js';
import { emptyCallStats } from '../src/agent/call-stats.js';
import { readSessionUsageState, SESSION_USAGE_KEY } from '../src/agent/usage-state.js';
import { sumUsage, type UsageTotals } from '../src/agent/usage.js';
import { configPath } from '../src/config.js';
import { formatUsageReport } from '../src/tui/App.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

if (process.argv[2] !== '--probe') ownPrivateHome('usage-resume');
const A = 'global.anthropic.claude-opus-5';
const B = 'openai.gpt-5.6-sol';
const TOKENS: Record<string, UsageTotals> = {
  [A]: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900, cacheWriteInputTokens: 50 },
  [B]: { inputTokens: 400, outputTokens: 20, cacheReadInputTokens: 300, cacheWriteInputTokens: 0 },
};
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

class MeteredModel extends Model<BaseModelConfig> {
  private conf: BaseModelConfig = { modelId: 'offline.usage', contextWindowLimit: 200_000 };
  constructor(private readonly tokens: UsageTotals) { super(); }
  override updateConfig(next: BaseModelConfig): void { this.conf = { ...this.conf, ...next }; }
  override getConfig(): BaseModelConfig { return this.conf; }
  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ok' } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMetadataEvent', usage: { ...this.tokens, totalTokens: this.tokens.inputTokens + this.tokens.outputTokens } };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-usage-resume-'));
  await mkdir(path.join(root, '.darwin'));
  await writeFile(configPath(root), JSON.stringify({
    permissionMode: 'yolo', trajectory: false,
    models: [
      { enable: true, name: 'a', provider: 'bedrock', model: A, region: 'us-west-2' },
      { enable: false, name: 'b', provider: 'openai', model: B, openaiApi: 'responses' },
    ],
  }));
  return root;
}

async function turn(runtime: AgentRuntime): Promise<void> {
  for await (const _event of runtime.send('ordinary metered turn')) { /* Drain the real SDK stream. */ }
}

function usageReport(runtime: AgentRuntime): string {
  return formatUsageReport(runtime.usage, runtime.config, runtime.info.resumed, false,
    runtime.lastTurnUsage, runtime.childUsage, runtime.callStats, runtime.modelShares,
    runtime.cacheMissReport(), runtime.hasCompleteUsageHistory);
}

async function create(root: string, id?: string): Promise<AgentRuntime> {
  return AgentRuntime.create({ projectRoot: root,
    session: id === undefined ? { kind: 'new' } : { kind: 'id', sessionId: id },
    permissionBridge: allowAllBridge,
  });
}

async function main(): Promise<void> {
  setRuntimeModelFactoryForTest(async (config) => new MeteredModel(TOKENS[config.model]!));
  const root = await fixture();
  try {
    await resume(root);
    await legacy(root);
    await auxiliary(root);
    await unknownCounters(root);
    schema();
  } finally {
    setRuntimeModelFactoryForTest(undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function resume(root: string): Promise<void> {
  header('usage — snapshot restoration, multiple models and repeated resumes');
  let runtime = await create(root);
  const id = runtime.info.sessionId;
  try {
    await turn(runtime);
    await (await runtime.changeModel(runtime.modelChoices.find((entry) => entry.name === 'b')!)).saved;
    await turn(runtime);
    const expected = runtime.usage;
    const lastTurn = runtime.lastTurnUsage;
    const stats = runtime.callStats;
    const shares = runtime.modelShares.map(({ config, usage }) => ({ model: config.model, provider: config.provider, openaiApi: config.openaiApi, usage }));
    const file = snapshotPath(root, id, 'darwin');
    const before = await readFile(file);
    const snapshot = JSON.parse(before.toString());
    const saved = readSessionUsageState(snapshot.data.state[SESSION_USAGE_KEY]);
    assert('SDK autosave contains reconciled counter-only usage state before shutdown', saved !== undefined && equal(saved.usage, expected));
    assert('usage persists even when trajectory is disabled', runtime.trajectoryStatus === undefined && saved?.callStats?.calls === 2);
    assert('the checkpoint does not persist model configuration or credentials',
      saved !== undefined && saved.models.every((entry) => Object.keys(entry).every((key) => ['provider', 'model', 'openaiApi', 'usage'].includes(key))));
    await runtime.shutdown();
    const probe = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename, '--probe', root, id], {
      encoding: 'utf8', env: process.env, timeout: 30_000,
    });
    assert('a separate process resumes the saved usage without invoking a model',
      probe.status === 0 && equal(JSON.parse(probe.stdout).usage, expected) && JSON.parse(probe.stdout).calls === 2);
    runtime = await create(root, id);
    assert('resume restores the exact parent meter and latest-turn delta without a model call', equal(runtime.usage, expected) && equal(runtime.lastTurnUsage, lastTurn));
    assert('resume restores call efficiency', equal(runtime.callStats, stats));
    assert('resume keeps per-model attribution and Responses cache semantics', equal(runtime.modelShares.map(({ config, usage }) => ({ model: config.model, provider: config.provider, openaiApi: config.openaiApi, usage })), shares));
    assert('all per-model shares reconcile to the restored meter', equal(sumUsage(runtime.modelShares.map((share) => share.usage)), runtime.usage));
    assert('/usage names the session scope and includes prior runs', usageReport(runtime).includes('including earlier runs') && !usageReport(runtime).includes('unavailable: no valid'));
    assert('resume and report reads do not rewrite the snapshot', (await readFile(file)).equals(before));
    await runtime.shutdown();
    runtime = await create(root, id);
    assert('a second no-turn resume does not double-count the prefix', equal(runtime.usage, expected));
    assert('headless receipts start with a clean process meter, not historical spend', equal(runtime.runAccounting.usage, { inputTokens: 0, outputTokens: 0 }) && runtime.runAccounting.callStats === undefined);
    assert('historical models are not billed again by the headless cost projection', runtime.runAccounting.modelShares.length === 1 && runtime.runAccounting.modelShares[0]?.config.model === B);
    await turn(runtime);
    const after = sumUsage([expected, TOKENS[B]!]);
    assert('new calls add to the prefix exactly once', equal(runtime.usage, after));
    assert('last-turn usage excludes the restored prefix', equal(runtime.lastTurnUsage, TOKENS[B]));
    assert('new calls extend restored efficiency', runtime.callStats?.calls === 3);
    assert('headless receipts count only this run and price only the model it used',
      equal(runtime.runAccounting.usage, TOKENS[B]) && runtime.runAccounting.callStats?.calls === 1 &&
      runtime.runAccounting.modelShares.length === 1 && equal(runtime.runAccounting.modelShares[0]?.usage, TOKENS[B]));
    await runtime.shutdown();
    runtime = await create(root, id);
    assert('the updated aggregate survives another resume', equal(runtime.usage, after) && runtime.callStats?.calls === 3);
    const source = await readFile(file);
    const checkpoints = await runtime.listRewindCheckpoints();
    runtime = await runtime.startRewind(checkpoints.checkpoints[0]!);
    assert('rewind starts a fresh accounting session, not the source counters', runtime.usage.inputTokens === 0 && runtime.callStats === undefined && runtime.childUsage === undefined);
    assert('rewind leaves the source usage snapshot unchanged', (await readFile(file)).equals(source));
    const branchId = runtime.info.sessionId;
    await runtime.shutdown();
    runtime = await create(root, branchId);
    assert('an unsent rewind branch resumes with known zero spend, not a historical gap', runtime.hasCompleteUsageHistory && runtime.usage.inputTokens === 0);
    await turn(runtime);
    runtime = await runtime.startNewSession();
    assert('/clear still resets all usage and efficiency', runtime.usage.inputTokens === 0 && runtime.lastTurnUsage === undefined && runtime.callStats === undefined && runtime.hasCompleteUsageHistory);
    assert('/clear also leaves the old source snapshot unchanged', (await readFile(file)).equals(source));
  } finally { await runtime.shutdown(); }
}

async function legacy(root: string): Promise<void> {
  header('usage — legacy and damaged snapshots degrade explicitly');
  let runtime = await create(root);
  const id = runtime.info.sessionId;
  try {
    await turn(runtime);
    const file = snapshotPath(root, id, 'darwin');
    await runtime.shutdown();
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    delete snapshot.data.state[SESSION_USAGE_KEY];
    await writeFile(file, JSON.stringify(snapshot));
    runtime = await create(root, id);
    assert('legacy resume remains usable and states that previous usage is unavailable', !runtime.hasCompleteUsageHistory && usageReport(runtime).includes('earlier usage unavailable'));
    await turn(runtime);
    const newUsage = runtime.usage;
    await runtime.shutdown();
    runtime = await create(root, id);
    assert('known new usage persists without pretending the legacy gap was repaired', equal(runtime.usage, newUsage) && !runtime.hasCompleteUsageHistory);
    await runtime.shutdown();
    const damaged = JSON.parse(await readFile(file, 'utf8'));

    damaged.data.state[SESSION_USAGE_KEY].usage.inputTokens = -1;
    await writeFile(file, JSON.stringify(damaged));
    runtime = await create(root, id);
    assert('invalid persisted counters never poison startup or the live meter', runtime.usage.inputTokens === 0 && !runtime.hasCompleteUsageHistory);
  } finally { await runtime.shutdown(); }
}

async function auxiliary(root: string): Promise<void> {
  header('usage — child aggregates, cache misses and absent counters survive resume');
  let runtime = await create(root);
  const id = runtime.info.sessionId;
  const prior = TOKENS[A]!;
  try {
    await (await runtime.changeModel(runtime.modelChoices.find((entry) => entry.name === 'a')!)).saved;
    await turn(runtime);
    const registry = (runtime as unknown as { subagentDispatches: SubagentDispatchRegistry }).subagentDispatches;
    const childTokens = { inputTokens: 7, outputTokens: 2 };
    const child = registry.begin({ agentName: 'general', task: 'counter-only fixture' });
    child.attachUsage(() => childTokens);
    child.finish('succeeded');
    TOKENS[A]!.cacheReadInputTokens = 0;
    await turn(runtime);
    const misses = runtime.cacheMissReport();
    const children = runtime.childUsage;
    assert('fixture records a real tracker miss and a metered dispatch', misses.misses > 0 && children?.dispatches === 1);
    await runtime.shutdown();
    runtime = await create(root, id);
    assert('resume retains child counters and dispatch count without resurrecting jobs', equal(runtime.childUsage, children) && (runtime as unknown as { subagentDispatches: SubagentDispatchRegistry }).subagentDispatches.list().length === 0);
    assert('headless child receipts do not re-emit old dispatches', runtime.runAccounting.childUsage === undefined);
    assert('resume retains cache-miss count and verdict, but makes no stale warmth claim', equal(runtime.cacheMissReport(), misses) && runtime.cacheWarmth(Date.now()) === undefined);
    const nextRegistry = (runtime as unknown as { subagentDispatches: SubagentDispatchRegistry }).subagentDispatches;
    const next = nextRegistry.begin({ agentName: 'general', task: 'new metered dispatch' });
    next.attachUsage(() => childTokens);
    next.finish('failed');
    assert('new child spend adds to the restored prefix once', runtime.childUsage?.dispatches === 2 && equal(runtime.childUsage?.usage, sumUsage([childTokens, childTokens])));
    await turn(runtime);
    await runtime.shutdown();
    runtime = await create(root, id);
    assert('the combined child aggregate survives the next resume', runtime.childUsage?.dispatches === 2 && equal(runtime.sessionUsage, sumUsage([runtime.usage, childTokens, childTokens])));
    const savedFile = snapshotPath(root, id, 'darwin');
    const beforeFailure = runtime.usage;
    const failure = new Error('offline invocation failed after a completed call');
    const agent = (runtime as unknown as { agent: Agent }).agent;
    agent.addHook(AfterInvocationEvent, () => { throw failure; }, { order: HookOrder.SDK_LAST });
    let caught: unknown;
    try { await turn(runtime); } catch (error) { caught = error; }
    assert('an accounting snapshot does not replace the original invocation error', caught === failure);
    const spent = runtime.usage;
    assert('the failed invocation still counted its completed model call', spent.inputTokens > beforeFailure.inputTokens);
    await runtime.shutdown();
    runtime = await create(root, id);
    assert('completed spend survives an invocation that failed after autosave', equal(runtime.usage, spent) && (await readFile(savedFile)).length > 0);
  } finally {
    TOKENS[A] = prior;
    TOKENS[A]!.cacheReadInputTokens = 900;
    await runtime.shutdown();
  }
}

async function unknownCounters(root: string): Promise<void> {
  header('usage — a saved cache measurement cannot fabricate this run\'s metrics');
  let runtime = await create(root);
  const id = runtime.info.sessionId;
  const original = { ...TOKENS[B]! };
  try {
    await (await runtime.changeModel(runtime.modelChoices.find((entry) => entry.name === 'b')!)).saved;
    await turn(runtime);
    await runtime.shutdown();
    delete TOKENS[B]!.cacheReadInputTokens;
    delete TOKENS[B]!.cacheWriteInputTokens;
    runtime = await create(root, id);
    await turn(runtime);
    assert('the session retains the historical reported cache count', runtime.usage.cacheReadInputTokens === original.cacheReadInputTokens);
    const current = runtime.runAccounting;
    assert('the new run meter and efficiency keep unreported cache counters absent',
      current.usage.cacheReadInputTokens === undefined && current.callStats?.usage?.cacheReadInputTokens === undefined);
    assert('the new run cost projection also preserves absent counters', current.modelShares.length === 1 && current.modelShares[0]?.usage.cacheReadInputTokens === undefined);
    assert('the process model shares reconcile to the authoritative new SDK meter', equal(sumUsage(current.modelShares.map((share) => share.usage)), current.usage));
  } finally { TOKENS[B] = original; await runtime.shutdown(); }
}

function schema(): void {
  header('usage — bounded schema and absent metrics');
  const tokens = { inputTokens: 12, outputTokens: 3 };
  const state = { version: 1, historyComplete: true, usage: tokens,
    models: [{ provider: 'openai', model: B, openaiApi: 'chat', usage: tokens }],
    callStats: emptyCallStats(), cacheMisses: { misses: 0 },
  };
  const saved = readSessionUsageState(state);
  assert('unreported cache counters remain absent, not zero', saved !== undefined && !('cacheReadInputTokens' in saved.usage));
  assert('invalid versions are refused', readSessionUsageState({ ...state, version: 2 }) === undefined);
  assert('non-reconciling model shares are refused', readSessionUsageState({ ...state, usage: { ...tokens, inputTokens: 13 } }) === undefined);
  assert('negative, fractional and nonfinite counters are refused', [-1, 0.5, Infinity, NaN].every((inputTokens) => readSessionUsageState({ ...state, usage: { inputTokens, outputTokens: 3 } }) === undefined));
  assert('overflowing state and model arrays are bounded', readSessionUsageState({ ...state, padding: 'x'.repeat(65_537) }) === undefined && readSessionUsageState({ ...state, models: Array(129).fill(state.models[0]) }) === undefined);
  assert('inconsistent call stats are refused', readSessionUsageState({ ...state, callStats: { ...emptyCallStats(), calls: 1 } }) === undefined);
  assert('broken observers survive as unknown, not revived zeroes', readSessionUsageState({ ...state, callStats: null, cacheMisses: null })?.callStats === null);
  const withChildren = readSessionUsageState({ ...state, children: { dispatches: 2, usage: tokens } });
  assert('child aggregates persist only counters and dispatch count', withChildren?.children?.dispatches === 2 && equal(withChildren.children.usage, tokens));
}

if (process.argv[2] === '--probe') {
  // The factory is needed for assembly, but a stream call is never allowed here.
  setRuntimeModelFactoryForTest(async () => new class extends MeteredModel {
    override async *stream(): AsyncIterable<ModelStreamEvent> { throw new Error('resume called the model'); }
  }({ inputTokens: 0, outputTokens: 0 }));
  const runtime = await create(process.argv[3]!, process.argv[4]!);
  try { console.log(JSON.stringify({ usage: runtime.usage, calls: runtime.callStats?.calls })); }
  finally { await runtime.shutdown(); }
} else {
  await main();
  report();
}
