/** Host blocker regressions: private HOME, native writers, real signed SDK loopback.
 * No darwin/CLI launch, external cloud, credentials, or user outbox/config access. */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Agent, Model, BeforeToolCallEvent, AfterToolCallEvent, ToolUseBlock, ToolResultBlock, TextBlock, type BaseModelConfig, type ModelStreamEvent } from '@strands-agents/sdk';
import { loadConfig, configPath } from '../src/config.js';
import { updateConfigFile } from '../src/config-file.js';
import { projectIdentity } from '../src/project-identity.js';
import { cloudBinding, effectiveCloudPolicy, parseProjectOverrides } from '../src/project-overrides.js';
import { parseAgentCoreConfig, digest } from '../src/agentcore/config.js';
import { CloudMemory } from '../src/agentcore/controller.js';
import { persistUploadMode } from '../src/agentcore/auto-policy.js';
import { quotaDirectory, tokenReceipt } from '../src/agentcore/auto-state.js';
import { cloudDirectory, writeState, readState, setCloudStateObserverForTest } from '../src/agentcore/state.js';
import { setMemoryTransportOptionsForTest } from '../src/agentcore/transport.js';
import { runDoctorCommand } from '../src/cli-doctor.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { loopbackHandler } from './agentcore-sdk-fixture.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('cloud-acceptance');
const root = path.join(home, 'project'); const other = path.join(home, 'other');
await mkdir(root); await mkdir(other);
const base = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'synthetic-user', episodicStrategyId: 'episodes-0123456789', preferenceStrategyId: 'preferences-0123456789', preferences: false, upload: 'manual' })!;
const file = configPath(root); const key = projectIdentity(root); const signal = new AbortController().signal;
const configure = (record: unknown) => writeFile(file, JSON.stringify(record));
const box = (memory: CloudMemory) => path.join(cloudDirectory(memory.config, memory.root), cloudBinding(memory.config, memory.root));
const rejects = async (run: () => unknown | Promise<unknown>) => { try { await run(); return false; } catch { return true; } };
function gate() {
  let release!: () => void; let enter!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { enter = resolve; });
  return { wait, reached, release, enter };
}
const calls: string[] = []; let responseGate: ReturnType<typeof gate> | undefined; let statuses: number[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString(); calls.push(body);
  const held = responseGate; responseGate = undefined; held?.enter(); await held?.wait;
  const status = statuses.shift() ?? 200; response.statusCode = status; response.setHeader('content-type', 'application/json');
  const input = JSON.parse(body);
  response.end(JSON.stringify(status === 200 ? { event: { memoryId: base.memoryId, actorId: input.actorId, sessionId: input.sessionId, eventId: 'synthetic' } } : { message: 'synthetic' }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const credentials = { accessKeyId: 'SYNTHETICKEY', secretAccessKey: 'synthetic-secret' };
const resetTransport = () => setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(port), credentials }));
resetTransport();
const agent = new Agent({ model: 'offline-fixture-never-invoked' });
type Work = { chain: Promise<void>; autoWork: Promise<void> };
const work = (memory: CloudMemory) => memory as unknown as Work;
const tokenFor = (memory: CloudMemory, turn: number) => digest([cloudBinding(memory.config, memory.root), memory.session, turn, turn + 10]);
function begin(memory: CloudMemory, turn: number) {
  memory.begin(turn, 'inspect real result');
  const use = new ToolUseBlock({ name: 'fixture', toolUseId: `call-${turn}`, input: { text: 'evidence 中文' } }); const invocationState = {};
  memory.uploadObserver?.before(new BeforeToolCallEvent({ agent, invocationState, tool: undefined, toolUse: use }));
  memory.uploadObserver?.after(new AfterToolCallEvent({ agent, invocationState, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: use.toolUseId, status: 'success', content: [new TextBlock('actual result')] }) }));
}
async function publish(memory: CloudMemory, turn: number) {
  memory.uploadObserver?.end();
  memory.settle({ durable: true, session: memory.session, turn, seq: turn + 10, at: new Date().toISOString(), stopReason: 'endTurn', failure: false, partial: false });
  await work(memory).chain;
}
async function capture(memory: CloudMemory, turn: number) { begin(memory, turn); await publish(memory, turn); await work(memory).autoWork; }
async function approved(session: string) {
  await configure({ agentCoreMemory: base });
  return new CloudMemory(await persistUploadMode(root, base, 'auto', signal), root, session);
}
header('Working-tree consent is not the shared cloud namespace');
const shared = { ...base, projectId: 'shared' };
await configure({ agentCoreMemory: shared });
const a = new CloudMemory(await persistUploadMode(root, shared, 'auto', signal), root, 'isolation-a');
const b = new CloudMemory((await loadConfig(other)).agentCoreMemory!, other, 'isolation-b');
assert('native auto A does not authorize unrelated B with the same explicit cloud ID', a.config.upload === 'auto' && b.config.upload === 'manual' && !b.config.authorization);
assert('legacy cloud binding unchanged and still shared', cloudBinding(shared, root) === digest([shared.region, shared.memoryId, shared.actorId, 'shared', shared.episodicStrategyId, shared.preferenceStrategyId]) && cloudBinding(shared, root) === cloudBinding(shared, other));
await capture(b, 1);
const bBody = await readFile(path.join(box(b), `${tokenFor(b, 1)}.event.json`), 'utf8');
assert('unauthorized B captures manual only and never launches', calls.length === 0 && await readState(path.join(box(b), `${tokenFor(b, 1)}.auto.json`)) === undefined);
const alias = path.join(home, 'alias'); await symlink(root, alias);
assert('symlink aliases share one canonical local consent', projectIdentity(alias) === key && (await loadConfig(alias)).agentCoreMemory?.authorization?.epoch === a.config.authorization?.epoch);
const git = (...args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
assert('owned worktree fixture initializes', git('init', '-q').status === 0 && git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture').status === 0);
const tree = path.join(home, 'worktree');
assert('owned git worktree created', git('worktree', 'add', '-q', '-b', 'fixture-worktree', tree).status === 0);
assert('different worktree does not inherit consent', projectIdentity(tree) !== key && (await loadConfig(tree)).agentCoreMemory?.upload === 'manual');
await b.command('auto', 'user'); const bEpoch = b.config.authorization?.epoch;
await a.command('manual', 'user');
assert('manual A revokes only A, not independently authorized B', (await loadConfig(root)).agentCoreMemory?.upload === 'manual' && (await loadConfig(other)).agentCoreMemory?.authorization?.epoch === bEpoch);
assert('mode changes preserve exact manual body/hash', await readFile(path.join(box(b), `${tokenFor(b, 1)}.event.json`), 'utf8') === bBody);
const v1 = { version: 1 as const, epoch: randomUUID(), at: new Date().toISOString(), scope: cloudBinding(shared, root) };
assert('legacy version 1 under canonical key held manual', effectiveCloudPolicy(shared, { [key]: { agentCoreMemory: { upload: 'auto', authorization: v1 } } }, root)?.upload === 'manual');
assert('old explicit-ID registry entry never grants consent', effectiveCloudPolicy(shared, { shared: { agentCoreMemory: { upload: 'auto', authorization: v1 } } }, root)?.upload === 'manual');
const copied = { ...a.config, upload: 'auto' as const, authorization: (await loadConfig(other)).agentCoreMemory!.authorization };
assert('copied v2 authorization fails project binding', effectiveCloudPolicy(shared, { [key]: { agentCoreMemory: { upload: 'auto', authorization: copied.authorization } } }, root)?.upload === 'manual');
assert('strict registry rejects extra authorization fields', await rejects(() => parseProjectOverrides({ [key]: { agentCoreMemory: { authorization: { ...v1, extra: true } } } })));
let doctor = ''; await runDoctorCommand({ projectRoot: other, out: text => { doctor += text; }, err: () => {} });
assert('doctor distinguishes local key from cloud namespace', doctor.includes(`local key ${projectIdentity(other)}`) && doctor.includes('cloud namespace shared') && doctor.includes('upload auto'));
assert('local cloud status distinguishes both identities', (await b.command('status')).includes(`local key ${projectIdentity(other)}`) && b.status().includes('cloud namespace shared'));
await a.close(); await b.close();

header('Existing manual/off controllers discover new consent without backfill');
for (const upload of ['manual', 'off'] as const) {
  await configure({ agentCoreMemory: { ...base, upload } });
  const old = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, `refresh-${upload}`);
  begin(old, 1);
  const peer = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, `peer-${upload}`);
  await peer.command('auto', 'user'); const before = calls.length;
  await old.refreshPolicy();
  assert(`${upload} discovers peer auto without prior override`, old.config.upload === 'auto' && old.uploadObserver !== undefined);
  await publish(old, 1); await work(old).autoWork;
  assert(`${upload} pre-enable turn is not retroactively authorized`, calls.length === before && await readState(path.join(box(old), `${tokenFor(old, 1)}.auto.json`)) === undefined);
  // Fresh session avoids the deliberately manual earlier-turn ordering barrier.
  const fresh = new CloudMemory(old.config, root, `fresh-${upload}`); await capture(fresh, 1);
  assert(`${upload} fresh turn sends automatically`, calls.length === before + 1);
  await peer.command('manual', 'user'); await old.refreshPolicy();
  assert(`${upload} peer revoke reflected in current status`, old.config.upload === 'manual' && (await old.command('status')).includes('upload manual'));
  await fresh.close(); await old.close(); await peer.close();
}
header('Native revocation is linearized before request-handler start');
for (const boundary of ['stop', 'quota', 'attempt', 'credentials', 'coordination'] as const) {
  for (const mutation of ['manual', 'epoch', 'scope', 'malformed'] as const) {
    const memory = await approved(`race-${boundary}-${mutation}`);
    const paused = gate(); let reads = 0;
    await writeState(path.join(box(memory), 'auto-stop.json'), { epoch: randomUUID(), reason: 'previous epoch failure' });
    const target = boundary === 'coordination' ? path.join(path.dirname(file), 'config-write-lock', 'active.json') : boundary === 'stop' ? path.join(box(memory), 'auto-stop.json') : boundary === 'quota' ? path.join(quotaDirectory(root), 'usage.json') : path.join(box(memory), `${tokenFor(memory, 1)}.attempt-1.json`);
    if (boundary === 'credentials') {
      setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(port), credentials: async () => { paused.enter(); await paused.wait; return credentials; } }));
    } else {
      let stopped = false;
      setCloudStateObserverForTest(async (name, phase) => {
        if (!stopped && name === target && phase === (boundary === 'coordination' ? 'before-publish' : boundary === 'stop' ? 'after-read' : 'after-publish') && (boundary !== 'stop' || ++reads === 3)) { stopped = true; paused.enter(); await paused.wait; }
      });
    }
    // Credentials are fixed at controller construction, so use a second instance.
    const sender = boundary === 'credentials' ? new CloudMemory(memory.config, root, memory.session) : memory;
    const before = calls.length; const running = capture(sender, 1); await paused.reached;
    if (mutation === 'manual' || mutation === 'epoch') await persistUploadMode(root, memory.config, mutation === 'manual' ? 'manual' : 'auto', signal);
    else await updateConfigFile(file, record => {
      if (mutation === 'scope') (record['agentCoreMemory'] as Record<string, unknown>)['actorId'] = 'changed-actor';
      else record['projectOverrides'] = { [key]: { badField: true } };
    });
    assert(`${boundary}/${mutation}: native policy publication completes before launch`, calls.length === before);
    paused.release(); await running; setCloudStateObserverForTest(undefined); resetTransport();
    assert(`${boundary}/${mutation}: no stale authority reaches SDK handler`, calls.length === before);
    await sender.close(); if (sender !== memory) await memory.close();
  }
}
// Verify the lock is actually held at the synchronous handler seam, not merely
// around a stale earlier check, and is released without awaiting its response.
let lockAtLaunch = false; let writerRefused = false;
const heldResponse = gate(); const started = gate();
setMemoryTransportOptionsForTest(() => {
  const handler = loopbackHandler(port);
  return { credentials, requestHandler: { ...handler, handle: (request: any, options: any) => {
    const source = `import { updateConfigFile } from ${JSON.stringify(new URL('../src/config-file.ts', import.meta.url).href)}; try { await updateConfigFile(${JSON.stringify(file)}, r => { r.name = 'must-not-publish'; }); } catch { process.exitCode = 2; }`;
    writerRefused = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env: { ...process.env }, stdio: 'ignore', timeout: 5000 }).status === 2;
    lockAtLaunch = writerRefused;
    const pending = heldResponse.wait.then(() => handler.handle(request, options)); started.enter(); return pending;
  } } };
});
const coordinated = await approved('coordinated'); const beforeCoordinated = calls.length;
const coordinatedWork = capture(coordinated, 1); await started.reached;
// Await just the lock disappearance, without sleeping or waiting for cloud I/O.
let lockReleased = false;
for (let i = 0; i < 200; i++) {
  if (await readState(path.join(path.dirname(file), 'config-write-lock', 'active.json')) === undefined) { lockReleased = true; break; }
}
assert('launch lock released before response', lockReleased);
await persistUploadMode(root, coordinated.config, 'manual', signal);
assert('final validation and handler invocation exclude native cross-process writer', lockAtLaunch && writerRefused);
assert('manual completes while already-started response is still pending', calls.length === beforeCoordinated && (await loadConfig(root)).agentCoreMemory?.upload === 'manual');
heldResponse.release(); await coordinatedWork;
assert('received acknowledgement retained after peer revocation', (await tokenReceipt(box(coordinated), tokenFor(coordinated, 1)))?.disposition === 'accepted');
setCloudStateObserverForTest(undefined); await coordinated.close(); resetTransport();
header('Publication activity is coalesced, finite and cancellable');
for (const same of [true, false]) {
  for (const mode of ['send', 'manual', 'cancel', 'rotate', 'budget', 'retry'] as const) {
    statuses = [];
    const first = await approved(`drain-${same}-${mode}`);
    const second = same ? first : new CloudMemory(first.config, root, `second-${mode}`);
    const held = gate(); responseGate = held; const before = calls.length;
    begin(first, 1); await publish(first, 1); await held.reached;
    begin(second, same ? 2 : 1); await publish(second, same ? 2 : 1);
    const secondToken = tokenFor(second, same ? 2 : 1);
    assert(`${same ? 'same' : 'other'} session/${mode}: second event published during held request`, await readState(path.join(box(second), `${secondToken}.auto.json`)) !== undefined && calls.length === before + 1);
    if (mode === 'manual') await persistUploadMode(root, first.config, 'manual', signal);
    if (mode === 'cancel') { first.cancel(); second.cancel(); }
    if (mode === 'rotate') await persistUploadMode(root, first.config, 'auto', signal);
    if (mode === 'budget') await updateConfigFile(file, record => { (record['projectOverrides'] as any)[key].agentCoreMemory.autoDailyEvents = 1; });
    if (mode === 'retry') statuses = [200, 503, 503, 503];
    held.release(); await work(first).autoWork; await work(second).autoWork;
    assert(`${same ? 'same' : 'other'} session/${mode}: finite followup request count`, calls.length === before + (mode === 'send' ? 2 : mode === 'retry' ? 4 : 1));
    if (mode === 'send') assert('followup acceptance durable without third activity', (await tokenReceipt(box(second), secondToken))?.disposition === 'accepted');
    if (mode === 'retry') assert('coalesced followup retains stable body across at most three attempts', new Set(calls.slice(before + 1)).size === 1);
    const settled = work(second).autoWork; await second.command('status');
    assert('status/held/budget do not create idle drain loop', work(second).autoWork === settled && calls.length <= before + 4);
    await first.close(); if (second !== first) await second.close();
  }
}
// Publication during final status inspection must not land in a promise-finalizer gap.
const inspecting = await approved('inspection-publication'); const inspectionGate = gate();
const firstInspect = tokenFor(inspecting, 1); let pausedInspection = false;
setCloudStateObserverForTest(async (name, phase) => {
  if (!pausedInspection && name === path.join(quotaDirectory(root), 'usage.json') && phase === 'after-read' && await tokenReceipt(box(inspecting), firstInspect)) {
    pausedInspection = true; inspectionGate.enter(); await inspectionGate.wait;
  }
});
const beforeInspection = calls.length; begin(inspecting, 1); await publish(inspecting, 1); await inspectionGate.reached;
begin(inspecting, 2); await publish(inspecting, 2); inspectionGate.release(); await work(inspecting).autoWork;
setCloudStateObserverForTest(undefined);
assert('publication during final inspection is drained before ownership release', calls.length === beforeInspection + 2);
await inspecting.close();
// Many old-epoch pending sessions must not consume the current pass's eight slots.
const current = await approved('fresh-after-epochs');
const beforeFresh = calls.length; await capture(current, 1);
assert('fresh epoch candidate not starved by prior epochs', calls.length === beforeFresh + 1);
await current.close();

