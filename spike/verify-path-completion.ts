/**
 * `@` path completion: what opens a menu, what it offers, what accepting one writes
 * into the draft, and what the scan refuses to look at.
 *
 * No terminal and no model. Two halves, matching the module: the pure editor half is
 * asserted on strings, and the scan half runs against a real temp tree plus *this*
 * repository — which is the only honest place to measure the two numbers that decide
 * whether typing stalls, because it is the tree that has a `node_modules`.
 *
 * The load-bearing property has no single assertion: completion never reads file
 * content. It is defended three ways here — the module imports no file-reading API,
 * a candidate's bytes never appear in any result, and `applyPathCompletion` is a
 * function from strings to strings — and end to end by `verify-tui.ts pathCompletion`.
 */
import { strict as nodeAssert } from 'node:assert';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  EXCLUDED_DIRECTORY_NAMES,
  MAX_PATH_QUERY_LENGTH,
  MAX_SCAN_DEPTH,
  MAX_SCAN_ENTRIES,
  applyPathCompletion,
  matchWorkspacePaths,
  pathCompletionQuery,
  scanWorkspacePaths,
  workspacePathsNote,
} from '../src/tui/path-completion.js';
import { assert, header, report } from './shared.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = '/tmp/darwin-path-completion';
const OUTSIDE = '/tmp/darwin-path-completion-outside';

/** The cursor at the end of a draft, which is where typing leaves it. */
function atEnd(text: string): { text: string; cursor: { offset: number; affinity: 'upstream' } } {
  return { text, cursor: { offset: text.length, affinity: 'upstream' } };
}

header('path completion — where a trigger is recognized');

assert('a bare @ at the start of the draft opens a query',
  pathCompletionQuery('@', 1)?.text === '');
assert('typing after it narrows the same query',
  pathCompletionQuery('@src/tu', 7)?.text === 'src/tu');
assert('an @ after whitespace opens one mid-draft',
  pathCompletionQuery('look at @src', 12)?.text === 'src');
assert('a newline counts as whitespace, so a multi-line draft triggers per line',
  pathCompletionQuery('first line\n@src', 15)?.text === 'src');
assert('the query starts at the @ itself, not at the text after it',
  pathCompletionQuery('look at @src', 12)?.start === 8);
assert('a tab counts too',
  pathCompletionQuery('look\tat\t@no', 11)?.text === 'no');

header('path completion — and where it is not');

assert('an email address never triggers: the @ is inside a word',
  pathCompletionQuery('mail me@example.com', 19) === undefined);
assert('nor does an @ typed mid-word',
  pathCompletionQuery('foo@bar', 7) === undefined);
assert('a space after the query closes it',
  pathCompletionQuery('@src ', 5) === undefined);
assert('so does a newline after it',
  pathCompletionQuery('@src\n', 5) === undefined);
assert('a draft with no @ at all opens nothing',
  pathCompletionQuery('src/tui/App.tsx', 15) === undefined);
assert('the cursor decides: an @ later in the draft is not under it',
  pathCompletionQuery('hello @src', 5) === undefined);
assert('a query longer than the cap is prose, not a path prefix',
  pathCompletionQuery(`@${'x'.repeat(MAX_PATH_QUERY_LENGTH + 1)}`, MAX_PATH_QUERY_LENGTH + 2) === undefined);
assert('the closest @ wins, so a second one re-anchors the query',
  pathCompletionQuery('@a@b', 4) === undefined);

header('path completion — which candidates are offered');

const candidates = [
  'AGENTS.md',
  'src/',
  'package.json',
  'src/cli.ts',
  'src/tui/',
  'src/tui/App.tsx',
  'src/tui/InputBox.tsx',
  'docs/research/backlog_index.md',
];

assert('an empty query offers everything, in scan order',
  matchWorkspacePaths(candidates, '').join('|') === candidates.join('|'));
assert('a path prefix narrows to that subtree',
  matchWorkspacePaths(candidates, 'src/t').join('|') === 'src/tui/|src/tui/App.tsx|src/tui/InputBox.tsx');
