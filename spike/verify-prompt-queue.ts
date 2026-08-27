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
 * state machine end to end (enqueue while busy, drain order, cancel return,
 * /clear drop) is `spike/verify-tui.ts queue` — a real pty, still free.
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
  queueRowText,
  queuedCountHint,
  refusesToQueue,
  takeBackDraft,
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
check('session-replacing commands refuse: /clear /compact /model /rewind /exit /quit', () => {
  for (const command of ['/clear', '/compact', '/model', '/rewind', '/exit', '/quit']) {
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

header('prompt queue — the listing plan is bounded and states its cuts');

check('the listing wants one row per entry', () => {
  nodeAssert.equal(queueListWanted(0), 0);
  nodeAssert.equal(queueListWanted(5), 5);
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
