import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  type GeneratedMemoryEntry,
  type MemorySourceAnchor,
  type MemoryState,
  type MemoryValidation,
} from './state.js';

export const MEMORY_SOURCE_MAX_BYTES = 256 * 1024;
export const MEMORY_SOURCE_MAX_LINES = 10_000;
export const MEMORY_SOURCE_LINE_MAX_CODE_POINTS = 4_000;
export const MEMORY_HORIZON_MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface MemoryValidationOptions { readonly horizonDays: number; readonly now?: () => Date; readonly persist?: boolean }
export interface ValidatedMemory { readonly state: MemoryState; readonly eligible: MemoryState }

export async function validateMemoryState(projectRoot: string, state: MemoryState, options: MemoryValidationOptions): Promise<ValidatedMemory> {
  const now = options.now?.() ?? new Date(); const generated: GeneratedMemoryEntry[] = [];
  for (const entry of state.generated) generated.push({ ...entry, validation: await validateEntry(projectRoot, entry, options.horizonDays, now) });
  const validated = { ...state, generated };
  const eligible = { ...validated, generated: generated.filter((entry) => entry.validation.state === 'valid') };
  return { state: validated, eligible };
}

async function validateEntry(projectRoot: string, entry: GeneratedMemoryEntry, horizonDays: number, now: Date): Promise<MemoryValidation> {
  const checkedAt = now.toISOString(); const sourceTime = Date.parse(entry.source.at);
  if (horizonDays > 0 && now.getTime() - sourceTime >= horizonDays * MEMORY_HORIZON_MS_PER_DAY) return { state: 'expired', reason: `generated evidence reached the ${horizonDays}-day horizon`, checkedAt };
  if (entry.evidence.kind === 'userInput') return { state: 'valid', reason: 'exact current user-input quote was verified before durable commit', checkedAt };
  const result = await validateAnchor(projectRoot, entry.evidence.anchor);
  return result === 'valid' ? { state: 'valid', reason: 'exact source anchor matches the current worktree', checkedAt } : { ...result, checkedAt };
}

type AnchorResult = { state: 'invalid' | 'unknown'; reason: string } | 'valid';
export async function validateAnchor(projectRoot: string, anchor: MemorySourceAnchor): Promise<AnchorResult> {
  if (!safeRelativePath(anchor.path)) return { state: 'invalid', reason: 'source anchor path is not a safe project-relative path' };
  let canonicalRoot: string; try { canonicalRoot = await realpath(projectRoot); } catch { return { state: 'unknown', reason: 'canonical project root could not be resolved' }; }
  const candidate = path.resolve(canonicalRoot, ...anchor.path.split('/')); if (!inside(canonicalRoot, candidate)) return { state: 'invalid', reason: 'source anchor escapes the canonical project root' };
  let handle;
  try {
    const pathStat = await lstat(candidate); if (pathStat.isSymbolicLink() || !pathStat.isFile()) return { state: 'invalid', reason: 'source anchor is not a regular project file' };
    const canonicalCandidate = await realpath(candidate); if (!inside(canonicalRoot, canonicalCandidate)) return { state: 'invalid', reason: 'source anchor resolves outside the canonical project root' };
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const stat = await handle.stat();
    if (!stat.isFile()) return { state: 'invalid', reason: 'source anchor is not a regular project file' }; if (stat.size > MEMORY_SOURCE_MAX_BYTES) return { state: 'unknown', reason: 'source file exceeds the validation byte bound' };
    const buffer = Buffer.alloc(stat.size + 1); let offset = 0; while (offset < stat.size) { const read = await handle.read(buffer, offset, stat.size - offset, offset); if (read.bytesRead === 0) break; offset += read.bytesRead; }
    const after = await handle.stat(); if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return { state: 'unknown', reason: 'source file changed while validation read it' };
    let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)); } catch { return { state: 'unknown', reason: 'source file is not valid UTF-8 text' }; }
    if (text.includes('\0')) return { state: 'unknown', reason: 'source file is binary text' }; const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > MEMORY_SOURCE_MAX_LINES) return { state: 'unknown', reason: 'source file exceeds the validation line bound' }; const line = lines[anchor.line - 1];
    if (line === undefined) return { state: 'invalid', reason: 'anchored source line no longer exists' }; if ([...line].length > MEMORY_SOURCE_LINE_MAX_CODE_POINTS) return { state: 'unknown', reason: 'anchored source line exceeds the validation bound' };
    if ([...line].length !== anchor.codePoints || hashLine(line) !== anchor.hash) return { state: 'invalid', reason: 'anchored source text changed' }; return 'valid';
  } catch (error) {
    const code = errorCode(error); if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'invalid', reason: 'anchored source file was deleted' }; if (code === 'ELOOP') return { state: 'invalid', reason: 'source anchor is a symbolic link' }; return { state: 'unknown', reason: 'source file could not be read safely' };
  } finally { await handle?.close().catch(() => {}); }
}

