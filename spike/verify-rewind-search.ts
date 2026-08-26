/** Pure `/rewind` chooser behavior; no disk, terminal, model or network. */
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

report();
