import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { collaborationDir, userDarwinDir } from '../paths.js';

export const MAX_STATE_BYTES = 65_536;
export const idSchema = z.string().uuid();
export const projectSchema = z.string().min(1).max(1024).refine(p => path.isAbsolute(p) && path.normalize(p) === p);
const pairSchema = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/), projects: z.tuple([projectSchema, projectSchema]), grant: idSchema }).strict();
const pendingSchema = z.object({ id: idSchema, projects: z.tuple([projectSchema, projectSchema]), expires: z.number().int() }).strict();
const stateSchema = z.object({ version: z.literal(1), node: idSchema, enabled: z.boolean(), generation: idSchema, pairs: z.array(pairSchema).max(64), pending: z.array(pendingSchema).max(32) }).strict();
export type CooperationState = z.infer<typeof stateSchema>;

export function canonicalProject(root: string): string {
  const canonical = realpathSync.native(root);
  projectSchema.parse(canonical);
  if (!lstatSync(canonical).isDirectory()) throw new Error('Project must be a directory');
  return canonical;
}

function directory(dir: string, privateMode: boolean): void {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
    || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0 || realpathSync.native(dir) !== dir) {
    throw new Error('Unsafe collaboration directory; requires owned, non-symlink directories without foreign write access');
  }
}

