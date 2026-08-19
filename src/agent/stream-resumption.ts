import { ModelError } from '@strands-agents/sdk';

const STREAM_INTERRUPTION_MESSAGE = 'Stream ended without completing a message';

/**
 * A bounded internal instruction for the one continuation turn. It deliberately
 * contains none of the original request: the retained SDK conversation is the source
 * of truth, and replaying user text could replay completed side effects.
 */
export const STREAM_CONTINUATION_PROMPT =
  '[Darwin automatic continuation after an interrupted model stream] Inspect the retained conversation and work already completed. Continue from exactly where the interruption occurred. Do not repeat completed work, replay tool calls, or restart the original request. Briefly verify the current state before any further action.';

export const STREAM_CONTINUATION_NOTICE =
  'model stream interrupted; continuing once from retained conversation without repeating completed work';

/** The sole provider failure SRF-001 permits Darwin to continue automatically. */
export function isRetryableStreamInterruption(error: unknown): error is ModelError {
  if (!(error instanceof ModelError)) return false;
  const normalized = error.message.trim().replace(/[.!]+$/u, '').trimEnd();
  return normalized === STREAM_INTERRUPTION_MESSAGE;
}

/**
 * Runs an ordinary turn and, for the one recognized stream interruption only, one
 * ordinary continuation turn. The first error is observed but never replaced or
 * mutated; if continuation fails, that second error reaches the caller unchanged.
 */
export async function runWithStreamResumption<T>(
  input: string,
  runOrdinaryTurn: (turnInput: string) => Promise<T>,
  onContinuing: (error: ModelError) => void,
): Promise<T> {
  try {
    return await runOrdinaryTurn(input);
  } catch (error) {
    if (!isRetryableStreamInterruption(error)) throw error;
    onContinuing(error);
    return runOrdinaryTurn(STREAM_CONTINUATION_PROMPT);
  }
}
