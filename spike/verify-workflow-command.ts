/**
 * The `/workflow` built-in — a prompt-style trigger for the workflow DAG tool.
 *
 * No model calls and no runtime: the command is a pure expansion, so parse,
 * template, registration, and built-in reservation are all checkable directly.
 * Run: pnpm tsx spike/verify-workflow-command.ts
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BUILTIN_COMMAND_NAMES,
  COMMANDS_DIRNAME,
  builtinCommandDescription,
  loadCustomCommands,
} from '../src/commands/custom-commands.js';
import {
  WORKFLOW_COMMAND_NAME,
  WORKFLOW_COMMAND_USAGE,
  parseWorkflowCommand,
} from '../src/commands/workflow-command.js';
import { darwinDir } from '../src/paths.js';
import { assert, header, report } from './shared.js';

function parsing(): void {
  header('/workflow — parse grammar');

  assert('non-command prose passes through', parseWorkflowCommand('workflow this please') === null);
  assert('another slash command passes through', parseWorkflowCommand('/status') === null);
  assert('a prefixed name is not the command', parseWorkflowCommand('/workflows do it') === null);
  assert('prose containing the command is not the command',
    parseWorkflowCommand('please /workflow this') === null);

  assert('bare /workflow is a missing task', parseWorkflowCommand('/workflow') === 'missing-task');
  assert('whitespace-only arguments are a missing task',
    parseWorkflowCommand('/workflow   \t ') === 'missing-task');
  assert('surrounding whitespace does not change the bare form',
    parseWorkflowCommand('  /workflow  ') === 'missing-task');

  const expanded = parseWorkflowCommand('/workflow refactor the parser and update its docs');
  const mixedCase = parseWorkflowCommand('/WorkFlow do the thing');
  assert('a task expands', expanded !== null && expanded !== 'missing-task');
  assert('the name match is case-insensitive, like custom commands',
    mixedCase !== null && mixedCase !== 'missing-task');
}

function template(): void {
  header('/workflow — expansion template');

  const task = 'refactor the parser and update its docs';
  const result = parseWorkflowCommand(`/workflow ${task}`);
  const message = result !== null && result !== 'missing-task' ? result.message : '';

  assert('the expansion names the workflow tool', message.includes('`workflow` tool'));
  assert('the task description is embedded verbatim under the Task marker',
    message.includes(`Task: ${task}`));
  assert('the DAG node bound is restated', message.includes('at most 8'));
  assert('the reads-parallel / writes-serialized rule is restated',
    message.includes('parallel branches are for reads only') && message.includes('serialize writes by edges'));
  assert('the SER-065 writeScopes declaration is restated for writing nodes',
    message.includes('writeScopes') && message.includes('project-relative path prefixes'));
  assert('the indivisible-task escape hatch is present', message.includes('handle it directly'));
  assert('the usage notice names the command and its argument',
    WORKFLOW_COMMAND_USAGE.includes('/workflow') && WORKFLOW_COMMAND_USAGE.includes('<task description>'));
}

function registration(): void {
  header('/workflow — built-in registration');

  assert('the name constant is the registered built-in', WORKFLOW_COMMAND_NAME === 'workflow');
  assert('BUILTIN_COMMAND_NAMES contains workflow',
    (BUILTIN_COMMAND_NAMES as readonly string[]).includes('workflow'));
  const description = builtinCommandDescription('workflow');
  assert('the completion row has a non-empty one-line description',
    typeof description === 'string' && description.trim() !== '' && !description.includes('\n'));
}

async function reservation(): Promise<void> {
  header('/workflow — reserved against custom commands');

  const root = '/tmp/darwin-workflow-command-test';
  const commandsRoot = path.join(darwinDir(root), COMMANDS_DIRNAME);
  await rm(root, { recursive: true, force: true });
  await mkdir(commandsRoot, { recursive: true });
  await writeFile(path.join(commandsRoot, 'workflow.md'), 'shadow the built-in\n', 'utf8');

  const registry = await loadCustomCommands(root, []);
  assert('a custom command named workflow never loads',
    !registry.commands.some((command) => command.name.toLowerCase() === 'workflow'));
  assert('the collision is reported as a built-in reservation',
    registry.problems.some((problem) => problem.reason.includes('built-in command /workflow')));

  await rm(root, { recursive: true, force: true });
}

parsing();
template();
registration();
await reservation();
report();
