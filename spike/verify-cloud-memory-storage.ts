/** Cloud-memory storage/sender regressions D/E/F/G, offline and standalone.
 * Run: pnpm tsx spike/verify-cloud-memory-storage.ts
 * ownPrivateHome, real files, native policy writers and signed AWS SDK loopback only.
 * Capacity fixtures deliberately seed synthetic disk entries; activity is actual
 * AgentRuntime.send (scripted Model + real fileEditor + durable trajectory close).
 * Direct controller fixtures use public SDK events AND sealTurn(true) + settlement.
 * No darwin launch, external cloud/model, real config/outbox, clock replacement,
 * source mutation, dependency changes or private sender/settlement bypass.
 */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
process.env['AWS_EC2_METADATA_DISABLED'] = 'true';

import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import {
  Agent, Model, BeforeToolCallEvent, AfterToolCallEvent, ToolUseBlock, ToolResultBlock,
  TextBlock, type BaseModelConfig, type Message, type ModelStreamEvent,
} from '@strands-agents/sdk';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { trajectoryPath } from '../src/agent/session.js';
import type { TurnSettlement } from '../src/trajectory/writer.js';
import { configPath, loadConfig } from '../src/config.js';
import { updateConfigFile } from '../src/config-file.js';
import { projectIdentity } from '../src/project-identity.js';
import { cloudBinding, readCloudPolicy } from '../src/project-overrides.js';
import { CloudMemory, cloudReadArguments } from '../src/agentcore/controller.js';
import { runCloudMemoryCli } from '../src/agentcore/cli.js';
import { digest, parseAgentCoreConfig, type AgentCoreConfig } from '../src/agentcore/config.js';
import { persistUploadMode } from '../src/agentcore/auto-policy.js';
import {
  AUTO_RETENTION_MS, MAX_OUTBOX_BODIES, MAX_PENDING_BODIES, quotaDirectory,
  quotaUsage, receiptFile, tokenReceipt,
} from '../src/agentcore/auto-state.js';
import { cloudDirectory, readState, writeState, setCloudStateObserverForTest } from '../src/agentcore/state.js';
import { UploadTurn, uploadBody } from '../src/agentcore/upload-projection.js';
import { setMemoryTransportOptionsForTest } from '../src/agentcore/transport.js';
import { loopbackHandler } from './agentcore-sdk-fixture.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('cloud-storage');
const signal = new AbortController().signal;
const base = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'synthetic-user', episodicStrategyId: 'episodes-0123456789', preferenceStrategyId: 'preferences-0123456789', preferences: false, upload: 'manual' })!;
const evidence = 'REAL STORAGE FILE EDITOR EVIDENCE 中文\n';
const controllers = new Set<CloudMemory>();
const runtimes = new Set<AgentRuntime>();
const releases = new Set<() => void>();
function need<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing fixture evidence: ${label}`);
  return value;
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 300000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
function gate() {
  let release!: () => void; let enter!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { enter = resolve; });
  releases.add(release);
  return { wait, reached, release, enter };
}
const calls: { body: string; authorization: string }[] = [];
let statuses: number[] = [];
let launches = 0;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  calls.push({ body, authorization: String(request.headers.authorization) });
  const input = JSON.parse(body);
  const status = statuses.shift() ?? 200;
  response.statusCode = status; response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(status === 200
    ? { event: { memoryId: base.memoryId, actorId: base.actorId, sessionId: input.sessionId, eventId: `synthetic-${calls.length}` } }
    : { message: 'synthetic failure' }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = (server.address() as { port: number }).port;
setMemoryTransportOptionsForTest(() => {
  const handler = loopbackHandler(port);
  return { credentials: { accessKeyId: 'SYNTHETICKEY', secretAccessKey: 'synthetic-secret' },
    requestHandler: { ...handler, handle: (...args: Parameters<typeof handler.handle>) => {
      launches++; return handler.handle(...args);
    } },
  };
});
const box = (memory: CloudMemory) => path.join(cloudDirectory(memory.config, memory.root), cloudBinding(memory.config, memory.root));
const stateFile = (memory: CloudMemory, token: string, suffix: string) => path.join(box(memory), `${token}.${suffix}.json`);
type Work = { chain: Promise<void>; autoWork: Promise<void> };
const work = (memory: CloudMemory) => memory as unknown as Work;
async function settleWork(memory: CloudMemory) {
  await bounded(work(memory).chain, 'publication');
  await bounded(work(memory).autoWork, 'finite drain/retention');
}
function controller(config: AgentCoreConfig, root: string, session: string) {
  const memory = new CloudMemory(config, root, session); controllers.add(memory); return memory;
}
async function close(memory: CloudMemory) { await memory.close(); controllers.delete(memory); }
async function configured(label: string, budget?: number) {
  const root = path.join(home, label); await mkdir(root);
  await writeFile(path.join(root, 'evidence.txt'), evidence);
  await mkdir(path.dirname(configPath(root)), { recursive: true });
  // Each scenario has a different canonical project/quota identity. The global
  // file is private and rewritten only after all preceding controllers settle.
  await writeFile(configPath(root), JSON.stringify({ model: 'offline-storage', promptCache: false, memory: false, contextOffload: false, trajectory: true, agentCoreMemory: base }));
  await persistUploadMode(root, base, 'auto', signal);
  if (budget !== undefined) await setBudget(root, budget);
  return root;
}
async function policy(root: string) { return need(await readCloudPolicy(root), 'current policy'); }
async function setBudget(root: string, bytes: number) {
  await updateConfigFile(configPath(root), record => {
    const overrides = record['projectOverrides'] as Record<string, { agentCoreMemory: Record<string, unknown> }>;
    overrides[projectIdentity(root)]!.agentCoreMemory['autoDailyBytes'] = bytes;
  });
}
const tokenFor = (memory: CloudMemory, turn: number) => digest([cloudBinding(memory.config, memory.root), memory.session, turn, turn + 10]);
const settlement = (session: string, turn: number, at = new Date().toISOString()): Extract<TurnSettlement, { durable: true }> => ({ durable: true, session, turn, seq: turn + 10, at, stopReason: 'endTurn', failure: false, partial: false });
const eventAgent = new Agent({ model: 'offline-fixture-never-invoked', printer: false });
function action(target: Pick<UploadTurn, 'before' | 'after'>, turn: number) {
  const invocationState = {};
  const toolUse = new ToolUseBlock({ name: 'storage-fixture', toolUseId: `call-${turn}`, input: { evidence: 'input 中文' } });
  target.before(new BeforeToolCallEvent({ agent: eventAgent, invocationState, tool: undefined, toolUse }));
  target.after(new AfterToolCallEvent({ agent: eventAgent, invocationState, tool: undefined, toolUse, result: new ToolResultBlock({ toolUseId: toolUse.toolUseId, status: 'success', content: [new TextBlock('actual SDK event result 中文')] }) }));
}
async function capture(memory: CloudMemory, turn: number) {
  memory.begin(turn, `inspect storage evidence ${turn}`);
  action(need(memory.uploadObserver, 'upload observer'), turn);
  memory.uploadObserver!.end();
  memory.sealTurn(turn, true); // Driver completion is separate from durable close.
  memory.settle(settlement(memory.session, turn));
  await settleWork(memory);
  return tokenFor(memory, turn);
}
async function manualSend(memory: CloudMemory, token: string) {
  const preview = await memory.commandResult(`preview ${token}`, 'user');
  const hash = need(/send [a-f0-9]{64} ([a-f0-9]{64})/.exec(preview.text)?.[1], 'exact preview hash');
  const sent = await memory.commandResult(`send ${token} ${hash}`, 'user');
  assert('manual exact-preview send accepted', preview.ok && sent.ok && sent.text.startsWith('AWS event accepted.'));
}
class ReadModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline-storage' };
  calls = 0;
  constructor(readonly root: string) { super(); }
  override updateConfig(value: BaseModelConfig) { this.config = { ...this.config, ...value }; }
  override getConfig() { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const call = this.calls++;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (call % 2 === 0) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'fileEditor', toolUseId: `read-${call}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ command: 'view', path: path.join(this.root, 'evidence.txt') }) } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'ASSISTANT EXCLUDED' } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}
