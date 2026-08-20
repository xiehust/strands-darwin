/** No-model checks for the process argv boundary and strict CLI parsers. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  CliUsageError,
  normalizeLeadingArgvSeparator,
  parseCliArgs,
} from '../src/cli-args.js';
import { ownPrivateHome, assert, header, report } from './shared.js';

const HOME = ownPrivateHome('cli-args');
const ROOT = path.resolve(import.meta.dirname, '..');

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(argv: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(ROOT, 'src/cli.ts'), ...argv],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME },
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
    && directTuiError.stderr === 'error: Unknown argument "--unknown".\n',
);

const directHeadlessError = cli(['-p', 'x', '--unknown']);
const separatedHeadlessError = cli(['--', '-p', 'x', '--unknown']);
assert(
  'the process entry preserves identical headless-path usage errors',
  isDeepStrictEqual(directHeadlessError, separatedHeadlessError)
    && directHeadlessError.status === 2
    && directHeadlessError.stderr === 'error: Unknown argument "--unknown".\n',
);

report();
