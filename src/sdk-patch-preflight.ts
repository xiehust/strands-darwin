/**
 * Startup preflight: refuse to run on an unpatched `@strands-agents/sdk`.
 *
 * darwin depends on its pinned SDK patch (`patches/@strands-agents__sdk@1.16.0.patch`).
 * pnpm applies it in a clone; the npm package applies it from `postinstall` with
 * `patch-package`. An install that skipped scripts (`npm install --ignore-scripts`,
 * or `pnpm add -g`, whose isolated layout patch-package cannot address) leaves the
 * SDK unpatched, and the first symptom used to be ESM's raw
 * `does not provide an export named 'DEFAULT_SUMMARIZATION_PROMPT'` from
 * `src/agent/compact.ts` — thrown while *linking* the module graph, before any
 * statement of `cli.ts` ran. That is why the check lives in a module whose imports
 * never reach the SDK and why `cli.ts` loads the rest of the program with a dynamic
 * `import()` only after it passed: a static import would fail first.
 *
 * The check reads two marker files instead of importing the SDK, so `--help` stays
 * cheap and no SDK module is evaluated before the refusal: the root re-export that
 * the raw error was about, and the `excludeTools` option of the context offloader,
 * which an unpatched SDK would silently ignore at runtime.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DARWIN_PACKAGE_NAME } from './version.js';

/** The two markers, each a token that only the patched SDK file contains. */
export const SDK_PATCH_MARKERS = [
  { file: 'index.js', token: 'DEFAULT_SUMMARIZATION_PROMPT' },
  { file: 'vended-plugins/context-offloader/plugin.js', token: 'excludeTools' },
] as const;

export const SDK_PATCH_PREFLIGHT_EXIT_CODE = 1;

/**
 * The refusal text for the given missing markers (`undefined` when none is missing):
 * what is wrong, why it happened, and the one supported fix. Bounded and fixed —
 * the names are the SDK file paths above.
 */
export function unpatchedSdkNotice(missing: readonly string[]): string | undefined {
  if (missing.length === 0) return undefined;
  return [
    `error: the installed @strands-agents/sdk is not patched (missing: ${missing.join(', ')}).`,
    'darwin needs its pinned SDK patch, which `patch-package` applies from this package\'s `postinstall` script;',
    'that script did not run here — typically an `npm install --ignore-scripts`, or `pnpm add -g`, which is unsupported.',
    `Fix: reinstall through the supported route, \`npm install -g ${DARWIN_PACKAGE_NAME}\` (scripts enabled).`,
    'Developing in a clone: `pnpm install` applies the same patch through pnpm.',
    '',
  ].join('\n');
}

/**
 * Inspect the installed SDK's marker files. `sources` maps a marker file (relative to
 * the SDK's `dist/src/`) to its text, or `undefined` when unreadable; the default reads
 * the files next to the SDK's resolved entry point.
 */
export function missingSdkPatchMarkers(
  sources: (file: string) => string | undefined = readInstalledSdkFile,
): string[] {
  return SDK_PATCH_MARKERS.filter(({ file, token }) => !(sources(file)?.includes(token) ?? false))
    .map(({ file, token }) => `${token} in ${file}`);
}

function readInstalledSdkFile(file: string): string | undefined {
  // `@strands-agents/sdk` resolves to `dist/src/index.node.js`; the marker files are
  // its siblings. Resolution failure (no SDK at all) is a different, louder problem
  // and is left to surface as itself.
  const entry = import.meta.resolve('@strands-agents/sdk');
  try {
    return readFileSync(fileURLToPath(new URL(`./${file}`, entry)), 'utf8');
  } catch {
    return undefined;
  }
}

/** The refusal to print (stderr) and exit nonzero with, or `undefined` when the SDK is patched. */
export function sdkPatchPreflight(): string | undefined {
  return unpatchedSdkNotice(missingSdkPatchMarkers());
}
