/**
 * The `darwin` command-line grammar and the two local answers derived from it:
 * `--help`/`-h` and `--version`/`-V`.
 *
 * This module is the single source of the usage text. `cli.ts` prints it, its header
 * comment points here instead of repeating it, and `docs/user-guide/reference.md`
 * quotes it verbatim (pinned by `spike/verify-cli-args.ts`), so the three cannot drift.
 *
 * Deliberately imports nothing beyond `version.ts`: answering `--help` or `--version`
 * must stay a local, write-free operation that reaches no runtime, config, model, SDK
 * or Ink module. `spike/verify-cli-args.ts` asserts that over the import graph.
 */
import { DARWIN_VERSION } from './version.js';

export const HELP_FLAGS = ['--help', '-h'] as const;
export const VERSION_FLAGS = ['--version', '-V'] as const;

/** The complete grammar, exactly as `darwin --help` prints it (trailing newline included). */
export const CLI_USAGE = `Usage: darwin [--resume [<id>]|--session <id>] [--permission-mode <default|auto|plan|yolo>] [--yolo]
       darwin -p <message> [--output-format text|json|stream-json]
         [--continue|--resume [<id>]|--session <id>] [permission flags]
         [--max-model-calls <n>] [--context-offload] [--compact-before]
       darwin sessions
       darwin trajectory <list|search|replay|fork> …
       darwin --help | -h
       darwin --version | -V

--context-offload force-enables the default-on offloader for this process; it never persists.
Print-only flags: --output-format, --max-model-calls, --context-offload, --compact-before, --continue.
`;

/** The one hint every usage error appends after its `error:` line. */
export const CLI_HELP_HINT = 'Run `darwin --help` for usage.';

/**
 * The stdout text for a `--help`/`--version` invocation, or `undefined` when argv asks
 * for neither. Either flag anywhere in argv wins over everything else — subcommands,
 * `-p`, unknown flags — and help wins over version, so the answer is decided before
 * any other parser sees the arguments.
 */
export function localCliAnswer(argv: readonly string[]): string | undefined {
  if (HELP_FLAGS.some((flag) => argv.includes(flag))) return CLI_USAGE;
  if (VERSION_FLAGS.some((flag) => argv.includes(flag))) return `darwin ${DARWIN_VERSION}\n`;
  return undefined;
}
