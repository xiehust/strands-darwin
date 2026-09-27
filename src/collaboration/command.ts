import { randomUUID } from 'node:crypto';
import { discoverPeers, LocalCollaboration } from './local.js';
import { idSchema, policyCommand } from './storage.js';
import { hubCommand, parseHubArgs } from './hub-command.js';

import { COLLABORATE_USAGE } from './grammar.js';
export { COLLABORATE_USAGE } from './grammar.js';

/** Pure preflight shared by CLI and TUI: no policy, registration or probe on bad grammar. */
function validateCommand(args: readonly string[]): void {
  const [verb, id, flag] = args;
  if (verb === 'hub') { parseHubArgs(args.slice(1)); return; }
  if (args.length === 1 && ['status', 'list', 'pending', 'relations', 'on', 'off'].includes(verb!)) return;
  if (verb === 'confirm' && args.length === 3 && flag === '--persist' && idSchema.safeParse(id).success) return;
  if (verb === 'revoke' && args.length === 2 && /^[a-f0-9]{64}$/.test(id ?? '')) return;
  if (verb === 'send' && args.length >= 3 && idSchema.safeParse(id).success) {
    const bytes = Buffer.byteLength(args.slice(2).join(' '));
    if (bytes > 0 && bytes <= 4096) return;
  }
  throw new Error(COLLABORATE_USAGE);
}

/** Literal user-only command. No invocation, expansion or model-granted trust. */
export async function collaborationCommand(local: LocalCollaboration, text: string): Promise<string> {
  const command = text.trim();
  const send = /^send\s+(\S+)\s+([\s\S]+)$/.exec(text.trimStart());
  validateCommand(send ? ['send', send[1]!, send[2]!] : (command || 'status').split(/\s+/));
  if (send) {
    local.beginHumanTurn();
    return local.send(send[1]!, send[2]!);
  }
  if (/^hub(?:\s|$)/.test(command)) return hubCommand(local, local.root, command.split(/\s+/).slice(1), false);
  if (command === 'list') return JSON.stringify(await local.discover(), null, 2);
  const result = await policyCommand((command || 'status').split(/\s+/));
  if (command === 'off') local.close('collaboration off');
  if (command === 'on') { local.close('new endpoint requested'); await local.start(); }
  const hub = `${local.hub.state}${local.hub.reason ? ` (${local.hub.reason})` : ''}${local.hub.address ? ` endpoint ${local.hub.address.endpoint}` : ''}`;
  return `${result}\nThis endpoint: ${JSON.stringify(local.address ?? null)}; queued: ${local.pending}\nHub: ${hub}\n${COLLABORATE_USAGE}`;
}

export async function runCollaborationCli(root: string, args: readonly string[]): Promise<void> {
  try {
    // CLI registration exists only for an explicit send. Read projections do not
    // create policy; first startup/on initializes it with no cross-project grants.
    validateCommand(args.length ? args : ['status']);
    if (args[0] === 'hub') { console.log(await hubCommand(undefined, root, args.slice(1), true)); return; }
    if (args[0] === 'list') { console.log(JSON.stringify(await discoverPeers(), null, 2)); return; }
    if (args[0] !== 'send') { console.log(await policyCommand(args.length ? args : ['status'])); return; }
    const local = new LocalCollaboration(root, `cli-${randomUUID()}`);
    await local.start();
    // argv already separates the target from literal text; do not reparse it as
    // TUI command whitespace and lose leading spaces/newlines in a quoted body.
    try { local.beginHumanTurn(); console.log(await local.send(args[1]!, args.slice(2).join(' '))); }
    finally { local.close('CLI send finished'); }
  } catch (error) {
    console.error(`collaborate: ${error instanceof Error ? error.message : 'local operation failed'}`);
    process.exitCode = 1;
  }
}
