import { projectKey } from '../paths.js';
import {
  MEMORY_MAX_SUPPRESSIONS,
  MEMORY_MAX_USER_NOTES,
  createUserMemoryEntry,
  emptyMemoryState,
  isSafeMemoryId,
  memoryEntries,
  readMemoryState,
  renderMemoryIndex,
  validateRememberedNote,
  withMemoryStateLock,
  writeMemoryProjection,
  writeMemoryState,
  type MemoryEntry,
  type MemoryState,
} from './state.js';
import { validateMemoryState, type MemoryValidationOptions } from './validation.js';

export const MEMORY_REPORT_MAX_LINES = 48;
export const MEMORY_REPORT_MAX_LINE_CODE_POINTS = 180;
export const MEMORY_REPORT_MAX_ENTRIES = 32;
export const MEMORY_USAGE = 'usage: /memory [list] · /memory show <id|number> · /memory forget <id|number|all> · /memory remember <note>';

export type MemoryCommandResult = {
  readonly changed: boolean;
  readonly text: string;
  readonly index?: string;
};

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

async function listMemory(
  projectRoot: string,
  options: MemoryValidationOptions,
): Promise<MemoryCommandResult> {
  const loaded = await loadedState(projectRoot, options);
  if ('text' in loaded) return unchanged(loaded.text);
  const all = memoryEntries(loaded.state);
  const entries = all.slice(0, MEMORY_REPORT_MAX_ENTRIES);
  const lines = [scopeLine(projectRoot), `entries: ${entries.length}/${all.length}`];
  if (entries.length === 0) lines.push('  (empty)');
  entries.forEach((entry, index) => lines.push(listLine(entry, index + 1)));
  lines.push(
    `generated horizon: ${options.horizonDays === 0 ? 'disabled (source validation remains required)' : `${options.horizonDays} days`}`,
    `suppressed generated ids: ${loaded.state.suppressedGeneratedIds.length}/${MEMORY_MAX_SUPPRESSIONS}`,
    `  ${MEMORY_USAGE}`,
  );
  return { changed: false, text: report(lines), index: renderMemoryIndex(loaded.eligible) };
}

async function showMemory(
  projectRoot: string,
  target: string,
  options: MemoryValidationOptions,
): Promise<MemoryCommandResult> {
  if (target === '') return unchanged(MEMORY_USAGE);
  const loaded = await loadedState(projectRoot, options);
  if ('text' in loaded) return unchanged(loaded.text);
  const entry = resolveEntry(loaded.state, target);
  return entry === undefined
    ? unchanged(report([
        scopeLine(projectRoot),
        `${safeTarget(target)} matches no memory entry — nothing shown`,
        `  ${MEMORY_USAGE}`,
      ]))
    : unchanged(report(showLines(entry)));
}

async function rememberMemory(
  projectRoot: string,
  raw: string,
  options: MemoryValidationOptions,
): Promise<MemoryCommandResult> {
  const note = validateRememberedNote(raw);
  if (note === undefined) {
    return unchanged(report([
      'memory note refused: expected bounded non-sensitive project context without prompt boundaries, policy-like instructions, controls, or dump text',
      `  ${MEMORY_USAGE}`,
    ]));
  }

  return withMemoryStateLock(projectRoot, async () => {
    const read = await readMemoryState(projectRoot);
    if (read.kind === 'invalid') {
      return unchanged(report([scopeLine(projectRoot), `state: corrupt/refused — ${read.problem}`]));
    }
    let prior: MemoryState;
    try {
      prior = read.kind === 'ready'
        ? await stateForAuthorizedMutation(projectRoot, read.state, read.migrated, options)
        : emptyMemoryState(projectKey(projectRoot));
    } catch {
      return unchanged(report([
        scopeLine(projectRoot),
        'state: validation unavailable — mutation refused',
      ]));
    }
    if (prior.user.length >= MEMORY_MAX_USER_NOTES) {
      return unchanged(`memory note refused: user note limit ${MEMORY_MAX_USER_NOTES} reached`);
    }
    const duplicate = prior.user.find((entry) => entry.note === note);
    if (duplicate !== undefined) return unchanged(`memory note already exists as ${duplicate.id}`);

    const entry = createUserMemoryEntry(note);
    const next = { ...prior, user: [...prior.user, entry] };
    return persistMutation(
      projectRoot,
      next,
      `remembered project memory ${entry.id} — user-authored; explicit/unvalidated`,
    );
  });
}

