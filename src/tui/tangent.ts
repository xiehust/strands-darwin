/**
 * `/tangent` — a bookmark-and-return gesture over the rewind machinery (SER-083).
 *
 * A tangent is a side conversation that inherits everything so far: `/tangent`
 * arms it, the next completed prompt starts it, and `/tangent` again returns to
 * the conversation exactly as it was before that prompt. Nothing here is a second
 * branch mechanism. The return point *is* the rewind checkpoint `AgentRuntime.send`
 * captures before the first prompt sent after arming, and the return *is*
 * `startRewind(returnPoint)` — the same successor runtime, the same omission
 * notice. What this module adds is the bookkeeping the picker-less gesture needs:
 * which catalogued boundary to go back to, how many prompts that discards, and
 * the notices that state each transition.
 *
 * Scope is deliberately one level, unnamed and picker-free — `/rewind` already lists
 * every boundary. The state is live TUI session state like the permission mode:
 * never persisted, never in the trajectory, not offered by headless drivers or the
 * dev REPL, dropped by `/clear`, absent in a resumed session.
 *
 * Every function is pure over the runtime's own `listRewindCheckpoints()` projection
 * (checkpoints newest first). Prompt ordinals are 1-based positions in that
 * catalogue — *prompt N* is the N-th completed prompt this session catalogued a
 * checkpoint for — and the discarded count is the number of catalogued prompts
 * since the tangent was armed, the return prompt included (its answer is discarded
 * too). Prompts that were never catalogued (failed, cancelled, image-carrying,
 * over the rewind editor bound) are not counted, because the return cannot undo
 * more than the catalogue can see.
 */

import type { RewindCatalogue, RewindCheckpoint } from '../agent/rewind.js';

/** `/tangent` is waiting for the next completed prompt to become the return point. */
export interface ArmedTangent {
  readonly phase: 'armed';
  /** Catalogue size when armed; the delta is what a return discards. */
  readonly baseline: number;
}

/** The return point is captured; `/tangent` again rewinds to it. */
export interface ActiveTangent {
  readonly phase: 'active';
  readonly baseline: number;
  /** 1-based catalogue ordinal of the prompt that started the tangent. */
  readonly since: number;
  /** The exact catalogued row `startRewind` is handed — never a fabricated snapshot id. */
  readonly returnPoint: RewindCheckpoint;
}

export type TangentState = ArmedTangent | ActiveTangent;

export type TangentCommand = 'toggle' | 'start' | 'end' | 'usage';

/** Local usage notice for any argument other than `start`/`end`. */
export const TANGENT_COMMAND_USAGE = '/tangent takes no arguments other than start or end';

/** Notice for drivers that expose the runtime without the rewind seam. */
export const TANGENT_TUI_ONLY_NOTICE = '/tangent is a TUI command';

/** Grammar: bare `/tangent` toggles; `start` only arms; `end` returns or disarms. */
export function parseTangentCommand(text: string): TangentCommand | undefined {
  if (!/^\/tangent(?:\s|$)/.test(text)) return undefined;
  const argument = text.slice('/tangent'.length).trim();
  if (argument === '') return 'toggle';
  if (argument === 'start') return 'start';
  if (argument === 'end') return 'end';
  return 'usage';
}

export type ArmOutcome =
  | { readonly kind: 'armed'; readonly state: ArmedTangent; readonly notice: string }
  | { readonly kind: 'refused'; readonly notice: string };

/**
 * Arms from the live catalogue. A catalogue that cannot be read or a session at
 * capture capacity is refused up front — the next prompt could not become a
 * return point, so a "tangent" then would be a promise the return cannot keep.
 */
export function armTangent(catalogue: RewindCatalogue): ArmOutcome {
  if (catalogue.problem !== undefined) {
    return { kind: 'refused', notice: `tangent unavailable: ${catalogue.problem}` };
  }
  if (catalogue.captureCapacityReached === true) {
    return {
      kind: 'refused',
      notice: 'tangent unavailable — rewind checkpoint capacity reached, so no return point could be captured',
    };
  }
  return {
    kind: 'armed',
    state: { phase: 'armed', baseline: catalogue.checkpoints.length },
    notice: 'tangent armed — the next prompt starts it; /tangent again returns to the conversation as it is now',
  };
}

/** What the App knows about the prompt that just ran, for the "why not" notice. */
export interface TangentPromptFacts {
  /** An image travelled with the prompt: a text-only checkpoint cannot reproduce it. */
  readonly image: boolean;
  /** A background-task wake, not the user's prompt: never catalogued. */
  readonly sessionOriginated: boolean;
  /** The turn ran to its natural end (not failed, not cancelled). */
  readonly completed: boolean;
}

