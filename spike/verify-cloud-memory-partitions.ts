/** New upload session budget: real files, SDK events and signed loopback HTTP.
 * Isolated HOME; no AWS, real config, historical outboxes or model calls.
 * Run: pnpm tsx spike/verify-cloud-memory-partitions.ts */
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';

import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Agent, BeforeToolCallEvent, AfterToolCallEvent, ToolUseBlock, ToolResultBlock, TextBlock } from '@strands-agents/sdk';
import { CloudMemory } from '../src/agentcore/controller.js';
import { digest, parseAgentCoreConfig, scopeFor } from '../src/agentcore/config.js';
import { cloudBinding } from '../src/project-overrides.js';
import { cloudDirectory, readState, writeState } from '../src/agentcore/state.js';
import { UploadTurn, uploadBody, memorySessionId, MAX_NEW_EVENT_BYTES, MAX_EVENT_BYTES } from '../src/agentcore/upload-projection.js';
import { setMemoryTransportOptionsForTest } from '../src/agentcore/transport.js';
import { loopbackHandler } from './agentcore-sdk-fixture.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const home = ownPrivateHome('cloud-partitions'); const root = path.join(home, 'project'); await mkdir(root);
const config = parseAgentCoreConfig({ enabled: true, region: 'us-west-2', memoryId: 'Synthetic-0123456789', actorId: 'synthetic-user', episodicStrategyId: 'episodes', preferenceStrategyId: 'preferences', preferences: false, upload: 'manual' })!;
Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'AKIDSYNTHETIC', AWS_SECRET_ACCESS_KEY: 'synthetic-not-a-secret', AWS_EC2_METADATA_DISABLED: 'true' });
const requests: string[] = []; let fail = false;
const server = createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += String(chunk);
  requests.push(text); response.setHeader('content-type', 'application/json');
  if (fail) { response.statusCode = 503; response.end('{"message":"synthetic unavailable"}'); return; }
  const body = JSON.parse(text);
  response.end(JSON.stringify({ event: { memoryId: config.memoryId, actorId: body.actorId, sessionId: body.sessionId, eventId: 'synthetic-event' } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); if (!address || typeof address === 'string') throw new Error('Loopback address missing');
setMemoryTransportOptionsForTest(() => ({ requestHandler: loopbackHandler(address.port) }));
const agent = new Agent({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
const session = 'session-logical';
const binding = cloudBinding(config, root);
const directory = path.join(cloudDirectory(config, root), binding);
const settlement = (turn: number, seq = turn * 100, origin = session) => ({ durable: true as const, session: origin, turn, seq, at: '2026-01-01T00:00:00Z', stopReason: 'endTurn', failure: false, partial: false });
const tokenFor = (turn: number, seq = turn * 100, origin = session) => digest([binding, origin, turn, seq]);
const fileFor = (token: string, suffix = 'event') => path.join(directory, `${token}.${suffix}.json`);
function action(turn: UploadTurn, i: number) {
  const invocationState = {};
  const toolUse = new ToolUseBlock({ name: 'bash', toolUseId: `tool-${i}`, input: { command: 'pnpm test', text: 'raw-input '.repeat(1000) } });
  turn.before(new BeforeToolCallEvent({ agent, invocationState, tool: undefined, toolUse }));
  turn.after(new AfterToolCallEvent({ agent, invocationState, tool: undefined, toolUse, result: new ToolResultBlock({ toolUseId: toolUse.toolUseId, status: i === 4 ? 'error' : 'success', content: [new TextBlock('raw-output '.repeat(1000) + `END-${i}`)] }) }));
}
function bodyFor(turn: number, seq = turn * 100, origin = session) {
  const projection = new UploadTurn(turn, 'User goal and constraints');
  for (let i = 0; i < 64; i++) action(projection, i);
  return uploadBody({ memoryId: config.memoryId, actorId: config.actorId, sessionId: origin, clientToken: tokenFor(turn, seq, origin), eventTimestamp: settlement(turn).at, extractionConfig: { namespaceVariables: { projectid: scopeFor(config, root).projectId } } }, projection, settlement(turn, seq, origin))!;
}
async function publish(memory: CloudMemory, turn: number) {
  memory.uploadObserver!.begin(turn, `goal ${turn}`);
  memory.settle(settlement(turn));
  await memory.command('pending'); // Existing public local-publication barrier.
  const value = await readState(fileFor(tokenFor(turn)));
  if (!value) throw new Error('Candidate missing');
  return value as { version: number; binding: string; token: string; body: ReturnType<typeof bodyFor> };
}
const user = (memory: CloudMemory, input: string) => memory.commandResult(input, 'user');
const memory = new CloudMemory(config, root, session);
let restarted: CloudMemory | undefined;
try {

  header('Deterministic per-event sessions and cumulative bytes');
  const baseline = bodyFor(1); const source = JSON.parse(baseline.payload[0]!.conversational.content.text);
  const cases = [baseline, bodyFor(1, 101), bodyFor(2, 100), bodyFor(1, 100, 'session-branch'), bodyFor(1)];
  const totals = new Map<string, Map<string, number>>();
  for (const body of cases) {
    const bytes = Buffer.byteLength(JSON.stringify(body));
    const events = totals.get(body.sessionId) ?? new Map<string, number>();
    events.set(body.clientToken, bytes); totals.set(body.sessionId, events);
    assert('new request fits byte budget and legal session ID', bytes <= MAX_NEW_EVENT_BYTES && /^[a-zA-Z0-9_-]{1,128}$/.test(body.sessionId));
  }
  assert('same turn/different seq, different turn/same seq and branch all partition independently', totals.size === 4);
  assert('every Memory session has one unique event and bounded accumulated bytes', [...totals.values()].every(events => events.size === 1 && [...events.values()].reduce((a, b) => a + b, 0) <= MAX_NEW_EVENT_BYTES));
  assert('same identity reproduces exact session/body while original Darwin provenance survives', JSON.stringify(baseline) === JSON.stringify(cases.at(-1)) && source.session === session && source.turn === 1 && source.closingSeq === 100 && source.memorySession.maxEvents === 1);
  const tools = baseline.payload.filter(p => p.conversational.role === 'TOOL').map(p => JSON.parse(p.conversational.content.text));
  assert('failure, recovery and final validation raw evidence survives tighter cap', [4, 5, 63].every(i => tools.some(action => action.invocation === `tool-${i}` && JSON.stringify(action).includes(`END-${i}`))));
  assert('omitted actions remain explicit and selected actions stay chronological', source.quality.actionBodiesOmitted === 64 - tools.length && tools.every((action, i) => !i || tools[i - 1].ordinal < action.ordinal));
  for (const goal of ['\u0000'.repeat(20000), '😀中文\\\"'.repeat(20000), '\ud800'.repeat(20000)]) {
    const projection = new UploadTurn(1, goal);
    const body = uploadBody(baseline, projection, settlement(1))!;
    assert('escaped goal-only baseline remains bounded with exact retained slices', Buffer.byteLength(JSON.stringify(body)) <= MAX_NEW_EVENT_BYTES && body.payload[1]!.conversational.content.text === projection.goal.parts.join(''));
  }
  const empty = uploadBody(baseline, new UploadTurn(1, ''), settlement(1));
  assert('empty turn does not consume a Memory partition', empty === undefined);

  header('Frozen legacy bytes, mixed-session order and restart retry');
  // Independent old-v2 shape, deliberately larger than the new cap. No new
  // renderer creates this fixture and its existing preview/attempt are retained.
  const oldToken = tokenFor(1);
  const oldBody: ReturnType<typeof bodyFor> = { memoryId: config.memoryId, actorId: config.actorId, sessionId: session, eventTimestamp: settlement(1).at, clientToken: oldToken, extractionConfig: { namespaceVariables: { projectid: memory.scope.projectId } }, payload: [
    { conversational: { role: 'OTHER', content: { text: JSON.stringify({ format: 'darwin-upload-v2', session, turn: 1, closingSeq: 100, goal: { present: true }, quality: { completeActions: 1, missingResults: 0, contentTruncatedActions: 0, actionBodiesOmitted: 0, sourceLimitedActions: 0 } }) } } },
    { conversational: { role: 'USER', content: { text: 'old literal goal' } } },
    ...Array.from({ length: 2 }, () => ({ conversational: { role: 'TOOL' as const, content: { text: 'old raw evidence '.repeat(4000) } } })),
  ] };
  const oldEntry = { version: 1, binding, token: oldToken, body: oldBody }; const oldHash = digest(oldEntry);
  await writeState(fileFor(oldToken), oldEntry, true);
  await writeState(fileFor(oldToken, 'preview'), { hash: oldHash }, true);
  await writeState(fileFor(oldToken, 'attempt-1'), { hash: oldHash }, true);
  const oldBytes = await readFile(fileFor(oldToken));
  const oldProofBytes = await readFile(fileFor(oldToken, 'preview'));
  assert('legacy fixture exceeds new cap but fits original cap', Buffer.byteLength(JSON.stringify(oldBody)) > MAX_NEW_EVENT_BYTES && Buffer.byteLength(JSON.stringify(oldBody)) <= MAX_EVENT_BYTES);
  const second = await publish(memory, 2); const secondHash = digest(second);
  assert('publication uses partition but preserves original source and project namespace', second.body.sessionId === memorySessionId(second.token) && JSON.parse(second.body.payload[0]!.conversational.content.text).session === session && second.body.extractionConfig.namespaceVariables.projectid === memory.scope.projectId);
  assert('new publication does not send or rewrite old bytes/proofs', requests.length === 0 && (await readFile(fileFor(oldToken))).equals(oldBytes) && (await readFile(fileFor(oldToken, 'preview'))).equals(oldProofBytes));
  const read = await memory.commandResult(`preview ${oldToken}`);
  assert('legacy read-only preview still valid without proof changes', read.ok && read.text.includes(oldHash) && (await readFile(fileFor(oldToken, 'preview'))).equals(oldProofBytes));
  assert('new event cannot send without its exact user preview', !(await user(memory, `send ${second.token} ${secondHash}`)).ok && requests.length === 0);
  await user(memory, `preview ${second.token}`);
  const blocked = await user(memory, `send ${second.token} ${secondHash}`);
  assert('earlier legacy turn blocks later partition before reservation/network', !blocked.ok && blocked.text.includes('earlier pending') && requests.length === 0 && await readState(fileFor(second.token, 'attempt-1')) === undefined);
  assert('explicit old preview authorization can still send exact legacy bytes', (await user(memory, `send ${oldToken} ${oldHash}`)).ok && isDeepStrictEqual(JSON.parse(requests[0]!).payload, oldBody.payload) && (await readFile(fileFor(oldToken))).equals(oldBytes));
  fail = true;
  const failed = await user(memory, `send ${second.token} ${secondHash}`);
  const firstRequest = requests.at(-1)!;
  assert('failed send retains deterministic partition and durable reservation', !failed.ok && JSON.parse(firstRequest).sessionId === second.body.sessionId && (await readState(fileFor(second.token, 'attempt-1')) as { hash: string }).hash === secondHash);
  const frozenSecond = await readFile(fileFor(second.token));
  await memory.close(); restarted = new CloudMemory(config, root, session); fail = false;
  const again = await publish(restarted, 2);
  assert('duplicate settlement after restart cannot replace immutable candidate', digest(again) === secondHash && (await readFile(fileFor(second.token))).equals(frozenSecond));
  assert('restart uses original preview, body, token and Memory partition', (await user(restarted, `send ${second.token} ${secondHash}`)).ok && requests.at(-1) === firstRequest && (await readFile(fileFor(second.token))).equals(frozenSecond));
  const sent = requests.length;
  assert('accepted event is not repeated', (await user(restarted, `send ${second.token} ${secondHash}`)).ok && requests.length === sent);
  await user(restarted, 'clear-accepted');
  await publishAfterCleanup();
  async function publishAfterCleanup() {
    restarted!.uploadObserver!.begin(2, 'duplicate after cleanup'); restarted!.settle(settlement(2));
    await restarted!.command('pending');
    assert('receipt prevents reallocation/republication after body cleanup', await readState(fileFor(second.token)) === undefined && requests.length === sent);
  }
  const third = await publish(restarted, 3); const fourth = await publish(restarted, 4);
  await user(restarted, `preview ${fourth.token}`);
  const later = await user(restarted, `send ${fourth.token} ${digest(fourth)}`);
  assert('new-to-new ordering still follows original session, not Memory partition', !later.ok && later.text.includes(third.token) && requests.length === sent);

  header('Fail-closed new metadata and partition identity');
  for (const kind of ['session', 'budget', 'oversize', 'missing-budget'] as const) {
    const changed = structuredClone(third);
    const source = JSON.parse(changed.body.payload[0]!.conversational.content.text);
    if (kind === 'session') changed.body.sessionId = memorySessionId('0'.repeat(64));
    if (kind === 'budget') source.memorySession.maxBytes++;
    if (kind === 'missing-budget') delete source.memorySession;
    if (kind === 'oversize') changed.body.payload.push(...oldBody.payload.slice(2));
    changed.body.payload[0]!.conversational.content.text = JSON.stringify(source);
    await writeState(fileFor(third.token), changed);
    const refused = await restarted.commandResult(`preview ${third.token}`);
    assert(`tampered ${kind} refused before proof/network`, !refused.ok && requests.length === sent && await readState(fileFor(third.token, 'preview')) === undefined);
  }
  await writeState(fileFor(third.token), third);
  assert('restored valid new entry exposes byte budget, not token guarantee', (await restarted.command('pending')).includes('98304 byte budget (not tokens)'));
} finally {
  await memory.close(); await restarted?.close(); setMemoryTransportOptionsForTest(undefined);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
report();