async function forgetMemory(
  projectRoot: string,
  target: string,
  options: MemoryValidationOptions,
): Promise<MemoryCommandResult> {
  if (target === '') return unchanged(MEMORY_USAGE);
  return withMemoryStateLock(projectRoot, async () => {
    const read = await readMemoryState(projectRoot);
    if (read.kind === 'invalid') {
      return unchanged(report([scopeLine(projectRoot), `state: corrupt/refused — ${read.problem}`]));
    }
    if (read.kind === 'absent') {
      return unchanged(report([scopeLine(projectRoot), 'state: absent — nothing forgotten']));
    }
    let prior: MemoryState;
    try {
      prior = await stateForAuthorizedMutation(projectRoot, read.state, read.migrated, options);
    } catch {
      return unchanged(report([
        scopeLine(projectRoot),
        'state: validation unavailable — mutation refused',
      ]));
    }

    if (target === 'all') {
      const added = prior.generated
        .flatMap((entry) => [entry.id, ...(entry.legacyIds ?? [])])
        .filter((id) => !prior.suppressedGeneratedIds.includes(id));
      const suppressions = [...new Set([...prior.suppressedGeneratedIds, ...added])];
      if (suppressions.length > MEMORY_MAX_SUPPRESSIONS) {
        return unchanged('forget all refused: generated suppression limit would be exceeded');
      }
      if (prior.generated.length === 0 && prior.user.length === 0) {
        return unchanged('memory is already empty — nothing forgotten');
      }
      const next = { ...prior, generated: [], user: [], suppressedGeneratedIds: suppressions };
      return persistMutation(
        projectRoot,
        next,
        `forgot all project memory entries (${prior.generated.length} generated suppressed, ${prior.user.length} user-authored removed)`,
      );
    }

    const entry = resolveEntry(prior, target);
    if (entry === undefined) return unchanged(`${safeTarget(target)} matches no memory entry — nothing forgotten`);
    const added = entry.origin === 'generated' ? [entry.id, ...(entry.legacyIds ?? [])] : [];
    const suppressions = [...new Set([...prior.suppressedGeneratedIds, ...added])];
    if (suppressions.length > MEMORY_MAX_SUPPRESSIONS) {
      return unchanged('forget refused: generated suppression limit reached');
    }
    const next = entry.origin === 'generated'
      ? {
          ...prior,
          generated: prior.generated.filter((candidate) => candidate.id !== entry.id),
          suppressedGeneratedIds: suppressions,
        }
      : { ...prior, user: prior.user.filter((candidate) => candidate.id !== entry.id) };
    return persistMutation(
      projectRoot,
      next,
      `forgot ${entry.id} — ${entry.origin === 'generated' ? 'generated id durably suppressed' : 'user-authored note removed'}`,
    );
  });
}

async function persistMutation(
  root: string,
  state: MemoryState,
  successText: string,
): Promise<MemoryCommandResult> {
  // The strict JSON is authoritative. A projection failure after it commits is
  // reported honestly instead of claiming the whole mutation failed or rolling
  // authoritative state back to stale bytes.
  await writeMemoryState(root, state);
  try {
    await writeMemoryProjection(root, state);
    return changed(successText, state);
  } catch (error) {
    return changed(
      `${successText}; index projection degraded — ${boundedProblem(error)}`,
      state,
    );
  }
}

async function stateForAuthorizedMutation(
  projectRoot: string,
  state: MemoryState,
  migrated: boolean,
  options: MemoryValidationOptions,
): Promise<MemoryState> {
  if (!migrated) return state;
  // Legacy generated validation metadata is not authority. The first explicit
  // mutation upgrades only entries whose exact anchors still validate and whose
  // age remains eligible; user notes and suppression ids are retained.
  return (await validateMemoryState(projectRoot, state, {
    ...options,
    persist: false,
  })).eligible;
}

