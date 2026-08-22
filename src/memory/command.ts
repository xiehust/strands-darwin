import { projectKey } from '../paths.js';
import {
  MEMORY_STATE_VERSION,
  MEMORY_MAX_SUPPRESSIONS,
  MEMORY_MAX_USER_NOTES,
  createUserMemoryEntry,
  isSafeMemoryId,
  memoryEntries,
  readMemoryState,
  renderMemoryIndex,
  validateRememberedNote,
  withMemoryStateLock,
  writeMemoryState,
  type MemoryEntry,
  type MemoryState,
} from './state.js';
import { validateMemoryState, type MemoryValidationOptions } from './validation.js';

export const MEMORY_REPORT_MAX_LINES = 48;
export const MEMORY_REPORT_MAX_LINE_CODE_POINTS = 180;
export const MEMORY_REPORT_MAX_ENTRIES = 32;
export const MEMORY_USAGE = 'usage: /memory [list] · /memory show <id|number> · /memory forget <id|number|all> · /memory remember <note>';

export type MemoryCommandResult =
  | { readonly changed: false; readonly text: string; readonly index?: string }
  | { readonly changed: true; readonly text: string; readonly index: string };

export async function runMemoryCommand(
  projectRoot: string,
  input: string,
  options: MemoryValidationOptions = { horizonDays: 28 },
): Promise<MemoryCommandResult> {
  const argument = input.slice('/memory'.length).trim();
  const separator = argument.search(/\s/);
  const verb = argument === '' ? 'list' : separator === -1 ? argument : argument.slice(0, separator);
  const target = separator === -1 ? '' : argument.slice(separator).trim();
  if ((verb === 'list' && target !== '') || !['list', 'show', 'forget', 'remember'].includes(verb)) {
    return unchanged(`${verb} is not a valid /memory form\n  ${MEMORY_USAGE}`);
  }
  if (verb === 'list') return listMemory(projectRoot, options);
  if (verb === 'show') return showMemory(projectRoot, target, options);
  if (verb === 'remember') return rememberMemory(projectRoot, target, options);
  return forgetMemory(projectRoot, target, options);
}

async function listMemory(projectRoot: string, options: MemoryValidationOptions): Promise<MemoryCommandResult> {
  const loaded = await loadedState(projectRoot, options);
  if ('text' in loaded) return unchanged(loaded.text);
  const entries = memoryEntries(loaded.state).slice(0, MEMORY_REPORT_MAX_ENTRIES);
  const lines = [scopeLine(projectRoot), `entries: ${entries.length}/${memoryEntries(loaded.state).length}`];
  if (entries.length === 0) lines.push('  (empty)');
  entries.forEach((entry, index) => lines.push(listLine(entry, index + 1)));
  lines.push(`generated horizon: ${options.horizonDays === 0 ? 'disabled (source validation remains required)' : `${options.horizonDays} days`}`);
  lines.push(`suppressed generated ids: ${loaded.state.suppressedGeneratedIds.length}/${MEMORY_MAX_SUPPRESSIONS}`);
  lines.push(`  ${MEMORY_USAGE}`);
  return { changed: false, text: report(lines), index: renderMemoryIndex(await eligibleState(projectRoot, loaded.state, options)) };
}

async function showMemory(projectRoot: string, target: string, options: MemoryValidationOptions): Promise<MemoryCommandResult> {
  if (target === '') return unchanged(MEMORY_USAGE);
  const loaded = await loadedState(projectRoot, options);
  if ('text' in loaded) return unchanged(loaded.text);
  const entry = resolveEntry(loaded.state, target);
  if (entry === undefined) return unchanged(report([scopeLine(projectRoot), `${safeTarget(target)} matches no memory entry — nothing shown`, `  ${MEMORY_USAGE}`]));
  return unchanged(report(showLines(entry)));
}