const cloud = (runtime: AgentRuntime) => (runtime as unknown as { cloudMemory: CloudMemory }).cloudMemory;
async function createRuntime(root: string) {
  setRuntimeModelFactoryForTest(async () => new ReadModel(root));
  const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: true }) });
  runtimes.add(runtime); return runtime;
}
async function activity(runtime: AgentRuntime) {
  await bounded((async () => { for await (const _event of runtime.send('Read the real storage evidence file')) {} })(), 'runtime send');
  await bounded((runtime as unknown as { trajectory: { chain: Promise<void> } }).trajectory.chain, 'durable recorder close');
  await settleWork(cloud(runtime));
}
async function shutdown(runtime: AgentRuntime) { await bounded(runtime.shutdown(), 'runtime shutdown'); runtimes.delete(runtime); }
async function runtimeEntries(runtime: AgentRuntime) {
  const memory = cloud(runtime); const entries: Entry[] = [];
  for (const name of (await readdir(box(memory))).filter(name => name.endsWith('.event.json'))) {
    const entry = JSON.parse(await readFile(path.join(box(memory), name), 'utf8')) as Entry;
    if (entry.body.sessionId === runtime.info.sessionId) entries.push(entry);
  }
  return entries;
}

type Body = NonNullable<ReturnType<typeof uploadBody>>;
type Entry = { version: number; binding: string; token: string; body: Body };
function syntheticEntry(memory: CloudMemory, session: string, turn: number, at = new Date().toISOString(), legacy = false): Entry {
  const binding = cloudBinding(memory.config, memory.root);
  const token = digest([binding, session, turn, turn + 10]);
  const projection = new UploadTurn(turn, 'synthetic stored goal'); action(projection, turn);
  const body = need(uploadBody({ memoryId: base.memoryId, actorId: base.actorId, sessionId: session, eventTimestamp: at, clientToken: token, extractionConfig: { namespaceVariables: { projectid: memory.scope.projectId } } }, projection, settlement(session, turn, at)), 'synthetic body');
  if (legacy) {
    const metadata = JSON.parse(body.payload[0]!.conversational.content.text);
    metadata.format = 'legacy'; body.payload[0]!.conversational.content.text = JSON.stringify(metadata);
  }
  return { version: 1, binding, token, body };
}
async function seed(memory: CloudMemory, entry: Entry, options: { proof?: boolean; accepted?: 'auto' | 'manual'; receipt?: 'accepted' | 'discarded'; held?: boolean } = {}) {
  await mkdir(box(memory), { recursive: true });
  // Synthetic capacity setup uses real closed files, not controller internals.
  await writeFile(stateFile(memory, entry.token, 'event'), JSON.stringify(entry));
  if (options.proof) await writeFile(stateFile(memory, entry.token, 'auto'), JSON.stringify({ version: 1, hash: digest(entry), authorization: memory.config.authorization, session: entry.body.sessionId, turn: JSON.parse(entry.body.payload[0]!.conversational.content.text).turn }));
  if (options.accepted) await writeFile(stateFile(memory, entry.token, 'accepted'), JSON.stringify({ eventId: 'synthetic-stored-acceptance', at: entry.body.eventTimestamp, ...(options.accepted === 'auto' ? { auto: true } : {}) }));
  if (options.held) await writeFile(stateFile(memory, entry.token, 'auto-state'), JSON.stringify({ state: 'held', reason: 'synthetic prior sender failure; manual review required' }));
  // Receipt publication is synced and atomic even in saturation fixtures.
  if (options.receipt) await writeState(receiptFile(box(memory), entry.token), { token: entry.token, disposition: options.receipt, at: entry.body.eventTimestamp }, true);
}
async function seedMany(memory: CloudMemory, entries: Entry[], options: Parameters<typeof seed>[2]) {
  for (let offset = 0; offset < entries.length; offset += 16) {
    await Promise.all(entries.slice(offset, offset + 16).map(entry => seed(memory, entry, options)));
  }
}
async function snapshot(directory: string): Promise<string> {
  const rows: [string, string][] = [];
  async function walk(current: string) {
    for (const name of (await readdir(current)).sort()) {
      const file = path.join(current, name); const stat = await lstat(file);
      if (stat.isSymbolicLink()) throw new Error('Unexpected symlink in private fixture');
      if (stat.isDirectory()) { rows.push([path.relative(directory, file) + '/', '']); await walk(file); }
      else rows.push([path.relative(directory, file), (await readFile(file)).toString('base64')]);
    }
  }
  await walk(directory); return JSON.stringify(rows);
}
const listedTokens = (text: string) => [...text.matchAll(/^([a-f0-9]{64}) /gm)].map(match => match[1]!);
const requestedTokens = (from: number) => calls.slice(from).map(call => JSON.parse(call.body).clientToken as string);
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

