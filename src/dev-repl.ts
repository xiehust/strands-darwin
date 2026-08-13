/**
 * SUPERSEDED by the Ink TUI (`pnpm start` / `src/cli.ts`). Kept for debugging.
 *
 * Still useful when the TUI's rendering is the thing under suspicion: this drives
 * the same `AgentRuntime` through plain readline and line-by-line output, so a
 * problem that reproduces here is in the agent layer, not in Ink.
 *
 * Run: pnpm dev-repl            (new session)
 *      pnpm dev-repl --resume   (continue the previous session)
 */
import { createInterface, type Interface } from 'node:readline/promises';
import process from 'node:process';

import { AGENTS_FILENAME } from './agent/instructions.js';
import { AgentRuntime } from './agent/runtime.js';
import type { PermissionRequest } from './agent/permission.js';
import { ConfigError } from './config.js';
import { MCP_CONFIG_FILENAME } from './mcp/registry.js';
import { DARWIN_DIRNAME } from './paths.js';

const DETAIL_MAX_LINES = 12;
const DETAIL_MAX_CHARS = 800;

/** Signals that stdin reached EOF, so the session should end. */
class InputClosedError extends Error {}

/**
 * Owns the process's single readline interface.
 *
 * Created lazily on first question rather than up front: with piped (non-TTY)
 * stdin, EOF arrives while the agent is still initializing, which would close an
 * already-open interface before the first prompt is ever shown.
 */
class Prompter {
  private rl: Interface | undefined;
  private closed = false;

  ask(query: string): Promise<string> {
    if (this.closed) return Promise.reject(new InputClosedError('stdin closed'));

    if (this.rl === undefined) {
      this.rl = createInterface({ input: process.stdin, output: process.stdout });
      this.rl.on('close', () => {
        this.closed = true;
      });
    }

    return this.rl.question(query).catch(() => {
      // readline rejects once the stream has ended; treat that as EOF.
      this.closed = true;
      throw new InputClosedError('stdin closed');
    });
  }

  close(): void {
    this.rl?.close();
    this.closed = true;
  }
}

/**
 * Serializes prompts through the shared interface. Concurrent tool calls would
 * otherwise race for stdin and both read the same keystroke.
 */
function createReadlineBridge(prompter: Prompter) {
  let queue: Promise<unknown> = Promise.resolve();

  return async (request: PermissionRequest): Promise<boolean> => {
    const task = queue.then(async () => {
      console.log(`\n  ┌─ permission required ─ ${request.kind}`);
      console.log(`  │ ${request.summary}`);
      for (const detail of request.details) {
        console.log(`  │`);
        console.log(`  │ ${detail.label}:`);
        for (const line of clip(detail.value)) console.log(`  │   ${line}`);
      }
      console.log(`  └─`);

      try {
        const answer = await prompter.ask('  allow? [y/N] ');
        return /^(y|yes)$/i.test(answer.trim());
      } catch (error) {
        // Nobody can answer anymore, so deny rather than silently allowing.
        if (error instanceof InputClosedError) return false;
        throw error;
      }
    });
    queue = task.catch(() => undefined);
    return task;
  };
}

/** Keeps a long file body or command from flooding the terminal. */
function clip(value: string): string[] {
  const truncated = value.length > DETAIL_MAX_CHARS;
  const body = truncated ? value.slice(0, DETAIL_MAX_CHARS) : value;
  const lines = body.split('\n');
  const clipped = lines.slice(0, DETAIL_MAX_LINES);

  if (lines.length > DETAIL_MAX_LINES) {
    clipped.push(`… ${lines.length - DETAIL_MAX_LINES} more line(s)`);
  } else if (truncated) {
    clipped.push('…');
  }
  return clipped;
}

