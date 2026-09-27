/**
 * Collaboration hub wire contract (hub/README.md §4, §6, §8). Pure: zod and node:crypto only,
 * no filesystem or darwin runtime imports, because the hub's Lambda bundle and its dependency-free
 * local server import this exact module — one definition for both ends.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from 'node:crypto';
import { z } from 'zod';

export const MAX_TEXT_BYTES = 4096;
export const MAX_FRAME_BYTES = 16_384;
export const MAX_QUEUE = 8;
export const MESSAGE_TTL_MS = 60_000;
export const CHAIN_TTL_MS = 300_000;
export const MAX_HOPS = 4;
/** Connect assertion and envelope `sent` clock window (both directions). */
export const CLOCK_SKEW_MS = 60_000;
export const MAX_DISCOVERY = 32;
export const ENROLL_TOKEN_TTL_MS = 600_000;

export const uuidSchema = z.string().uuid();
export const sessionSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
/** Normalized remote identity: lowercase host plus 1–8 path segments, ≤256 bytes. */
export const hubProjectSchema = z.string().max(256).regex(/^[a-z0-9.-]+(\/[A-Za-z0-9._~-]+){1,8}$/);
export const nodeNameSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
/** Ed25519 SPKI DER (44 bytes) as base64. */
export const publicKeySchema = z.string().regex(/^[A-Za-z0-9+/]{59}[A-Za-z0-9+/=]$/);
export const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const nonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const tokenSchema = z.string().regex(/^dhub1_[A-Za-z0-9_-]{43}$/);
const reasonSchema = z.string().max(512);
const textSchema = z.string().min(1).refine(t => Buffer.byteLength(t) <= MAX_TEXT_BYTES, 'text exceeds 4096 UTF-8 bytes');

export const chainSchema = z.object({ id: uuidSchema, started: z.number().int(), hop: z.number().int().min(0).max(MAX_HOPS), readOnly: z.boolean() }).strict();
export type PeerChain = z.infer<typeof chainSchema>;

export const hubAddressSchema = z.object({ version: z.literal(2), transport: z.literal('hub'), node: uuidSchema, endpoint: uuidSchema, project: hubProjectSchema, session: sessionSchema }).strict();
export type HubAddress = z.infer<typeof hubAddressSchema>;
export const hubEnvelopeSchema = z.object({ version: z.literal(2), id: uuidSchema, sender: hubAddressSchema, target: hubAddressSchema, sent: z.number().int(), chain: chainSchema, text: textSchema }).strict();
export type HubEnvelope = z.infer<typeof hubEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Keys, fingerprints and signatures. Signed bytes carry a domain prefix so a
// connect assertion can never be replayed as an envelope signature or vice versa.

export interface NodeKeys { publicKey: string; privateKey: string }

export function generateNodeKeys(): NodeKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

export function fingerprint(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKeySchema.parse(publicKey), 'base64')).digest('hex');
}

/** Display form: first 16 hex in groups of four. Pinning always compares the full key. */
export function shortFingerprint(value: string): string {
  return (value.slice(0, 16).match(/.{4}/g) ?? []).join(':');
}

function signBytes(privateKey: string, bytes: Buffer): string {
  return edSign(null, bytes, createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64url');
}

function verifyBytes(publicKey: string, bytes: Buffer, signature: unknown): boolean {
  if (!signatureSchema.safeParse(signature).success || !publicKeySchema.safeParse(publicKey).success) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return edVerify(null, bytes, key, Buffer.from(signature as string, 'base64url'));
  } catch { return false; }
}

/** Serialize the zod-parsed value: key order is the schema's, identical on both ends. */
function envelopeBytes(envelope: HubEnvelope): Buffer {
  return Buffer.from(`darwin-hub-envelope/v1\n${JSON.stringify(hubEnvelopeSchema.parse(envelope))}`, 'utf8');
}

export function signEnvelope(privateKey: string, envelope: HubEnvelope): string {
  return signBytes(privateKey, envelopeBytes(envelope));
}

