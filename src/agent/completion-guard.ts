import { MaxTokensError, type AgentStreamEvent } from '@strands-agents/sdk';

import { parsePlanInput, UPDATE_PLAN_TOOL_NAME } from '../tools/update-plan.js';

const MAX_CANDIDATE_CODE_POINTS = 240;
const MAX_CANDIDATE_WORDS = 24;
export const MAX_COMPLETION_GUARD_EVENTS = 512;

/**
 * Fixed private input for the sole continuation. It contains neither the original
 * request nor the suppressed note, so it cannot replay either one.
 */
export const COMPLETION_GUARD_PROMPT = [
  '[Darwin automatic completion guard]',
  'Inspect the retained conversation and completed work.',
  'Do not repeat prior text or completed actions.',
  'If an action is still required, perform the actual tool call now; otherwise give the user a concise direct answer.',
  'Do not output planning notes, TODOs, or descriptions of what you intend to do.',
].join(' ');

/** Fixed private continuation when the parent checklist proves work is unfinished. */
export const UNFINISHED_PLAN_PROMPT = [
  '[Darwin automatic unfinished-plan guard]',
  'The latest parent progress checklist still contains pending or in-progress items.',
  'Continue the actual work from retained context without repeating completed actions.',
  'Use tools as needed, verify the work, update the checklist truthfully, then give the user a concise final answer.',
  'If progress is genuinely blocked on user input, state that blocker directly instead.',
].join(' ');

export class CompletionGuardError extends Error {
  constructor() {
    super('The agent ended twice on an internal working note without completing the response.');
    this.name = 'CompletionGuardError';
  }
}

export interface CompletionCandidate<T> {
  value: T;
  finalText: string;
  eligible: boolean;
  unfinishedPlan: boolean;
  accept(): void;
  suppress(): void;
}

export interface CompletionGuardRuntime {
  send(input: string): AsyncIterable<AgentStreamEvent>;
  beginCompletionGuardTurn?(input: string, privateInput?: boolean): Promise<{
    events: AsyncIterable<AgentStreamEvent>;
    accept(): void;
    suppress(): void;
  }>;
}

/**
 * Conservative classifier for short, standalone internal action notes. Long prose,
 * questions, completed statements, and ordinary user-facing sentences fail open.
 */
