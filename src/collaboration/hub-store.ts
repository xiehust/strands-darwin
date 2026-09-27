/**
 * Hub state on this machine (hub/README.md §5, §7). Lives in the owner-private collaboration
 * directory, so the gate's existing protection covers it: sensitive read path, un-ruleable,
 * model access to the directory and to `collaborate` controls denied before rules and hooks.
 * Writes share the policy lock; reads validate strictly and fail closed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { collaborationDir } from '../paths.js';
import { fingerprintSchema, nodeNameSchema, normalizeRemote, publicKeySchema, uuidSchema } from './hub-wire.js';
import { checkStore, readPrivate, withLock, writePrivate } from './storage.js';

const NODE_FILE = 'hub-node.json';
const STATE_FILE = 'hub-state.json';
export const MAX_PINS = 256;

const urlSchema = z.string().max(512).refine(value => { try { return /^(https|wss|http|ws):$/.test(new URL(value).protocol); } catch { return false; } });
export const hubNodeSchema = z.object({
  version: z.literal(1), hubUrl: urlSchema, wsUrl: urlSchema, audience: z.string().min(1).max(256),
  node: uuidSchema, name: nodeNameSchema, publicKey: publicKeySchema, privateKey: z.string().min(40).max(256), fingerprint: fingerprintSchema, enrolledAt: z.number().int(),
}).strict();
export type HubNode = z.infer<typeof hubNodeSchema>;

const pinSchema = z.object({ node: uuidSchema, name: nodeNameSchema, publicKey: publicKeySchema, fingerprint: fingerprintSchema, firstSeen: z.number().int() }).strict();
export type HubPin = z.infer<typeof pinSchema>;
const stateSchema = z.object({
  version: z.literal(1),
  pins: z.array(pinSchema).max(MAX_PINS),
  blocked: z.array(uuidSchema).max(MAX_PINS),
  /** Canonical project roots whose sessions do not publish to the hub. */
  unpublished: z.array(z.string().min(1).max(1024)).max(64),
}).strict();
export type HubState = z.infer<typeof stateSchema>;
const EMPTY: HubState = { version: 1, pins: [], blocked: [], unpublished: [] };

export function readHubNode(): HubNode | undefined {
  if (!existsSync(collaborationDir())) return undefined;
  const raw = readPrivate(NODE_FILE);
  return raw === undefined ? undefined : hubNodeSchema.parse(raw);
}

/** Enrollment writes the identity exactly once; an existing file must be removed by `leave`. */
export async function writeHubNode(node: HubNode): Promise<void> {
  await withLock(() => {
    if (readPrivate(NODE_FILE) !== undefined) throw new Error('This HOME is already enrolled; run collaborate hub leave first');
    writePrivate(NODE_FILE, hubNodeSchema.parse(node));
  });
}

export async function removeHubNode(): Promise<boolean> {
  return withLock(() => {
    if (readPrivate(NODE_FILE) === undefined) return false;
    unlinkSync(path.join(checkStore(), NODE_FILE));
    return true;
  });
}

export function readHubState(): HubState {
  if (!existsSync(collaborationDir())) return structuredClone(EMPTY);
  const raw = readPrivate(STATE_FILE);
  return raw === undefined ? structuredClone(EMPTY) : stateSchema.parse(raw);
}

export async function updateHubState<T>(change: (state: HubState) => T): Promise<T> {
  return withLock(() => {
    const raw = readPrivate(STATE_FILE);
    const state = raw === undefined ? structuredClone(EMPTY) : stateSchema.parse(raw);
    const result = change(state);
    writePrivate(STATE_FILE, stateSchema.parse(state));
    return result;
  });
}

export type PinResult = 'pinned' | 'match' | 'mismatch' | 'full';

/** Pin once, never re-key (§7.1): a different key for a known node id is refused forever. */
export async function pinNode(node: string, name: string, publicKey: string, fingerprint: string, now = Date.now()): Promise<PinResult> {
  const known = readHubState().pins.find(pin => pin.node === node);
  if (known) return known.publicKey === publicKey ? 'match' : 'mismatch';
  return updateHubState(state => {
    const current = state.pins.find(pin => pin.node === node);
    if (current) return current.publicKey === publicKey ? 'match' : 'mismatch';
    if (state.pins.length >= MAX_PINS) return 'full';
    state.pins.push({ node, name, publicKey, fingerprint, firstSeen: now });
    return 'pinned';
  });
}

export function pinnedKey(node: string): string | undefined {
  return readHubState().pins.find(pin => pin.node === node)?.publicKey;
}

export function isBlocked(node: string): boolean { return readHubState().blocked.includes(node); }
export function isPublished(canonicalRoot: string): boolean { return !readHubState().unpublished.includes(canonicalRoot); }

/**
 * Automatic cross-machine project identity (§4): `git remote get-url origin`, normalized.
 * Argument array, no shell, bounded time. Any failure disables the hub for that project.
 */
export function remoteIdentity(canonicalRoot: string): { project: string } | { problem: string } {
  const result = spawnSync('git', ['-C', canonicalRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.error || result.status !== 0) return { problem: 'no git origin remote' };
  try { return { project: normalizeRemote(result.stdout) }; }
  catch (error) { return { problem: error instanceof Error ? error.message : 'unrecognized origin remote' }; }
}
