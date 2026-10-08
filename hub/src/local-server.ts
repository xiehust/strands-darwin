/**
 * Dependency-free local hub (README §11): Node `http` upgrade plus a minimal RFC 6455 codec
 * (text frames, client masking required, ≤16 KiB messages, no extensions). Runs the same
 * handlers.ts as Lambda over a MemoryStore, so darwin's free suites exercise real transports
 * without AWS. Import boundary: Node built-ins, hub-wire.ts and type-only hub modules.
 */
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { ENROLL_TOKEN_TTL_MS, MAX_FRAME_BYTES, mintToken } from '../../src/collaboration/hub-wire.js';
import type { Gateway } from './gateway.js';
import { authorize, connect, disconnect, enroll, message, mint, revoke, time, type HubContext, type LogFields } from './handlers.js';
import { MemoryStore } from './store-memory.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 §1.3
const STAGE = 'v1';

function encode(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65_536 ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
      : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(length), 2); return b; })();
  return Buffer.concat([header, payload]);
}

function closeFrame(code: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(code); return encode(0x8, b); }

class Connection {
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  closed = false;
  constructor(readonly id: string, private readonly socket: Duplex, private readonly onText: (text: string) => Promise<void>, private readonly onClose: () => void) {
    socket.on('data', chunk => this.data(chunk as Buffer));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  send(text: string): boolean {
    if (this.closed) return false;
    this.socket.write(encode(0x1, Buffer.from(text, 'utf8')));
    return true;
  }

  close(code = 1000): void {
    if (this.closed) return;
    try { this.socket.write(closeFrame(code)); this.socket.end(); } catch { /* already gone */ }
    // Let the close frame flush; destroy shortly after regardless.
    setTimeout(() => this.socket.destroy(), 500).unref();
    this.closed = true;
    // Drain accepted frames before disconnect deletes their authenticated connection.
    void this.queue.then(() => this.onClose());
  }

  /** Abrupt loss: no close frame. */
  abort(): void { this.finish(); }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    // Drain accepted frames before disconnect deletes their authenticated connection.
    void this.queue.then(() => this.onClose());
  }

  private data(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0]!; const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0; const opcode = b0 & 0x0f;
      if ((b0 & 0x70) !== 0 || (b1 & 0x80) === 0) { this.close(1002); return; } // no extensions; clients must mask
      let length = b1 & 0x7f; let offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME_BYTES)) { this.close(1009); return; }
        length = Number(big); offset = 10;
      }
      if (length > MAX_FRAME_BYTES) { this.close(1009); return; }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);
      if (opcode === 0x8) { this.close(1000); return; }
      if (opcode === 0x9) { this.socket.write(encode(0xa, payload)); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x2) { this.close(1003); return; }
      if (opcode !== 0x1 && opcode !== 0x0) { this.close(1002); return; }
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > MAX_FRAME_BYTES) { this.close(1009); return; }
      this.fragments.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = []; this.fragmentBytes = 0;
      // One message at a time per connection, in arrival order.
      this.queue = this.queue.then(() => this.onText(text)).catch(() => {});
    }
  }
}

export interface LocalHubOptions { host?: string; port?: number; now?: () => number; log?: (fields: LogFields) => void }

export class LocalHub {
  readonly store = new MemoryStore();
  readonly logs: LogFields[] = [];
  private readonly connections = new Map<string, Connection>();
  private readonly server: http.Server;
  private readonly clock: () => number;
  private readonly extraLog: ((fields: LogFields) => void) | undefined;
  httpUrl = '';
  wsUrl = '';
  readonly audience = `local/${STAGE}`;

  constructor(private readonly options: LocalHubOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.extraLog = options.log;
    this.server = http.createServer((req, res) => { void this.http(req, res); });
    this.server.on('upgrade', (req, socket) => { void this.upgrade(req, socket); });
  }

  get ctx(): HubContext {
    const gateway: Gateway = {
      post: async (connectionId, frame) => (this.connections.get(connectionId)?.send(frame) ? 'ok' : 'gone'),
      close: async connectionId => { this.connections.get(connectionId)?.close(1008); },
      exists: async connectionId => this.connections.get(connectionId)?.closed === false,
    };
    return { store: this.store, gateway, audience: this.audience, wsUrl: this.wsUrl, now: this.clock, log: fields => { this.logs.push(fields); this.extraLog?.(fields); } };
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', resolve); });
    const { port } = this.server.address() as AddressInfo;
    const host = this.options.host ?? '127.0.0.1';
    this.httpUrl = `http://${host}:${port}`;
    this.wsUrl = `ws://${host}:${port}/${STAGE}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections.values()) connection.close(1001);
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }

  /** Operator action: returns the plaintext token once; only its hash is stored. */
  async mintToken(note = 'local'): Promise<string> {
    const token = mintToken();
    await mint(this.ctx, token, ENROLL_TOKEN_TTL_MS, note);
    return token;
  }

  revokeNode(node: string) { return revoke(this.ctx, node); }
  get connectionCount(): number { return this.connections.size; }
  /** Test hook: drop a node's connections without a close handshake (network loss). */
  async sever(node: string): Promise<number> {
    let count = 0;
    for (const [id, connection] of [...this.connections]) {
      if ((await this.store.getConnection(id))?.node !== node) continue;
      connection.abort();
      count++;
    }
    return count;
  }

  private async http(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: string) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
    try {
      if (req.method === 'GET' && req.url === '/time') { const result = time(this.ctx); reply(result.status, result.body); return; }
      if (req.method === 'POST' && req.url === '/enroll') {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += (chunk as Buffer).length; if (size > 4096) { reply(413, '{"ok":false}'); return; } chunks.push(chunk as Buffer); }
        const result = await enroll(this.ctx, Buffer.concat(chunks).toString('utf8'));
        reply(result.status, result.body);
        return;
      }
      reply(404, '{"ok":false}');
    } catch { reply(500, '{"ok":false}'); }
  }

  private async upgrade(req: http.IncomingMessage, socket: Duplex): Promise<void> {
    socket.on('error', () => {});
    const key = req.headers['sec-websocket-key'];
    if (req.url !== `/${STAGE}` || req.headers.upgrade?.toLowerCase() !== 'websocket' || typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([name, value]) => [name, Array.isArray(value) ? value[0] : value]));
    const verdict = await authorize(this.ctx, headers);
    // API Gateway answers a denied authorizer with 403 and no detail; so does the local hub.
    if (!verdict.allow) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    // As on API Gateway, `$connect` completes before the client sees 101.
    const id = randomUUID();
    await connect(this.ctx, id, verdict.node);
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const connection = new Connection(id, socket, text => message(this.ctx, id, text), () => {
      this.connections.delete(id);
      void disconnect(this.ctx, id);
    });
    this.connections.set(id, connection);
  }
}
