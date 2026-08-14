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
import type { AssessedPermissionRequest, PermissionDecision } from './agent/permission.js';
import { isThinkingEffort, THINKING_EFFORTS, type ThinkingPlan } from './agent/thinking.js';
import { CONFIG_FILENAME, ConfigError } from './config.js';
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

  return async (request: AssessedPermissionRequest): Promise<PermissionDecision> => {
    const task = queue.then(async () => {
      console.log(`\n  ┌─ permission required ─ ${request.kind} — ${request.riskReason}`);
      console.log(`  │ ${request.summary}`);
      for (const detail of request.details) {
        console.log(`  │`);
        console.log(`  │ ${detail.label}:`);
        for (const line of clip(detail.value)) console.log(`  │   ${line}`);
      }
      console.log(`  └─`);

      try {
        const answer = await prompter.ask('  allow? [y/N] ');
        // No "always allow" here: this driver exists for debugging the agent loop,
        // and a rule it wrote would outlive the debugging session in the config.
        return { allowed: /^(y|yes)$/i.test(answer.trim()) };
      } catch (error) {
        // Nobody can answer anymore, so deny rather than silently allowing.
        if (error instanceof InputClosedError) return { allowed: false };
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
    if (info.systemPromptSource !== 'default') {
      const origin = info.systemPromptPath ?? `${DARWIN_DIRNAME}/${CONFIG_FILENAME}`;
      console.log(`  prompt   : base system prompt overridden by ${origin}`);
    }
    if (info.systemPromptProblem !== undefined) {
      console.warn(`  prompt   : using the default — ${info.systemPromptProblem}`);
    }
    if (info.promptCache.enabled) {
      const ttl = info.promptCache.ttl === undefined ? '' : ` [${info.promptCache.ttl}]`;
      console.log(`  cache    : ${info.promptCache.parts.join(', ')}${ttl}`);
    }
    if (info.promptCache.problem !== undefined) {
      console.warn(`  cache    : off — ${info.promptCache.problem}`);
    }
    console.log(`  thinking : effort ${info.thinking.effective ?? 'none'}`);
    if (info.thinking.problem !== undefined) {
      console.warn(`  thinking : ${info.thinking.problem}`);
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
    for (const problem of info.commandProblems) {
      console.warn(`  command skipped: ${problem.file} — ${problem.reason}`);
    }
    for (const problem of info.agentProblems) {
      console.warn(`  agent skipped: ${problem.file} — ${problem.reason}`);
    }
    console.log(`  subagents: ${info.agentNames.join(', ')}`);
    console.log(`  tools    : ${info.toolNames.join(', ')}`);
    console.log('  commands : /exit to quit · /usage for token counts · /effort [level]\n');

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

      // Read straight off the SDK's meter, so asking what a session cost does not
      // itself cost a turn.
      if (input === '/usage') {
        const usage = runtime.usage;
        console.log(
          `  usage    : input ${usage.inputTokens} · cache read ${usage.cacheReadInputTokens} · ` +
            `cache write ${usage.cacheWriteInputTokens} · output ${usage.outputTokens}` +
            `${info.resumed ? ' (this run only)' : ''}\n`,
        );
        continue;
      }

      // Reconfigures the live model and remembers the level in the config file; no
      // turn is spent, and the conversation is untouched.
      if (input === '/effort' || input.startsWith('/effort ')) {
        await runEffortCommand(runtime, input);
        continue;
      }

      try {
        // Skills and project commands send their expanded prompt instead of the
        // raw command. Unknown slash commands fall through as ordinary input.
        const expanded = await runtime.expandSlashCommand(input);
        if (expanded !== null) {
          console.log(
            expanded.kind === 'skill'
              ? `  · loaded skill "${expanded.skill.name}"`
              : `  · loaded command "/${expanded.command.name}"`,
          );
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

/**
 * Reports or changes the thinking effort level.
 *
 * Awaited here, unlike in the TUI: a REPL line is a synchronous unit of work, so
 * there is no live frame to keep responsive, and reporting the outcome in order is
 * worth more than answering a millisecond sooner.
 */
async function runEffortCommand(runtime: AgentRuntime, input: string): Promise<void> {
  const argument = input.slice('/effort'.length).trim().toLowerCase();

  if (argument === '') {
    console.log(`  effort   : ${describeThinking(runtime.thinking)}\n`);
    return;
  }
  if (!isThinkingEffort(argument)) {
    console.warn(
      `  effort   : ${argument} is not a level — expected one of ${THINKING_EFFORTS.join(', ')} ` +
        `(still ${describeThinking(runtime.thinking)})\n`,
    );
    return;
  }

  const { plan, saved } = runtime.changeThinkingEffort(argument);
  try {
    await saved;
    console.log(`  effort   : ${describeThinking(plan)} — saved to ${DARWIN_DIRNAME}/${CONFIG_FILENAME}\n`);
  } catch (error) {
    console.warn(
      `  effort   : ${describeThinking(plan)}, this session only — could not write ` +
        `${DARWIN_DIRNAME}/${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** The level in force, plus the reason it is not the one that was asked for. */
function describeThinking(plan: ThinkingPlan): string {
  const level = plan.effective ?? 'none';
  return plan.problem === undefined ? level : `${level} — ${plan.problem}`;
}

await main();
