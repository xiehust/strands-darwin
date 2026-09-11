/** Cloud-memory lifecycle regressions B/C plus review races, offline and standalone.
 * Covers cancelled-ACK fresh-activity handoff, delayed-close signal ownership,
 * durable peer launch fencing and suspended-origin reconsent/status.
 * Run: pnpm tsx spike/verify-cloud-memory-lifecycle.ts
 * Actual AgentRuntime, scripted Model, real fileEditor view, real trajectory writes,
 * native persistUploadMode and signed AWS SDK loopback. All state lives in ownPrivateHome.
 * No darwin/CLI, external cloud, developer config, synthetic settlement or SDK-loop replacement.
 */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
process.env['AWS_EC2_METADATA_DISABLED'] = 'true';

import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import {
  Model, ModelError, type BaseModelConfig, type Message, type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';
import {
  AgentRuntime, setRuntimeModelFactoryForTest, setRuntimeRecorderOverridesForTest,
} from '../src/agent/runtime.js';
import { trajectoryPath } from '../src/agent/session.js';
import type { RewindCheckpoint } from '../src/agent/rewind.js';
import type { TurnSettlement } from '../src/trajectory/writer.js';
import { configPath, loadConfig } from '../src/config.js';
import { cloudBinding } from '../src/project-overrides.js';
import { CloudMemory } from '../src/agentcore/controller.js';
import { digest, parseAgentCoreConfig } from '../src/agentcore/config.js';
import { persistUploadMode } from '../src/agentcore/auto-policy.js';
import { AUTO_RETENTION_MS, tokenReceipt } from '../src/agentcore/auto-state.js';
import { cloudDirectory, readState, writeState, setCloudStateObserverForTest } from '../src/agentcore/state.js';
import { setMemoryTransportOptionsForTest } from '../src/agentcore/transport.js';
import { loopbackHandler } from './agentcore-sdk-fixture.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('cloud-lifecycle');
const signal = new AbortController().signal;
const base = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'synthetic-user', episodicStrategyId: 'episodes-0123456789', preferenceStrategyId: 'preferences-0123456789', preferences: false, upload: 'manual' })!;
const evidence = 'REAL FILE EDITOR EVIDENCE 中文\nnot assistant prose\n';
const runtimes = new Set<AgentRuntime>();
const controllers = new Set<CloudMemory>();
const releases = new Set<() => void>();
function gate() {
  let release!: () => void; let enter!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { enter = resolve; });
  releases.add(release);
  return { wait, reached, release, enter };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing fixture evidence: ${label}`);
  return value;
}
const calls: { body: string; authorization: string }[] = [];
let launches = 0;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  calls.push({ body, authorization: String(request.headers.authorization) });
  const input = JSON.parse(body);
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ event: { memoryId: base.memoryId, actorId: base.actorId, sessionId: input.sessionId, eventId: `synthetic-${calls.length}` } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = (server.address() as { port: number }).port;
setMemoryTransportOptionsForTest(() => {
  const handler = loopbackHandler(port);
  return {
    credentials: { accessKeyId: 'SYNTHETICKEY', secretAccessKey: 'synthetic-secret' },
    requestHandler: { ...handler, handle: (...args: Parameters<typeof handler.handle>) => {
      launches++; return handler.handle(...args);
    } },
  };
});
function* text(value = 'ASSISTANT EXCLUDED'): Iterable<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' };
  yield { type: 'modelContentBlockStartEvent' };
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: value } };
  yield { type: 'modelContentBlockStopEvent' };
  yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
}
function* toolUse(id: string, name: string, input: unknown): Iterable<ModelStreamEvent> {
  yield { type: 'modelMessageStartEvent', role: 'assistant' };
  yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId: id } };
  yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } };
  yield { type: 'modelContentBlockStopEvent' };
  yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
}
class ReadModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline-lifecycle' };
  calls = 0;
  constructor(readonly root: string, readonly failure?: ModelError) { super(); }
  override updateConfig(value: BaseModelConfig) { this.config = { ...this.config, ...value }; }
  override getConfig() { return this.config; }
  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    const call = this.calls++;
    if (call === 1 && this.failure) throw this.failure;
    if (call % 2 === 0) yield* toolUse(`view-${call}`, 'fileEditor', { command: 'view', path: path.join(this.root, 'evidence.txt') });
    else yield* text();
  }
}
type CloudWork = { chain: Promise<void>; autoWork: Promise<void>; autoSuspended: boolean; autoAbort: AbortController; closes: Map<number, { completed?: boolean; settled?: unknown }> };
type RecorderReach = { chain: Promise<void>; publishSettlement: (settlement: TurnSettlement) => void };
const cloud = (runtime: AgentRuntime) => (runtime as unknown as { cloudMemory: CloudMemory }).cloudMemory;
const work = (memory: CloudMemory) => memory as unknown as CloudWork;
const recorder = (runtime: AgentRuntime) => (runtime as unknown as { trajectory: RecorderReach }).trajectory;
const box = (memory: CloudMemory) => path.join(cloudDirectory(memory.config, memory.root), cloudBinding(memory.config, memory.root));
const stateFile = (memory: CloudMemory, token: string, suffix: string) => path.join(box(memory), `${token}.${suffix}.json`);
async function settleWork(runtime: AgentRuntime) {
  await bounded((async () => {
    const memory = work(cloud(runtime));
    // A cancelled pass may hand a fresh turn's earned activity to a new promise in
    // finally. Awaiting only the original autoWork misses precisely that handoff.
    for (;;) {
      const closing = recorder(runtime).chain;
      await closing;
      const publication = memory.chain;
      await publication;
      const automatic = memory.autoWork;
      await automatic;
      if (closing === recorder(runtime).chain && publication === memory.chain && automatic === memory.autoWork) return;
    }
  })(), 'stable real closing append, projection and automatic passes');
}
async function drain(runtime: AgentRuntime, prompt = 'Read the actual evidence file') {
  for await (const _event of runtime.send(prompt)) { /* consume the complete natural generator */ }
}
async function configured(label: string): Promise<string> {
  const root = path.join(home, label); await mkdir(root);
  await writeFile(path.join(root, 'evidence.txt'), evidence);
  await mkdir(path.dirname(configPath(root)), { recursive: true });
  await writeFile(configPath(root), JSON.stringify({ model: 'offline-lifecycle', promptCache: false, memory: false, contextOffload: false, trajectory: true, agentCoreMemory: base }));
  await persistUploadMode(root, base, 'auto', signal);
  return root;
}
async function create(root: string, model: Model = new ReadModel(root), sessionId?: string, background = false) {
  setRuntimeModelFactoryForTest(async () => model);
  const runtime = await AgentRuntime.create({ projectRoot: root, session: sessionId === undefined ? { kind: 'new' } : { kind: 'id', sessionId }, backgroundCompletionWakes: background, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: true }) });
  runtimes.add(runtime); return runtime;
}
async function shutdown(runtime: AgentRuntime) { await bounded(runtime.shutdown(), 'runtime shutdown'); runtimes.delete(runtime); }
interface Candidate { token: string; bytes: string; entry: { body: { sessionId: string; clientToken: string; payload: { conversational: { content: { text: string } } }[] } }; }
async function candidate(runtime: AgentRuntime, turn = 1): Promise<Candidate> {
  const memory = cloud(runtime);
  for (const name of await readdir(box(memory))) {
    if (!name.endsWith('.event.json')) continue;
    const bytes = await readFile(path.join(box(memory), name), 'utf8');
    const entry: Candidate['entry'] = JSON.parse(bytes);
    const metadata = JSON.parse(entry.body.payload[0]!.conversational.content.text);
    if (entry.body.sessionId === runtime.info.sessionId && metadata.turn === turn) return { token: name.slice(0, -11), bytes, entry };
  }
  throw new Error(`Missing actual runtime candidate ${runtime.info.sessionId}/${turn}`);
}
async function heldProof(runtime: AgentRuntime, item: Candidate, label: string) {
  const proof = await readState(stateFile(cloud(runtime), item.token, 'auto')) as { hash?: string; reason?: string } | undefined;
  assert(`${label}: real view input/result retained, assistant excluded`, item.bytes.includes('fileEditor') && item.bytes.includes('REAL FILE EDITOR EVIDENCE') && !item.bytes.includes('ASSISTANT EXCLUDED'));
  assert(`${label}: exact body hash bound to explicit driver hold`, proof?.hash === digest(item.entry) && /abandoned|cancelled/i.test(proof?.reason ?? ''));
  assert(`${label}: no attempt or acceptance`, await readState(stateFile(cloud(runtime), item.token, 'attempt-1')) === undefined && await tokenReceipt(box(cloud(runtime)), item.token) === undefined);
}
function pauseState(memory: CloudMemory, suffix: string) {
  const paused = gate(); let file: string | undefined;
  setCloudStateObserverForTest(async (name, boundary) => {
    if (file === undefined && path.dirname(name) === box(memory) && name.endsWith(suffix) && boundary === 'before-publish') {
      file = name; paused.enter(); await paused.wait;
    }
  });
  return { ...paused, file: () => requireValue(file, suffix) };
}
async function restartDrain(root: string, old: Candidate, label: string, expected = 1) {
  // A genuinely fresh runtime/controller earns a real pass with its own new turn.
  // Same policy epoch and unchanged old proof/body; no manual kickAuto invocation.
  const fresh = await create(root);
  const before = launches;
  await drain(fresh); await settleWork(fresh);
  assert(`${label}: fresh controller sends only its own future turn`, launches === before + expected && calls.slice(before).every(call => JSON.parse(call.body).clientToken !== old.token));
  assert(`${label}: old immutable body unchanged on restart drain`, await readFile(stateFile(cloud(fresh), old.token, 'event'), 'utf8') === old.bytes);
  await shutdown(fresh);
}

/** Real recorder seam: forward every FileHandle method; only the closing write waits.
 * No hand-authored TurnSettlement: append() still writes, closes and publishes it.
 */
function closingWriteGate() {
  const paused = gate(); let held = false;
  setRuntimeRecorderOverridesForTest({ openFile: async (...args) => {
    const handle = await open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'write') return async (...writeArgs: Parameters<typeof handle.write>) => {
        const payload = writeArgs[0];
        if (!held && typeof payload === 'string' && payload.includes('"type":"turnEnded"')) {
          held = true; paused.enter(); await paused.wait;
        }
        return Reflect.apply(target.write, target, writeArgs);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } });
  return paused;
}
/** Normally recordStream.end schedules the close only once resumed past the last yield.
 * To exercise the opposite order deterministically, wrap the actual TurnRecording:
 * after recording final agentResult, call its real idempotent end() early. Its genuine
 * append/settlement can finish while the driver is still at that final yield. This
 * deliberately accelerates ONLY the recorder seam, never manufactures settlement or
 * calls CloudMemory.sealTurn. recordStream's later end() is the ordinary no-op.
 */
function closeRecorderAtFinalResult(runtime: AgentRuntime) {
  const rec = (runtime as unknown as { trajectory: import('../src/trajectory/writer.js').TrajectoryRecorder }).trajectory;
  const original = rec.beginTurn.bind(rec);
  rec.beginTurn = (...args: Parameters<typeof rec.beginTurn>) => {
    const turn = original(...args);
    if (turn) {
      const record = turn.record.bind(turn);
      turn.record = event => { record(event); if (event.type === 'agentResultEvent') turn.end(); };
    }
    return turn;
  };
  return () => { rec.beginTurn = original; };
}
function observeSettlement(runtime: AgentRuntime) {
  const rec = recorder(runtime); const original = rec.publishSettlement.bind(rec);
  const seen: TurnSettlement[] = [];
  rec.publishSettlement = value => { seen.push(value); original(value); };
  return seen;
}

async function abandonedFinals() {
  header('B: breaking on final agentResult is not natural driver completion');
  for (const cancel of [false, true]) {
    const label = `final-break-${cancel ? 'cancel' : 'no-cancel'}`;
    const root = await configured(label); const runtime = await create(root);
    const before = launches; let finalSeen = false;
    for await (const event of runtime.send(label)) {
      if (event.type === 'agentResultEvent') {
        finalSeen = event.result.stopReason === 'endTurn';
        if (cancel) runtime.cancel();
        break;
      }
    }
    await settleWork(runtime);
    const old = await candidate(runtime);
    assert(`${label}: final endTurn observed, zero immediate HTTP starts`, finalSeen && launches === before);
    await heldProof(runtime, old, label);
    const preview = await runtime.manageCloudMemory(`preview ${old.token}`);
    const previewBytes = await readFile(stateFile(cloud(runtime), old.token, 'preview'), 'utf8');
    assert(`${label}: manual preview still binds the exact original hash`, preview.includes(digest(old.entry)) && preview.includes('REAL FILE EDITOR EVIDENCE'));
    await drain(runtime, 'Next ordinary qualifying read'); await settleWork(runtime);
    assert(`${label}: next activity cannot revive old candidate`, launches === before);
    const next = await candidate(runtime, 2);
    const nextProof = await readState(stateFile(cloud(runtime), next.token, 'auto')) as { reason?: string };
    assert(`${label}: next natural turn eligible but respects earlier pending order`, nextProof.reason === undefined);
    const reopened = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, runtime.info.sessionId);
    controllers.add(reopened);
    await reopened.command('status'); await reopened.command('pending');
    await reopened.close(); controllers.delete(reopened);
    assert(`${label}: reopened controller/status/close performs no send`, launches === before);
    await shutdown(runtime);
    assert(`${label}: runtime close performs no send and preserves manual body/proof`, launches === before && await readFile(stateFile(cloud(runtime), old.token, 'event'), 'utf8') === old.bytes && await readFile(stateFile(cloud(runtime), old.token, 'preview'), 'utf8') === previewBytes);
    await restartDrain(root, old, label);
  }
}

async function closingOrders() {
  header('B: actual closing append and natural completion join in either order');
  for (const order of ['settlement-first', 'seal-first'] as const) {
    for (const cancel of [false, true]) {
      const label = `${order}-${cancel ? 'cancel-before-close' : 'normal'}`;
      const root = await configured(label); const paused = closingWriteGate();
      const runtime = await create(root); const observed = observeSettlement(runtime);
      const restore = order === 'settlement-first' ? closeRecorderAtFinalResult(runtime) : () => {};
      const before = launches;
      let finalSeen = false;
      const running = (async () => {
        for await (const event of runtime.send(label)) {
          if (event.type !== 'agentResultEvent') continue;
          finalSeen = event.result.stopReason === 'endTurn';
          if (order === 'settlement-first') {
            await bounded(paused.reached, 'accelerated genuine recorder closing write');
            assert(`${label}: no durable closing record before release`, !(await readFile(trajectoryPath(root, runtime.info.sessionId), 'utf8')).includes('"type":"turnEnded"') && observed.length === 0);
            if (cancel) runtime.cancel();
            paused.release(); await bounded(recorder(runtime).chain, 'settlement before resuming driver');
            assert(`${label}: real durable settlement while driver remains at final yield`, observed.length === 1 && observed[0]!.durable);
            if (!cancel) assert(`${label}: settlement alone cannot authorize HTTP`, launches === before && work(cloud(runtime)).closes.get(1)?.settled !== undefined && work(cloud(runtime)).closes.get(1)?.completed === undefined);
          } else if (cancel) {
            // At final yield the recorder has not yet scheduled its closing append.
            runtime.cancel();
          }
        }
      })();
      if (order === 'seal-first') {
        await bounded(paused.reached, 'normal real recorder closing write');
        await bounded(running, 'natural driver completes before closing append');
        assert(`${label}: driver seals before durable settlement`, finalSeen && observed.length === 0 && work(cloud(runtime)).closes.get(1)?.completed === !cancel && launches === before);
        assert(`${label}: closing bytes really absent while paused`, !(await readFile(trajectoryPath(root, runtime.info.sessionId), 'utf8')).includes('"type":"turnEnded"'));
        paused.release();
      }
      await bounded(running, label); await settleWork(runtime); restore();
      setRuntimeRecorderOverridesForTest(undefined);
      const old = await candidate(runtime);
      assert(`${label}: genuine durable endTurn delivered exactly once`, observed.length === 1 && observed[0]!.durable && observed[0]!.stopReason === 'endTurn');
      if (cancel) {
        assert(`${label}: cancellation before durable append prevents HTTP`, launches === before);
        await heldProof(runtime, old, label);
        await drain(runtime, 'Ordinary activity after closing cancellation'); await settleWork(runtime);
        assert(`${label}: no later same-session send revives held proof`, launches === before);
      } else {
        assert(`${label}: natural qualifying turn sends exactly once`, launches === before + 1 && (await tokenReceipt(box(cloud(runtime)), old.token))?.disposition === 'accepted');
      }
      await shutdown(runtime);
      if (cancel) await restartDrain(root, old, label);
    }
  }
  // Cancellation can also land after seal(true), while its durable half is pending.
  const root = await configured('cancel-after-natural-seal'); const paused = closingWriteGate();
  const runtime = await create(root); const before = launches;
  await drain(runtime); await bounded(paused.reached, 'closing append after natural seal');
  assert('late cancel fixture: natural seal true with no settlement yet', work(cloud(runtime)).closes.get(1)?.completed === true);
  runtime.cancel(); paused.release(); await settleWork(runtime);
  setRuntimeRecorderOverridesForTest(undefined);
  const old = await candidate(runtime);
  assert('cancel after natural seal but before durable append prevents send', launches === before);
  await heldProof(runtime, old, 'late cancel'); await shutdown(runtime);
  await restartDrain(root, old, 'late cancel');
}

async function exactFailure() {
  header('B: model failure identity survives runtime, recorder and cloud collection');
  const root = await configured('model-error');
  const sentinel = new ModelError('lifecycle original model failure');
  const runtime = await create(root, new ReadModel(root, sentinel)); const before = launches;
  let caught: unknown;
  try { await drain(runtime); } catch (error) { caught = error; }
  await settleWork(runtime);
  assert('the exact SDK ModelError object is rethrown, not wrapped', caught === sentinel && caught instanceof ModelError);
  const old = await candidate(runtime);
  assert('failed real read is held without HTTP and retains failure trajectory', launches === before && (await readFile(trajectoryPath(root, runtime.info.sessionId), 'utf8')).includes(sentinel.message));
  await heldProof(runtime, old, 'ModelError');
  await shutdown(runtime); await restartDrain(root, old, 'ModelError');
}

type Transition = 'clear' | 'rewind';
function transition(runtime: AgentRuntime, kind: Transition, checkpoint: RewindCheckpoint) {
  return kind === 'clear' ? runtime.startNewSession() : runtime.startRewind(checkpoint);
}
async function stoppedSession(memory: CloudMemory) {
  return await readState(stateFile(memory, digest(memory.session), 'session-stop')) as { session?: string } | undefined;
}
async function transitionRaces() {
  header('C: predecessor auto stops before slow successor construction, even on failure');
  for (const kind of ['clear', 'rewind'] as const) {
    for (const fail of [false, true]) {
      const label = `${kind}-${fail ? 'failed' : 'successful'}-slow-successor`;
      const root = await configured(label); const runtime = await create(root);
      const memory = cloud(runtime); const before = launches;
      const attempt = pauseState(memory, '.attempt-1.json');
      await drain(runtime);
      await bounded(attempt.reached, `${label} reserved attempt boundary`);
      const checkpoint = requireValue((await runtime.listRewindCheckpoints()).checkpoints[0], 'actual checkpoint');
      const old = await candidate(runtime);
      const proofFile = stateFile(memory, old.token, 'auto'); const proofBytes = await readFile(proofFile, 'utf8');
      assert(`${label}: old candidate genuinely eligible before transition`, (JSON.parse(proofBytes) as { reason?: string }).reason === undefined && launches === before && attempt.file() === stateFile(memory, old.token, 'attempt-1'));
      const preview = await runtime.manageCloudMemory(`preview ${old.token}`);
      assert(`${label}: manual preview is available before transition`, preview.includes(digest(old.entry)));
      const previewBytes = await readFile(stateFile(memory, old.token, 'preview'), 'utf8');
      const factory = gate(); const sentinel = new Error(`${label} original construction error`);
      setRuntimeModelFactoryForTest(async () => {
        factory.enter(); await factory.wait;
        if (fail) throw sentinel;
        return new ReadModel(root);
      });
      const pending = transition(runtime, kind, checkpoint).then(
        successor => { runtimes.add(successor); return { successor, error: undefined }; },
        (error: unknown) => ({ successor: undefined, error }),
      );
      assert(`${label}: suspension and abort precede the first transition await`, work(memory).autoSuspended && work(memory).autoAbort.signal.aborted);
      await bounded(factory.reached, `${label} paused model factory`);
      assert(`${label}: per-session stop durable before successor model construction`, (await stoppedSession(memory))?.session === runtime.info.sessionId && (await loadConfig(root)).agentCoreMemory?.upload === 'auto');
      assert(`${label}: explicit conservative-stop notice while predecessor is live`, runtime.cloudMemoryStatus.includes('Predecessor automatic uploads stopped') && runtime.cloudMemoryStatus.includes('even if successor startup fails'));
      attempt.release(); await settleWork(runtime);
      assert(`${label}: releasing old sender during paused factory starts no HTTP`, launches === before && await readState(attempt.file()) === undefined);
      setCloudStateObserverForTest(undefined);
      factory.release(); const outcome = await bounded(pending, label);
      if (fail) {
        assert(`${label}: identical construction error and cloud notice preserved`, outcome.error === sentinel && runtime.cloudMemoryStatus.includes('Predecessor automatic uploads stopped'));
        setRuntimeModelFactoryForTest(async () => new ReadModel(root));
        await drain(runtime, 'Ordinary activity after failed successor'); await settleWork(runtime);
        const later = await candidate(runtime, 2);
        assert(`${label}: failed transition never re-enables predecessor on next turn`, launches === before && work(memory).autoSuspended && await readState(stateFile(memory, later.token, 'auto')) === undefined);
        await suspendedReconsent(runtime, old, label);
      } else {
        const successor = requireValue(outcome.successor, 'successful successor');
        runtimes.delete(runtime); // retired by the real transition; process state belongs to successor
        assert(`${label}: successor retains project auto but has new session`, successor.info.sessionId !== runtime.info.sessionId && successor.config.agentCoreMemory?.upload === 'auto');
        await drain(successor); await settleWork(successor);
        const sent = await candidate(successor);
        assert(`${label}: only future successor turn is accepted`, launches === before + 1 && (await tokenReceipt(box(cloud(successor)), sent.token))?.disposition === 'accepted' && calls.at(-1)?.body.includes(successor.info.sessionId) === true);
        await shutdown(successor);
      }
      assert(`${label}: transition preserves original manual body/hash/proof`, await readFile(stateFile(memory, old.token, 'event'), 'utf8') === old.bytes && await readFile(proofFile, 'utf8') === proofBytes && await readFile(stateFile(memory, old.token, 'preview'), 'utf8') === previewBytes && await tokenReceipt(box(memory), old.token) === undefined);
      await restartDrain(root, old, label);
      // Reopen the stopped origin itself: its new ordinary activity must not re-arm
      // old proofs, even though config still authorizes future *other* sessions.
      const resumed = await create(root, new ReadModel(root), runtime.info.sessionId);
      const beforeResume = launches;
      await drain(resumed, 'New activity in stopped origin after runtime reconstruction'); await settleWork(resumed);
      assert(`${label}: resumed stopped origin cannot send stale or new origins`, launches === beforeResume && await tokenReceipt(box(memory), old.token) === undefined);
      await shutdown(resumed);
    }
  }
}
async function suspendedReconsent(runtime: AgentRuntime, old: Candidate, label: string) {
  const memory = cloud(runtime); const root = memory.root; const before = launches;
  const oldEpoch = memory.config.authorization?.epoch;
  const ownConsent = await runtime.manageCloudMemory('auto');
  assert(`${label}: explicit reconsent promises a NEW SESSION, never current enablement`, ownConsent.includes('NEW SESSION') && ownConsent.includes('this origin session remains stopped') && !ownConsent.includes('auto enabled for NEW turns only') && memory.config.authorization?.epoch !== oldEpoch);
  assert(`${label}: suspension status survives explicit command clearing problem`, work(memory).autoSuspended && memory.problem === undefined && runtime.cloudMemoryStatus.includes('this origin session is stopped: start a new session') && (await stoppedSession(memory))?.session === memory.session);
  await drain(runtime, 'Stopped origin activity after explicit auto reconsent'); await settleWork(runtime);
  assert(`${label}: explicit auto command cannot restart this origin sender`, launches === before && work(memory).autoSuspended && await tokenReceipt(box(memory), old.token) === undefined);

  const ownEpoch = memory.config.authorization?.epoch;
  const peer = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'peer-reconsent-controller');
  controllers.add(peer);
  const peerConsent = await peer.command('auto', 'user');
  const status = await runtime.manageCloudMemory('status');
  assert(`${label}: actual peer reconsent refreshes epoch without erasing suspension`, peerConsent.includes('auto enabled for NEW turns only') && peer.config.authorization?.epoch !== ownEpoch && memory.config.authorization?.epoch === peer.config.authorization?.epoch && work(memory).autoSuspended && memory.problem === undefined);
  assert(`${label}: refreshed status independently states stopped origin and new-session remedy`, status.includes('this origin session is stopped: start a new session') && status.includes('old pending remains manual') && !status.includes('auto enabled for NEW turns only'));
  await peer.close(); controllers.delete(peer);
  await drain(runtime, 'Stopped origin activity after peer fresh epoch refresh'); await settleWork(runtime);
  assert(`${label}: fresh epoch and ordinary turns do not revive stopped origin`, launches === before && await tokenReceipt(box(memory), old.token) === undefined && (await stoppedSession(memory))?.session === memory.session);
  setRuntimeModelFactoryForTest(async () => new ReadModel(root));
  const successor = await runtime.startNewSession(); runtimes.add(successor); runtimes.delete(runtime);
  await drain(successor, 'Actually new successor future read after reconsent'); await settleWork(successor);
  const next = await candidate(successor);
  assert(`${label}: genuinely new successor can send its future turn under refreshed consent`, successor.info.sessionId !== runtime.info.sessionId && !work(cloud(successor)).autoSuspended && launches === before + 1 && (await tokenReceipt(box(memory), next.token))?.disposition === 'accepted' && JSON.parse(calls.at(-1)!.body).clientToken === next.token);
  await shutdown(successor);
}
async function staleRewind() {
  header('C: stale checkpoint refuses unchanged, but conservatively stops old auto');
  const root = await configured('stale-rewind'); const runtime = await create(root);
  const memory = cloud(runtime); const before = launches;
  const attempt = pauseState(memory, '.attempt-1.json');
  await drain(runtime); await bounded(attempt.reached, 'stale checkpoint attempt');
  const checkpoint = requireValue((await runtime.listRewindCheckpoints()).checkpoints[0], 'checkpoint');
  const old = await candidate(runtime); let error: unknown; let constructions = 0;
  setRuntimeModelFactoryForTest(async () => { constructions++; return new ReadModel(root); });
  try { await runtime.startRewind({ ...checkpoint, prompt: `${checkpoint.prompt} changed` }); } catch (caught) { error = caught; }
  assert('stale rewind preserves exact refusal without constructing successor', error instanceof Error && error.message === 'The selected rewind checkpoint is stale or unmapped.' && constructions === 0);
  assert('stale rewind still publishes durable session stop and visible notice', (await stoppedSession(memory))?.session === memory.session && runtime.cloudMemoryStatus.includes('Predecessor automatic uploads stopped'));
  attempt.release(); await settleWork(runtime); setCloudStateObserverForTest(undefined);
  await drain(runtime, 'Ordinary activity after stale rewind'); await settleWork(runtime);
  assert('stale rewind cannot revive old sender on subsequent activity', launches === before);
  await suspendedReconsent(runtime, old, 'stale rewind');
  await restartDrain(root, old, 'stale rewind');
}
async function lateAcknowledgements() {
  header('C: acknowledged AWS effect survives cancellation and session transitions');
  for (const kind of ['clear', 'rewind', 'cancel'] as const) {
    const root = await configured(`late-ack-${kind}`); const runtime = await create(root);
    const memory = cloud(runtime); const before = launches;
    const ack = pauseState(memory, '.accepted.json');
    await drain(runtime); await bounded(ack.reached, `${kind} late ACK publication`);
    const old = await candidate(runtime);
    assert(`${kind}: signed request completed but acknowledgement publication is paused`, launches === before + 1 && calls.length === launches && await readState(ack.file()) === undefined);
    let successor: AgentRuntime | undefined;
    if (kind === 'cancel') {
      runtime.cancel(); ack.release(); await settleWork(runtime);
    } else {
      const checkpoint = requireValue((await runtime.listRewindCheckpoints()).checkpoints[0], 'late ACK checkpoint');
      const factory = gate();
      setRuntimeModelFactoryForTest(async () => { factory.enter(); await factory.wait; return new ReadModel(root); });
      const pending = transition(runtime, kind, checkpoint);
      await bounded(factory.reached, 'late ACK successor factory');
      ack.release(); await settleWork(runtime);
      assert(`${kind}: received ACK persists while successor is still pending`, (await tokenReceipt(box(memory), old.token))?.disposition === 'accepted');
      factory.release(); successor = await bounded(pending, 'late ACK successor');
      runtimes.add(successor); runtimes.delete(runtime);
    }
    setCloudStateObserverForTest(undefined);
    const accepted = await readState(stateFile(memory, old.token, 'accepted')) as { eventId?: string; auto?: boolean } | undefined;
    assert(`${kind}: durable accepted.json and non-evicting receipt remain truthful`, accepted?.auto === true && accepted.eventId?.startsWith('synthetic-') === true && (await tokenReceipt(box(memory), old.token))?.disposition === 'accepted' && launches === before + 1);
    await shutdown(successor ?? runtime);
    await restartDrain(root, old, `late ACK ${kind}`);
  }
}

async function cancelledAckHandsOffFreshActivity() {
  header('Review: fresh completed activity survives a cancelled pass retaining its ACK');
  const root = await configured('cancelled-ack-fresh-activity'); const runtime = await create(root);
  const memory = cloud(runtime); const before = launches;
  const ack = pauseState(memory, '.accepted.json');
  await drain(runtime); await bounded(ack.reached, 'validated ACK before accepted.json');
  const old = await candidate(runtime); const oldWork = work(memory).autoWork;
  const oldSignal = work(memory).autoAbort.signal;
  assert('handoff fixture: signed response validated, accepted.json still absent', launches === before + 1 && calls.length === launches && await readState(ack.file()) === undefined);
  runtime.cancel();
  await drain(runtime, 'Second qualifying read, completed while old ACK publication waits');
  await bounded(recorder(runtime).chain, 'fresh turn durable close behind ACK');
  await bounded(work(memory).chain, 'fresh eligible projection behind ACK');
  const next = await candidate(runtime, 2);
  const proof = await readState(stateFile(memory, next.token, 'auto')) as { hash?: string; reason?: string };
  assert('fresh turn finishes naturally with a new live signal and exact eligible proof', oldSignal.aborted && !work(memory).autoAbort.signal.aborted && work(memory).autoAbort.signal !== oldSignal && proof.hash === digest(next.entry) && proof.reason === undefined);
  assert('fresh turn cannot send while cancelled pass owns late ACK', launches === before + 1 && work(memory).autoWork === oldWork && await readState(stateFile(memory, next.token, 'attempt-1')) === undefined);
  ack.release(); await settleWork(runtime); setCloudStateObserverForTest(undefined);
  const accepted = await readState(stateFile(memory, old.token, 'accepted')) as { eventId?: string; auto?: boolean };
  assert('cancelled pass persists original ACK and receipt without repeating HTTP', accepted.auto === true && accepted.eventId?.startsWith('synthetic-') === true && (await tokenReceipt(box(memory), old.token))?.disposition === 'accepted' && calls.slice(before).filter(call => JSON.parse(call.body).clientToken === old.token).length === 1);
  assert('earned fresh pass changes autoWork and sends second turn without third activity', work(memory).autoWork !== oldWork && launches === before + 2 && (await tokenReceipt(box(memory), next.token))?.disposition === 'accepted' && JSON.parse(calls.at(-1)!.body).clientToken === next.token);
  assert('handoff does not rewrite either immutable runtime body', await readFile(stateFile(memory, old.token, 'event'), 'utf8') === old.bytes && await readFile(stateFile(memory, next.token, 'event'), 'utf8') === next.bytes);
  await shutdown(runtime);
}

class HoldSecondTurnModel extends ReadModel {
  readonly second = gate();
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (this.calls === 2) { this.second.enter(); await this.second.wait; }
    yield* super.stream(messages, options);
  }
}
async function cancelledCloseCannotBorrowOpenTurn() {
  header('Review: cancelled delayed close cannot borrow an unfinished fresh turn signal');
  const root = await configured('cancelled-close-open-turn');
  // Both unrelated candidates come from real turns. Only the accepted timestamp is
  // aged as a retention fixture; no invented body, proof, settlement or receipt.
  const donor = await create(root); const donorMemory = cloud(donor);
  await drain(donor); await settleWork(donor); const expired = await candidate(donor);
  const pendingAttempt = pauseState(donorMemory, '.attempt-1.json');
  await drain(donor, 'Unrelated eligible pending read'); await bounded(pendingAttempt.reached, 'donor pending attempt');
  const pending = await candidate(donor, 2);
  donor.cancel(); pendingAttempt.release(); await settleWork(donor); setCloudStateObserverForTest(undefined);
  const pendingProof = await readState(stateFile(donorMemory, pending.token, 'auto')) as { reason?: string };
  assert('delayed-close fixture has unrelated eligible unsent runtime candidate', pendingProof.reason === undefined && await tokenReceipt(box(donorMemory), pending.token) === undefined && await readState(stateFile(donorMemory, pending.token, 'attempt-1')) === undefined);
  await shutdown(donor);
  const ackFile = stateFile(donorMemory, expired.token, 'accepted');
  const ack = await readState(ackFile) as { eventId: string; auto: true; at: string };
  await writeState(ackFile, { ...ack, at: new Date(Date.now() - AUTO_RETENTION_MS - 60000).toISOString() });

  const paused = closingWriteGate(); const model = new HoldSecondTurnModel(root);
  const runtime = await create(root, model); const memory = cloud(runtime);
  const observed = observeSettlement(runtime); const before = launches;
  await drain(runtime, 'Turn A: real read with delayed closing append');
  await bounded(paused.reached, 'A real closing write');
  const oldSignal = work(memory).autoAbort.signal;
  runtime.cancel();
  // Observe the actual begin call, forwarding it unchanged. B cannot reach its
  // model until A's real append releases the recorder input-durability barrier.
  const begun = gate(); const originalBegin = memory.begin.bind(memory);
  memory.begin = (turn, goal) => { originalBegin(turn, goal); if (turn === 2) begun.enter(); };
  let retentionProofReads = 0;
  setCloudStateObserverForTest(async (file, boundary) => {
    if (file === stateFile(memory, expired.token, 'auto') && boundary === 'after-read') retentionProofReads++;
  });
  const runningB = drain(runtime, 'Turn B: hold unfinished while cancelled A settles');
  await bounded(begun.reached, 'B real begin before A settlement'); memory.begin = originalBegin;
  assert('B begins fresh while A still has no durable settlement', oldSignal.aborted && work(memory).autoAbort.signal !== oldSignal && !work(memory).autoAbort.signal.aborted && observed.length === 0 && work(memory).closes.get(2)?.completed === undefined);
  paused.release(); await bounded(model.second.reached, 'B model remains unfinished');
  await settleWork(runtime);
  const old = await candidate(runtime);
  assert('A real settlement completes while B stays open', observed.length === 1 && observed[0]!.durable && observed[0]!.turn === 1 && work(memory).closes.get(2)?.completed === undefined);
  await heldProof(runtime, old, 'cancelled A cannot borrow B');
  assert('A settlement earns zero launches or retention proof reads before B finishes', launches === before && retentionProofReads === 0 && await readFile(stateFile(memory, expired.token, 'event'), 'utf8') === expired.bytes && await tokenReceipt(box(memory), pending.token) === undefined);
  model.second.release(); await bounded(runningB, 'B natural driver completion'); await settleWork(runtime);
  setCloudStateObserverForTest(undefined); setRuntimeRecorderOverridesForTest(undefined);
  const next = await candidate(runtime, 2);
  const nextProof = await readState(stateFile(memory, next.token, 'auto')) as { reason?: string };
  assert('B completion, not A settlement, earns the unrelated pending send', nextProof.reason === undefined && launches === before + 1 && (await tokenReceipt(box(memory), pending.token))?.disposition === 'accepted' && JSON.parse(calls.at(-1)!.body).clientToken === pending.token);
  assert('B completion earns real retention proofread and expiry; accepted receipt survives', retentionProofReads > 0 && await readState(stateFile(memory, expired.token, 'event')) === undefined && (await tokenReceipt(box(memory), expired.token))?.disposition === 'accepted');
  assert('A remains manual and byte-identical after B earns its pass', await readFile(stateFile(memory, old.token, 'event'), 'utf8') === old.bytes && await tokenReceipt(box(memory), old.token) === undefined && await readState(stateFile(memory, next.token, 'attempt-1')) === undefined);
  await shutdown(runtime);
}

async function peerLaunchHonoursDurableOriginStop(early = false) {
  header(`Review: peer ${early ? 'reservation' : 'final launch lock'} honors durable origin stop`);
  const root = await configured(`peer-launch-origin-stop-${early}`); const runtime = await create(root);
  const memory = cloud(runtime); const before = launches;
  const attempt = pauseState(memory, '.attempt-1.json');
  await drain(runtime); await bounded(attempt.reached, 'origin actual eligible candidate');
  const old = await candidate(runtime);
  runtime.cancel(); attempt.release(); await settleWork(runtime); setCloudStateObserverForTest(undefined);
  const proofBytes = await readFile(stateFile(memory, old.token, 'auto'), 'utf8');
  assert('peer fixture: origin real natural turn remains eligible, no reserved attempt', (JSON.parse(proofBytes) as { reason?: string }).reason === undefined && await readState(stateFile(memory, old.token, 'attempt-1')) === undefined && launches === before);
  const peer = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'peer-launch-controller');
  controllers.add(peer);
  const paused = gate(); let intercepted = false; let markerUnderLock = false;
  const order: string[] = [];
  const configLock = path.join(path.dirname(configPath(root)), 'config-write-lock', 'active.json');
  // withConfigLock delegates to the real state lock. Its before-publish boundary
  // is AFTER the sender's third authority check, BEFORE exclusive lock acquisition.
  // Hold only the peer's first publication; origin stop can win the same real lock.
  setCloudStateObserverForTest(async (file, boundary) => {
    if ((early ? file === stateFile(memory, old.token, 'attempt-1') && boundary === 'after-publish' : file === configLock && boundary === 'before-publish') && !intercepted) {
      intercepted = true; order.push('peer-before-lock'); paused.enter(); await paused.wait;
    } else if (file === configLock && boundary === 'after-publish') {
      order.push('config-lock-acquired');
    } else if (file === stateFile(memory, digest(memory.session), 'session-stop') && boundary === 'after-publish') {
      markerUnderLock = JSON.parse(await readFile(configLock, 'utf8')).pid === process.pid;
      order.push('origin-stop-durable');
    }
  });
  // Test-only entry into the actual finite peer sender; all provenance checks,
  // quota/attempt I/O, coordination and signed transport remain untouched.
  const peerDrain = (peer as unknown as { drainAuto(signal: AbortSignal): Promise<void> }).drainAuto(signal);
  await bounded(paused.reached, 'peer after precoordination, before launch-lock acquisition');
  assert('peer reached launch boundary with durable reservation but zero HTTP', launches === before && await readState(stateFile(memory, old.token, 'attempt-1')) !== undefined && await stoppedSession(memory) === undefined);
  setRuntimeModelFactoryForTest(async () => new ReadModel(root));
  const successor = await bounded(runtime.startNewSession(), 'origin successor durably stops before peer release');
  runtimes.add(successor); runtimes.delete(runtime);
  assert('origin stop wins and is durably published under the shared config lock', markerUnderLock && (await stoppedSession(memory))?.session === memory.session && order.join(',') === 'peer-before-lock,config-lock-acquired,origin-stop-durable');
  paused.release(); await bounded(peerDrain, 'peer final stop validation'); setCloudStateObserverForTest(undefined);
  const state = await readState(stateFile(peer, old.token, 'auto-state')) as { state?: string; reason?: string };
  assert('peer acquires launch lock only after durable stop and starts zero HTTP', order.join(',') === `peer-before-lock,config-lock-acquired,origin-stop-durable${early ? '' : ',config-lock-acquired'}` && launches === before && state.state === 'held' && /Origin session stopped/.test(state.reason ?? ''));
  assert('peer refusal retains manual original body/proof, without false ACK or receipt', await readFile(stateFile(peer, old.token, 'event'), 'utf8') === old.bytes && await readFile(stateFile(peer, old.token, 'auto'), 'utf8') === proofBytes && await readState(stateFile(peer, old.token, 'accepted')) === undefined && await tokenReceipt(box(peer), old.token) === undefined);
  await peer.close(); controllers.delete(peer);
  await drain(successor, 'Successor future turn after peer launch refusal'); await settleWork(successor);
  const next = await candidate(successor);
  assert('shared stop fences only old origin: successor future turn still sends', launches === before + 1 && (await tokenReceipt(box(memory), next.token))?.disposition === 'accepted' && JSON.parse(calls.at(-1)!.body).clientToken === next.token);
  await shutdown(successor);
}

class BackgroundModel extends ReadModel {
  delegate = false;
  private dispatched = false;
  readonly child = gate();
  override async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    if (!options?.toolSpecs?.some(spec => spec.name === 'subagent')) {
      this.child.enter();
      const cancel = options?.cancelSignal;
      let aborted!: () => void;
      const stopped = new Promise<void>(resolve => { aborted = resolve; });
      cancel?.addEventListener('abort', aborted, { once: true });
      try { if (!cancel?.aborted) await Promise.race([this.child.wait, stopped]); }
      finally { cancel?.removeEventListener('abort', aborted); }
      yield* text('real child report'); return;
    }
    if (this.delegate) {
      if (!this.dispatched) {
        this.dispatched = true;
        yield* toolUse('live-child', 'subagent', { task: 'Wait, then report; no writes', _background_execution: true });
      } else {
        this.delegate = false; yield* text('Child still working');
      }
      return;
    }
    yield* super.stream(messages, options);
  }
}
async function liveDelegationGuard() {
  header('C: real live background delegation refuses transition without stopping auto');
  const root = await configured('live-background-guard');
  const model = new BackgroundModel(root); const runtime = await create(root, model, undefined, true);
  const memory = cloud(runtime); const before = launches;
  const attempt = pauseState(memory, '.attempt-1.json');
  await drain(runtime, 'Read before live child');
  await bounded(attempt.reached, 'eligible attempt before child dispatch');
  const old = await candidate(runtime);
  const checkpoint = requireValue((await runtime.listRewindCheckpoints()).checkpoints[0], 'background checkpoint');
  model.delegate = true;
  await drain(runtime, 'Delegate a background read');
  await bounded(model.child.reached, 'real recipe child model');
  assert('guard fixture has actual running child and SDK background task', runtime.listSubagentDispatches().some(dispatch => dispatch.state === 'running') && runtime.listBackgroundDelegations().length === 1);
  const abort = work(memory).autoAbort;
  for (const kind of ['clear', 'rewind'] as const) {
    let error: unknown;
    try { await transition(runtime, kind, checkpoint); } catch (caught) { error = caught; }
    assert(`${kind}: live delegation refusal names user cancellation route`, error instanceof Error && error.message.includes('/agents cancel') && error.message.includes(`/${kind}`));
    assert(`${kind}: refused transition neither suspends nor aborts automatic work`, !work(memory).autoSuspended && work(memory).autoAbort === abort && !abort.signal.aborted && await stoppedSession(memory) === undefined);
  }
  attempt.release(); await settleWork(runtime); setCloudStateObserverForTest(undefined);
  assert('previous eligible upload really sends after refused transitions', launches === before + 1 && (await tokenReceipt(box(memory), old.token))?.disposition === 'accepted');
  const terminal = gate(); const unsubscribe = runtime.subscribeToBackgroundDelegations(() => terminal.enter());
  model.child.release(); await bounded(terminal.reached, 'real child background completion'); unsubscribe();
  await drain(runtime, 'Receive the actual completed child report'); await settleWork(runtime);
  assert('real completion is delivered by ordinary SDK/runtime next turn', runtime.listBackgroundDelegations().length === 0);
  await shutdown(runtime);
}

try {
  await abandonedFinals();
  await closingOrders();
  await exactFailure();
  await transitionRaces();
  await staleRewind();
  await lateAcknowledgements();
  await cancelledAckHandsOffFreshActivity();
  await cancelledCloseCannotBorrowOpenTurn();
  await peerLaunchHonoursDurableOriginStop();
  await peerLaunchHonoursDurableOriginStop(true);
  await liveDelegationGuard();
  assert('all actual SDK HTTP starts reached loopback and were SigV4 signed', launches > 0 && calls.length === launches && calls.every(call => call.authorization.startsWith('AWS4-HMAC-SHA256')));
  report();
} finally {
  // Always unblock owned seams before shutdown, even after a failed prerequisite.
  for (const release of releases) release();
  setCloudStateObserverForTest(undefined);
  setRuntimeRecorderOverridesForTest(undefined);
  await Promise.allSettled([...runtimes].map(runtime => bounded(runtime.shutdown(), 'cleanup runtime')));
  await Promise.allSettled([...controllers].map(memory => memory.close()));
  setRuntimeModelFactoryForTest(undefined);
  setMemoryTransportOptionsForTest(undefined);
  server.close(); server.closeAllConnections(); await once(server, 'close');
}