async function regressionD() {
  header('D — accepted auto proofs cannot consume slots or block their session');
  const root = await configured('d-accepted-slots', 1);
  const memory = controller(await policy(root), root, 'accepted-slots');
  const epoch = memory.config.authorization!.epoch;
  const before = calls.length; const accepted: string[] = []; const bodies: string[] = [];
  for (let turn = 1; turn <= 8; turn++) {
    // Accept each paused turn before publishing the next so all eight have an
    // actual budget-paused state (not just queued behind the first pause).
    const token = await capture(memory, turn); accepted.push(token);
    bodies.push(await readFile(stateFile(memory, token, 'event'), 'utf8'));
    const paused = await readState(stateFile(memory, token, 'auto-state')) as { state?: string; reason?: string } | undefined;
    assert(`D turn ${turn}: quota pause before reservation/request`, paused?.state === 'paused' && /budget exhausted/.test(paused.reason ?? '') && calls.length === before + turn - 1 && await readState(stateFile(memory, token, 'attempt-1')) === undefined);
    await manualSend(memory, token);
  }
  assert('D manual sends use no automatic quota', (await quotaUsage(root, new Date(), memory.config)).events === 0);
  await setBudget(root, base.autoDailyBytes); await memory.refreshPolicy();
  assert('D raising quota preserves exact authority epoch', memory.config.authorization!.epoch === epoch);
  const ninth = await capture(memory, 9);
  assert('D ninth auto-sends despite eight retained accepted proofs', same(requestedTokens(before + 8), [ninth]) && (await tokenReceipt(box(memory), ninth))?.disposition === 'accepted');
  const tenth = await capture(memory, 10);
  assert('D tenth remains unstarved on the next activity', same(requestedTokens(before + 8), [ninth, tenth]) && (await tokenReceipt(box(memory), tenth))?.disposition === 'accepted');
  assert('D first eight immutable bodies unchanged', (await Promise.all(accepted.map(token => readFile(stateFile(memory, token, 'event'), 'utf8')))).every((bytes, index) => bytes === bodies[index]));
  // Historical residual held state after a successful manual retry must not be
  // consulted before durable acceptance. Only this sidecar is synthetic here.
  await writeState(stateFile(memory, accepted[0]!, 'auto-state'), { state: 'held', reason: 'Prior failure retained after manual acceptance' });
  const eleventh = await capture(memory, 11);
  assert('D accepted held early turn does not block same-session later turn', same(requestedTokens(before + 8), [ninth, tenth, eleventh]) && (await tokenReceipt(box(memory), eleventh))?.disposition === 'accepted');
  await close(memory);
  const fresh = controller(await policy(root), root, 'accepted-slots');
  const from = calls.length; const twelfth = await capture(fresh, 12);
  assert('D fresh controller sends only the new token, no duplicate acceptance', same(requestedTokens(from), [twelfth]) && (await fresh.command('status')).includes('held 0'));
  assert('D auto quota counts only four actual new requests', (await quotaUsage(root, new Date(), fresh.config)).events === 4);
  await close(fresh);
}

