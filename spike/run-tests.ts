/** Runs every fast suite with a private HOME so global Darwin state cannot leak. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const suites = [
  'verify-prompt-editor.ts',
  'verify-config.ts',
  'verify-state-layers.ts',
  'verify-headless.ts',
  'verify-background-bash.ts',
  'verify-task-format.ts',
  'verify-permission-modes.ts',
  'verify-tool-hooks.ts',
  'verify-mcp-config.ts',
  'verify-skills.ts',
  'verify-custom-commands.ts',
  'verify-subagents.ts',
  'verify-agents-md.ts',
  'verify-system-prompt.ts',
  'verify-prompt-cache.ts',
  'verify-usage.ts',
  'verify-compact.ts',
  'verify-max-tokens-recovery.ts',
  'verify-thinking.ts',
  'verify-model-command.ts',
] as const;

for (const suite of suites) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'darwin-test-home-'));
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, suite)], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, HOME: home },
      stdio: 'inherit',
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
