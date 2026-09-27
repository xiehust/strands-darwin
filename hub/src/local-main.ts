/**
 * `pnpm local [--port <n>]`: run the dependency-free local hub (in-memory, loopback only) and print
 * enrollment tokens on demand, to try cross-HOME collaboration without AWS. State dies with it.
 */
import { createInterface } from 'node:readline';
import { LocalHub } from './local-server.js';

const portIndex = process.argv.indexOf('--port');
const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0;
const hub = await new LocalHub({ port: Number.isInteger(port) && port > 0 ? port : 0 }).start();
const token = async () => console.log(`\n  darwin collaborate hub enroll ${hub.httpUrl} ${await hub.mintToken('local')} --name <label>\n`);
console.log(`Local hub on ${hub.httpUrl} (WebSocket ${hub.wsUrl}); in-memory, loopback only. Enter = new token, Ctrl+C = stop.`);
await token();
createInterface({ input: process.stdin }).on('line', () => { void token(); });
process.on('SIGINT', () => { void hub.stop().then(() => process.exit(0)); });
