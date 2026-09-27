/**
 * Hub behaviour (README §5–§8), shared verbatim by the Lambda entry points and the local server.
 * The hub is a relay and node directory: it never stores or logs message text, never decides
 * trust beyond "enrolled and active", and identifies senders only by connectionId → node.
 */
import {
  clientFrame, CLOCK_SKEW_MS, encodeFrame, enrollRequestSchema, fingerprint, MAX_DISCOVERY, parseConnectHeaders, parseFrame,
  tokenHash, verifyConnect, verifyEnvelope, type HubAddress, type HubEnvelope, type HubFrame, type NodeInfo,
} from '../../src/collaboration/hub-wire.js';
import type { Gateway } from './gateway.js';
import type { NodeRecord, Store } from './store.js';

export const CONNECTION_TTL_MS = 2 * 60 * 60_000;
export const ENDPOINT_TTL_MS = 10 * 60_000;
export const NONCE_TTL_MS = 5 * 60_000;
export const MESSAGE_CLAIM_TTL_MS = 2 * 60_000;
export const SENDS_PER_MINUTE = 60;
export const SENDS_PER_HOUR = 600;

/** Structured log fields only: ids, sizes, outcomes. Never text, envelopes, tokens or signatures. */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface HubContext {
  store: Store;
  gateway: Gateway;
  /** `<apiId>/<stage>`; connect assertions are bound to it. */
  audience: string;
  /** WebSocket URL returned to a freshly enrolled node. */
  wsUrl: string;
  now(): number;
  log(fields: LogFields): void;
}

const nodeInfo = (record: NodeRecord): NodeInfo => ({ node: record.node, name: record.name, publicKey: record.publicKey, fingerprint: record.fingerprint });
const sameAddress = (a: HubAddress, b: HubAddress): boolean => JSON.stringify(a) === JSON.stringify(b);

async function post(ctx: HubContext, connectionId: string, frame: HubFrame): Promise<'ok' | 'gone'> {
  try { return await ctx.gateway.post(connectionId, encodeFrame(frame)); }
  catch (error) { ctx.log({ event: 'post-failed', connectionId, error: error instanceof Error ? error.name : 'unknown' }); return 'gone'; }
}

async function broadcast(ctx: HubContext, frame: HubFrame, exceptNode?: string): Promise<number> {
  const now = ctx.now();
  let sent = 0;
  for (const connection of await ctx.store.listConnections()) {
    if (connection.expiresAt <= now || connection.node === exceptNode) continue;
    if (await post(ctx, connection.connectionId, frame) === 'ok') sent++;
    else await disconnect(ctx, connection.connectionId);
  }
  return sent;
}

// ---------------------------------------------------------------------------
// $connect

/** Authorizer: parse → active node → signature over audience → single-use nonce. */
export async function authorize(ctx: HubContext, headers: Record<string, string | undefined> | undefined): Promise<{ allow: true; node: string } | { allow: false; reason: string }> {
  const assertion = parseConnectHeaders(headers);
  if (!assertion) return deny(ctx, 'malformed-assertion');
  const record = await ctx.store.getNode(assertion.node);
  if (!record || record.status !== 'active') return deny(ctx, 'unknown-or-revoked', assertion.node);
  const now = ctx.now();
  if (!verifyConnect(record.publicKey, ctx.audience, assertion, now)) return deny(ctx, 'bad-signature-or-skew', assertion.node);
  // Signature first: unauthenticated callers cannot fill the replay table.
  if (!await ctx.store.claim(`nonce#${assertion.node}#${assertion.nonce}`, now + NONCE_TTL_MS, now)) return deny(ctx, 'replayed-nonce', assertion.node);
  ctx.log({ event: 'authorize', outcome: 'allow', node: assertion.node });
  return { allow: true, node: assertion.node };
}

function deny(ctx: HubContext, reason: string, node?: string): { allow: false; reason: string } {
  ctx.log({ event: 'authorize', outcome: 'deny', reason, node });
  return { allow: false, reason };
}

export async function connect(ctx: HubContext, connectionId: string, node: string): Promise<void> {
  const now = ctx.now();
  await ctx.store.putConnection({ connectionId, node, connectedAt: now, expiresAt: now + CONNECTION_TTL_MS });
  ctx.log({ event: 'connect', connectionId, node });
}

export async function disconnect(ctx: HubContext, connectionId: string): Promise<void> {
  await ctx.store.deleteConnection(connectionId);
  for (const endpoint of await ctx.store.listEndpoints(1024)) {
    if (endpoint.connectionId === connectionId) await ctx.store.deleteEndpoint(endpoint.endpoint, connectionId);
  }
  ctx.log({ event: 'disconnect', connectionId });
}

// ---------------------------------------------------------------------------
// Messages on an established connection

