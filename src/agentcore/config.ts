import { z } from 'zod';
import { createHash } from 'node:crypto';
import { projectIdentity } from '../project-identity.js';

const segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const agentCoreConfigSchema = z.object({
  enabled: z.literal(true),
  region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
  memoryId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}-[a-zA-Z0-9]{10}$/),
  episodicStrategyId: segment,
  preferenceStrategyId: segment,
  actorId: segment,
  projectId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  // Compatibility only: validated, ignored, never executed or displayed.
  cliPath: z.string().regex(/^\//).max(1024).optional(),
  timeoutMs: z.number().int().min(100).max(15000).default(5000),
  preferences: z.boolean().default(true),
  upload: z.enum(['off', 'manual', 'auto']).default('off'),
  autoDailyEvents: z.number().int().min(1).max(100000).default(500),
  autoDailyBytes: z.number().int().min(1).max(107374182400).default(104857600),
}).strict().refine((value) => value.episodicStrategyId !== value.preferenceStrategyId, 'strategies must be distinct');
const authorizationFields = { epoch: z.string().uuid(), at: z.string().datetime(), scope: z.string().regex(/^[a-f0-9]{64}$/) };
// V1 is readable only so old config/provenance remains inspectable and held manual.
export const authorizationSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), ...authorizationFields }).strict(),
  z.object({ version: z.literal(2), ...authorizationFields, project: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
export type AutoAuthorization = z.infer<typeof authorizationSchema>;
export type AgentCoreConfig = z.infer<typeof agentCoreConfigSchema> & {
  /** Derived only by the project registry; never accepted at the global root. */
  authorization?: AutoAuthorization;
  autoProblem?: string;
  projectOverride?: boolean;
};
export const AGENTCORE_CLI_PATH_NOTICE = 'agentCoreMemory.cliPath is deprecated and ignored; runtime memory uses the AWS SDK. Remove cliPath from your private config; retain all other memory settings.';

export function parseAgentCoreConfig(value: unknown): AgentCoreConfig | undefined {
  if (value === undefined || value === false) return undefined;
  const result = agentCoreConfigSchema.safeParse(value);
  if (!result.success) throw new Error('agentCoreMemory: invalid configuration; use enabled:true, region, memoryId, distinct strategy IDs and opaque actorId; upload is off, manual or project-authorized auto.');
  return result.data;
}
export function scopeFor(config: AgentCoreConfig, root: string) {
  const projectId = projectIdentity(root, config.projectId);
  const project = `/users/${config.actorId}/projects/${projectId}/strategy/${config.episodicStrategyId}/`;
  return { projectId, project, episodes: `${project}sessions/`, preferences: `/users/${config.actorId}/strategy/${config.preferenceStrategyId}/preferences/` };
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
