/** One explicit live composer slot. No persistence, queue or runtime access. */
import type { ImageBlock } from '@strands-agents/sdk';
import { cellWidth, type EditorValue } from './prompt-editor.js';

export const DRAFT_STASH_CAP = 65_536;
export interface DraftStash {
  readonly editor: EditorValue;
  readonly image: ImageBlock | undefined;
}
export type StashTransition =
  | { readonly action: 'inert' }
  | { readonly action: 'refused'; readonly notice: string }
  | { readonly action: 'stored' | 'restored'; readonly composer: DraftStash; readonly slot: DraftStash | undefined };

/** External ownership is queue/in-flight, never history's already-sent images. */
export function toggleDraftStash(
  composer: DraftStash,
  slot: DraftStash | undefined,
  otherImage: boolean,
): StashTransition {
  const occupied = composer.editor.text !== '' || composer.image !== undefined;
  if (occupied && slot !== undefined) {
    return { action: 'refused', notice: 'draft stash occupied — clear the composer before restoring; neither draft changed' };
  }
  if (!occupied && slot === undefined) return { action: 'inert' };
  const moving = occupied ? composer : slot!;
  if (moving.image !== undefined && otherImage) {
    return { action: 'refused', notice: 'draft stash refused — another image is queued or sending; nothing changed' };
  }
  if (occupied) {
    let points = 0;
    for (const _point of composer.editor.text) {
      if (++points > DRAFT_STASH_CAP) {
        return { action: 'refused', notice: 'draft stash refused — exceeds 65,536 code points; draft unchanged' };
      }
    }
    return {
      action: 'stored', slot: composer,
      composer: { editor: { text: '', cursor: { offset: 0, affinity: 'downstream' } }, image: undefined },
    };
  }
  return { action: 'restored', composer: moving, slot: undefined };
}

/** Fixed content-free suffix, carried on the existing counted hint row. */
export const DRAFT_STASH_HINT = ' · stash: Ctrl+S';
export const DRAFT_STASH_DROP_NOTICE = 'draft stash dropped — session ended or replaced';

/** Reserve the suffix inside one existing hint row; input is fixed UI text only. */
export function stashHint(hint: string, occupied: boolean, columns: number): string {
  if (!occupied) return hint;
  const width = Math.max(0, columns);
  const suffix = width < DRAFT_STASH_HINT.length ? 'stash: Ctrl+S'.slice(0, width) : DRAFT_STASH_HINT;
  const available = width - suffix.length;
  let head = '';
  let cells = 0;
  for (const point of hint) {
    cells += cellWidth(point);
    if (cells > available) break;
    head += point;
  }
  return head + suffix;
}
