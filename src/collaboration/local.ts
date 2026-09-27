import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, opendirSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { collaborationDir } from '../paths.js';
import { authorization, canonicalProject, checkStore, idSchema, readPolicy, readPrivate, requestCooperation, withPolicy, writePrivate } from './storage.js';
import { addressSchema, authentic, CHAIN_TTL_MS, IO_TIMEOUT_MS, localEnvelopeSchema, MAX_FRAME_BYTES, MAX_HOPS, MAX_QUEUE, MESSAGE_TTL_MS, sign, type LocalEnvelope, type PeerAddress, type PeerChain, type PeerEnvelope, type PeerInput, type PeerTransport } from './protocol.js';
import { isPublished } from './hub-store.js';
import { HubTransport } from './hub-transport.js';
import type { HubEnvelope } from './hub-wire.js';

const registrationSchema = z.object({ address: addressSchema, pid: z.number().int().positive(), secret: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Registration = z.infer<typeof registrationSchema>;
const wireSchema = z.object({ body: z.unknown(), mac: z.string() }).strict();
const probeSchema = z.object({ kind: z.literal('probe'), target: idSchema, nonce: idSchema }).strict();
const messageSchema = z.object({ kind: z.literal('message'), envelope: localEnvelopeSchema }).strict();
const responseSchema = z.object({ nonce: idSchema, result: z.string().max(4096) }).strict();
const sameAddress = (a: PeerAddress, b: PeerAddress): boolean => JSON.stringify(a) === JSON.stringify(b);

export function socketPath(id: string): string {
  idSchema.parse(id);
  const file = path.join(collaborationDir(), `${id}.sock`);
  // sockaddr_un portability: leave room for NUL on supported POSIX systems.
  if (Buffer.byteLength(file) > 103) throw new Error('Collaboration socket path exceeds 103 bytes; use a shorter HOME (no TCP fallback)');
  return file;
}

function registration(id: string): Registration {
  idSchema.parse(id);
  const record = registrationSchema.parse(readPrivate(`${id}.json`));
  if (record.address.endpoint !== id || record.address.node !== readPolicy().node
    || canonicalProject(record.address.project) !== record.address.project) throw new Error('Endpoint identity mismatch');
  const info = lstatSync(socketPath(id));
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error('Unsafe endpoint socket');
  // PID is diagnostic only. A signed live challenge, not signal 0, proves identity.
  return record;
}

function readFrame(socket: net.Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('Collaboration frame timeout')), IO_TIMEOUT_MS);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer); socket.off('data', data); socket.off('error', fail); socket.off('end', end); socket.off('close', end);
      if (error) { socket.destroy(); reject(error); } else resolve(value);
    };
    const fail = (error: Error) => finish(error);
    const end = () => finish(new Error('Partial collaboration frame'));
    const data = (chunk: Buffer) => {
      if (bytes.length + chunk.length > MAX_FRAME_BYTES) { finish(new Error('Collaboration frame too large')); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== bytes.length - 1) { finish(new Error('Only one collaboration frame per connection')); return; }
      try { finish(undefined, JSON.parse(bytes.subarray(0, newline).toString('utf8'))); }
      catch { finish(new Error('Malformed collaboration JSON')); }
    };
    socket.on('data', data); socket.once('error', fail); socket.once('end', end); socket.once('close', end);
  });
}

async function exchange(record: Registration, body: unknown, secret: string, nonce: string): Promise<string> {
  const socket = net.createConnection(socketPath(record.address.endpoint));
  socket.on('error', () => {});
  const response = readFrame(socket);
  socket.once('connect', () => socket.write(JSON.stringify({ body, mac: sign(secret, body) }) + '\n'));
  try {
    const wire = wireSchema.parse(await response);
    const parsed = responseSchema.parse(wire.body);
    if (parsed.nonce !== nonce || !authentic(record.secret, parsed, wire.mac)) throw new Error('Forged endpoint response');
    return parsed.result;
  } finally { socket.destroy(); }
}