assert('matching is case-insensitive',
  matchWorkspacePaths(candidates, 'AgEnTs')[0] === 'AGENTS.md');
assert('a bare name matches the last segment, so a deep file is reachable without its directories',
  matchWorkspacePaths(candidates, 'InputBox')[0] === 'src/tui/InputBox.tsx');
assert('path matches come before basename matches',
  matchWorkspacePaths(candidates, 'src').join('|').startsWith('src/|src/cli.ts'));
assert('a query naming a directory of its own never falls back to basenames',
  matchWorkspacePaths(candidates, 'tui/App').length === 0);
assert('a leading ./ is the same query',
  matchWorkspacePaths(candidates, './src/cli').join('|') === 'src/cli.ts');
assert('a query nothing matches offers nothing at all — this is what keeps @someone in prose silent',
  matchWorkspacePaths(candidates, 'someone').length === 0);
// The menu's own cap is asserted where it is applied (`verify-frame-budget.ts` and
// `verify-tui.ts pathCompletion`); here the matcher must hand over the *whole* list, or
// the "… n more" row would be counting from an already-truncated total.
assert('every match is returned, so the caller can say how many rows it is not showing',
  matchWorkspacePaths(candidates, '').length === candidates.length);

header('path completion — what accepting one does to the draft');

nodeAssert.deepEqual(
  applyPathCompletion(atEnd('@src/cli'), pathCompletionQuery('@src/cli', 8)!, 'src/cli.ts'),
  { text: 'src/cli.ts ', cursor: { offset: 11, affinity: 'upstream' } },
);
assert('accepting a file leaves the plain path and a space — the marker was scaffolding', true);

nodeAssert.deepEqual(
  applyPathCompletion(atEnd('@src'), pathCompletionQuery('@src', 4)!, 'src/tui/'),
  { text: '@src/tui/', cursor: { offset: 9, affinity: 'upstream' } },
);
assert('accepting a directory keeps the marker, so the next keystroke completes inside it', true);

assert('and that draft is still a query, one level down',
  pathCompletionQuery('@src/tui/', 9)?.text === 'src/tui/');

{
  const draft = { text: 'compare @src with notes.md', cursor: { offset: 12, affinity: 'upstream' as const } };
  const applied = applyPathCompletion(draft, pathCompletionQuery(draft.text, 12)!, 'src/cli.ts');
  assert('a mid-draft acceptance replaces only the token',
    applied.text === 'compare src/cli.ts  with notes.md');
  assert('and leaves the cursor after the inserted path',
    applied.cursor.offset === 'compare src/cli.ts '.length);
}

header('path completion — the bounded scan');

await rm(FIXTURE, { recursive: true, force: true });
await rm(OUTSIDE, { recursive: true, force: true });
await mkdir(path.join(FIXTURE, 'src', 'tui'), { recursive: true });
await mkdir(path.join(FIXTURE, 'node_modules', 'ink', 'build'), { recursive: true });
await mkdir(path.join(FIXTURE, 'dist'), { recursive: true });
await mkdir(path.join(FIXTURE, '.git', 'objects'), { recursive: true });
await mkdir(path.join(FIXTURE, '.darwin', 'skills', 'commit-message'), { recursive: true });
await mkdir(OUTSIDE, { recursive: true });
await writeFile(path.join(FIXTURE, 'notes.md'), 'notes\n', 'utf8');
await writeFile(path.join(FIXTURE, 'src', 'cli.ts'), 'export {};\n', 'utf8');
await writeFile(path.join(FIXTURE, 'src', 'tui', 'App.tsx'), 'UNIQUE_FIXTURE_CONTENT\n', 'utf8');
await writeFile(path.join(FIXTURE, 'node_modules', 'ink', 'build', 'ink.js'), '// ink\n', 'utf8');
await writeFile(path.join(FIXTURE, 'dist', 'bundle.js'), '// built\n', 'utf8');
await writeFile(path.join(FIXTURE, '.git', 'objects', 'deadbeef'), 'object\n', 'utf8');
await writeFile(path.join(FIXTURE, '.darwin', 'skills', 'commit-message', 'SKILL.md'), '# skill\n', 'utf8');
await writeFile(path.join(OUTSIDE, 'secret.txt'), 'OUTSIDE_SECRET\n', 'utf8');
await symlink(OUTSIDE, path.join(FIXTURE, 'escape'), 'dir');
await symlink(path.join(FIXTURE, 'notes.md'), path.join(FIXTURE, 'inside-link'), 'file');