async function acceptedDuringHeldRead() {
  header('D — manual acceptance during held-state read wins in the same earned pass');
  const root = await configured('d-accepted-during-held-read');
  const memory = controller(await policy(root), root, 'trigger');
  const manual = controller(await policy(root), root, 'manual-review');
  const first = syntheticEntry(memory, 'same-origin', 1);
  const later = syntheticEntry(memory, 'same-origin', 2);
  const unrelated = syntheticEntry(memory, 'unrelated-origin', 3);
  await seed(memory, first, { proof: true, held: true });
  await seed(memory, later, { proof: true }); await seed(memory, unrelated, { proof: true });
  const fillers = Array.from({ length: 5 }, (_, index) => syntheticEntry(memory, `filler-${index}`, index + 4));
  await seedMany(memory, fillers, { proof: true });
  const overflow = syntheticEntry(memory, 'overflow', 101); await seed(memory, overflow, { proof: true });
  const preserved = ['event', 'auto', 'auto-state'];
  const originals = await Promise.all(preserved.map(suffix => readFile(stateFile(memory, first.token, suffix), 'utf8')));
  const held = gate(); let paused = false;
  setCloudStateObserverForTest(async (file, boundary) => {
    if (!paused && file === stateFile(memory, first.token, 'auto-state') && boundary === 'after-read') {
      paused = true; held.enter(); await held.wait;
    }
  });
  const before = calls.length;
  const activity = capture(memory, 100); void activity.catch(() => {});
  try {
    await bounded(held.reached, 'held sidecar read before blocking verdict', 15000);
    await manualSend(manual, first.token);
    assert('D racing manual ACK is durable before held verdict resumes', await readState(stateFile(memory, first.token, 'accepted')) !== undefined && same(requestedTokens(before), [first.token]) && (await quotaUsage(root, new Date(), memory.config)).events === 0);
    const acknowledgement = await readFile(stateFile(memory, first.token, 'accepted'), 'utf8');
    held.release(); const trigger = await bounded(activity, 'same earned pass completion', 30000);
    const requests = requestedTokens(before);
    assert('D racing manual ACK unblocks later same-session candidate in this pass', requests.includes(later.token) && (await tokenReceipt(box(memory), later.token))?.disposition === 'accepted');
    assert('D racing manual ACK preserves unrelated-session progress', requests.includes(unrelated.token) && (await tokenReceipt(box(memory), unrelated.token))?.disposition === 'accepted');
    assert('D racing manual acceptance consumes no slot and no request duplicates', same(requests, [first.token, later.token, unrelated.token, ...fillers.map(entry => entry.token), trigger]) && new Set(requests).size === requests.length);
    assert('D only eight automatic slots, no self-rescheduled overflow pass', (await quotaUsage(root, new Date(), memory.config)).events === 8 && await readState(stateFile(memory, overflow.token, 'attempt-1')) === undefined && await readState(stateFile(memory, overflow.token, 'accepted')) === undefined);
    assert('D manual body/hash/held sidecar and ACK remain unchanged', (await Promise.all(preserved.map(suffix => readFile(stateFile(memory, first.token, suffix), 'utf8')))).every((bytes, index) => bytes === originals[index]) && await readFile(stateFile(memory, first.token, 'accepted'), 'utf8') === acknowledgement && await readState(stateFile(memory, first.token, 'attempt-2')) === undefined);
  } finally {
    held.release(); setCloudStateObserverForTest(undefined); await activity;
  }
  await close(manual); await close(memory);
}

