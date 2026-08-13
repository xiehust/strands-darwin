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

export type HistoryItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string; status: ToolStatus; preview: string }
  | { kind: 'notice'; id: string; text: string };

export type ToolStatus = 'ok' | 'error' | 'denied';

/** A tool call that has started but not finished. */
export interface ActiveTool {
  id: string;
  name: string;
  summary: string;
}

export interface TurnState {
  /** Finished entries, rendered once and never redrawn. */
  history: HistoryItem[];
  /** Assistant text still arriving. */
  liveText: string;
  /** True while the model is emitting reasoning rather than answer text. */
  thinking: boolean;
  activeTools: ActiveTool[];
}

export const initialTurnState: TurnState = {
  history: [],
  liveText: '',
  thinking: false,
  activeTools: [],
};

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export type TurnAction =
  | { type: 'userInput'; text: string }
  | { type: 'notice'; text: string }
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
        history: [...state.history, { kind: 'notice', id: nextId('notice'), text: action.text }],
      };

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
      return {
        ...flushLiveText(state),
        thinking: false,
        activeTools: [
          ...state.activeTools,
          { id: event.toolUse.toolUseId, name: event.toolUse.name, summary: request.summary },
        ],
      };
    }

    case 'afterToolCallEvent': {
      const toolUseId = event.toolUse.toolUseId;
      const active = state.activeTools.find((tool) => tool.id === toolUseId);
      const summary = active?.summary ?? classify(event.toolUse.name, event.toolUse.input).summary;
      const preview = previewToolResult(event.result.content);
      const status: ToolStatus =
        event.result.status === 'error' ? (preview.startsWith('DENIED:') ? 'denied' : 'error') : 'ok';

      return {
        ...state,
        activeTools: state.activeTools.filter((tool) => tool.id !== toolUseId),
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
