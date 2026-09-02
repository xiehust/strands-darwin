/**
 * Focused, network-free contracts for the fileEditor line-diff projection.
 *
 * The bar is SER-009/SER-016 information equivalence: what the diff shows must be
 * exactly recoverable from the marker vocabulary, bounding must stay explicit and
 * single-sourced, and nothing the permission box stated before the diff existed
 * may go unstated after it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { classify } from '../src/agent/permission.js';
import {
  DIFF_ADDED,
  DIFF_CONTEXT,
  DIFF_REMOVED,
  REPLACE_ALL_ROW,
  diffLineEmphasis,
  diffLineTone,
  diffStat,
  emphasisSpans,
  fileEditorDiff,
  fileEditorInputProjection,
  fileEditorReplaceAll,
  formatDiffStat,
  permissionDisplayDetails,
} from '../src/tui/edit-diff.js';
import { permissionDetailRows, toolInputRows } from '../src/tui/frame-budget.js';
import {
  EXPANDED_INPUT_CODE_POINTS,
  EXPANDED_INPUT_LINES,
  PERMISSION_DETAIL_CODE_POINTS,
  PERMISSION_DETAIL_LINES,
  compactEditDiff,
  expandedToolInput,
  permissionDetail,
} from '../src/tui/tool-detail-presentation.js';
import { assert, header, report } from './shared.js';

/** Old value = removals + context, marker stripped. */
const oldOf = (diff: string): string =>
  diff.split('\n').filter((line) => !line.startsWith(DIFF_ADDED)).map((line) => line.slice(2)).join('\n');
/** New value = additions + context, marker stripped. */
const newOf = (diff: string): string =>
  diff.split('\n').filter((line) => !line.startsWith(DIFF_REMOVED)).map((line) => line.slice(2)).join('\n');

const strReplace = (oldStr: string, newStr?: string): Record<string, unknown> => ({
  command: 'str_replace',
  path: '/tmp/example.ts',
  old_str: oldStr,
  ...(newStr === undefined ? {} : { new_str: newStr }),
});

header('edit diff — str_replace markers and ordering');

const basic = fileEditorDiff(strReplace('keep\nold line\nkeep too', 'keep\nnew line\nkeep too'));
assert('a diff is produced for str_replace', basic !== undefined);
assert('unchanged lines are context-marked', basic?.includes(`${DIFF_CONTEXT}keep`) === true);
assert('the removed line carries the minus marker', basic?.includes(`${DIFF_REMOVED}old line`) === true);
assert('the added line carries the plus marker', basic?.includes(`${DIFF_ADDED}new line`) === true);
assert('removal precedes addition within one changed run',
  (basic ?? '').indexOf(`${DIFF_REMOVED}old line`) < (basic ?? '').indexOf(`${DIFF_ADDED}new line`));
assert('markers are plain text that survives ANSI stripping',
  (basic ?? '').split('\n').every((line) => /^([+-] |  )/.test(line)));

header('edit diff — information equivalence on every write shape');

const pairs: [string, string][] = [
  ['old', 'new'],
  ['', 'something'],
  ['multi\nline\nvalue', 'multi\nchanged\nvalue'],
  ['trailing\n', 'trailing\nmore\n'],
  ['emoji 😀 line\nsecond', 'emoji 😀 line\nsecond changed 🎉'],
  ['same', 'same'],
  ['a\nb\nc\nd', 'c\nd\na\nb'],
];
for (const [oldStr, newStr] of pairs) {
  const diff = fileEditorDiff(strReplace(oldStr, newStr));
  assert(`old value is recoverable: ${JSON.stringify(oldStr).slice(0, 40)}`,
    diff !== undefined && oldOf(diff) === oldStr);
  assert(`new value is recoverable: ${JSON.stringify(newStr).slice(0, 40)}`,
    diff !== undefined && newOf(diff) === newStr);
}

const created = fileEditorDiff({ command: 'create', path: '/tmp/new.ts', file_text: 'a\nb\n' });
assert('create is all additions', created === `${DIFF_ADDED}a\n${DIFF_ADDED}b\n${DIFF_ADDED}`);
assert('create content is recoverable', created !== undefined && newOf(created) === 'a\nb\n');

