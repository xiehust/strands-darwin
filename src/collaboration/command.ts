import { randomUUID } from 'node:crypto';
import { discoverPeers, LocalCollaboration } from './local.js';
import { policyCommand, withPolicy } from './storage.js';

import { COLLABORATE_USAGE } from './grammar.js';
export { COLLABORATE_USAGE } from './grammar.js';

/** Literal user-only command. No invocation, expansion or model-granted trust. */
export async function collaborationCommand(local: LocalCollaboration, text: string): Promise<string> {
  const command = text.trim();
  const send = /^send\s+(\S+)\s+([\s\S]+)$/.exec(text.trimStart());
  if (send) {
    local.beginHumanTurn();
    return local.send(send[1]!, send[2]!);
  }
  if (command === 'list') return JSON.stringify(await discoverPeers(), null, 2);
  const result = await policyCommand((command || 'status').split(/\s+/));
  if (command === 'off') local.close('collaboration off');
  if (command === 'on') { local.close('new endpoint requested'); await local.start(); }
  return `${result}\nThis endpoint: ${JSON.stringify(local.address ?? null)}; queued: ${local.pending}\n${COLLABORATE_USAGE}`;
}

export async function runCollaborationCli(root: string, args: readonly string[]): Promise<void> {
  try {
    // CLI registration exists only for an explicit send. Read projections do not
    // create policy; first startup/on initializes it with no cross-project grants.
    if (args[0] === 'on') await withPolicy(() => undefined);
    if (args[0] === 'list') { console.log(JSON.stringify(await discoverPeers(), null, 2)); return; }
    if (args[0] !== 'send') { console.log(await policyCommand(args.length ? args : ['status'])); return; }
    if (args.length < 3) throw new Error(COLLABORATE_USAGE);
    const local = new LocalCollaboration(root, `cli-${randomUUID()}`);
    await local.start();
    try { console.log(await collaborationCommand(local, `send ${args[1]} ${args.slice(2).join(' ')}`)); }
    finally { local.close('CLI send finished'); }
  } catch (error) {
    console.error(`collaborate: ${error instanceof Error ? error.message : 'local operation failed'}`);
    process.exitCode = 1;
  }
}
