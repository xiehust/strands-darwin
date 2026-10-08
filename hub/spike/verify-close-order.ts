/** Real local hub regression: coalesced unregister + close must drain in wire order.
 * Free: authenticated raw WebSocket over loopback, no model or AWS.
 * Run: pnpm tsx hub/spike/verify-close-order.ts
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { connectHeaders, generateNodeKeys } from '../../src/collaboration/hub-wire.js';
import { LocalHub } from '../src/local-server.js';

/** Client frames are masked; the two final frames go in ONE write, not timed sends. */
function frame(opcode: number, text = ''): Buffer {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 65_536);
  const mask = randomBytes(4);
  const header = payload.length < 126 ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : Buffer.from([0x80 | opcode, 0xfe, payload.length >> 8, payload.length & 0xff]);
  for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
  return Buffer.concat([header, mask, payload]);
}
async function waitFor(test: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!test()) { assert.ok(Date.now() < deadline, 'local hub operation timed out'); await delay(10); }
}
function open(hub: LocalHub, headers: ReturnType<typeof connectHeaders>): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${hub.httpUrl}/v1`, { headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers,
    } });
    request.on('upgrade', (response, socket) => {
      assert.equal(response.statusCode, 101);
      socket.on('error', reject);
      socket.resume();
      resolve(socket);
    });
    request.on('response', response => { response.resume(); reject(new Error(`upgrade refused: ${response.statusCode}`)); });
    request.on('error', reject);
    request.setTimeout(3000, () => request.destroy(new Error('upgrade timeout')));
    request.end();
  });
}

const hub = await new LocalHub().start();
let socket: Duplex | undefined;
try {
  const keys = generateNodeKeys();
  const node = randomUUID();
  const response = await fetch(`${hub.httpUrl}/enroll`, { method: 'POST', body: JSON.stringify({
    token: await hub.mintToken(), node, name: 'close-order', publicKey: keys.publicKey,
  }) });
  assert.equal(response.status, 200);
  await response.text();
  socket = await open(hub, connectHeaders(hub.audience, node, keys.privateKey));
  const endpoint = randomUUID();
  socket.write(frame(1, JSON.stringify({ action: 'register', rid: randomUUID(), endpoint,
    project: 'github.com/acme/close-order', session: 'close-order' })));
  await waitFor(() => hub.store.endpoints.has(endpoint));
  socket.write(Buffer.concat([frame(1, JSON.stringify({ action: 'unregister', endpoint })), frame(8)]));
  await waitFor(() => hub.logs.some(entry => entry['event'] === 'disconnect'));
  assert.ok(hub.logs.some(entry => entry['event'] === 'unregister' && entry['endpoint'] === endpoint),
    `removed by the explicit unregister, not left to $disconnect: ${JSON.stringify(hub.logs)}`);
  assert.ok(!hub.store.endpoints.has(endpoint));
  assert.equal(hub.store.connections.size, 0);
  const unregister = hub.logs.findIndex(entry => entry['event'] === 'unregister');
  const disconnect = hub.logs.findIndex(entry => entry['event'] === 'disconnect');
  assert.ok(unregister < disconnect, 'accepted frames drain before disconnect');
  assert.equal(hub.logs.filter(entry => entry['event'] === 'disconnect').length, 1);
  console.log('ok coalesced unregister + close: explicit unregister before exactly one disconnect');
} finally {
  socket?.destroy();
  await hub.stop();
}
