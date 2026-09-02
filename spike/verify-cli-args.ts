/** No-model checks for the process argv boundary and strict CLI parsers. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  CliUsageError,
  normalizeLeadingArgvSeparator,
  parseCliArgs,
} from '../src/cli-args.js';
import { CLI_HELP_HINT, CLI_USAGE, HELP_FLAGS, VERSION_FLAGS, localCliAnswer } from '../src/cli-usage.js';
import { ownPrivateHome, assert, header, report } from './shared.js';

const HOME = ownPrivateHome('cli-args');
const ROOT = path.resolve(import.meta.dirname, '..');
const HINT_LINE = `${CLI_HELP_HINT}\n`;

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(argv: readonly string[], home: string = HOME): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'src/cli.ts'), ...argv],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    },
  );
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function usageError(argv: readonly string[]): string {
  try {
    parseCliArgs(normalizeLeadingArgvSeparator(argv));
  } catch (error) {
    if (error instanceof CliUsageError) return error.message;
    throw error;
  }
  throw new Error(`expected usage error for ${JSON.stringify(argv)}`);
}

header('one leading argv separator');
const tui = parseCliArgs(normalizeLeadingArgvSeparator(['--yolo']));
const separatedTui = parseCliArgs(normalizeLeadingArgvSeparator(['--', '--yolo']));
assert('direct and separated TUI options are identical', isDeepStrictEqual(tui, separatedTui));

const headless = parseCliArgs(normalizeLeadingArgvSeparator(['-p', 'fixture prompt', '--yolo']));
const separatedHeadless = parseCliArgs(normalizeLeadingArgvSeparator(['--', '-p', 'fixture prompt', '--yolo']));
assert(
  'direct and separated headless options are identical',
  isDeepStrictEqual(headless, separatedHeadless) && headless.prompt === 'fixture prompt',
);

const bareResume = parseCliArgs(normalizeLeadingArgvSeparator(['--', '--resume']));
assert('separated bare --resume keeps pointer-following semantics', bareResume.session.kind === 'continue');

const directSessions = cli(['sessions']);
const separatedSessions = cli(['--', 'sessions']);
assert(
  'direct and separated sessions subcommands have identical process results',
  isDeepStrictEqual(directSessions, separatedSessions) && directSessions.status === 0,
);

const directTrajectory = cli(['trajectory']);
const separatedTrajectory = cli(['--', 'trajectory']);
assert(
  'direct and separated trajectory routing have identical process results',
  isDeepStrictEqual(directTrajectory, separatedTrajectory)
    && directTrajectory.status === 2
    && directTrajectory.stderr.includes('Usage: darwin trajectory'),
);

header('strict separator placement');
assert(
  'a second leading separator remains an error',
  usageError(['--', '--', '--yolo']) === 'Unknown argument "--".',
);
assert(
  'a separator after parsed options remains an error',
  usageError(['-p', 'x', '--', '--yolo']) === 'Unknown argument "--".',
);
assert(
  'a separator used as an option value retains that option error',
  usageError(['-p', '--']) === '-p expects a non-empty message.',
);
assert(
  'unknown flags retain strict handling after one separator',
  usageError(['--', '--unknown']) === 'Unknown argument "--unknown".',
);

const directTuiError = cli(['--resume', '--unknown']);
const separatedTuiError = cli(['--', '--resume', '--unknown']);
assert(
  'the process entry preserves identical TUI-path usage errors',
  isDeepStrictEqual(directTuiError, separatedTuiError)
    && directTuiError.status === 2
    && directTuiError.stderr === `error: Unknown argument "--unknown".\n${HINT_LINE}`,
);

const directHeadlessError = cli(['-p', 'x', '--unknown']);
const separatedHeadlessError = cli(['--', '-p', 'x', '--unknown']);
assert(
  'the process entry preserves identical headless-path usage errors',
  isDeepStrictEqual(directHeadlessError, separatedHeadlessError)
    && directHeadlessError.status === 2
    && directHeadlessError.stderr === `error: Unknown argument "--unknown".\n${HINT_LINE}`,
);

header('--help and --version are bounded local answers');
const packageVersion = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const VERSION_LINE = `darwin ${packageVersion}\n`;
assert('the grammar names both flags', CLI_USAGE.includes('darwin --help | -h') && CLI_USAGE.includes('darwin --version | -V'));
assert('the grammar ends with exactly one newline', CLI_USAGE.endsWith('\n') && !CLI_USAGE.endsWith('\n\n'));
assert('the hint names darwin --help', CLI_HELP_HINT.includes('darwin --help'));
assert('the parser itself stays unaware: --help is still an unknown argument to parseCliArgs',
  usageError(['--help']) === 'Unknown argument "--help".' && usageError(['-V']) === 'Unknown argument "-V".');
assert('the answer is decided from argv alone', localCliAnswer(['--yolo']) === undefined && localCliAnswer([]) === undefined);

// A HOME nobody else in this suite has touched: the answer must create nothing there.
const untouchedHome = mkdtempSync(path.join(os.tmpdir(), 'darwin-cli-help-home-'));
process.on('exit', () => rmSync(untouchedHome, { recursive: true, force: true }));
for (const flag of HELP_FLAGS) {
  const result = cli([flag], untouchedHome);
  assert(`${flag} prints the grammar to stdout, nothing to stderr, and exits 0`,
    result.status === 0 && result.stdout === CLI_USAGE && result.stderr === '');
}
for (const flag of VERSION_FLAGS) {
  const result = cli([flag], untouchedHome);
  assert(`${flag} prints "darwin <package.json version>" to stdout, nothing to stderr, and exits 0`,
    result.status === 0 && result.stdout === VERSION_LINE && result.stderr === '');
}
assert('neither answer wrote anything under the private HOME', !existsSync(path.join(untouchedHome, '.darwin')));
assert('the separated forms are identical to the direct ones',
  isDeepStrictEqual(cli(['--', '--help']), cli(['--help'])) && isDeepStrictEqual(cli(['--', '-V']), cli(['-V'])));

header('help wins anywhere in argv, then version');
for (const argv of [['--yolo', '--help'], ['-p', 'x', '-h'], ['sessions', '--help'], ['trajectory', 'search', '--help'], ['--version', '--help'], ['--unknown', '-h']]) {
  const result = cli(argv);
  assert(`${JSON.stringify(argv)} answers with the grammar and exits 0`,
    result.status === 0 && result.stdout === CLI_USAGE && result.stderr === '');
}
for (const argv of [['--resume', '--version'], ['-p', 'x', '-V'], ['sessions', '--version'], ['--unknown', '-V']]) {
  const result = cli(argv);
  assert(`${JSON.stringify(argv)} answers with the version and exits 0`,
    result.status === 0 && result.stdout === VERSION_LINE && result.stderr === '');
}

header('every usage error keeps its message and exit 2, plus one --help hint');
const trajectoryError = cli(['trajectory', 'bogus']);
assert('the trajectory path keeps its own usage text and gains the hint as its last line',
  trajectoryError.status === 2
    && trajectoryError.stderr.startsWith('error: Unknown trajectory command "bogus".\n')
    && trajectoryError.stderr.includes('Usage: darwin trajectory')
    && trajectoryError.stderr.endsWith(HINT_LINE)
    && trajectoryError.stdout === '');
const sessionsError = cli(['sessions', 'extra']);
assert('the sessions path keeps its own usage text and gains the hint as its last line',
  sessionsError.status === 2
    && sessionsError.stderr.startsWith('error: sessions takes no arguments.\n')
    && sessionsError.stderr.endsWith(HINT_LINE)
    && sessionsError.stdout === '');
const valueError = cli(['-p']);
assert('a value-shaped usage error carries exactly the message line and the hint line',
  valueError.status === 2 && valueError.stderr === `error: -p expects a non-empty message.\n${HINT_LINE}`);
assert('the hint appears once per error, never doubled',
  [directTuiError, directHeadlessError, trajectoryError, sessionsError, valueError]
    .every((result) => result.stderr.split(CLI_HELP_HINT).length === 2));

header('the help/version path reaches no runtime, SDK or Ink module');
// Structural half, in the style of spike/verify-trajectory.ts: the module that answers
// `--help`/`--version` (and the one it imports for the version) may import Node
// built-ins and each other, nothing else. cli.ts's own static imports are out of scope
// here — the assertion is about what answering the flag requires, which is this module.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const localModules = ['src/cli-usage.ts', 'src/version.ts'].map((file) => ({
  file,
  text: stripComments(readFileSync(path.join(ROOT, file), 'utf8')),
}));
const importSpecifiers = localModules.flatMap(({ file, text }) =>
  [...text.matchAll(/from\s+'([^']+)'|import\s*\(\s*'([^']+)'\s*\)/g)].map((match) => ({ file, specifier: match[1] ?? match[2]! })));
const allowedLocal = new Set(['./version.js']);
const offending = importSpecifiers.filter(({ specifier }) => !specifier.startsWith('node:') && !allowedLocal.has(specifier));
assert('the scan saw the version import (so it really looked at code)',
  importSpecifiers.some(({ file, specifier }) => file === 'src/cli-usage.ts' && specifier === './version.js'));
assert(`cli-usage.ts and version.ts import only node built-ins and each other${offending.length > 0 ? ` (offending: ${offending.map(({ file, specifier }) => `${file} -> ${specifier}`).join(', ')})` : ''}`,
  offending.length === 0);
assert('no runtime, SDK, Ink or React module is named anywhere in either source',
  localModules.every(({ text }) => !/@strands-agents\/sdk|'ink'|'react'|agent\/runtime|headless-runner|\.\/config\.js|\.\/tui\//.test(text)));

header('the docs quote the grammar verbatim and name the hint');
for (const doc of ['docs/user-guide/reference.md', 'docs/user-guide/reference.zh-CN.md']) {
  const text = readFileSync(path.join(ROOT, doc), 'utf8');
  assert(`${doc} contains the exact --help output`, text.includes(CLI_USAGE));
  assert(`${doc} names the --help hint on usage errors`, text.includes('darwin --help') && text.includes('--version'));
}

report();
