/** Child-process fixture for last-resort process-group cleanup. */
import { readFile, rm } from 'node:fs/promises';

import { BackgroundBashManager } from '../src/tools/background-bash.js';

const [mode = 'exit', root = '/tmp/darwin-background-exit-probe'] = process.argv.slice(2);
await rm(root, { recursive: true, force: true });
const manager = new BackgroundBashManager(root, 'probe-session');
const leaderFile = `${root}/leader.pid`;
const childFile = `${root}/child.pid`;
await manager.start(`echo $$ > ${leaderFile}; sleep 1000 & echo $! > ${childFile}; wait`);

const deadline = Date.now() + 2_000;
while (Date.now() < deadline) {
  try {
    if ((await readFile(leaderFile, 'utf8')).trim() && (await readFile(childFile, 'utf8')).trim()) break;
  } catch {
    // Shell has not written both process ids yet.
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}
console.log('READY');

switch (mode) {
  case 'exit':
    process.exit(0);
    break;
  case 'signal':
    await new Promise(() => undefined);
    break;
  case 'shutdown':
    await manager.shutdown();
    break;
  case 'forced':
    setTimeout(() => process.exit(0), 50).unref();
    await new Promise(() => undefined);
    break;
  default:
    throw new Error(`unknown probe mode ${mode}`);
}