export async function message(ctx: HubContext, connectionId: string, body: string): Promise<void> {
  const bytes = Buffer.byteLength(body);
  const frame = parseFrame(clientFrame, body);
  if (!frame) { ctx.log({ event: 'frame', outcome: 'invalid', connectionId, bytes }); await post(ctx, connectionId, { type: 'error', reason: 'invalid frame' }); return; }
  if (frame.action === 'ping') return;
  const now = ctx.now();
  const connection = await ctx.store.getConnection(connectionId);
  const sender = connection && connection.expiresAt > now ? await ctx.store.getNode(connection.node) : undefined;
  if (!connection || !sender || sender.status !== 'active') {
    ctx.log({ event: frame.action, outcome: 'unauthenticated', connectionId });
    await post(ctx, connectionId, { type: 'error', reason: 'connection not authenticated or node revoked' });
    await ctx.gateway.close(connectionId);
    return;
  }
  switch (frame.action) {
    case 'register': {
      const ok = await ctx.store.putEndpoint({ endpoint: frame.endpoint, connectionId, node: sender.node, project: frame.project, session: frame.session, expiresAt: now + ENDPOINT_TTL_MS }, now);
      ctx.log({ event: 'register', outcome: ok ? 'ok' : 'conflict', connectionId, node: sender.node, endpoint: frame.endpoint });
      await post(ctx, connectionId, { type: 'registered', rid: frame.rid, endpoint: frame.endpoint, ok, ...(ok ? {} : { reason: 'endpoint id belongs to another node' }) });
      return;
    }
    case 'unregister':
      await ctx.store.deleteEndpoint(frame.endpoint, connectionId);
      ctx.log({ event: 'unregister', connectionId, endpoint: frame.endpoint });
      return;
    case 'discover':
      await post(ctx, connectionId, await discover(ctx, sender.node, frame.rid));
      return;
    case 'send':
      await post(ctx, connectionId, await relay(ctx, connectionId, sender, frame.envelope, frame.sig, bytes));
      return;
    case 'ack': {
      const senderConnection = await ctx.store.acknowledge(`msg#${frame.id}`, connectionId, now);
      ctx.log({ event: 'ack', outcome: senderConnection ? 'relayed' : 'refused', connectionId, id: frame.id });
      if (senderConnection) await post(ctx, senderConnection, { type: 'ack', id: frame.id, status: frame.status, ...(frame.reason === undefined ? {} : { reason: frame.reason }) });
      return;
    }
  }
}

async function discover(ctx: HubContext, callerNode: string, rid: string): Promise<HubFrame> {
  const now = ctx.now();
  const nodes = new Map<string, NodeRecord | undefined>();
  const rows: Extract<HubFrame, { type: 'discovered' }>['endpoints'] = [];
  let omitted = 0;
  for (const endpoint of await ctx.store.listEndpoints(1024)) {
    // The hub never routes a node to itself: same-machine peers use the local transport and its rules.
    if (endpoint.node === callerNode || endpoint.expiresAt <= now) continue;
    if (!nodes.has(endpoint.node)) nodes.set(endpoint.node, await ctx.store.getNode(endpoint.node));
    const owner = nodes.get(endpoint.node);
    if (!owner || owner.status !== 'active') continue;
    if (rows.length >= MAX_DISCOVERY) { omitted++; continue; }
    rows.push({ address: { version: 2, transport: 'hub', node: endpoint.node, endpoint: endpoint.endpoint, project: endpoint.project, session: endpoint.session }, name: owner.name, publicKey: owner.publicKey, fingerprint: owner.fingerprint });
  }
  rows.sort((a, b) => a.address.endpoint.localeCompare(b.address.endpoint));
  ctx.log({ event: 'discover', node: callerNode, returned: rows.length, omitted });
  return { type: 'discovered', rid, endpoints: rows, omitted };
}

