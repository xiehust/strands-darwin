import path from 'node:path';
import { z } from 'zod';
import { userDarwinDir } from '../paths.js';
import { projectIdentity } from '../project-identity.js';
import { authorizationSchema, type AgentCoreConfig } from './config.js';
import { readState, stateNames, withStateLock, writeState } from './state.js';

export const MAX_OUTBOX_FILES = 32768;
export const MAX_OUTBOX_BODIES = 4096;
export const MAX_PENDING_BODIES = 512;
export const AUTO_RETENTION_MS = 7 * 86400000;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const autoProofSchema = z.object({ version: z.literal(1), hash, authorization: authorizationSchema,
  session: z.string().max(128), turn: z.number().int().positive(), reason: z.string().max(240).optional(),
}).strict();
export type AutoProof = z.infer<typeof autoProofSchema>;

const receiptSchema = z.object({ token: hash, disposition: z.enum(['accepted', 'discarded']), at: z.string().datetime() }).strict();
export function receiptFile(directory: string, token: string): string {
  hash.parse(token); return path.join(directory, 'receipts', token.slice(0, 2), `${token}.json`);
}
export async function tokenReceipt(directory: string, token: string) {
  const value = await readState(receiptFile(directory, token));
  if (value === undefined) return undefined;
  const receipt = receiptSchema.parse(value);
  if (receipt.token !== token) throw new Error('Receipt identity mismatch');
  return receipt;
}
export async function receiptCapacity(directory: string, tokens: string[]): Promise<void> {
  const shards = new Map<string, Set<string>>();
  for (const token of tokens) {
    const file = receiptFile(directory, token); const shard = path.dirname(file);
    if (!shards.has(shard)) shards.set(shard, new Set(await stateNames(shard, 4096)));
    shards.get(shard)!.add(path.basename(file));
    if (shards.get(shard)!.size > 4096) throw new Error('Receipt partition full (4096); paused without removing data');
  }
}
export async function saveReceipt(directory: string, token: string, disposition: 'accepted' | 'discarded', signal?: AbortSignal): Promise<void> {
  const prior = await tokenReceipt(directory, token);
  if (prior) { if (prior.disposition !== disposition) throw new Error('Receipt disposition cannot change'); return; }
  await receiptCapacity(directory, [token]);
  await writeState(receiptFile(directory, token), { token, disposition, at: new Date().toISOString() }, true, signal);
}

const quotaSchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), events: z.number().int().nonnegative().max(100000), bytes: z.number().int().nonnegative().max(107374182400) }).strict();
export function quotaDirectory(root: string, config?: AgentCoreConfig): string { return path.join(userDarwinDir(), 'agentcore', 'auto-quota', projectIdentity(root, config?.projectId)); }
export async function quotaUsage(root: string, now = new Date(), config?: AgentCoreConfig) {
  const day = now.toISOString().slice(0, 10);
  const value = await readState(path.join(quotaDirectory(root, config), 'usage.json'));
  const usage = value === undefined ? { day, events: 0, bytes: 0 } : quotaSchema.parse(value);
  if (usage.day > day) throw new Error('Quota clock moved backwards; auto paused');
  return usage.day === day ? usage : { day, events: 0, bytes: 0 };
}
/** A reservation is one network attempt, not one extracted memory or unique event.
 * Exact Smithy-serialized request body bytes; crashes/unknown acks consume budget. */
export async function reserveQuota(root: string, config: AgentCoreConfig, bytes: number, signal: AbortSignal, now = new Date()): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 262144) throw new Error('Invalid wire request size');
  await withStateLock(quotaDirectory(root, config), async () => {
    const usage = await quotaUsage(root, now, config);
    if (usage.events + 1 > config.autoDailyEvents || usage.bytes + bytes > config.autoDailyBytes) throw new Error('Auto paused: daily budget exhausted; pending retained until next ordinary authorized activity');
    await writeState(path.join(quotaDirectory(root, config), 'usage.json'), { day: usage.day, events: usage.events + 1, bytes: usage.bytes + bytes }, false, signal);
  }, signal);
}
