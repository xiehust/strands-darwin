import { spawn } from 'node:child_process';
import { withDarwinMarker } from '../tools/shell-env.js';

/** User-only inspection: deliberately not a tool or a shell-command report. */
export const DIFF_USAGE = 'Usage: /diff or /diff --staged (TUI only; no paths or other flags)';
export type DiffScope = 'unstaged' | 'staged';
export function parseDiffCommand(input: string): DiffScope | 'usage' | undefined {
  const match = /^\/diff(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (match === null) return undefined;
  const argument = (match[1] ?? '').trim();
  return argument === '' ? 'unstaged' : argument === '--staged' ? 'staged' : 'usage';
}

export const DIFF_MAX_BYTES = 64 * 1024;
export const DIFF_MAX_LINES = 200;
export const DIFF_MAX_LINE_POINTS = 500;
export const DIFF_TIMEOUT_MS = 5_000;

/** Escape rather than interpret terminal controls, including Unicode bidi controls. */
function safeText(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function projection(text: string): { text: string; truncated: boolean } {
  const lines = safeText(text).trimEnd().split('\n');
  let truncated = lines.length > DIFF_MAX_LINES;
  const bounded = lines.slice(0, DIFF_MAX_LINES).map((line) => {
    const points = [...line];
    if (points.length <= DIFF_MAX_LINE_POINTS) return line;
    truncated = true;
    return `${points.slice(0, DIFF_MAX_LINE_POINTS - 1).join('')}…`;
  }).join('\n');
  return { text: bounded, truncated };
}

// Fixed commands only. No option/path/revision is derived from user or repository text.
const GIT_PREFIX = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false'];
const PREFLIGHT = ['config', '--null', '--get-regexp', '^(filter\\..*\\.(clean|process)|remote\\..*\\.promisor|extensions\\.partialclone)$'];
const DIFF_ARGS = [
  '-c', 'submodule.recurse=false', '-c', 'diff.autoRefreshIndex=false',
  '-c', 'core.quotePath=true', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all',
  '--no-renames', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3',
];

type Capture = { code: number | null; output: string; error: string; truncated: boolean; spawnFailed: boolean };
export interface RunningGitDiff {
  readonly result: Promise<string>;
  cancel(): void;
}

/** One shared time/storage budget across the safety preflight and the diff. No disk writes. */
export function runGitDiff(options: {
  projectRoot: string;
  scope: DiffScope;
  /** Caller applies the existing shell-env scrub/passthrough policy. */
  env: NodeJS.ProcessEnv;
}): RunningGitDiff {
  // Git-specific inherited overrides must not redirect this project, inject configuration,
  // write trace files, or enable a helper. All other scrubbed environment values survive.
  const env = withDarwinMarker(Object.fromEntries(Object.entries(options.env)
    .filter(([key, value]) => value !== undefined && !/^GIT_/i.test(key))) as Record<string, string>);
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_NO_LAZY_FETCH'] = '1';
  env['LC_ALL'] = 'C';
  let stop: 'cancelled' | 'timed out' | 'output limit reached' | undefined;
  let kill: (() => void) | undefined;
  let remaining = DIFF_MAX_BYTES;
  const halt = (reason: typeof stop): void => {
    stop ??= reason;
    kill?.();
  };
  const timer = setTimeout(() => halt('timed out'), DIFF_TIMEOUT_MS);

  const capture = (args: readonly string[]): Promise<Capture> => new Promise((resolve) => {
    if (stop !== undefined) { resolve({ code: null, output: '', error: '', truncated: false, spawnFailed: false }); return; }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let truncated = false;
    let spawnFailed = false;
    const child = spawn('git', [...GIT_PREFIX, ...args], {
      cwd: options.projectRoot, env, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    kill = () => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* Already reaped. */ }
    };
    const collect = (buffers: Buffer[], chunk: Buffer): void => {
      const kept = chunk.subarray(0, remaining);
      // Copy the bounded prefix, never retain an oversized backing buffer.
      if (kept.length > 0) buffers.push(Buffer.from(kept));
      remaining -= kept.length;
      if (kept.length < chunk.length) { truncated = true; halt('output limit reached'); }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', () => { spawnFailed = true; });
    child.on('close', (code) => {
      kill = undefined;
      resolve({ code, output: Buffer.concat(stdout).toString('utf8'), error: Buffer.concat(stderr).toString('utf8'), truncated, spawnFailed });
    });
  });

  const label = options.scope === 'staged'
    ? 'diff — staged: index versus HEAD (empty tree when unborn)'
    : 'diff — unstaged: worktree versus index (tracked files)';
  const heading = `${label}\nUntracked contents and submodule contents excluded.\n`;
  const failure = (captured: Capture): string | undefined => {
    if (stop !== undefined) return `${stop}; capture incomplete — not a clean result`;
    if (captured.spawnFailed) return 'could not start Git (missing Git or inaccessible project directory)';
    return undefined;
  };
  const result = (async () => {
    try {
      // --no-textconv does NOT disable clean/process filters. Refuse them before diff;
      // likewise refuse promisor remotes rather than permitting an implicit fetch.
      const preflight = await capture(PREFLIGHT);
      const problem = failure(preflight);
      if (problem !== undefined) return heading + problem;
      if (preflight.code === 0) return heading + 'unavailable: configured clean/process filters or promisor remotes are not supported (helpers must not run)';
      if (preflight.code !== 1) return heading + 'Git safety preflight failed; no diff was run';
      const captured = await capture([...DIFF_ARGS, ...(options.scope === 'staged' ? ['--cached'] : []), '--']);
      const view = projection([captured.output, captured.error].filter(Boolean).join('\n'));
      const stopped = failure(captured);
      const status = stopped ?? (captured.code !== 0
        ? `Git failed (exit ${captured.code ?? 'signal'}); not a clean result`
        : captured.output === '' && captured.error === ''
          ? 'No changes in this selected scope; this does not mean the whole tree is clean.'
          : '');
      return heading + [status, view.text,
        captured.truncated || view.truncated ? '… truncated; capture incomplete (64 KiB / 200 lines / 500 code points per line)' : '',
      ].filter(Boolean).join('\n');
    } catch {
      return heading + 'Git inspection failed; not a clean result';
    } finally {
      clearTimeout(timer);
      kill?.();
    }
  })();
  return { result, cancel: () => halt('cancelled') };
}