const inserted = fileEditorDiff({ command: 'insert', path: '/tmp/x.ts', insert_line: 3, new_str: 'inserted' });
assert('insert is all additions', inserted === `${DIFF_ADDED}inserted`);

header('edit diff — deletion stays distinguishable from empty replacement');

const deletion = fileEditorDiff(strReplace('doomed line'));
assert('absent new_str yields removals only', deletion === `${DIFF_REMOVED}doomed line`);
const emptied = fileEditorDiff(strReplace('doomed line', ''));
assert('explicit empty new_str yields one empty addition',
  emptied === `${DIFF_REMOVED}doomed line\n${DIFF_ADDED}`);
assert('the two shapes render differently', deletion !== emptied);

header('edit diff — unrecognized inputs fall back, losing nothing');

for (const [name, input] of Object.entries({
  'a read': { command: 'view', path: '/tmp/x.ts' },
  'a missing path': { command: 'create', file_text: 'x' },
  'a wrong field type': { command: 'str_replace', path: '/tmp/x.ts', old_str: 42 },
  'an unexpected extra key': { command: 'create', path: '/tmp/x.ts', file_text: 'x', force: true },
  'a non-object': 'command=create',
  'an array': ['create'],
  'a null input': null,
})) {
  assert(`${name} yields no diff`, fileEditorDiff(input) === undefined);
}

header('edit diff — bounded LCS falls back without losing equivalence');

const bigOld = Array.from({ length: 400 }, (_, i) => `old-${i}`).join('\n');
const bigNew = Array.from({ length: 400 }, (_, i) => `new-${i}`).join('\n');
const bigStart = performance.now();
const bigDiff = fileEditorDiff(strReplace(bigOld, bigNew));
const bigMs = performance.now() - bigStart;
assert('a 400x400 changed middle still recovers both values',
  bigDiff !== undefined && oldOf(bigDiff) === bigOld && newOf(bigDiff) === bigNew);
assert(`the fallback path stays fast (${bigMs.toFixed(1)}ms < 1000ms)`, bigMs < 1_000);

header('edit diff — permission display keeps everything stated');

const editRequest = classify('fileEditor', strReplace('  return n + 2;', '  return n * 2;'));
assert('classify marks exactly the content blocks as edit content',
  editRequest.details.filter((d) => d.editContent === true).map((d) => d.label).join(',') === 'Replace,With');
editRequest.details.push({ label: 'Classifier', value: 'flagged for review' });
const displayed = permissionDisplayDetails(editRequest);
assert('content blocks collapse into one Diff block in place',
  displayed.map((d) => d.label).join(',') === 'Path,Operation,Diff (+1 -1),Classifier');
assert('only the Diff block is toned',
  displayed.filter((d) => d.diff).map((d) => d.label).join(',') === 'Diff (+1 -1)');
assert('the Diff block carries both sides',
  displayed[2]?.value === `${DIFF_REMOVED}  return n + 2;\n${DIFF_ADDED}  return n * 2;`);

const insertRequest = classify('fileEditor', { command: 'insert', path: '/tmp/x.ts', insert_line: 3, new_str: 'x' });
assert('insert keeps its At line block beside the diff',
  permissionDisplayDetails(insertRequest).map((d) => d.label).join(',') === 'Path,Operation,At line,Diff (+1 -0)');

const bashRequest = classify('bash', { command: 'printf -- "- not a diff"' });
assert('non-fileEditor requests pass through untouched',
  permissionDisplayDetails(bashRequest).map((d) => `${d.label}:${String(d.diff)}`).join(',') === 'Command:false');

const odd = classify('fileEditor', { command: 'str_replace', path: '/tmp/x.ts' });
assert('a shape the diff reader rejects keeps its raw blocks',
  permissionDisplayDetails(odd).map((d) => d.label).join(',') === 'Path,Operation,Replace,With');

header('edit diff — bounds are the existing budgets, truncation explicit');

const hugeDiff = fileEditorDiff(strReplace('  return n + 2;', `  return n * 2; // ${'x'.repeat(620)}`));
const boundedDetail = permissionDetail(hugeDiff ?? '');
assert('an oversized diff is explicitly truncated', boundedDetail.at(-1)?.startsWith('… truncated ') === true);
assert('the bounded diff keeps its removal row', boundedDetail[0] === `${DIFF_REMOVED}  return n + 2;`);
assert('detail caps are marker-inclusive',
  boundedDetail.length <= PERMISSION_DETAIL_LINES &&
  [...boundedDetail.join('\n')].length <= PERMISSION_DETAIL_CODE_POINTS);

