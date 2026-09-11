/** Project auto policy: isolated HOME, real SDK/runtime/files and signed loopback only.
 * No real config, cloud resources or user outboxes are read or changed. */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
import { mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Agent, Model, BeforeToolCallEvent, AfterToolCallEvent, ToolResultEvent, ToolUseBlock, ToolResultBlock, TextBlock, type BaseModelConfig, type ModelStreamEvent } from '@strands-agents/sdk';
import { loadConfig, configPath, saveEnabledModel, saveThinkingEffort, withModelChoice } from '../src/config.js';
import { updateConfigFile } from '../src/config-file.js';
import { projectIdentity } from '../src/project-identity.js';
import { parseProjectOverrides, cloudBinding, effectiveCloudPolicy } from '../src/project-overrides.js';
import { parseAgentCoreConfig, digest } from '../src/agentcore/config.js';
import { CloudMemory } from '../src/agentcore/controller.js';
import { autoHoldReason, persistUploadMode } from '../src/agentcore/auto-policy.js';
import { quotaUsage, reserveQuota, quotaDirectory, tokenReceipt, receiptFile, saveReceipt, receiptCapacity, AUTO_RETENTION_MS } from '../src/agentcore/auto-state.js';
import { cloudDirectory, readState, writeState, stateNames, setCloudStateObserverForTest, withStateLock } from '../src/agentcore/state.js';
import { UploadTurn, uploadBody } from '../src/agentcore/upload-projection.js';
import { setMemoryTransportOptionsForTest } from '../src/agentcore/transport.js';
import { runDoctorCommand } from '../src/cli-doctor.js';
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { loopbackHandler } from './agentcore-sdk-fixture.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('cloud-auto');
const root = path.join(home, 'project'); const other = path.join(home, 'other');
await mkdir(root); await mkdir(other);
const base = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'synthetic-user', episodicStrategyId: 'episodes-0123456789', preferenceStrategyId: 'preferences-0123456789', preferences: false, upload: 'manual' })!;
const file = configPath(root); const key = projectIdentity(root);
const signal = new AbortController().signal;
const configure = async (record: unknown) => writeFile(file, JSON.stringify(record));
const box = (config = base) => path.join(cloudDirectory(config, root), cloudBinding(config, root));
const rejects = async (run: () => unknown | Promise<unknown>) => { try { await run(); return false; } catch { return true; } };
const calls: { body: string; authorization: string }[] = []; let statuses: number[] = [];
let onRequest: (() => void) | undefined;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8'); calls.push({ body, authorization: String(request.headers.authorization) }); onRequest?.();
  const status = statuses.shift() ?? 200; response.setHeader('content-type', 'application/json'); response.statusCode = status;
  if (status !== 200) { response.end(JSON.stringify({ message: 'synthetic failure' })); return; }
  const input = JSON.parse(body); response.end(JSON.stringify({ event: { memoryId: base.memoryId, actorId: base.actorId, sessionId: input.sessionId, eventId: 'synthetic-event' } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = (server.address() as { port: number }).port;
setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(port), credentials: { accessKeyId: 'SYNTHETICKEY', secretAccessKey: 'synthetic-secret' } }));
const agent = new Agent({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
function add(turn: UploadTurn, status: 'success' | 'error' = 'success') {
  const state = {}; const use = new ToolUseBlock({ name: 'arbitrary-tool', toolUseId: 'call', input: { text: '中文 evidence' } });
  turn.before(new BeforeToolCallEvent({ agent, invocationState: state, tool: undefined, toolUse: use }));
  turn.after(new AfterToolCallEvent({ agent, invocationState: state, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: 'call', status, content: [new TextBlock('actual result 中文')] }) }));
}
const closeTurn = (session: string, turn: number) => ({ durable: true as const, session, turn, seq: turn + 10, at: new Date().toISOString(), stopReason: 'endTurn', failure: false, partial: false });
async function capture(memory: CloudMemory, turn: number, options: { failed?: boolean; partial?: boolean; goal?: string; noAction?: boolean } = {}) {
  memory.begin(turn, options.goal ?? 'inspect actual result');
  const observer = memory.uploadObserver!;
  const use = new ToolUseBlock({ name: 'arbitrary-tool', toolUseId: `call-${turn}`, input: { text: '中文 evidence' } }); const state = {};
  if (!options.noAction) {
    observer.before(new BeforeToolCallEvent({ agent, invocationState: state, tool: undefined, toolUse: use }));
    observer.after(new AfterToolCallEvent({ agent, invocationState: state, tool: undefined, toolUse: use, result: new ToolResultBlock({ toolUseId: `call-${turn}`, status: options.failed ? 'error' : 'success', content: [new TextBlock('actual result 中文')] }) }));
  }
  observer.end(); memory.sealTurn(turn, true); memory.settle({ ...closeTurn(memory.session, turn), partial: options.partial ?? false });
  await (memory as unknown as { chain: Promise<void> }).chain;
  await (memory as unknown as { autoWork: Promise<void> }).autoWork;
  return digest([cloudBinding(memory.config, root), memory.session, turn, turn + 10]);
}

