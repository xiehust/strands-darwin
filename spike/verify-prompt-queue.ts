/**
 * The prompt queue (SER-027) — free, no model call, no pty.
 *
 * SER-027 deliberately supersedes SER-010's "retained, never queued" busy-submit
 * contract (explicit user product decision, 2026-08-19): a submission while a
 * turn streams or a `!` command runs joins a visible FIFO queue and is sent when
 * the session returns to idle. This suite pins the pure pieces the App composes:
 * which submissions refuse to queue, how an entry projects to one counted row,
 * what a take-back puts in the editor, how the listing shares the frame budget,
 * and that what Ink draws for the listing is never taller than its grant. The
 * background-task wake (SER-069) is the queue's second entry kind and is pinned
 * here too: its collapsed notification summary, its own busy-hint word, and that take-back and
 * `partitionQueue` leave it out of the editor. The
 * state machine end to end (enqueue while busy, drain order, cancel return,
 * /clear drop) is `spike/verify-tui.ts queue` — a real pty, still free — and the
 * wake's end-to-end path is `spike/verify-task-wake.ts`.
 */
import { strict as nodeAssert } from 'node:assert';

import { renderToString } from 'ink';
import React from 'react';

import {
  frameBudget,
  hiddenQueuedNotice,
  planQueueList,
  queueListWanted,
} from '../src/tui/frame-budget.js';
import {
  QUEUED_MARKER,
  hasQueuedImage,
  isTaskWake,
  partitionQueue,
  queueRowText,
  queueNotificationSummary,
  queuedCountHint,
  refusesToQueue,
  takeBackDraft,
  type QueuedTaskWake,
} from '../src/tui/prompt-queue.js';
import { QueuedMessages } from '../src/tui/QueuedMessages.js';
import { assert, header, report } from './shared.js';

function check(what: string, assertion: () => void): void {
  try {
    assertion();
    assert(what, true);
  } catch (error) {
    assert(what, false);
    throw error;
  }
}

header('prompt queue — what queues and what keeps the refusal shape');

check('plain prompts queue', () => {
  nodeAssert.equal(refusesToQueue('explain the frame budget'), false);
});
check('! shell commands queue (the Claude Code shape)', () => {
  nodeAssert.equal(refusesToQueue('!git status'), false);
});
check('local report commands would queue here — they never reach the busy check', () => {
  // /usage, /status etc. are handled above the busy check in submit(); this
  // predicate deciding "queue" for them is unreachable, asserted for the record.
  nodeAssert.equal(refusesToQueue('/usage'), false);
});
check('session-replacing commands refuse: /clear /compact /model /rewind /tangent /exit /quit', () => {
  for (const command of ['/clear', '/compact', '/model', '/rewind', '/tangent', '/exit', '/quit']) {
    nodeAssert.equal(refusesToQueue(command), true, command);
  }
});
check('refusal matches the first word, not a prefix of a longer prompt', () => {
  nodeAssert.equal(refusesToQueue('/model claude'), true);
  nodeAssert.equal(refusesToQueue('/clearly this is a prompt'), false);
  nodeAssert.equal(refusesToQueue('/modeling question'), false);
});

header('prompt queue — one entry, one counted row');

check('a queued row carries the durable marker', () => {
  nodeAssert.equal(queueRowText('fix the tests'), `${QUEUED_MARKER} fix the tests`);
});
check('a multi-line entry stays one row: newlines become visible ⏎', () => {
  const row = queueRowText('first line\nsecond line');
  nodeAssert.equal(row.includes('\n'), false);
  nodeAssert.equal(row, `${QUEUED_MARKER} first line ⏎ second line`);
});
check('an attached queued row states the fact without bytes', () => {
  const row = queueRowText({ text: 'inspect this', image: { type: 'imageBlock' } as never });
  nodeAssert.equal(row, `${QUEUED_MARKER} [image] inspect this`);
  nodeAssert.equal(row.includes('bytes'), false);
});

check('the queue exposes whether its one bounded image slot is occupied', () => {
  const image = { type: 'imageBlock' } as never;
  nodeAssert.equal(hasQueuedImage([{ text: 'plain' }]), false);
  nodeAssert.equal(hasQueuedImage([{ text: 'attached', image }]), true);
});