const unicodeDiff = fileEditorDiff(strReplace('short', `${'u'.repeat(490)}😀${'tail'.repeat(50)}`)) ?? '';
const unicodeBounded = permissionDetail(unicodeDiff).join('\n');
assert('Unicode truncation never splits a code point', !unicodeBounded.includes('\uFFFD'));

header('edit diff — toned rows come from the counted geometry');

const longAdd = fileEditorDiff(strReplace('a', `long ${'word '.repeat(30)}end`)) ?? '';
const tonedRows = permissionDetailRows(longAdd, 40, true);
assert('a wrapped added line keeps its tone on every continuation row',
  tonedRows.filter((row) => row.tone === 'add').length > 1);
assert('the removal row is toned as removal', tonedRows.some((row) => row.tone === 'remove'));
const untonedRows = permissionDetailRows('- looks like a diff', 40, false);
assert('a non-diff block is never toned', untonedRows.every((row) => row.tone === undefined));
assert('tone never changes the counted text',
  permissionDetailRows(longAdd, 40, true).map((row) => row.text).join('\n') ===
  permissionDetailRows(longAdd, 40, false).map((row) => row.text).join('\n'));

assert('the truncation marker row is never toned',
  permissionDetailRows(hugeDiff ?? '', 600, true).every((row) => !(row.text.startsWith('… truncated') && row.tone !== undefined)));
assert('diffLineTone reads a marker-truncated line', diffLineTone('+') === 'add' && diffLineTone('-') === 'remove');
assert('context and prose lines carry no tone',
  diffLineTone('  keep') === undefined && diffLineTone('… truncated 3 code points') === undefined);

header('edit diff — expanded input projection, same seam and caps');

const expanded = expandedToolInput(strReplace('old', 'new'), 'fileEditor');
assert('expanded fileEditor input is the labelled diff projection',
  expanded.join('\n') === `command: str_replace\npath: /tmp/example.ts\n${DIFF_REMOVED}old\n${DIFF_ADDED}new`);
const expandedInsert = expandedToolInput({ command: 'insert', path: '/tmp/x.ts', insert_line: 7, new_str: 'x' }, 'fileEditor');
assert('the insert projection states its line number', expandedInsert.includes('insert line: 7'));
assert('a fileEditor read stays JSON',
  expandedToolInput({ command: 'view', path: '/tmp/x.ts' }, 'fileEditor').join('\n').includes('"command": "view"'));
assert('other tools stay JSON', expandedToolInput({ command: 'ls' }, 'bash').join('\n').includes('"command": "ls"'));
assert('no tool name means the JSON presentation of before', expandedToolInput({ command: 'ls' }).join('\n').includes('"command": "ls"'));

const hugeCreate = { command: 'create', path: '/tmp/big.ts', file_text: Array.from({ length: 300 }, (_, i) => `line-${i}`).join('\n') };
const hugeExpanded = expandedToolInput(hugeCreate, 'fileEditor');
assert('expanded projection keeps the expanded caps',
  hugeExpanded.length <= EXPANDED_INPUT_LINES + 1 && [...hugeExpanded.join('\n')].length <= EXPANDED_INPUT_CODE_POINTS + 80);
assert('expanded truncation is explicit', hugeExpanded.at(-1)?.startsWith('… truncated ') === true);

const activeRows = toolInputRows(strReplace('old', 'new'), 80, 'fileEditor');
assert('active-panel rows carry the same tones',
  activeRows.some((row) => row.tone === 'remove') && activeRows.some((row) => row.tone === 'add'));
assert('active-panel rows for bash stay untoned',
  toolInputRows({ command: '- rm -rf /' }, 80, 'bash').every((row) => row.tone === undefined));

header('edit diff — change stats counted from the same markers');

const statOf = (input: unknown): string => formatDiffStat(diffStat(fileEditorDiff(input) ?? ''));
assert('str_replace counts one removal and one addition', statOf(strReplace('old', 'new')) === '+1 -1');
assert('create counts every added line, trailing empty line included',
  statOf({ command: 'create', path: '/tmp/new.ts', file_text: 'a\nb\n' }) === '+3 -0');
