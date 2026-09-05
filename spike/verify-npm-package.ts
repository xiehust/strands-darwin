/**
 * The npm package end to end, with the real registry: build, `npm pack`, `npm install -g`
 * into a temporary prefix, run the installed `darwin`, and prove that an install which
 * skipped `postinstall` is refused with the one clear message instead of the raw ESM
 * `DEFAULT_SUMMARIZATION_PROMPT` error.
 *
 * **Not in `pnpm test`.** `npm install -g <tarball>` resolves darwin's dependencies
 * from the registry (the SDK, Ink, and the SDK's optional `@tobilu/qmd` chain — about
 * 350 packages, ~13 s warm, minutes cold), so this suite needs network access and is
 * run standalone. The offline half — the pnpm→patch-package conversion, the
 * generator, the manifest facts, the preflight's notice and import-graph placement —
 * is `spike/verify-npm-patch-format.ts`, which `pnpm test` does run.
 *
 * What it asserts, in order:
 * - `pnpm build` succeeds and leaves `dist/patches/@strands-agents+sdk+1.16.0.patch`;
 * - `npm pack --ignore-scripts` (the tree is freshly built, so `prepack` need not
 *   rebuild) lists `dist/src/**` incl. every built-in skill's `SKILL.md`, the generated
 *   patch, `README.md` (npm adds every `README*`, so `README.zh-CN.md` too), `package.json`
 *   — and no `dist/spike/`, `src/`, `spike/`, `docs/`, `patches/`, `attachments/` or
 *   dotfile entry;
 * - `npm install -g --prefix <tmp> <tarball>` exits 0, runs `postinstall`, and the
 *   installed SDK carries `DEFAULT_SUMMARIZATION_PROMPT` in `dist/src/index.js` and
 *   `excludeTools` in `dist/src/vended-plugins/context-offloader/plugin.js`;
 * - `<prefix>/bin/darwin --version` prints the manifest version (not `unknown`),
 *   `--help` prints the grammar, and `darwin doctor` exits 0 in an empty directory
 *   under a pristine HOME;
 * - a second install with `--ignore-scripts` leaves the SDK unpatched, and its
 *   `darwin --help` exits 1 with the refusal naming `patch-package`, `postinstall`,
 *   `npm install -g strands-darwin` and `pnpm add -g` as unsupported — and never the
 *   raw `does not provide an export named` text.
 *
 * Every temporary directory (pack destination, both prefixes, the empty project, the
 * pristine HOME) is removed in `finally`. Layout assumptions are npm's POSIX global
 * layout (`<prefix>/bin`, `<prefix>/lib/node_modules`).
 *
 * Run: pnpm tsx spike/verify-npm-package.ts
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLI_USAGE } from '../src/cli-usage.js';
import { SDK_PATCH_MARKERS } from '../src/sdk-patch-preflight.js';
import { assert, header, report } from './shared.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
const GENERATED_PATCH = 'dist/patches/@strands-agents+sdk+1.16.0.patch';
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

function run(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv; timeout?: number }): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env },
    timeout: options.timeout ?? INSTALL_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function installedPackageDir(prefix: string): string {
  return path.join(prefix, 'lib', 'node_modules', manifest.name);
}

function sdkFile(prefix: string, file: string): string {
  return path.join(installedPackageDir(prefix), 'node_modules', '@strands-agents', 'sdk', 'dist', 'src', file);
}

function hasToken(file: string, token: string): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').includes(token);
}

const temp = mkdtempSync(path.join(os.tmpdir(), 'darwin-npm-package-'));
const packDestination = path.join(temp, 'pack');
const prefix = path.join(temp, 'prefix');
const unpatchedPrefix = path.join(temp, 'prefix-ignore-scripts');
const emptyProject = path.join(temp, 'empty-project');
const pristineHome = path.join(temp, 'home');
for (const dir of [packDestination, prefix, unpatchedPrefix, emptyProject, pristineHome]) mkdirSync(dir);
try {
  header('build: the tree the tarball is packed from');
  const build = run('pnpm', ['build'], { cwd: ROOT });
  assert('pnpm build exits 0', build.status === 0);
  assert(`the build generated ${GENERATED_PATCH}`, existsSync(path.join(ROOT, GENERATED_PATCH)));
  const builtinSkills = readdirSync(path.join(ROOT, 'src', 'skills', 'builtin'));
  assert(`the built tree carries every built-in skill (${builtinSkills.join(', ')})`,
    builtinSkills.length >= 4 && builtinSkills.every((name) => existsSync(path.join(ROOT, 'dist', 'src', 'skills', 'builtin', name, 'SKILL.md'))));

  header('npm pack: the entry list is the whitelist and nothing else');
  const pack = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDestination], { cwd: ROOT });
  assert('npm pack exits 0', pack.status === 0);
  const packed = (JSON.parse(pack.stdout) as Array<{ filename: string; files: Array<{ path: string }>; name: string; version: string }>)[0]!;
  const entries = packed.files.map((file) => file.path);
  const tarball = path.join(packDestination, packed.filename);
  assert(`the tarball is ${packed.filename} for ${manifest.name}@${manifest.version} and exists`,
    packed.name === manifest.name && packed.version === manifest.version && existsSync(tarball));
  const forbidden = ['dist/spike/', 'src/', 'spike/', 'docs/', 'patches/', 'attachments/', 'node_modules/', '.'];
  const offending = entries.filter((entry) => forbidden.some((prefixText) => entry.startsWith(prefixText)));
  assert(`no dist/spike, src, spike, docs, patches, attachments or dotfile entry${offending.length > 0 ? ` (offending: ${offending.slice(0, 5).join(', ')})` : ''}`,
    offending.length === 0);
  assert('dist/src/cli.js, the generated patch, README.md and package.json are in',
    ['dist/src/cli.js', 'dist/src/cli-main.js', GENERATED_PATCH, 'README.md', 'package.json'].every((entry) => entries.includes(entry)));
  assert('every built-in skill SKILL.md is in',
    builtinSkills.every((name) => entries.includes(`dist/src/skills/builtin/${name}/SKILL.md`)));
  assert('nothing outside dist/src, dist/patches, README* and package.json is in (npm always adds every README*, so README.zh-CN.md rides along)',
    entries.every((entry) => entry.startsWith('dist/src/') || entry.startsWith('dist/patches/') || /^README[^/]*$/.test(entry) || entry === 'package.json'));
  assert(`the tarball is bounded (${entries.length} entries): under 1000 entries`, entries.length < 1000);

  header('npm install -g into a temporary prefix: postinstall patches the SDK');
  const install = run('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', tarball], { cwd: temp });
  assert(`npm install -g exits 0${install.status === 0 ? '' : ` (stderr: ${install.stderr.slice(0, 800)})`}`, install.status === 0);
  const bin = path.join(prefix, 'bin', 'darwin');
  assert('<prefix>/bin/darwin exists and the package landed under lib/node_modules', existsSync(bin) && existsSync(installedPackageDir(prefix)));
  assert('the shipped generated patch is in the installed package', existsSync(path.join(installedPackageDir(prefix), GENERATED_PATCH)));
  for (const { file, token } of SDK_PATCH_MARKERS) {
    assert(`the installed SDK's dist/src/${file} carries ${token}`, hasToken(sdkFile(prefix, file), token));
  }

  header('the installed binary: --version, --help, doctor in an empty directory');
  const env = { HOME: pristineHome, DARWIN_MODEL_PRICES_FETCH: 'off' };
  const version = run(bin, ['--version'], { cwd: emptyProject, env });
  assert(`darwin --version prints "darwin ${manifest.version}" (the manifest version, not unknown), exit 0`,
    version.status === 0 && version.stdout === `darwin ${manifest.version}\n` && version.stderr === '');
  const help = run(bin, ['--help'], { cwd: emptyProject, env });
  assert('darwin --help prints the grammar, exit 0', help.status === 0 && help.stdout === CLI_USAGE && help.stderr === '');
  const doctor = run(bin, ['doctor'], { cwd: emptyProject, env });
  assert(`darwin doctor exits 0 in an empty directory under a pristine HOME${doctor.status === 0 ? '' : ` (stdout: ${doctor.stdout.slice(-600)} stderr: ${doctor.stderr.slice(0, 400)})`}`,
    doctor.status === 0 && doctor.stdout.includes('no problems found'));
  assert('doctor created nothing in the pristine HOME or the empty project',
    readdirSync(pristineHome).length === 0 && readdirSync(emptyProject).length === 0);

  header('--ignore-scripts install: unpatched SDK, one clear refusal, exit 1');
  const skipped = run('npm', ['install', '-g', '--prefix', unpatchedPrefix, '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', tarball], { cwd: temp });
  assert('npm install -g --ignore-scripts exits 0 (npm does not refuse it; darwin must)', skipped.status === 0);
  assert('negative control: without postinstall the installed SDK lacks both markers',
    SDK_PATCH_MARKERS.every(({ file, token }) => existsSync(sdkFile(unpatchedPrefix, file)) && !hasToken(sdkFile(unpatchedPrefix, file), token)));
  const refused = run(path.join(unpatchedPrefix, 'bin', 'darwin'), ['--help'], { cwd: emptyProject, env });
  assert('darwin --help exits 1 with nothing on stdout', refused.status === 1 && refused.stdout === '');
  assert('stderr says the SDK is not patched and names both missing markers',
    refused.stderr.startsWith('error: the installed @strands-agents/sdk is not patched (missing: DEFAULT_SUMMARIZATION_PROMPT in index.js, excludeTools in vended-plugins/context-offloader/plugin.js).\n'));
  assert('it names patch-package, postinstall, --ignore-scripts, the supported route and the unsupported one',
    ['`patch-package`', '`postinstall`', '--ignore-scripts', '`npm install -g strands-darwin`', '`pnpm add -g`, which is unsupported']
      .every((needle) => refused.stderr.includes(needle)));
  assert('the raw ESM linking error never appears',
    !refused.stderr.includes('does not provide an export named') && !refused.stderr.includes('SyntaxError'));
  assert('the refusal is bounded: five lines', refused.stderr.trimEnd().split('\n').length === 5);
  const refusedVersion = run(path.join(unpatchedPrefix, 'bin', 'darwin'), ['--version'], { cwd: emptyProject, env });
  assert('--version is refused the same way (the preflight precedes every local answer)',
    refusedVersion.status === 1 && refusedVersion.stdout === '' && refusedVersion.stderr === refused.stderr);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

report();
