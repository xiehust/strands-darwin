import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { userDarwinDir } from '../paths.js';
import { projectIdentity } from '../project-identity.js';
import { updateConfigFile } from '../config-file.js';
import { cloudBinding, effectiveCloudPolicy, parseProjectOverrides } from '../project-overrides.js';
import { parseAgentCoreConfig, type AgentCoreConfig } from './config.js';
import type { UploadTurn } from './upload-projection.js';
import type { TurnSettlement } from '../trajectory/writer.js';

/** Called only from the existing user TUI management authority. No model tool. */
export async function persistUploadMode(root: string, expected: AgentCoreConfig, mode: 'auto' | 'manual', signal: AbortSignal): Promise<AgentCoreConfig> {
  return updateConfigFile(path.join(userDarwinDir(), 'config.json'), record => {
    const global = parseAgentCoreConfig(record['agentCoreMemory']);
    if (!global || cloudBinding(global, root) !== cloudBinding(expected, root)) throw new Error('Cloud scope changed; restart and re-confirm this project');
    if (record['trajectory'] === false) throw new Error('Uploads require trajectory recording');
    const overrides = parseProjectOverrides(record['projectOverrides']) ?? Object.create(null);
    const key = projectIdentity(root);
    const prior = overrides[key] ?? {};
    overrides[key] = { ...prior, agentCoreMemory: { ...prior.agentCoreMemory, upload: mode,
      ...(mode === 'auto' ? { authorization: { version: 2, epoch: randomUUID(), at: new Date().toISOString(), scope: cloudBinding(global, root), project: key } } : {}),
    } };
    if (mode === 'manual') delete overrides[key]!.agentCoreMemory!.authorization;
    parseProjectOverrides(overrides); // Includes the bound after insertion.
    record['projectOverrides'] = overrides;
    return effectiveCloudPolicy(global, overrides, root)!;
  }, signal);
}

/** No success classifier, sensitivity filter, whitelist or omitted-percent veto. */
export function autoHoldReason(turn: UploadTurn, settlement: TurnSettlement): string | undefined {
  if (!settlement.durable) return 'Turn close not durable';
  if (settlement.failure || settlement.partial || settlement.stopReason !== 'endTurn') return 'Cancelled, incomplete or provider-failed turn; manual review required';
  if (turn.observerErrors || turn.unmatchedResults || turn.backgroundResultsDropped) return 'Serious collection loss or ambiguous pairing; manual review required';
  const integrity = turn.integrity;
  if (integrity.identityAmbiguous || integrity.lateOriginsOverflow) return 'Source identity/attribution loss; manual review required';
  if (integrity.sourceUnavailable) return 'Source collection unavailable; manual review required';
  if (integrity.unresolvedResults || integrity.resultUnavailable) return 'Missing or ambiguous results; manual review required';
  if (!integrity.completedResults) return 'No traceable action/result; management or acknowledgement-only turn';
  if (!turn.goal.retainedBytes && !integrity.lateResults) return 'No goal or traceable original late result';
  return undefined;
}