async function regressionE() {
  header('E — full body store expires on actual runtime activity, without eviction');
  const root = await configured('e-body-cap');
  const runtime = await createRuntime(root); const memory = cloud(runtime);
  const oldAt = new Date(Date.now() - AUTO_RETENTION_MS - 86400000).toISOString();
  const expired = Array.from({ length: MAX_OUTBOX_BODIES }, (_, i) => syntheticEntry(memory, 'expired-auto', i + 1, oldAt));
  await seedMany(memory, expired, { proof: true, accepted: 'auto', receipt: 'accepted' });
  assert('E exactly 4096 expired accepted bodies seeded at declared cap', MAX_OUTBOX_BODIES === 4096 && (await readdir(box(memory))).filter(name => name.endsWith('.event.json')).length === 4096);
  const before = launches;
  await activity(runtime);
  assert('E full publication refused visibly but expired bodies reclaimed', memory.status().includes('Outbox full') && (await readdir(box(memory))).filter(name => name.endsWith('.event.json')).length === 0);
  assert('E omitted runtime turn is not reconstructed or uploaded', launches === before && (await runtimeEntries(runtime)).length === 0);
  const receiptBytes = await Promise.all(expired.map(entry => readFile(receiptFile(box(memory), entry.token), 'utf8')));
  assert('E all 4096 durable accepted receipts survive expiry', receiptBytes.every((bytes, index) => { const receipt = JSON.parse(bytes); return receipt.token === expired[index]!.token && receipt.disposition === 'accepted' && receipt.at === oldAt; }));
  const transcript = await readFile(trajectoryPath(root, runtime.info.sessionId), 'utf8');
  assert('E refused publication came from actual completed tool/trajectory lifecycle', transcript.includes('"type":"turnEnded"') && transcript.includes('fileEditor') && transcript.includes('REAL STORAGE FILE EDITOR EVIDENCE'));
  // Protection is verified during the next authorized retention pass. Neither old
  // manual acceptance nor unaccepted legacy data is eligible for automatic expiry.
  const manual = syntheticEntry(memory, 'protected-manual', 1, oldAt);
  const legacy = syntheticEntry(memory, 'protected-legacy', 1, oldAt, true);
  await seed(memory, manual, { accepted: 'manual' }); await seed(memory, legacy);
  const protectedBefore = await Promise.all([manual, legacy].map(entry => readFile(stateFile(memory, entry.token, 'event'), 'utf8')));
  await activity(runtime);
  const published = await runtimeEntries(runtime);
  assert('E next actual runtime turn publishes and sends once after expiry', launches === before + 1 && published.length === 1 && JSON.parse(published[0]!.body.payload[0]!.conversational.content.text).turn === 2 && (await tokenReceipt(box(memory), published[0]!.token))?.disposition === 'accepted');
  const wire = calls.at(-1)!.body;
  assert('E recovered source includes real fileEditor evidence, never assistant prose', wire.includes('fileEditor') && wire.includes('REAL STORAGE FILE EDITOR EVIDENCE') && !wire.includes('ASSISTANT EXCLUDED'));
  assert('E expired manual and legacy bodies remain byte-identical', (await Promise.all([manual, legacy].map(entry => readFile(stateFile(memory, entry.token, 'event'), 'utf8')))).every((bytes, i) => bytes === protectedBefore[i]));
  const pass = work(memory).autoWork; await memory.command('status');
  assert('E status does not manufacture another retention/drain pass', pass === work(memory).autoWork && launches === before + 1);
  await shutdown(runtime);

  header('E — 512 pending capacity refusal still earns a finite eight-request pass');
  const pendingRoot = await configured('e-pending-cap');
  const pendingRuntime = await createRuntime(pendingRoot); const pendingMemory = cloud(pendingRuntime);
  const pending = Array.from({ length: MAX_PENDING_BODIES }, (_, i) => syntheticEntry(pendingMemory, 'pending-cap', i + 1));
  await seedMany(pendingMemory, pending, { proof: true });
  const pendingBefore = launches; const callBefore = calls.length;
  assert('E pending-cap starts with available quota', (await quotaUsage(pendingRoot, new Date(), pendingMemory.config)).events === 0 && MAX_PENDING_BODIES === 512);
  await activity(pendingRuntime);
  assert('E capacity failure drains exactly eight existing candidates in session order', pendingMemory.status().includes('Outbox full') && launches === pendingBefore + 8 && same(requestedTokens(callBefore), pending.slice(0, 8).map(entry => entry.token)));
  assert('E failed append has no new body; all 512 old bodies retained', (await runtimeEntries(pendingRuntime)).length === 0 && (await readdir(box(pendingMemory))).filter(name => name.endsWith('.event.json')).length === 512);
  const firstPass = work(pendingMemory).autoWork; await pendingMemory.command('status');
  assert('E no self-rescheduling to drain remaining 504 pending', firstPass === work(pendingMemory).autoWork && launches === pendingBefore + 8);
  await activity(pendingRuntime);
  const next = await runtimeEntries(pendingRuntime);
  assert('E next activity appends normally and earns only eight more requests', launches === pendingBefore + 16 && next.length === 1 && (await tokenReceipt(box(pendingMemory), next[0]!.token))?.disposition === 'accepted');
  assert('E two bounded passes have no duplicates and exact wire quota', new Set(requestedTokens(callBefore)).size === 16 && (await quotaUsage(pendingRoot, new Date(), pendingMemory.config)).events === 16 && (await quotaUsage(pendingRoot, new Date(), pendingMemory.config)).bytes === calls.slice(callBefore).reduce((n, call) => n + Buffer.byteLength(call.body), 0));
  await shutdown(pendingRuntime);

  header('E — paused budget resumes on prior-UTC ledger reset, not a timer');
  const quotaRoot = await configured('e-budget-rollover');
  const quotaMemory = controller(await policy(quotaRoot), quotaRoot, 'rollover');
  const quotaFile = path.join(quotaDirectory(quotaRoot, quotaMemory.config), 'usage.json');
  const today = new Date().toISOString().slice(0, 10);
  await writeState(quotaFile, { day: today, events: base.autoDailyEvents, bytes: base.autoDailyBytes });
  const quotaBefore = calls.length; const pausedToken = await capture(quotaMemory, 1);
  assert('E exhausted current UTC ledger pauses without attempt', calls.length === quotaBefore && (await quotaMemory.command('pending')).includes('budget exhausted') && await readState(stateFile(quotaMemory, pausedToken, 'attempt-1')) === undefined);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await writeState(quotaFile, { day: yesterday, events: base.autoDailyEvents, bytes: base.autoDailyBytes });
  const nextToken = await capture(quotaMemory, 2);
  const usage = await quotaUsage(quotaRoot, new Date(), quotaMemory.config);
  assert('E later activity resets previous-UTC ledger and sends paused/new turns', same(requestedTokens(quotaBefore), [pausedToken, nextToken]) && usage.day === new Date().toISOString().slice(0, 10) && usage.events === 2 && usage.bytes === calls.slice(quotaBefore).reduce((n, call) => n + Buffer.byteLength(call.body), 0));
  await close(quotaMemory);

  header('E — cancellation/manual before capacity-failure kick bars all requests');
  for (const mode of ['cancel', 'manual'] as const) {
    const stoppedRoot = await configured(`e-before-kick-${mode}`);
    const stoppedRuntime = await createRuntime(stoppedRoot); const stopped = cloud(stoppedRuntime);
    const entries = Array.from({ length: MAX_PENDING_BODIES }, (_, i) => syntheticEntry(stopped, 'unsent-cap', i + 1));
    await seedMany(stopped, entries, { proof: true });
    const held = gate(); let paused = false;
    setCloudStateObserverForTest(async (file, boundary) => {
      if (!paused && file === path.join(box(stopped), 'publication', 'active.json') && boundary === 'before-publish') {
        paused = true; held.enter(); await held.wait;
      }
    });
    const initialLaunches = launches; const initialWork = work(stopped).autoWork;
    const running = activity(stoppedRuntime);
    await bounded(held.reached, 'publication before capacity check', 15000);
    if (mode === 'cancel') stoppedRuntime.cancel();
    else assert('E explicit user manual persists before kick', (await stopped.commandResult('manual', 'user')).ok && (await policy(stoppedRoot)).upload === 'manual');
    held.release(); await running; setCloudStateObserverForTest(undefined);
    assert(`E ${mode}: failed append remains visible with zero network/quota`, stopped.status().includes('Outbox full') && launches === initialLaunches && (await quotaUsage(stoppedRoot, new Date(), stopped.config)).events === 0);
    assert(`E ${mode}: no detached pass or silent pending eviction`, initialWork === work(stopped).autoWork && (await readdir(box(stopped))).filter(name => name.endsWith('.event.json')).length === 512 && (await runtimeEntries(stoppedRuntime)).length === 0);
    await shutdown(stoppedRuntime);
  }
}

