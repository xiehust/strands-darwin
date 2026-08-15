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

export type HistoryItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: ToolStatus; preview: string }
  | { kind: 'notice'; id: string; text: string; severity: NoticeSeverity };

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
  backgroundMode?: BackgroundBashMode;
  backgroundInput?: unknown;
}

export interface TurnState {
  /** Finished entries, rendered once and never redrawn. */
  history: HistoryItem[];
  /** Assistant text still arriving. */
  liveText: string;
  /** True while the model is emitting reasoning rather than answer text. */
  thinking: boolean;
  activeTools: ActiveTool[];
  /** Session-local display preference; immutable Static history is never rewritten. */
  backgroundDetailsExpanded: boolean;
}

export const initialTurnState: TurnState = {
  history: [],
  liveText: '',
  thinking: false,
  activeTools: [],
  backgroundDetailsExpanded: false,
};

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export type TurnAction =
  | { type: 'userInput'; text: string }
  | { type: 'notice'; text: string; severity?: NoticeSeverity }
  | { type: 'toggleBackgroundDetails' }
  | { type: 'streamEvent'; event: AgentStreamEvent }
  | { type: 'turnEnded' };

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

    case 'toggleBackgroundDetails': {
      const backgroundDetailsExpanded = !state.backgroundDetailsExpanded;
      return {
        ...state,
        backgroundDetailsExpanded,
        history: [
          ...state.history,
          {
            kind: 'notice',
            id: nextId('notice'),
            text: `background details: ${backgroundDetailsExpanded ? 'expanded' : 'compact'}`,
            severity: 'info',
          },
        ],
      };
    }

    case 'turnEnded':
      // Flush anything the model left unterminated (e.g. a cancelled turn) so it
      // is not lost when the live area clears.
      return { ...flushLiveText(state), thinking: false, activeTools: [] };

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
          return { ...state, liveText: state.liveText + inner.delta.text, thinking: false };
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
        // deltas and survives any delta we failed to observe.
        const text = block.text.trim();
        if (text === '') return { ...state, liveText: '' };
        return {
          ...state,
          liveText: '',
          thinking: false,
          history: [...state.history, { kind: 'assistant', id: nextId('assistant'), text }],
        };
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
            ...(backgroundMode === undefined
              ? {}
              : {
                  backgroundMode,
                  backgroundInput: event.toolUse.input,
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
      if (backgroundMode !== undefined && !state.backgroundDetailsExpanded) {
        // Compact labels stay bounded even when a call fails or its successful
        // payload drifts. Failures and fallbacks still retain the full preview.
        summary = active?.compactSummary ?? compactBackgroundCallSummary(
          backgroundMode,
          active?.backgroundInput ?? event.toolUse.input,
        );
        if (status === 'ok') {
          const compact = compactBackgroundResult(
            backgroundMode,
            active?.backgroundInput ?? event.toolUse.input,
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
          { kind: 'tool', id: nextId('tool'), name: event.toolUse.name, summary, status, preview },
        ],
      };
    }

    default:
      return state;
  }
}

/** Moves any in-progress assistant text into history. */
function flushLiveText(state: TurnState): TurnState {
  const text = state.liveText.trim();
  if (text === '') return { ...state, liveText: '' };
  return {
    ...state,
    liveText: '',
    history: [...state.history, { kind: 'assistant', id: nextId('assistant'), text }],
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
