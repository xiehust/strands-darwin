import { z } from 'zod';
import { createHash } from 'node:crypto';
import { projectKey } from '../paths.js';

const segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const agentCoreConfigSchema = z.object({
  enabled: z.literal(true),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  memoryId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}-[a-zA-Z0-9]{10}$/),
  episodicStrategyId: segment,
  preferenceStrategyId: segment,
  actorId: segment,
  projectId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  cliPath: z.string().regex(/^\//).max(1024).default('/usr/local/bin/aws'),
  timeoutMs: z.number().int().min(100).max(15000).default(5000),
  preferences: z.boolean().default(true),
  upload: z.enum(['off', 'manual']).default('off'),
}).strict().refine((value) => value.episodicStrategyId !== value.preferenceStrategyId, 'strategies must be distinct');
export type AgentCoreConfig = z.infer<typeof agentCoreConfigSchema>;
export function parseAgentCoreConfig(value: unknown): AgentCoreConfig | undefined {
  if (value === undefined || value === false) return undefined;
  const result = agentCoreConfigSchema.safeParse(value);
  if (!result.success) throw new Error('agentCoreMemory: invalid configuration; use enabled:true, region, memoryId, distinct strategy IDs and opaque actorId; upload is off or manual.');
  return result.data;
}
export function scopeFor(config: AgentCoreConfig, root: string) {
  const projectId = config.projectId ?? createHash('sha256').update(projectKey(root)).digest('hex');
  const project = `/users/${config.actorId}/projects/${projectId}/strategy/${config.episodicStrategyId}/`;
  return { projectId, project, episodes: `${project}sessions/`, preferences: `/users/${config.actorId}/strategy/${config.preferenceStrategyId}/preferences/` };
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
