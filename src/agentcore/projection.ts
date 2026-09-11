import { isSensitiveMemoryText } from '../memory/state.js';

/** Recall query policy only. Uploads deliberately do not use this safeguard. */
export function publicProse(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1000 || value.split('\n').length > 3 || /[\u0000-\u001f<>`{}]|(?:\/|\\)[\w.]|\b(?:token|secret|password|credential|private.key)\b/i.test(value) || isSensitiveMemoryText(value)) return undefined;
  return value;
}