async function rememberMemory(projectRoot: string, raw: string, options: MemoryValidationOptions): Promise<MemoryCommandResult> {
  const note = validateRememberedNote(raw);
  if (note === undefined) return unchanged(report(['memory note refused: expected 1–800 code points of non-sensitive project context, without prompt boundaries, policy-like instructions, controls, or dump text', `  ${MEMORY_USAGE}`]));
  return withMemoryStateLock(projectRoot, async () => {
    const read = await readMemoryState(projectRoot);
    if (read.kind === 'invalid') return unchanged(report([scopeLine(projectRoot), `state: corrupt/refused — ${read.problem}`]));
    const prior: MemoryState = read.kind === 'ready' ? read.state : {
      version: MEMORY_STATE_VERSION, projectKey: projectKey(projectRoot), generated: [], user: [], suppressedGeneratedIds: [], skipped: 0,
    };
    if (prior.user.length >= MEMORY_MAX_USER_NOTES) return unchanged(`memory note refused: user note limit ${MEMORY_MAX_USER_NOTES} reached`);
    if (prior.user.some((entry) => entry.note === note)) return unchanged(`memory note already exists as ${prior.user.find((entry) => entry.note === note)?.id}`);
    const entry = createUserMemoryEntry(note);
    if (prior.generated.some((candidate) => candidate.id === entry.id) || prior.suppressedGeneratedIds.includes(entry.id)) {
      return unchanged('memory note refused: generated id collision; retry the command');
    }
    const next: MemoryState = { ...prior, user: [...prior.user, entry] };
    await writeMemoryState(projectRoot, next);
    return changed(`remembered project memory ${entry.id} — user-authored; explicit/unvalidated; sensitivity heuristic-screened`, await eligibleState(projectRoot, next, options));
  });
}

async function forgetMemory(projectRoot: string, target: string, options: MemoryValidationOptions): Promise<MemoryCommandResult> {
  if (target === '') return unchanged(MEMORY_USAGE);
  return withMemoryStateLock(projectRoot, async () => {
    const read = await readMemoryState(projectRoot);
    if (read.kind === 'invalid') return unchanged(report([scopeLine(projectRoot), `state: corrupt/refused — ${read.problem}`]));
    if (read.kind === 'absent') return unchanged(report([scopeLine(projectRoot), 'state: absent — nothing forgotten']));
    const prior = read.state;
    if (target === 'all') {
      const added = prior.generated.map((entry) => entry.id).filter((id) => !prior.suppressedGeneratedIds.includes(id));
      if (added.length + prior.suppressedGeneratedIds.length > MEMORY_MAX_SUPPRESSIONS) return unchanged('forget all refused: generated suppression limit would be exceeded');
      if (prior.generated.length === 0 && prior.user.length === 0) return unchanged('memory is already empty — nothing forgotten');
      const next: MemoryState = {
        ...prior,
        generated: [],
        user: [],
        suppressedGeneratedIds: [...prior.suppressedGeneratedIds, ...added],
      };
      await writeMemoryState(projectRoot, next);
      return changed(`forgot all project memory entries (${prior.generated.length} generated suppressed, ${prior.user.length} user-authored removed)`, await eligibleState(projectRoot, next, options));
    }
    const entry = resolveEntry(prior, target);
    if (entry === undefined) return unchanged(`${safeTarget(target)} matches no memory entry — nothing forgotten`);
    if (entry.origin === 'generated' && prior.suppressedGeneratedIds.length >= MEMORY_MAX_SUPPRESSIONS) return unchanged('forget refused: generated suppression limit reached');
    const next: MemoryState = entry.origin === 'generated'
      ? { ...prior, generated: prior.generated.filter((candidate) => candidate.id !== entry.id), suppressedGeneratedIds: [...prior.suppressedGeneratedIds, entry.id] }
      : { ...prior, user: prior.user.filter((candidate) => candidate.id !== entry.id) };
    await writeMemoryState(projectRoot, next);
    return changed(`forgot ${entry.id} — ${entry.origin === 'generated' ? 'generated id durably suppressed' : 'user-authored note removed'}`, await eligibleState(projectRoot, next, options));
  });
}

