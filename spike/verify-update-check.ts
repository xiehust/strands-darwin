/**
 * Free checks for the startup update check (`src/update-check.ts`). No external
 * network: registry answers come from an injected `fetch` or a loopback HTTP server.
 *
 * Pins: semver precedence; every off switch (config, `DARWIN_NO_UPDATE_CHECK`,
 * development checkout, unknown version) stops the check before any request; one
 * request per 24h with the answer *and* failures cached; a fresh cache is compared
 * against the current version; every failure shape (throw, non-2xx, bad JSON,
 * non-semver, timeout, unwritable cache) yields no notice and never throws; this
 * checkout is itself a checkout, so pty suites never reach the registry; only the
 * interactive path calls the check.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  UPDATE_CHECK_INTERVAL_MS,
  UPGRADE_COMMAND,
  checkForUpdate,
  compareVersions,
  formatUpdateNotice,
  updateCheckSkipReason,
  type UpdateCheckOptions,
} from '../src/update-check.js';
import { DARWIN_PACKAGE_ROOT } from '../src/version.js';
import { assert, header, report } from './shared.js';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'darwin-update-check-'));
const installedRoot = path.join(scratch, 'installed');
await mkdir(installedRoot, { recursive: true });
let fileIndex = 0;
const freshCache = (): string => path.join(scratch, `cache-${(fileIndex += 1)}.json`);

/** A fake `fetch` that counts calls and answers with `answer()`. */
function fakeFetch(answer: () => Response | Promise<Response>): { impl: typeof fetch; calls: () => number } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    return answer();
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function base(overrides: Partial<UpdateCheckOptions>): UpdateCheckOptions {
  return { currentVersion: '0.0.43', packageRoot: installedRoot, enabled: true, env: {}, ...overrides };
}

header('update check — version precedence');
assert('patch bump is newer', compareVersions('0.0.44', '0.0.43') === 1);
assert('equal versions compare equal', compareVersions('0.0.43', '0.0.43') === 0);
assert('numeric, not lexical, components', compareVersions('0.0.10', '0.0.9') === 1 && compareVersions('0.1.0', '0.0.99') === 1);
assert('older is older', compareVersions('0.0.42', '0.0.43') === -1);
assert('a release outranks its prerelease', compareVersions('1.0.0', '1.0.0-rc.1') === 1 && compareVersions('1.0.0-rc.1', '1.0.0') === -1);
assert('prerelease identifiers compare numerically', compareVersions('1.0.0-rc.10', '1.0.0-rc.2') === 1);
assert('alphanumeric identifiers compare lexically', compareVersions('1.0.0-beta', '1.0.0-alpha') === 1);
assert('numeric identifiers rank below alphanumeric', compareVersions('1.0.0-1', '1.0.0-alpha') === -1);
assert('a longer prerelease set outranks its prefix', compareVersions('1.0.0-alpha.1', '1.0.0-alpha') === 1);
assert('build metadata is ignored', compareVersions('1.0.0+abc', '1.0.0') === 0);
assert('non-semver input is not comparable', compareVersions('unknown', '0.0.43') === undefined && compareVersions('0.0.43', 'latest') === undefined);

