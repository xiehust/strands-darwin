/** Real hub node process fixture: one LocalCollaboration in its own HOME, no model/provider. Parent commands stand for explicit human actions. */
import { collaborationCommand } from '../../src/collaboration/command.js';
import { LocalCollaboration } from '../../src/collaboration/local.js';
import { peerPrompt, type PeerInput } from '../../src/collaboration/protocol.js';

const local = new LocalCollaboration(process.argv[2]!, process.argv[3]!);
await local.start();
let taken: PeerInput | undefined;
process.send?.({ ready: { local: local.address ?? null, hub: local.hub.address ?? null, state: local.hub.state, reason: local.hub.reason }, notices: local.takeNotices() });
process.on('message', async (message: { id: number; op: string; target?: string; text?: string }) => {
  try {
    let result: unknown;
    if (message.op === 'state') result = { state: local.hub.state, reason: local.hub.reason, hub: local.hub.address ?? null, pending: local.pending };
    else if (message.op === 'discover') result = await local.discover();
    else if (message.op === 'send') { local.beginHumanTurn(); result = await local.send(message.target!, message.text!); }
    else if (message.op === 'take') { taken = local.take(); result = taken ? { envelope: taken.envelope, prompt: peerPrompt(taken) } : null; }
    else if (message.op === 'reply') {
      if (!taken) throw new Error('No taken input');
      local.beginPeerTurn(taken);
      result = await local.send(taken.envelope.sender.endpoint, message.text!);
    }
    else if (message.op === 'validate') { if (!taken) throw new Error('No taken input'); local.validateDelivery(taken); result = 'deliverable'; }
    else if (message.op === 'notices') result = local.takeNotices();
    else if (message.op === 'command') result = await collaborationCommand(local, message.text!);
    else if (message.op === 'rotate') { local.hub.rotateNow(); result = 'rotating'; }
    else if (message.op === 'stop') { local.close('fixture shutdown'); result = local.takeNotices(); }
    else throw new Error('Unknown fixture operation');
    process.send?.({ id: message.id, result });
  } catch (error) { process.send?.({ id: message.id, error: error instanceof Error ? error.message : 'fixture error' }); }
});
process.on('disconnect', () => { local.close('fixture disconnect'); process.exit(0); });
