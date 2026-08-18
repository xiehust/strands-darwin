/**
 * Maps SDK stream events onto what the TUI draws.
 *
 * Kept as a pure reducer, separate from the components, so the event mapping can
 * be tested without a terminal — the part most likely to break when the SDK's
 * event shapes change.
 *
 * Event mapping follows the catalog measured in
 * `research/spike-results.md` §4.
 */
import type { AgentStreamEvent } from '@strands-agents/sdk';

import { classify } from '../agent/permission.js';
import {
  backgroundBashMode,
  compactBackgroundCallSummary,
  compactBackgroundResult,
  type BackgroundBashMode,
} from './background-tool-presentation.js';
import { subagentCallSummary } from './subagent-format.js';
import { expandedToolInput, toolResultPreview } from './tool-detail-presentation.js';

export type HistoryItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; part: AnswerPart }
  | {
      kind: 'tool';
      id: string;
      name: string;
      summary: string;
      status: ToolStatus;
      preview: string;
      /** Already bounded before entering immutable transcript history. */
      inputPreview: string;
      expanded: boolean;
    }
  | { kind: 'notice'; id: string; text: string; severity: NoticeSeverity };

/**
 * Where one assistant entry sits in its answer.
 *
 * An answer reaches history in pieces now — finished lines are committed to
 * `<Static>` while the rest is still arriving — so the label and the blank row
 * below cannot both belong to every entry, or a 120-line answer becomes 120
 * labelled blocks. `<Static>` never redraws what it wrote, so which piece carries
 * which cannot be decided later: it is decided as each piece is pushed, which is
 * why the last complete line is always held back (see `commitFinishedLines`).
 *
 * - `whole` — the entire answer in one entry: label above, blank row below.
 * - `first` — label, no blank row; more is coming.
 * - `middle` — neither.
 * - `last` — no label, blank row below.
 */
export type AnswerPart = 'whole' | 'first' | 'middle' | 'last';

export type ToolStatus = 'ok' | 'error' | 'denied';

/**
 * How a notice renders, not what it says: `error` for something that failed
 * outright, `warn` for a degradation the session survives, `info` for the rest.
 */
export type NoticeSeverity = 'info' | 'warn' | 'error';

/** A tool call that has started but not finished. */
export interface ActiveTool {
  id: string;
  name: string;
  summary: string;
  /** Epoch ms when the call entered the live panel; drives the elapsed suffix. */
  startedAt: number;
  compactSummary?: string;
  /** Raw only while active; the renderer bounds it before drawing. */
  input: unknown;
  backgroundMode?: BackgroundBashMode;
}

export interface TurnState {
  /** Finished entries, rendered once and never redrawn. */
  history: HistoryItem[];
  /** Assistant text still arriving, and not yet committed to history. */
  liveText: string;
  /**
   * Text of the in-flight answer already committed to `<Static>`, newlines
   * included, `''` when no piece of the current answer has been written yet.
   *
   * Kept because `<Static>` cannot be taken back: when `contentBlockEvent` closes
   * the answer with the authoritative text, this is what that text is reconciled
   * against — the remainder is appended if it is a continuation, and a divergence
   * has to be *said* rather than silently corrected.
   */
  committedAnswer: string;
  /** True while the model is emitting reasoning rather than answer text. */
  thinking: boolean;
  activeTools: ActiveTool[];
  /** Session-local display preference; immutable Static history is never rewritten. */
  toolDetailsExpanded: boolean;
  /**
   * Bumped by `clear`, and used as the `<Static>` React key.
   *
   * Emptying `history` is not enough to clear the screen: Ink accumulates every byte
   * `<Static>` ever wrote in `fullStaticOutput` and re-emits it on any later
   * whole-screen redraw, so the old transcript would reappear at the next overflow.
   * Remounting `<Static>` is what makes Ink drop that buffer (`reconciler.js` fires
   * `onStaticChange` on a node-identity change), which is why this is a key and not a
   * counter nobody reads.
   */
  staticEpoch: number;
}