header('update check — off switches stop it before any request');
{
  const never = fakeFetch(() => json({ version: '9.9.9' }));
  const cacheFile = freshCache();
  assert('config false skips', (await updateCheckSkipReason(base({ enabled: false }))) === 'config');
  assert('…and makes no request', (await checkForUpdate(base({ enabled: false, fetchImpl: never.impl, cacheFile }))) === undefined);
  assert('DARWIN_NO_UPDATE_CHECK=1 skips', (await updateCheckSkipReason(base({ env: { DARWIN_NO_UPDATE_CHECK: '1' } }))) === 'env');
  assert('…and makes no request', (await checkForUpdate(base({ env: { DARWIN_NO_UPDATE_CHECK: '1' }, fetchImpl: never.impl, cacheFile }))) === undefined);
  assert('DARWIN_NO_UPDATE_CHECK=0 and empty do not skip',
    (await updateCheckSkipReason(base({ env: { DARWIN_NO_UPDATE_CHECK: '0' } }))) === undefined &&
    (await updateCheckSkipReason(base({ env: { DARWIN_NO_UPDATE_CHECK: '' } }))) === undefined);
  assert('an unknown current version skips', (await updateCheckSkipReason(base({ currentVersion: 'unknown' }))) === 'unknown-version');
  assert('an unknown package root skips', (await updateCheckSkipReason(base({ packageRoot: undefined }))) === 'unknown-root');

  const checkoutDir = path.join(scratch, 'checkout');
  await mkdir(path.join(checkoutDir, '.git'), { recursive: true });
  assert('a .git directory marks a development checkout', (await updateCheckSkipReason(base({ packageRoot: checkoutDir }))) === 'checkout');
  const worktree = path.join(scratch, 'worktree');
  await mkdir(worktree, { recursive: true });
  await writeFile(path.join(worktree, '.git'), 'gitdir: /elsewhere\n');
  assert('a .git file (worktree) marks a checkout too', (await updateCheckSkipReason(base({ packageRoot: worktree }))) === 'checkout');
  assert('…and a checkout makes no request', (await checkForUpdate(base({ packageRoot: checkoutDir, fetchImpl: never.impl, cacheFile }))) === undefined);
  assert('no skipped check requested anything', never.calls() === 0);
  assert('no skipped check wrote a cache', await readFile(cacheFile, 'utf8').then(() => false, () => true));

  assert('this repository is a checkout, so pty suites never reach the registry',
    (await updateCheckSkipReason({ currentVersion: '0.0.1', packageRoot: DARWIN_PACKAGE_ROOT, enabled: true, env: {} })) === 'checkout');
}

header('update check — one request per interval, answer cached');
{
  const cacheFile = freshCache();
  const registry = fakeFetch(() => json({ name: 'strands-darwin', version: '0.0.44' }));
  let now = 1_000_000_000_000;
  const options = base({ fetchImpl: registry.impl, cacheFile, now: () => now });
  const first = await checkForUpdate(options);
  assert('a newer registry version is announced', first?.latest === '0.0.44' && first.current === '0.0.43');
  assert('…after exactly one request', registry.calls() === 1);
  const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, unknown>;
  assert('the cache records time and version', cached['checkedAt'] === now && cached['latest'] === '0.0.44');

  now += UPDATE_CHECK_INTERVAL_MS - 1;
  const second = await checkForUpdate(options);
  assert('within 24h the cache answers', second?.latest === '0.0.44' && registry.calls() === 1);
  assert('a fresh cache is compared against the current version (upgrade silences it)',
    (await checkForUpdate({ ...options, currentVersion: '0.0.44' })) === undefined && registry.calls() === 1);

  now += 1;
  await checkForUpdate(options);
  assert('after 24h the registry is asked again', registry.calls() === 2);

  const skewed = await checkForUpdate({ ...options, now: () => now - 10 * UPDATE_CHECK_INTERVAL_MS });
  assert('a cache stamped in the future is not trusted', registry.calls() === 3 && skewed?.latest === '0.0.44');

  await writeFile(cacheFile, '{ torn');
  await checkForUpdate(options);
  assert('a corrupt cache is replaced by a request', registry.calls() === 4);
}

header('update check — no notice when not newer');
{
  const same = fakeFetch(() => json({ version: '0.0.43' }));
  assert('same version: none', (await checkForUpdate(base({ fetchImpl: same.impl, cacheFile: freshCache() }))) === undefined);
  const older = fakeFetch(() => json({ version: '0.0.40' }));
  assert('older registry version: none', (await checkForUpdate(base({ fetchImpl: older.impl, cacheFile: freshCache() }))) === undefined);
  const pre = fakeFetch(() => json({ version: '0.0.43-rc.1' }));
  assert('a prerelease of the installed version: none', (await checkForUpdate(base({ fetchImpl: pre.impl, cacheFile: freshCache() }))) === undefined);
}

