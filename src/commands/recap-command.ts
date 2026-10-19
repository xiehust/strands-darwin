/** Only the interactive local-human submit path may generate a recap. */
export const RECAP_USAGE = 'Usage: /recap (no arguments)';
export const RECAP_UNSUPPORTED = '/recap requires an explicit local human request in the interactive TUI; no recap generated';
export function parseRecapCommand(input: string): 'recap' | 'usage' | undefined {
  const text = input.trim();
  if (!/^\/recap(?:\s|$)/iu.test(text)) return undefined;
  return /^\/recap$/iu.test(text) ? 'recap' : 'usage';
}
