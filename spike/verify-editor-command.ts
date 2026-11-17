/** SER-133 C1: exact recognition, reservation, description and complete discoverability.
 * No model/network; real command files. Run: pnpm tsx spike/verify-editor-command.ts
 */
import { strict as check } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEditorCommand } from '../src/commands/editor-command.js';
import { BUILTIN_COMMAND_NAMES, BUILTIN_COMMAND_DESCRIPTIONS, loadCustomCommands } from '../src/commands/custom-commands.js';
import { formatHelpReport, MAX_HELP_COMMANDS } from '../src/tui/help-format.js';
import { MAX_COMPLETIONS } from '../src/tui/InputBox.js';
import { computeCompletions } from '../src/tui/prompt-completion.js';

check.equal(parseEditorCommand(' \t/editor \n'), 'editor');
for (const input of ['/editor x', '/editor\narg', '/editor\targ']) check.equal(parseEditorCommand(input), 'usage');
for (const input of ['/editorial', '/Editor', 'please /editor', '> /editor', '/editor/']) check.equal(parseEditorCommand(input), undefined);
const root = await mkdtemp(path.join(os.tmpdir(), 'darwin-editor-reservation-'));
try {
  const commands = path.join(root, '.darwin/commands');
  await mkdir(commands, { recursive: true });
  await writeFile(path.join(commands, 'editor.md'), 'must not shadow the human command');
  const loaded = await loadCustomCommands(root, []);
  check.ok(!loaded.commands.some(command => command.name === 'editor'));
  check.ok(loaded.problems.some(problem => problem.reason.includes('built-in command /editor')));
  check.equal(BUILTIN_COMMAND_NAMES.length, 34);
  check.ok(MAX_COMPLETIONS >= BUILTIN_COMMAND_NAMES.length);
  check.ok(MAX_HELP_COMMANDS >= BUILTIN_COMMAND_NAMES.length);
  check.match(BUILTIN_COMMAND_DESCRIPTIONS.editor, /blank.*unsent.*idle TUI/);
  const help = formatHelpReport();
  const completions = computeCompletions('/', BUILTIN_COMMAND_NAMES).slice(0, MAX_COMPLETIONS);
  for (const name of BUILTIN_COMMAND_NAMES) {
    check.ok(help.includes(`  /${name} — ${BUILTIN_COMMAND_DESCRIPTIONS[name]}`), name);
    check.ok(completions.includes(name), name);
  }
  check.deepEqual(computeCompletions('/editor', BUILTIN_COMMAND_NAMES), ['editor']);
} finally { await rm(root, { recursive: true, force: true }); }
console.log('SER-133 C1 parser, reservation, descriptions and every help/completion entry passed');
