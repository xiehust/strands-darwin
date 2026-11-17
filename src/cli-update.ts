/** Explicit, SDK-free update route. Checks never install; --install is user-owned. */
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { localCliAnswer, usageErrorText } from './cli-usage.js';
import { compareVersions, fetchLatestVersion, UPGRADE_COMMAND } from './update-check.js';
import { DARWIN_PACKAGE_NAME, DARWIN_PACKAGE_ROOT, DARWIN_VERSION } from './version.js';

const UPDATE_USAGE = 'usage: darwin update [--install]';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Injectable locations/budgets for real loopback and process verification, not CLI flags. */
export interface UpdateCliOptions {
  currentVersion?: string;
  packageRoot?: string;
  registryUrl?: string;
  requestTimeoutMs?: number;
  npmCommand?: string;
  installTimeoutMs?: number;
}

export async function runUpdateCli(argv: readonly string[], options: UpdateCliOptions = {}): Promise<void> {
  const local = localCliAnswer(argv);
  if (local !== undefined) { process.stdout.write(local); return; }
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--install')) {
    process.stderr.write(usageErrorText(UPDATE_USAGE));
    process.exitCode = 2;
    return;
  }
  const install = argv[0] === '--install';
  const current = options.currentVersion ?? DARWIN_VERSION;
  const root = options.packageRoot ?? DARWIN_PACKAGE_ROOT;
  const npm = options.npmCommand ?? 'npm';
  try {
    if (compareVersions(current, current) === undefined) throw new Error('the installed version is unknown');
    // Installing is refused before network/process work for a checkout or unknown root.
    if (install) await refuseCheckout(root);
    const latest = await fetchLatestVersion({
      ...(options.registryUrl === undefined ? {} : { url: options.registryUrl }),
      timeoutMs: options.requestTimeoutMs ?? 5000,
    });
    process.stdout.write(`darwin: installed ${current}, latest ${latest}\n`);
    if (compareVersions(latest, current) !== 1) {
      process.stdout.write('Already up to date; nothing installed.\n');
      return;
    }
    if (!install) {
      process.stdout.write('Update available. Run `darwin update --install` to upgrade.\n');
      return;
    }
    const prefix = await installPrefix(root!, npm);
    process.stdout.write(`Installing ${DARWIN_PACKAGE_NAME}@${latest} into ${prefix}\n`);
    await runProcess(npm, ['install', '-g', `${DARWIN_PACKAGE_NAME}@${latest}`, '--prefix', prefix, '--no-audit', '--no-fund'],
      root!, options.installTimeoutMs ?? INSTALL_TIMEOUT_MS, true);
    // A zero npm exit alone is not proof: dry-run/ignore-scripts settings can leave it unchanged or broken.
    const version = await runProcess(process.execPath, [path.join(root!, 'dist/src/cli.js'), '--version'], root!, 10_000);
    if (version.trim() !== `darwin ${latest}`) throw new Error('installed CLI did not report the requested version');
    process.stdout.write(`Updated to ${latest}. Restart other running Darwin sessions to use it.\n`);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 500);
    process.stderr.write(`error: update: ${message}\n`);
    if (install) process.stderr.write(`No automatic retry or rollback. Check the installation before retrying; manual command: \`${UPGRADE_COMMAND}\`.\n`);
    process.exitCode = 1;
  }
}

async function refuseCheckout(root: string | undefined): Promise<void> {
  if (root === undefined) throw new Error('cannot identify the installed package; use npm to install it manually');
  try {
    await lstat(path.join(root, '.git'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('this is a source checkout/link, not an npm installation; rebuild the checkout or install the npm package separately');
}

async function installPrefix(root: string, npm: string): Promise<string> {
  if (process.platform === 'win32') throw new Error('automatic installation supports POSIX npm global layouts only; use npm manually');
  const prefix = (await runProcess(npm, ['prefix', '-g'], root, 10_000)).trim();
  if (!path.isAbsolute(prefix) || /[\r\n]/.test(prefix)) throw new Error('npm returned an invalid global prefix');
  const target = path.join(prefix, 'lib/node_modules', DARWIN_PACKAGE_NAME);
  try {
    if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== await realpath(root)) {
      throw new Error('the running package is not this npm global installation');
    }
  } catch {
    throw new Error('the running package does not match the npm global prefix; refusing to modify another installation');
  }
  return prefix;
}

/** One argv-only, noninteractive process. No shell, sudo, automatic retries or detached survivors. */
async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, live = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', stopped: string | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: string) => {
      if (stopped !== undefined) return;
      stopped = reason;
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* Already stopped. */ }
      };
      kill('SIGTERM');
      // Retain this timer even if the leader exits first: npm lifecycle descendants share its group.
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const interrupt = () => stop('cancelled; installation may be incomplete');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const timer = setTimeout(() => stop('timed out; installation may be incomplete'), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      if (stopped === undefined && killTimer !== undefined) clearTimeout(killTimer);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (live) process.stdout.write(chunk);
      else {
        const text = chunk.toString('utf8');
        if (stdout.length + text.length > 64 * 1024) stop('command output exceeded the limit');
        else stdout += text;
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
      if (live) process.stderr.write(chunk);
    });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      if (stopped !== undefined) reject(new Error(stopped));
      else if (code !== 0) reject(new Error(`command failed (${signal ?? code}): ${stderr.trim()}`));
      else resolve(stdout);
    });
  });
}
