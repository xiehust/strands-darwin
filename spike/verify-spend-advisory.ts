/**
 * Pure contracts for the repeated-long-context spend advisory (issue #8): each
 * successive cacheReadWarnTokens multiple fires at most once, only when recent
 * model calls show the ≤1-tool pattern, unknown metrics keep it silent, and 0
 * disables it. No model, no network.
 *
 * Run: pnpm tsx spike/verify-spend-advisory.ts
 */
import {
  SPEND_ADVISORY_LOW_TOOL_CALLS,
  SPEND_ADVISORY_WINDOW,
  createSpendAdvisoryLatch,
  type SpendAdvisoryInput,
} from '../src/tui/spend-advisory.js';
import { initialTurnState, turnReducer, type TurnState } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

const WARN = 4_000_000;
/** Ten single-tool rounds — the pattern the advisory exists for. */
const SINGLE_TOOL = Array.from({ length: SPEND_ADVISORY_WINDOW }, () => 1);
/** Ten parallel-read rounds — a session doing it right. */
const MULTI_TOOL = Array.from({ length: SPEND_ADVISORY_WINDOW }, () => 3);

function input(overrides: Partial<SpendAdvisoryInput> = {}): SpendAdvisoryInput {
  return { cacheReadTokens: 0, recentToolUseCounts: SINGLE_TOOL, warnTokens: WARN, ...overrides };
}

header('spend advisory — threshold multiples');
let latch = createSpendAdvisoryLatch();
assert('silent below the first multiple', latch.check(input({ cacheReadTokens: WARN - 1 })) === null);
const first = latch.check(input({ cacheReadTokens: WARN }));
assert('fires at the exact first multiple', first !== null);
assert('does not fire again while inside the same multiple',
  latch.check(input({ cacheReadTokens: WARN + 1 })) === null &&
  latch.check(input({ cacheReadTokens: 2 * WARN - 1 })) === null);
const second = latch.check(input({ cacheReadTokens: 2 * WARN }));
assert('the next multiple fires once more', second !== null && latch.check(input({ cacheReadTokens: 2 * WARN })) === null);
assert('the notice names the crossed threshold, the pattern, and the three recommendations',
  first !== null &&
  first.includes('4,000,000') &&
  first.includes(`${SPEND_ADVISORY_LOW_TOOL_CALLS < SPEND_ADVISORY_WINDOW ? 10 : SPEND_ADVISORY_WINDOW} of the last ${SPEND_ADVISORY_WINDOW}`) &&
  first.includes('consolidating edits') &&
  first.includes('parallel') &&
  first.includes('/compact'));
assert('the notice is one bounded line', first !== null && !first.includes('\n') && first.length <= 240);
assert('the second notice names the second multiple', second !== null && second.includes('8,000,000'));

header('spend advisory — a jump over several multiples fires once');
latch = createSpendAdvisoryLatch();
assert('a jump straight to the third multiple is one notice, latched at the third',
  latch.check(input({ cacheReadTokens: 3 * WARN + 5 })) !== null &&
  latch.check(input({ cacheReadTokens: 3 * WARN + 500_000 })) === null);

header('spend advisory — the pattern gate');
latch = createSpendAdvisoryLatch();
assert('a crossed multiple with parallel-read rounds stays silent',
  latch.check(input({ cacheReadTokens: WARN, recentToolUseCounts: MULTI_TOOL })) === null);
assert('the crossing stays eligible: the same multiple fires once the pattern appears',
  latch.check(input({ cacheReadTokens: WARN, recentToolUseCounts: SINGLE_TOOL })) !== null);
latch = createSpendAdvisoryLatch();
const sevenOfTen = [1, 1, 1, 1, 1, 1, 1, 2, 2, 2];
assert('seven of ten low-tool rounds is below the gate',
  latch.check(input({ cacheReadTokens: WARN, recentToolUseCounts: sevenOfTen })) === null);
const eightOfTen = [1, 0, 1, 1, 1, 1, 1, 1, 2, 2];
assert('eight of ten low-tool rounds (zero counts included) passes the gate',
  latch.check(input({ cacheReadTokens: WARN, recentToolUseCounts: eightOfTen })) !== null);
latch = createSpendAdvisoryLatch();
assert('fewer than eight recent calls can never satisfy the gate',
  latch.check(input({ cacheReadTokens: WARN, recentToolUseCounts: [1, 1, 1, 1, 1, 1, 1] })) === null);

header('spend advisory — unknowns keep it silent');
latch = createSpendAdvisoryLatch();
assert('an unreported cache-read meter is silence, never a zero crossing',
  latch.check(input({ cacheReadTokens: undefined })) === null &&
  latch.check(input({ cacheReadTokens: Number.NaN })) === null &&
  latch.check(input({ cacheReadTokens: -1 })) === null);
assert('a session with no call stats yet is silent',
  latch.check(input({ cacheReadTokens: WARN, recentToolUseCounts: undefined })) === null);

header('spend advisory — config disable');
latch = createSpendAdvisoryLatch();
assert('warnTokens 0 disables it however large the reads',
  latch.check(input({ cacheReadTokens: 50_000_000, warnTokens: 0 })) === null);
assert('a negative or non-finite threshold is disabled too',
  latch.check(input({ cacheReadTokens: 50_000_000, warnTokens: -5 })) === null &&
  latch.check(input({ cacheReadTokens: 50_000_000, warnTokens: Number.NaN })) === null);

header('spend advisory — transcript-only integration');
latch = createSpendAdvisoryLatch();
let state: TurnState = initialTurnState;
for (const reads of [WARN - 1, WARN, WARN + 100_000]) {
  const notice = latch.check(input({ cacheReadTokens: reads }));
  if (notice !== null) state = turnReducer(state, { type: 'notice', text: notice, severity: 'warn' });
}
assert('three post-turn checks around one crossing produce exactly one transcript notice',
  state.history.length === 1 && state.history[0]?.kind === 'notice');
assert('the notice populates no live-frame turn state',
  state.liveText === '' && state.committedAnswer === '' && !state.thinking && state.activeTools.length === 0);

report();
