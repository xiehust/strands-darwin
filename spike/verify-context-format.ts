/** Pure formatting contracts for the /context report. No model, no network. */
import { formatContextReport, formatWindowShare } from '../src/tui/context-format.js';
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

report();