const fixture = await scanWorkspacePaths(FIXTURE);
const offered = fixture.paths.join('|');

assert('the scan completes without a bound', !fixture.truncated && fixture.problem === undefined);
assert('files and directories are both offered, directories with a trailing slash',
  fixture.paths.includes('notes.md') && fixture.paths.includes('src/'));
assert('nested paths are project-relative and slash-separated',
  fixture.paths.includes('src/tui/App.tsx'));
assert('root entries come before deep ones — the scan is breadth-first',
  fixture.paths.indexOf('src/') < fixture.paths.indexOf('src/tui/App.tsx'));
assert('node_modules is neither walked nor offered', !offered.includes('node_modules'));
assert('dist is neither walked nor offered', !offered.includes('dist'));
assert('.git is neither walked nor offered', !offered.includes('.git'));
assert('a dot-directory that is not on the excluded list is still offered',
  fixture.paths.includes('.darwin/') && fixture.paths.includes('.darwin/skills/commit-message/SKILL.md'));
assert('a symlink out of the project produces no candidate at all',
  !offered.includes('escape') && !offered.includes('secret'));
assert('a symlink that stays inside is offered, and never as a directory to walk into',
  fixture.paths.includes('inside-link'));
assert('the scan names no path outside the project root',
  fixture.paths.every((candidate) => !candidate.startsWith('/') && !candidate.includes('..')));
assert('no file content reaches the candidate list',
  !offered.includes('UNIQUE_FIXTURE_CONTENT') && !offered.includes('OUTSIDE_SECRET'));

{
  // Depth: a chain longer than the bound is offered down to it and no further, and
  // the reading says the tree did not run out.
  const deep = path.join(FIXTURE, 'deep');
  const chain = Array.from({ length: MAX_SCAN_DEPTH + 3 }, (_, index) => `d${index}`);
  await mkdir(path.join(deep, ...chain), { recursive: true });
  const reading = await scanWorkspacePaths(deep);
  const deepest = Math.max(...reading.paths.map((candidate) => candidate.split('/').filter(Boolean).length));
  assert(`the scan stops at ${MAX_SCAN_DEPTH} levels`, deepest === MAX_SCAN_DEPTH);
  assert('and says it was bounded', reading.truncated);
  assert('which the menu states on its title row',
    workspacePathsNote(reading) === `bounded scan: ${reading.paths.length} paths`);
  await rm(deep, { recursive: true, force: true });
}

{
  // A directory that does not exist is a degraded reading, not a thrown error: a
  // completion menu with fewer rows must never be able to stop somebody typing.
  const reading = await scanWorkspacePaths(path.join(FIXTURE, 'does-not-exist'));
  assert('an unreadable root degrades instead of throwing',
    reading.paths.length === 0 && reading.problem !== undefined);
  assert('and the menu would state that too', workspacePathsNote(reading)?.startsWith('partial scan:') === true);
}

assert('a complete reading states nothing', workspacePathsNote(fixture) === undefined);
assert('the excluded list covers the four a repository scan must never walk',
  ['.git', 'node_modules', 'dist', 'build'].every((name) => EXCLUDED_DIRECTORY_NAMES.has(name)));

header('path completion — no file is ever read');

{
  const source = await readFile(path.join(REPO_ROOT, 'src', 'tui', 'path-completion.ts'), 'utf8');
  const readers = ['readFile', 'createReadStream', 'readFileSync', 'open('];
  assert('the module imports no file-reading API',
    readers.every((reader) => !source.includes(reader)));
  assert('and reads directory entries only',
    source.includes("from 'node:fs/promises'") && /opendir/.test(source));
}

