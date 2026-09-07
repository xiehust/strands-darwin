/**
 * Wildcard allow-rules: "stop asking about calls like this one".
 *
 * A rule is a string, so it survives a round trip through `.darwin/config.json`
 * unchanged and stays readable in it:
 *
 * - `bash:pnpm *` — pattern matched against the command, `*` is any run of characters
 * - `fileEditor:src/**` — glob on the path, `**` crosses `/`, `*` does not
 * - `bash` — no colon: every call of that tool. The only shape available for
 *   unknown and MCP tools, whose input has no structure we can reason about.
 *
 * The matcher is deliberately conservative in the same way the static risk rules
 * are: anything it cannot reason about does not match, and a non-match only costs
 * a prompt.
 */
import os from 'node:os';
import path from 'node:path';

import { isSensitiveDarwinPath } from '../paths.js';

/** What the matcher needs from a tool call. `PermissionRequest` satisfies it. */
export interface RuleTarget {
  toolName: string;
  input: unknown;
}

/** One "always allow" offer, ready to render on the prompt's option line. */
export interface RuleSuggestion {
  /** The rule string, as it will be written to the config. */
  rule: string;
  /** Short label for the option line, e.g. `pnpm *` or `all bash`. */
  label: string;
}

/**
 * Redirection and substitution turn an otherwise recognizable command into a
 * write (`echo x > f`) or hide arbitrary execution (`` `...` ``, `$(...)`). `<`
 * is included because `<(...)` process substitution executes its body.
 */