export function verifyEnvelope(publicKey: string, envelope: unknown, signature: unknown): envelope is HubEnvelope {
  const parsed = hubEnvelopeSchema.safeParse(envelope);
  return parsed.success && verifyBytes(publicKey, envelopeBytes(parsed.data), signature);
}

/** `audience` is `<apiId>/<stage>`, binding an assertion to one deployment. */
export function connectMessage(audience: string, node: string, ts: number, nonce: string): Buffer {
  return Buffer.from(`darwin-hub-connect/v1\n${audience}\n${node}\n${ts}\n${nonce}`, 'utf8');
}

export interface ConnectHeaders { 'X-Darwin-Node': string; 'X-Darwin-Ts': string; 'X-Darwin-Nonce': string; 'X-Darwin-Sig': string }

export function connectHeaders(audience: string, node: string, privateKey: string, now = Date.now()): ConnectHeaders {
  const nonce = randomBytes(16).toString('base64url');
  return { 'X-Darwin-Node': node, 'X-Darwin-Ts': String(now), 'X-Darwin-Nonce': nonce, 'X-Darwin-Sig': signBytes(privateKey, connectMessage(audience, node, now, nonce)) };
}

export interface ConnectAssertion { node: string; ts: number; nonce: string; sig: string }

/** Case-insensitive header lookup, bounded parse; undefined on any malformed field. */
export function parseConnectHeaders(headers: Record<string, string | undefined> | undefined): ConnectAssertion | undefined {
  if (!headers) return undefined;
  const get = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const node = uuidSchema.safeParse(get('x-darwin-node'));
  const ts = get('x-darwin-ts');
  const nonce = nonceSchema.safeParse(get('x-darwin-nonce'));
  const sig = signatureSchema.safeParse(get('x-darwin-sig'));
  if (!node.success || !nonce.success || !sig.success || ts === undefined || !/^[0-9]{1,15}$/.test(ts)) return undefined;
  return { node: node.data, ts: Number(ts), nonce: nonce.data, sig: sig.data };
}

export function verifyConnect(publicKey: string, audience: string, assertion: ConnectAssertion, now = Date.now()): boolean {
  return Math.abs(now - assertion.ts) <= CLOCK_SKEW_MS
    && verifyBytes(publicKey, connectMessage(audience, assertion.node, assertion.ts, assertion.nonce), assertion.sig);
}

export function mintToken(): string { return `dhub1_${randomBytes(32).toString('base64url')}`; }
export function tokenHash(token: string): string { return createHash('sha256').update(token, 'utf8').digest('hex'); }

// ---------------------------------------------------------------------------
// Automatic cross-machine project identity (§4). Pure: the caller runs git.

/**
 * Normalize an `origin` URL to `host/path`. Userinfo (which may hold a token), port, scheme and
 * `.git` are dropped; host lowercased, path case kept. Local paths and file URLs are refused:
 * they name a directory on one machine, not a shared project.
 */
export function normalizeRemote(raw: string): string {
  const value = raw.trim();
  if (!value || value.length > 2048 || /[\s\0]/.test(value)) throw new Error('remote URL empty, oversized or contains whitespace');
  let host: string;
  let pathname: string;
  const scp = /^(?:[^@/:]+@)?([^/:@]+):(?!\/\/)(.+)$/.exec(value);
  if (!value.includes('://') && scp) {
    if (/^[a-zA-Z]$/.test(scp[1]!)) throw new Error('remote looks like a local drive path');
    host = scp[1]!; pathname = scp[2]!;
  } else {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error('remote is neither a URL nor scp-like host:path (local paths are not shared identities)'); }
    if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:', 'ssh+git:'].includes(url.protocol)) throw new Error(`remote scheme ${url.protocol} is not a network remote`);
    host = url.hostname; pathname = url.pathname;
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length) segments[segments.length - 1] = segments[segments.length - 1]!.replace(/\.git$/, '');
  const result = hubProjectSchema.safeParse([host, ...segments.filter(Boolean)].join('/'));
  if (!result.success) throw new Error('normalized remote identity is not host/owner/repo shaped (≤8 segments, ≤256 bytes, [A-Za-z0-9._~-])');
  return result.data;
}

