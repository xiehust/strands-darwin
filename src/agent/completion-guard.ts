import type { AgentStreamEvent } from '@strands-agents/sdk';

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

/** Runs one candidate and, for one matched note only, one ordinary continuation. */
export async function runWithCompletionGuard<T>(
  input: string,
  runOrdinaryCandidate: (turnInput: string) => Promise<CompletionCandidate<T>>,
): Promise<T> {
  const first = await runOrdinaryCandidate(input);
  if (!first.eligible || !isInternalCompletionNote(first.finalText)) {
    first.accept();
    return first.value;
  }

  first.suppress();
  const continuation = await runOrdinaryCandidate(COMPLETION_GUARD_PROMPT);
  // Strictly one continuation: a second match is terminal, not recursive, and its
  // note is still private rather than becoming a failed public answer.
  if (continuation.eligible && isInternalCompletionNote(continuation.finalText)) {
    continuation.suppress();
    throw new CompletionGuardError();
  }
  continuation.accept();
  return continuation.value;
}

/** Collects one deferred ordinary turn without publishing any candidate event. */
export async function collectCompletionCandidate(
  runtime: CompletionGuardRuntime,
  input: string,
  onFailed?: (events: readonly AgentStreamEvent[]) => void,
): Promise<CompletionCandidate<readonly AgentStreamEvent[]>> {
  const turn = runtime.beginCompletionGuardTurn === undefined
    ? { events: runtime.send(input), accept: () => {}, suppress: () => {} }
    : await runtime.beginCompletionGuardTurn(input, input === COMPLETION_GUARD_PROMPT);
  const events: AgentStreamEvent[] = [];
  let overflowed = false;
  try {
    for await (const event of turn.events) {
      if (events.length < MAX_COMPLETION_GUARD_EVENTS) events.push(event);
      else overflowed = true;
    }
  } catch (error) {
    turn.accept();
    onFailed?.(events);
    throw error;
  }
  return {
    value: events,
    finalText: finalAssistantText(events),
    eligible: completionCandidateEligible(events, overflowed),
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
