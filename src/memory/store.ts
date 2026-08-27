import { projectKey } from '../paths.js';
import {
  MEMORY_MAX_GENERATED,
  emptyMemoryState,
  generatedMemoryId,
  memoryEntries,
  parseV3State,
  readMemoryState,
  renderMemoryIndex,
  withMemoryStateLock,
  writeMemoryProjection,
  writeMemoryState,
  type GeneratedMemoryCandidate,
  type GeneratedMemoryEntry,
  type MemoryState,
} from './state.js';
import { validateMemoryState, type MemoryValidationOptions } from './validation.js';

export interface MemoryStatus { readonly directory: string; readonly problem: string | undefined; readonly pending: boolean; readonly droppedJobs: number }

export async function readValidatedMemory(projectRoot: string, options: MemoryValidationOptions = { horizonDays: 28 }): Promise<{ state?: MemoryState; problem?: string; migrated: boolean }> {
  const read = await readMemoryState(projectRoot); if (read.kind === 'absent') return { migrated: false }; if (read.kind === 'invalid') return { problem: read.problem, migrated: false };
  try { return { state: (await validateMemoryState(projectRoot, read.state, { ...options, persist: false })).eligible, migrated: read.migrated }; }
  catch { return { state: { ...read.state, generated: [] }, problem: 'memory validation unavailable; generated entries omitted', migrated: read.migrated }; }
}

export async function commitGeneratedMemory(
  projectRoot: string,
  candidates: readonly GeneratedMemoryCandidate[],
  source: GeneratedMemoryEntry['source'],
  options: MemoryValidationOptions = { horizonDays: 28 },
): Promise<MemoryState> {
  return withMemoryStateLock(projectRoot, async () => {
    const read = await readMemoryState(projectRoot);
    if (read.kind === 'invalid') throw new Error(read.problem);

    let prior = read.kind === 'ready'
      ? read.state
      : emptyMemoryState(projectKey(projectRoot));
    if (read.kind === 'ready' && read.migrated) {
      // Legacy metadata is never trusted. Keep only currently exact, non-expired
      // generated facts when the first authorized mutation upgrades the authority.
      prior = (await validateMemoryState(projectRoot, prior, {
        ...options,
        persist: false,
      })).eligible;
    }

    if (candidates.length === 0 || candidates.length > 8) {
      throw new Error('generated memory commit requires 1–8 candidates');
    }
    const staged = [...candidates]
      .sort((left, right) => generatedMemoryId(left.key, left.fact).localeCompare(
        generatedMemoryId(right.key, right.fact),
      ))
      .map((candidate): GeneratedMemoryEntry => ({
        ...candidate,
        id: generatedMemoryId(candidate.key, candidate.fact),
        origin: 'generated',
        source,
        validation: {
          state: 'unknown',
          reason: 'awaiting durable commit validation',
          checkedAt: source.at,
        },
      }));
    if (new Set(staged.map((entry) => entry.key)).size !== staged.length) {
      throw new Error('generated memory commit contains duplicate keys');
    }
    for (const entry of staged) {
      const single: MemoryState = { ...emptyMemoryState(prior.projectKey), generated: [entry] };
      if (parseV3State(single) === undefined) {
        throw new Error('generated memory candidate failed strict state validation');
      }
      if (prior.suppressedGeneratedIds.includes(entry.id)) {
        throw new Error('generated memory candidate was previously forgotten');
      }
    }

    // Validate the combined state so unchanged generated entries keep their
    // audit metadata and stale/expired prior facts do not consume the bounded
    // archive. Commit eligibility, however, is checked only for this batch.
    const stagedKeys = new Set(staged.map((entry) => entry.key));
    const combinedState: MemoryState = {
      ...prior,
      generated: [
        ...prior.generated.filter((entry) => !stagedKeys.has(entry.key)),
        ...staged,
      ],
    };
    // Enforce the same aggregate caps and deterministic-id invariants before any
    // source reads or disk mutation, even if a caller bypasses the tool schema.
    if (parseV3State(combinedState) === undefined) {
      throw new Error('generated memory batch exceeds strict state bounds');
    }
    const combined = await validateMemoryState(projectRoot, combinedState, {
      ...options,
      persist: false,
    });
    const stagedIds = new Set(staged.map((entry) => entry.id));
    const validatedStaged = combined.state.generated.filter((entry) => stagedIds.has(entry.id));
    if (
      validatedStaged.length !== staged.length ||
      validatedStaged.some((entry) => entry.validation.state !== 'valid')
    ) {
      throw new Error('generated memory evidence no longer validates at durable commit');
    }

    const eligiblePrior = combined.state.generated.filter((entry) =>
      !stagedIds.has(entry.id) && entry.validation.state === 'valid');
    const byKey = new Map(eligiblePrior.map((entry) => [entry.key, entry]));
    for (const entry of validatedStaged) byKey.set(entry.key, entry);

    let generated = [...byKey.values()].filter((entry) =>
      !prior.suppressedGeneratedIds.includes(entry.id) &&
      !(entry.legacyIds ?? []).some((id) => prior.suppressedGeneratedIds.includes(id)));
    generated.sort((left, right) =>
      left.source.at.localeCompare(right.source.at) || left.id.localeCompare(right.id));
    generated = generated.slice(-MEMORY_MAX_GENERATED);

    const next: MemoryState = { ...prior, version: 3, generated };
    await writeMemoryState(projectRoot, next);
    // Markdown is optional projection. Authoritative state is already committed;
    // callers surface projection degradation through the controller status.
    await writeMemoryProjection(projectRoot, next);
    return next;
  });
}

export function rankMemory(state: MemoryState, query: string, limit: number): { entries: ReturnType<typeof memoryEntries>; omitted: number } {
  const phrase = query.trim().toLocaleLowerCase(); const tokens = [...new Set(phrase.split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
  const ranked = memoryEntries(state).flatMap((entry) => {
    const key = entry.origin === 'generated' ? entry.key : ''; const title = entry.origin === 'generated' ? entry.title : ''; const body = entry.origin === 'generated' ? entry.fact : entry.note; const category = entry.origin === 'generated' ? entry.category : 'user';
    const haystack = `${key} ${title} ${category} ${body}`.toLocaleLowerCase(); let score = haystack.includes(phrase) ? 100 : 0; if (key === phrase) score += 80; if (title.toLocaleLowerCase().includes(phrase)) score += 40;
    for (const token of tokens) { if (key.includes(token)) score += 12; if (`${title} ${category}`.toLocaleLowerCase().includes(token)) score += 6; if (body.toLocaleLowerCase().includes(token)) score += 2; }
    return score === 0 ? [] : [{ entry, score, at: entry.origin === 'generated' ? entry.source.at : entry.authoredAt }];
  }).sort((a, b) => b.score - a.score || b.at.localeCompare(a.at) || a.entry.id.localeCompare(b.entry.id));
  return { entries: ranked.slice(0, limit).map(({ entry }) => entry), omitted: Math.max(0, ranked.length - limit) };
}
export { renderMemoryIndex };
