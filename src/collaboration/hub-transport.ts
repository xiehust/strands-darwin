/**
 * Collaboration hub transport (hub/README.md §6–§9). Owned by one LocalCollaboration: it shares
 * that session's inbox, dedupe, causal ledger and caps. Authorization on this transport is
 * "enrolled, active, not blocked, key matches the pin" — no per-pair confirmation, by decision.
 * Unattended code, bounded: backoff capped at 60 s, three consecutive refusals from a reachable
 * hub pause reconnects until a user command, ambiguous sends are reported and never replayed.
 */
import { randomUUID } from 'node:crypto';
import {
  connectHeaders, encodeFrame, fingerprint, hubFrame, parseFrame, shortFingerprint, signEnvelope, timeResponseSchema, verifyEnvelope,
  type DiscoverRow, type HubAddress, type HubEnvelope, type HubFrame, type PeerChain,
} from './hub-wire.js';
import { queuedText } from './protocol.js';
import { isBlocked, pinNode, pinnedKey, readHubNode, remoteIdentity, type HubNode } from './hub-store.js';

export const HEARTBEAT_MS = 4 * 60_000;
export const ROTATE_MS = 110 * 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_REFUSALS = 3;
/** ~25 minutes of capped backoff against an unreachable hub, then pause with a notice. */
export const MAX_UNREACHABLE_ATTEMPTS = 30;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000];

export interface HubHooks {
  /** Shared admission (freshness, dedupe, chain, caps); returns the local queue result text. */
  admit(envelope: HubEnvelope): Promise<string> | string;
  /** Drop queued input from a revoked or blocked node. */
  drop(node: string, reason: string): void;
  notice(text: string): void;
}

export type HubState = 'off' | 'not-enrolled' | 'unpublished' | 'unavailable' | 'connecting' | 'connected' | 'paused' | 'closed';

interface Pending<T> { resolve(value: T): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface Socket { ws: WebSocket; opened: boolean; ended: boolean }

/**
 * Idempotent end-of-socket: Node 22's undici fires only `error` (no `close`, readyState stays
 * CONNECTING) when the upgrade is refused, so both events must end the socket exactly once.
 */
function onEnd(socket: Socket, run: () => void): void {
  const end = () => { if (socket.ended) return; socket.ended = true; run(); };
  socket.ws.addEventListener('error', end);
  socket.ws.addEventListener('close', end);
}

export class HubTransport {
  private node: HubNode | undefined;
  private own: HubAddress | undefined;
  private socket: Socket | undefined;
  private rotating: Socket | undefined;
  private attempt = 0;
  private refusals = 0;
  private timers = new Set<NodeJS.Timeout>();
  private rows = new Map<string, DiscoverRow>();
  private revoked = new Set<string>();
  private requests = new Map<string, Pending<HubFrame>>();
  private stopped = true;
  state: HubState = 'off';
  reason = '';
  /** Changes on every start; validates queued input against this incarnation. */
  generation = randomUUID();

  constructor(private readonly hooks: HubHooks, private readonly session: string) {}

  get address(): HubAddress | undefined { return this.own; }
  get identity(): HubNode | undefined { return this.node; }
  /** Test hook: run the two-hour rotation now (open successor, re-register, close old). */
  rotateNow(): void { if (this.socket?.opened) this.rotate(this.socket); }

  /** Guarded like local startup: any problem disables only the hub transport, with one notice. */
  start(canonicalRoot: string, published: boolean): void {
    this.close();
    this.stopped = false; this.generation = randomUUID(); this.refusals = 0; this.attempt = 0;
    try { this.node = readHubNode(); }
    catch (error) { this.disable('unavailable', `hub identity unreadable: ${error instanceof Error ? error.message : 'invalid'}`); return; }
    if (!this.node) { this.state = 'not-enrolled'; this.stopped = true; return; }
    if (!published) { this.state = 'unpublished'; this.stopped = true; return; }
    if (typeof WebSocket !== 'function') { this.disable('unavailable', 'this Node has no global WebSocket; hub transport disabled'); return; }
    const identity = remoteIdentity(canonicalRoot);
    if ('problem' in identity) { this.disable('unavailable', `hub off for this project: ${identity.problem}. Only projects with a network git origin publish to the hub.`); return; }
    this.own = { version: 2, transport: 'hub', node: this.node.node, endpoint: randomUUID(), project: identity.project, session: this.session };
    this.connect();
  }

  private disable(state: HubState, reason: string): void {
    this.state = state; this.reason = reason; this.stopped = true;
    this.hooks.notice(`hub: ${reason}`);
  }