header('Strict project registry and persistent local authority');
await configure({ agentCoreMemory: { ...base, upload: 'auto' } });
assert('root auto alone fails closed with re-confirm guidance', (await loadConfig(root)).agentCoreMemory?.upload === 'manual' && !!(await loadConfig(root)).agentCoreMemory?.autoProblem);
for (const value of [[], { [key]: { projectOverrides: {} } }, { [key]: { provider: 'openai' } }, { [key]: { agentCoreMemory: { actorId: 'bad' } } }, { [key]: { agentCoreMemory: { autoDailyEvents: 0 } } }, { [key]: { agentCoreMemory: { autoDailyBytes: 1.5 } } }, JSON.parse('{"__proto__":{}}'), JSON.parse(`{"${key}":{"agentCoreMemory":{"constructor":{}}}}`)]) {
  assert('invalid override rejected', await rejects(() => parseProjectOverrides(value)));
}
for (const models of [false, true]) {
  await configure({ ...(models ? { models: [{ provider: 'bedrock', model: 'synthetic-a', enable: true }, { provider: 'bedrock', model: 'synthetic-b' }] } : { provider: 'bedrock', model: 'synthetic-a' }), agentCoreMemory: base,
    projectOverrides: { [key]: { agentCoreMemory: { autoDailyEvents: 777, autoDailyBytes: 200000000 } }, [projectIdentity(other)]: { agentCoreMemory: { upload: 'off' } } } });
  const memory = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'management');
  assert('auto explicit command persists warning/budgets', (await memory.command('auto', 'user')).includes('777 attempts / 200000000 bytes'));
  const config = await loadConfig(root);
  assert('current project auto and other project isolation', config.agentCoreMemory?.upload === 'auto' && (await loadConfig(other)).agentCoreMemory?.upload === 'off');
  assert('withModelChoice preserves policy', withModelChoice(config, config.modelChoices.at(-1)!).agentCoreMemory === config.agentCoreMemory);
  if (models) await saveEnabledModel(root, 1);
  await saveThinkingEffort(root, 'high');
  assert('model writers preserve overrides and authorization', (await loadConfig(root)).agentCoreMemory?.authorization?.epoch === config.agentCoreMemory?.authorization?.epoch);
  const before = await readFile(file, 'utf8');
  assert('headless and invalid mutation args refuse without changes', !(await memory.commandResult('manual', 'read')).ok && !(await memory.commandResult('auto extra', 'user')).ok && await readFile(file, 'utf8') === before);
  await memory.command('manual', 'user');
  assert('manual immediate and persisted, no model/network', memory.config.upload === 'manual' && (await loadConfig(root)).agentCoreMemory?.upload === 'manual' && calls.length === 0);
  await memory.close();
}
const explicit = { ...base, projectId: 'shared-project' };
assert('explicit global identity reused; scope changes invalidate binding', projectIdentity(root, explicit.projectId) === 'shared-project' && effectiveCloudPolicy(explicit, { 'shared-project': { agentCoreMemory: { upload: 'auto', authorization: { version: 1, epoch: randomUUID(), at: new Date().toISOString(), scope: cloudBinding(base, root) } } } }, root)?.upload === 'manual');
await configure({ agentCoreMemory: base, unknownFutureField: { keep: true } });
await updateConfigFile(file, record => { record['name'] = 'preserved'; });
assert('writer preserves unknown unrelated JSON', JSON.parse(await readFile(file, 'utf8')).unknownFutureField.keep);
const cancelled = new AbortController(); cancelled.abort(); const beforeCancel = await readFile(file, 'utf8');
assert('cancelled config write is zero-write', await rejects(() => persistUploadMode(root, base, 'auto', cancelled.signal)) && await readFile(file, 'utf8') === beforeCancel);
const linked = path.join(home, 'linked.json'); await symlink(file, linked);
assert('symlink config target refused', await rejects(() => updateConfigFile(linked, record => { record['name'] = 'bad'; })));
await withStateLock(path.join(path.dirname(file), 'config-write-lock'), async () => {
  assert('overlapping writer refuses rather than clobbers', await rejects(() => persistUploadMode(root, base, 'auto', signal)));
});
assert('private config mode', ((await stat(file)).mode & 0o777) === 0o600);
assert('noncooperating concurrent edit detected without clobber', await rejects(() => updateConfigFile(file, record => { record['name'] = 'stale'; writeFileSync(file, '{"external":true}'); })) && await readFile(file, 'utf8') === '{"external":true}');
await configure({ agentCoreMemory: base });
let doctorOutput = ''; const beforeDoctor = await readFile(file, 'utf8');
await runDoctorCommand({ projectRoot: root, out: text => { doctorOutput += text; }, err: () => {} });
assert('doctor projects effective policy with zero writes/network', doctorOutput.includes('cloud memory upload manual') && await readFile(file, 'utf8') === beforeDoctor && calls.length === 0);
for (const verb of ['auto', 'manual', 'discard-legacy']) {
  const cli = spawn(process.execPath, ['--import', 'tsx', new URL('../src/cli.ts', import.meta.url).pathname, 'cloud-memory', verb], { cwd: root, env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' }, stdio: 'ignore' });
  const [code] = await once(cli, 'exit');
  assert('standalone CLI refuses mutation before config/network', code === 1 && await readFile(file, 'utf8') === beforeDoctor && calls.length === 0);
}
await configure({ agentCoreMemory: base, trajectory: false, projectOverrides: { [key]: { agentCoreMemory: { upload: 'off' } } } });
assert('project off beats global manual with trajectory disabled', (await loadConfig(root)).agentCoreMemory?.upload === 'off');
await configure({ agentCoreMemory: base });

header('Eligibility is closure/traceability, not task success');
const good = new UploadTurn(1, 'goal'); add(good, 'error');
assert('normal closed failed task allowed', autoHoldReason(good, closeTurn('eligibility', 1)) === undefined);
for (const flags of [{ failure: true }, { partial: true }, { stopReason: 'cancelled' }, { stopReason: 'maxTokens' }]) assert('incomplete/provider/cancel held', !!autoHoldReason(good, { ...closeTurn('eligibility', 1), ...flags }));
good.observerErrors++;
assert('observer errors held', !!autoHoldReason(good, closeTurn('eligibility', 1))); good.observerErrors = 0;
good.unmatchedResults++;
assert('ambiguous results held', !!autoHoldReason(good, closeTurn('eligibility', 1))); good.unmatchedResults = 0;
assert('goal-only management excluded', !!autoHoldReason(new UploadTurn(1, 'ack'), closeTurn('eligibility', 1)));
const late = new UploadTurn(2, '');
late.receiveLate(UploadTurn.late({ turn: 1, ordinal: 1, invocation: 'call', invocationScope: 1, tool: 'arbitrary-tool' }, new ToolResultBlock({ toolUseId: 'call', status: 'success', content: [new TextBlock('late actual result')] })));
assert('traceable genuine late result without synthetic USER allowed', autoHoldReason(late, closeTurn('eligibility', 2)) === undefined);
const truncated = new UploadTurn(1, '长'.repeat(10000)); add(truncated);
assert('ordinary bounded truncation allowed', autoHoldReason(truncated, closeTurn('eligibility', 1)) === undefined);
const ackOnly = new UploadTurn(1, 'goal'); const ackState = {};
const ackUse = new ToolUseBlock({ name: 'subagent', toolUseId: 'ack', input: {} });
ackOnly.before(new BeforeToolCallEvent({ agent, invocationState: ackState, tool: undefined, toolUse: ackUse }));
ackOnly.fallback(new ToolResultEvent({ agent, invocationState: ackState, result: new ToolResultBlock({ toolUseId: 'ack', status: 'success', content: [new TextBlock('Background task dispatched.\n\nTask ID: synthetic')] }) }));
assert('ack-only cannot qualify', !!autoHoldReason(ackOnly, closeTurn('eligibility', 1)));
const nondurable = { durable: false as const, turn: 1 };
assert('nondurable close cannot qualify', !!autoHoldReason(good, nondurable as Parameters<typeof autoHoldReason>[1]));
const damaged = new UploadTurn(1, 'goal');
const damagedUse = new ToolUseBlock({ name: 'arbitrary-tool', toolUseId: 'damaged', input: {} });
Object.defineProperty(damagedUse.input, 'unavailable', { enumerable: true, get() { throw new Error('must not evaluate'); } });
damaged.before(new BeforeToolCallEvent({ agent, invocationState: ackState, tool: undefined, toolUse: damagedUse }));
damaged.after(new AfterToolCallEvent({ agent, invocationState: ackState, tool: undefined, toolUse: damagedUse, result: new ToolResultBlock({ toolUseId: 'damaged', status: 'success', content: [new TextBlock('actual result')] }) }));
assert('serious source collection problem held manual', !!autoHoldReason(damaged, closeTurn('eligibility', 1)));

const maxOverrides = Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`p${index}`, {}]));
assert('project registry capacity is finite', await rejects(() => parseProjectOverrides(maxOverrides)));
assert('budget integer upper bounds reject unbounded values', await rejects(() => parseProjectOverrides({ [key]: { agentCoreMemory: { autoDailyEvents: 100001 } } })) && await rejects(() => parseProjectOverrides({ [key]: { agentCoreMemory: { autoDailyBytes: 107374182401 } } })));
const disabled = new CloudMemory({ ...base, upload: 'off' }, root, 'disabled');
assert('off collector absent and no automatic work', disabled.uploadObserver === undefined && calls.length === 0); await disabled.close();