async function captureCli(root: string, args: string[]) {
  const out = process.stdout.write; const err = process.stderr.write; const exit = process.exitCode;
  let stdout = ''; let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(); return true; }) as typeof process.stderr.write;
  process.exitCode = 0;
  try { await runCloudMemoryCli(root, args); return { stdout, stderr, code: process.exitCode }; }
  finally { process.stdout.write = out; process.stderr.write = err; process.exitCode = exit; }
}
async function regressionF() {
  header('F — actionable pagination, separate acceptance, read-only CLI projection');
  const root = await configured('f-pages');
  const memory = controller(await policy(root), root, 'listing');
  const entries = Array.from({ length: 65 }, (_, i) => syntheticEntry(memory, 'listing-seed', i + 1)).sort((a, b) => a.token.localeCompare(b.token));
  const accepted = entries.slice(0, 64); const pending = entries[64]!;
  await seedMany(memory, accepted, { accepted: 'manual', receipt: 'accepted' }); await seed(memory, pending);
  const beforeSingle = await snapshot(box(memory)); const beforeLaunches = launches;
  const single = await memory.commandResult('pending', 'read');
  assert('F 64 earlier accepted bodies cannot hide the sole pending token', single.ok && same(listedTokens(single.text), [pending.token]) && single.text.includes('1 actionable (pending/held/cleanup), 64 accepted'));
  assert('F initial pending projection is zero-write/network', await snapshot(box(memory)) === beforeSingle && launches === beforeLaunches);
  // 132 actionable rows require three pages. Include a persisted held candidate,
  // a stopped origin, and a tombstoned body left by interrupted cleanup.
  const more = Array.from({ length: 131 }, (_, i) => syntheticEntry(memory, `page-${i}`, 1));
  await seedMany(memory, more, {});
  const held = more[0]!; const cleanup = more[1]!; const stopped = more[2]!;
  await seed(memory, held, { proof: true, held: true });
  await seed(memory, cleanup, { proof: true, receipt: 'discarded' });
  await seed(memory, stopped, { proof: true });
  await writeState(path.join(box(memory), `${digest(stopped.body.sessionId)}.session-stop.json`), { session: stopped.body.sessionId });
  // Accepted receipts without the old .accepted sidecar must still be separate.
  const receiptOnly = syntheticEntry(memory, 'receipt-only', 1);
  await seed(memory, receiptOnly, { receipt: 'accepted' }); accepted.push(receiptOnly);
  const expected = [pending, ...more].map(entry => entry.token).sort();
  const expectedAccepted = accepted.map(entry => entry.token).sort();
  // Snapshot the entire owned home, not just event bodies: config, proofs,
  // receipts, quota ledgers and runtime sessions must all remain byte-identical.
  const before = await snapshot(home); const callsBefore = calls.length;
  async function pages(acceptedView: boolean, cli = false) {
    const result: string[] = []; const texts: string[] = [];
    let input = `pending${acceptedView ? ' accepted' : ''}`;
    for (let page = 0; page < 10; page++) {
      let text: string;
      if (cli) {
        const output = await captureCli(root, input.split(' ')); text = output.stdout.trimEnd();
        assert(`F CLI ${input}: success without stderr`, output.code === 0 && output.stderr === '');
      } else {
        const output = await memory.commandResult(input, 'read'); text = output.text;
        assert(`F reader ${input}: successful page`, output.ok);
      }
      const tokens = listedTokens(text); result.push(...tokens); texts.push(text);
      assert('F every page has at most 64 sorted token rows and both counts', tokens.length <= 64 && same(tokens, [...tokens].sort()) && text.includes('132 actionable (pending/held/cleanup), 65 accepted'));
      const next = /^Next: darwin cloud-memory (pending(?: accepted)? after [a-f0-9]{64})$/m.exec(text)?.[1];
      if (!next) return { tokens: result, texts };
      assert('F cursor names the last row, never an offset or hidden token', next.endsWith(tokens.at(-1)!));
      input = next;
    }
    throw new Error('Pagination failed to terminate within fixture bound');
  }
  const actionable = await pages(false); const acceptedPages = await pages(true);
  assert('F all >64 actionable rows traversed exactly once', actionable.texts.length === 3 && same(actionable.tokens, expected) && new Set(actionable.tokens).size === expected.length);
  assert('F accepted-only cursor traverses receipts and acks separately', acceptedPages.texts.length === 2 && same(acceptedPages.tokens, expectedAccepted) && !acceptedPages.tokens.some(token => expected.includes(token)));
  const all = actionable.texts.join('\n');
  assert('F held state, stopped origin and interrupted cleanup stay discoverable', all.includes(`${held.token} {"state":"held"`) && all.includes(`${stopped.token} origin session stopped; held manual`) && all.includes(`${cleanup.token} `) && all.includes('discarded; cleanup interrupted, repeat user cleanup'));
  const cliPages = await pages(false, true); const cliAccepted = await pages(true, true);
  assert('F actual exported CLI preserves exact reader pages in both views', same(cliPages.texts, actionable.texts) && same(cliAccepted.texts, acceptedPages.texts));
  for (const args of [[], ['status'], ['preview', pending.token]]) {
    const result = await captureCli(root, args);
    assert(`F CLI legacy ${args[0] ?? '(default)'} read remains valid`, result.code === 0 && result.stderr === '' && (args[0] !== 'preview' || result.stdout.includes('Read-only preview: no authorization written')));
  }
  const afterLast = await memory.commandResult(`pending after ${expected.at(-1)}`, 'read');
  assert('F cursor beyond last actionable returns bounded empty page', afterLast.ok && listedTokens(afterLast.text).length === 0 && !afterLast.text.includes('Next:'));
  for (const input of ['', 'status', 'preferences', `inspect ${'x'.repeat(40)}`, `preview ${pending.token}`, 'pending', 'pending accepted', `pending after ${pending.token}`, `pending accepted after ${pending.token}`]) {
    assert(`F legacy/new grammar accepts ${input || '(default)'}`, cloudReadArguments(input));
  }
  const invalid = ['pending 2', 'pending after', 'pending accepted extra', `pending after ${'A'.repeat(64)}`, `pending after ${'a'.repeat(63)}`, `pending after ${pending.token} accepted`, `pending accepted after ${pending.token} extra`, 'status extra', 'auto', 'manual', 'clear-accepted', `discard ${pending.token}`, `send ${pending.token} ${'0'.repeat(64)}`];
  for (const input of invalid) {
    const result = await memory.commandResult(input, 'read'); const cli = await captureCli(root, input.split(' '));
    assert(`F invalid/read-mutation refused: ${input.split(' ').slice(0, 2).join(' ')}`, !cloudReadArguments(input) && !result.ok && cli.code === 1 && cli.stdout === '' && cli.stderr.includes('Headless mutations unavailable'));
  }
  assert('F all read/CLI paths and refusals are byte-zero mutation and zero network', await snapshot(home) === before && calls.length === callsBefore && launches === beforeLaunches);
  assert('F read preview never grants later user-send authority', await readState(stateFile(memory, pending.token, 'preview')) === undefined);
  await close(memory);
}

