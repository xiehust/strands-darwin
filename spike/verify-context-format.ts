/** Pure formatting contracts for the /context report. No model, no network. */
import { createContextWarnLatch, formatContextReport, formatContextValue, formatWindowShare } from '../src/tui/context-format.js';
import { initialTurnState, turnReducer, type TurnState } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

header('/context — window share');
assert('a plain share rounds to an integer percent',
  formatWindowShare(34_000, 1_000_000) === '3%');
assert('rounding is to the nearest percent, not truncation',
  formatWindowShare(25_000, 1_000_000) === '3%' && formatWindowShare(24_000, 1_000_000) === '2%');
assert('a nonzero share below one percent says <1%, never 0%',
  formatWindowShare(500, 1_000_000) === '<1%');
assert('an actually empty context is 0%', formatWindowShare(0, 1_000_000) === '0%');
assert('overflow is stated, not clamped', formatWindowShare(250_000, 200_000) === '125%');
assert('a nonsense window degrades to words, not division by zero',
  formatWindowShare(10, 0) === 'share unknown' && formatWindowShare(10, -5) === 'share unknown');

header('/context — report line');
assert('a known window renders tokens, share, and messages on one line',
  formatContextReport({ estimatedTokens: 34_000, messageCount: 42, windowTokens: 1_000_000 }) ===
  'estimated context — ~34,000 tokens · 3% of 1,000,000 window · 42 message(s)');
assert('an unknown window is said out loud instead of guessed',
  formatContextReport({ estimatedTokens: 1_234, messageCount: 3, windowTokens: undefined }) ===
  'estimated context — ~1,234 tokens · window unknown · 3 message(s)');
assert('an empty conversation still reports honestly',
  formatContextReport({ estimatedTokens: 0, messageCount: 0, windowTokens: 200_000 }) ===
  'estimated context — ~0 tokens · 0% of 200,000 window · 0 message(s)');

header('/context — report line with a measured base');
assert('a measured base is named, and stops the line calling itself merely estimated',
  formatContextReport({
    estimatedTokens: 128_431,
    messageCount: 84,
    windowTokens: 200_000,
    measuredTokens: 126_900,
    tailTokens: 1_531,
  }) ===
  'context — ~128,431 tokens (measured 126,900 + ~1,531 new) · 64% of 200,000 window · 84 message(s)');
assert('an empty tail says so rather than hiding the basis',
  formatContextReport({
    estimatedTokens: 126_900,
    messageCount: 12,
    windowTokens: 200_000,
    measuredTokens: 126_900,
    tailTokens: 0,
  }) ===
  'context — ~126,900 tokens (measured 126,900 + ~0 new) · 63% of 200,000 window · 12 message(s)');
assert('a failed tail count keeps the measurement and admits the gap',
  formatContextReport({
    estimatedTokens: 126_900,
    messageCount: 12,
    windowTokens: 200_000,
    measuredTokens: 126_900,
  }) ===
  'context — ~126,900 tokens (measured 126,900 + tail unknown) · 63% of 200,000 window · 12 message(s)');
assert('an unknown window is still said out loud with a measured base',
  formatContextReport({
    estimatedTokens: 5_000,
    messageCount: 4,
    windowTokens: undefined,
    measuredTokens: 4_900,
    tailTokens: 100,
  }) ===
  'context — ~5,000 tokens (measured 4,900 + ~100 new) · window unknown · 4 message(s)');
// The measured base is a basis, not a second total: the share and the token figure
// are still computed from `estimatedTokens` alone.
assert('the window share follows the total, not the measured part',
  formatContextValue({
    estimatedTokens: 160_000,
    messageCount: 9,
    windowTokens: 200_000,
    measuredTokens: 100_000,
    tailTokens: 60_000,
  }).includes('80% of 200,000 window'));

header('/context — pressure notice latch');
const KNOWN_WINDOW = 1_000_000;
const estimate = (estimatedTokens: number, windowTokens: number | undefined = KNOWN_WINDOW) => ({
  estimatedTokens,
  messageCount: 1,
  windowTokens,
});

let latch = createContextWarnLatch();
assert('stays silent below the deliberately high configured threshold',
  latch.check(estimate(799_999), 0.8) === null);
const firstNotice = latch.check(estimate(800_000), 0.8);
assert('fires at the exact configured threshold', firstNotice !== null);
assert('does not fire again while still above the threshold',
  latch.check(estimate(900_000), 0.8) === null);
assert('re-arms after a known estimate drops below the threshold',
  latch.check(estimate(700_000), 0.8) === null);
assert('fires again after re-arming',
  latch.check(estimate(850_000), 0.8) !== null);

latch = createContextWarnLatch();
assert('disabled at warnRatio 0, no matter how large the context',
  latch.check(estimate(999_999), 0) === null);

latch = createContextWarnLatch();
assert('never treats an unknown or invalid estimate as pressure',
  latch.check({ estimatedTokens: 999_999, messageCount: 1, windowTokens: undefined }, 0.8) === null &&
  latch.check(estimate(999_999, 0), 0.8) === null &&
  latch.check(estimate(999_999, -1), 0.8) === null &&
  latch.check(estimate(999_999, Number.NaN), 0.8) === null &&
  latch.check(estimate(Number.NaN), 0.8) === null &&
  latch.check(estimate(-1), 0.8) === null);

latch = createContextWarnLatch();
assert('an unknown estimate cannot dishonestly re-arm an already crossed latch',
  latch.check(estimate(800_000), 0.8) !== null &&
  latch.check({ estimatedTokens: 1, messageCount: 1, windowTokens: undefined }, 0.8) === null &&
  latch.check(estimate(900_000), 0.8) === null);

latch = createContextWarnLatch();
assert('a custom high threshold remains authoritative',
  latch.check(estimate(850_000), 0.9) === null && latch.check(estimate(900_000), 0.9) !== null);
assert('a fresh session latch may warn independently',
  createContextWarnLatch().check(estimate(900_000), 0.9) !== null);

assert('notice is one bounded line with the pressure, percent, /compact, and next broad-turn guidance',
  firstNotice !== null &&
  firstNotice.length <= 160 &&
  !firstNotice.includes('\n') &&
  firstNotice.includes('context pressure is high') &&
  firstNotice.includes('80%') &&
  firstNotice.includes('/compact') &&
  firstNotice.includes('before the next broad implementation or verification turn'));

header('/context — transcript-only integration');
latch = createContextWarnLatch();
let state: TurnState = initialTurnState;
const baseline = latch.check(estimate(700_000), 0.8);
if (baseline !== null) state = turnReducer(state, { type: 'notice', text: baseline, severity: 'warn' });
const crossing = latch.check(estimate(800_000), 0.8);
if (crossing !== null) state = turnReducer(state, { type: 'notice', text: crossing, severity: 'warn' });
const repeated = latch.check(estimate(900_000), 0.8);
if (repeated !== null) state = turnReducer(state, { type: 'notice', text: repeated, severity: 'warn' });
assert('baseline plus repeated high-pressure checks produce exactly one transcript notice',
  state.history.length === 1 && state.history[0]?.kind === 'notice' && state.history[0].text === crossing);
assert('the notice does not populate any live-frame turn state',
  state.liveText === '' && state.committedAnswer === '' && !state.thinking && state.activeTools.length === 0);

report();
