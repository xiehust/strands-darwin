/** Focused, network-free contracts for bounded permission presentation. */
import {
  PERMISSION_DETAIL_CODE_POINTS,
  PERMISSION_DETAIL_LINES,
  PERMISSION_SUMMARY_CODE_POINTS,
  permissionDetail,
  permissionSummary,
} from '../src/tui/tool-detail-presentation.js';
import { assert, header, report } from './shared.js';

header('permission presentation — unchanged short values');

for (const value of ['', '   ', '\t\t', 'short', 'alpha\nbeta', '  indented  \n\n tail ']) {
  assert(`short detail is unchanged: ${JSON.stringify(value)}`, permissionDetail(value).join('\n') === value);
}
assert('short summary is unchanged', permissionSummary('bash: printf ok') === 'bash: printf ok');

header('permission presentation — independent bounds');

const huge = 'x'.repeat(PERMISSION_DETAIL_CODE_POINTS + 200);
const hugeProjection = permissionDetail(huge);
assert('a huge single line is explicitly truncated', hugeProjection.at(-1)?.startsWith('… truncated ') === true);
assert('a huge single line keeps a truthful prefix', huge.startsWith(hugeProjection[0] ?? 'not-a-prefix'));
assert('detail marker is included in the code-point cap', [...hugeProjection.join('\n')].length <= PERMISSION_DETAIL_CODE_POINTS);
assert('detail marker is included in the line cap', hugeProjection.length <= PERMISSION_DETAIL_LINES);
assert('single-line omission reports code points but no omitted lines',
  /… truncated \d+ code points$/.test(hugeProjection.at(-1) ?? ''));

const many = Array.from({ length: PERMISSION_DETAIL_LINES + 9 }, (_, index) => `line-${index}`).join('\n');
const manyProjection = permissionDetail(many);
assert('many lines keep their source-order prefix', manyProjection[0] === 'line-0');
assert('many lines reserve a row for the marker', manyProjection.length === PERMISSION_DETAIL_LINES);
assert('many lines state both omitted code points and lines',
  /… truncated \d+ code points and 10 lines$/.test(manyProjection.at(-1) ?? ''));

const composed = `${'a'.repeat(PERMISSION_DETAIL_CODE_POINTS)}\n${many}`;
const composedProjection = permissionDetail(composed);
assert('line and code-point caps compose',
  composedProjection.length <= PERMISSION_DETAIL_LINES &&
  [...composedProjection.join('\n')].length <= PERMISSION_DETAIL_CODE_POINTS &&
  /code points and \d+ lines$/.test(composedProjection.at(-1) ?? ''));

header('permission presentation — Unicode and summaries');

const unicode = `${'u'.repeat(471)}😀${'tail'.repeat(100)}`;
const unicodeLines = permissionDetail(unicode);
const unicodeProjection = unicodeLines.join('\n');
assert('Unicode truncation never creates a replacement character', !unicodeProjection.includes('\uFFFD'));
assert('Unicode truncation keeps the complete boundary emoji', unicodeLines[0]?.endsWith('😀') === true);

const longSummary = `bash: ${'s'.repeat(PERMISSION_SUMMARY_CODE_POINTS + 100)}\nspoofed second line`;
const summaryProjection = permissionSummary(longSummary);
assert('summary is one logical line', !summaryProjection.includes('\n'));
assert('summary is marker-inclusive bounded', [...summaryProjection].length <= PERMISSION_SUMMARY_CODE_POINTS);
assert('summary keeps its truthful prefix', summaryProjection.startsWith('bash: sssss'));
assert('summary states omitted code points and lines', /… truncated \d+ code points and 1 line$/.test(summaryProjection));
assert('summary omits the later line', !summaryProjection.includes('spoofed'));

report();
