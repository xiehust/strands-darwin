/**
 * Hub handlers through the dependency-free local hub (README §11). Free: no AWS, no model.
 * Real WebSocket clients (Node's global WebSocket with handshake headers) and raw HTTP upgrades.
 *
 * Proves: authorizer refuses missing/malformed headers, unknown/revoked nodes, bad signatures,
 * foreign audience, clock skew and replayed nonces; one-time tokens redeem once (also under
 * concurrency), expire, and every refusal is byte-identical; discover excludes the caller's node;
 * send binds sender to connection and registered endpoint, verifies signatures, time, rate,
 * duplicates, self-routing and target registration; acks relay once and only from the target;
 * enroll/revoke broadcast; revoke closes connections and refuses reconnects; frames over 16 KiB
 * close with 1009; logs never contain message text or tokens; the closure darwin compiles imports
 * no AWS SDK.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  connectHeaders, generateNodeKeys, hubFrame, parseFrame, signEnvelope, type HubAddress, type HubEnvelope, type HubFrame, type NodeKeys,
} from '../../src/collaboration/hub-wire.js';
import { connectionStatus, SENDS_PER_MINUTE } from '../src/handlers.js';
import { LocalHub } from '../src/local-server.js';

let passed = 0;
async function check(name: string, run: () => Promise<void>): Promise<void> { await run(); passed++; console.log(`ok ${name}`); }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let clockOffset = 0;
let frozen: number | undefined;
const hub = await new LocalHub({ now: () => frozen ?? Date.now() + clockOffset }).start();
const SENTINEL = `sentinel-${randomUUID()}`;

interface Node { id: string; keys: NodeKeys; name: string }
async function enrollNode(name: string, token?: string): Promise<{ status: number; body: string; node: Node }> {
  const node = { id: randomUUID(), keys: generateNodeKeys(), name };
  const response = await fetch(`${hub.httpUrl}/enroll`, { method: 'POST', body: JSON.stringify({ token: token ?? await hub.mintToken(), node: node.id, name, publicKey: node.keys.publicKey }) });
  return { status: response.status, body: await response.text(), node };
}

class Client {
  readonly frames: HubFrame[] = [];
  closeCode: number | undefined;
  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', event => { const frame = parseFrame(hubFrame, String(event.data)); if (frame) this.frames.push(frame); });
    ws.addEventListener('close', event => { this.closeCode = event.code; });
  }
  static open(node: Node, headers = connectHeaders(hub.audience, node.id, node.keys.privateKey)): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(hub.wsUrl, { headers } as unknown as string[]);
      const client = new Client(ws);
      ws.addEventListener('open', () => resolve(client), { once: true });
      ws.addEventListener('error', () => reject(new Error('refused')), { once: true });
    });
  }
  send(value: unknown): void { this.ws.send(JSON.stringify(value)); }
  async next<T extends HubFrame['type']>(type: T, match: (frame: Extract<HubFrame, { type: T }>) => boolean = () => true, ms = 3000): Promise<Extract<HubFrame, { type: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const index = this.frames.findIndex(frame => frame.type === type && match(frame as Extract<HubFrame, { type: T }>));
      if (index >= 0) return this.frames.splice(index, 1)[0] as Extract<HubFrame, { type: T }>;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}`);
      await delay(10);
    }
  }
  async none(type: HubFrame['type'], ms = 300): Promise<void> { await delay(ms); assert.equal(this.frames.some(frame => frame.type === type), false, `unexpected ${type}`); }
  close(): void { this.ws.close(); }
}

/** Raw upgrade: returns the HTTP status line code the server answered with. */
function upgradeStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${hub.httpUrl}/v1`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.from(randomUUID()).toString('base64').slice(0, 24), ...headers } });
    request.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 0); });
    request.on('response', response => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on('error', reject);
    request.end();
  });
}

async function register(client: Client, node: Node, project = 'github.com/xiehust/strands-darwin'): Promise<HubAddress> {
  const endpoint = randomUUID(); const rid = randomUUID(); const session = `s-${endpoint.slice(0, 8)}`;
  client.send({ action: 'register', rid, endpoint, project, session });
  const reply = await client.next('registered', frame => frame.rid === rid);
  assert.equal(reply.ok, true);
  return { version: 2, transport: 'hub', node: node.id, endpoint, project, session };
}

function envelope(sender: HubAddress, target: HubAddress, text = SENTINEL, sent = Date.now() + clockOffset): HubEnvelope {
  return { version: 2, id: randomUUID(), sender, target, sent, chain: { id: randomUUID(), started: sent, hop: 0, readOnly: false }, text };
}

// ---------------------------------------------------------------------------

const a = await enrollNode('alpha');
const b = await enrollNode('beta');
await check('enrollment returns node, fingerprint, wsUrl and audience', async () => {
  assert.equal(a.status, 200);
  const body = JSON.parse(a.body);
  assert.equal(body.node, a.node.id); assert.equal(body.wsUrl, hub.wsUrl); assert.equal(body.audience, hub.audience);
  assert.match(body.fingerprint, /^[a-f0-9]{64}$/);
});

await check('one-time tokens: reuse, concurrency, expiry, duplicate node id, malformed — one uniform refusal', async () => {
  const token = await hub.mintToken();
  const first = await enrollNode('gamma', token);
  const reuse = await enrollNode('delta', token);
  assert.equal(first.status, 200);
  assert.equal(reuse.status, 403);
  const shared = await hub.mintToken();
  const racers = await Promise.all(Array.from({ length: 8 }, (_, n) => enrollNode(`racer${n}`, shared)));
  assert.equal(racers.filter(result => result.status === 200).length, 1);
  const expiring = await hub.mintToken();
  clockOffset += 601_000;
  const expired = await enrollNode('late', expiring);
  clockOffset -= 601_000;
  const duplicate = await fetch(`${hub.httpUrl}/enroll`, { method: 'POST', body: JSON.stringify({ token: await hub.mintToken(), node: a.node.id, name: 'dup', publicKey: generateNodeKeys().publicKey }) });
  const malformed = await fetch(`${hub.httpUrl}/enroll`, { method: 'POST', body: '{"token":1}' });
  const bodies = new Set([reuse.body, expired.body, await duplicate.text(), await malformed.text(), ...racers.filter(r => r.status !== 200).map(r => r.body)]);
  assert.equal(expired.status, 403); assert.equal(duplicate.status, 403); assert.equal(malformed.status, 403);
  assert.deepEqual([...bodies], ['{"ok":false,"reason":"enrollment refused"}']);
  assert.equal(JSON.parse((await (await fetch(`${hub.httpUrl}/enroll`, { method: 'POST', body: JSON.stringify({ token: await hub.mintToken(), node: randomUUID(), name: 'x', publicKey: 'short' }) })).text())).ok, false);
});

await check('authorizer refuses every malformed, foreign, stale, replayed or unknown assertion', async () => {
  const good = connectHeaders(hub.audience, a.node.id, a.node.keys.privateKey);
  assert.equal(await upgradeStatus({}), 403);
  assert.equal(await upgradeStatus({ ...good, 'X-Darwin-Sig': 'A'.repeat(86) }), 403);
  assert.equal(await upgradeStatus(connectHeaders('other-api/v1', a.node.id, a.node.keys.privateKey) as unknown as Record<string, string>), 403);
  assert.equal(await upgradeStatus(connectHeaders(hub.audience, a.node.id, a.node.keys.privateKey, Date.now() - 61_000) as unknown as Record<string, string>), 403);
  assert.equal(await upgradeStatus(connectHeaders(hub.audience, a.node.id, b.node.keys.privateKey) as unknown as Record<string, string>), 403);
  assert.equal(await upgradeStatus(connectHeaders(hub.audience, randomUUID(), a.node.keys.privateKey) as unknown as Record<string, string>), 403);
  assert.equal(await upgradeStatus({ ...good, 'X-Darwin-Ts': 'soon' }), 403);
  assert.equal(await upgradeStatus(good as unknown as Record<string, string>), 101);
  assert.equal(await upgradeStatus(good as unknown as Record<string, string>), 403, 'replayed nonce');
  await assert.rejects(Client.open(a.node, { ...good }), /refused/);
});

const ca = await Client.open(a.node);
const cb = await Client.open(b.node);
const addrA = await register(ca, a.node);
const addrB = await register(cb, b.node, 'github.com/other/project');

await check('discover lists other active nodes only, with keys and fingerprints', async () => {
  const rid = randomUUID();
  ca.send({ action: 'discover', rid });
  const found = await ca.next('discovered', frame => frame.rid === rid);
  assert.ok(found.endpoints.some(row => row.address.endpoint === addrB.endpoint && row.publicKey === b.node.keys.publicKey && row.name === 'beta'));
  assert.ok(!found.endpoints.some(row => row.address.node === a.node.id), 'own node excluded');
});

await check('send → deliver (with sender key) → ack relayed once, only from the target connection', async () => {
  const message = envelope(addrA, addrB);
  ca.send({ action: 'send', envelope: message, sig: signEnvelope(a.node.keys.privateKey, message) });
  assert.equal((await ca.next('sendResult', frame => frame.id === message.id)).status, 'delivered');
  const delivered = await cb.next('deliver', frame => frame.envelope.id === message.id);
  assert.equal(delivered.envelope.text, SENTINEL);
  assert.equal(delivered.sender.publicKey, a.node.keys.publicKey);
  // A third node cannot forge the target's acknowledgement.
  const c = await enrollNode('gamma2'); const cc = await Client.open(c.node);
  cc.send({ action: 'ack', id: message.id, status: 'queued' });
  await ca.none('ack');
  ca.send({ action: 'ack', id: message.id, status: 'queued' });
  await ca.none('ack');
  cb.send({ action: 'ack', id: message.id, status: 'queued' });
  assert.equal((await ca.next('ack', frame => frame.id === message.id)).status, 'queued');
  cb.send({ action: 'ack', id: message.id, status: 'refused' });
  await ca.none('ack');
  cc.close();
});

await check('sender binding, signature, time, duplicate, self-routing and target checks', async () => {
  const cases: Array<[string, HubEnvelope, string, RegExp | 'offline']> = [];
  const forgedNode = envelope({ ...addrA, node: b.node.id }, addrB); cases.push(['claims another node', forgedNode, signEnvelope(a.node.keys.privateKey, forgedNode), /sender node/]);
  const unregistered = envelope({ ...addrA, endpoint: randomUUID() }, addrB); cases.push(['unregistered endpoint', unregistered, signEnvelope(a.node.keys.privateKey, unregistered), /not registered/]);
  const wrongSession = envelope({ ...addrA, session: 'other' }, addrB); cases.push(['session mismatch', wrongSession, signEnvelope(a.node.keys.privateKey, wrongSession), /not registered/]);
  const badSig = envelope(addrA, addrB); cases.push(['foreign signature', badSig, signEnvelope(b.node.keys.privateKey, badSig), /signature/]);
  const stale = envelope(addrA, addrB, 'x', Date.now() - 61_000); cases.push(['stale', stale, signEnvelope(a.node.keys.privateKey, stale), /60 s/]);
  const self = envelope(addrA, { ...addrA, endpoint: randomUUID() }); cases.push(['self node', self, signEnvelope(a.node.keys.privateKey, self), /itself/]);
  const wrongTarget = envelope(addrA, { ...addrB, project: 'github.com/x/y' }); cases.push(['target mismatch', wrongTarget, signEnvelope(a.node.keys.privateKey, wrongTarget), /target address/]);
  const offline = envelope(addrA, { ...addrB, endpoint: randomUUID() }); cases.push(['offline', offline, signEnvelope(a.node.keys.privateKey, offline), 'offline']);
  for (const [name, message, sig, expected] of cases) {
    ca.send({ action: 'send', envelope: message, sig });
    const result = await ca.next('sendResult', frame => frame.id === message.id);
    if (expected === 'offline') assert.equal(result.status, 'offline', name);
    else { assert.equal(result.status, 'rejected', name); assert.match(result.reason ?? '', expected, name); }
  }
  const once = envelope(addrA, addrB);
  const sig = signEnvelope(a.node.keys.privateKey, once);
  ca.send({ action: 'send', envelope: once, sig });
  assert.equal((await ca.next('sendResult', frame => frame.id === once.id)).status, 'delivered');
  ca.send({ action: 'send', envelope: once, sig });
  assert.match((await ca.next('sendResult', frame => frame.id === once.id)).reason ?? '', /duplicate/);
  await cb.next('deliver', frame => frame.envelope.id === once.id);
  await cb.none('deliver');
});

await check('endpoint ids cannot be taken over by another node', async () => {
  const rid = randomUUID();
  ca.send({ action: 'register', rid, endpoint: addrB.endpoint, project: addrB.project, session: addrB.session });
  assert.equal((await ca.next('registered', frame => frame.rid === rid)).ok, false);
});

await check('invalid frames get an error; frames over 16 KiB close with 1009', async () => {
  ca.send({ action: 'admin' });
  assert.equal((await ca.next('error')).reason, 'invalid frame');
  const big = await Client.open(b.node);
  big.ws.send('x'.repeat(16_385));
  for (let n = 0; n < 100 && big.closeCode === undefined; n++) await delay(20);
  assert.equal(big.closeCode, 1009);
});

await check(`rate limit: ${SENDS_PER_MINUTE} sends per minute per node`, async () => {
  const r = await enrollNode('rate'); const cr = await Client.open(r.node); const addrR = await register(cr, r.node);
  const ids: string[] = [];
  frozen = Date.now(); // one window for the whole burst
  for (let n = 0; n <= SENDS_PER_MINUTE; n++) {
    const message = envelope(addrR, addrB, `rate ${n}`, frozen);
    ids.push(message.id);
    cr.send({ action: 'send', envelope: message, sig: signEnvelope(r.node.keys.privateKey, message) });
  }
  const results = await Promise.all(ids.map(id => cr.next('sendResult', frame => frame.id === id, 10_000)));
  frozen = undefined;
  assert.equal(results.filter(result => result.status === 'delivered').length, SENDS_PER_MINUTE);
  assert.match(results.at(-1)!.reason ?? '', /rate limit/);
  cr.close();
  while (cb.frames.some(frame => frame.type === 'deliver')) cb.frames.splice(cb.frames.findIndex(frame => frame.type === 'deliver'), 1);
});

await check('enrollment is broadcast to live connections', async () => {
  const late = await enrollNode('announced');
  const notice = await ca.next('node-enrolled', frame => frame.node.node === late.node.id);
  assert.equal(notice.node.publicKey, late.node.keys.publicKey);
});

await check('stale connection rows (missed $disconnect): counted apart, reaped on connect after a grace, pruned on demand', async () => {
  const now = Date.now();
  const old = randomUUID(); const young = randomUUID(); const orphan = randomUUID();
  await hub.store.putConnection({ connectionId: old, node: a.node.id, connectedAt: now - 120_000, expiresAt: now + 3_600_000 });
  await hub.store.putEndpoint({ endpoint: orphan, connectionId: old, node: a.node.id, project: 'github.com/x/y', session: 'gone', expiresAt: now + 600_000 }, now);
  await hub.store.putConnection({ connectionId: young, node: a.node.id, connectedAt: now, expiresAt: now + 3_600_000 });
  const before = await connectionStatus(hub.ctx);
  assert.equal(before.find(c => c.connectionId === old)?.state, 'stale');
  assert.equal(before.find(c => c.connectionId === old)?.endpoints, 1);
  assert.equal(before.find(c => c.connectionId === young)?.state, 'stale');
  assert.ok(before.filter(c => c.node === a.node.id && c.state === 'live').length >= 1, 'the real connection is live');
  const extra = await Client.open(a.node); // $connect reaps this node's old stale row
  assert.equal(await hub.store.getConnection(old), undefined, 'old stale row reaped');
  assert.equal(await hub.store.getEndpoint(orphan), undefined, 'its endpoint removed with it');
  assert.ok(await hub.store.getConnection(young), 'a row inside the grace window is kept');
  const pruned = await connectionStatus(hub.ctx, true);
  assert.equal(await hub.store.getConnection(young), undefined, 'prune removes the young stale row');
  assert.ok(pruned.filter(c => c.state === 'live').every(c => hub.store.connections.has(c.connectionId)), 'prune never removes a live row');
  assert.ok((await connectionStatus(hub.ctx)).every(c => c.state === 'live'));
  extra.close();
});

await check('revoke: closes the node, broadcasts, refuses reconnect, target goes offline', async () => {
  const result = await hub.revokeNode(b.node.id);
  assert.deepEqual({ revoked: result.revoked, closed: result.closed >= 1 }, { revoked: true, closed: true });
  await ca.next('node-revoked', frame => frame.node === b.node.id);
  for (let n = 0; n < 100 && cb.closeCode === undefined; n++) await delay(20);
  assert.equal(cb.closeCode, 1008);
  await assert.rejects(Client.open(b.node), /refused/);
  const message = envelope(addrA, addrB);
  ca.send({ action: 'send', envelope: message, sig: signEnvelope(a.node.keys.privateKey, message) });
  assert.equal((await ca.next('sendResult', frame => frame.id === message.id)).status, 'offline');
  assert.equal((await hub.revokeNode(b.node.id)).revoked, false, 'second revoke is a no-op');
});

await check('logs never contain message text, tokens or signatures', async () => {
  const token = await hub.mintToken();
  await enrollNode('logged', token);
  const text = JSON.stringify(hub.logs);
  assert.ok(hub.logs.length > 20);
  assert.ok(!text.includes(SENTINEL), 'message text');
  assert.ok(!text.includes(token), 'token');
  assert.ok(!text.includes(a.node.keys.privateKey.slice(0, 40)) && !/[A-Za-z0-9_-]{86}/.test(text), 'keys or signatures');
});

await check('import boundary: the closure darwin compiles never imports the AWS SDK', async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = path.resolve(here, '../src');
  for (const file of ['handlers.ts', 'store.ts', 'store-memory.ts', 'gateway.ts', 'local-server.ts']) {
    const source = readFileSync(path.join(src, file), 'utf8');
    for (const [, specifier] of source.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(specifier!.startsWith('node:') || specifier!.startsWith('./') || specifier === '../../src/collaboration/hub-wire.js', `${file} imports ${specifier}`);
    }
  }
});

ca.close();
await hub.stop();
console.log(`verify-handlers: ${passed} checks passed`);
