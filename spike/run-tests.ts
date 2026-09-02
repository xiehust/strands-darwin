/** Runs every fast suite with a private HOME so global Darwin state cannot leak. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const suites = [
  'verify-prompt-editor.ts',
  'verify-prompt-completion.ts',
  'verify-live-text.ts',
  'verify-frame-budget.ts',
  'verify-startup-screen.tsx',
  'verify-startup-pty.ts',
  'verify-react-production-memory.ts',
  'verify-visual-language.tsx',
  'verify-markdown.tsx',
  'verify-path-completion.ts',
  'verify-prompt-recall.ts',
  'verify-prompt-history-search.ts',
  'verify-rewind-search.ts',
  'verify-prompt-queue.ts',
  'verify-shell-command.ts',
  'verify-stream-into-static.ts',
  'verify-config.ts',
  'verify-terminal-bell.ts',
  'verify-state-layers.ts',
  'verify-headless.ts',
  'verify-headless-structured.ts',
  'verify-cli-args.ts',
  'verify-background-bash.ts',
  'verify-image-viewer.ts',
  'verify-clipboard-image.ts',
  'verify-runtime-image-input.ts',
  'verify-http-request-tool.ts',
  'verify-web-fetch.ts',
  'verify-task-format.ts',
  'verify-busy-suffix.ts',
  'verify-context-format.ts',
  'verify-context-anchor.ts',
  'verify-context-overflow.ts',
  'verify-background-tool-ui.ts',
  'verify-update-plan.tsx',
  'verify-context-offload.ts',
  'verify-permission-presentation.ts',
  'verify-edit-diff.ts',
  'verify-file-editor.ts',
  'verify-file-editor-serial.ts',
  'verify-permission-modes.ts',
  'verify-permission-mode-switch.ts',
  'verify-permissions-command.ts',
  'verify-tool-hooks.ts',
  'verify-codex-hooks.ts',
  'verify-retry-guard.ts',
  'verify-lifecycle-hooks.ts',
  'verify-mcp-config.ts',
  'verify-codegraph-preflight.ts',
  'verify-web-search-empty-results.ts',
  'verify-mcp-command.ts',
  'verify-status-command.ts',
  'verify-help-command.ts',
  'verify-skills.ts',
  'verify-self-reflection.ts',
  'verify-agent-skills.ts',
  'verify-custom-commands.ts',
  'verify-workflow-command.ts',
  'verify-subagents.ts',
  'verify-subagent-heartbeats.ts',
  'verify-workflow-tool.ts',
  'verify-subagent-format.ts',
  'verify-agents-md.ts',
  'verify-system-prompt.ts',
  'verify-working-context.ts',
  'verify-prompt-cache.ts',
  'verify-usage.ts',
  'verify-call-stats.ts',
  'verify-compact.ts',
  'verify-trajectory.ts',
  'verify-memory.ts',
  'verify-memory-tools.ts',
  'verify-memory-command.ts',
  'verify-memory-validation.ts',
  'verify-resume-recap.ts',
  'verify-stream-resumption.ts',

  'verify-export-command.ts',
  'verify-sessions-command.ts',
  'verify-clear-session.ts',
  'verify-rewind.ts',
  'verify-diagnostics.ts',
  'verify-max-tokens-recovery.ts',
  'verify-model-call-budget.ts',
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
