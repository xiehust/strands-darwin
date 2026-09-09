/** SER-085 pure state checks: exact identity, occupancy, cap and conflicting owners.
 * Run: pnpm tsx spike/verify-draft-stash.ts (offline; no runtime or file access).
 */
import { strict as check } from 'node:assert';
import { ImageBlock } from '@strands-agents/sdk';
import { DRAFT_STASH_CAP, stashHint, toggleDraftStash, type DraftStash } from '../src/tui/draft-stash.js';
import { formatHelpReport } from '../src/tui/help-format.js';
import { assert, header, report } from './shared.js';

header('SER-085 — one exact composer stash');
const empty: DraftStash = { editor: { text: '', cursor: { offset: 0, affinity: 'downstream' } }, image: undefined };
const image = new ImageBlock({ format: 'png', source: { bytes: new Uint8Array([1, 2, 3]) } });

for (const affinity of ['upstream', 'downstream'] as const) {
  const original: DraftStash = Object.freeze({
    editor: Object.freeze({ text: ' \t中e\u0301👩‍👩‍👧‍👦\n tail ', cursor: Object.freeze({ offset: 3, affinity }) }), image,
  });
  const stored = toggleDraftStash(original, undefined, false);
  check.equal(stored.action, 'stored');
  if (stored.action !== 'stored') throw new Error('store');
  check.equal(stored.slot, original);
  check.deepEqual(stored.composer, empty);
  const restored = toggleDraftStash(empty, stored.slot, false);
  if (restored.action !== 'restored') throw new Error('restore');
  check.equal(restored.composer.editor, original.editor);
  check.equal(restored.composer.image, image);
  check.equal(restored.slot, undefined);
  assert(`S1 exact Unicode/whitespace/cursor ${affinity} and image object identity round-trip`, true);
}
check.equal(toggleDraftStash(empty, undefined, false).action, 'inert');
assert('S1 both empty inert', true);
const imageOnly = { ...empty, image };
check.equal(toggleDraftStash(imageOnly, undefined, false).action, 'stored');
check.equal(toggleDraftStash(imageOnly, imageOnly, false).action, 'refused');
check.equal(toggleDraftStash(empty, imageOnly, true).action, 'refused');
check.equal(toggleDraftStash(imageOnly, undefined, true).action, 'refused');
assert('S1/S4 image-only occupies the slot; duplicate or external-owner conflict refuses unchanged', true);
const cap = { ...empty, editor: { ...empty.editor, text: '😀'.repeat(DRAFT_STASH_CAP) } };
const over = { ...empty, editor: { ...empty.editor, text: cap.editor.text + 'x' } };
check.equal(toggleDraftStash(cap, undefined, false).action, 'stored');
check.equal(toggleDraftStash(over, undefined, false).action, 'refused');
check.equal([...over.editor.text].length, DRAFT_STASH_CAP + 1);
check.equal(toggleDraftStash(cap, cap, false).action, 'refused');
check.equal(toggleDraftStash(cap, undefined, true).action, 'stored');
check.equal(toggleDraftStash(empty, cap, true).action, 'restored');
assert('S1 cap counts code points, never truncates; occupied refuses; text-only independent of other images', true);
check.match(formatHelpReport(), /Ctrl\+S.*never overwrites or sends/);
assert('S7 bounded help discovers stash semantics', true);

for (const width of [0, 8, 16, 20, 40, 80]) {
  const hint = stashHint('working… · 2 queued ' + 'x'.repeat(80), true, width);
  check.ok([...hint].length <= width);
  if (width >= 16) check.ok(hint.endsWith(' · stash: Ctrl+S'));
}
check.equal(stashHint('unchanged', false, 1), 'unchanged');
assert('S7 suffix width bounded even in tiny terminals, absence byte-identical', true);
report();