const SHELL_METACHARACTERS = /[><`]|\$\(/;

/** Sensitive file basenames no rule may cover. */
const ENV_FILE = /^\.env(\..+)?$/;

/**
 * Whitelisted bash readers whose non-option arguments name files (SER-071).
 * `echo` is on the static safe list but deliberately absent here: with `<` and
 * `$(` refused as metacharacters it can only print its arguments, never open a
 * file, so `echo ~/.ssh/id_rsa` reveals a path string and nothing else. `pwd`
 * and `which` take no file paths.
 */
const BASH_PATH_READERS = new Set(['cat', 'head', 'tail', 'grep', 'rg', 'find', 'ls', 'wc']);

/**
 * Home-relative directories whose every entry is a credential. The directory
 * itself counts too: listing `~/.ssh` names the keys that exist.
 */
export const SENSITIVE_READ_DIRECTORIES: readonly string[] = ['.ssh', '.aws', '.gnupg'];

/** Home-relative files that hold credentials. */
export const SENSITIVE_READ_HOME_FILES: readonly string[] = [
  '.netrc',
  path.join('.kube', 'config'),
  path.join('.docker', 'config.json'),
];

/** Absolute files that hold credentials. */
export const SENSITIVE_READ_ABSOLUTE_FILES: readonly string[] = ['/etc/shadow'];

/**
 * The fixed sensitive-read set (SER-071): a resolved absolute path that is under
 * one of {@link SENSITIVE_READ_DIRECTORIES}, is one of the home or absolute
 * credential files, has a `.env` / `.env.*` basename anywhere, or is one of
 * darwin's own policy files ({@link isSensitiveDarwinPath}).
 *
 * A fixed set rather than "outside the project": darwin legitimately reads
 * `/tmp`, `/etc/os-release` and the global skill roots, and a one-line list is
 * something a prompt can explain.
 */
export function isSensitiveReadPath(projectRoot: string, resolved: string): boolean {
  const home = os.homedir();
  if (SENSITIVE_READ_DIRECTORIES.some((directory) => isInside(path.join(home, directory), resolved))) return true;
  if (SENSITIVE_READ_HOME_FILES.some((file) => samePath(path.join(home, file), resolved))) return true;
  if (SENSITIVE_READ_ABSOLUTE_FILES.some((file) => samePath(file, resolved))) return true;
  if (ENV_FILE.test(path.basename(resolved))) return true;
  return isSensitiveDarwinPath(projectRoot, resolved);
}

/**
 * One path argument as the shell (or the model) would resolve it: `~`, `~/…`,
 * `$HOME…` and `${HOME}…` against the home directory, relative forms against
 * the project root, `..` segments normalised. Surrounding quotes are dropped
 * first — bash would not expand a quoted `~`, so this over-approximates, which
 * for a read costs a prompt and never a silent approval.
 */
export function resolveReadTarget(argument: string, projectRoot: string): string {
  const unquoted = argument.replace(/^(["'])([\s\S]*)\1$/, '$2');
  const home = os.homedir();
  let expanded = unquoted;
  if (unquoted === '~') expanded = home;
  else if (unquoted.startsWith('~/')) expanded = path.join(home, unquoted.slice(2));
  else if (/^\$(HOME|\{HOME\})(\/|$)/.test(unquoted)) expanded = path.join(home, unquoted.replace(/^\$(HOME|\{HOME\})/, ''));
  return path.resolve(projectRoot, expanded);
}

/**
 * The first read target of this call that falls in the sensitive set, as the
 * model wrote it, or undefined when the call reads nothing sensitive (SER-071).
 *
 * Targets are the `path` of `fileEditor view` and every non-option argument of
 * every {@link BASH_PATH_READERS} segment of a bash command — a pattern
 * argument (`rg password ~/.gnupg`) is resolved like a path and simply misses.
 * Any other tool or command reads nothing this function can see.
 */
export function sensitiveReadPath(toolName: string, input: unknown, projectRoot: string): string | undefined {
  if (toolName === 'fileEditor') {
    if (readString(input, 'command') !== 'view') return undefined;
    const filePath = readString(input, 'path');
    if (filePath === undefined || filePath === '') return undefined;
    return isSensitiveReadPath(projectRoot, resolveReadTarget(filePath, projectRoot)) ? filePath : undefined;
  }

  if (toolName === 'bash') {
    const command = readString(input, 'command');
    if (command === undefined) return undefined;
    for (const segment of splitBashSegments(command)) {
      const [word = '', ...args] = segment.split(/\s+/);
      if (!BASH_PATH_READERS.has(word)) continue;
      for (const arg of args) {
        if (arg.startsWith('-')) continue;
        if (isSensitiveReadPath(projectRoot, resolveReadTarget(arg, projectRoot))) return arg;
      }
    }
  }

  return undefined;
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Commands whose first word is only a dispatcher: `git push` and `git status`
 * have nothing in common, so a rule derived from `git …` alone would be far
 * broader than what the user just approved.
 */
const SUBCOMMAND_DRIVERS = new Set([
  'git',
  'pnpm',
  'npm',
  'npx',
  'yarn',
  'cargo',
  'docker',
  'go',
  'uv',
  'pip',
  'python',
  'python3',
  'node',
  'make',
  'gh',
  'kubectl',
  'aws',
  'poetry',
]);

/**
 * Longest label the prompt's single-line option row can carry. Kept short on
 * purpose: the row has to survive an 80-column terminal without wrapping, and a
 * wrapped row is one more line of the live frame Ink drops on a short screen.
 */
const MAX_LABEL_CHARS = 24;

/** True when the command contains redirection or substitution. */
export function hasShellMetacharacters(command: string): boolean {
  return SHELL_METACHARACTERS.test(command);
}

/**
 * Splits a command on the chaining operators, so `a && b` is only covered when
 * both halves are. Naive on purpose: a mis-split drops out of the safe path,
 * never into it.
 */
export function splitBashSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}

/** A rule split into its parts, or undefined when the string is not a rule. */
export function parseRule(rule: string): { toolName: string; pattern?: string } | undefined {
  const colon = rule.indexOf(':');
  if (colon === -1) {
    const toolName = rule.trim();
    return toolName === '' ? undefined : { toolName };
  }

  const toolName = rule.slice(0, colon).trim();
  const pattern = rule.slice(colon + 1).trim();
  if (toolName === '' || pattern === '') return undefined;
  return { toolName, pattern };
}

/** Whether a config entry is a usable rule. Used to reject typos at load time. */
export function isValidRule(rule: string): boolean {
  return parseRule(rule) !== undefined;
}

/**
 * The first rule that covers this call, or undefined when none does.
 *
 * Exempt targets (see {@link isRuleExempt}) match nothing, whatever the rules
 * say — a broad rule must not be a path to the agent widening its own
 * permissions.
 */
export function matchesAnyRule(
  rules: readonly string[],
  target: RuleTarget,
  projectRoot: string,
): string | undefined {
  if (isRuleExempt(target, projectRoot)) return undefined;

  for (const rule of rules) {
    const parsed = parseRule(rule);
    if (parsed === undefined) continue;
    if (parsed.toolName !== target.toolName) continue;
    // No pattern: the user asked for the whole tool.
    if (parsed.pattern === undefined) return rule;
    if (patternCovers(parsed.pattern, target, projectRoot)) return rule;
  }
  return undefined;
}

/**
 * Calls no rule may ever cover: darwin's own config (a rule there lets the agent
 * grant itself more rules), environment files, and — the read side of the same
 * exemption (SER-071) — any read into the sensitive set. All are also
 * `dangerous` statically, so the effect is that they always ask.
 */
export function isRuleExempt(target: RuleTarget, projectRoot: string): boolean {
  if (target.toolName === 'memory_save') return true;
  if (sensitiveReadPath(target.toolName, target.input, projectRoot) !== undefined) return true;
  if (target.toolName !== 'fileEditor') return false;

  const filePath = readString(target.input, 'path');
  if (filePath === undefined) return false;

  const resolved = path.resolve(projectRoot, filePath);
  if (ENV_FILE.test(path.basename(resolved))) return true;
  return isSensitiveDarwinPath(projectRoot, resolved);
}

/**
 * At most two offers, most specific first: one derived from this call, then the
 * whole tool. Empty for an exempt target — offering a rule that could never
 * apply would be a lie told in a security prompt.
 */
export function suggestRules(target: RuleTarget, projectRoot: string): RuleSuggestion[] {
  if (isRuleExempt(target, projectRoot)) return [];

  const specific = specificSuggestion(target, projectRoot);
  const wholeTool: RuleSuggestion = {
    rule: target.toolName,
    label: clipLabel(`all ${target.toolName}`),
  };
  return specific === undefined ? [wholeTool] : [specific, wholeTool];
}

function specificSuggestion(target: RuleTarget, projectRoot: string): RuleSuggestion | undefined {
  if (target.toolName === 'bash') {
    const pattern = bashPattern(readString(target.input, 'command') ?? '');
    return pattern === undefined ? undefined : { rule: `bash:${pattern}`, label: clipLabel(pattern) };
  }

  if (target.toolName === 'fileEditor') {
    const filePath = readString(target.input, 'path');
    if (filePath === undefined) return undefined;
    const pattern = directoryPattern(filePath, projectRoot);
    return { rule: `fileEditor:${pattern}`, label: clipLabel(pattern) };
  }

  // Unknown and MCP tools: the input shape is unknown, so the whole tool is the
  // only honest offer.
  return undefined;
}

/** `pnpm typecheck --watch` → `pnpm typecheck *`; `rm -rf x` → `rm *`. */
function bashPattern(command: string): string | undefined {
  const words = normalizeSpaces(command).split(' ').filter((word) => word !== '');
  const [first, second] = words;
  if (first === undefined) return undefined;

  if (SUBCOMMAND_DRIVERS.has(first) && second !== undefined && !second.startsWith('-')) {
    return `${first} ${second} *`;
  }
  return `${first} *`;
}

/** `src/tui/App.tsx` → `src/tui/**`; a project-root file → `**`. */
function directoryPattern(filePath: string, projectRoot: string): string {
  const resolved = path.resolve(projectRoot, filePath);
  const relative = path.relative(projectRoot, resolved);
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);

  const target = toPosix(inside ? relative : resolved);
  const directory = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
  return directory === '' ? '**' : `${directory}/**`;
}

function patternCovers(pattern: string, target: RuleTarget, projectRoot: string): boolean {
  if (target.toolName === 'bash') {
    const command = readString(target.input, 'command') ?? '';
    // Same fail-closed reasoning as the static rules: with redirection or
    // substitution in play, the words no longer say what will run.
    if (hasShellMetacharacters(command)) return false;
    const segments = splitBashSegments(command);
    if (segments.length === 0) return false;
    return segments.every((segment) => commandMatches(pattern, segment));
  }

  if (target.toolName === 'fileEditor') {
    const filePath = readString(target.input, 'path');
    if (filePath === undefined) return false;
    const resolved = path.resolve(projectRoot, filePath);
    const relative = path.relative(projectRoot, resolved);
    const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    return pathMatches(pattern, toPosix(inside ? relative : resolved));
  }

  // A pattern for a tool whose input we cannot read means nothing; only the
  // whole-tool form applies there.
  return false;
}

/** `*` is any run of characters. Whitespace is normalized on both sides. */
function commandMatches(pattern: string, command: string): boolean {
  const normalized = normalizeSpaces(pattern);
  // A trailing ` *` reads as "and anything after", which has to include nothing
  // at all: `pnpm typecheck *` must cover a bare `pnpm typecheck`.
  const openEnded = normalized.endsWith(' *');
  const body = openEnded ? normalized.slice(0, -2) : normalized;
  const core = body.split('*').map(escapeRegExp).join('[\\s\\S]*');
  const source = openEnded ? `^${core}(?: [\\s\\S]*)?$` : `^${core}$`;
  return new RegExp(source).test(normalizeSpaces(command));
}

/** `**` matches across `/`, `*` and `?` stay within one path segment. */
function pathMatches(pattern: string, target: string): boolean {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char ?? '');
    }
  }
  return new RegExp(`${source}$`).test(target);
}

function normalizeSpaces(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Patterns are written with `/`, so Windows separators are folded to it. */
function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clipLabel(label: string): string {
  return label.length <= MAX_LABEL_CHARS ? label : `${label.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function readString(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