header('Signed loopback automatic pipeline and immutable manual compatibility');
const memory = new CloudMemory(base, root, 'auto-session');
const oldToken = await capture(memory, 1);
assert('manual pending not sent', calls.length === 0);
await memory.command('auto', 'user');
const blockedToken = await capture(memory, 2, { failed: true });
assert('old pending blocks later same-session auto', calls.length === 0 && (await memory.command('pending')).includes('earlier pending'));
const otherSession = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'other-session');
statuses = [429, 503, 200];
const autoToken = await capture(otherSession, 1, { failed: true });
assert('unrelated session sends with finite retries', calls.length === 3);
assert('stable exact body/token across retries, signed request', new Set(calls.map(call => call.body)).size === 1 && calls.every(call => call.authorization.startsWith('AWS4-HMAC-SHA256')));
assert('no forged manual preview proof', await readState(path.join(box(), `${autoToken}.preview.json`)) === undefined);
assert('durable accepted receipt', (await tokenReceipt(box(), autoToken))?.disposition === 'accepted');
const usage = await quotaUsage(root);
assert('quota counts exact multibyte wire bytes for every attempt', usage.events === 3 && usage.bytes === calls.reduce((n, call) => n + Buffer.byteLength(call.body), 0));
const beforeOld = await readFile(path.join(box(), `${oldToken}.event.json`), 'utf8');
await memory.command('manual', 'user');
assert('mode switch preserves manual bytes and proofs', await readFile(path.join(box(), `${oldToken}.event.json`), 'utf8') === beforeOld && await readState(path.join(box(), `${blockedToken}.auto.json`)) !== undefined);
await memory.command('auto', 'user');
await capture(memory, 3);
assert('re-enable never retroactively authorizes old epoch', calls.length === 3);
const preview = await memory.command(`preview ${oldToken}`, 'user');
const oldHash = /send [a-f0-9]{64} ([a-f0-9]{64})/.exec(preview)![1]!;
assert('manual preview/hash send works in auto', (await memory.command(`send ${oldToken} ${oldHash}`, 'user')).startsWith('AWS event accepted.'));
assert('manual send does not consume auto quota', (await quotaUsage(root)).events === 3);
const beforeRevoke = calls.length;
await persistUploadMode(root, memory.config, 'manual', signal);
await capture(otherSession, 2);
assert('other-runtime revocation prevents request', calls.length === beforeRevoke);
await memory.command('auto', 'user');
const failures = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'auth-failure');
statuses = [403]; await capture(failures, 1); const after403 = calls.length; await capture(failures, 2);
assert('IAM 4xx stops sender visibly and no later request', calls.length === after403 && failures.status().includes('HTTP 403'));
const stoppedRestart = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'stopped-restart');
assert('permanent stop is visible after restart', (await stoppedRestart.command('status')).includes('Auto stopped:'));
await capture(stoppedRestart, 1);
assert('permanent stop persists across processes/runtimes', calls.length === after403); await stoppedRestart.close();
await failures.close(); await otherSession.close();
// Exact boundary, restart, rollover and corruption are filesystem-only quota tests.
const quotaRoot = path.join(home, 'quota'); await mkdir(quotaRoot);
const tiny = { ...base, autoDailyEvents: 2, autoDailyBytes: 8 };
await reserveQuota(quotaRoot, tiny, 4, signal, new Date('2026-01-01'));
await reserveQuota(quotaRoot, tiny, 4, signal, new Date('2026-01-01'));
assert('exact daily boundary then pause', await rejects(() => reserveQuota(quotaRoot, tiny, 1, signal, new Date('2026-01-01'))));
assert('persisted budget survives new reader', (await quotaUsage(quotaRoot, new Date('2026-01-01'))).bytes === 8);
await reserveQuota(quotaRoot, tiny, 1, signal, new Date('2026-01-02'));
assert('UTC rollover resets; clock backwards fails closed', (await quotaUsage(quotaRoot, new Date('2026-01-02'))).events === 1 && await rejects(() => quotaUsage(quotaRoot, new Date('2026-01-01'))));
await writeState(path.join(quotaDirectory(quotaRoot), 'usage.json'), { corrupt: true });
assert('corrupt quota fails closed', await rejects(() => reserveQuota(quotaRoot, tiny, 1, signal)));