header('prompt queue — take-back composes the draft, oldest first, ahead of typed text');

check('take-back into an empty draft is the entries, one per line', () => {
  nodeAssert.equal(takeBackDraft(['first', 'second'], ''), 'first\nsecond');
});
check('take-back lands ahead of typed text, preserving it', () => {
  nodeAssert.equal(takeBackDraft(['first', 'second'], 'half-typed'), 'first\nsecond\nhalf-typed');
});
check('a multi-line entry keeps its own newlines in the draft', () => {
  nodeAssert.equal(takeBackDraft(['a\nb'], 'c'), 'a\nb\nc');
});
check('take-back restores text from an attached entry without serializing image data', () => {
  nodeAssert.equal(takeBackDraft([{ text: 'look', image: { type: 'imageBlock' } as never }], 'draft'), 'look\ndraft');
});

header('prompt queue — the busy hint states the count, or nothing');

check('zero queued adds nothing to the hint', () => {
  nodeAssert.equal(queuedCountHint(0), '');
});
check('a non-empty queue is counted on the hint', () => {
  nodeAssert.equal(queuedCountHint(1), ' · 1 queued');
  nodeAssert.equal(queuedCountHint(12), ' · 12 queued');
});

header('prompt queue — a background-task wake is a second entry kind (SER-069)');

const wake: QueuedTaskWake = {
  kind: 'taskNotification',
  taskId: 'bg-1a2b3c4d-0000-4000-8000-000000000000',
  command: 'pnpm test\n  --filter core',
  state: 'failed',
  exitCode: 1,
  signal: null,
  text: '<task-notification task="bg-1a2b3c4d-0000-4000-8000-000000000000" state="failed">\nbody\n</task-notification>',
};

check('a wake row is distinct from a typed row: marker, bracketed task tag, command label — never the model-facing text', () => {
  const row = queueRowText(wake);
  nodeAssert.equal(row, `${QUEUED_MARKER} [task bg-1a2b3c4d failed] pnpm test --filter core`);
  nodeAssert.equal(row.includes('<task-notification'), false);
  nodeAssert.equal(row.includes('\n'), false);
});
check('a typed entry that merely looks like a wake stays a typed row', () => {
  nodeAssert.equal(isTaskWake({ text: '[task bg-1a2b3c4d failed] pnpm test' }), false);
  nodeAssert.equal(queueRowText({ text: '<task-notification>' }), `${QUEUED_MARKER} <task-notification>`);
});
check('partitionQueue splits ownership in order: typed entries to the user, wakes to the drain', () => {
  const { user, wakes } = partitionQueue([{ text: 'a' }, wake, { text: 'b' }]);
  nodeAssert.deepEqual(user.map((entry) => entry.text), ['a', 'b']);
  nodeAssert.deepEqual(wakes, [wake]);
});
check('take-back excludes wakes: only typed entries reach the draft', () => {
  nodeAssert.equal(takeBackDraft([{ text: 'first' }, wake, { text: 'second' }], 'typed'), 'first\nsecond\ntyped');
});
check('a queue of wakes alone leaves the draft untouched — nothing to edit', () => {
  nodeAssert.equal(takeBackDraft([wake], 'typed'), 'typed');
  nodeAssert.equal(takeBackDraft([wake], ''), '');
});
check('a wake carries no image and never occupies the clipboard slot', () => {
  nodeAssert.equal(hasQueuedImage([wake]), false);
});
check('the busy hint counts pending notifications apart from typed entries', () => {
  nodeAssert.equal(queuedCountHint(0, 1), ' · 1 notification pending');
  nodeAssert.equal(queuedCountHint(2, 3), ' · 2 queued · 3 notifications pending');
  nodeAssert.equal(queuedCountHint(0, 0), '');
});
check('notifications have their own summary, not another queued task row', () => {
  const output = renderToString(React.createElement(QueuedMessages, { entries: [{ text: 'typed' }, wake], maxRows: 5 }), { columns: 120 });
  const rows = output.split('\n').filter((row) => row.trim() !== '');
  nodeAssert.deepEqual(rows, [
    'notifications · 1 pending (1 failed) · after this turn · /tasks',
    'queued · typed',
  ]);
});

