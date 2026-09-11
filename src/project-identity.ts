import { createHash } from 'node:crypto';
import { projectKey } from './paths.js';

/** Stable cloud namespace/quota identity (legacy body bindings must not change).
 * Without an explicit namespace, also the canonical working-tree override key. */
export function projectIdentity(root: string, explicit?: string): string {
  return explicit ?? createHash('sha256').update(projectKey(root)).digest('hex');
}