header('Cross-process reservation, delayed authorization and cancellation');
const raceRoot = path.join(home, 'race'); await mkdir(raceRoot);
const moduleUrl = new URL('../src/agentcore/auto-state.ts', import.meta.url).href;
const quotaChild = `import { reserveQuota } from ${JSON.stringify(moduleUrl)}; try { await reserveQuota(${JSON.stringify(raceRoot)}, ${JSON.stringify({ ...base, autoDailyEvents: 1, autoDailyBytes: 10 })}, 10, new AbortController().signal); } catch { process.exitCode = 2; }`;
const child = () => {
  const processChild = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', quotaChild], { env: { ...process.env }, stdio: 'ignore' });
  return once(processChild, 'exit').then(([code]) => code);
};
const codes = await Promise.all([child(), child()]);
assert('two processes cannot double reserve one-event budget', codes.filter(code => code === 0).length === 1 && (await quotaUsage(raceRoot)).events === 1);
const sharedQuota = { ...base, projectId: 'shared-quota', autoDailyEvents: 1, autoDailyBytes: 10 };
await reserveQuota(root, sharedQuota, 10, signal);
assert('explicit shared identity cannot bypass quotas through another checkout', await rejects(() => reserveQuota(other, sharedQuota, 10, signal)));
await withStateLock(path.join(path.dirname(file), 'config-write-lock'), async () => {
  const source = `import { updateConfigFile } from ${JSON.stringify(new URL('../src/config-file.ts', import.meta.url).href)}; try { await updateConfigFile(${JSON.stringify(file)}, r => { r.name = 'wrong'; }); } catch { process.exitCode = 2; }`;
  const writer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { env: { ...process.env }, stdio: 'ignore' });
  const [code] = await once(writer, 'exit');
  assert('cross-process config writer cannot bypass held lock', code === 2);
});
function pause(file: string, boundary: string) {
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const reached = new Promise<void>(resolve => { entered = resolve; });
  setCloudStateObserverForTest(async (name, phase) => { if (name === file && phase === boundary) { entered(); await gate; } });
  return { release, reached };
}
await memory.command('auto', 'user');
const delayed = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'delayed');
let delayedToken = digest([cloudBinding(base, root), delayed.session, 1, 11]);
let paused = pause(path.join(box(), `${delayedToken}.attempt-1.json`), 'after-publish');
let beforeRace = calls.length; let pendingCapture = capture(delayed, 1);
await paused.reached;
const concurrentPublication = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'concurrent-publication');
concurrentPublication.begin(1, 'goal while network reserved'); concurrentPublication.sealTurn(1, true); concurrentPublication.settle(closeTurn('concurrent-publication', 1));
await (concurrentPublication as unknown as { chain: Promise<void> }).chain;
assert('event publication does not wait on network-owned outbox lock', await readState(path.join(box(), `${digest([cloudBinding(base, root), 'concurrent-publication', 1, 11])}.event.json`)) !== undefined);
await concurrentPublication.close();
await persistUploadMode(root, delayed.config, 'manual', signal);
paused.release(); await pendingCapture; setCloudStateObserverForTest(undefined);
assert('revocation after durable attempt reservation still prevents launch', calls.length === beforeRace && await readState(path.join(box(), `${delayedToken}.attempt-1.json`)) !== undefined);
await delayed.close();
await memory.command('auto', 'user');
const cancelMemory = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'cancel-before-launch');
delayedToken = digest([cloudBinding(base, root), cancelMemory.session, 1, 11]);
paused = pause(path.join(box(), `${delayedToken}.attempt-1.json`), 'before-publish');
pendingCapture = capture(cancelMemory, 1); await paused.reached; cancelMemory.cancel(); paused.release(); await pendingCapture; setCloudStateObserverForTest(undefined);
assert('cancel before reservation publication prevents request', calls.length === beforeRace && await readState(path.join(box(), `${delayedToken}.attempt-1.json`)) === undefined);
await cancelMemory.close();
await memory.command('auto', 'user');
const ackMemory = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'ack-race');
const ackToken = digest([cloudBinding(base, root), ackMemory.session, 1, 11]);
paused = pause(path.join(box(), `${ackToken}.accepted.json`), 'before-publish');
pendingCapture = capture(ackMemory, 1); await paused.reached; ackMemory.cancel(); paused.release(); await pendingCapture; setCloudStateObserverForTest(undefined);
assert('exact AWS acknowledgement survives cancellation race', (await tokenReceipt(box(), ackToken))?.disposition === 'accepted');
await ackMemory.close();
await memory.command('auto', 'user');
const budgetRecord = JSON.parse(await readFile(file, 'utf8'));
budgetRecord.projectOverrides[key].agentCoreMemory.autoDailyEvents = (await quotaUsage(root)).events;
await configure(budgetRecord);
const budgetMemory = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'budget-paused');
beforeRace = calls.length; const pausedToken = await capture(budgetMemory, 1);
assert('budget pause retains inspectable candidate and consumes no attempt', calls.length === beforeRace && (await budgetMemory.command('pending')).includes('budget exhausted') && await readState(path.join(box(), `${pausedToken}.attempt-1.json`)) === undefined);
budgetRecord.projectOverrides[key].agentCoreMemory.autoDailyEvents = 500; await configure(budgetRecord);
await capture(budgetMemory, 2);
assert('next ordinary activity resumes bounded same-epoch candidates', calls.length === beforeRace + 2);
await budgetMemory.close();

