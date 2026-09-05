/**
 * Conversion of a pnpm dependency patch into `patch-package` format.
 *
 * The repository pins its SDK patch once, as a pnpm patch
 * (`patches/@strands-agents__sdk@1.16.0.patch`, `pnpm patch-commit`, applied by
 * `pnpm-workspace.yaml` `patchedDependencies`). The npm package cannot use pnpm's
 * mechanism, so `postinstall` runs `patch-package`, which reads the *same* patch in a
 * slightly different dialect. The two formats differ only in two places:
 *
 * - **paths** — pnpm writes them relative to the package (`a/dist/src/index.js`),
 *   patch-package expects them rooted at the app (`a/node_modules/@strands-agents/sdk/dist/src/index.js`);
 * - **file name** — pnpm encodes the scope slash as `__` and separates the version
 *   with `@` (`@strands-agents__sdk@1.16.0.patch`), patch-package uses `+` for both
 *   (`@strands-agents+sdk+1.16.0.patch`).
 *
 * This module is the whole conversion, as pure functions. It is applied at build time
 * by `generate-patch.ts`, so there is never a second hand-maintained copy of the patch:
 * `pnpm patch-commit` stays the single source and the generated file is a build
 * artifact. Every function is idempotent — feeding it its own output changes nothing.
 */

/** The parsed identity of a pnpm patch file name. */
export interface PnpmPatchIdentity {
  /** The package name, scope slash restored (`@strands-agents/sdk`). */
  readonly packageName: string;
  /** The exact version the patch was recorded against (`1.16.0`). */
  readonly version: string;
}

const PNPM_PATCH_FILE = /^(?<name>@?[^@]+)@(?<version>[^@]+)\.patch$/;

/**
 * Parse a pnpm patch file name (`@scope__name@version.patch` or `name@version.patch`),
 * or `undefined` when the name is not in that shape.
 */
export function parsePnpmPatchFileName(fileName: string): PnpmPatchIdentity | undefined {
  const match = PNPM_PATCH_FILE.exec(fileName);
  if (match?.groups === undefined) return undefined;
  const { name, version } = match.groups as { name: string; version: string };
  return { packageName: name.replace('__', '/'), version };
}

/** The patch-package file name for an identity (`@strands-agents+sdk+1.16.0.patch`). */
export function patchPackageFileName(identity: PnpmPatchIdentity): string {
  return `${identity.packageName.replace('/', '+')}+${identity.version}.patch`;
}

/** Where patch-package expects the package to live, relative to the app root, with a trailing slash. */
export function patchPackagePathPrefix(packageName: string): string {
  return `node_modules/${packageName}/`;
}

/**
 * Rewrite a pnpm patch body into patch-package format by prefixing every path in the
 * `diff --git a/… b/…`, `--- a/…` and `+++ b/…` header lines with
 * `node_modules/<package>/`. Hunk bodies, `index` lines, mode lines and `/dev/null`
 * sides are untouched. Idempotent: a path that already carries the prefix is left alone.
 */
export function toPatchPackageFormat(pnpmPatch: string, packageName: string): string {
  const prefix = patchPackagePathPrefix(packageName);
  const withPrefix = (pathText: string): string =>
    pathText.startsWith(prefix) ? pathText : `${prefix}${pathText}`;
  return pnpmPatch
    .split('\n')
    .map((line) => {
      const header = /^diff --git a\/(?<from>.+) b\/(?<to>.+)$/.exec(line);
      if (header?.groups !== undefined) {
        const { from, to } = header.groups as { from: string; to: string };
        return `diff --git a/${withPrefix(from)} b/${withPrefix(to)}`;
      }
      if (line.startsWith('--- a/')) return `--- a/${withPrefix(line.slice('--- a/'.length))}`;
      if (line.startsWith('+++ b/')) return `+++ b/${withPrefix(line.slice('+++ b/'.length))}`;
      return line;
    })
    .join('\n');
}
