/**
 * The `/goal` grammar (SER-108), shared by the TUI (which runs it) and the runtime's
 * slash expansion (which refuses it for headless drivers). Pure: no state, no I/O.
 */

/** Longest goal condition, in code points; over-cap is a local refusal, nothing is stored. */
export const GOAL_CONDITION_MAX_CODE_POINTS = 400;

export const GOAL_USAGE = 'usage: /goal <condition> · /goal (status) · /goal off';

export type GoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'off' }
  | { readonly kind: 'set'; readonly condition: string }
  | { readonly kind: 'too-long'; readonly length: number };

/**
 * The `/goal` grammar over already-trimmed input, or `undefined` for anything else
 * (`/goals` is not this command). Whitespace and control characters in the condition
 * collapse to single spaces, so a stored condition is always one printable line.
 */
export function parseGoalCommand(text: string): GoalCommand | undefined {
  const match = /^\/goal(?=\s|$)([\s\S]*)$/u.exec(text);
  if (match === null) return undefined;
  // eslint-disable-next-line no-control-regex
  const body = (match[1] ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/gu, ' ').trim();
  if (body === '') return { kind: 'status' };
  if (body.toLowerCase() === 'off') return { kind: 'off' };
  const length = Array.from(body).length;
  if (length > GOAL_CONDITION_MAX_CODE_POINTS) return { kind: 'too-long', length };
  return { kind: 'set', condition: body };
}

/** Headless drivers run exactly one prompt; the goal loop has no idle session to live in. */
export const GOAL_HEADLESS_REFUSAL =
  '/goal is interactive-only: it needs an idle session to check and continue in. ' +
  'Headless runs execute one prompt; state the completion condition in the prompt itself, ' +
  'or use the TUI.';
