/** Real IPC process fixture, no model/provider. Parent commands stand for explicit human actions. */
import { LocalCollaboration } from '../../src/collaboration/local.js';
import { discoverPeers } from '../../src/collaboration/local.js';
import { policyCommand, requestCooperation } from '../../src/collaboration/storage.js';
import { collaborationCommand } from '../../src/collaboration/command.js';
const local = new LocalCollaboration(process.argv[2]!, process.argv[3]!);
await local.start();
process.send?.({ ready: local.address, problems: local.takeNotices() });
process.on('message', async (message: { id: number; op: string; target?: string; text?: string; args?: string[]; project?: string }) => {
  try {
    let result: unknown;
    if (message.op === 'send') { local.beginHumanTurn(); result = await local.send(message.target!, message.text!); }
    else if (message.op === 'reply') { const input = local.take(); if (!input) throw new Error('No queued input'); local.beginPeerTurn(input); result = await local.send(input.envelope.sender.endpoint, message.text!); }
    else if (message.op === 'take') result = local.take() ?? null;
    else if (message.op === 'pending') result = local.pending;
    else if (message.op === 'policy') result = await policyCommand(message.args!);
    else if (message.op === 'request') result = await requestCooperation(local.project, message.project!);
    else if (message.op === 'list') result = await discoverPeers();
    else if (message.op === 'discover') result = await local.discover();
    else if (message.op === 'status') result = await collaborationCommand(local, 'status');
    else if (message.op === 'stop') { local.close('fixture shutdown'); result = local.takeNotices(); }
    else throw new Error('Unknown fixture operation');
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : 'fixture error' }); }
});
process.on('disconnect', () => { local.close('fixture disconnect'); process.exit(0); });
