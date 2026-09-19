/** Offline observer entry: deliberately no config, runtime, gate, hooks, or SDK import. */
import { usageErrorText } from './cli-usage.js';
import { candidateProblem, permissionTestReport } from './permissions-test.js';

export const PERMISSIONS_TEST_USAGE = 'usage: darwin permissions test <rule> (quote the rule as one shell argument)';

export async function runPermissionsCli(projectRoot: string, argv: readonly string[]): Promise<void> {
  if (argv.length !== 2 || argv[0] !== 'test' || argv[1]?.trim() === '') {
    process.stderr.write(usageErrorText(PERMISSIONS_TEST_USAGE));
    process.exitCode = 2;
    return;
  }
  const rule = argv[1]!;
  const problem = candidateProblem(rule);
  if (problem !== undefined) {
    process.stderr.write(usageErrorText(`permissions test: parse invalid — ${problem}`));
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${await permissionTestReport(rule, { projectRoot })}\n`);
}
