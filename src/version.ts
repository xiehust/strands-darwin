/** Darwin's own package identity, for records that have to say what wrote them. */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The published package name (`npm install -g strands-darwin`). The executable
 * stays `darwin`; only the registry name carries the prefix, because bare `darwin`
 * is taken on npm. The walk-up below keys on it, so a rename must change it here.
 */
export const DARWIN_PACKAGE_NAME = 'strands-darwin';

/**
 * The version from darwin's `package.json`, or `'unknown'`.
 *
 * Resolved by walking up from this module rather than hard-coded, because a
 * constant here would silently drift from the released version at the first
 * `pnpm version` — and a wrong version stamped into an append-only record is worse
 * than an absent one. Walking up also survives both layouts: `src/version.ts` in
 * development and `dist/src/version.js` after a build.
 */
function readVersion(): string {
  let directory = import.meta.dirname;
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === DARWIN_PACKAGE_NAME && typeof parsed.version === 'string') return parsed.version;
    } catch {
      // Not this directory: keep walking. A missing package.json is expected here.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return 'unknown';
}

export const DARWIN_VERSION = readVersion();
