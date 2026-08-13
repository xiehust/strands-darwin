#!/usr/bin/env node
/**
 * `darwin` entry point.
 *
 * Boots the agent runtime, then hands control to the Ink app.
 *
 * Usage: darwin [--resume]
 */
import { render } from 'ink';
import React from 'react';
import process from 'node:process';

import { AgentRuntime } from './agent/runtime.js';
import { ConfigError } from './config.js';
import { App } from './tui/App.js';
import { PermissionQueue } from './tui/permission-queue.js';

/** Grace period for a clean exit before the process is forced down. */
const FORCE_EXIT_AFTER_MS = 500;

async function main(): Promise<void> {
  const resume = process.argv.includes('--resume');
  const projectRoot = process.cwd();
  const permissions = new PermissionQueue();

  let runtime: AgentRuntime;
  try {
    // Runs before Ink mounts, so a startup failure prints plainly instead of
    // being wiped by the first frame.
    runtime = await AgentRuntime.create({
      projectRoot,
      resume,
      permissionBridge: permissions.bridge,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`\nConfiguration problem:\n  ${error.message}\n\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const instance = render(React.createElement(App, { runtime, permissions }), {
    // The app implements its own Ctrl+C policy: cancel the turn first, exit on
    // the second press. Ink's default would exit immediately.
    exitOnCtrlC: false,
  });

  try {
    await instance.waitUntilExit();
  } finally {
    // Release anything still blocked on a confirmation, then reap MCP children.
    permissions.close();
    await runtime.shutdown();
    forceExitIfHung();
  }
}

/**
 * Last resort: leave the process a moment to end on its own, then force it down.
 *
 * Cancelling a turn leaks the model provider's HTTP socket, which is a live libuv
 * handle, so the process would otherwise hang forever after Ctrl+C. The leak is
 * inside the SDK — `BedrockModel.stream()` sends its command without an abort
 * signal and the agent abandons the response stream on cancellation, so nothing
 * destroys the socket, and the client is private, leaving no public way to close
 * it.
 *
 * Ordering matters: this runs only after `shutdown()` has awaited MCP disconnects
 * and the bash shell, so nothing that needed to be cleaned up is skipped. The
 * timer is unref'd, so a process that can exit cleanly still does, immediately.
 */
function forceExitIfHung(): void {
  const timer = setTimeout(() => process.exit(process.exitCode ?? 0), FORCE_EXIT_AFTER_MS);
  timer.unref();
}

await main();
