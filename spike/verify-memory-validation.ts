/** Focused offline verification of SER-033 generated-memory validation and expiry. */
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createUserMemoryEntry, emptyMemoryState, readMemoryState, writeMemoryState, type GeneratedMemoryEntry } from '../src/memory/state.js';
import { validateMemoryState, sourceAnchor, MEMORY_HORIZON_MS_PER_DAY, MEMORY_SOURCE_MAX_BYTES } from '../src/memory/validation.js';
import { projectKey, projectMemoryDir } from '../src/paths.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('memory-validation');
const ROOT = path.join(HOME, 'project');
await mkdir(ROOT, { recursive: true });
const at = '2026-08-01T00:00:00.000Z';
const now = new Date(Date.parse(at) + 27 * MEMORY_HORIZON_MS_PER_DAY);

function generated(id: string, pathname: string, line: string, lineNumber = 1): GeneratedMemoryEntry {
  return {
    id, title: `Generated ${id}`, origin: 'generated',
    source: { session: 'session-validation', turn: 1, seq: 3, at },
    facts: [`Fact anchored in ${pathname}`], anchors: [sourceAnchor(pathname, lineNumber, line)],
    omittedCandidates: 0, freshness: 'unvalidated', sensitivity: 'heuristic-filtered',
    validation: { state: 'unknown', reason: 'fixture awaiting validation', checkedAt: at },
  };
}

header('memory validation — exact anchors and user notes share one eligibility projection');
await writeFile(path.join(ROOT, 'valid.ts'), 'const café = "東京";\n');
await writeFile(path.join(ROOT, 'changed.ts'), 'const changed = false;\n');
await writeFile(path.join(ROOT, 'binary.bin'), Buffer.from([0, 1, 2]));
await writeFile(path.join(ROOT, 'large.txt'), Buffer.alloc(MEMORY_SOURCE_MAX_BYTES + 1, 97));
await mkdir(path.join(HOME, 'outside'), { recursive: true });
await writeFile(path.join(HOME, 'outside', 'secret.ts'), 'do not read\n');
await symlink(path.join(HOME, 'outside', 'secret.ts'), path.join(ROOT, 'escape.ts'));
await writeFile(path.join(ROOT, 'unreadable.ts'), 'const unreadable = true;\n');
await chmod(path.join(ROOT, 'unreadable.ts'), 0o000);

const state = {
  ...emptyMemoryState(projectKey(ROOT)),
  generated: [
    generated('valid', 'valid.ts', 'const café = "東京";'),
    generated('changed', 'changed.ts', 'const changed = true;'),
    generated('deleted', 'deleted.ts', 'const deleted = true;'),
    { ...generated('unknown', 'valid.ts', 'const café = "東京";'), anchors: [null] },
    generated('escape', 'escape.ts', 'do not read'),
    generated('binary', 'binary.bin', '\u0000\u0001\u0002'),
    generated('large', 'large.txt', 'a'),
    generated('unreadable', 'unreadable.ts', 'const unreadable = true;'),
  ],
  user: [createUserMemoryEntry('Explicit user note survives validation and age.', new Date('2020-01-01T00:00:00.000Z'))],
};
await writeMemoryState(ROOT, state);
const sourceBefore = new Map<string, Buffer>();
for (const file of ['valid.ts', 'changed.ts', 'binary.bin', 'large.txt']) sourceBefore.set(file, await readFile(path.join(ROOT, file)));
const checked = await validateMemoryState(ROOT, state, { horizonDays: 28, now: () => now });
assert('only exact current generated evidence enters ambient context', checked.index.includes('Generated valid') && !checked.index.includes('Generated changed') && checked.eligible.generated.length === 1);
assert('Unicode exact evidence remains valid', checked.state.generated.find((entry) => entry.id === 'valid')?.validation.state === 'valid');
assert('changed and deleted evidence are invalid with exact reasons', checked.state.generated.find((entry) => entry.id === 'changed')?.validation.reason.includes('changed') === true && checked.state.generated.find((entry) => entry.id === 'deleted')?.validation.reason.includes('deleted') === true);
assert('unanchored, binary, oversized and unreadable evidence fail closed as unknown', ['unknown', 'binary', 'large', 'unreadable'].every((id) => checked.state.generated.find((entry) => entry.id === id)?.validation.state === 'unknown'));
assert('symlink escape is invalid and source content is not reported', checked.state.generated.find((entry) => entry.id === 'escape')?.validation.state === 'invalid' && !checked.index.includes('do not read'));
assert('explicit old user notes remain eligible without validation or expiry', checked.index.includes('Explicit user note survives validation and age.'));
for (const [file, bytes] of sourceBefore) assert(`${file} stays byte-identical`, Buffer.compare(bytes, await readFile(path.join(ROOT, file))) === 0);

header('memory validation — exact horizon boundary and reactivation are deterministic');
const beforeBoundary = await validateMemoryState(ROOT, state, { horizonDays: 28, now: () => new Date(Date.parse(at) + 28 * MEMORY_HORIZON_MS_PER_DAY - 1), persist: false });
const atBoundary = await validateMemoryState(ROOT, state, { horizonDays: 28, now: () => new Date(Date.parse(at) + 28 * MEMORY_HORIZON_MS_PER_DAY), persist: false });
assert('one millisecond before the horizon remains eligible', beforeBoundary.state.generated.find((entry) => entry.id === 'valid')?.validation.state === 'valid');
assert('the exact horizon boundary is expired and omitted', atBoundary.state.generated.every((entry) => entry.validation.state === 'expired') && atBoundary.eligible.generated.length === 0);
const noExpiry = await validateMemoryState(ROOT, state, { horizonDays: 0, now: () => new Date('2036-01-01T00:00:00.000Z'), persist: false });
assert('0 disables age expiry but keeps exact validation', noExpiry.state.generated.find((entry) => entry.id === 'valid')?.validation.state === 'valid' && noExpiry.state.generated.find((entry) => entry.id === 'changed')?.validation.state === 'invalid');
await writeFile(path.join(ROOT, 'changed.ts'), 'const changed = true;\n');
const reactivated = await validateMemoryState(ROOT, state, { horizonDays: 28, now: () => now });
assert('restoring exact non-expired source reactivates the generated entry', reactivated.state.generated.find((entry) => entry.id === 'changed')?.validation.state === 'valid' && reactivated.index.includes('Generated changed'));
const persisted = await readMemoryState(ROOT);
assert('validation state and reason persist for management audit', persisted.kind === 'ready' && persisted.state.generated.every((entry) => entry.validation.checkedAt === now.toISOString()));

await chmod(path.join(ROOT, 'unreadable.ts'), 0o600).catch(() => {});
await rm(projectMemoryDir(ROOT), { recursive: true, force: true });
report();