async function regressionG() {
  header('G — peer re-consent clears only stale epoch stop; old held barrier stays manual');
  const root = await configured('g-stop-refresh');
  const memory = controller(await policy(root), root, 'stopped-origin');
  const oldEpoch = memory.config.authorization!.epoch; const before = calls.length;
  statuses = [403]; const first = await capture(memory, 1);
  const stopFile = path.join(box(memory), 'auto-stop.json');
  const oldStop = await readFile(stopFile, 'utf8');
  assert('G real signed HTTP403 persists an epoch-bound stop and held first token', calls.length === before + 1 && JSON.parse(oldStop).epoch === oldEpoch && memory.status().includes('HTTP 403') && (await memory.command('pending')).includes('"state":"held"'));
  const peer = controller((await loadConfig(root)).agentCoreMemory!, root, 'peer-user');
  const enabled = await peer.commandResult('auto', 'user');
  const newEpoch = peer.config.authorization!.epoch;
  await memory.refreshPolicy();
  assert('G original discovers peer fresh auto epoch, not a local reset', enabled.ok && newEpoch !== oldEpoch && memory.config.authorization!.epoch === newEpoch && memory.config.upload === 'auto' && calls.length === before + 1);
  const second = await capture(memory, 2);
  assert('G new epoch does not bypass earlier held same-session barrier', calls.length === before + 1 && (await memory.command('pending')).includes(`Send earlier pending token first: ${first}`) && await readState(stateFile(memory, second, 'attempt-1')) === undefined);
  const discarded = await memory.commandResult(`discard ${first}`, 'user');
  assert('G only explicit user discard resolves first held barrier', discarded.ok && (await tokenReceipt(box(memory), first))?.disposition === 'discarded' && await readState(stateFile(memory, first, 'event')) === undefined && calls.length === before + 1);
  const third = await capture(memory, 3);
  assert('G later new turn drains second/third under fresh epoch', same(requestedTokens(before + 1), [second, third]) && (await tokenReceipt(box(memory), third))?.disposition === 'accepted');
  assert('G old stop bytes remain intact, no proof migration/rewrite', await readFile(stopFile, 'utf8') === oldStop);
  await close(peer); await close(memory);
  const restarted = controller(await policy(root), root, 'stopped-origin');
  const fourth = await capture(restarted, 4);
  assert('G restart in same new epoch sends without stale stop or duplicates', restarted.config.authorization!.epoch === newEpoch && same(requestedTokens(before + 1), [second, third, fourth]) && (await tokenReceipt(box(restarted), fourth))?.disposition === 'accepted' && !(await restarted.command('status')).includes('Auto stopped:'));
  await close(restarted);
}

try {
  await regressionD();
  await acceptedDuringHeldRead();
  await regressionE();
  await regressionF();
  await regressionG();
  assert('all launched memory requests reached signed synthetic loopback', launches === calls.length && calls.length > 0 && calls.every(call => call.authorization.startsWith('AWS4-HMAC-SHA256 Credential=SYNTHETICKEY/')));
} finally {
  setCloudStateObserverForTest(undefined);
  for (const release of releases) release();
  for (const runtime of runtimes) await runtime.shutdown();
  for (const memory of controllers) await memory.close();
  setRuntimeModelFactoryForTest(undefined); setMemoryTransportOptionsForTest(undefined);
  const closed = once(server, 'close'); server.close(); await closed;
}
report();
