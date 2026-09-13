/** `/rewind` chooser state and real Ink row bounds; no disk, model or network. */
import {
  acceptRewindSearch,
  appendRewindSearchQuery,
  backspaceRewindSearchQuery,
  cancelRewindSearch,
  clearRewindSearchQuery,
  moveRewindSearchSelection,
  openRewindSearch,
  rewindSearchView,
} from '../src/tui/rewind-search.js';
import type { RewindCheckpoint } from '../src/agent/rewind.js';
import type { EditorValue } from '../src/tui/prompt-editor.js';
import { assert, header, report } from './shared.js';
import { checkSearchRender, SEARCH_PREVIEW_CASES } from './search-preview-checks.js';

const draft: EditorValue = { text: 'keep this draft', cursor: { offset: 4, affinity: 'downstream' } };
const checkpoints: RewindCheckpoint[] = [
  { snapshotId: 'newest', prompt: 'fix login tests', completedAt: '2026-08-26T12:00:02.000Z' },
  { snapshotId: 'older', prompt: 'document login flow', completedAt: '2026-08-26T12:00:01.000Z' },
];

header('/rewind chooser — filter, navigate, accept and cancel');
let search = openRewindSearch(draft, 'source-session', checkpoints);
assert('opens in runtime-provided newest-first order', acceptRewindSearch(search)?.snapshotId === 'newest');
search = appendRewindSearchQuery(search, 'doc');
assert('filters prompt text without losing SDK identity', acceptRewindSearch(search)?.snapshotId === 'older');
search = clearRewindSearchQuery(search);
search = moveRewindSearchSelection(search, 1);
assert('down selects the older completed boundary', acceptRewindSearch(search)?.snapshotId === 'older');
search = moveRewindSearchSelection(search, 1);
assert('navigation wraps inside the bounded list', acceptRewindSearch(search)?.snapshotId === 'newest');
search = appendRewindSearchQuery(search, 'x');
search = backspaceRewindSearchQuery(search);
assert('query editing restores the complete match list', search.matches.length === 2);
const restored = cancelRewindSearch(search);
assert('Escape restores the exact opening editor value',
  restored.text === draft.text && restored.cursor.offset === draft.cursor.offset && restored.cursor.affinity === draft.cursor.affinity);
assert('the view states branch and cancel keys',
  rewindSearchView(search).title.includes('enter branch') && rewindSearchView(search).title.includes('esc cancel'));

header('/rewind chooser — shared single-row projection, raw checkpoint intact (SER-088)');
for (const { name, raw, preview } of SEARCH_PREVIEW_CASES) {
  const original: EditorValue = { text: `draft\r\n${raw}`, cursor: { offset: 3, affinity: 'upstream' } };
  const checkpoint: RewindCheckpoint = { snapshotId: name, prompt: raw, completedAt: '2026-09-13T00:00:00.000Z' };
  const filtered = appendRewindSearchQuery(openRewindSearch(original, 'source-session', [checkpoint]), raw.toLocaleLowerCase());
  const snapshot = JSON.stringify(filtered);
  const view = rewindSearchView(filtered);
  assert(`${name}: checkpoint candidate uses the safe preview`, view.matches[0] === preview);
  checkSearchRender(`rewind ${name}`, view, true);
  assert(`${name}: rendering preserves raw filtering, checkpoint identity and exact Escape snapshot`,
    filtered.query === raw.toLocaleLowerCase() && JSON.stringify(filtered) === snapshot &&
    acceptRewindSearch(filtered) === checkpoint && JSON.stringify(cancelRewindSearch(filtered)) === JSON.stringify(original));
  checkSearchRender(`rewind ${name} no match`, rewindSearchView(appendRewindSearchQuery(filtered, 'absent')), true);
}
const many = Array.from({ length: 9 }, (_, i) => ({ ...checkpoints[0]!, snapshotId: `point-${i}`, prompt: `entry ${i}\r\n🧬 second` }));
const windowView = rewindSearchView(moveRewindSearchSelection(openRewindSearch(draft, 'source-session', many), 5));
assert('rewind five-row cap, trailing selection and omissions stay unchanged',
  windowView.matches.length === 5 && windowView.selected === 4 && windowView.hiddenAbove === 1 && windowView.hiddenBelow === 3);
checkSearchRender('rewind capped window', windowView, true);

report();
