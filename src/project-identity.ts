import { createHash } from 'node:crypto';
import { projectKey } from './paths.js';

/** Stable cloud/override key: explicit global identity, otherwise SHA256(projectKey). */
export function projectIdentity(root: string, explicit?: string): string {
  return explicit ?? createHash('sha256').update(projectKey(root)).digest('hex');
}
