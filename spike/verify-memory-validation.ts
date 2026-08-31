/** Focused offline verification of v3 atomic memory state and evidence. */
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emptyMemoryState, generatedMemoryId, migrateLegacyState, quoteHash, readMemoryState, writeMemoryState, type GeneratedMemoryEntry } from '../src/memory/state.js';
import { validateMemoryState, resolveExactSourceAnchor, sourceAnchor, MEMORY_HORIZON_MS_PER_DAY, MEMORY_SOURCE_MAX_BYTES } from '../src/memory/validation.js';
import { projectKey, projectMemoryDir } from '../src/paths.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
const HOME = ownPrivateHome('memory-validation'); const ROOT = path.join(HOME, 'project'); await mkdir(ROOT, { recursive: true }); const at = '2026-08-01T00:00:00.000Z';
function generated(key: string, pathname: string, line: string, lineNumber = 1): GeneratedMemoryEntry { const fact = `Fact anchored in ${pathname}`; return { id: generatedMemoryId(key, fact), key, category: 'convention', title: `Generated ${key}`, fact, origin: 'generated', source: { session: 'session-validation', turn: 1, seq: 3, at }, evidence: { kind: 'project', anchor: sourceAnchor(pathname, lineNumber, line) }, validation: { state: 'unknown', reason: 'fixture awaiting validation', checkedAt: at } }; }
header('memory validation — exact current evidence and expiry');
await writeFile(path.join(ROOT, 'valid.ts'), 'const café = "東京";\n'); await writeFile(path.join(ROOT, 'changed.ts'), 'const changed = false;\n'); await writeFile(path.join(ROOT, 'binary.bin'), Buffer.from([0, 1, 2])); await writeFile(path.join(ROOT, 'large.txt'), Buffer.alloc(MEMORY_SOURCE_MAX_BYTES + 1, 97)); await mkdir(path.join(HOME, 'outside'), { recursive: true }); await writeFile(path.join(HOME, 'outside', 'secret.ts'), 'do not read\n'); await symlink(path.join(HOME, 'outside', 'secret.ts'), path.join(ROOT, 'escape.ts')); await writeFile(path.join(ROOT, 'unreadable.ts'), 'const unreadable = true;\n'); await chmod(path.join(ROOT, 'unreadable.ts'), 0o000);
const userFact = 'The user prefers concise progress updates.'; const userKey = 'preference:progress';
const state = { ...emptyMemoryState(projectKey(ROOT)), generated: [generated('convention:valid', 'valid.ts', 'const café = "東京";'), generated('convention:changed', 'changed.ts', 'const changed = true;'), generated('convention:deleted', 'deleted.ts', 'const deleted = true;'), generated('convention:escape', 'escape.ts', 'do not read'), generated('convention:binary', 'binary.bin', '\x00\x01\x02'), generated('convention:large', 'large.txt', 'a'), generated('convention:unreadable', 'unreadable.ts', 'const unreadable = true;'), { id: generatedMemoryId(userKey, userFact), key: userKey, category: 'preference' as const, title: 'Progress preference', fact: userFact, origin: 'generated' as const, source: { session: 'session-validation', turn: 1, seq: 3, at }, evidence: { kind: 'userInput' as const, quoteHash: quoteHash('Please keep progress concise.'), codePoints: 28 }, validation: { state: 'unknown' as const, reason: 'fixture', checkedAt: at } }] };
await writeMemoryState(ROOT, state); const before = await readFile(path.join(ROOT, 'valid.ts')); const now = new Date(Date.parse(at) + 27 * MEMORY_HORIZON_MS_PER_DAY); const checked = await validateMemoryState(ROOT, state, { horizonDays: 28, now: () => now, persist: false });
assert('only exact current project evidence and host-verified user-input evidence are eligible', checked.eligible.generated.some((entry) => entry.key === 'convention:valid') && checked.eligible.generated.some((entry) => entry.key === userKey) && checked.eligible.generated.length === 2);
assert('changed/deleted/symlink evidence is invalid', ['convention:changed', 'convention:deleted', 'convention:escape'].every((key) => checked.state.generated.find((entry) => entry.key === key)?.validation.state === 'invalid'));
assert('binary/large/unreadable evidence fails closed', ['convention:binary', 'convention:large', 'convention:unreadable'].every((key) => checked.state.generated.find((entry) => entry.key === key)?.validation.state === 'unknown'));
assert('source remains byte-identical', Buffer.compare(before, await readFile(path.join(ROOT, 'valid.ts'))) === 0);
const boundary = await validateMemoryState(ROOT, state, { horizonDays: 28, now: () => new Date(Date.parse(at) + 28 * MEMORY_HORIZON_MS_PER_DAY), persist: false }); assert('exact horizon boundary expires every generated entry', boundary.eligible.generated.length === 0);
const noExpiry = await validateMemoryState(ROOT, state, { horizonDays: 0, now: () => new Date('2036-01-01T00:00:00.000Z'), persist: false }); assert('zero disables age only', noExpiry.eligible.generated.some((entry) => entry.key === 'convention:valid') && noExpiry.state.generated.find((entry) => entry.key === 'convention:changed')?.validation.state === 'invalid');