export const initialTurnState: TurnState = {
  history: [],
  liveText: '',
  committedAnswer: '',
  thinking: false,
  activeTools: [],
  toolDetailsExpanded: false,
  staticEpoch: 0,
};

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export type TurnAction =
  | { type: 'userInput'; text: string }
  | { type: 'notice'; text: string; severity?: NoticeSeverity }
  | { type: 'toggleToolDetails' }
  | { type: 'streamEvent'; event: AgentStreamEvent }
  | { type: 'turnEnded' }
  | { type: 'clear' };

export function turnReducer(state: TurnState, action: TurnAction): TurnState {
  switch (action.type) {
    case 'userInput':
      return {
        ...state,
        history: [...state.history, { kind: 'user', id: nextId('user'), text: action.text }],
      };

    case 'notice':
      return {
        ...state,
        history: [
          ...state.history,
          { kind: 'notice', id: nextId('notice'), text: action.text, severity: action.severity ?? 'info' },
        ],
      };

    case 'toggleToolDetails': {
      const toolDetailsExpanded = !state.toolDetailsExpanded;
      return {
        ...state,
        toolDetailsExpanded,
        history: [
          ...state.history,
          {
            kind: 'notice',
            id: nextId('notice'),
            text: `tool details: ${toolDetailsExpanded ? 'expanded' : 'compact'}`,
            severity: 'info',
          },
        ],
      };
    }

    case 'turnEnded':
      // Flush anything the model left unterminated (e.g. a cancelled turn) so it
      // is not lost when the live area clears.
      return { ...flushLiveText(state), thinking: false, activeTools: [] };

    case 'clear':
      // `/clear` starts a new session, so the transcript of the old one goes with it.
      // Everything conversation-shaped is dropped and the `<Static>` epoch is bumped
      // (see {@link TurnState.staticEpoch}); `toolDetailsExpanded` is not, because it
      // is how this *user* wants tool calls drawn, not part of any conversation.
      return {
        ...initialTurnState,
        toolDetailsExpanded: state.toolDetailsExpanded,
        staticEpoch: state.staticEpoch + 1,
      };

    case 'streamEvent':
      return applyStreamEvent(state, action.event);
  }
}

