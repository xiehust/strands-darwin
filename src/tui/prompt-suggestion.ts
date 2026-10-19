/** Transient suggestion ownership. No runtime, filesystem, timer or model imports. */
import type { SuggestionResult } from '../agent/prompt-suggestion.js';
import { layoutEditor } from './prompt-editor.js';

export interface SuggestionOwners {
  idle: boolean;
  draft: string;
  permission: boolean;
  search: boolean;
  completion: boolean;
  image: boolean;
  editor: boolean;
  queue: boolean;
  peer: boolean;
  goal: boolean;
  task: boolean;
  replacing: boolean;
}

export function suggestionUnowned(owners: SuggestionOwners): boolean {
  return owners.idle && owners.draft === '' && !owners.permission && !owners.search &&
    !owners.completion && !owners.image && !owners.editor && !owners.queue &&
    !owners.peer && !owners.goal && !owners.task && !owners.replacing;
}

/** Full text AND key hint must fit in the existing empty composer row. No clipping. */
export function suggestionRow(candidate: string | undefined, columns: number, promptRows: number): string | undefined {
  if (candidate === undefined || promptRows < 1) return undefined;
  const row = `suggest: ${candidate} (Right to edit)`;
  const layout = layoutEditor(row, columns, { offset: row.length, affinity: 'upstream' });
  return columns >= 24 && layout.rows.length === 1 ? row : undefined;
}

/** App-scoped, so clear/rewind cannot reset a rejected provider into an endless loop. */
export class PromptSuggestionState {
  revision = 0;
  candidate: string | undefined;
  private active: AbortController | undefined;
  private attempted = -1;
  private key = '';
  private cause = '';
  private failures = 0;

  invalidate(): void {
    this.revision++;
    this.candidate = undefined;
    this.active?.abort();
    this.active = undefined;
  }

  async offer(
    revision: number,
    key: string,
    generate: (signal: AbortSignal) => Promise<SuggestionResult>,
    settled: (result: SuggestionResult, suspension?: string) => void,
  ): Promise<void> {
    if (revision !== this.revision || this.attempted === revision) return;
    if (key !== this.key) { this.key = key; this.failures = 0; this.cause = ''; }
    if (this.failures >= 3) return;
    this.attempted = revision;
    const controller = new AbortController();
    this.active = controller;
    const result = await generate(controller.signal);
    if (this.active === controller) this.active = undefined;
    // Usage is still reported for a cancelled/stale attempt; it was a real request.
    let suspension: string | undefined;
    if (!controller.signal.aborted && !result.cancelled && key === this.key) {
      if (result.problem !== undefined && result.problem !== 'no candidate returned') {
        this.failures = this.cause === result.problem ? this.failures + 1 : 1;
        this.cause = result.problem;
        if (this.failures === 3) suspension = `prompt suggestions suspended after 3 same-cause failures: ${this.cause}. Change model/config or restart to re-enable; no further automatic attempts in this App.`;
      } else { this.failures = 0; this.cause = ''; }
      if (revision === this.revision) this.candidate = result.candidate;
    }
    settled(result, suspension);
  }
}