async function probe(record: Registration): Promise<void> {
  const nonce = randomUUID();
  const result = await exchange(record, { kind: 'probe', target: record.address.endpoint, nonce }, record.secret, nonce);
  if (result !== 'live') throw new Error('Endpoint is not live');
}

/** Bounded metadata-only endpoint projection, separate from immutable lease discovery. */
export async function discoverPeers(): Promise<{ endpoints: PeerAddress[]; omitted: number; uninspected: number; scanLimited: boolean; scope: string }> {
  const dir = opendirSync(checkStore());
  const candidates: Registration[] = [];
  let omitted = 0;
  let uninspected = 0;
  let scanLimited = false;
  try {
    for (let n = 0; n < 256; n++) {
      const entry = dir.readSync();
      if (!entry) break;
      if (/^[a-f0-9-]{36}\.json$/.test(entry.name)) {
        try {
          // Cheap private metadata/socket checks precede the expensive challenge
          // budget. Crash remnants must not hide current live endpoints.
          const record = registration(entry.name.slice(0, -5));
          if (candidates.length < 32) candidates.push(record);
          else { omitted++; uninspected++; }
        } catch { omitted++; }
      }
      if (n === 255) scanLimited = dir.readSync() !== null;
    }
  } finally { dir.closeSync(); }
  const endpoints: PeerAddress[] = [];
  // Eight probes at a time, at most 32 endpoints / six seconds. Never reads history.
  for (let start = 0; start < candidates.length; start += 8) {
    await Promise.all(candidates.slice(start, start + 8).map(async record => {
      try { await probe(record); endpoints.push(record.address); }
      catch { omitted++; }
    }));
  }
  return { endpoints: endpoints.sort((a, b) => a.endpoint.localeCompare(b.endpoint)), omitted, uninspected, scanLimited, scope: 'Messaging-capable local endpoints only. Omitted counts scanned registrations not returned; uninspected counts metadata-valid candidates not challenged. scanLimited means further directory entries were not inspected (count unknown). /list-agents separately lists leases; a lease without an endpoint (including older Darwin) cannot receive messages. Discovery starts no model work.' };
}

/** One parent session, never a daemon or SDK loop. Only drivers drain the inbox. */
export class LocalCollaboration implements PeerTransport {
  private server: net.Server | undefined;
  private registration: Registration | undefined;
  private sockets = new Set<net.Socket>();
  private inbox: PeerInput[] = [];
  private listeners = new Set<() => void>();
  private notices: string[] = [];
  private seen = new Map<string, number>();
  private chainCounts = new Map<string, { count: number; expires: number }>();
  private cause?: PeerChain;
  private outgoing = 0;
  private peerTurn = false;
  private lastPeerId?: string;
  private denied = false;
  private admitted = 0;
  private window = Date.now();
  private accepting = false;
  private stopped = false;
  private generation = 0;
  private canonicalRoot: string | undefined;
  /** Cross-machine transport (hub/README.md); shares this session's inbox, ledger and caps. */
  readonly hub: HubTransport;
  constructor(private readonly projectRoot: string, readonly session: string, private readonly readOnly: () => boolean = () => false) {
    this.hub = new HubTransport({
      admit: envelope => this.admitHub(envelope),
      drop: (node, reason) => this.dropHubNode(node, reason),
      notice: text => this.notice(text),
    }, session);
  }
  get project(): string {
    if (this.canonicalRoot === undefined) throw new Error('Canonical collaboration project unavailable');
    return this.canonicalRoot;
  }

