/**
 * Update check: tells an interactive user once, at startup, that a newer
 * `strands-darwin` is on npm, and how to install it. It never installs anything.
 *
 * Contract (pinned by `spike/verify-update-check.ts`):
 * - **Interactive TUI only.** `cli-main.ts` calls it for the TUI; headless (`-p`),
 *   the CLI readers (`sessions`, `trajectory`, `doctor`, …) and child agents never
 *   check, so scripted output and "local-only" commands stay network-free.
 * - **Off switches, checked before any I/O:** config `updateCheck: false`, a
 *   non-empty `DARWIN_NO_UPDATE_CHECK` other than `0`, and a development checkout
 *   (the package root holds a `.git` entry) — `pnpm start` and every pty suite run
 *   from the checkout, so none of them reaches the registry.
 * - **At most one registry request per {@link UPDATE_CHECK_INTERVAL_MS}.** The
 *   result — including a failure — is cached in `~/.darwin/update-check.json`,
 *   so an offline machine pays the {@link UPDATE_CHECK_TIMEOUT_MS} timeout at most
 *   once a day. A fresh cache is compared against the *current* version, so an
 *   upgrade silences the notice immediately.
 * - **Fails silent.** Network errors, timeouts, non-2xx answers, malformed bodies
 *   and an unwritable cache all yield no notice and never throw.
 */
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { userDarwinDir } from './paths.js';
import { DARWIN_PACKAGE_NAME } from './version.js';

/** How long one registry answer (or failure) is trusted: 24 hours. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Budget for one registry request; it runs concurrently with runtime startup. */
export const UPDATE_CHECK_TIMEOUT_MS = 1500;
/** The environment variable that disables the check (any value but empty or `0`). */
export const UPDATE_CHECK_ENV = 'DARWIN_NO_UPDATE_CHECK';
/** npm's abbreviated "latest" document for the package. */
export const DEFAULT_REGISTRY_URL = `https://registry.npmjs.org/${DARWIN_PACKAGE_NAME}/latest`;
/** The command the notice recommends. */
export const UPGRADE_COMMAND = `npm install -g ${DARWIN_PACKAGE_NAME}@latest`;

/** Largest registry body read; the "latest" document is a few KiB. */
const MAX_BODY_BYTES = 512 * 1024;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `~/.darwin/update-check.json`. */
export function updateCheckFile(): string {
  return path.join(userDarwinDir(), 'update-check.json');
}

/** What the cache file holds. `latest` is absent when the last request failed. */
export interface UpdateCheckCache {
  checkedAt: number;
  latest?: string;
}

export interface UpdateAvailable {
  current: string;
  latest: string;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  /** `DARWIN_PACKAGE_ROOT`; a `.git` entry there means a development checkout. */
  packageRoot: string | undefined;
  /** Resolved config `updateCheck` (`undefined` = default on). */
  enabled: boolean | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  cacheFile?: string;
  registryUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Semver precedence (build metadata ignored); `undefined` when either is not semver. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = SEMVER.exec(a.trim());
  const right = SEMVER.exec(b.trim());
  if (left === null || right === null) return undefined;
  for (let index = 1; index <= 3; index += 1) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff !== 0) return Math.sign(diff);
  }
  const preLeft = left[4];
  const preRight = right[4];
  if (preLeft === undefined || preRight === undefined) {
    // A release outranks any prerelease of the same triple.
    return preLeft === preRight ? 0 : preLeft === undefined ? 1 : -1;
  }
  const idsLeft = preLeft.split('.');
  const idsRight = preRight.split('.');
  for (let index = 0; index < Math.max(idsLeft.length, idsRight.length); index += 1) {
    const x = idsLeft[index];
    const y = idsRight[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** The one startup notice line. */
export function formatUpdateNotice(update: UpdateAvailable): string {
  return `update available: ${DARWIN_PACKAGE_NAME} ${update.latest} (you have ${update.current}) · run \`${UPGRADE_COMMAND}\``;
}

/** Why no check runs, or `undefined` when it may. Performs no network I/O. */
export async function updateCheckSkipReason(
  options: Pick<UpdateCheckOptions, 'currentVersion' | 'packageRoot' | 'enabled' | 'env'>,
): Promise<string | undefined> {
  if (options.enabled === false) return 'config';
  const flag = (options.env ?? process.env)[UPDATE_CHECK_ENV];
  if (flag !== undefined && flag !== '' && flag !== '0') return 'env';
  if (SEMVER.exec(options.currentVersion) === null) return 'unknown-version';
  if (options.packageRoot === undefined) return 'unknown-root';
  try {
    await lstat(path.join(options.packageRoot, '.git'));
    return 'checkout';
  } catch {
    return undefined;
  }
}

/**
 * The newer version to announce, or `undefined`. Uses the cache when fresh,
 * otherwise asks the registry once and records the answer. Never throws.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<UpdateAvailable | undefined> {
  try {
    if ((await updateCheckSkipReason(options)) !== undefined) return undefined;
    const now = (options.now ?? Date.now)();
    const file = options.cacheFile ?? updateCheckFile();
    let latest: string | undefined;
    const cached = await readCache(file);
    // A timestamp in the future (clock moved back) is not trusted as fresh.
    if (cached !== undefined && cached.checkedAt <= now && now - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
      latest = cached.latest;
    } else {
      latest = await fetchLatest(
        options.registryUrl ?? DEFAULT_REGISTRY_URL,
        options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS,
        options.fetchImpl ?? fetch,
      );
      await writeCache(file, latest === undefined ? { checkedAt: now } : { checkedAt: now, latest });
    }
    if (latest === undefined) return undefined;
    return compareVersions(latest, options.currentVersion) === 1
      ? { current: options.currentVersion, latest }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readCache(file: string): Promise<UpdateCheckCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    if (typeof parsed['checkedAt'] !== 'number' || !Number.isFinite(parsed['checkedAt'])) return undefined;
    const latest = parsed['latest'];
    if (latest !== undefined && (typeof latest !== 'string' || SEMVER.exec(latest) === null)) return undefined;
    return latest === undefined ? { checkedAt: parsed['checkedAt'] } : { checkedAt: parsed['checkedAt'], latest };
  } catch {
    return undefined;
  }
}

async function writeCache(file: string, cache: UpdateCheckCache): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename so a concurrent darwin never reads a torn file.
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } catch {
    // An unwritable cache only means the next launch asks again.
  }
}

async function fetchLatest(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
    const body = await response.text();
    if (body.length > MAX_BODY_BYTES) return undefined;
    const version = (JSON.parse(body) as { version?: unknown }).version;
    return typeof version === 'string' && SEMVER.exec(version) !== null ? version : undefined;
  } catch {
    return undefined;
  }
}