header('path completion — responsiveness, measured in this repository');

{
  // This repo is the honest tree: it has node_modules (≈30k entries) and dist.
  const started = performance.now();
  const reading = await scanWorkspacePaths(REPO_ROOT);
  const scanMs = performance.now() - started;
  console.log(`  scan: ${reading.paths.length} candidates from ${reading.entriesSeen} entries in ${scanMs.toFixed(0)}ms (truncated: ${reading.truncated})`);

  assert('the repository scan finds its own source files',
    reading.paths.includes('src/tui/App.tsx') && reading.paths.includes('AGENTS.md'));
  assert('without walking node_modules or dist',
    reading.paths.every((candidate) => !candidate.startsWith('node_modules') && !candidate.startsWith('dist')));
  assert(`the scan inspects fewer than ${MAX_SCAN_ENTRIES} entries here`,
    reading.entriesSeen < MAX_SCAN_ENTRIES);
  // Generous on purpose: the number that matters is that this is *not* on the
  // keystroke path at all. It runs once per 5s TTL, off the editor's critical path.
  assert('one scan of this repository stays well under a second', scanMs < 1000);

  // What a keystroke actually costs: matching, which is all the editor does
  // synchronously. Typed one character at a time, exactly like a person.
  const query = 'src/tui/InputBox.tsx';
  let worst = 0;
  let matches = 0;
  for (let length = 0; length <= query.length; length += 1) {
    const at = performance.now();
    matches = matchWorkspacePaths(reading.paths, query.slice(0, length)).length;
    worst = Math.max(worst, performance.now() - at);
  }
  console.log(`  per-keystroke match over ${reading.paths.length} candidates: worst ${worst.toFixed(2)}ms, final matches ${matches}`);
  assert('a keystroke costs under 5ms of matching over the whole candidate list', worst < 5);
  assert('and the last keystroke has narrowed to the file itself', matches === 1);
}

{
  // The tree that would stall an editor, built rather than borrowed: this repository's
  // own `node_modules` is 31k entries, but only 448 of them are *reachable* by this
  // scan (pnpm's top level is symlinks, which are never traversed, and every nested
  // `node_modules` is on the excluded list) — so it proves the exclusions, not the
  // bounds. A single wide directory past `MAX_SCAN_ENTRIES` proves the bounds, and the
  // interval timer proves the thing that actually matters for an Ink app: the scan
  // never holds the event loop that keystrokes and renders both arrive on.
  const wide = path.join(FIXTURE, 'wide');
  await mkdir(wide, { recursive: true });
  await Promise.all(
    Array.from({ length: MAX_SCAN_ENTRIES + 500 }, (_, index) =>
      writeFile(path.join(wide, `file-${index}.txt`), '', 'utf8'),
    ),
  );

  const lags: number[] = [];
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    lags.push(now - last - 5);
    last = now;
  }, 5);
  const started = performance.now();
  const reading = await scanWorkspacePaths(wide);
  const scanMs = performance.now() - started;
  clearInterval(ticker);
  const worstLag = Math.max(0, ...lags);
  console.log(`  ${MAX_SCAN_ENTRIES + 500}-entry tree: ${reading.paths.length} candidates from ${reading.entriesSeen} entries in ${scanMs.toFixed(0)}ms; worst event-loop lag ${worstLag.toFixed(1)}ms over ${lags.length} ticks`);

  assert('a tree bigger than the bounds stops at them', reading.truncated);
  assert(`and inspects no more than ${MAX_SCAN_ENTRIES} entries`, reading.entriesSeen <= MAX_SCAN_ENTRIES);
  assert('the menu states that it is showing a bounded scan',
    workspacePathsNote(reading)?.startsWith('bounded scan:') === true);
  assert('the scan never blocks the loop a keystroke arrives on', worstLag < 100);
  await rm(wide, { recursive: true, force: true });
}

await rm(FIXTURE, { recursive: true, force: true });
await rm(OUTSIDE, { recursive: true, force: true });

report();
