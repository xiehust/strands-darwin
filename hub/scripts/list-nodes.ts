/** `pnpm list-nodes`: enrolled nodes with status and fingerprint, plus live connection counts. */
import { shortFingerprint } from '../../src/collaboration/hub-wire.js';
import { operatorContext } from './operator.js';

const { ctx } = operatorContext();
const now = Date.now();
const connections = (await ctx.store.listConnections()).filter(connection => connection.expiresAt > now);
const rows = (await ctx.store.listNodes()).sort((a, b) => a.enrolledAt - b.enrolledAt).map(node => ({
  node: node.node, name: node.name, status: node.status, fingerprint: shortFingerprint(node.fingerprint),
  enrolledAt: new Date(node.enrolledAt).toISOString(), ...(node.revokedAt ? { revokedAt: new Date(node.revokedAt).toISOString() } : {}),
  liveConnections: connections.filter(connection => connection.node === node.node).length,
}));
console.log(JSON.stringify(rows, null, 2));
