import { z } from 'zod';
import path from 'node:path';
import { userDarwinDir } from './paths.js';
import { projectIdentity } from './project-identity.js';
import { readConfigBytes } from './config-file.js';
import { authorizationSchema, digest, parseAgentCoreConfig, type AgentCoreConfig } from './agentcore/config.js';

/** Explicit extensible registry: adding an override requires both schema and merge code.
 * No model/provider/permissions or resource/actor/project identity fields are registered. */
export const PROJECT_OVERRIDE_REGISTRY = {
  agentCoreMemory: z.object({
    upload: z.enum(['off', 'manual', 'auto']).optional(),
    autoDailyEvents: z.number().int().min(1).max(100000).optional(),
    autoDailyBytes: z.number().int().min(1).max(107374182400).optional(),
    authorization: authorizationSchema.optional(),
  }).strict(),
} as const;
const overrideSchema = z.object({ agentCoreMemory: PROJECT_OVERRIDE_REGISTRY.agentCoreMemory.optional() }).strict();
export type ProjectOverrides = Record<string, z.infer<typeof overrideSchema>>;
export function parseProjectOverrides(value: unknown): ProjectOverrides | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('projectOverrides must be an object');
  const entries = Object.entries(value);
  if (entries.length > 1024) throw new Error('projectOverrides exceeds 1024 projects');
  const result: ProjectOverrides = Object.create(null);
  for (const [key, entry] of entries) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('projectOverrides: invalid project identity');
    const parsed = overrideSchema.safeParse(entry);
    if (!parsed.success) throw new Error(`projectOverrides.${key}: invalid fields/types; only registered upload policy fields are allowed; repair configuration then re-confirm /cloud-memory auto`);
    result[key] = parsed.data;
  }
  return result;
}
export function cloudBinding(config: AgentCoreConfig, root: string): string {
  return digest([config.region, config.memoryId, config.actorId, projectIdentity(root, config.projectId), config.episodicStrategyId, config.preferenceStrategyId]);
}

export function effectiveCloudPolicy(global: AgentCoreConfig | undefined, overrides: ProjectOverrides | undefined, root: string): AgentCoreConfig | undefined {
  if (!global) return undefined;
  const project = projectIdentity(root); // Consent is NEVER keyed by the cloud namespace.
  const override = overrides?.[project]?.agentCoreMemory;
  const config: AgentCoreConfig = { ...global,
    ...(override?.upload === undefined ? {} : { upload: override.upload }),
    ...(override?.autoDailyEvents === undefined ? {} : { autoDailyEvents: override.autoDailyEvents }),
    ...(override?.autoDailyBytes === undefined ? {} : { autoDailyBytes: override.autoDailyBytes }),
    ...(override === undefined ? {} : { projectOverride: true }),
  };
  delete config.authorization; delete config.autoProblem;
  if (!override && global.projectId !== project && overrides?.[global.projectId ?? '']?.agentCoreMemory?.upload === 'auto') config.autoProblem = 'Legacy cloud-namespace consent is inactive; re-confirm this working tree with /cloud-memory auto';
  if (config.upload === 'auto') {
    if (override?.upload === 'auto' && override.authorization?.version === 2 && override.authorization.project === project && override.authorization.scope === cloudBinding(config, root)) config.authorization = override.authorization;
    else {
      config.upload = 'manual';
      config.autoProblem = 'Auto authorization missing or scope changed; re-confirm this project with /cloud-memory auto';
    }
  }
  return config;
}

/** Send-time local policy read only: no model construction/reconfiguration or writes. */
export async function readCloudPolicy(root: string): Promise<AgentCoreConfig | undefined> {
  const raw = await readConfigBytes(path.join(userDarwinDir(), 'config.json'));
  if (raw === undefined) return undefined;
  const record: unknown = JSON.parse(raw);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Cloud policy config invalid');
  const input = record as Record<string, unknown>;
  const config = effectiveCloudPolicy(parseAgentCoreConfig(input['agentCoreMemory']), parseProjectOverrides(input['projectOverrides']), root);
  if (config && config.upload !== 'off' && input['trajectory'] === false) throw new Error('Cloud uploads require trajectory');
  return config;
}