header('update check — failures are silent and cached');
{
  const cacheFile = freshCache();
  let now = 2_000_000_000_000;
  const offline = fakeFetch(() => { throw new TypeError('fetch failed'); });
  const options = base({ fetchImpl: offline.impl, cacheFile, now: () => now });
  assert('a network error yields no notice', (await checkForUpdate(options)) === undefined);
  const cached = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, unknown>;
  assert('…and the failure is cached without a version', cached['checkedAt'] === now && !('latest' in cached));
  now += 60_000;
  await checkForUpdate(options);
  assert('…so an offline machine does not retry within 24h', offline.calls() === 1);

  const shapes: Array<[string, () => Response]> = [
    ['a 404', () => json({ error: 'not found' }, 404)],
    ['a 500', () => json({}, 500)],
    ['malformed JSON', () => new Response('<html>', { status: 200 })],
    ['a missing version', () => json({ name: 'strands-darwin' })],
    ['a non-semver version', () => json({ version: 'latest' })],
    ['an oversized body', () => new Response(`{"version":"9.9.9","pad":"${'x'.repeat(600 * 1024)}"}`, { status: 200 })],
  ];
  for (const [what, answer] of shapes) {
    const registry = fakeFetch(answer);
    assert(`${what} yields no notice`, (await checkForUpdate(base({ fetchImpl: registry.impl, cacheFile: freshCache() }))) === undefined);
  }

  const blocker = path.join(scratch, 'not-a-dir');
  await writeFile(blocker, 'file');
  const registry = fakeFetch(() => json({ version: '0.0.44' }));
  const unwritable = await checkForUpdate(base({ fetchImpl: registry.impl, cacheFile: path.join(blocker, 'update-check.json') }));
  assert('an unwritable cache still announces, without throwing', unwritable?.latest === '0.0.44');
}

header('update check — real fetch over loopback');
{
  let requested = '';
  let accept = '';
  let delayMs = 0;
  const server = createServer((request, response) => {
    requested = request.url ?? '';
    accept = String(request.headers['accept'] ?? '');
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ name: 'strands-darwin', version: '0.1.0' }));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const registryUrl = `http://127.0.0.1:${port}/strands-darwin/latest`;

  const found = await checkForUpdate(base({ registryUrl, cacheFile: freshCache() }));
  assert('the real fetch path reads the version', found?.latest === '0.1.0');
  assert('…from the latest document, asking for JSON', requested === '/strands-darwin/latest' && accept.includes('application/json'));

  delayMs = 2000;
  const started = Date.now();
  const slow = await checkForUpdate(base({ registryUrl, cacheFile: freshCache(), timeoutMs: 200 }));
  const elapsed = Date.now() - started;
  assert(`a slow registry times out silently (${elapsed}ms)`, slow === undefined && elapsed < 1500);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

header('update check — notice text and call sites');
{
  const text = formatUpdateNotice({ current: '0.0.43', latest: '0.0.44' });
  assert('the notice names both versions and the command',
    text === `update available: strands-darwin 0.0.44 (you have 0.0.43) · run \`${UPGRADE_COMMAND}\`` &&
    UPGRADE_COMMAND === 'npm install -g strands-darwin@latest');

  const cliMain = await readFile(path.resolve('src/cli-main.ts'), 'utf8');
  const interactive = cliMain.slice(cliMain.indexOf('async function runInteractive('), cliMain.indexOf('function errorMessage('));
  assert('the interactive path starts the check', interactive.includes('startupUpdateNotice(projectRoot)'));
  assert('…and it is called nowhere else', cliMain.split('startupUpdateNotice(').length === 3);
  for (const file of ['src/headless-runner.ts', 'src/headless.ts', 'src/cli-doctor.ts', 'src/cli.ts', 'src/agent/runtime.ts']) {
    const source = await readFile(path.resolve(file), 'utf8');
    assert(`${file} never imports the update check`, !source.includes('update-check'));
  }
}

report();
