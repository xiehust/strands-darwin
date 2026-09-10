/** OPT-IN ONLY. Synthetic data in an explicitly supplied disposable Memory resource.
 * AGENTCORE_DISPOSABLE_CONFIG=/absolute/config.json AGENTCORE_ALLOW_SYNTHETIC_UPLOAD=yes
 * pnpm tsx spike/verify-agentcore-memory-live.ts
 * Config is the agentCoreMemory object, including manual upload and a synthetic actorId.
 * No resource provisioning/deletion; source event and eventual LTM remain for the owner to clean up.
 */
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseAgentCoreConfig } from '../src/agentcore/config.js';
import { CloudMemory } from '../src/agentcore/controller.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
import { ownPrivateHome } from './shared.js';
import { Agent, AgentResult, AgentResultEvent, Message } from '@strands-agents/sdk';
const filename = process.env['AGENTCORE_DISPOSABLE_CONFIG'];
if (!filename || !path.isAbsolute(filename) || process.env['AGENTCORE_ALLOW_SYNTHETIC_UPLOAD'] !== 'yes') {
  console.log('SKIP: no explicitly authorized disposable AgentCore resource; live behavior NOT verified.');
} else {
  const config = parseAgentCoreConfig(JSON.parse(await readFile(filename, 'utf8')));
  if (!config || config.upload !== 'manual' || !config.actorId.startsWith('synthetic-')) throw new Error('Use enabled config, upload:manual and a synthetic- actor in a disposable resource');
  const home = ownPrivateHome('agentcore-live'); const root = path.join(home, 'synthetic-project'); await mkdir(root);
  const session = `synthetic-${Date.now()}`; const memory = new CloudMemory(config, root, session);
  await memory.cli.requireExtraction();
  const file = path.join(home, 'synthetic-trajectory.jsonl');
  const recorder = new TrajectoryRecorder({ file, run: { session, agentId: 'darwin', darwinVersion: 'test', provider: 'offline', model: 'none', permissionMode: 'plan', thinkingEffort: undefined, resumed: false, restoredMessages: 0 }, onTurnSettled: settlement => memory.settle(settlement, file) });
  const turn = recorder.beginTurn('Synthetic test: arrange three colored blocks.'); await turn?.inputDurable();
  const agent = new Agent({ model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
  turn?.record(new AgentResultEvent({ agent, invocationState: {}, result: new AgentResult({ invocationState: {}, stopReason: 'endTurn', lastMessage: new Message({ role: 'assistant', content: [] }) }) }));
  turn?.end(); await recorder.close();
  try {
    const token = (await memory.command('pending')).split(' ')[0]!;
    const preview = await memory.command(`preview ${token}`, 'user'); console.log(preview);
    const hash = preview.match(/send [a-f0-9]{64} ([a-f0-9]{64})/)?.[1]; if (!hash) throw new Error('Synthetic preview unavailable');
    const sent = await memory.command(`send ${token} ${hash}`, 'user'); console.log(sent);
    if (!sent.startsWith('AWS event accepted.')) throw new Error('Synthetic event not accepted');
    console.log(JSON.stringify(await memory.recall('episode', 'Arrange three colored blocks', 2), null, 2));
    console.log(JSON.stringify(await memory.recall('reflection', 'Ordering synthetic colored blocks', 2), null, 2));
    console.log('Transport acceptance checked only. No episode/reflection generation timing guarantee; empty retrieval does not verify extraction. Owner must clean up source events AND long-term records.');
  } finally { await memory.close(); }
}