const manyWakes: QueuedTaskWake[] = Array.from({ length: 19 }, (_, index) => ({
  ...wake,
  taskId: `bg-${index}`,
  state: index === 0 ? 'failed' : index < 3 ? 'stopped' : 'succeeded',
}));
check('nineteen finished jobs collapse to one row with failures first and no command or payload dump', () => {
  nodeAssert.equal(queueNotificationSummary(manyWakes),
    'notifications · 19 pending (1 failed, 2 stopped, 16 succeeded) · after this turn · /tasks');
  nodeAssert.equal(queueNotificationSummary([]), undefined);
  const output = renderToString(React.createElement(QueuedMessages, { entries: manyWakes, maxRows: 30 }), { columns: 120 });
  nodeAssert.equal(output, queueNotificationSummary(manyWakes));
  nodeAssert.equal(output.includes('queued'), false);
  nodeAssert.equal(output.includes(wake.command), false);
  nodeAssert.equal(output.includes('<task-notification'), false);
});
check('the summary points to the relevant existing detail reports for jobs and delegations', () => {
  const delegation: QueuedTaskWake = { ...wake, source: 'delegation' };
  nodeAssert.equal(queueNotificationSummary([delegation]),
    'notifications · 1 pending (1 failed) · after this turn · /agents');
  nodeAssert.equal(queueNotificationSummary([wake, delegation]),
    'notifications · 2 pending (2 failed) · after this turn · /tasks · /agents');
});
check('a mixed queue preserves typed order and attachments without changing the underlying FIFO', () => {
  const entries = Object.freeze([
    Object.freeze({ text: 'first' }), manyWakes[0]!,
    Object.freeze({ text: 'second\nline', image: { type: 'imageBlock' } as never }), ...manyWakes.slice(1),
  ]);
  const before = JSON.stringify(entries);
  const output = renderToString(React.createElement(QueuedMessages, { entries, maxRows: 3 }), { columns: 120 });
  nodeAssert.deepEqual(output.split('\n').slice(1), ['queued · first', 'queued · [image] second ⏎ line']);
  nodeAssert.equal(JSON.stringify(entries), before);
  nodeAssert.equal(takeBackDraft(entries, 'draft'), 'first\nsecond\nline\ndraft');
});
check('collapsed notifications respect zero, one and small grants at narrow and wide widths', () => {
  const entries = [...manyWakes, { text: 'typed first' }, { text: 'typed second' }];
  for (const columns of [20, 40, 80, 120]) {
    for (const maxRows of [0, 1, 2, 3, 30]) {
      const output = renderToString(React.createElement(QueuedMessages, { entries, maxRows }), { columns });
      nodeAssert.ok((output === '' ? 0 : output.split('\n').length) <= maxRows);
    }
  }
  const render = (maxRows: number) => renderToString(React.createElement(QueuedMessages, { entries, maxRows }), { columns: 160 });
  nodeAssert.equal(render(0), '');
  nodeAssert.equal(render(1), '2 queued · 19 notifications pending');
  const narrow = renderToString(React.createElement(QueuedMessages, { entries, maxRows: 1 }), { columns: 20 });
  nodeAssert.ok(narrow.startsWith('2 queued · 19 '));
  nodeAssert.equal(render(2).split('\n')[1], '… 2 more queued');
  nodeAssert.equal(render(3).split('\n')[1], 'queued · typed first');
});

header('prompt queue — the listing plan is bounded and states its cuts');

check('the listing wants one row per typed entry and one for all notifications', () => {
  nodeAssert.equal(queueListWanted(0), 0);
  nodeAssert.equal(queueListWanted(5), 5);
  nodeAssert.equal(queueListWanted(19, 19), 1);
  nodeAssert.equal(queueListWanted(21, 19), 3);
  nodeAssert.equal(queueListWanted(1, 1), 1);
});
check('entries that fit are all shown', () => {
  nodeAssert.deepEqual(planQueueList(3, 5), { shown: 3, hiddenEntries: 0 });
  nodeAssert.deepEqual(planQueueList(3, 3), { shown: 3, hiddenEntries: 0 });
});
check('a cut keeps the head (next to send) and states the rest', () => {
  nodeAssert.deepEqual(planQueueList(5, 3), { shown: 2, hiddenEntries: 3 });
});
check('a single granted row for several entries goes entirely to the notice', () => {
  nodeAssert.deepEqual(planQueueList(4, 1), { shown: 0, hiddenEntries: 4 });
});
check('zero rows draws nothing — the hint count is what keeps the queue visible', () => {
  nodeAssert.deepEqual(planQueueList(4, 0), { shown: 0, hiddenEntries: 4 });
});
check('the hidden-entries notice uses the shared truncation vocabulary', () => {
  nodeAssert.equal(hiddenQueuedNotice(3), '… 3 more queued');
});