function applyStreamEvent(state: TurnState, event: AgentStreamEvent): TurnState {
  switch (event.type) {
    case 'modelStreamUpdateEvent': {
      const inner = event.event;
      if (inner.type !== 'modelContentBlockDeltaEvent') return state;

      switch (inner.delta.type) {
        case 'textDelta':
          // Incremental answer text: the only thing appended character by character.
          return commitFinishedLines({
            ...state,
            liveText: state.liveText + inner.delta.text,
            thinking: false,
          });
        case 'reasoningContentDelta':
          // Reasoning is shown as a status indicator, never as answer text: it is
          // a different register from the reply and interleaving them reads as
          // corruption.
          return { ...state, thinking: true };
        default:
          // toolUseInputDelta / citationsDelta: partial tool arguments and citation
          // spans. The assembled values arrive on beforeToolCallEvent and
          // contentBlockEvent, so nothing to draw from the partials.
          return state;
      }
    }

    case 'contentBlockEvent': {
      const block = event.contentBlock;
      if (block.type === 'textBlock') {
        // The assembled block is authoritative — it closes off the accumulated
        // deltas and survives any delta we failed to observe. What is different now
        // is that some of those deltas are already in `<Static>`, which cannot be
        // taken back, so this is a reconciliation rather than a write.
        return closeAnswer(state, block.text.trim());
      }
      if (block.type === 'reasoningBlock') {
        return { ...state, thinking: false };
      }
      return state;
    }

    case 'beforeToolCallEvent': {
      // classify() already produces the human-readable summary the permission
      // prompt uses; reusing it keeps one description of a tool call, not two.
      const request = classify(event.toolUse.name, event.toolUse.input);
      const backgroundMode = backgroundBashMode(event.toolUse.name, event.toolUse.input);
      // Delegation rows carry the dispatch identity and the task: several children
      // run at once, so three rows reading `subagent: general` distinguish nothing.
      // Pure in the tool-use block — the reducer never reads the dispatch registry.
      const summary =
        subagentCallSummary(event.toolUse.name, event.toolUse.input, event.toolUse.toolUseId) ??
        request.summary;
      return {
        ...flushLiveText(state),
        thinking: false,
        activeTools: [
          ...state.activeTools,
          {
            id: event.toolUse.toolUseId,
            name: event.toolUse.name,
            summary,
            startedAt: Date.now(),
            input: event.toolUse.input,
            ...(backgroundMode === undefined
              ? {}
              : {
                  backgroundMode,
                  compactSummary: compactBackgroundCallSummary(backgroundMode, event.toolUse.input),
                }),
          },
        ],
      };
    }

    case 'afterToolCallEvent': {
      const toolUseId = event.toolUse.toolUseId;
      const active = state.activeTools.find((tool) => tool.id === toolUseId);
      // The active row's summary first, then the same delegation projection, then
      // the plain classification: a finished dispatch must not lose the identity
      // the live row showed just because the panel entry was already dropped.
      let summary =
        active?.summary ??
        subagentCallSummary(event.toolUse.name, event.toolUse.input, toolUseId) ??
        classify(event.toolUse.name, event.toolUse.input).summary;
      let preview = previewToolResult(event.result.content);
      const status: ToolStatus =
        event.result.status === 'error' ? (preview.startsWith('DENIED:') ? 'denied' : 'error') : 'ok';
      const activeTools = state.activeTools.filter((tool) => tool.id !== toolUseId);

      // Failures always retain the ordinary diagnostic. Compact presentation is
      // applied only after a successful manager result has been safely decoded.
      // Some SDK after-events omit the original input, so prefer the mode captured
      // when the call entered the live panel.
      const backgroundMode =
        active?.backgroundMode ?? backgroundBashMode(event.toolUse.name, event.toolUse.input);
      if (backgroundMode !== undefined && !state.toolDetailsExpanded) {
        // Compact labels stay bounded even when a call fails or its successful
        // payload drifts. Failures and fallbacks still retain the full preview.
        summary = active?.compactSummary ?? compactBackgroundCallSummary(
          backgroundMode,
          active?.input ?? event.toolUse.input,
        );
        if (status === 'ok') {
          const compact = compactBackgroundResult(
            backgroundMode,
            active?.input ?? event.toolUse.input,
            event.result.content,
          );
          if (compact.kind === 'suppress') return { ...state, activeTools };
          if (compact.kind === 'compact') {
            summary = compact.summary;
            preview = compact.preview;
          }
        }
      }

      return {
        ...state,
        activeTools,
        history: [
          ...state.history,
          {
            kind: 'tool',
            id: nextId('tool'),
            name: event.toolUse.name,
            summary,
            status,
            // Bound before immutable history/replay state owns the string.
            preview: toolResultPreview(preview, status, state.toolDetailsExpanded).join('\n'),
            inputPreview: state.toolDetailsExpanded
              ? expandedToolInput(active?.input ?? event.toolUse.input, event.toolUse.name).join('\n')
              : '',
            expanded: state.toolDetailsExpanded,
          },
        ],
      };
    }

    default:
      return state;
  }
}

/**
 * Moves answer lines that can no longer change into `<Static>` history.
 *
 * Committed is every complete line up to — but not including — the **last non-blank
 * complete line**. Two things fall out of that, and both are load-bearing:
 *
 * - The newest finished line is always held back, so `closeAnswer` always has
 *   something left to write. That closing piece is what carries the `last` part, and
 *   with it the blank row below the answer; Ink fixes an entry's margin when it
 *   writes it, so an answer that had already committed everything could never get
 *   that row back.
 * - **Trailing blank lines are held back too.** `contentBlockEvent` trims the
 *   assembled text, so a blank line at the end of the answer is not part of it —
 *   committing one would make the authoritative text disagree with history and
 *   report a divergence for an answer that had none. Measured on `a\nb\nc\n\n\n`,
 *   which is an ordinary way for a model to finish.
 *
 * Interior blank lines *are* committed: a paragraph break is content, and holding it
 * back would move the text under the cursor as the answer arrives.
 *
 * The committed text is recorded in `committedAnswer` verbatim, because that is what
 * makes the reconciliation at the end a comparison rather than a guess.
 */
