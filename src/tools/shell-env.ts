/**
 * Withhold credential-shaped environment variables from model-spawned shells (SER-082).
 *
 * The persistent SDK shell and the session's background jobs used to inherit the
 * whole `process.env`. `assessRisk` rightly calls `echo $ANTHROPIC_API_KEY` a
 * read-only command, so in `default` mode the model could print darwin's own API
 * key without a prompt and the value would land in the tool result, the
 * trajectory and `/export`. This module is the one pure decision about what a
 * *model-spawned* shell inherits; the seams that spawn shells
 * (`createForegroundBashTool`, `BackgroundBashManager.start`) take the result as
 * an ordinary `env` and never consult `process.env` for the model again.
 *
 * Scope, stated once here and repeated at each untouched seam:
 * - `!` user shell commands (`src/tui/shell-command.ts`) run with the user's own
 *   environment — the user typed them, the permission gate's subject is model
 *   tool calls, and so is this scrub's.
 * - Hooks (`src/hooks/*`) are user-configured commands and keep `process.env`.
 * - MCP servers (`src/mcp/registry.ts`) get their environment from config
 *   interpolation, not from here.
 * - The SDK `bash` tool stays the SDK's: only the existing `createBash` option
 *   seam carries the scrubbed map — no execution wrapper, no `toolExecutor`.
 *
 * Orthogonal to the scrub, every one of those seams — the scrubbed map itself,
 * `!`, hooks, stdio MCP `env` — adds the {@link DARWIN_MARKER_NAME} marker through
 * {@link withDarwinMarker} (SER-094): one added name, never a withheld one.
 *
 * The rule is fixed: one case-insensitive pattern on the variable *name*
 * ({@link CREDENTIAL_NAME_PATTERN}); values are never inspected. There is no off
 * switch — the only knob is `shellEnv.passthrough` in config, which restores named
 * variables (exact names or `PREFIX_*`). The result reports the withheld *names*,
 * sorted, so `/status` and the startup notice can say what happened without ever
 * printing a value. A login shell's own profile (`~/.bashrc`, `~/.profile`) may
 * re-export a name on its own; that is the user's file, not the inherited map.
 */

/**
 * A variable is credential-shaped when its name contains one of these words,
 * case-insensitively: `ANTHROPIC_API_KEY`, `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`,
 * `DB_PASSWORD`, `GOOGLE_APPLICATION_CREDENTIALS`, `my_api_key`. Deliberately
 * coarse — a false positive costs one `passthrough` entry, a false negative
 * costs a leaked secret.
 */
export const CREDENTIAL_NAME_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

/**
 * Names a shell cannot do without, kept even if the pattern ever matched them (it
 * does not today — none contains a credential word — but the guarantee is stated
 * and enforced rather than assumed). `LC_*` is a prefix; the proxy names are
 * accepted in both the upper- and lowercase spellings the tools honour.
 */
export const ALWAYS_SURVIVE_NAMES: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TMPDIR',
  'TZ',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** Prefixes whose every variable always survives (`LC_ALL`, `LC_CTYPE`, …). */
export const ALWAYS_SURVIVE_PREFIXES: readonly string[] = ['LC_'];

export interface ScrubbedShellEnv {
  /** The environment to hand to `spawn` — defined values only, as before the scrub. */
  readonly env: Record<string, string>;
  /** Names withheld, sorted (`localeCompare`-free byte order), never values. */
  readonly withheld: readonly string[];
}

/**
 * Why a `shellEnv.passthrough` entry is unusable, or undefined when it is valid.
 * An entry is an exact variable name, or a prefix followed by exactly one
 * trailing `*` (`STRIPE_*`). `*` anywhere else, several `*`, blanks and
 * whitespace are refused — config validation quotes this message under the key.
 */
export function passthroughEntryProblem(entry: string): string | undefined {
  if (entry === '') return 'must not be empty';
  if (/\s/.test(entry)) return 'must not contain whitespace';
  const star = entry.indexOf('*');
  if (star === -1) return undefined;
  if (star !== entry.length - 1) return 'may end in one "*" (a prefix) but not contain one elsewhere';
  if (entry === '*') return 'must name a prefix before "*"';
  return undefined;
}