header('prompt queue — the frame budget grants it after tools, before the answer');

{
  const base = {
    rows: 30,
    headerRows: 8,
    thinkingRows: 0,
    prompt: { wanted: 3, floor: 1 },
    tools: { wanted: 4, floor: 1 },
    live: { wanted: 10, floor: 0 },
  };
  check('a frame without a queued claim grants it zero and changes nothing else', () => {
    const withoutClaim = frameBudget(base);
    nodeAssert.equal(withoutClaim.queued, 0);
    const explicitZero = frameBudget({ ...base, queued: { wanted: 0, floor: 0 } });
    nodeAssert.deepEqual(withoutClaim, explicitZero);
  });
  check('a queued claim is served after tools and before the live answer', () => {
    const grants = frameBudget({ ...base, queued: { wanted: 3, floor: 0 } });
    nodeAssert.equal(grants.prompt, 3);
    nodeAssert.equal(grants.tools, 4);
    nodeAssert.equal(grants.queued, 3);
    // The answer takes what is left, never what the queue was granted.
    nodeAssert.equal(grants.live, Math.min(10, 30 - 1 - 8 - 3 - 4 - 3));
  });
  check('everything granted never exceeds the frame', () => {
    for (const rows of [8, 12, 20, 50]) {
      for (const queuedWanted of [0, 1, 5, 40]) {
        const grants = frameBudget({ ...base, rows, queued: { wanted: queuedWanted, floor: 0 } });
        const total = grants.prompt + grants.tools + grants.queued + grants.live;
        nodeAssert.ok(total <= Math.max(0, rows - 1 - base.headerRows), `rows=${rows} queued=${queuedWanted}`);
      }
    }
  });
  check('a starved queue listing never degrades the frame — floor 0, count on the hint', () => {
    const grants = frameBudget({ ...base, rows: 12, queued: { wanted: 6, floor: 0 } });
    nodeAssert.equal(grants.degraded, false);
  });
}

header('prompt queue — what Ink draws is never taller than the grant');

function renderedRows(element: React.ReactElement, columns: number): number {
  const output = renderToString(element, { columns });
  return output === '' ? 0 : output.split('\n').length;
}

{
  const entries = [
    'first queued prompt',
    'a very long queued prompt that would certainly wrap at forty columns if it were allowed to wrap instead of truncating',
    'third\nwith a newline',
    '!echo queued shell command',
    'fifth',
  ];
  let worst = 0;
  for (const columns of [40, 80, 120]) {
    for (const maxRows of [0, 1, 2, 5, 10]) {
      const rendered = renderedRows(React.createElement(QueuedMessages, { entries, maxRows }), columns);
      worst = Math.max(worst, rendered - Math.max(0, maxRows));
    }
  }
  assert('the queued listing Ink draws is never taller than its grant', worst <= 0);

  const output = renderToString(React.createElement(QueuedMessages, { entries, maxRows: 3 }), { columns: 120 });
  assert('a bounded listing keeps the head of the queue', output.includes('first queued prompt'));
  assert('every drawn row carries the marker', output.split('\n').slice(0, 2).every((row) => row.includes(QUEUED_MARKER)));
  assert('the cut is stated in the listing itself', output.includes('… 3 more queued'));

  const full = renderToString(React.createElement(QueuedMessages, { entries, maxRows: 10 }), { columns: 200 });
  assert('a listing that fits shows every entry and no notice', entries.every((entry) => full.includes(queueRowText(entry).slice(0, 20))) && !full.includes('more queued'));
  assert('an empty queue draws nothing', renderToString(React.createElement(QueuedMessages, { entries: [], maxRows: 5 }), { columns: 80 }) === '');
}

report();
