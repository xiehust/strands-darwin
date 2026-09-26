/**
 * `/review [focus]` and `/review --commit <SHA>` are ordinary user prompts,
 * not a review executor or a read-only mode. Keep expansion pure; the existing
 * permission gate remains authoritative over any tools the model subsequently requests.
 */
export const REVIEW_COMMAND_NAME = 'review';

const REVIEW_PROMPT =
  'Review the current repository changes. First inspect the repository instructions, ' +
  'staged and unstaged changes, relevant untracked files, and the surrounding code needed ' +
  'to understand their behavior. Report actionable bugs in priority order, with file/line ' +
  'evidence and an explanation of the impact. List test gaps separately from bug findings. ' +
  'Avoid speculative or style-only findings. If you find no actionable bugs, say so ' +
  'explicitly; honestly state what you could not inspect or verify, including tests not run. ' +
  'Do not edit files or make commits unless separately requested. This is review guidance, ' +
  'not an enforced read-only mode; the existing permission gate remains authoritative.';

export const REVIEW_COMMIT_USAGE = 'Usage: /review --commit <40-hex-SHA>';

const COMMIT_PROMPT =
  'Review commit %SHA% only. Inspect the repository instructions and resolve this exact commit ' +
  'as a commit object. Inspect its diff against its parent (first parent for merges); if it is a root commit, compare it ' +
  'against the empty tree instead. Read the surrounding code and relevant tests to understand ' +
  'the changes. Report actionable bugs in priority order, with file/line evidence and impact. ' +
  'List test gaps separately; avoid speculative or style-only findings. If no actionable bugs ' +
  'are found, say so. If the commit or its parent is missing, unsupported or cannot be inspected, ' +
  'state the limitation honestly and do not invent a diff or findings. State any other unverified ' +
  'limits, including tests not run. Do not edit files or make commits. This is review guidance, ' +
  'not an enforced read-only mode; the existing permission gate remains authoritative.';

/** Exact, case-insensitive name grammar shared with the other prompt built-ins. */
export function parseReviewCommand(input: string): { message: string; invalid?: false } | { message?: undefined; invalid: true } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const withoutSlash = trimmed.slice(1);
  const separator = withoutSlash.search(/\s/);
  const name = separator === -1 ? withoutSlash : withoutSlash.slice(0, separator);
  if (name.toLowerCase() !== REVIEW_COMMAND_NAME) return null;

  const focus = separator === -1 ? '' : withoutSlash.slice(separator).trim();
  if (/^--commit(?:\s|$|=)/.test(focus)) {
    const match = focus.match(/^--commit\s+([0-9a-fA-F]{40})$/);
    return match === null ? { invalid: true } : { message: COMMIT_PROMPT.replace('%SHA%', match[1]!) };
  }
  return { message: REVIEW_PROMPT + (focus === '' ? '' : `\n\nFocus: ${focus}`) };
}
