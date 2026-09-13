/**
 * Filesystem and expansion checks for project-defined Markdown slash commands.
 *
 * No network/provider calls: real loaders, expansion, runtime and headless drivers
 * use the existing offline CaptureModel. All files/config/session state are private.
 * Run: pnpm tsx spike/verify-custom-commands.ts
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { configPath } from '../src/config.js';
import { runHeadlessTurn } from '../src/headless.js';
import { runStructuredHeadlessTurn, StructuredHeadlessWriter } from '../src/headless-protocol.js';
import { darwinDir } from '../src/paths.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('custom-commands');
const TMP_ROOT = path.join(HOME, 'project');
const COMMANDS_ROOT = path.join(darwinDir(TMP_ROOT), COMMANDS_DIRNAME);
const PLAIN_CONTENT = ' \t检查 café 🧬\r\nKeep $1, $arguments and @file literal.\n  \n';
const LITERAL_ARGS = `路径/文件.ts  "two words"\n$ARGUMENTS $1 \\tail $(touch ${TMP_ROOT}/executed) !\`touch ${TMP_ROOT}/executed\``;

async function buildFixture(): Promise<string> {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(path.join(COMMANDS_ROOT, 'nested'), { recursive: true });

  await writeFile(
    path.join(COMMANDS_ROOT, 'review.md'),
    'Review $ARGUMENTS. Then review $ARGUMENTS again.\n',
    'utf8',
  );
  await writeFile(path.join(COMMANDS_ROOT, 'plain.MD'), PLAIN_CONTENT, 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'notes.txt'), 'not a command\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'nested', 'hidden.md'), 'nested\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'exit.md'), 'shadow built-in\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'init.md'), 'shadow the prompt-style built-in\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'quit.md'), 'shadow alias\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'PDF-FORMS.md'), 'shadow skill\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'bad name.md'), 'bad name\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'empty.md'), '  \n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'same.md'), 'first\n', 'utf8');
  await writeFile(path.join(COMMANDS_ROOT, 'SAME.md'), 'second\n', 'utf8');

  const unreadable = path.join(COMMANDS_ROOT, 'unreadable.md');
  await writeFile(unreadable, 'cannot read\n', 'utf8');
  await chmod(unreadable, 0o000);

  const linkedTarget = path.join(TMP_ROOT, 'linked-command.md');
  await writeFile(linkedTarget, 'Linked command.\n');
  await symlink(linkedTarget, path.join(COMMANDS_ROOT, 'linked.md'));
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
  assert('direct symlinked Markdown commands resolve to regular files', names.includes('linked'));

  assert('ignores non-Markdown files', !names.includes('notes'));
  assert('ignores nested command files', !names.includes('hidden'));
  assert('reserves built-in names', reasons.some((reason) => reason.includes('built-in command /exit')));
  assert('reserves the prompt-style built-in /init',
    !names.includes('init') && reasons.some((reason) => reason.includes('built-in command /init')));
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
  assert('placeholder-free content retains every byte before two newlines and args',
    plain?.message === `${PLAIN_CONTENT}\n\nextra words`);
  assert('loader retains leading/trailing whitespace, CRLF and Unicode',
    plain?.command.content === PLAIN_CONTENT);
  for (const input of ['/plain', ' /PLAIN \t\r\n ']) {
    assert('placeholder-free bare/whitespace args return original bytes',
      expandCustomCommand(registry, input)?.message === PLAIN_CONTENT);
  }
  assert('placeholder whitespace-only args behave like no args',
    expandCustomCommand(registry, '/review \t\n')?.message === bare?.message);
  assert('fallback keeps multiline Unicode, shell/placeholder-looking args and internal spaces literal',
    expandCustomCommand(registry, ` \t/PLAIN \t${LITERAL_ARGS}\n `)?.message === `${PLAIN_CONTENT}\n\n${LITERAL_ARGS}`);
  assert('repeated replacement is nonrecursive and keeps shell-looking args as text',
    expandCustomCommand(registry, `/review ${LITERAL_ARGS}`)?.message === `Review ${LITERAL_ARGS}. Then review ${LITERAL_ARGS} again.\n`);
  const replacementSyntax = "$& $$ $` $'";
  assert('fallback does not interpret JavaScript replacement-string syntax',
    expandCustomCommand(registry, `/plain ${replacementSyntax}`)?.message === `${PLAIN_CONTENT}\n\n${replacementSyntax}`);
  assert('existing placeholder replacement-string behavior stays byte-identical',
    expandCustomCommand(registry, `/review ${replacementSyntax}`)?.message ===
      'Review $ARGUMENTS. Then review $ARGUMENTS again.\n'.replaceAll('$ARGUMENTS', replacementSyntax));
  const reproduction = { commands: [{ name: 'review', file: '', content: 'Review code for bugs.' }], problems: [] };
  assert('report reproduction preserves the supplied target',
    expandCustomCommand(reproduction, '/review src/auth.ts')?.message === 'Review code for bugs.\n\nsrc/auth.ts');
  for (const input of ['/unknown', '/plain-other x', '/plainx x']) {
    assert('unknown slash input passes through without prefix matching', expandCustomCommand(registry, input) === null);
  }
  assert('plain prose is not a command', expandCustomCommand(registry, 'please /review this') === null);
}

async function missingDirectory(): Promise<void> {
  header('custom commands — absent directory');
  const registry = await loadCustomCommands(path.join(HOME, 'missing'), []);
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

// Runtime integration uses the same files as discovery, then removes the loaded
// templates: neither expansion nor the drivers may read them again.
async function runtimeExpansion(): Promise<void> {
  header('custom commands — ordinary runtime/headless turns and literal trajectory');
  const config = JSON.stringify({
    provider: 'bedrock', model: 'fake.offline-capture', region: 'us-west-2',
    promptCache: false, memory: false, contextOffload: false, trajectory: true,
  });
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), config);
  const model = new CaptureModel();
  setRuntimeModelFactoryForTest(async () => model);
  let runtime: AgentRuntime | undefined;
  let trajectoryFile: string | undefined;
  const literalInputs: string[] = [];
  let gateCalls = 0;
  try {
    runtime = await AgentRuntime.create({
      projectRoot: TMP_ROOT, session: { kind: 'new' },
      permissionBridge: async () => { gateCalls++; return { allowed: false }; },
    });
    await rm(COMMANDS_ROOT, { recursive: true });
    const input = ` /PLAIN\t${LITERAL_ARGS} \n`;
    const expected = `${PLAIN_CONTENT}\n\n${LITERAL_ARGS}`;
    const expanded = await runtime.expandSlashCommand(input);
    assert('real runtime retains loaded bytes after source files disappear',
      expanded?.kind === 'command' && expanded.message === expected);
    assert('runtime expansion alone makes no model or permission call', model.calls.length === 0 && gateCalls === 0);
    assert('runtime expansion alone records no user input',
      runtime.info.trajectoryFile === undefined || !existsSync(runtime.info.trajectoryFile) ||
      !(await readFile(runtime.info.trajectoryFile, 'utf8')).includes('"type":"userInput"'));

    const cases = [
      { input, expected },
      { input: '/plain', expected: PLAIN_CONTENT },
      { input: ' /plain \t\n ', expected: PLAIN_CONTENT },
      { input: `/review ${LITERAL_ARGS}`, expected: `Review ${LITERAL_ARGS}. Then review ${LITERAL_ARGS} again.\n` },
      { input: '/REVIEW', expected: 'Review . Then review  again.\n' },
      { input: '/review \t\n', expected: 'Review . Then review  again.\n' },
      { input: '/unknown untouched', expected: '/unknown untouched' },
    ];
    for (const driver of ['direct', 'text', 'json', 'stream-json'] as const) {
      for (const test of cases) {
        const before = model.calls.length;
        if (driver === 'direct') {
          const command = await runtime.expandSlashCommand(test.input);
          let toolCalled = false;
          for await (const event of runtime.send(command?.message ?? test.input, test.input)) {
            if (event.type === 'beforeToolCallEvent') toolCalled = true;
          }
          assert('direct runtime turn invokes no tools', !toolCalled);
        } else if (driver === 'text') {
          assert('text headless completes normally', await runHeadlessTurn(runtime, test.input, () => {}) === 'ok');
        } else {
          const result = await runStructuredHeadlessTurn(runtime, test.input,
            new StructuredHeadlessWriter(driver, () => {}), () => 'unexpected tool');
          assert(`${driver} headless completes normally`, result.reply === 'ok');
        }
        literalInputs.push(test.input);
        assert(`${driver} sends exactly one ordinary model request`, model.calls.length === before + 1);
        const prompt = model.calls.at(-1)?.messages.at(-1)?.content
          .map(block => block.type === 'textBlock' ? block.text : '').join('');
        assert(`${driver} delivers exact expanded prompt or unknown input`, prompt === test.expected);
      }
    }
    trajectoryFile = runtime.info.trajectoryFile;
    assert('no shell interpolation or permission/tool execution', gateCalls === 0 && !existsSync(path.join(TMP_ROOT, 'executed')));
    assert('fixture config remains byte-identical', await readFile(configPath(), 'utf8') === config);
  } finally {
    await runtime?.shutdown();
    setRuntimeModelFactoryForTest(undefined);
  }
  assert('ordinary runtime recorded a trajectory', trajectoryFile !== undefined);
  if (trajectoryFile !== undefined) {
    const records = (await readFile(trajectoryFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const inputs = records.filter(record => record.type === 'userInput').map(record => record.text);
    assert('all drivers record only the exact literal input once per turn', JSON.stringify(inputs) === JSON.stringify(literalInputs));
    assert('no tool calls are recorded', !records.some(record => record.type === 'beforeToolCallEvent'));
  }
}

process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
const registry = await discovery();
expansion(registry);
await missingDirectory();
completionDescriptions();
await runtimeExpansion();
await rm(TMP_ROOT, { recursive: true, force: true });
report();
