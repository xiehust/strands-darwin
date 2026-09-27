/** `pnpm revoke-node <nodeId>`: mark revoked, close its connections, broadcast node-revoked. A revoked id never returns. */
import { uuidSchema } from '../../src/collaboration/hub-wire.js';
import { revoke } from '../src/handlers.js';
import { operatorContext } from './operator.js';

const node = uuidSchema.safeParse(process.argv[2]);
if (!node.success) { console.error('usage: pnpm revoke-node <nodeId>'); process.exit(1); }
const { ctx } = operatorContext();
const result = await revoke(ctx, node.data);
console.log(JSON.stringify({ node: node.data, ...result }, null, 2));
if (!result.revoked) console.log('Nothing revoked: the node is unknown or already revoked (connections were still closed if any).');
