/**
 * Filesystem and expansion checks for project-defined Markdown slash commands.
 *
 * No model calls: this covers discovery, collision, and interpolation directly.
 * Run: pnpm tsx spike/verify-custom-commands.ts
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  BUILTIN_COMMAND_DESCRIPTIONS,
  BUILTIN_COMMAND_NAMES,
  COMMANDS_DIRNAME,
  builtinCommandDescription,
  expandCustomCommand,
  loadCustomCommands,
  type CustomCommandRegistry,
} from '../src/commands/custom-commands.js';
import { darwinDir } from '../src/paths.js';
import { assert, header, report } from './shared.js';

const TMP_ROOT = '/tmp/darwin-custom-commands-test';
const COMMANDS_ROOT = path.join(darwinDir(TMP_ROOT), COMMANDS_DIRNAME);

async function buildFixture(): Promise<string> {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(path.join(COMMANDS_ROOT, 'nested'), { recursive: true });

  await writeFile(
    path.join(COMMANDS_ROOT, 'review.md'),
    'Review $ARGUMENTS. Then review $ARGUMENTS again.\n',
    'utf8',
  );
  await writeFile(path.join(COMMANDS_ROOT, 'plain.MD'), 'Use this prompt unchanged.\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'notes.txt'), 'not a command\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'nested', 'hidden.md'), 'nested\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'exit.md'), 'shadow built-in\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'quit.md'), 'shadow alias\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'PDF-FORMS.md'), 'shadow skill\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'bad name.md'), 'bad name\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'empty.md'), '  \n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'same.md'), 'first\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'SAME.md'), 'second\n', 'utf8');

  const unreadable = path.join(COMMANDS_ROOT, 'unreadable.md');
  await writeFile(unreadable, 'cannot read\n', 'utf8');
  await chmod(unreadable, 0o000);
  return unreadable;
}

async function discovery(): Promise<CustomCommandRegistry> {
  header('custom commands — discovery and collisions');
  const unreadable = await buildFixture();
  const registry = await loadCustomCommands(TMP_ROOT, ['pdf-forms']);
  await chmod(unreadable, 0o600);

  const names = registry.commands.map((command) => command.name);
  const reasons = registry.problems.map((problem) => problem.reason);
  console.log(`  commands : ${JSON.stringify(names)}`);
  console.log(`  problems : ${JSON.stringify(reasons)}`);

  assert('discovers direct Markdown files', names.includes('review') && names.includes('plain'));
  assert('accepts a case-insensitive .md extension', names.includes('plain'));
  assert('ignores non-Markdown files', !names.includes('notes'));
  assert('ignores nested command files', !names.includes('hidden'));
  assert('reserves built-in names', reasons.some((reason) => reason.includes('built-in command /exit')));
  assert('reserves the unadvertised /quit alias', reasons.some((reason) => reason.includes('built-in command /quit')));
  assert('skills win case-insensitive collisions', reasons.some((reason) => reason.includes('skill /pdf-forms')));
  assert('rejects names outside the slash grammar', reasons.some((reason) => reason.includes('must contain only')));
  assert('rejects empty command files', reasons.some((reason) => reason.includes('file is empty')));
  assert('keeps only one case-insensitive duplicate', names.filter((name) => name.toLowerCase() === 'same').length === 1);
  assert('reports the duplicate owner', reasons.some((reason) => reason.includes('conflicts with')));
  assert('isolates an unreadable file', reasons.some((reason) => reason.includes('could not read file')));
  assert('sorts accepted commands by name', names.join(',') === [...names].sort((a, b) => a.localeCompare(b)).join(','));
  return registry;
}

function expansion(registry: CustomCommandRegistry): void {
  header('custom commands — argument expansion');

  const bare = expandCustomCommand(registry, '/review');
  const args = expandCustomCommand(registry, '/review focus on auth');
  const mixedCase = expandCustomCommand(registry, '/REVIEW one thing');
  const plain = expandCustomCommand(registry, '/plain extra words');

  assert('bare command expands', bare?.command.name === 'review');
  assert('bare command replaces every placeholder with empty text', bare?.message === 'Review . Then review  again.\n');
  assert('arguments replace every placeholder', args?.message === 'Review focus on auth. Then review focus on auth again.\n');
  assert('lookup is case-insensitive', mixedCase?.message.includes('one thing') === true);
  assert('content without a placeholder is unchanged', plain?.message === 'Use this prompt unchanged.\n');
  assert('unknown slash input passes through', expandCustomCommand(registry, '/unknown') === null);
  assert('plain prose is not a command', expandCustomCommand(registry, 'please /review this') === null);
}

async function missingDirectory(): Promise<void> {
  header('custom commands — absent directory');
  const registry = await loadCustomCommands('/tmp/darwin-custom-commands-missing', []);
  assert('absence is silent', registry.commands.length === 0 && registry.problems.length === 0);
}

function completionDescriptions(): void {
  header('custom commands — built-in completion descriptions');
  assert('every built-in has a non-empty one-line description',
    BUILTIN_COMMAND_NAMES.every((name) => {
      const description = builtinCommandDescription(name);
      return typeof description === 'string' && description.trim() !== '' && !description.includes('\n');
    }));
  assert('the map carries no entries beyond the built-ins',
    Object.keys(BUILTIN_COMMAND_DESCRIPTIONS).length === BUILTIN_COMMAND_NAMES.length);
  assert('custom command and skill names get no description',
    builtinCommandDescription('review') === undefined &&
    builtinCommandDescription('commit-message') === undefined);
  assert('prototype properties are not descriptions',
    builtinCommandDescription('constructor') === undefined &&
    builtinCommandDescription('toString') === undefined);
}

const registry = await discovery();
expansion(registry);
await missingDirectory();
completionDescriptions();
await rm(TMP_ROOT, { recursive: true, force: true });
report();
