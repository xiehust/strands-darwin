/**
 * Bounded metadata for conversation-only rewind checkpoints.
 *
 * The SDK immutable snapshot is the sole model-state authority. This catalogue
 * maps its opaque id to the user prompt whose pre-invocation boundary it captures;
 * it is never replayed into an Agent and never consults trajectory.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sessionStateDir } from './session.js';

export const REWIND_CATALOGUE_FILENAME = 'rewind-checkpoints.json';
export const MAX_REWIND_CHECKPOINTS = 100;
export const MAX_REWIND_PROMPT_CODE_POINTS = 4_000;
export const MAX_REWIND_CATALOGUE_BYTES = 512 * 1024;
const REWIND_CATALOGUE_VERSION = 1;
const MAX_SNAPSHOT_ID_CODE_POINTS = 128;

export interface RewindCheckpoint {
  readonly snapshotId: string;
  readonly prompt: string;
  readonly completedAt: string;
}

export interface RewindCatalogue {
  readonly checkpoints: readonly RewindCheckpoint[];
  readonly problem?: string | undefined;
  /** The catalogue itself has reached its entry bound. */
  readonly capped: boolean;
  /** Runtime projection: no further rewind-owned immutable snapshot may be created. */
  readonly captureCapacityReached?: boolean | undefined;
}

interface RewindCatalogueFile {
  readonly v: typeof REWIND_CATALOGUE_VERSION;
  readonly sessionId: string;
  readonly checkpoints: readonly RewindCheckpoint[];
}

export function rewindCataloguePath(projectRoot: string, sessionId: string): string {
  return path.join(sessionStateDir(projectRoot, sessionId), REWIND_CATALOGUE_FILENAME);
}

/** A prompt too large to return to the editor is never advertised as selectable. */
export function rewindPromptEligible(prompt: string): boolean {
  return prompt !== '' && [...prompt].length <= MAX_REWIND_PROMPT_CODE_POINTS;
}

/** Strict bounded read. Damage is stated and never repaired or overwritten. */
export async function readRewindCatalogue(
  projectRoot: string,
  sessionId: string,
): Promise<RewindCatalogue> {
  const file = rewindCataloguePath(projectRoot, sessionId);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (isMissing(error)) return { checkpoints: [], capped: false };
    return { checkpoints: [], capped: false, problem: `could not read rewind checkpoints: ${message(error)}` };
  }
  if (bytes.byteLength > MAX_REWIND_CATALOGUE_BYTES) {
    return { checkpoints: [], capped: false, problem: 'rewind checkpoint catalogue exceeds its byte bound' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { checkpoints: [], capped: false, problem: 'rewind checkpoint catalogue is not valid JSON' };
  }
  if (!isRecord(parsed) || parsed.v !== REWIND_CATALOGUE_VERSION || parsed.sessionId !== sessionId ||
      !Array.isArray(parsed.checkpoints) || parsed.checkpoints.length > MAX_REWIND_CHECKPOINTS) {
    return { checkpoints: [], capped: false, problem: 'rewind checkpoint catalogue has an invalid shape' };
  }

  const checkpoints: RewindCheckpoint[] = [];
  const ids = new Set<string>();
  for (const value of parsed.checkpoints) {
    if (!isRecord(value) || typeof value.snapshotId !== 'string' || typeof value.prompt !== 'string' ||
        typeof value.completedAt !== 'string' || [...value.snapshotId].length === 0 ||
        [...value.snapshotId].length > MAX_SNAPSHOT_ID_CODE_POINTS || !rewindPromptEligible(value.prompt) ||
        !Number.isFinite(Date.parse(value.completedAt)) || ids.has(value.snapshotId)) {
      return { checkpoints: [], capped: false, problem: 'rewind checkpoint catalogue has an invalid entry' };
    }
    ids.add(value.snapshotId);
    checkpoints.push({
      snapshotId: value.snapshotId,
      prompt: value.prompt,
      completedAt: value.completedAt,
    });
  }
  return { checkpoints, capped: checkpoints.length >= MAX_REWIND_CHECKPOINTS };
}

/**
 * Adds one completed prompt boundary. A full or damaged catalogue stays untouched;
 * immutable SDK snapshots are never deleted or overwritten to make room.
 */
export async function appendRewindCheckpoint(
  projectRoot: string,
  sessionId: string,
  checkpoint: RewindCheckpoint,
): Promise<RewindCatalogue> {
  if (!rewindPromptEligible(checkpoint.prompt)) {
    return { checkpoints: [], capped: false, problem: 'prompt exceeds the rewind editor bound' };
  }
  const current = await readRewindCatalogue(projectRoot, sessionId);
  if (current.problem !== undefined || current.capped) return current;
  if (current.checkpoints.some((entry) => entry.snapshotId === checkpoint.snapshotId)) {
    return { ...current, problem: 'rewind checkpoint id is already catalogued' };
  }

  const checkpoints = [...current.checkpoints, checkpoint];
  const document: RewindCatalogueFile = {
    v: REWIND_CATALOGUE_VERSION,
    sessionId,
    checkpoints,
  };
  const encoded = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(encoded) > MAX_REWIND_CATALOGUE_BYTES) {
    return { checkpoints: current.checkpoints, capped: false, problem: 'rewind checkpoint catalogue reached its byte bound' };
  }

  const file = rewindCataloguePath(projectRoot, sessionId);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return { checkpoints: current.checkpoints, capped: false, problem: `could not write rewind checkpoints: ${message(error)}` };
  }
  return { checkpoints, capped: checkpoints.length >= MAX_REWIND_CHECKPOINTS };
}

/** Newest completed prompt first for the chooser. */
export function newestRewindCheckpoints(catalogue: RewindCatalogue): readonly RewindCheckpoint[] {
  return [...catalogue.checkpoints].reverse();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