function commitFinishedLines(state: TurnState): TurnState {
  const lines = state.liveText.split('\n');
  // The final element is the line still arriving — never complete, always held.
  let hold = lines.length - 1;
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if ((lines[index] as string).trim() !== '') {
      hold = index;
      break;
    }
  }
  if (hold === 0) return state;

  let text = lines.slice(0, hold).join('\n');
  const liveText = lines.slice(hold).join('\n');
  if (state.committedAnswer === '') {
    // The assembled block is trimmed at both ends, so leading blank lines are not
    // part of the answer either.
    text = text.replace(/^\s+/u, '');
    if (text === '') return { ...state, liveText };
  }

  return {
    ...state,
    liveText,
    committedAnswer: state.committedAnswer === '' ? text : `${state.committedAnswer}\n${text}`,
    history: [
      ...state.history,
      {
        kind: 'assistant',
        id: nextId('assistant'),
        text,
        part: state.committedAnswer === '' ? 'first' : 'middle',
      },
    ],
  };
}

/**
 * Closes the answer against the authoritative assembled text.
 *
 * Three outcomes, and the middle one is the whole reason this is not a plain write:
 *
 * - nothing committed yet → the answer enters history in one entry, exactly as it
 *   did before any of this existed;
 * - the authoritative text continues what was committed → only the remainder is
 *   written, as the `last` part;
 * - it *diverges* → the difference is stated as a warning and the authoritative
 *   text is written in full. The rows already printed are not retracted, because
 *   they cannot be; showing two versions with a line explaining why is the honest
 *   option, and silently dropping either one is not.
 */
function closeAnswer(state: TurnState, authoritative: string): TurnState {
  const settled: TurnState = { ...state, liveText: '', committedAnswer: '', thinking: false };
  if (state.committedAnswer === '') {
    if (authoritative === '') return settled;
    return { ...settled, history: [...state.history, answerEntry(authoritative, 'whole')] };
  }

  const prefix = `${state.committedAnswer}\n`;
  if (authoritative === state.committedAnswer) {
    // Defensive: `commitFinishedLines` holds back the last non-blank line, so there
    // is normally something left to write. If a stream ever leaves nothing, the
    // blank row below the answer is still owed, and an empty `last` entry is exactly
    // that row and nothing else.
    return { ...settled, history: [...state.history, answerEntry('', 'last')] };
  }
  if (authoritative.startsWith(prefix)) {
    return {
      ...settled,
      history: [...state.history, answerEntry(authoritative.slice(prefix.length), 'last')],
    };
  }

  return {
    ...settled,
    history: [
      ...state.history,
      {
        kind: 'notice',
        id: nextId('notice'),
        text:
          'the model’s final text differs from what was streamed; the lines above are what arrived, ' +
          'and the answer below is the authoritative version',
        severity: 'warn',
      },
      answerEntry(authoritative, 'whole'),
    ],
  };
}

function answerEntry(text: string, part: AnswerPart): HistoryItem {
  return { kind: 'assistant', id: nextId('assistant'), text, part };
}

/**
 * Writes out whatever answer text is still uncommitted.
 *
 * Reached when a tool call interrupts the text, and when a turn ends without the
 * model closing its block (a cancel, or a failure). Only the *uncommitted*
 * remainder is written — the committed lines are already in history, and writing
 * them again is the one thing progressive commits make easy to get wrong.
 */
function flushLiveText(state: TurnState): TurnState {
  const text = state.liveText.trim();
  if (text === '') {
    if (state.committedAnswer === '') return { ...state, liveText: '' };
    // Committed lines with nothing left over still owe the blank row below.
    return {
      ...state,
      liveText: '',
      committedAnswer: '',
      history: [...state.history, answerEntry('', 'last')],
    };
  }
  return {
    ...state,
    liveText: '',
    committedAnswer: '',
    history: [
      ...state.history,
      answerEntry(text, state.committedAnswer === '' ? 'whole' : 'last'),
    ],
  };
}

/** Flattens tool result content into text for the collapsed preview. */
export function previewToolResult(content: readonly unknown[]): string {
  const parts: string[] = [];

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const typed = block as { type?: string; text?: string; json?: unknown };

    if (typed.type === 'textBlock' && typeof typed.text === 'string') {
      parts.push(typed.text);
    } else if (typed.type === 'jsonBlock') {
      parts.push(safeStringify(typed.json));
    } else if (typeof typed.type === 'string') {
      // Images, video and documents have no useful text form here.
      parts.push(`[${typed.type}]`);
    }
  }
  return parts.join('\n').trim();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