function resolveEntry(state: MemoryState, target: string): MemoryEntry | undefined {
  const all = memoryEntries(state);
  if (/^[1-9]\d*$/.test(target)) return all.slice(0, MEMORY_REPORT_MAX_ENTRIES)[Number(target) - 1];
  if (!isSafeMemoryId(target)) return undefined;
  return all.find((entry) => entry.id === target);
}

async function loadedState(projectRoot: string, options: MemoryValidationOptions): Promise<{ state: MemoryState } | { text: string }> {
  const read = await readMemoryState(projectRoot);
  if (read.kind === 'ready') {
    try {
      return { state: (await validateMemoryState(projectRoot, read.state, options)).state };
    } catch {
      return { text: report([scopeLine(projectRoot), 'state: validation unavailable — generated entries omitted from ambient context']) };
    }
  }
  return { text: report([scopeLine(projectRoot), read.kind === 'absent' ? 'state: absent — no managed memory store' : `state: corrupt/refused — ${read.problem}`]) };
}

async function eligibleState(projectRoot: string, state: MemoryState, options: MemoryValidationOptions): Promise<MemoryState> {
  return (await validateMemoryState(projectRoot, state, options)).eligible;
}

function listLine(entry: MemoryEntry, number: number): string {
  return entry.origin === 'generated'
    ? `  ${number}. ${entry.id} · generated · ${entry.source.session} turn ${entry.source.turn} @ ${entry.source.at} · ${entry.validation.state}: ${entry.validation.reason}`
    : `  ${number}. ${entry.id} · user-authored @ ${entry.authoredAt} · explicit/unvalidated · no expiry · sensitivity ${entry.sensitivity}`;
}

function showLines(entry: MemoryEntry): string[] {
  if (entry.origin === 'user') return [
    `memory ${entry.id}`,
    'origin: user-authored project note',
    `provenance: explicit local /memory remember @ ${entry.authoredAt}`,
    'validation: explicit user context; not code-validated; does not auto-expire',
    `sensitivity: ${entry.sensitivity} (heuristic rejection passed, not a guarantee)`,
    'note:',
    ...entry.note.split('\n').map((line) => `  ${line}`),
  ];
  return [
    `memory ${entry.id}`,
    'origin: generated from durable successful trajectory evidence',
    `provenance: ${entry.source.session} turn ${entry.source.turn}, closing seq ${entry.source.seq}, ${entry.source.at}`,
    `validation: ${entry.validation.state} — ${entry.validation.reason} @ ${entry.validation.checkedAt}`,
    `sensitivity: ${entry.sensitivity} (${entry.omittedCandidates} candidate lines omitted; heuristic, not a guarantee)`,
    `title: ${entry.title}`,
    'anchors:',
    ...entry.anchors.map((anchor, index) => anchor === null
      ? `  ${index + 1}. none (fact excluded from ambient context)`
      : `  ${index + 1}. ${anchor.path}:${anchor.line} · sha256 ${anchor.hash.slice(0, 12)}… · ${anchor.codePoints} code points`),
  ];
}

function changed(text: string, state: MemoryState): MemoryCommandResult {
  return { changed: true, text: report([text, scopeLineFromState()]), index: renderMemoryIndex(state) };
}

function unchanged(text: string): MemoryCommandResult {
  return { changed: false, text: report(text.split('\n')) };
}

function scopeLine(projectRoot: string): string {
  return `project memory scope: ${projectKey(projectRoot)}`;
}

function scopeLineFromState(): string {
  return 'live prompt: refreshed before command completion';
}

function safeTarget(target: string): string {
  return isSafeMemoryId(target) || /^[1-9]\d*$/.test(target) ? target : '(malformed target)';
}

function report(lines: readonly string[]): string {
  return lines.slice(0, MEMORY_REPORT_MAX_LINES).map((line) => {
    const points = [...line];
    return points.length <= MEMORY_REPORT_MAX_LINE_CODE_POINTS ? line : `${points.slice(0, MEMORY_REPORT_MAX_LINE_CODE_POINTS - 1).join('')}…`;
  }).join('\n');
}