export function projectLabel(project: string): string {
  return project.slice(project.lastIndexOf('/') + 1).slice(0, 64);
}

// ---------------------------------------------------------------------------
// Frames. Client → hub carries `action` (the API Gateway route key); hub → client carries `type`.

const rid = uuidSchema;
export const registerFrame = z.object({ action: z.literal('register'), rid, endpoint: uuidSchema, project: hubProjectSchema, session: sessionSchema }).strict();
export const unregisterFrame = z.object({ action: z.literal('unregister'), endpoint: uuidSchema }).strict();
export const discoverFrame = z.object({ action: z.literal('discover'), rid }).strict();
export const sendFrame = z.object({ action: z.literal('send'), envelope: hubEnvelopeSchema, sig: signatureSchema }).strict();
export const ackFrame = z.object({ action: z.literal('ack'), id: uuidSchema, status: z.enum(['queued', 'refused']), reason: reasonSchema.optional() }).strict();
export const pingFrame = z.object({ action: z.literal('ping') }).strict();
export const clientFrame = z.discriminatedUnion('action', [registerFrame, unregisterFrame, discoverFrame, sendFrame, ackFrame, pingFrame]);
export type ClientFrame = z.infer<typeof clientFrame>;

export const nodeInfoSchema = z.object({ node: uuidSchema, name: nodeNameSchema, publicKey: publicKeySchema, fingerprint: fingerprintSchema }).strict();
export type NodeInfo = z.infer<typeof nodeInfoSchema>;
export const discoverRowSchema = z.object({ address: hubAddressSchema, name: nodeNameSchema, publicKey: publicKeySchema, fingerprint: fingerprintSchema }).strict();
export type DiscoverRow = z.infer<typeof discoverRowSchema>;

export const hubFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('registered'), rid, endpoint: uuidSchema, ok: z.boolean(), reason: reasonSchema.optional() }).strict(),
  z.object({ type: z.literal('discovered'), rid, endpoints: z.array(discoverRowSchema).max(MAX_DISCOVERY), omitted: z.number().int().min(0) }).strict(),
  z.object({ type: z.literal('deliver'), envelope: hubEnvelopeSchema, sig: signatureSchema, sender: nodeInfoSchema }).strict(),
  z.object({ type: z.literal('sendResult'), id: uuidSchema, status: z.enum(['delivered', 'offline', 'rejected']), reason: reasonSchema.optional() }).strict(),
  z.object({ type: z.literal('ack'), id: uuidSchema, status: z.enum(['queued', 'refused']), reason: reasonSchema.optional() }).strict(),
  z.object({ type: z.literal('node-enrolled'), node: nodeInfoSchema, enrolledAt: z.number().int() }).strict(),
  z.object({ type: z.literal('node-revoked'), node: uuidSchema }).strict(),
  z.object({ type: z.literal('endpoint-gone'), endpoint: uuidSchema }).strict(),
  z.object({ type: z.literal('error'), reason: reasonSchema }).strict(),
]);
export type HubFrame = z.infer<typeof hubFrame>;

export const enrollRequestSchema = z.object({ token: tokenSchema, node: uuidSchema, name: nodeNameSchema, publicKey: publicKeySchema }).strict();
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;
export const enrollResponseSchema = z.object({ ok: z.literal(true), node: uuidSchema, fingerprint: fingerprintSchema, wsUrl: z.string().url().max(512), audience: z.string().max(256) }).strict();
export const timeResponseSchema = z.object({ now: z.number().int() }).strict();

/** Parse one inbound JSON frame with the byte cap first; undefined on any violation. */
export function parseFrame<T>(schema: z.ZodType<T>, raw: string | Buffer): T | undefined {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > MAX_FRAME_BYTES) return undefined;
  try { const parsed = schema.safeParse(JSON.parse(raw.toString())); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}

export function encodeFrame(value: unknown): string {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new Error('Encoded hub frame exceeds 16 KiB; shorten text/identities');
  return text;
}