/** Renders one turn: streaming text plus tool-call activity. */
async function renderTurn(runtime: AgentRuntime, input: string): Promise<void> {
  let streamingText = false;

  for await (const event of runtime.send(input)) {
    switch (event.type) {
      case 'modelStreamUpdateEvent': {
        if (
          event.event.type === 'modelContentBlockDeltaEvent' &&
          event.event.delta.type === 'textDelta'
        ) {
          if (!streamingText) {
            process.stdout.write('\nagent> ');
            streamingText = true;
          }
          process.stdout.write(event.event.delta.text);
        }
        break;
      }
      case 'beforeToolCallEvent': {
        if (streamingText) {
          process.stdout.write('\n');
          streamingText = false;
        }
        console.log(`  · calling ${event.toolUse.name}`);
        break;
      }
      case 'afterToolCallEvent': {
        const status = event.result.status === 'error' ? 'failed' : 'ok';
        console.log(`  · ${event.toolUse.name} → ${status}`);
        break;
      }
      default:
        break;
    }
  }

  if (streamingText) process.stdout.write('\n');
  await runtime.markResumable();
}

async function main(): Promise<void> {
  const resume = process.argv.includes('--resume');
  const projectRoot = process.cwd();

  const prompter = new Prompter();
  let runtime: AgentRuntime | undefined;

  try {
    runtime = await AgentRuntime.create({
      projectRoot,
      resume,
      permissionBridge: createReadlineBridge(prompter),
    });

    const info = runtime.info;
    console.log('darwin dev REPL (debugging aid — `pnpm start` runs the TUI)');
    console.log(`  provider : ${info.config.provider} / ${info.config.model}`);
    console.log(`  session  : ${info.sessionId}${info.resumed ? ' (resumed)' : ' (new)'}`);
    if (info.resumed) {
      console.log(`  restored : ${runtime.messageCount} message(s) of history`);
    } else if (resume) {
      console.log('  note     : --resume given but no previous session found; started a new one');
    }
    if (info.projectInstructions !== undefined) {
      const { path: agentsPath, bytes, truncated } = info.projectInstructions;
      console.log(`  agents   : ${agentsPath} (${bytes} bytes${truncated ? ', truncated' : ''})`);
    }
    if (info.projectInstructionsProblem !== undefined) {
      console.warn(`  agents   : ${AGENTS_FILENAME} skipped — ${info.projectInstructionsProblem}`);
    }
    if (info.mcpConfigPath !== undefined) {
      console.log(`  mcp      : ${info.mcpServerCount} server(s) from ${info.mcpConfigPath}`);
    }
    if (info.mcpIgnoredConfigPath !== undefined) {
      console.warn(
        `  mcp note : ${info.mcpIgnoredConfigPath} ignored ` +
          `(${DARWIN_DIRNAME}/${MCP_CONFIG_FILENAME} takes precedence)`,
      );
    }
    if (info.skillNames.length > 0) {
      console.log(`  skills   : ${info.skillNames.join(', ')} (use /<name> to load one)`);
    }
    for (const problem of info.skillProblems) {
      console.warn(`  skill skipped: ${problem.directory} — ${problem.reason}`);
    }
    console.log(`  tools    : ${info.toolNames.join(', ')}`);
    console.log('  commands : /exit to quit\n');

    for (;;) {
      let input: string;
      try {
        input = (await prompter.ask('you> ')).trim();
      } catch (error) {
        if (error instanceof InputClosedError) break;
        throw error;
      }
      if (input === '') continue;
      if (input === '/exit' || input === '/quit') break;

      try {
        // `/skill-name` sends the skill's full text instead of the raw command.
        // Unknown slash commands fall through as ordinary input.
        const expanded = await runtime.expandSlashCommand(input);
        if (expanded !== null) {
          console.log(`  · loaded skill "${expanded.skill.name}"`);
          await renderTurn(runtime, expanded.message);
          continue;
        }
        await renderTurn(runtime, input);
      } catch (error) {
        // One failed turn should not end the session; the user may want to retry
        // or ask something else.
        console.error(`\n  turn failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\nConfiguration problem:\n  ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    prompter.close();
    // Release MCP subprocesses even if the session ended badly.
    await runtime?.shutdown();
  }
}

await main();
