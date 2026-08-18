/** Focused, network-free checks for the busy rows' live suffix projection (SER-022). */
import type { UsageBuckets } from '../src/agent/usage.js';
import { busySuffix, formatTokenCount } from '../src/tui/busy-suffix.js';
import { assert, header, report } from './shared.js';

header('busy-row live suffix');

assert('small counts are exact', formatTokenCount(0) === '0' && formatTokenCount(999) === '999');
assert('thousands are compact with one decimal', formatTokenCount(1_234) === '1.2k' && formatTokenCount(12_345) === '12.3k');
assert('a whole number of thousands drops the decimal', formatTokenCount(12_000) === '12k');
assert('floating point cannot floor a tenth away', formatTokenCount(2_900) === '2.9k');
assert('the decimal never rounds a count into the next unit', formatTokenCount(999_999) === '999.9k');
assert('millions scale the same way', formatTokenCount(1_234_567) === '1.2M' && formatTokenCount(2_000_000) === '2M');
assert('a negative or non-finite count degrades to zero, never NaN', formatTokenCount(-5) === '0' && formatTokenCount(Number.NaN) === '0');

const spend = (input: number | undefined, output: number): UsageBuckets =>
  ({ input, output, cacheRead: undefined, cacheWrite: undefined });

assert(
  'the full suffix states elapsed time and both directions',
  busySuffix(12_000, spend(1_234, 318)) === ' · 12s · ↑1.2k ↓318 tokens',
);
assert(
  'elapsed time uses the compact task-duration units',
  busySuffix(65_000, spend(0, 0)).startsWith(' · 1m 5s'),
);
// The usageBuckets honesty rule: an unreported metric is absent, never rendered as 0 —
// while a genuinely zero accumulator is a measured nothing and is shown.
assert(
  'an unknown input bucket is absent from the suffix, never zero',
  busySuffix(12_000, spend(undefined, 318)) === ' · 12s · ↓318 tokens',
);
assert(
  'a zero accumulator is a measured nothing and is shown',
  busySuffix(1_000, spend(0, 0)) === ' · 1s · ↑0 ↓0 tokens',
);
assert('an unreadable meter degrades to elapsed only', busySuffix(12_000, undefined) === ' · 12s');
// The suffix rides rows drawn as one `<Text wrap="truncate-end">`, so its bound is a
// character budget, not a wrap count: even the widest realistic reading stays one row
// on the narrow terminals the pty suites use.
assert(
  'the widest realistic suffix stays short enough for a narrow row',
  [...busySuffix(3_600_000 * 9, spend(999_999_999, 999_999_999))].length <= 40,
);
report();