export function isInternalCompletionNote(text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  const points = [...normalized];
  if (points.length === 0 || points.length > MAX_CANDIDATE_CODE_POINTS) return false;
  if (normalized.split(' ').length > MAX_CANDIDATE_WORDS) return false;
  if (/[?!。！？]/u.test(normalized) || /(?:^|\s)(?:you|your|we|i have|here(?:'s| is)|done|completed|finished)(?:\s|$)/iu.test(normalized)) {
    return false;
  }

  const note = normalized
    .replace(/^[\-*#>\s]+/u, '')
    .replace(/[.;:]+$/u, '')
    .trim();
  const internalVerb = '(?:continue|call|use|run|update|answer|respond|reply|check|verify|fix|implement|write|read|open|test)';
  return new RegExp(
    `^(?:need(?:\\s+to)?\\s+${internalVerb}\\b|must\\s+${internalVerb}\\b|should\\s+${internalVerb}\\b|todo\\b|continue\\s+(?:the\\s+)?tools?\\b|update\\s+(?:the\\s+)?plan\\b|(?:call|use|run)\\s+(?:the\\s+)?tools?\\b)`,
    'iu',
  ).test(note);
}

/** Runs one candidate and, for one matched completion gap only, one continuation. */
export async function runWithCompletionGuard(
  input: string,
  runOrdinaryCandidate: (
    turnInput: string,
  ) => Promise<CompletionCandidate<readonly AgentStreamEvent[]>>,
): Promise<readonly AgentStreamEvent[]> {
  const first = await runOrdinaryCandidate(input);
  const internalNote = first.eligible && isInternalCompletionNote(first.finalText);
  const unfinishedPlan = first.unfinishedPlan && !statesUserBlocker(first.finalText);
  if (!internalNote && !unfinishedPlan) {
    first.accept();
    return first.value;
  }

  // An internal note has no public value and remains private. An unfinished-plan
  // candidate may contain many completed tool side effects: accept and retain every
  // event before asking the model to continue, never hide or replay those actions.
  if (internalNote) first.suppress();
  else first.accept();
  const continuation = await runOrdinaryCandidate(
    unfinishedPlan ? UNFINISHED_PLAN_PROMPT : COMPLETION_GUARD_PROMPT,
  );
  // Strictly one continuation. For the original internal-note path a second note is
  // terminal. For an unfinished plan, preserve the already-accepted work and suppress
  // only a second private note; never discard completed tool evidence.
  if (continuation.eligible && isInternalCompletionNote(continuation.finalText)) {
    continuation.suppress();
    if (unfinishedPlan) return first.value;
    throw new CompletionGuardError();
  }
  continuation.accept();
  return unfinishedPlan ? [...first.value, ...continuation.value] : continuation.value;
}

/** Collects one deferred ordinary turn without publishing any candidate event. */
export async function collectCompletionCandidate(
  runtime: CompletionGuardRuntime,
  input: string,
  onFailed?: (events: readonly AgentStreamEvent[]) => void,
): Promise<CompletionCandidate<readonly AgentStreamEvent[]>> {
  const privateInput = input === COMPLETION_GUARD_PROMPT || input === UNFINISHED_PLAN_PROMPT;
  const turn = runtime.beginCompletionGuardTurn === undefined
    ? { events: runtime.send(input), accept: () => {}, suppress: () => {} }
    : await runtime.beginCompletionGuardTurn(input, privateInput);
  const events: AgentStreamEvent[] = [];
  let overflowed = false;
  let pendingText = '';
  let pendingTextEvent: AgentStreamEvent | undefined;
  try {
    for await (const event of turn.events) {
      const textDelta = textDeltaOf(event);
      if (textDelta !== undefined) {
        // Needed only when no authoritative text block arrives (cancel/throw). Keep
        // one bounded suffix outside the aggregate-event cap, not every raw delta.
        pendingText = boundedTextSuffix(pendingText + textDelta);
        pendingTextEvent = event;
        continue;
      }
      if (event.type === 'contentBlockEvent' && event.contentBlock.type === 'textBlock') {
        // Preserve the reducer's ordinary delta-before-authoritative-block shape without
        // retaining every provider chunk. One synthesized aggregate delta produces the
        // same committed answer pieces while keeping the event bound independent of
        // provider chunk frequency.
        if (pendingTextEvent !== undefined) {
          if (events.length < MAX_COMPLETION_GUARD_EVENTS) {
            events.push(retainedTextDelta(pendingTextEvent, event.contentBlock.text));
          } else {
            overflowed = true;
          }
        }
        pendingText = '';
        pendingTextEvent = undefined;
      }
      // Buffer only events consumed by a public driver. High-frequency raw model
      // deltas and hook events have authoritative aggregate events later; counting
      // them used to exhaust this cap and silently drop the final answer/plan.
      if (!isPublicCandidateEvent(event)) continue;
      if (events.length < MAX_COMPLETION_GUARD_EVENTS) events.push(event);
      else overflowed = true;
    }
  } catch (error) {
    turn.accept();
    const failedEvents = pendingTextEvent === undefined
      ? events
      : [...events, retainedTextDelta(pendingTextEvent, pendingText)];
    onFailed?.(failedEvents);
    throw error;
  }
  if (pendingTextEvent !== undefined) events.push(retainedTextDelta(pendingTextEvent, pendingText));
  return {
    value: events,
    finalText: finalAssistantText(events),
    eligible: completionCandidateEligible(events, overflowed),
    unfinishedPlan: unfinishedPlanAtEnd(events, overflowed),
    accept: turn.accept,
    suppress: turn.suppress,
  };
}

export function finalAssistantText(events: readonly AgentStreamEvent[]): string {
  const result = events.findLast(
    (event): event is Extract<AgentStreamEvent, { type: 'agentResultEvent' }> =>
      event.type === 'agentResultEvent',
  );
  if (result === undefined || result.result.stopReason !== 'endTurn') return '';
  const message = result.result.lastMessage ?? events.findLast(
    (event): event is Extract<AgentStreamEvent, { type: 'modelMessageEvent' }> =>
      event.type === 'modelMessageEvent',
  )?.message;
  return (message?.content ?? [])
    .flatMap((block) => block.type === 'textBlock' ? [block.text] : [])
    .join('')
    .trim();
}

/** Tool-bearing turns and oversized buffers fail open; hidden side effects are forbidden. */
export function completionCandidateEligible(events: readonly AgentStreamEvent[], overflowed: boolean): boolean {
  if (overflowed) return false;
  return !events.some((event) =>
    event.type === 'beforeToolCallEvent' || event.type === 'afterToolCallEvent',
  );
}

/** Events consumed by at least one public driver after guard acceptance. */
function isPublicCandidateEvent(event: AgentStreamEvent): boolean {
  switch (event.type) {
    case 'contentBlockEvent':
      return event.contentBlock.type === 'textBlock';
    case 'afterModelCallEvent':
      return event.error instanceof MaxTokensError;
    case 'modelMessageEvent':
    case 'beforeToolCallEvent':
    case 'afterToolCallEvent':
    case 'agentResultEvent':
      return true;
    default:
      return false;
  }
}

const MAX_PENDING_TEXT_CODE_POINTS = 8_000;

function textDeltaOf(event: AgentStreamEvent): string | undefined {
  if (event.type !== 'modelStreamUpdateEvent') return undefined;
  const inner = event.event;
  return inner.type === 'modelContentBlockDeltaEvent' && inner.delta.type === 'textDelta'
    ? inner.delta.text
    : undefined;
}

function boundedTextSuffix(value: string): string {
  const points = [...value];
  return points.length <= MAX_PENDING_TEXT_CODE_POINTS
    ? value
    : points.slice(-MAX_PENDING_TEXT_CODE_POINTS).join('');
}

/** Rebuilds one reducer-compatible delta carrying only the bounded retained suffix. */
function retainedTextDelta(event: AgentStreamEvent, text: string): AgentStreamEvent {
  if (event.type !== 'modelStreamUpdateEvent') return event;
  const inner = event.event;
  if (inner.type !== 'modelContentBlockDeltaEvent' || inner.delta.type !== 'textDelta') return event;
  return {
    ...event,
    event: {
      ...inner,
      delta: { ...inner.delta, text },
    },
  } as AgentStreamEvent;
}

/** Latest successful parent checklist still has work, on a clean successful turn. */
export function unfinishedPlanAtEnd(
  events: readonly AgentStreamEvent[],
  overflowed = false,
): boolean {
  if (overflowed) return false;
  const result = events.findLast(
    (event): event is Extract<AgentStreamEvent, { type: 'agentResultEvent' }> =>
      event.type === 'agentResultEvent',
  );
  if (result?.result.stopReason !== 'endTurn') return false;

  let latestPlan: ReturnType<typeof parsePlanInput>;
  for (const event of events) {
    if (event.type !== 'afterToolCallEvent') continue;
    if (event.result.status === 'error') return false;
    if (event.toolUse.name !== UPDATE_PLAN_TOOL_NAME) continue;
    latestPlan = parsePlanInput(event.toolUse.input);
  }
  return latestPlan?.some((item) => item.status !== 'completed') === true;
}

/** A direct blocker/question is a valid reason to return with unfinished work. */
export function statesUserBlocker(text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized === '') return false;
  return /[?？]/u.test(normalized) ||
    /\b(?:need|require|waiting for|blocked on|cannot proceed without)\s+(?:your|user|the user)\b/iu.test(normalized) ||
    /\b(?:please provide|please choose|which (?:option|one)|clarif(?:y|ication))\b/iu.test(normalized) ||
    /(?:需要|请)(?:你|您)(?:提供|确认|选择)|等待(?:你|您)(?:提供|确认)|无法继续/u.test(normalized);
}