export type CaptureOutcome =
  | { readonly kind: 'started'; readonly state: ActiveTangent; readonly notice: string }
  | { readonly kind: 'ended'; readonly notice: string };

/**
 * After the first prompt since arming: the catalogue grew by the checkpoint the
 * runtime captured before it, and its newest row is the return point. No growth
 * means nothing to return to, and the tangent ends at once with the reason.
 */
export function captureReturnPoint(
  state: ArmedTangent,
  catalogue: RewindCatalogue,
  facts: TangentPromptFacts,
): CaptureOutcome {
  if (catalogue.problem !== undefined) return ended(catalogue.problem);
  const newest = catalogue.checkpoints[0];
  if (catalogue.checkpoints.length > state.baseline && newest !== undefined) {
    const since = catalogue.checkpoints.length;
    return {
      kind: 'started',
      state: { phase: 'active', baseline: state.baseline, since, returnPoint: newest },
      notice: `tangent started — since prompt ${since}; /tangent again returns there`,
    };
  }
  if (facts.image) return ended('an image was attached');
  if (facts.sessionOriginated) return ended('the prompt was a background-task wake');
  if (!facts.completed) return ended('the turn failed or was cancelled');
  if (catalogue.captureCapacityReached === true) return ended('rewind checkpoint capacity reached');
  return ended('no checkpoint was catalogued for the prompt');
}

function ended(reason: string): CaptureOutcome {
  return { kind: 'ended', notice: `tangent not started — no return point could be captured (${reason})` };
}

export type TangentCommandOutcome =
  | { readonly action: 'arm' }
  | { readonly action: 'return'; readonly state: ActiveTangent }
  | { readonly action: 'disarm'; readonly notice: string }
  | { readonly action: 'notice'; readonly notice: string };

/** The one transition table for `/tangent`, `/tangent start` and `/tangent end`. */
export function tangentCommandOutcome(
  state: TangentState | undefined,
  command: Exclude<TangentCommand, 'usage'>,
): TangentCommandOutcome {
  if (state === undefined) {
    return command === 'end'
      ? { action: 'notice', notice: 'not in a tangent — /tangent starts one' }
      : { action: 'arm' };
  }
  if (state.phase === 'armed') {
    return command === 'end'
      ? { action: 'disarm', notice: 'tangent disarmed — no prompt had started it' }
      : { action: 'notice', notice: 'tangent armed — send a prompt to start it, or /tangent end to cancel' };
  }
  // Active: one level only. `start` cannot nest; bare `/tangent` and `end` both return.
  if (command === 'start') {
    return { action: 'notice', notice: `already in a tangent — /tangent again returns to prompt ${state.since}` };
  }
  return { action: 'return', state };
}

/**
 * Catalogued prompts since arming, the return prompt included. Read from the live
 * catalogue at return time; a catalogue that cannot be read falls back to what the
 * state alone proves (the return prompt itself).
 */
export function discardedPromptCount(state: ActiveTangent, catalogue: RewindCatalogue | undefined): number {
  if (catalogue === undefined || catalogue.problem !== undefined) {
    return Math.max(1, state.since - state.baseline);
  }
  return Math.max(1, catalogue.checkpoints.length - state.baseline);
}

/** The one extra line after the rewind path's own omission notice. */
export function tangentReturnNotice(discarded: number): string {
  return `returned from tangent — ${discarded} prompt${discarded === 1 ? '' : 's'} discarded`;
}

/** `/clear` and `/rewind` leave the tangent behind with the conversation it bookmarked. */
export function tangentEndedByNotice(command: '/clear' | '/rewind'): string {
  return `tangent ended by ${command}`;
}

/**
 * What the editor receives after a successful branch. `/rewind` hands the selected
 * prompt back unsent; a tangent return hands back nothing — the user asked to return,
 * not to resend.
 */
export function rewindDraftAfterBranch(kind: 'rewind' | 'tangent', selectedPrompt: string): string {
  return kind === 'tangent' ? '' : selectedPrompt;
}

/** The `/status` `tangent` row value; absent (no row) when not in a tangent. */
export function tangentStatusFact(state: TangentState | undefined): string | undefined {
  if (state === undefined) return undefined;
  return state.phase === 'armed' ? 'armed — the next prompt starts it' : `since prompt ${state.since}`;
}

/** Appended to the header's existing state word; no row of its own. */
export function tangentHeaderSuffix(state: TangentState | undefined): string {
  if (state === undefined) return '';
  return state.phase === 'armed' ? ' · tangent armed' : ` · tangent since prompt ${state.since}`;
}