  get address(): PeerAddress | undefined { return this.registration?.address; }
  /** The project root this session was started in (not canonicalized). */
  get root(): string { return this.projectRoot; }
  get pending(): number { return this.inbox.length; }
  get active(): boolean { return this.accepting; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  takeNotices(): string[] { return this.notices.splice(0); }
  private changed(): void { for (const listener of this.listeners) { try { listener(); } catch { /* observer */ } } }
  private notice(text: string): void { if (this.notices.length < 16) this.notices.push(text); this.changed(); }

  async start(): Promise<void> {
    if (this.server) return;
    this.stopped = false;
    const generation = ++this.generation;
    try {
      this.canonicalRoot = canonicalProject(this.projectRoot);
      const node = await withPolicy(state => state.node);
      if (this.stopped || generation !== this.generation) return;
      if (!readPolicy().enabled) { this.notice('Collaboration is off. User: /collaborate on'); return; }
      const record: Registration = { address: { version: 1, transport: 'local', node, endpoint: randomUUID(), project: this.project, session: this.session }, pid: process.pid, secret: randomBytes(32).toString('hex') };
      const file = socketPath(record.address.endpoint);
      const server = net.createServer(socket => {
        socket.on('error', () => {});
        if (this.stopped || this.sockets.size >= 16) { socket.destroy(); return; }
        this.sockets.add(socket);
        const deadline = setTimeout(() => socket.destroy(), IO_TIMEOUT_MS * 3);
        socket.once('close', () => { clearTimeout(deadline); this.sockets.delete(socket); });
        void this.receive(socket, record).catch(() => socket.destroy());
      });
      this.server = server;
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(file, resolve); });
      server.on('error', () => {
        if (generation !== this.generation || this.server !== server) return;
        this.notice('Collaboration listener failed; endpoint retired'); this.close('listener failure');
      });
      if (this.stopped || generation !== this.generation) { server.close(() => {}); return; }
      chmodSync(file, 0o600);
      writePrivate(`${record.address.endpoint}.json`, record);
      this.registration = record;
      this.accepting = true;
      // After local success, inside the same guard: any hub problem disables only the hub.
      try { this.hub.start(this.project, isPublished(this.project)); }
      catch (error) { this.notice(`hub: unavailable: ${error instanceof Error ? error.message.slice(0, 256) : 'startup failed'}`); }
    } catch (error) {
      if (generation !== this.generation) return;
      this.close('startup unavailable');
      const reason = error instanceof Error ? error.message.slice(0, 512) : 'local startup failed';
      this.notice(`Collaboration unavailable: ${JSON.stringify(reason)}. User: darwin collaborate status. No TCP fallback.`);
    }
  }

  /** Headless closes admission before draining a finite snapshot; not an idle daemon. */
  stopAdmission(): void { this.accepting = false; }

  close(reason: string): void {
    this.generation++;
    this.stopped = true; this.accepting = false;
    this.hub.close();
    const count = this.inbox.length; this.inbox = [];
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close(); this.server = undefined;
    const record = this.registration; this.registration = undefined;
    if (record) {
      // UUID never reused. Refuse to remove a replaced registration or symlink.
      try {
        const current = registrationSchema.parse(readPrivate(`${record.address.endpoint}.json`));
        if (current.secret === record.secret && sameAddress(current.address, record.address)) unlinkSync(path.join(checkStore(), `${record.address.endpoint}.json`));
      } catch { /* stale record is never proof of a live endpoint */ }
    }
    if (count) this.notice(`peer messages dropped: ${count} (${reason}); not forwarded to a successor`);
    this.changed();
  }

  private async receive(socket: net.Socket, own: Registration): Promise<void> {
    const wire = wireSchema.parse(await readFrame(socket));
    const probeRequest = probeSchema.safeParse(wire.body);
    if (probeRequest.success) {
      if (probeRequest.data.target !== own.address.endpoint || !authentic(own.secret, wire.body, wire.mac)) throw new Error('Invalid challenge');
      this.respond(socket, own, probeRequest.data.nonce, 'live'); return;
    }
    const { envelope } = messageSchema.parse(wire.body);
    if (!sameAddress(envelope.target, own.address) || envelope.sender.endpoint === own.address.endpoint) throw new Error('Invalid target');
    const sender = registration(envelope.sender.endpoint);
    if (!sameAddress(sender.address, envelope.sender) || !authentic(sender.secret, wire.body, wire.mac)) throw new Error('Forged sender');
    await probe(sender);
    if (!this.accepting || this.registration !== own) throw new Error('Retired endpoint');
    const result = await this.admit(envelope);
    this.respond(socket, own, envelope.id, result);
  }

  private respond(socket: net.Socket, own: Registration, nonce: string, result: string): void {
    const body = { nonce, result };
    socket.end(JSON.stringify({ body, mac: sign(own.secret, body) }) + '\n');
  }

  private fresh(envelope: PeerEnvelope): boolean {
    const now = Date.now();
    return envelope.sent <= now + 1000 && envelope.sent > now - MESSAGE_TTL_MS
      && envelope.chain.started <= envelope.sent && envelope.chain.started > now - CHAIN_TTL_MS;
  }

  private async admit(envelope: LocalEnvelope): Promise<string> {
    if (!this.fresh(envelope)) return 'Not queued: expired message/chain';
    const auth = authorization(this.project, envelope.sender.project);
    if (!auth) return requestCooperation(this.project, envelope.sender.project);
    return this.enqueue(envelope, auth);
  }

  /**
   * Hub admission: the transport already checked block/pin/signature/target. Enrollment is the
   * grant (no per-pair confirmation); everything after is the shared local admission.
   */
  private admitHub(envelope: HubEnvelope): string {
    if (!this.accepting || this.stopped) return 'Not queued: endpoint retired or admission closed';
    if (!this.fresh(envelope)) return 'Not queued: expired message/chain';
    return this.enqueue(envelope, `hub:${this.hub.generation}`);
  }

  /** Drop queued hub input from one node (revoked at the hub, or blocked by the user). */
  dropHubNode(node: string, reason: string): void {
    const before = this.inbox.length;
    this.inbox = this.inbox.filter(input => input.envelope.version !== 2 || input.envelope.sender.node !== node);
    if (this.inbox.length !== before) this.notice(`peer messages dropped: ${before - this.inbox.length} (${reason})`);
  }

  /** peer_discover: the local projection unchanged, plus the bounded hub projection. */
  async discover(): Promise<Awaited<ReturnType<typeof discoverPeers>> & { hub: Awaited<ReturnType<HubTransport['discover']>> }> {
    const [local, hub] = await Promise.all([discoverPeers(), this.hub.discover()]);
    return { ...local, hub };
  }

  private enqueue(envelope: PeerEnvelope, auth: string): string {
    const now = Date.now();
    for (const [id, expiry] of this.seen) if (expiry <= now) this.seen.delete(id);
    for (const [id, entry] of this.chainCounts) if (entry.expires <= now) this.chainCounts.delete(id);
    if (this.seen.has(envelope.id)) return `Already queued ${envelope.id}; duplicate not delivered again (not proof of processing)`;
    if (now - this.window >= MESSAGE_TTL_MS) { this.window = now; this.admitted = 0; }
    const chain = this.chainCounts.get(envelope.chain.id);
    if (this.inbox.length >= MAX_QUEUE || this.admitted >= 16 || this.seen.size >= 256 || this.chainCounts.size >= 256) return 'Not queued: inbox/flood capacity (8 queued, 16 admitted/minute); pause until capacity changes';
    if ((chain?.count ?? 0) >= 2) return 'Not queued: causal chain limit; a human must explicitly resume work';
    this.seen.set(envelope.id, envelope.sent + MESSAGE_TTL_MS);
    this.chainCounts.set(envelope.chain.id, { count: (chain?.count ?? 0) + 1, expires: envelope.chain.started + CHAIN_TTL_MS });
    this.inbox.push({ kind: 'peer', envelope, authorization: auth }); this.admitted++;
    this.changed();
    return `Queued ${envelope.id}; not processed. Expires after 60 seconds; revocation, cancellation, shutdown or capacity policy may drop it. No automatic retry on ambiguous acknowledgement.`;
  }

  /** Only a driver at idle takes input. Runtime rechecks it immediately before invocation. */
  take(): PeerInput | undefined {
    while (this.inbox.length) {
      const input = this.inbox.shift()!;
      try { this.validateDelivery(input); this.changed(); return input; }
      catch { this.notice(`peer message ${input.envelope.id} dropped: expired, revoked or retired`); }
    }
    return undefined;
  }

  validateDelivery(input: PeerInput): void {
    if (input.envelope.version === 2) {
      if (!this.fresh(input.envelope) || !this.hub.deliverable(input.envelope, input.authorization)) throw new Error('Peer delivery expired, revoked or retired');
      return;
    }
    if (!this.registration || !sameAddress(input.envelope.target, this.registration.address) || !this.fresh(input.envelope)
      || authorization(this.project, input.envelope.sender.project) !== input.authorization) throw new Error('Peer delivery expired, revoked or retired');
  }

  beginHumanTurn(): void {
    this.cause = { id: randomUUID(), started: Date.now(), hop: 0, readOnly: this.readOnly() };
    this.outgoing = 0; this.peerTurn = false; this.denied = false;
  }
  beginPeerTurn(input: PeerInput): void {
    this.validateDelivery(input);
    this.cause = input.envelope.chain;
    if (this.lastPeerId !== input.envelope.id) this.outgoing = 0;
    this.lastPeerId = input.envelope.id; this.peerTurn = true;
    // A local denial remains latched through synthetic turns; only a human can reset it.
  }
  permissionDenied(): void { this.denied = true; }
  get fromPeer(): boolean { return this.peerTurn; }
  get peerReadOnly(): boolean { return this.peerTurn && this.cause?.readOnly === true; }

  async send(target: string, text: string): Promise<string> {
    const own = this.registration;
    if (!own || this.stopped) throw new Error('Collaboration endpoint inactive; user: /collaborate on');
    idSchema.parse(target);
    if (target === own.address.endpoint) throw new Error('Self-send refused');
    if (this.denied) throw new Error('Peer send paused after a local permission denial; never route denied work to a peer. A human must explicitly resume.');
    const cause = this.cause;
    if (!cause || cause.started <= Date.now() - CHAIN_TTL_MS || (this.peerTurn && cause.hop >= MAX_HOPS) || this.outgoing >= (this.peerTurn ? 1 : 4)) throw new Error('Peer causal/outgoing limit; a human must explicitly resume work (no invented new chain)');
    const chain: PeerChain = { ...cause, readOnly: cause.readOnly || this.readOnly(), hop: cause.hop + (this.peerTurn ? 1 : 0) };
    if (this.hub.knows(target)) {
      const prepared = this.hub.prepare(target, chain, text);
      // Reserve synchronously before network waits; parallel tools share the cap.
      this.outgoing++;
      return this.hub.transmit(prepared);
    }
    const recipient = registration(target);
    const envelope = localEnvelopeSchema.parse({ version: 1, id: randomUUID(), sender: own.address, target: recipient.address, sent: Date.now(), chain, text });
    const body = { kind: 'message', envelope };
    if (Buffer.byteLength(JSON.stringify({ body, mac: sign(own.secret, body) }) + '\n') > MAX_FRAME_BYTES) throw new Error('Encoded peer frame exceeds 16 KiB; shorten text/identities');
    // Reserve synchronously before network or lock waits; parallel tools share the cap.
    this.outgoing++;
    if (!authorization(this.project, recipient.address.project)) return requestCooperation(this.project, recipient.address.project);
    try { return await exchange(recipient, body, own.secret, envelope.id); }
    catch { throw new Error(`Peer send ${envelope.id}: acknowledgement unavailable; delivery may have queued. Do not replay automatically. Inspect the receiving session before a human retries.`); }
  }
}