assert('insert counts its added lines',
  statOf({ command: 'insert', path: '/tmp/x.ts', insert_line: 3, new_str: 'a\nb' }) === '+2 -0');
assert('deletion counts removals only', statOf(strReplace('doomed line')) === '+0 -1');
assert('an explicit empty replacement keeps its one empty addition',
  statOf(strReplace('doomed line', '')) === '+1 -1');
assert('context lines never count',
  statOf(strReplace('keep\nold\nkeep too', 'keep\nnew\nkeep too')) === '+1 -1');
assert('an unknown shape has no diff to count', fileEditorDiff({ command: 'view', path: '/x' }) === undefined);
assert('a marker-truncated bare line still counts its tone',
  formatDiffStat(diffStat('- \n+\n-')) === '+1 -2');

header('edit diff — finished-row diff: complete, never truncated');

const wholeExcerpt = compactEditDiff(strReplace('old', 'new'), 'fileEditor');
assert('a small edit is shown whole',
  wholeExcerpt.join('\n') === `${DIFF_REMOVED}old\n${DIFF_ADDED}new`);
assert('nothing withheld states nothing', wholeExcerpt.every((line) => !line.startsWith('…')));
assert('non-fileEditor tools get no excerpt', compactEditDiff({ command: 'ls' }, 'bash').length === 0);
assert('an unrecognized fileEditor shape gets no excerpt',
  compactEditDiff({ command: 'view', path: '/x' }, 'fileEditor').length === 0);
assert('no tool name gets no excerpt', compactEditDiff(strReplace('a', 'b')).length === 0);

