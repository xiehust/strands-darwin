/** Local observer route: no runtime, config, provider or SDK imports. */
import { formatLocalAgents, readLocalAgents } from './list-agents.js';
import { usageErrorText } from './cli-usage.js';

export async function runListAgentsCli(args: readonly string[]): Promise<void> {
  if (args.length > 0) {
    process.stderr.write(usageErrorText('list-agents takes no arguments. Usage: darwin list-agents'));
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${formatLocalAgents(await readLocalAgents())}\n`);
}