await memory.command('auto', 'user');
const retryMemory = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'retry-cancel');
let requested!: () => void; const requestSeen = new Promise<void>(resolve => { requested = resolve; }); onRequest = requested; statuses = [503];
beforeRace = calls.length; pendingCapture = capture(retryMemory, 1); await requestSeen; retryMemory.cancel(); await pendingCapture; onRequest = undefined;
assert('cancelled retry never issues a successor request', calls.length === beforeRace + 1); await retryMemory.close();
await memory.command('auto', 'user');
const closing = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'shutdown-before-launch');
const closingToken = digest([cloudBinding(base, root), closing.session, 1, 11]);
paused = pause(path.join(box(), `${closingToken}.attempt-1.json`), 'before-publish');
beforeRace = calls.length; pendingCapture = capture(closing, 1); await paused.reached;
const shutdown = closing.close(); paused.release(); await shutdown; await pendingCapture; setCloudStateObserverForTest(undefined);
assert('shutdown cancels owned work and late launch', calls.length === beforeRace && await readState(path.join(box(), `${closingToken}.attempt-1.json`)) === undefined);
await memory.command('auto', 'user');
const exhausted = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'three-attempts');
statuses = [503, 503, 503]; beforeRace = calls.length; const exhaustedToken = await capture(exhausted, 1);
await capture(exhausted, 2);
assert('auto retry cap is durable and never exceeds three', calls.length === beforeRace + 3 && await readState(path.join(box(), `${exhaustedToken}.attempt-3.json`)) !== undefined);
await exhausted.close();
// A pre-enable open turn remains manual even if settlement happens after consent.
await memory.command('manual', 'user');
const preEnable = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'pre-enable');
preEnable.begin(1, 'old goal');
const preUse = new ToolUseBlock({ name: 'arbitrary-tool', toolUseId: 'pre', input: {} }); const preState = {};
preEnable.uploadObserver!.before(new BeforeToolCallEvent({ agent, invocationState: preState, tool: undefined, toolUse: preUse }));
preEnable.uploadObserver!.after(new AfterToolCallEvent({ agent, invocationState: preState, tool: undefined, toolUse: preUse, result: new ToolResultBlock({ toolUseId: 'pre', status: 'success', content: [new TextBlock('actual old result')] }) }));
await preEnable.command('auto', 'user'); beforeRace = calls.length; preEnable.sealTurn(1, true); preEnable.settle(closeTurn('pre-enable', 1));
await (preEnable as unknown as { chain: Promise<void> }).chain; await (preEnable as unknown as { autoWork: Promise<void> }).autoWork;
assert('pre-enable originating turn has no auto proof or request', calls.length === beforeRace && await readState(path.join(box(), `${digest([cloudBinding(base, root), 'pre-enable', 1, 11])}.auto.json`)) === undefined);
await preEnable.close();