const longCreate = compactEditDiff(
  { command: 'create', path: '/tmp/big.ts', file_text: Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n') },
  'fileEditor',
);
assert('a long create is shown complete — every added line present',
  longCreate.length === 40 &&
  longCreate[0] === `${DIFF_ADDED}line-0` && longCreate.at(-1) === `${DIFF_ADDED}line-39`);
assert('a long diff carries no truncation marker',
  longCreate.every((line) => !line.startsWith('… truncated')));

const context = Array.from({ length: 12 }, (_, i) => `ctx-${i}`);
const contextHeavy = compactEditDiff(
  strReplace([...context, 'old middle'].join('\n'), [...context, 'new middle'].join('\n')),
  'fileEditor',
);
assert('leading unchanged context is kept, never skipped',
  contextHeavy[0] === `${DIFF_CONTEXT}ctx-0`);
assert('the change is present in full',
  contextHeavy.includes(`${DIFF_REMOVED}old middle`) && contextHeavy.includes(`${DIFF_ADDED}new middle`));
assert('a context-heavy diff is exactly its own lines',
  contextHeavy.join('\n') === fileEditorDiff(
    strReplace([...context, 'old middle'].join('\n'), [...context, 'new middle'].join('\n'))));

const hugeInput = strReplace('a', `x${'y'.repeat(3_000)}`);
const hugeLine = compactEditDiff(hugeInput, 'fileEditor');
assert('an oversized single line is shown complete, code point for code point',
  hugeLine.join('\n') === fileEditorDiff(hugeInput));
assert('an oversized line carries no truncation marker',
  hugeLine.every((line) => !line.startsWith('… truncated')));

header('edit diff — replace_all: one input-derived row above the same one pair (SER-055)');

const everyInput = { ...strReplace('  return n + 2;', '  return n * 2;'), replace_all: true };
const onceInput = strReplace('  return n + 2;', '  return n * 2;');
const explicitOnce = { ...onceInput, replace_all: false };
const pairDiff = fileEditorDiff(onceInput) ?? '';
assert('the bare diff of a replace_all input is exactly the one pair — no count, no marker',
  fileEditorDiff(everyInput) === pairDiff && pairDiff === `${DIFF_REMOVED}  return n + 2;\n${DIFF_ADDED}  return n * 2;`);
assert('old and new stay recoverable from the markers',
  oldOf(fileEditorDiff(everyInput) ?? '') === '  return n + 2;' && newOf(fileEditorDiff(everyInput) ?? '') === '  return n * 2;');
assert('the +N -N stat is the one pair\'s, never a count of occurrences',
  formatDiffStat(diffStat(fileEditorDiff(everyInput) ?? '')) === '+1 -1');
assert('the reader recognizes replace_all: true and false, and nothing else',
  fileEditorReplaceAll(everyInput) && !fileEditorReplaceAll(explicitOnce) && !fileEditorReplaceAll(onceInput)
    && !fileEditorReplaceAll({ command: 'insert', path: '/tmp/x.ts', insert_line: 1, new_str: 'x' }));
assert('a non-boolean replace_all is an unrecognized shape — raw fallback, nothing lost',
  fileEditorDiff({ ...onceInput, replace_all: 'yes' }) === undefined
    && fileEditorReplaceAll({ ...onceInput, replace_all: 'yes' }) === false);
assert('the expanded projection states the row after the path header, before the diff',
  fileEditorInputProjection(everyInput) === `command: str_replace\npath: /tmp/example.ts\n${REPLACE_ALL_ROW}\n${pairDiff}`);
assert('replace_all: false and absent projections are unchanged and carry no row',
  fileEditorInputProjection(explicitOnce) === fileEditorInputProjection(onceInput)
    && fileEditorInputProjection(onceInput)?.includes(REPLACE_ALL_ROW) === false);
const compactEvery = compactEditDiff(everyInput, 'fileEditor');
assert('the compact finished row is the same row above the bare diff',
  compactEvery.join('\n') === `${REPLACE_ALL_ROW}\n${pairDiff}`);
assert('compact rows without the flag are exactly the bare diff',
  compactEditDiff(onceInput, 'fileEditor').join('\n') === pairDiff
    && compactEditDiff(explicitOnce, 'fileEditor').join('\n') === pairDiff);
assert('the row is a header, not a diff line — no tone, not counted',
  diffLineTone(REPLACE_ALL_ROW) === undefined && formatDiffStat(diffStat(compactEvery.join('\n'))) === '+1 -1');
assert('the active-panel rows carry the same row',
  toolInputRows(everyInput, 80, 'fileEditor').some((row) => row.text === REPLACE_ALL_ROW && row.tone === undefined));

const everyRequest = classify('fileEditor', everyInput);
assert('classification stays a write with the same summary',
  everyRequest.kind === 'write' && everyRequest.summary === 'fileEditor str_replace: /tmp/example.ts'
    && everyRequest.summary === classify('fileEditor', onceInput).summary);
assert('the gate states the scope as its own detail row, before the content blocks',
  everyRequest.details.map((d) => `${d.label}=${d.editContent === true ? 'edit' : d.value}`).join(',')
    === 'Path=/tmp/example.ts,Operation=str_replace,Replace all=every occurrence,Replace=edit,With=edit');
assert('the permission box keeps that row untoned beside the one-pair Diff block',
  permissionDisplayDetails(everyRequest).map((d) => `${d.label}:${String(d.diff)}`).join(',')
    === 'Path:false,Operation:false,Replace all:false,Diff (+1 -1):true');
assert('without the flag the gate\'s details are today\'s',
  classify('fileEditor', onceInput).details.map((d) => d.label).join(',') === 'Path,Operation,Replace,With'
    && classify('fileEditor', explicitOnce).details.map((d) => d.label).join(',') === 'Path,Operation,Replace,With');

const editDiffSource = readFileSync(fileURLToPath(new URL('../src/tui/edit-diff.ts', import.meta.url)), 'utf8');
assert('the diff module still opens no file — no fs import, no read API',
  !/from ['"]node:fs|from ['"]fs['"]|readFile|openSync|createReadStream/.test(editDiffSource));

header('edit diff — intraline emphasis: bold span over the same bytes');

const pairLines = (fileEditorDiff(strReplace('  return n + 2;', '  return n * 2;')) ?? '').split('\n');
const pairRanges = diffLineEmphasis(pairLines);
const removedAt = pairLines.findIndex((line) => line.startsWith(DIFF_REMOVED));
const addedAt = pairLines.findIndex((line) => line.startsWith(DIFF_ADDED));
const removedRange = pairRanges[removedAt];
const addedRange = pairRanges[addedAt];
assert('a replaced pair emphasizes exactly the changed span on the removal',
  removedRange !== undefined && emphasisSpans(pairLines[removedAt] as string, removedRange).mid === '+');
assert('a replaced pair emphasizes exactly the changed span on the addition',
  addedRange !== undefined && emphasisSpans(pairLines[addedAt] as string, addedRange).mid === '*');
assert('emphasis slices reassemble the exact line — the text never changes',
  pairLines.every((line, index) => {
    const range = pairRanges[index];
    if (range === undefined) return true;
    const { pre, mid, post } = emphasisSpans(line, range);
    return `${pre}${mid}${post}` === line;
  }));

const unicodePair = (fileEditorDiff(strReplace('emoji 😀 old span', 'emoji 😀 new😀 span')) ?? '').split('\n');
const unicodeRanges = diffLineEmphasis(unicodePair);
const uniRemoved = unicodeRanges[0];
const uniAdded = unicodeRanges[1];
assert('unicode prefix trim never splits a surrogate pair',
  uniRemoved !== undefined && emphasisSpans(unicodePair[0] as string, uniRemoved).mid === 'old' &&
  uniAdded !== undefined && emphasisSpans(unicodePair[1] as string, uniAdded).mid === 'new😀');

assert('a pair sharing no edge context is unrelated lines, not an intraline edit',
  diffLineEmphasis((fileEditorDiff(strReplace('abc', 'xyz')) ?? '').split('\n'))
    .every((range) => range === undefined));
assert('an unequal changed run is never paired',
  diffLineEmphasis((fileEditorDiff(strReplace('a1\na2', 'b1')) ?? '').split('\n'))
    .every((range) => range === undefined));
const insertion = diffLineEmphasis([`${DIFF_REMOVED}ab`, `${DIFF_ADDED}axb`]);
assert('a pure intraline insertion emphasizes only the added side',
  insertion[0] === undefined && insertion[1] !== undefined &&
  emphasisSpans(`${DIFF_ADDED}axb`, insertion[1]).mid === 'x');
assert('context and marker rows carry no emphasis',
  diffLineEmphasis([`${DIFF_CONTEXT}keep`, '… truncated 3 code points']).every((range) => range === undefined));

header('edit diff — emphasis rides the counted rows');

const emphasisDetail = permissionDetailRows(`${DIFF_REMOVED}alpha old beta\n${DIFF_ADDED}alpha new beta`, 60, true);
const emphasisRemoved = emphasisDetail.find((row) => row.tone === 'remove');
assert('a permission diff row carries its emphasis span',
  emphasisRemoved?.emphasis !== undefined &&
  emphasisRemoved.text.slice(emphasisRemoved.emphasis.start, emphasisRemoved.emphasis.end) === 'old');
assert('a non-diff block never carries emphasis',
  permissionDetailRows('- alpha old beta\n+ alpha new beta', 60, false).every((row) => row.emphasis === undefined));

const wrappedPair = `${DIFF_REMOVED}${'a'.repeat(30)}OLD${'b'.repeat(30)}\n${DIFF_ADDED}${'a'.repeat(30)}NEW${'b'.repeat(30)}`;
const wrappedRows = permissionDetailRows(wrappedPair, 40, true);
const wrappedEmphasized = wrappedRows.filter((row) => row.emphasis !== undefined);
assert('a wrapped line intersects its emphasis with exactly the rows that hold it',
  wrappedEmphasized.length === 2 &&
  wrappedEmphasized.every((row) =>
    row.text.slice(row.emphasis?.start, row.emphasis?.end) === (row.tone === 'remove' ? 'OLD' : 'NEW')));
assert('emphasis never changes the counted row text',
  wrappedRows.map((row) => row.text).join('\n') ===
  permissionDetailRows(wrappedPair, 40, false).map((row) => row.text).join('\n'));

const emphasizedActive = toolInputRows(strReplace('  return n + 2;', '  return n * 2;'), 80, 'fileEditor');
assert('active-panel rows carry the same emphasis',
  emphasizedActive.some((row) => row.tone === 'add' &&
    row.emphasis !== undefined && row.text.slice(row.emphasis.start, row.emphasis.end) === '*'));
assert('active-panel bash rows never carry emphasis',
  toolInputRows({ command: '- rm -rf /' }, 80, 'bash').every((row) => row.emphasis === undefined));

report();