async function relay(ctx: HubContext, connectionId: string, sender: NodeRecord, envelope: HubEnvelope, sig: string, bytes: number): Promise<HubFrame> {
  const now = ctx.now();
  const id = envelope.id;
  const reject = (reason: string): HubFrame => { ctx.log({ event: 'send', outcome: 'rejected', reason, connectionId, id, bytes }); return { type: 'sendResult', id, status: 'rejected', reason }; };
  // The claimed sender must be exactly this connection's node and one of its registered endpoints.
  if (envelope.sender.node !== sender.node) return reject('sender node does not match connection');
  const own = await ctx.store.getEndpoint(envelope.sender.endpoint);
  if (!own || own.connectionId !== connectionId || own.expiresAt <= now
    || !sameAddress({ version: 2, transport: 'hub', node: own.node, endpoint: own.endpoint, project: own.project, session: own.session }, envelope.sender)) return reject('sender endpoint not registered on this connection');
  if (!verifyEnvelope(sender.publicKey, envelope, sig)) return reject('signature does not verify');
  if (Math.abs(now - envelope.sent) > CLOCK_SKEW_MS) return reject('envelope time outside the 60 s window');
  if (!await ctx.store.countWindow(`rate#${sender.node}#m#${Math.floor(now / 60_000)}`, SENDS_PER_MINUTE, now + 120_000)
    || !await ctx.store.countWindow(`rate#${sender.node}#h#${Math.floor(now / 3_600_000)}`, SENDS_PER_HOUR, now + 7_200_000)) return reject('rate limit (60/min, 600/hour per node)');
  if (envelope.target.node === sender.node) return reject('the hub never routes a node to itself; use local collaboration');
  const target = await ctx.store.getEndpoint(envelope.target.endpoint);
  const targetNode = target ? await ctx.store.getNode(target.node) : undefined;
  if (!target || target.expiresAt <= now || !targetNode || targetNode.status !== 'active') {
    ctx.log({ event: 'send', outcome: 'offline', connectionId, id, bytes });
    return { type: 'sendResult', id, status: 'offline', reason: 'target endpoint is not connected' };
  }
  if (!sameAddress({ version: 2, transport: 'hub', node: target.node, endpoint: target.endpoint, project: target.project, session: target.session }, envelope.target)) return reject('target address does not match its registration');
  if (!await ctx.store.claim(`msg#${id}`, now + MESSAGE_CLAIM_TTL_MS, now, { senderConnection: connectionId, targetConnection: target.connectionId })) return reject('duplicate message id');
  if (await post(ctx, target.connectionId, { type: 'deliver', envelope, sig, sender: nodeInfo(sender) }) === 'gone') {
    await ctx.store.deleteEndpoint(target.endpoint, target.connectionId);
    ctx.log({ event: 'send', outcome: 'offline', reason: 'gone', connectionId, id, bytes });
    return { type: 'sendResult', id, status: 'offline', reason: 'target connection is gone' };
  }
  ctx.log({ event: 'send', outcome: 'delivered', connectionId, id, bytes, from: sender.node, to: target.node });
  return { type: 'sendResult', id, status: 'delivered' };
}

// ---------------------------------------------------------------------------
// HTTP: enrollment and time

export interface HttpResult { status: number; body: string }
const REFUSED: HttpResult = { status: 403, body: JSON.stringify({ ok: false, reason: 'enrollment refused' }) };

/** One uniform refusal for every failure: no oracle for token, id or key problems. */
export async function enroll(ctx: HubContext, body: string): Promise<HttpResult> {
  const request = parseFrame(enrollRequestSchema, body);
  if (!request) { ctx.log({ event: 'enroll', outcome: 'refused', reason: 'malformed' }); return REFUSED; }
  const now = ctx.now();
  const record: NodeRecord = { node: request.node, name: request.name, publicKey: request.publicKey, fingerprint: fingerprint(request.publicKey), status: 'active', enrolledAt: now };
  if (!await ctx.store.redeemToken(tokenHash(request.token), now, record)) { ctx.log({ event: 'enroll', outcome: 'refused', reason: 'token-or-node' }); return REFUSED; }
  ctx.log({ event: 'enroll', outcome: 'ok', node: record.node });
  await broadcast(ctx, { type: 'node-enrolled', node: nodeInfo(record), enrolledAt: now }, record.node);
  return { status: 200, body: JSON.stringify({ ok: true, node: record.node, fingerprint: record.fingerprint, wsUrl: ctx.wsUrl, audience: ctx.audience }) };
}

export function time(ctx: HubContext): HttpResult {
  return { status: 200, body: JSON.stringify({ now: ctx.now() }) };
}

// ---------------------------------------------------------------------------
// Operator actions (deployer's credentials; never reachable from a client frame)

export async function mint(ctx: HubContext, token: string, ttlMs: number, note: string): Promise<void> {
  await ctx.store.putToken(tokenHash(token), ctx.now() + ttlMs, note.slice(0, 128));
  ctx.log({ event: 'mint' });
}

export async function revoke(ctx: HubContext, node: string): Promise<{ revoked: boolean; closed: number; notified: number }> {
  const revoked = await ctx.store.revokeNode(node, ctx.now());
  let closed = 0;
  for (const connection of await ctx.store.listConnections()) {
    if (connection.node !== node) continue;
    await ctx.gateway.close(connection.connectionId);
    await disconnect(ctx, connection.connectionId);
    closed++;
  }
  for (const endpoint of await ctx.store.listEndpoints(1024)) if (endpoint.node === node) await ctx.store.deleteEndpoint(endpoint.endpoint);
  const notified = revoked ? await broadcast(ctx, { type: 'node-revoked', node }) : 0;
  ctx.log({ event: 'revoke', node, revoked, closed, notified });
  return { revoked, closed, notified };
}