header('Runtime new-turn, model, clear, rewind and status refresh');
class LocalModel extends Model<BaseModelConfig> {
  config: BaseModelConfig = { modelId: 'offline' }; calls = 0;
  updateConfig(value: BaseModelConfig) { this.config = { ...this.config, ...value }; }
  getConfig() { return this.config; }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (this.calls++ === 0) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: 'fileEditor', toolUseId: 'runtime-call' } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify({ command: 'view', path: path.join(root, 'evidence.txt') }) } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' }; yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: 'done' } };
      yield { type: 'modelContentBlockStopEvent' }; yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}
await writeFile(path.join(root, 'evidence.txt'), 'real runtime evidence');
setRuntimeModelFactoryForTest(async () => new LocalModel());
const runtimeConfig = { memory: false, contextOffload: false, models: [{ model: 'offline-a', promptCache: false, enable: true }, { model: 'offline-b', promptCache: false }] };
for (const upload of ['manual', 'off'] as const) {
  await configure({ ...runtimeConfig, agentCoreMemory: { ...base, upload } });
  const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: true }) });
  const cloud = (runtime as unknown as { cloudMemory: CloudMemory }).cloudMemory;
  await persistUploadMode(root, base, 'auto', signal);
  const before = calls.length;
  for await (const _event of runtime.send('read evidence')) {}
  await (runtime as unknown as { trajectory: { chain: Promise<void> } }).trajectory.chain;
  await work(cloud).chain; await work(cloud).autoWork;
  assert(`runtime ${upload} discovers peer auto on new turn and sends`, runtime.config.agentCoreMemory?.upload === 'auto' && calls.length === before + 1);
  const messages = (runtime as unknown as { agent: Agent }).agent.messages;
  await persistUploadMode(root, base, 'manual', signal);
  const changed = await runtime.changeModel(runtime.config.modelChoices[1]!); await changed.saved;
  assert('model switch refreshes peer revoke and preserves conversation', runtime.config.agentCoreMemory?.upload === 'manual' && (runtime as unknown as { agent: Agent }).agent.messages === messages);
  await persistUploadMode(root, base, 'auto', signal);
  await runtime.refreshCloudPolicy();
  assert('status boundary uses fresh policy and both identifiers', runtime.cloudMemoryStatus.includes('upload auto') && runtime.cloudMemoryStatus.includes(`local key ${key}`) && runtime.cloudMemoryStatus.includes(`cloud namespace ${key}`));
  const checkpoint = (await runtime.listRewindCheckpoints()).checkpoints[0]!;
  await persistUploadMode(root, base, 'manual', signal);
  const rewound = await runtime.startRewind(checkpoint);
  assert('rewind does not inherit stale auto authorization', rewound.config.agentCoreMemory?.upload === 'manual' && !rewound.config.agentCoreMemory.authorization);
  await persistUploadMode(root, base, 'auto', signal);
  const successor = await rewound.startNewSession();
  assert('clear discovers fresh peer auto rather than stale manual', successor.config.agentCoreMemory?.upload === 'auto');
  await writeFile(file, '{broken');
  for await (const _event of successor.send('ordinary turn despite malformed config')) {}
  assert('malformed refreshed config fails closed without breaking ordinary turn', successor.config.agentCoreMemory?.upload === 'manual' && successor.cloudMemoryStatus.includes('repair config'));
  await successor.shutdown();
}
await configure({ ...runtimeConfig, agentCoreMemory: false });
const disabled = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionBridge: async () => ({ allowed: true }) });
const beforeDisabled = calls.length;
await configure({ ...runtimeConfig, agentCoreMemory: base }); await persistUploadMode(root, base, 'auto', signal);
await disabled.refreshCloudPolicy();
assert('fully disabled runtime stays controller-free and never starts cloud work', disabled.config.agentCoreMemory === undefined && (disabled as unknown as { cloudMemory?: CloudMemory }).cloudMemory === undefined && calls.length === beforeDisabled);
await disabled.shutdown(); setRuntimeModelFactoryForTest(undefined);
setMemoryTransportOptionsForTest(undefined); server.close(); await once(server, 'close');
report();