header('Auto-only retention and local legacy cleanup');
const acceptedFile = path.join(box(), `${autoToken}.accepted.json`);
await writeState(acceptedFile, { eventId: 'synthetic-event', auto: true, at: new Date(Date.now() - AUTO_RETENTION_MS - 1000).toISOString() });
await memory.command('auto', 'user');
await capture(memory, 4);
assert('7-day auto body expires but permanent receipt survives', await readState(path.join(box(), `${autoToken}.event.json`)) === undefined && (await tokenReceipt(box(), autoToken))?.disposition === 'accepted');
assert('manual accepted body never auto-expires', await readState(path.join(box(), `${oldToken}.event.json`)) !== undefined);
const legacySession = 'legacy-session'; const legacyToken = digest([cloudBinding(base, root), legacySession, 1, 11]);
const legacyBody = uploadBody({ memoryId: base.memoryId, actorId: base.actorId, sessionId: legacySession, eventTimestamp: new Date().toISOString(), clientToken: legacyToken, extractionConfig: { namespaceVariables: { projectid: key } } }, good, closeTurn(legacySession, 1))!;
const metadata = JSON.parse(legacyBody.payload[0]!.conversational.content.text); metadata.format = 'legacy';
legacyBody.payload[0]!.conversational.content.text = JSON.stringify(metadata);
const legacyEntry = { version: 1, binding: cloudBinding(base, root), token: legacyToken, body: legacyBody };
await writeState(path.join(box(), `${legacyToken}.event.json`), legacyEntry);
const legacyPreview = await memory.command('discard-legacy', 'user');
const manifestHash = /discard-legacy ([a-f0-9]{64})/.exec(legacyPreview)![1]!;
assert('legacy batch preview bounded and user-only', legacyPreview.includes('1 unaccepted') && !(await memory.commandResult(`discard-legacy ${manifestHash}`, 'read')).ok);
await writeState(path.join(box(), `${legacyToken}.event.json`), { ...legacyEntry, body: { ...legacyBody, eventTimestamp: '2026-01-01T00:00:00Z' } });
assert('TOCTOU mutation refuses zero-removal', !(await memory.commandResult(`discard-legacy ${manifestHash}`, 'user')).ok && await readState(path.join(box(), `${legacyToken}.event.json`)) !== undefined);
const nextManifest = /discard-legacy ([a-f0-9]{64})/.exec(await memory.command('discard-legacy', 'user'))![1]!;
assert('confirmed legacy batch only removes legacy local body', (await memory.command(`discard-legacy ${nextManifest}`, 'user')).includes('Discarded 1') && await readState(path.join(box(), `${legacyToken}.event.json`)) === undefined && await readState(path.join(box(), `${blockedToken}.event.json`)) !== undefined);
assert('legacy discard durable tombstone', (await tokenReceipt(box(), legacyToken))?.disposition === 'discarded');
const receiptRoot = path.join(home, 'receipts');
for (let index = 0; index < 260; index++) await saveReceipt(receiptRoot, digest(index), 'accepted');
assert('receipts exceed old 256 cap without whole archive read', (await tokenReceipt(receiptRoot, digest(0)))?.disposition === 'accepted' && (await tokenReceipt(receiptRoot, digest(259)))?.disposition === 'accepted');
// Partial batch cleanup: durable manifest + tombstone, cancellation before body removal.
await writeState(path.join(box(), `${legacyToken}.event.json`), legacyEntry);
const partialToken = digest([cloudBinding(base, root), 'legacy-partial', 1, 11]);
const partialBody = { ...legacyBody, sessionId: 'legacy-partial', clientToken: partialToken, payload: legacyBody.payload.map((p, index) => index ? p : { conversational: { ...p.conversational, content: { text: JSON.stringify({ ...metadata, session: 'legacy-partial' }) } } }) };
await writeState(path.join(box(), `${partialToken}.event.json`), { ...legacyEntry, token: partialToken, body: partialBody });
const partialHash = /discard-legacy ([a-f0-9]{64})/.exec(await memory.command('discard-legacy', 'user'))![1]!;
paused = pause(receiptFile(box(), partialToken), 'after-publish');
const cleanupPromise = memory.commandResult(`discard-legacy ${partialHash}`, 'user');
await paused.reached; memory.cancel(); paused.release(); await cleanupPromise; setCloudStateObserverForTest(undefined);
assert('partial legacy cleanup leaves receipt and body, restart-safe', (await tokenReceipt(box(), partialToken))?.disposition === 'discarded' && await readState(path.join(box(), `${partialToken}.event.json`)) !== undefined);
const cleanupRestart = new CloudMemory((await loadConfig(root)).agentCoreMemory!, root, 'cleanup-restart');
assert('repeat confirmed manifest completes partial cleanup', (await cleanupRestart.command(`discard-legacy ${partialHash}`, 'user')).includes('Discarded 1') && await readState(path.join(box(), `${partialToken}.event.json`)) === undefined);
await cleanupRestart.close();
assert('v2 and manually accepted events remain outside batch', await readState(path.join(box(), `${blockedToken}.event.json`)) !== undefined && await readState(path.join(box(), `${oldToken}.event.json`)) !== undefined);
const fullShard = path.join(home, 'full-receipts'); const fullToken = 'aa' + 'f'.repeat(62);
await mkdir(path.dirname(receiptFile(fullShard, fullToken)), { recursive: true });
for (let i = 0; i < 4096; i++) await writeFile(path.join(path.dirname(receiptFile(fullShard, fullToken)), `${i}.json`), '{}');
assert('receipt partition capacity refuses before removal/publication', await rejects(() => receiptCapacity(fullShard, [fullToken])) && await readState(receiptFile(fullShard, fullToken)) === undefined);
const capRoot = path.join(home, 'cap-project'); await mkdir(capRoot);
const capConfig = { ...base }; const capBox = path.join(cloudDirectory(capConfig, capRoot), cloudBinding(capConfig, capRoot));
await mkdir(capBox, { recursive: true });
for (let i = 0; i < 512; i++) await writeFile(path.join(capBox, `${digest(i)}.event.json`), '{}');
const full = new CloudMemory(capConfig, capRoot, 'full'); full.uploadObserver!.begin(1, 'goal'); full.settle(closeTurn('full', 1));
await (full as unknown as { chain: Promise<void> }).chain;
assert('pending capacity stops visibly with all old bodies intact', full.status().includes('Outbox full') && (await stateNames(capBox, 32768)).filter(n => n.endsWith('.event.json')).length === 512); await full.close();
await memory.close();

