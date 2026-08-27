import { ContextWindowOverflowError } from '@strands-agents/sdk';

/** Bounded driver-only projection for an unrecovered SDK context overflow. */
export const CONTEXT_OVERFLOW_ERROR_LIMIT = 1_200;
const GUIDANCE =
  'The context is still too large. Run `/compact`, retry with a narrower request, or use `/clear` to start a new session.';

/**
 * Returns actionable bounded text only for the SDK's exact overflow error class.
 * Other errors are projected byte-for-byte so ordinary failure paths cannot drift.
 */
export function contextOverflowErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!isContextWindowOverflow(error)) return message;

  const detail = message.replace(/\s+/gu, ' ').trim();
  const separator = detail === '' ? '' : ' ';
  const suffix = `${separator}${GUIDANCE}`;
  const available = Math.max(0, CONTEXT_OVERFLOW_ERROR_LIMIT - [...suffix].length);
  const points = [...detail];
  const boundedDetail = points.length <= available
    ? detail
    : `${points.slice(0, Math.max(0, available - 1)).join('')}…`;
  return `${boundedDetail}${suffix}`;
}

function isContextWindowOverflow(error: unknown): boolean {
  return error instanceof ContextWindowOverflowError;
}