header('memory resolution — untrimmed exact-line anchoring with specific failure reasons');
await writeFile(path.join(ROOT, 'indent.ts'), 'export function demo() {\n  return true;\n}\n'); await writeFile(path.join(ROOT, 'dup.ts'), '  const twice = 1;\n  const twice = 1;\n');
const indented = await resolveExactSourceAnchor(ROOT, 'indent.ts', '  return true;'); assert('an indented line anchors untrimmed at its exact line', indented.ok && indented.anchor.line === 2 && indented.anchor.codePoints === 14);
const trimmedQuote = await resolveExactSourceAnchor(ROOT, 'indent.ts', 'return true;'); assert('a trimmed variant of an indented line reports no matching line', !trimmedQuote.ok && trimmedQuote.failure === 'no-matching-line');
const multiMatch = await resolveExactSourceAnchor(ROOT, 'dup.ts', '  const twice = 1;'); assert('a duplicated line reports multiple matching lines', !multiMatch.ok && multiMatch.failure === 'multiple-matching-lines');
const multiline = await resolveExactSourceAnchor(ROOT, 'indent.ts', '  return true;\n}'); assert('a multiline quote is refused as not one bounded line', !multiline.ok && multiline.failure === 'quote-not-one-line');
const oversizedSource = await resolveExactSourceAnchor(ROOT, 'large.txt', 'a'); assert('an oversized source file keeps its refusal', !oversizedSource.ok && oversizedSource.failure === 'oversized-source');
const unsafePath = await resolveExactSourceAnchor(ROOT, '../outside/secret.ts', 'do not read'); assert('a path escaping the project keeps its refusal', !unsafePath.ok && unsafePath.failure === 'unsafe-path');
const symlinkPath = await resolveExactSourceAnchor(ROOT, 'escape.ts', 'do not read'); assert('a symlink evidence path keeps its refusal', !symlinkPath.ok && symlinkPath.failure === 'unsafe-path');
const missingFile = await resolveExactSourceAnchor(ROOT, 'missing.ts', 'anything'); assert('a missing evidence file is refused as unreadable', !missingFile.ok && missingFile.failure === 'unreadable-source');


header('memory migration — legacy bounds and suppression stay strict');
const legacyBase = {
  version: 2,
  projectKey: projectKey(ROOT),
  generated: [{
    id: 'legacy-topic',
    title: 'Legacy topic',
    source: { session: 'session-legacy', turn: 1, seq: 3, at },
    facts: ['Legacy anchored fact'],
    anchors: [sourceAnchor('valid.ts', 1, 'const café = "東京";')],
    omittedCandidates: 0,
    origin: 'generated',
    freshness: 'unvalidated',
    sensitivity: 'heuristic-filtered',
    validation: { state: 'valid', reason: 'legacy metadata is not trusted', checkedAt: at },
  }],
  user: [],
  suppressedGeneratedIds: [],
  skipped: 0,
};
assert('legacy topic atomizes into one unknown v3 entry with lineage', (() => {
  const migrated = migrateLegacyState(legacyBase);
  return migrated?.generated.length === 1 &&
    migrated.generated[0]?.validation.state === 'unknown' &&
    migrated.generated[0]?.legacyIds?.[0] === 'legacy-topic';
})());
assert('suppressing a legacy topic suppresses every migrated atomic fact',
  migrateLegacyState({ ...legacyBase, suppressedGeneratedIds: ['legacy-topic'] })?.generated.length === 0);
assert('legacy duplicate suppression ids are rejected',
  migrateLegacyState({ ...legacyBase, suppressedGeneratedIds: ['legacy-topic', 'legacy-topic'] }) === undefined);
assert('legacy per-topic fact overflow is rejected before atomization',
  migrateLegacyState({
    ...legacyBase,
    generated: [{ ...legacyBase.generated[0], facts: Array(9).fill('fact'), anchors: Array(9).fill(sourceAnchor('valid.ts', 1, 'const café = "東京";')) }],
  }) === undefined);

header('memory state — strict scope and no-follow path safety'); const persisted = await readMemoryState(ROOT); assert('v3 state round-trips strictly', persisted.kind === 'ready' && !persisted.migrated && persisted.state.generated.length === state.generated.length);
const SYMLINK = path.join(HOME, 'symlink-project'); await mkdir(path.dirname(projectMemoryDir(SYMLINK)), { recursive: true }); await symlink(path.join(HOME, 'outside'), projectMemoryDir(SYMLINK)); assert('memory-directory symlink is refused', (await readMemoryState(SYMLINK)).kind === 'invalid');
await chmod(path.join(ROOT, 'unreadable.ts'), 0o600).catch(() => {}); await rm(HOME, { recursive: true, force: true }); report();
