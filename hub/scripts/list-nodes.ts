/**
 * `pnpm list-nodes [--prune]`: enrolled nodes with status and fingerprint, plus connection counts
 * verified against API Gateway (`$disconnect` is best-effort, so a row alone is not a live
 * connection). `--prune` removes stale and expired rows and their endpoints.
 */
import { shortFingerprint } from '../../src/collaboration/hub-wire.js';
import { connectionStatus } from '../src/handlers.js';
import { operatorContext } from './operator.js';

const prune = process.argv.slice(2).includes('--prune');
const { ctx } = operatorContext();
const connections = await connectionStatus(ctx, prune);
const count = (node: string, live: boolean) => connections.filter(c => c.node === node && (c.state === 'live') === live).length;
const rows = (await ctx.store.listNodes()).sort((a, b) => a.enrolledAt - b.enrolledAt).map(node => ({
  node: node.node, name: node.name, status: node.status, fingerprint: shortFingerprint(node.fingerprint),
  enrolledAt: new Date(node.enrolledAt).toISOString(), ...(node.revokedAt ? { revokedAt: new Date(node.revokedAt).toISOString() } : {}),
  liveConnections: count(node.node, true),
  ...(count(node.node, false) ? { staleConnections: count(node.node, false) } : {}),
}));
console.log(JSON.stringify(rows, null, 2));
const stale = connections.filter(c => c.state !== 'live');
if (stale.length) {
  console.log(`\n${stale.length} stale connection row(s) (socket gone or past two hours): ${stale.map(c => `${c.connectionId} [${c.state}, ${c.endpoints} endpoint(s)]`).join(', ')}`);
  console.log(prune ? 'Pruned: rows and their endpoints removed.' : 'Not counted as live. Remove with: pnpm list-nodes --prune');
}