/** Case-sensitive: POSIX variable names are, and `stripe_key` is not `STRIPE_*`. */
function passesThrough(name: string, passthrough: readonly string[]): boolean {
  for (const entry of passthrough) {
    if (entry.endsWith('*')) {
      if (entry.length > 1 && name.startsWith(entry.slice(0, -1))) return true;
    } else if (name === entry) {
      return true;
    }
  }
  return false;
}

function alwaysSurvives(name: string): boolean {
  return ALWAYS_SURVIVE_NAMES.includes(name) || ALWAYS_SURVIVE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Split `env` into what a model-spawned shell may inherit and the names withheld.
 * Undefined values are dropped as `spawn` would drop them; every other variable
 * is kept unless its name is credential-shaped and neither always-surviving nor
 * restored by a `passthrough` entry. Pure and deterministic: same input, same
 * output, `withheld` sorted.
 */
export function scrubShellEnv(env: NodeJS.ProcessEnv, passthrough: readonly string[]): ScrubbedShellEnv {
  const kept: Record<string, string> = {};
  const withheld: string[] = [];
  for (const name of Object.keys(env)) {
    const value = env[name];
    if (value === undefined) continue;
    if (CREDENTIAL_NAME_PATTERN.test(name) && !alwaysSurvives(name) && !passesThrough(name, passthrough)) {
      withheld.push(name);
      continue;
    }
    kept[name] = value;
  }
  withheld.sort();
  return { env: kept, withheld };
}

/**
 * The one environment marker every process darwin spawns receives (SER-094):
 * `DARWIN=1`, the counterpart of Claude Code's `CLAUDECODE=1` and Gemini CLI's
 * `GEMINI_CLI=1`, so scripts, git hooks and test runners can detect an agent host
 * and drop pagers or interactive prompts, and hook commands can tell who calls them.
 */
export const DARWIN_MARKER_NAME = 'DARWIN';

/** The marker's value; a bare presence flag, never state. */
export const DARWIN_MARKER_VALUE = '1';

/**
 * A copy of `env` carrying {@link DARWIN_MARKER_NAME}`=1` — unless the name is
 * already set, in which case the input is returned byte-identical (a user's own
 * `export DARWIN=custom` survives; the marker never overrides). Pure: the input is
 * never mutated, undefined values are dropped as `spawn` would drop them, nothing
 * else is added. Applied at every spawn seam darwin owns — the scrubbed map the
 * model's `bash` gets, `!` commands, hook commands, stdio MCP server `env` — and
 * deliberately outside {@link scrubShellEnv}: the marker is neither withheld nor
 * a passthrough, so the notice and `/status` never mention it.
 */
export function withDarwinMarker(env: NodeJS.ProcessEnv): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const name of Object.keys(env)) {
    const value = env[name];
    if (value !== undefined) copy[name] = value;
  }
  if (!(DARWIN_MARKER_NAME in copy)) copy[DARWIN_MARKER_NAME] = DARWIN_MARKER_VALUE;
  return copy;
}

/** Representative withheld names in the startup notice before `…` takes over. */
export const MAX_NOTICE_NAMES = 3;

/**
 * The one sentence every driver's startup notice carries when something was
 * withheld: a count plus a few names, never a value. Callers add their own
 * prefix (`shell env:`) and, in the TUI, the `— see /status` pointer. Undefined
 * when nothing was withheld, so an unaffected run adds no line.
 */
export function formatShellEnvNotice(withheld: readonly string[]): string | undefined {
  if (withheld.length === 0) return undefined;
  const shown = withheld.slice(0, MAX_NOTICE_NAMES);
  const names = withheld.length > shown.length ? `${shown.join(', ')}, …` : shown.join(', ');
  const noun = withheld.length === 1 ? 'variable' : 'variables';
  return `${withheld.length} credential-shaped ${noun} withheld from model shells (${names})`;
}