function resolveEntry(state: MemoryState, target: string): MemoryEntry | undefined {
  const all = memoryEntries(state);
  if (/^[1-9]\d*$/.test(target)) {
    return all.slice(0, MEMORY_REPORT_MAX_ENTRIES)[Number(target) - 1];
  }
  return isSafeMemoryId(target) ? all.find((entry) => entry.id === target) : undefined;
}

async function loadedState(
  projectRoot: string,
  options: MemoryValidationOptions,
): Promise<{ state: MemoryState; eligible: MemoryState } | { text: string }> {
  const read = await readMemoryState(projectRoot);
  if (read.kind === 'ready') {
    try {
      const validated = await validateMemoryState(projectRoot, read.state, {
        ...options,
        persist: false,
      });
      return { state: validated.state, eligible: validated.eligible };
    } catch {
      return { text: report([scopeLine(projectRoot), 'state: validation unavailable — generated entries omitted']) };
    }
  }
  return {
    text: report([
      scopeLine(projectRoot),
      read.kind === 'absent'
        ? 'state: absent — no managed memory store'
        : `state: corrupt/refused — ${read.problem}`,
    ]),
  };
}

function listLine(entry: MemoryEntry, number: number): string {
  return entry.origin === 'generated'
    ? `  ${number}. ${entry.id} · generated · ${entry.category} · ${entry.source.session} turn ${entry.source.turn} · ${entry.validation.state}: ${entry.validation.reason}`
    : `  ${number}. ${entry.id} · user-authored @ ${entry.authoredAt} · explicit/unvalidated · no expiry`;
}

function showLines(entry: MemoryEntry): string[] {
  if (entry.origin === 'user') {
    return [
      `memory ${entry.id}`,
      'origin: user-authored project note',
      `provenance: explicit local /memory remember @ ${entry.authoredAt}`,
      'validation: explicit user context; not code-validated; does not auto-expire',
      'note:',
      ...entry.note.split('\n').map((line) => `  ${line}`),
    ];
  }
  return [
    `memory ${entry.id}`,
    `origin: generated ${entry.category}`,
    `key: ${entry.key}`,
    `provenance: ${entry.source.session} turn ${entry.source.turn}, closing seq ${entry.source.seq}, ${entry.source.at}`,
    `validation: ${entry.validation.state} — ${entry.validation.reason} @ ${entry.validation.checkedAt}`,
    `title: ${entry.title}`,
    `fact: ${entry.fact}`,
    entry.evidence.kind === 'project'
      ? `evidence: ${entry.evidence.anchor.path}:${entry.evidence.anchor.line} · sha256 ${entry.evidence.anchor.hash.slice(0, 12)}…`
      : `evidence: exact user-input quote hash ${entry.evidence.quoteHash.slice(0, 12)}…`,
  ];
}

function changed(text: string, state: MemoryState): MemoryCommandResult {
  return {
    changed: true,
    text: report([text, 'authoritative state updated']),
    index: renderMemoryIndex(state),
  };
}

function unchanged(text: string): MemoryCommandResult {
  return { changed: false, text: report(text.split('\n')) };
}

function scopeLine(projectRoot: string): string {
  return `project memory scope: ${projectKey(projectRoot)}`;
}

function safeTarget(target: string): string {
  return isSafeMemoryId(target) || /^[1-9]\d*$/.test(target) ? target : '(malformed target)';
}

function report(lines: readonly string[]): string {
  return lines.slice(0, MEMORY_REPORT_MAX_LINES).map((line) => {
    const points = [...line];
    return points.length <= MEMORY_REPORT_MAX_LINE_CODE_POINTS
      ? line
      : `${points.slice(0, MEMORY_REPORT_MAX_LINE_CODE_POINTS - 1).join('')}…`;
  }).join('\n');
}

function boundedProblem(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim() || 'projection write failed';
  const points = [...text];
  return points.length <= 120 ? text : `${points.slice(0, 119).join('')}…`;
}