/** Closed reason set for exact-line anchoring failures; each save rejection names one. */
export type SourceAnchorFailure = 'quote-not-one-line' | 'unsafe-path' | 'oversized-source' | 'unreadable-source' | 'no-matching-line' | 'multiple-matching-lines';
export type SourceAnchorResolution = { readonly ok: true; readonly anchor: MemorySourceAnchor } | { readonly ok: false; readonly failure: SourceAnchorFailure };
const anchorFailure = (failure: SourceAnchorFailure): SourceAnchorResolution => ({ ok: false, failure });

export async function resolveExactSourceAnchor(projectRoot: string, pathname: string, evidence: string): Promise<SourceAnchorResolution> {
  if (!safeRelativePath(pathname)) return anchorFailure('unsafe-path');
  if (evidence.includes('\n') || [...evidence].length > MEMORY_SOURCE_LINE_MAX_CODE_POINTS) return anchorFailure('quote-not-one-line');
  const root = await realpath(projectRoot).catch(() => undefined); if (root === undefined) return anchorFailure('unreadable-source'); const candidate = path.resolve(root, ...pathname.split('/')); if (!inside(root, candidate)) return anchorFailure('unsafe-path');
  let handle;
  try {
    const pathStat = await lstat(candidate); if (!pathStat.isFile() || pathStat.isSymbolicLink() || !inside(root, await realpath(candidate))) return anchorFailure('unsafe-path');
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const stat = await handle.stat(); if (!stat.isFile()) return anchorFailure('unsafe-path'); if (stat.size > MEMORY_SOURCE_MAX_BYTES) return anchorFailure('oversized-source');
    const buffer = Buffer.alloc(stat.size); let offset = 0; while (offset < stat.size) { const read = await handle.read(buffer, offset, stat.size - offset, offset); if (read.bytesRead === 0) break; offset += read.bytesRead; }
    if (offset !== stat.size) return anchorFailure('unreadable-source'); const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); if (text.includes('\0')) return anchorFailure('unreadable-source');
    const lines = text.replace(/\r\n?/g, '\n').split('\n'); if (lines.length > MEMORY_SOURCE_MAX_LINES) return anchorFailure('oversized-source'); const matches = lines.flatMap((line, index) => line === evidence ? [index + 1] : []);
    if (matches.length === 0) return anchorFailure('no-matching-line'); if (matches.length > 1) return anchorFailure('multiple-matching-lines');
    return { ok: true, anchor: sourceAnchor(pathname, matches[0] as number, evidence) };
  } catch { return anchorFailure('unreadable-source'); } finally { await handle?.close().catch(() => {}); }
}
export function sourceAnchor(pathname: string, line: number, text: string): MemorySourceAnchor { return { path: pathname, line, hash: hashLine(text), codePoints: [...text].length }; }
export function safeRelativePath(value: string): boolean { return value !== '' && !path.isAbsolute(value) && !value.includes('\\') && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'); }
function hashLine(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function inside(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function errorCode(error: unknown): unknown { return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined; }