  close(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const [id, pending] of this.requests) { clearTimeout(pending.timer); pending.reject(new Error('hub transport closed')); this.requests.delete(id); }
    for (const socket of [this.socket, this.rotating]) {
      if (!socket) continue;
      try { if (socket.opened && this.own) socket.ws.send(JSON.stringify({ action: 'unregister', endpoint: this.own.endpoint })); } catch { /* closing */ }
      try { socket.ws.close(); } catch { /* closed */ }
    }
    this.socket = undefined; this.rotating = undefined;
    this.rows.clear();
    if (this.state === 'connected' || this.state === 'connecting' || this.state === 'paused') this.state = 'closed';
    this.own = undefined;
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); run(); }, ms);
    timer.unref();
    this.timers.add(timer);
  }

  private open(): Socket {
    const node = this.node!;
    // undici's non-standard `headers` option reaches the upgrade request (verified on Node 22.19).
    const ws = new WebSocket(node.wsUrl, { headers: connectHeaders(node.audience, node.node, node.privateKey) } as unknown as string[]);
    const socket: Socket = { ws, opened: false, ended: false };
    ws.addEventListener('message', event => { void this.frame(socket, String(event.data)); });
    return socket;
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    const socket = this.open();
    this.socket = socket;
    socket.ws.addEventListener('open', () => {
      if (this.socket !== socket || this.stopped) { socket.ws.close(); return; }
      socket.opened = true; this.attempt = 0; this.refusals = 0;
      this.state = 'connected'; this.reason = '';
      void this.register(socket);
      this.heartbeat(socket);
      this.later(ROTATE_MS, () => this.rotate(socket));
    });
    onEnd(socket, () => { if (this.socket === socket) void this.lost(socket); });
  }

  private heartbeat(socket: Socket): void {
    this.later(HEARTBEAT_MS, () => {
      if (this.stopped || (this.socket !== socket && this.rotating !== socket)) return;
      void this.register(socket);
      this.heartbeat(socket);
    });
  }

  /** API Gateway caps a connection at two hours: open the successor first, then close the old one. */
  private rotate(old: Socket): void {
    if (this.stopped || this.socket !== old) return;
    const next = this.open();
    this.rotating = next;
    next.ws.addEventListener('open', () => {
      if (this.stopped || this.rotating !== next) { next.ws.close(); return; }
      next.opened = true; this.socket = next; this.rotating = undefined;
      void this.register(next).then(() => { try { old.ws.close(); } catch { /* gone */ } });
      this.heartbeat(next);
      this.later(ROTATE_MS, () => this.rotate(next));
    });
    onEnd(next, () => {
      if (this.rotating === next) this.rotating = undefined; // keep the old one; its own end reconnects
      else if (this.socket === next) void this.lost(next);
    });
  }

  private async register(socket: Socket): Promise<void> {
    if (!this.own) return;
    const rid = randomUUID();
    try {
      const reply = await this.request(socket, rid, { action: 'register', rid, endpoint: this.own.endpoint, project: this.own.project, session: this.own.session });
      if (reply.type === 'registered' && !reply.ok) this.hooks.notice(`hub: endpoint registration refused: ${reply.reason ?? 'unknown'}`);
    } catch { /* the next heartbeat or reconnect registers again */ }
  }

  private async lost(socket: Socket): Promise<void> {
    if (this.stopped) return;
    this.socket = undefined;
    for (const [id, pending] of this.requests) { clearTimeout(pending.timer); pending.reject(new Error('hub connection lost')); this.requests.delete(id); }
    if (!socket.opened) {
      // Never opened: refused by the authorizer, or the hub is unreachable. Ask the hub's clock.
      const skew = await this.skew();
      if (skew !== undefined && ++this.refusals >= MAX_REFUSALS) {
        const reason = Math.abs(skew) > 50_000
          ? `hub refused ${MAX_REFUSALS} connections; this clock is ${Math.round(skew / 1000)} s off the hub's. Fix the clock, then /collaborate on.`
          : `hub refused ${MAX_REFUSALS} connections; this node may be revoked. User: darwin collaborate hub status. Reconnects paused until /collaborate on.`;
        this.state = 'paused'; this.reason = reason; this.stopped = true;
        this.hooks.notice(`hub: ${reason}`);
        return;
      }
    }
    this.state = 'connecting';
    if (this.attempt >= MAX_UNREACHABLE_ATTEMPTS) {
      const reason = `hub unreachable after ${MAX_UNREACHABLE_ATTEMPTS} attempts; reconnects paused until /collaborate on`;
      this.state = 'paused'; this.reason = reason; this.stopped = true;
      this.hooks.notice(`hub: ${reason}`);
      return;
    }
    const base = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
    this.later(Math.round(base * (0.8 + Math.random() * 0.4)), () => this.connect());
  }

  /** Server minus local clock in ms, or undefined when the hub's HTTP API is unreachable. */
  private async skew(): Promise<number | undefined> {
    try {
      const started = Date.now();
      const response = await fetch(new URL('/time', this.node!.hubUrl), { signal: AbortSignal.timeout(5000) });
      const parsed = timeResponseSchema.safeParse(await response.json());
      return parsed.success ? parsed.data.now - (started + Date.now()) / 2 : undefined;
    } catch { return undefined; }
  }

  private request(socket: Socket, key: string, frame: unknown): Promise<HubFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.requests.delete(key); reject(new Error('hub request timed out')); }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.requests.set(key, { resolve, reject, timer });
      try { socket.ws.send(encodeFrame(frame)); }
      catch (error) { clearTimeout(timer); this.requests.delete(key); reject(error instanceof Error ? error : new Error('hub send failed')); }
    });
  }

  private settle(key: string, frame: HubFrame): void {
    const pending = this.requests.get(key);
    if (!pending) return;
    clearTimeout(pending.timer); this.requests.delete(key); pending.resolve(frame);
  }

  private abandon(key: string): void {
    const pending = this.requests.get(key);
    if (!pending) return;
    clearTimeout(pending.timer); this.requests.delete(key); pending.reject(new Error('abandoned'));
  }

  private async frame(socket: Socket, raw: string): Promise<void> {
    const frame = parseFrame(hubFrame, raw);
    if (!frame) return;
    switch (frame.type) {
      case 'registered': this.settle(frame.rid, frame); return;
      case 'discovered': this.settle(frame.rid, frame); return;
      case 'sendResult': this.settle(`send:${frame.id}`, frame); return;
      case 'ack': this.settle(`ack:${frame.id}`, frame); return;
      case 'deliver': await this.receive(socket, frame); return;
      case 'node-enrolled':
        this.hooks.notice(`hub: node enrolled · ${frame.node.name} ${frame.node.node} fingerprint ${shortFingerprint(frame.node.fingerprint)}. Enrolled nodes collaborate without confirmation; if unexpected: darwin collaborate hub block ${frame.node.node}`);
        return;
      case 'node-revoked':
        this.revoked.add(frame.node);
        for (const [endpoint, row] of this.rows) if (row.address.node === frame.node) this.rows.delete(endpoint);
        this.hooks.drop(frame.node, 'node revoked at the hub');
        this.hooks.notice(`hub: node revoked · ${frame.node}; its queued messages were dropped`);
        return;
      case 'endpoint-gone': this.rows.delete(frame.endpoint); return;
      case 'error': return;
    }
  }

  private async receive(socket: Socket, frame: Extract<HubFrame, { type: 'deliver' }>): Promise<void> {
    const { envelope, sig, sender } = frame;
    // The hub accepts an ack only from the connection it delivered to.
    const reply = (status: 'queued' | 'refused', reason?: string) => {
      try { socket.ws.send(encodeFrame({ action: 'ack', id: envelope.id, status, ...(reason ? { reason: reason.slice(0, 512) } : {}) })); } catch { /* sender sees an ambiguous result */ }
    };
    const own = this.own;
    if (this.stopped || !own || JSON.stringify(envelope.target) !== JSON.stringify(own)) { reply('refused', 'not addressed to this live endpoint'); return; }
    if (sender.node !== envelope.sender.node || fingerprint(sender.publicKey) !== sender.fingerprint) { reply('refused', 'sender identity mismatch'); return; }
    if (this.revoked.has(sender.node) || isBlocked(sender.node)) { reply('refused', 'sender blocked on this node'); return; }
    const pin = await pinNode(sender.node, sender.name, sender.publicKey, sender.fingerprint);
    if (pin === 'mismatch') { this.hooks.notice(`hub: refused a message from ${sender.node}: its key differs from the pinned key (re-keying is never accepted; operator revoke + re-enroll issues a new node id)`); reply('refused', 'key does not match the pinned key'); return; }
    if (pin === 'full') { reply('refused', 'pin capacity reached on this node'); return; }
    if (!verifyEnvelope(sender.publicKey, envelope, sig)) { reply('refused', 'signature does not verify'); return; }
    const result = await this.hooks.admit(envelope);
    // A verified sender is a known reply target, as if discovered (bounded).
    if (result.startsWith('Queued') && (this.rows.has(envelope.sender.endpoint) || this.rows.size < 64)) {
      this.rows.set(envelope.sender.endpoint, { address: envelope.sender, name: sender.name, publicKey: sender.publicKey, fingerprint: sender.fingerprint });
    }
    reply(result.startsWith('Queued') ? 'queued' : 'refused', result.startsWith('Queued') ? undefined : result);
  }

  // -------------------------------------------------------------------------
  // Model-facing operations (through LocalCollaboration's gated tools)

  async discover(): Promise<{ state: HubState; reason?: string; endpoints: Array<{ address: HubAddress; name: string; fingerprint: string }>; omitted: number }> {
    const socket = this.socket;
    const base = { state: this.state, ...(this.reason ? { reason: this.reason } : {}) };
    if (!socket?.opened) return { ...base, endpoints: [], omitted: 0 };
    const rid = randomUUID();
    const reply = await this.request(socket, rid, { action: 'discover', rid }).catch(() => undefined);
    if (reply?.type !== 'discovered') return { ...base, reason: 'hub discovery timed out', endpoints: [], omitted: 0 };
    let omitted = reply.omitted;
    const endpoints: Array<{ address: HubAddress; name: string; fingerprint: string }> = [];
    this.rows.clear();
    for (const row of reply.endpoints) {
      if (this.revoked.has(row.address.node) || isBlocked(row.address.node) || fingerprint(row.publicKey) !== row.fingerprint) { omitted++; continue; }
      const pin = await pinNode(row.address.node, row.name, row.publicKey, row.fingerprint);
      if (pin === 'mismatch' || pin === 'full') { omitted++; continue; }
      this.rows.set(row.address.endpoint, row);
      endpoints.push({ address: row.address, name: row.name, fingerprint: shortFingerprint(row.fingerprint) });
    }
    return { ...base, endpoints, omitted };
  }

  knows(endpoint: string): boolean { return this.rows.has(endpoint); }

  /** Synchronous checks and signing; throws before the caller reserves outgoing budget. */
  prepare(target: string, chain: PeerChain, text: string): { socket: Socket; target: string; envelope: HubEnvelope; value: unknown } {
    const socket = this.socket; const own = this.own; const node = this.node;
    const row = this.rows.get(target);
    if (!socket?.opened || !own || !node || this.stopped) throw new Error(`Hub transport ${this.state}${this.reason ? `: ${this.reason}` : ''}`);
    if (!row) throw new Error('Unknown hub endpoint; run peer_discover first');
    if (this.revoked.has(row.address.node) || isBlocked(row.address.node)) throw new Error('Target node is blocked or revoked on this node');
    if (pinnedKey(row.address.node) !== row.publicKey) throw new Error('Target key does not match the pinned key; refused');
    const envelope: HubEnvelope = { version: 2, id: randomUUID(), sender: own, target: row.address, sent: Date.now(), chain, text };
    const value = { action: 'send', envelope, sig: signEnvelope(node.privateKey, envelope) };
    encodeFrame(value); // over-16-KiB frames are refused here
    return { socket, target, envelope, value };
  }

  async transmit({ socket, target, envelope, value }: ReturnType<HubTransport['prepare']>): Promise<string> {
    const ambiguous = `Peer send ${envelope.id} via hub: acknowledgement unavailable; delivery may have queued. Do not replay automatically. Inspect the receiving session before a human retries.`;
    // Register for the ack before sending: a fast target may answer before sendResult arrives.
    const ack = new Promise<HubFrame | undefined>(resolve => {
      const timer = setTimeout(() => { this.requests.delete(`ack:${envelope.id}`); resolve(undefined); }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.requests.set(`ack:${envelope.id}`, { resolve, reject: () => resolve(undefined), timer });
    });
    let result: HubFrame;
    try { result = await this.request(socket, `send:${envelope.id}`, value); }
    catch { this.abandon(`ack:${envelope.id}`); throw new Error(ambiguous); }
    if (result.type !== 'sendResult' || result.status !== 'delivered') {
      this.abandon(`ack:${envelope.id}`);
      if (result.type === 'sendResult' && result.status === 'offline') { this.rows.delete(target); return `Not queued: hub target offline (${result.reason ?? 'not connected'}). Run peer_discover again.`; }
      return `Not queued: hub rejected the message (${result.type === 'sendResult' ? result.reason ?? 'rejected' : 'unexpected reply'}).`;
    }
    const answer = await ack;
    if (answer?.type !== 'ack') throw new Error(ambiguous);
    if (answer.status === 'queued') return queuedText(envelope.id, ' via hub');
    return answer.reason ?? 'Not queued by the target';
  }

  /** Delivery re-check (admission, dequeue, pre-invoke): same incarnation, sender still admissible. */
  deliverable(envelope: HubEnvelope, authorization: string): boolean {
    return !this.stopped && authorization === `hub:${this.generation}` && this.own !== undefined
      && JSON.stringify(envelope.target) === JSON.stringify(this.own)
      && !this.revoked.has(envelope.sender.node) && !isBlocked(envelope.sender.node)
      && pinnedKey(envelope.sender.node) !== undefined;
  }
}
