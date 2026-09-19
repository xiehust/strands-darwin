/** SDK-free setup migration route; no configuration or runtime startup. */
import { localCliAnswer, usageErrorText } from './cli-usage.js';
import { applyClaudeImport, formatImportPlan, scanClaudeImport } from './import-claude.js';

export async function runImportCli(projectRoot: string, argv: readonly string[]): Promise<void> {
  const local = localCliAnswer(argv);
  if (local !== undefined) { process.stdout.write(local); return; }
  const apply = argv.includes('--apply');
  const args = argv[0] === '--apply' ? argv.slice(1) : argv.at(-1) === '--apply' ? argv.slice(0, -1) : argv;
  if (args.length !== 2 || args[0] !== '--from' || args[1] !== 'claude-code') {
    process.stderr.write(usageErrorText('usage: darwin import --from claude-code [--apply]'));
    process.exitCode = 2;
    return;
  }
  const plan = scanClaudeImport(projectRoot);
  process.stdout.write(formatImportPlan(plan));
  if (apply) {
    const result = applyClaudeImport(plan);
    process.stdout.write(result.text);
    if (result.failed) process.exitCode = 1;
  }
}
