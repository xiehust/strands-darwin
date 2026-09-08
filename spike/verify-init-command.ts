/**
 * The `/init` built-in — a prompt-style trigger that asks the model to create or
 * improve this project's AGENTS.md.
 *
 * No model calls and no runtime: the command is a pure expansion over the
 * instructions summary the runtime already holds, so parse, template, the
 * create/improve/migrate branches, registration, built-in reservation and the
 * module's purity (no runtime import, no file-reading API) are all checkable
 * directly. Run: pnpm tsx spike/verify-init-command.ts
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_INSTRUCTIONS_BYTES } from '../src/agent/instructions.js';
import {
  BUILTIN_COMMAND_NAMES,
  COMMANDS_DIRNAME,
  builtinCommandDescription,
  loadCustomCommands,
} from '../src/commands/custom-commands.js';
import {
  INIT_COMMAND_NAME,
  parseInitCommand,
  type InitCommandContext,
} from '../src/commands/init-command.js';
import { darwinDir } from '../src/paths.js';
import { assert, header, report } from './shared.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NONE: InitCommandContext = { loaded: undefined, problemFile: undefined };
const AGENTS_LOADED: InitCommandContext = {
  loaded: { filename: 'AGENTS.md', bytes: 4096, truncated: false },
  problemFile: undefined,
};
const AGENTS_TRUNCATED: InitCommandContext = {
  loaded: { filename: 'AGENTS.md', bytes: 40_000, truncated: true },
  problemFile: undefined,
};
const CLAUDE_LOADED: InitCommandContext = {
  loaded: { filename: 'CLAUDE.md', bytes: 2048, truncated: false },
  problemFile: undefined,
};
const AGENTS_UNREADABLE: InitCommandContext = { loaded: undefined, problemFile: 'AGENTS.md' };

function message(input: string, context: InitCommandContext = NONE): string {
  return parseInitCommand(input, context)?.message ?? '';
}

function parsing(): void {
  header('/init — parse grammar');

  assert('non-command prose passes through', parseInitCommand('init the project', NONE) === null);
  assert('another slash command passes through', parseInitCommand('/status', NONE) === null);
  assert('the sibling built-in /workflow passes through', parseInitCommand('/workflow', NONE) === null);
  assert('a prefixed name is not the command', parseInitCommand('/initx', NONE) === null);
  assert('a pluralized name with arguments is not the command',
    parseInitCommand('/inits foo', NONE) === null);
  assert('prose containing the command is not the command',
    parseInitCommand('please /init this', NONE) === null);

  assert('bare /init is the trigger itself, not a usage notice',
    parseInitCommand('/init', NONE) !== null);
  assert('whitespace-only arguments are the bare form',
    message('/init   \t ') === message('/init'));
  assert('surrounding whitespace does not change the bare form',
    message('  /init  ') === message('/init'));
  assert('the name match is case-insensitive, like custom commands',
    message('/INIT') === message('/init') && message('/Init') !== '');
}

function template(): void {
  header('/init — the fixed prompt, no instructions loaded');

  const prompt = message('/init');
  assert('the create variant names AGENTS.md at the project root',
    prompt.includes('create `AGENTS.md` at the project root'));
  assert('it asks for the build, test and typecheck commands',
    prompt.includes('build, test and typecheck commands'));
  assert('it asks for layout and conventions',
    prompt.includes('directory layout') && prompt.includes('conventions'));
  assert('it names every instruction source to consult',
    ['`CLAUDE.md`', '`.cursorrules`', '`.cursor/rules/`', '`.github/copilot-instructions.md`']
      .every((source) => prompt.includes(source)));
  assert('it states the 32 KiB hard cap from the imported constant',
    prompt.includes(`${MAX_INSTRUCTIONS_BYTES / 1024} KiB (${MAX_INSTRUCTIONS_BYTES} bytes)`) &&
    prompt.includes('32 KiB') && prompt.includes('hard cap'));
  assert('and asks for a target well below it', prompt.includes('aim well below'));
  assert('it says darwin preloads AGENTS.md into every request',
    prompt.includes('preloads `AGENTS.md`') && prompt.includes('every request'));
  assert('it states the CLAUDE.md fallback exactly',
    prompt.includes('falls back to `CLAUDE.md` only when there is no `AGENTS.md`'));
  assert('it says the file is written with the ordinary file editor',
    prompt.includes('ordinary file editor'));
  assert('it never mentions improving in place when nothing is loaded',
    !prompt.includes('improve that file in place'));
  assert('bare /init carries no Focus marker', !prompt.includes('Focus:'));
  assert('the prompt asks for nothing a typed prompt could not',
    !/\bsudo\b|\brm -rf\b|\bgit push\b/.test(prompt));
}

function branches(): void {
  header('/init — create, improve and migrate variants from the runtime summary');

  const improve = message('/init', AGENTS_LOADED);
  assert('a loaded AGENTS.md is improved in place',
    improve.includes('darwin loaded `AGENTS.md` (4096 bytes)') &&
    improve.includes('improve that file in place'));
  assert('the improve variant keeps what is still true and never overwrites wholesale',
    improve.includes('keep everything that is still true') && improve.includes('never overwrite it wholesale'));
  assert('the improve variant does not ask to create the file',
    !improve.includes('create `AGENTS.md` at the project root'));
  assert('an untruncated file gets no over-cap remark', !improve.includes('is being truncated'));

  const truncated = message('/init', AGENTS_TRUNCATED);
  assert('a truncated AGENTS.md is told to come back under the cap',
    truncated.includes('is being truncated') && truncated.includes('bring it back under'));

  const migrate = message('/init', CLAUDE_LOADED);
  assert('a loaded CLAUDE.md creates AGENTS.md from it',
    migrate.includes('darwin loaded `CLAUDE.md` (2048 bytes)') &&
    migrate.includes('Create `AGENTS.md` at the project root, carrying over the still-true content of `CLAUDE.md`'));
  assert('and leaves CLAUDE.md untouched', migrate.includes('leave `CLAUDE.md` untouched'));
  assert('and explains that @path imports are not expanded',
    migrate.includes('`@path` import lines are not expanded by darwin'));
  assert('the migrate variant never improves CLAUDE.md in place',
    !migrate.includes('improve that file in place'));

  const unreadable = message('/init', AGENTS_UNREADABLE);
  assert('a present-but-unreadable file is inspected first and never replaced',
    unreadable.includes('`AGENTS.md` is present at the project root, but darwin could not read it') &&
    unreadable.includes('never delete or replace it'));
  assert('the unreadable variant does not ask to create the file',
    !unreadable.includes('create `AGENTS.md` at the project root'));

  const common = [message('/init'), improve, migrate, unreadable];
  assert('every variant states the cap, the preload and the fallback',
    common.every((prompt) =>
      prompt.includes('32 KiB') &&
      prompt.includes('preloads `AGENTS.md`') &&
      prompt.includes('falls back to `CLAUDE.md` only when there is no `AGENTS.md`') &&
      prompt.includes('ordinary file editor')));
}

function focus(): void {
  header('/init — focus');

  const focused = message('/init add the release process');
  assert('a focus is the bare prompt plus one Focus marker',
    focused === `${message('/init')}\n\nFocus: add the release process`);
  assert('the focus is embedded verbatim, at the end', focused.endsWith('Focus: add the release process'));
  assert('a focus with surrounding whitespace is trimmed, its inside kept',
    message('/init   keep  the   spacing ').endsWith('Focus: keep  the   spacing'));
  assert('the focus rides along with the improve variant',
    message('/init add the release process', AGENTS_LOADED).endsWith('Focus: add the release process') &&
    message('/init add the release process', AGENTS_LOADED).includes('improve that file in place'));
}

function registration(): void {
  header('/init — built-in registration');

  assert('the name constant is the registered built-in', INIT_COMMAND_NAME === 'init');
  assert('BUILTIN_COMMAND_NAMES contains init',
    (BUILTIN_COMMAND_NAMES as readonly string[]).includes('init'));
  const names = BUILTIN_COMMAND_NAMES as readonly string[];
  assert('the display order stays alphabetical', [...names].sort().join(',') === names.join(','));
  const description = builtinCommandDescription('init');
  assert('the completion row has a non-empty one-line description',
    typeof description === 'string' && description.trim() !== '' && !description.includes('\n'));
}

async function reservation(): Promise<void> {
  header('/init — reserved against custom commands');

  const root = '/tmp/darwin-init-command-test';
  const commandsRoot = path.join(darwinDir(root), COMMANDS_DIRNAME);
  await rm(root, { recursive: true, force: true });
  await mkdir(commandsRoot, { recursive: true });
  await writeFile(path.join(commandsRoot, 'init.md'), 'shadow the built-in\n', 'utf8');

  const registry = await loadCustomCommands(root, []);
  assert('a custom command named init never loads',
    !registry.commands.some((command) => command.name.toLowerCase() === 'init'));
  assert('the collision is reported as a built-in reservation',
    registry.problems.some((problem) => problem.reason.includes('built-in command /init')));

  await rm(root, { recursive: true, force: true });
}

async function purity(): Promise<void> {
  header('/init — the module is pure');

  const source = await readFile(path.join(REPO_ROOT, 'src', 'commands', 'init-command.ts'), 'utf8');
  const readers = ['readFile', 'createReadStream', 'readFileSync', 'open(', 'opendir', 'readdir', 'stat('];
  assert('the module imports no file-reading API',
    readers.every((reader) => !source.includes(reader)));
  assert('and nothing from node:fs at all', !source.includes("'node:fs"));
  assert('the module imports nothing from the runtime',
    !source.includes('runtime.js') && !source.includes('AgentRuntime'));
  assert('the cap is the imported constant, not a copied number',
    source.includes('MAX_INSTRUCTIONS_BYTES') && !/32\s*\*\s*1024|32768/.test(source));
}

parsing();
template();
branches();
focus();
registration();
await reservation();
await purity();
report();
