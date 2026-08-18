/**
 * Focused, network-free contracts for the fileEditor line-diff projection.
 *
 * The bar is SER-009/SER-016 information equivalence: what the diff shows must be
 * exactly recoverable from the marker vocabulary, bounding must stay explicit and
 * single-sourced, and nothing the permission box stated before the diff existed
 * may go unstated after it.
 */
import { classify } from '../src/agent/permission.js';
import {
  DIFF_ADDED,
  DIFF_CONTEXT,
  DIFF_REMOVED,
  diffLineTone,
  fileEditorDiff,
  fileEditorInputProjection,
  permissionDisplayDetails,
} from '../src/tui/edit-diff.js';
import { permissionDetailRows, toolInputRows } from '../src/tui/frame-budget.js';
import {
  EXPANDED_INPUT_CODE_POINTS,
  EXPANDED_INPUT_LINES,
  PERMISSION_DETAIL_CODE_POINTS,
  PERMISSION_DETAIL_LINES,
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
  displayed.map((d) => d.label).join(',') === 'Path,Operation,Diff,Classifier');
assert('only the Diff block is toned', displayed.filter((d) => d.diff).map((d) => d.label).join(',') === 'Diff');
assert('the Diff block carries both sides',
  displayed[2]?.value === `${DIFF_REMOVED}  return n + 2;\n${DIFF_ADDED}  return n * 2;`);

const insertRequest = classify('fileEditor', { command: 'insert', path: '/tmp/x.ts', insert_line: 3, new_str: 'x' });
assert('insert keeps its At line block beside the diff',
  permissionDisplayDetails(insertRequest).map((d) => d.label).join(',') === 'Path,Operation,At line,Diff');

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

report();
