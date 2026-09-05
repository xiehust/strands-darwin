/**
 * The npm package's build-time and start-time halves, without npm: the pnpm-patch →
 * patch-package conversion, the generator that runs inside `pnpm build`, the manifest
 * facts `npm install -g strands-darwin` relies on, and the SDK-patch preflight that
 * refuses an unpatched install before ESM linking could crash on it.
 *
 * Free and offline — `patch-package` is invoked from `node_modules/.bin` against the
 * repository's own (pnpm-patched) SDK, which is the developer-path guarantee: the root
 * `postinstall` must exit 0 when the generated patch dir is absent (fresh clone, before
 * any build) and when the SDK is already patched (every later `pnpm install`). The
 * real tarball — `npm pack`, `npm install -g --prefix`, the installed binary, the
 * `--ignore-scripts` refusal — is `spike/verify-npm-package.ts`, which needs the
 * registry and therefore stays out of `pnpm test`.
 *
 * Run: pnpm tsx spike/verify-npm-patch-format.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { generatePatchPackageFiles, findPackageRoot } from '../src/npm-package/generate-patch.js';
import {
  parsePnpmPatchFileName,
  patchPackageFileName,
  patchPackagePathPrefix,
  toPatchPackageFormat,
} from '../src/npm-package/patch-package-format.js';
import {
  missingSdkPatchMarkers,
  SDK_PATCH_MARKERS,
  SDK_PATCH_PREFLIGHT_EXIT_CODE,
  sdkPatchPreflight,
  unpatchedSdkNotice,
} from '../src/sdk-patch-preflight.js';
import { DARWIN_PACKAGE_NAME } from '../src/version.js';
import { assert, header, report } from './shared.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SDK = '@strands-agents/sdk';
const PNPM_PATCH_NAME = `${SDK.replace('/', '__')}@1.16.0.patch`;
const GENERATED_NAME = `${SDK.replace('/', '+')}+1.16.0.patch`;
const PREFIX = `node_modules/${SDK}/`;

header('file names: pnpm dialect in, patch-package dialect out');
const identity = parsePnpmPatchFileName(PNPM_PATCH_NAME);
assert('the pinned pnpm file name parses to the scoped package and its exact version',
  isDeepStrictEqual(identity, { packageName: SDK, version: '1.16.0' }));
assert('an unscoped pnpm name parses too',
  isDeepStrictEqual(parsePnpmPatchFileName('left-pad@1.3.0.patch'), { packageName: 'left-pad', version: '1.3.0' }));
assert('a name outside pnpm\'s shape is refused, not guessed',
  parsePnpmPatchFileName('notes.patch') === undefined && parsePnpmPatchFileName('README.md') === undefined);
assert('the patch-package name is the identity with both separators turned into +',
  identity !== undefined && patchPackageFileName(identity) === GENERATED_NAME);
assert('the path prefix roots the package under node_modules with a trailing slash',
  patchPackagePathPrefix(SDK) === PREFIX);

header('body conversion: only the three path header lines change');
const fixture = [
  'diff --git a/dist/src/index.js b/dist/src/index.js',
  'index 3cb62b85..4a1febbd 100644',
  '--- a/dist/src/index.js',
  '+++ b/dist/src/index.js',
  '@@ -52,6 +52,7 @@ export { ConversationManager, } from ...',
  ' export { Foo } from "./foo.js";',
  '+export { DEFAULT_SUMMARIZATION_PROMPT } from "./x.js";',
  '-removed line that mentions --- a/ and b/ in its text',
  'diff --git a/dist/new.js b/dist/new.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/dist/new.js',
  '@@ -0,0 +1 @@',
  '+export const fresh = 1;',
  '',
].join('\n');
const converted = toPatchPackageFormat(fixture, SDK);
const convertedLines = converted.split('\n');
assert('diff --git carries the prefix on both sides',
  convertedLines[0] === `diff --git a/${PREFIX}dist/src/index.js b/${PREFIX}dist/src/index.js`);
assert('--- a/ and +++ b/ carry the prefix', convertedLines[2] === `--- a/${PREFIX}dist/src/index.js` && convertedLines[3] === `+++ b/${PREFIX}dist/src/index.js`);
assert('the index line, hunk header and hunk body are byte-identical',
  convertedLines[1] === 'index 3cb62b85..4a1febbd 100644' && convertedLines[4] === fixture.split('\n')[4]
  && convertedLines[5] === fixture.split('\n')[5] && convertedLines[6] === fixture.split('\n')[6]);
assert('a removed body line that merely mentions the markers is untouched', convertedLines[7] === fixture.split('\n')[7]);
assert('a /dev/null side stays /dev/null, the other side gets the prefix',
  convertedLines[10] === '--- /dev/null' && convertedLines[11] === `+++ b/${PREFIX}dist/new.js`);
assert('line count and trailing newline are preserved', convertedLines.length === fixture.split('\n').length && converted.endsWith('\n'));
assert('the conversion is idempotent (its output converts to itself)', toPatchPackageFormat(converted, SDK) === converted);

header('the pinned patch converts wholesale');
const pinnedSource = readFileSync(path.join(ROOT, 'patches', PNPM_PATCH_NAME), 'utf8');
const pinnedConverted = toPatchPackageFormat(pinnedSource, SDK);
const sourceLines = pinnedSource.split('\n');
const outLines = pinnedConverted.split('\n');
const headerLine = (line: string): boolean => line.startsWith('diff --git ') || line.startsWith('--- ') || line.startsWith('+++ ');
const fileCount = sourceLines.filter((line) => line.startsWith('diff --git ')).length;
assert(`the pinned patch touches ${fileCount} files (a real multi-file patch, so the loop is exercised)`, fileCount >= 10);
assert('every header line in the output carries the node_modules prefix',
  outLines.filter(headerLine).every((line) => line.includes(`a/${PREFIX}`) || line.includes(`b/${PREFIX}`) || line.includes('/dev/null'))
  && outLines.filter(headerLine).length === sourceLines.filter(headerLine).length);
assert('every non-header line is byte-identical to the pnpm source',
  outLines.length === sourceLines.length && outLines.every((line, i) => headerLine(line) || line === sourceLines[i]));
assert('the pinned patch is not already in patch-package format (the conversion is not a no-op)', pinnedConverted !== pinnedSource);
assert('the converted pinned patch is idempotent', toPatchPackageFormat(pinnedConverted, SDK) === pinnedConverted);

header('the generator writes dist/patches from patches/, and only from pnpm-shaped names');
const work = mkdtempSync(path.join(os.tmpdir(), 'darwin-npm-patch-'));
try {
  const patchesDir = path.join(work, 'patches');
  const outputDir = path.join(work, 'dist', 'patches');
  mkdirSync(patchesDir, { recursive: true });
  writeFileSync(path.join(patchesDir, PNPM_PATCH_NAME), pinnedSource, 'utf8');
  writeFileSync(path.join(patchesDir, 'notes.patch'), 'not a pnpm patch\n', 'utf8');
  writeFileSync(path.join(patchesDir, 'README.md'), 'ignored\n', 'utf8');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'stale+0.0.0.patch'), 'stale\n', 'utf8');
  const result = generatePatchPackageFiles({ patchesDir, outputDir });
  assert('exactly the pinned patch is generated, under its patch-package name',
    result.generated.length === 1 && result.generated[0]?.output === path.join(outputDir, GENERATED_NAME)
    && result.generated[0]?.source === path.join(patchesDir, PNPM_PATCH_NAME));
  assert('the generated bytes are the conversion of the source',
    readFileSync(path.join(outputDir, GENERATED_NAME), 'utf8') === pinnedConverted);
  assert('a .patch outside pnpm\'s name shape is skipped and reported; non-.patch files are ignored silently',
    isDeepStrictEqual(result.skipped, ['notes.patch']) && !existsSync(path.join(outputDir, 'notes.patch')));
  assert('a stale file in the output dir does not survive a regeneration', !existsSync(path.join(outputDir, 'stale+0.0.0.patch')));
  assert('running the generator twice is idempotent',
    isDeepStrictEqual(generatePatchPackageFiles({ patchesDir, outputDir }), result)
    && readFileSync(path.join(outputDir, GENERATED_NAME), 'utf8') === pinnedConverted);
  assert('the package root is found from src/ (and therefore from dist/src/ with the same walk)',
    findPackageRoot() === ROOT && findPackageRoot(path.join(ROOT, 'dist', 'src', 'npm-package')) === ROOT);

  header('the root postinstall exits 0 on both developer-path edges');
  const patchPackage = path.join(ROOT, 'node_modules', '.bin', 'patch-package');
  const run = (patchDir: string) => spawnSync(patchPackage, ['--patch-dir', patchDir], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  const absent = run(path.relative(ROOT, path.join(work, 'no-such-dir')));
  assert('an absent patch dir (fresh clone before the first build) is "No patch files found", exit 0',
    absent.status === 0 && absent.stdout.includes('No patch files found'));
  const applied = run(path.relative(ROOT, outputDir));
  assert('the generated patch against the SDK pnpm already patched exits 0 (already applied, nothing rewritten)',
    applied.status === 0 && applied.stdout.includes(`${SDK}@1.16.0`));
  for (const { file, token } of SDK_PATCH_MARKERS) {
    const text = readFileSync(path.join(ROOT, 'node_modules', SDK, 'dist', 'src', file), 'utf8');
    assert(`${file} still carries ${token} exactly as pnpm left it (the second application changed nothing)`,
      text.includes(token) && !text.includes(`${token}${token}`));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

header('package.json: the facts npm install -g relies on');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
const scripts = manifest['scripts'] as Record<string, string>;
assert('the name is the unscoped registry name, and version.ts keys on the same constant',
  manifest['name'] === 'strands-darwin' && DARWIN_PACKAGE_NAME === manifest['name']);
assert('the executable stays darwin → ./dist/src/cli.js', isDeepStrictEqual(manifest['bin'], { darwin: './dist/src/cli.js' }));
assert('engines.node is the import.meta.dirname floor, >=20.11.0', isDeepStrictEqual(manifest['engines'], { node: '>=20.11.0' }));
assert('files whitelist: dist/src, dist/patches, README.md — nothing else',
  isDeepStrictEqual(manifest['files'], ['dist/src', 'dist/patches', 'README.md']));
assert('publishConfig.access is public', isDeepStrictEqual(manifest['publishConfig'], { access: 'public' }));
assert('patch-package is a runtime dependency (postinstall runs in the installed tree)',
  typeof (manifest['dependencies'] as Record<string, string>)['patch-package'] === 'string');
assert('postinstall applies the generated dir and nothing else', scripts['postinstall'] === 'patch-package --patch-dir dist/patches');
assert('build generates the patch after tsc and the skills copy', scripts['build']?.endsWith('&& node dist/src/npm-package/generate-patch.js') === true);
assert('prepack rebuilds, so a publish never ships a stale dist', scripts['prepack'] === 'npm run build');
assert('devEngines stays out (it kills npx-launched MCP servers)', !('devEngines' in manifest));
assert('the version answer stays "darwin <version>" — the bin name, not the package name',
  spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'src/cli.ts'), '--version'], { cwd: ROOT, encoding: 'utf8' }).stdout === `darwin ${manifest['version'] as string}\n`);

header('the preflight: markers, notice, and where it can run');
assert('the two markers are the root re-export and the offloader option',
  isDeepStrictEqual([...SDK_PATCH_MARKERS], [
    { file: 'index.js', token: 'DEFAULT_SUMMARIZATION_PROMPT' },
    { file: 'vended-plugins/context-offloader/plugin.js', token: 'excludeTools' },
  ]));
assert('unreadable files count as missing, one entry per marker',
  isDeepStrictEqual(missingSdkPatchMarkers(() => undefined),
    ['DEFAULT_SUMMARIZATION_PROMPT in index.js', 'excludeTools in vended-plugins/context-offloader/plugin.js']));
assert('a file lacking the token counts as missing, one containing it does not',
  isDeepStrictEqual(missingSdkPatchMarkers((file) => (file === 'index.js' ? 'export const other = 1;' : 'options.excludeTools')),
    ['DEFAULT_SUMMARIZATION_PROMPT in index.js']));
assert('a patched SDK yields no notice', unpatchedSdkNotice([]) === undefined);
const notice = unpatchedSdkNotice(['DEFAULT_SUMMARIZATION_PROMPT in index.js']) ?? '';
assert('the notice says the SDK patch was not applied and which marker is missing',
  notice.startsWith('error: the installed @strands-agents/sdk is not patched (missing: DEFAULT_SUMMARIZATION_PROMPT in index.js).'));
assert('it names patch-package and postinstall as the mechanism', notice.includes('`patch-package`') && notice.includes('`postinstall`'));
assert('it names the supported route and the unsupported one',
  notice.includes('`npm install -g strands-darwin`') && notice.includes('`pnpm add -g`, which is unsupported') && notice.includes('--ignore-scripts'));
assert('it is bounded: five lines, under 600 characters, newline-terminated',
  notice.endsWith('\n') && notice.trimEnd().split('\n').length === 5 && notice.length < 600 && !notice.includes('\n\n'));
assert('the exit code is nonzero', (SDK_PATCH_PREFLIGHT_EXIT_CODE as number) !== 0);
assert('against this repository\'s pnpm-patched SDK the preflight passes', sdkPatchPreflight() === undefined);

// Placement: ESM links the whole static import graph of the entry module before it
// runs any statement, so a refusal can only be printed by an entry whose static
// imports never reach the SDK. cli.ts may import node built-ins and the preflight;
// the preflight may import node built-ins and version.ts; the program proper is
// loaded with a dynamic import() after the check.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function staticImports(file: string): string[] {
  return [...stripComments(readFileSync(path.join(ROOT, file), 'utf8')).matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
}
const cliImports = staticImports('src/cli.ts');
assert(`cli.ts statically imports only node built-ins and the preflight (saw: ${cliImports.join(', ')})`,
  cliImports.length > 0 && cliImports.every((s) => s.startsWith('node:') || s === './sdk-patch-preflight.js'));
assert('cli.ts loads cli-main.js only through a dynamic import, after the check',
  /const \{ main \} = await import\('\.\/cli-main\.js'\)/.test(readFileSync(path.join(ROOT, 'src/cli.ts'), 'utf8'))
  && !cliImports.includes('./cli-main.js'));
const preflightImports = staticImports('src/sdk-patch-preflight.ts');
assert(`the preflight imports only node built-ins and version.ts (saw: ${preflightImports.join(', ')})`,
  preflightImports.every((s) => s.startsWith('node:') || s === './version.js'));
assert('cli-main.ts is where the SDK-reaching static imports live (runtime.js), and it exports main',
  staticImports('src/cli-main.ts').includes('./agent/runtime.js')
  && /export async function main\(\)/.test(readFileSync(path.join(ROOT, 'src/cli-main.ts'), 'utf8')));

report();