header('Actual runtime durable event and successor policy');
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
await writeFile(path.join(root, 'evidence.txt'), 'real runtime evidence 中文');
await configure({ agentCoreMemory: base, memory: false, contextOffload: false, models: [{ model: 'offline-a', promptCache: false, enable: true }, { model: 'offline-b', promptCache: false }] });
await persistUploadMode(root, base, 'auto', signal);
setRuntimeModelFactoryForTest(async () => new LocalModel());
const runtime = await AgentRuntime.create({ projectRoot: root, session: { kind: 'new' }, permissionModeOverride: 'yolo', permissionBridge: async () => ({ allowed: true }) });
const beforeRuntime = calls.length;
for await (const _event of runtime.send('read evidence')) {}
const cloud = (runtime as unknown as { cloudMemory: CloudMemory }).cloudMemory;
// Recorder closing barrier settles before the detached queue is observed.
await (runtime as unknown as { trajectory: { chain: Promise<void> } }).trajectory.chain;
await (cloud as unknown as { chain: Promise<void> }).chain;
await (cloud as unknown as { autoWork: Promise<void> }).autoWork;
assert('actual runtime automatically sends new durable event, no preview', calls.length === beforeRuntime + 1 && calls.at(-1)!.body.includes('real runtime evidence'));
const beforeMessages = (runtime as unknown as { agent: Agent }).agent.messages;
const changed = await runtime.changeModel(runtime.config.modelChoices[1]!); await changed.saved;
assert('live model switch preserves project policy and conversation', runtime.config.agentCoreMemory?.upload === 'auto' && (runtime as unknown as { agent: Agent }).agent.messages === beforeMessages && (await loadConfig(root)).agentCoreMemory?.upload === 'auto');
await runtime.manageCloudMemory('manual');
assert('runtime policy changes without replacing conversation', runtime.config.agentCoreMemory?.upload === 'manual' && (runtime as unknown as { agent: Agent }).agent.messages === beforeMessages);
const checkpoint = (await runtime.listRewindCheckpoints()).checkpoints[0]!;
const rewound = await runtime.startRewind(checkpoint);
assert('rewind successor preserves effective project policy', rewound.config.agentCoreMemory?.upload === 'manual');
const successor = await rewound.startNewSession();
assert('clear successor preserves effective project policy', successor.config.agentCoreMemory?.upload === 'manual');
await successor.manageCloudMemory('auto');
const validPolicy = await readFile(file, 'utf8'); await writeFile(file, '{broken');
const successorCloud = (successor as unknown as { cloudMemory: CloudMemory }).cloudMemory;
await successorCloud.refreshPolicy();
assert('corrupt changed policy fails closed without breaking ordinary invocation preparation', successorCloud.config.upload === 'manual' && successorCloud.status().includes('repair config'));
await writeFile(file, validPolicy);
await successor.shutdown(); setRuntimeModelFactoryForTest(undefined);

setMemoryTransportOptionsForTest(undefined); server.close(); await once(server, 'close');
report();
