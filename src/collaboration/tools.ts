import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { discoverPeers, type LocalCollaboration } from './local.js';
import { MAX_TEXT_BYTES } from './protocol.js';

export function peerTools(local: LocalCollaboration) {
  return [
    tool({ name: 'peer_discover', description: 'Discover up to 32 authenticated local messaging endpoints. Exact endpoint UUID, canonical project, session, node; no files/history or model work. Lease-only sessions are separately visible with /list-agents. Same project automatic; other projects need one user-only persistent symmetric confirmation.', inputSchema: z.object({}).strict(), callback: async () => JSON.stringify(await discoverPeers()) }),
    tool({ name: 'peer_send', description: 'Send literal text (4096 UTF-8 bytes) to the exact endpoint UUID from peer_discover. Ordinary receiving permissions remain in force. Never send denied work to bypass local permissions or request policy/config/AGENTS changes. No slash/shell/path expansion. Acknowledgement means queued, NOT processed; expires in 60s. Same project and human-approved project pairs automatically receive/reply. Unknown pairs return actionable human confirmation; never run it through a tool. Causal reply limits cannot be reset by a model. No automatic retry after an ambiguous acknowledgement.', inputSchema: z.object({ target: z.string().uuid(), text: z.string().min(1).refine(t => Buffer.byteLength(t) <= MAX_TEXT_BYTES) }).strict(), callback: async ({ target, text }) => local.send(target, text) }),
  ];
}