export function checkStore(create = false): string {
  if (process.platform === 'win32' || process.getuid === undefined) throw new Error('Local collaboration requires POSIX Unix sockets');
  directory(os.homedir(), false);
  for (const [dir, privateMode] of [[userDarwinDir(), false], [collaborationDir(), true]] as const) {
    if (create) { try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    directory(dir, privateMode);
  }
  return collaborationDir();
}

/** NOFOLLOW + NONBLOCK + fstat, fixed buffer: no symlink/FIFO/oversize reads. */
export function readPrivate(name: string): unknown | undefined {
  const root = checkStore();
  if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error('Invalid collaboration filename');
  let fd: number;
  try { fd = openSync(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > MAX_STATE_BYTES) throw new Error('Unsafe or oversized collaboration file');
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let used = 0;
    while (used < buffer.length) { const n = readSync(fd, buffer, used, buffer.length - used, used); if (!n) break; used += n; }
    if (used > MAX_STATE_BYTES) throw new Error('Oversized collaboration file');
    return JSON.parse(buffer.subarray(0, used).toString('utf8')) as unknown;
  } finally { closeSync(fd); }
}

/** Call only under the policy lock, or with an unguessable new endpoint filename. */
export function writePrivate(name: string, value: unknown): void {
  const root = checkStore();
  if (!/^[a-zA-Z0-9.-]+$/.test(name)) throw new Error('Invalid collaboration filename');
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new Error('Collaboration storage capacity reached');
  // Refuse unsafe existing targets, rather than replacing even a dangling symlink.
  const target = path.join(root, name);
  try { const stat = lstatSync(target); if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error('Unsafe collaboration target'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = path.join(root, `${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes); fsyncSync(fd);
    renameSync(temporary, target);
    const dir = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally { closeSync(fd); try { unlinkSync(temporary); } catch { /* renamed */ } }
}

/** No stale-lock stealing: a crashed writer fails closed, never resurrects a revoked pair. */
export async function withLock<T>(change: () => T): Promise<T> {
  const root = checkStore(true);
  const lock = path.join(root, 'policy.lock');
  let acquired = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await delay(25);
  }
  if (!acquired) throw new Error('Collaboration policy busy (policy.lock); retry after the writer finishes. After a crash, the owner must inspect and remove the stale empty lock directory.');
  try { return change(); } finally { rmdirSync(lock); }
}

export async function withPolicy<T>(change: (state: CooperationState) => T): Promise<T> {
  return withLock(() => {
    const raw = readPrivate('policy.json');
    const state = raw === undefined ? { version: 1 as const, node: randomUUID(), enabled: true, generation: randomUUID(), pairs: [], pending: [] } : validateState(raw);
    state.pending = state.pending.filter(p => p.expires > Date.now());
    const result = change(state);
    writePrivate('policy.json', validateState(state));
    return result;
  });
}

function validateState(raw: unknown): CooperationState {
  const state = stateSchema.parse(raw);
  const ids = new Set<string>();
  for (const pair of state.pairs) {
    if (pair.projects[0] >= pair.projects[1] || pair.id !== pairId(...pair.projects) || ids.has(pair.id)) throw new Error('Corrupt cooperation pairs');
    ids.add(pair.id);
  }
  const pending = new Set<string>();
  for (const p of state.pending) {
    if (p.projects[0] >= p.projects[1] || pending.has(p.id)) throw new Error('Corrupt pending cooperation request');
    pending.add(p.id);
  }
  return state;
}

export function readPolicy(): CooperationState {
  const raw = readPrivate('policy.json');
  if (raw === undefined) throw new Error('Collaboration policy missing; run darwin collaborate status');
  return validateState(raw);
}

export function pairId(a: string, b: string): string {
  return createHash('sha256').update(JSON.stringify([a, b].sort())).digest('hex');
}

export function authorization(a: string, b: string): string | undefined {
  const state = readPolicy();
  if (!state.enabled) return undefined;
  if (a === b) return state.generation;
  const pair = state.pairs.find(p => p.id === pairId(a, b));
  return pair === undefined ? undefined : `${state.generation}:${pair.grant}`;
}

export async function requestCooperation(a: string, b: string): Promise<string> {
  return withPolicy(state => {
    if (!state.enabled) return 'Collaboration is off; the user can run darwin collaborate on';
    if (a === b || state.pairs.some(p => p.id === pairId(a, b))) return 'Cooperation changed; retry the send explicitly';
    let pending = state.pending.find(p => pairId(...p.projects) === pairId(a, b));
    if (!pending) {
      if (state.pending.length >= 32) throw new Error('Pending cooperation capacity reached (32); wait for expiry');
      pending = { id: randomUUID(), projects: [a, b].sort() as [string, string], expires: Date.now() + 600_000 };
      state.pending.push(pending);
    }
    return `Not queued. Human cooperation confirmation required for ${JSON.stringify(pending.projects)}. One confirmation persists a symmetric relationship across restarts in ~/.darwin/collaboration/policy.json. User: darwin collaborate confirm ${pending.id} --persist (or /collaborate confirm ${pending.id} --persist). Never run this confirmation from a model tool.`;
  });
}

/** User command only. Neither exposed as a tool nor called from admission. */
export async function policyCommand(args: readonly string[]): Promise<string> {
  const [verb, id, flag] = args;
  if (verb === 'status' && args.length === 1 || verb === 'relations' && args.length === 1 || verb === 'pending' && args.length === 1) {
    const state = readPolicy();
    return JSON.stringify({ enabled: state.enabled, node: state.node, pairs: state.pairs.map(({ id, projects }) => ({ id, projects })), pending: state.pending.filter(p => p.expires > Date.now()), persistence: '~/.darwin/collaboration/policy.json', confirmation: 'confirm <pending-id> --persist; symmetric across restarts' }, null, 2);
  }
  if ((verb === 'on' || verb === 'off') && args.length === 1) return withPolicy(state => {
    state.enabled = verb === 'on'; state.generation = randomUUID();
    return `Collaboration ${verb}, persisted for this HOME; queued messages from the old policy generation will be dropped.`;
  });
  if (verb === 'confirm' && args.length === 3 && flag === '--persist') return withPolicy(state => {
    idSchema.parse(id);
    const pending = state.pending.find(p => p.id === id);
    if (!pending) throw new Error('Pending request absent or expired; inspect pending and send again');
    // Resolve again: a renamed project or changed symlink must not grant another identity.
    if (pending.projects.some(p => canonicalProject(p) !== p)) throw new Error('Canonical project changed');
    const key = pairId(...pending.projects);
    if (!state.pairs.some(p => p.id === key)) {
      if (state.pairs.length >= 64) throw new Error('Cooperation relation capacity reached (64); revoke unused relations');
      state.pairs.push({ id: key, projects: pending.projects, grant: randomUUID() });
    }
    state.pending = state.pending.filter(p => p.id !== id);
    return `Confirmed bidirectional cooperation between ${JSON.stringify(pending.projects)}. Persisted in ~/.darwin/collaboration/policy.json across process/session restarts. Revoke with darwin collaborate revoke ${key}.`;
  });
  if (verb === 'revoke' && args.length === 2 && /^[a-f0-9]{64}$/.test(id ?? '')) return withPolicy(state => {
    state.pairs = state.pairs.filter(p => p.id !== id);
    state.pending = state.pending.filter(p => pairId(...p.projects) !== id);
    return `Revoked relation ${id}; queued and future messages require fresh authorization.`;
  });
  throw new Error('Usage: collaborate status|relations|pending|on|off; confirm <pending-id> --persist; revoke <pair-id>; list; send <endpoint-uuid> <literal text>');
}
