/** Focused, network-free checks for the busy rows' live suffix projection (SER-022, SER-067). */
import { describeRetryWait, type RetryWaitState } from '../src/agent/model-retry.js';
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

header('busy-row live suffix — model-retry wait phrase (SER-067)');
// The runtime's frozen wait state: attempt 2 failed, so the phrase names attempt 3 —
// the call about to be made — and derives the seconds left from `until` against `now`.
const NOW = 1_700_000_000_000;
const waiting = (attempt: number, maxAttempts: number, remainingMs: number): RetryWaitState =>
  Object.freeze({ attempt, maxAttempts, waitMs: 30_000, until: NOW + remainingMs, reason: 'ModelThrottledError: Rate exceeded' });
assert(
  'a pending wait appends one fixed phrase after the full suffix',
  busySuffix(12_000, spend(1_234, 318), waiting(2, 6, 12_000), NOW) ===
    ' · 12s · ↑1.2k ↓318 tokens · throttled, retry 3/6 in 12s',
);
assert(
  'the reduced elapsed-only row carries the same phrase',
  busySuffix(12_000, undefined, waiting(1, 6, 4_000), NOW) === ' · 12s · throttled, retry 2/6 in 4s',
);
assert(
  'the phrase matches the shared describeRetryWait projection exactly',
  busySuffix(1_000, undefined, waiting(4, 6, 900), NOW) === ` · 1s · ${describeRetryWait(waiting(4, 6, 900), NOW)}`,
);
assert(
  'a fraction of a second left rounds up, never down to a premature 0s',
  busySuffix(1_000, undefined, waiting(1, 6, 900), NOW).endsWith('in 1s'),
);
assert(
  'a deadline already passed is floored at 0s, never negative',
  busySuffix(1_000, undefined, waiting(1, 6, -2_500), NOW).endsWith('in 0s') &&
    !busySuffix(1_000, undefined, waiting(1, 6, -2_500), NOW).includes('-'),
);
assert(
  'no wait (undefined) leaves every existing suffix byte-identical',
  busySuffix(12_000, spend(1_234, 318), undefined, NOW) === ' · 12s · ↑1.2k ↓318 tokens' &&
    busySuffix(12_000, undefined, undefined, NOW) === ' · 12s' &&
    busySuffix(12_000, spend(undefined, 318)) === ' · 12s · ↓318 tokens',
);
assert(
  'the provider reason never reaches the row',
  !busySuffix(1_000, undefined, waiting(1, 6, 4_000), NOW).includes('Rate exceeded'),
);
assert(
  'the widest suffix with the phrase still fits one narrow row',
  [...busySuffix(3_600_000 * 9, spend(999_999_999, 999_999_999), waiting(5, 6, 240_000), NOW)].length <= 72,
);
report();
