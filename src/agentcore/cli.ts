import process from 'node:process';
import { loadConfig } from '../config.js';
import { AGENTCORE_CLI_PATH_NOTICE } from './config.js';
import { CloudMemory, cloudReadArguments, CLOUD_READ_USAGE } from './controller.js';

/** Routed before runtime imports: SDK bash installs exit(0) signal handlers. */
export async function runCloudMemoryCli(root: string, args: string[]): Promise<void> {
  const input = args.join(' ');
  if (!cloudReadArguments(input)) {
    process.stderr.write(`Headless mutations unavailable; use user-submitted TUI management. ${CLOUD_READ_USAGE}\n`);
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(root);
  if (config.agentCoreMemory === undefined) {
    process.stdout.write('AgentCore: disabled (local project memory unchanged)\n');
    if (input !== '' && input !== 'status') process.exitCode = 1;
    return;
  }
  if (config.agentCoreMemory.cliPath !== undefined) process.stderr.write(`${AGENTCORE_CLI_PATH_NOTICE}\n`);
  const memory = new CloudMemory(config.agentCoreMemory, root, 'management');
  const cancel = () => { process.exitCode = 1; memory.cancel(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const result = await memory.commandResult(input);
    process.stdout.write(`${result.text}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
    await memory.close();
  }
}
