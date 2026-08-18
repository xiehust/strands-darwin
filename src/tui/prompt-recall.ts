/**
 * Prompt recall: which key steps where, and what the editor says while it does.
 *
 * Everything here is pure and synchronous — a walk over a list of strings the
 * trajectory reader already produced (`src/trajectory/prompt-history.ts`). The split
 * is the same one `path-completion.ts` uses: the I/O is async, bounded and cached by
 * the caller, and the part a keystroke actually runs is this.
 *
 * The binding is the risky part of this feature, so it is stated once, here, and
 * enforced by the caller in exactly this order:
 *
 * 1. A **completion menu wins**. `App.tsx` handles `Up`/`Down` as menu selection
 *    whenever `completions.length > 0`, before recall is consulted at all — so recall
 *    is unreachable with a `/` or `@` menu open, by construction rather than by a
 *    predicate that could drift.
 * 2. **`Up` recalls only when the draft is empty**, or when a walk is already active
 *    and the cursor sits on the first visual row. A non-empty draft that is not a walk
 *    falls through to `moveVertical` exactly as before, which is what makes recall
 *    incapable of replacing typed text — no stash, and nothing to lose.
 * 3. **`Down` applies only inside a walk**, and only from the last visual row. Past the
 *    newest entry it empties the draft and ends the walk, which is where the walk
 *    started; outside a walk `Down` is untouched.
 * 4. Cursor movement does not end a walk — `Up` through a recalled multi-row prompt
 *    reaches its top row and only then steps further back — but every **edit** does.
 */
import { promptHistoryNote, type PromptHistory } from '../trajectory/prompt-history.js';

/** A recall walk in progress. Absent from `App` state means "not recalling". */
export interface PromptRecall {
  /**
   * The entries this walk started from.
   *
   * Snapshotted deliberately: a re-read landing mid-walk must not renumber what `Up`
   * is stepping through under the user's hands.
   */
  readonly entries: readonly string[];
  /** Index into {@link entries}; `-1` only while nothing can be applied (see {@link pending}). */
  readonly index: number;
  /** True while the history read this walk asked for has not landed yet. */
  readonly pending: boolean;
  /** What the reading is not showing, stated on the indicator row. */
  readonly note: string | undefined;
}

export type RecallDirection = 'older' | 'newer';

/** The result of opening or stepping a walk. */
export interface RecallStep {
  /** The walk afterwards; `undefined` ends it. */
  readonly recall: PromptRecall | undefined;
  /** Draft text to apply, or `undefined` to leave the draft exactly as it is. */
  readonly text: string | undefined;
}

/**
 * Opens a walk on the newest entry.
 *
 * `history` is `undefined` while the read has not landed. That case opens a *pending*
 * walk rather than claiming there is no history: saying "no earlier prompts" about a
 * file that has not been read yet would be a lie in the one row the user is looking at.
 */
export function openPromptRecall(history: PromptHistory | undefined): RecallStep {
  if (history === undefined) {
    return { recall: { entries: [], index: -1, pending: true, note: undefined }, text: undefined };
  }
  const note = promptHistoryNote(history);
  const empty: PromptRecall = { entries: history.entries, index: -1, pending: false, note };
  return history.entries.length === 0 ? { recall: empty, text: undefined } : step(empty, 'older');
}

/**
 * Steps a walk one entry older or newer.
 *
 * Never wraps. At the oldest entry `Up` holds still — the indicator already says
 * `(oldest)`, and wrapping to the newest is how a walk loses the user's place.
 */
export function stepPromptRecall(recall: PromptRecall, direction: RecallDirection): RecallStep {
  return step(recall, direction);
}

function step(recall: PromptRecall, direction: RecallDirection): RecallStep {
  // Nothing to step through: a pending read, or a project with no prompts. `Up` holds
  // the indicator (the user may press it again once the read lands); `Down` dismisses it.
  if (recall.entries.length === 0) {
    return direction === 'older' ? { recall, text: undefined } : { recall: undefined, text: undefined };
  }

  if (direction === 'older') {
    const next = Math.min(recall.index + 1, recall.entries.length - 1);
    if (next === recall.index) return { recall, text: undefined };
    return { recall: { ...recall, index: next }, text: recall.entries[next] as string };
  }

  // Newer than the newest is where the walk began: an empty draft, and no walk. The
  // eligibility rule means that is exactly the draft `Up` replaced.
  if (recall.index <= 0) return { recall: undefined, text: '' };
  const next = recall.index - 1;
  return { recall: { ...recall, index: next }, text: recall.entries[next] as string };
}

/**
 * The single row a walk draws under the draft.
 *
 * One string, one row, counted by {@link RECALL_INDICATOR_ROWS} and rendered as one
 * `<Text wrap="truncate-end">` — the live-frame rule for any row whose height has to
 * be known. A bounded or degraded reading is a *suffix* of this row, never a row of
 * its own, exactly like the completion menu's scan note.
 */
export function promptRecallIndicator(recall: PromptRecall): string {
  if (recall.pending) return 'history: reading this project\u2019s record…';
  if (recall.entries.length === 0) {
    const note = recall.note === undefined ? '' : ` — ${recall.note}`;
    return `history: no earlier prompts in this project${note}`;
  }
  const position = `history ${Math.max(recall.index, 0) + 1}/${recall.entries.length}`;
  const oldest = recall.index === recall.entries.length - 1 ? ' (oldest)' : '';
  const note = recall.note === undefined ? '' : ` — ${recall.note}`;
  return `${position}${oldest} · ↑ older ↓ newer${note}`;
}
