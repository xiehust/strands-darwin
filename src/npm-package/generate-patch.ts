/**
 * Build step: generate the `patch-package` copy of every pinned pnpm patch.
 *
 * `pnpm build` runs this after `tsc` (`node dist/src/npm-package/generate-patch.js`).
 * It reads `patches/*.patch` — the pnpm patches `pnpm patch-commit` writes and
 * `pnpm-workspace.yaml` applies — and writes their patch-package dialect to
 * `dist/patches/` (see `patch-package-format.ts` for the two differences). That
 * directory is a build artifact like the rest of `dist/`: gitignored, and shipped by
 * the `files` whitelist in `package.json`, where `postinstall` runs
 * `patch-package --patch-dir dist/patches` against it.
 *
 * Both install paths stay green because of what patch-package does at the edges:
 * a fresh clone's `pnpm install` runs `postinstall` before any build, finds no
 * `dist/patches/` and exits 0 ("No patch files found"); a developer's later
 * `pnpm install` finds the generated file but an SDK pnpm has already patched, and
 * exits 0 as well (already applied). `spike/verify-npm-patch-format.ts` pins the
 * conversion; `spike/verify-npm-package.ts` packs and installs the real tarball.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { DARWIN_PACKAGE_NAME } from '../version.js';
import { parsePnpmPatchFileName, patchPackageFileName, toPatchPackageFormat } from './patch-package-format.js';

/** One generated file: its source pnpm patch and where the patch-package copy went. */
export interface GeneratedPatch {
  readonly source: string;
  readonly output: string;
}

/**
 * Convert every pnpm patch in `patchesDir` into `outputDir`, which is recreated from
 * scratch so a renamed or removed source never leaves a stale copy behind. Files
 * whose names are not in pnpm's `name@version.patch` shape are skipped and reported.
 */
export function generatePatchPackageFiles(options: {
  readonly patchesDir: string;
  readonly outputDir: string;
}): { readonly generated: readonly GeneratedPatch[]; readonly skipped: readonly string[] } {
  const generated: GeneratedPatch[] = [];
  const skipped: string[] = [];
  const sources = readdirSync(options.patchesDir).filter((name) => name.endsWith('.patch')).sort();
  rmSync(options.outputDir, { recursive: true, force: true });
  mkdirSync(options.outputDir, { recursive: true });
  for (const fileName of sources) {
    const identity = parsePnpmPatchFileName(fileName);
    if (identity === undefined) {
      skipped.push(fileName);
      continue;
    }
    const source = path.join(options.patchesDir, fileName);
    const output = path.join(options.outputDir, patchPackageFileName(identity));
    writeFileSync(output, toPatchPackageFormat(readFileSync(source, 'utf8'), identity.packageName), 'utf8');
    generated.push({ source, output });
  }
  return { generated, skipped };
}

/**
 * The package root, found by walking up from this module to the `package.json` that
 * names darwin — the same rule `version.ts` uses, so it holds for `src/npm-package/`
 * under tsx and `dist/src/npm-package/` after a build alike.
 */
export function findPackageRoot(start: string = import.meta.dirname): string {
  let directory = start;
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as { name?: unknown };
      if (parsed.name === DARWIN_PACKAGE_NAME) return directory;
    } catch {
      // Not this directory: keep walking.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`generate-patch: no package.json named ${DARWIN_PACKAGE_NAME} above ${start}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = findPackageRoot();
  const { generated, skipped } = generatePatchPackageFiles({
    patchesDir: path.join(root, 'patches'),
    outputDir: path.join(root, 'dist', 'patches'),
  });
  for (const { source, output } of generated) {
    process.stdout.write(`generated ${path.relative(root, output)} from ${path.relative(root, source)}\n`);
  }
  for (const name of skipped) process.stderr.write(`generate-patch: skipped patches/${name} (not a pnpm patch file name)\n`);
  if (generated.length === 0) {
    process.stderr.write('generate-patch: no pnpm patch found under patches/\n');
    process.exitCode = 1;
  }
}
