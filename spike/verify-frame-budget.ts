/**
 * Pure contracts for the frame's row budget. No terminal, no model.
 *
 * Round 1 proved the arithmetic for one participant (`verify-live-text.ts`): the
 * block drawn for still-arriving text is never taller than the rows it was given.
 * This suite proves it for *all* of them at once, which is the property that
 * actually keeps Ink out of its `clearTerminal` branch — three individually
 * bounded boxes still overflow together.
 *
 * The numbers being defended are in
 * `.trellis/tasks/08-17-live-frame-chrome/research/probe-results.md`.
 */
import { renderToString } from 'ink';
import React from 'react';

import { NEVER_WITHDRAWN } from '../src/agent/permission.js';
import {
  InputBox,
  completionWindow,
  hiddenCompletionNotice,
  moveCompletionSelection,
} from '../src/tui/InputBox.js';
import { PermissionPrompt } from '../src/tui/PermissionPrompt.js';
import { PlanChecklist } from '../src/tui/PlanChecklist.js';
import { ActiveToolCalls } from '../src/tui/ToolCallPanel.js';
import { layoutEditor } from '../src/tui/prompt-editor.js';
import { promptRecallIndicator } from '../src/tui/prompt-recall.js';
import {
  PERMISSION_BOX_FIXED_ROWS,
  RECALL_INDICATOR_ROWS,
  SPARE_FRAME_ROW,
  draftWindow,
  frameBudget,
  hiddenDetailNotice,
  hiddenDraftNotice,
  hiddenPermissionNotice,
  hiddenToolsNotice,
  planPermissionBox,
  planPromptBox,
  planToolPanel,
  promptBoxWanted,
  type FrameClaims,
} from '../src/tui/frame-budget.js';
import { assert, header, report } from './shared.js';

/** Rows the frame really draws for a set of grants. */
function frameHeight(claims: FrameClaims): number {
  const grants = frameBudget(claims);
  return claims.headerRows + claims.thinkingRows + grants.prompt + grants.tools + grants.plan + grants.queued + grants.live;
}

header('frame budget — the invariant, over every shape that reaches it');

// The property: whatever anyone asks for, the frame stays strictly shorter than the
// viewport. `rows - SPARE_FRAME_ROW` is the limit because Ink calls a frame
// fullscreen at `outputHeight >= rows` and clears the screen when it shrinks again.
{
  let worst = { over: 0, at: '' };
  for (const rows of [10, 20, 24, 40, 50, 80]) {
    for (const headerRows of [3, 6, 12, 14]) {
      for (const thinkingRows of [0, 1]) {
        for (const promptWanted of [1, 2, 13, 41, 200]) {
          for (const toolsWanted of [0, 1, 5, 41, 102]) {
            for (const liveWanted of [0, 4, 12, 122]) {
              const claims: FrameClaims = {
                rows,
                headerRows,
                thinkingRows,
                prompt: { wanted: promptWanted, floor: 1 },
                tools: { wanted: toolsWanted, floor: toolsWanted > 0 ? 1 : 0 },
                live: { wanted: liveWanted, floor: 0 },
              };
              const height = frameHeight(claims);
              const limit = rows - SPARE_FRAME_ROW;
              // The header is the one participant this module cannot bound, so a
              // header taller than the terminal is excluded from the property (and
              // is exactly what `degraded` reports).
              if (headerRows + thinkingRows > limit) continue;
              if (height - limit > worst.over) {
                worst = { over: height - limit, at: `${rows}x header ${headerRows} prompt ${promptWanted} tools ${toolsWanted} live ${liveWanted}` };
              }
            }
          }
        }
      }
    }
  }
  assert(`the frame never reaches the viewport height (worst overshoot ${worst.over}${worst.at === '' ? '' : ` at ${worst.at}`})`,
    worst.over === 0);
}

header('frame budget — who yields, and who never does');

const streaming: FrameClaims = {
  rows: 24,
  headerRows: 12,
  thinkingRows: 0,
  // The measured case: a 200-row pasted draft while an answer streams.
  prompt: { wanted: 200, floor: 1 },
  tools: { wanted: 0, floor: 0 },
  live: { wanted: 122, floor: 0 },
};

const withPlan = frameBudget({
  rows: 18,
  headerRows: 5,
  thinkingRows: 1,
  prompt: { wanted: 3, floor: 1 },
  tools: { wanted: 4, floor: 1 },
  plan: { wanted: 21, floor: 1 },
  queued: { wanted: 3, floor: 0 },
  live: { wanted: 20, floor: 0 },
});
assert('the plan grant is counted with every sibling in the shared budget',
  5 + 1 + withPlan.prompt + withPlan.tools + withPlan.plan + withPlan.queued + withPlan.live < 18);
const adversarialPlanGrant = 4;
const renderedPlan = renderToString(React.createElement(PlanChecklist, {
  plan: Array.from({ length: 3 }, (_, index) => ({
    item: `${index}-${'long-plan-'.repeat(18)}`,
    status: 'pending' as const,
  })),
  maxRows: adversarialPlanGrant,
}), { columns: 12 });
assert('long plan items at narrow width draw exactly one visual row per granted row',
  renderedPlan.split('\n').length === adversarialPlanGrant);

const whileStreaming = frameBudget(streaming);
assert('a 200-row draft is windowed rather than allowed to fill the frame',
  whileStreaming.prompt < 200 && whileStreaming.prompt > 0);
assert('the streaming answer still gets rows when the draft is huge', whileStreaming.live > 0);
assert('the answer yields first: the draft is served before it',
  whileStreaming.prompt >= whileStreaming.live);

const idle = frameBudget({ ...streaming, live: { wanted: 0, floor: 0 } });
assert('with nothing streaming the draft may use the whole screen',
  idle.prompt === streaming.rows - SPARE_FRAME_ROW - streaming.headerRows);
assert('this is the case that used to clear the screen at 13 rows', idle.prompt >= 11);

const withTools = frameBudget({
  ...streaming,
  prompt: { wanted: 1, floor: 1 },
  tools: { wanted: 41, floor: 1 },
});
assert('an over-tall tool panel is cut, not drawn', withTools.tools < 41);
assert('a running tool keeps at least its collapsed row', withTools.tools >= 1);
assert('expanded tool detail yields before the draft',
  withTools.prompt >= 1 && withTools.tools < 41);

// The permission box is modal — the loop is blocked on it — so it is not asked to
// share with the call it is asking about. Getting this wrong cost the box its last
// detail row, which is where `permissionDetail` puts `… truncated N code points`:
// the line stating that the value shown is not the whole value.
{
  const claims: FrameClaims = {
    rows: 50,
    headerRows: 7,
    thinkingRows: 0,
    prompt: { wanted: 25, floor: PERMISSION_BOX_FIXED_ROWS, modal: true },
    tools: { wanted: 1, floor: 1 },
    live: { wanted: 9, floor: 0 },
  };
  assert('a modal permission box gets every row it asks for while a call runs',
    frameBudget(claims).prompt === 25);
  assert('and the same claim without `modal` is halved — the bug this guards',
    frameBudget({ ...claims, prompt: { wanted: 25, floor: PERMISSION_BOX_FIXED_ROWS } }).prompt === 21);
  assert('a modal box still cannot take rows that do not exist',
    frameBudget({ ...claims, rows: 20 }).prompt === 12);
}

header('frame budget — a terminal smaller than its own furniture');

const tiny = frameBudget({
  rows: 8,
  headerRows: 12,
  thinkingRows: 0,
  prompt: { wanted: 4, floor: 1 },
  tools: { wanted: 3, floor: 1 },
  live: { wanted: 9, floor: 0 },
});
assert('nothing below a too-tall header is granted a single row',
  tiny.prompt === 0 && tiny.tools === 0 && tiny.live === 0);
assert('and that is reported rather than pretended away', tiny.degraded);
assert('a frame that fits is not reported as degraded',
  !frameBudget({ rows: 40, headerRows: 6, thinkingRows: 0, prompt: { wanted: 3, floor: 1 }, tools: { wanted: 0, floor: 0 }, live: { wanted: 4, floor: 0 } }).degraded);

header('draft window — the cursor is always on screen');

{
  let worstHeight = 0;
  let cursorLost = '';
  for (const total of [1, 2, 13, 68, 200]) {
    for (const maxRows of [1, 2, 3, 6, 11, 24]) {
      for (const cursorRow of [0, 1, Math.floor(total / 2), total - 2, total - 1]) {
        if (cursorRow < 0 || cursorRow >= total) continue;
        const view = draftWindow(total, cursorRow, maxRows);
        const drawn = view.end - view.start + (view.notice ? 1 : 0);
        worstHeight = Math.max(worstHeight, drawn - maxRows);
        if (!(cursorRow >= view.start && cursorRow < view.end)) {
          cursorLost = `total ${total} cursor ${cursorRow} maxRows ${maxRows}`;
        }
        if (view.hiddenAbove + view.hiddenBelow + (view.end - view.start) !== total) {
          cursorLost = `lost rows: total ${total} cursor ${cursorRow} maxRows ${maxRows}`;
        }
      }
    }
  }
  assert('the window plus its notice never exceeds the rows it was given', worstHeight <= 0);
  assert(`the cursor's row is always inside the window${cursorLost === '' ? '' : ` (${cursorLost})`}`, cursorLost === '');
}

assert('a draft that fits is shown whole, with nothing hidden',
  draftWindow(5, 0, 10).end === 5 && draftWindow(5, 0, 10).hiddenAbove === 0 && draftWindow(5, 0, 10).hiddenBelow === 0);
{
  const tail = draftWindow(200, 199, 6);
  assert('typing at the end shows the newest rows', tail.end === 200 && tail.hiddenAbove === 195 && tail.hiddenBelow === 0);
  const middle = draftWindow(200, 100, 6);
  assert('moving up scrolls the window to the cursor',
    middle.start <= 100 && middle.end > 100 && middle.hiddenAbove > 0 && middle.hiddenBelow > 0);
  assert('one notice counts both directions',
    hiddenDraftNotice(96, 99) === '… 195 draft rows not shown (96 above, 99 below)');
  assert('one hidden row is singular', hiddenDraftNotice(1, 0) === '… 1 draft row not shown (1 above)');
}

header('completion menu — the bounded window follows the full-list selection');

{
  const first = completionWindow(20, 0, 5);
  const middle = completionWindow(20, 10, 5);
  const last = completionWindow(20, 19, 5);
  const wrappedUp = completionWindow(20, moveCompletionSelection(0, 20, -1), 5);
  const wrappedDown = completionWindow(20, moveCompletionSelection(19, 20, 1), 5);

  assert('the first selection keeps source order and states only omissions below',
    first.start === 0 && first.end === 5 && first.selected === 0 &&
    hiddenCompletionNotice(first.hiddenAbove, first.hiddenBelow) === '… 15 more not shown (15 below)');
  assert('a middle selection is visible with truthful omissions on both sides',
    middle.start === 8 && middle.end === 13 && middle.selected === 10 &&
    hiddenCompletionNotice(middle.hiddenAbove, middle.hiddenBelow) === '… 15 more not shown (8 above, 7 below)');
  assert('the last selection keeps the final source-ordered suffix and states only omissions above',
    last.start === 15 && last.end === 20 && last.selected === 19 &&
    hiddenCompletionNotice(last.hiddenAbove, last.hiddenBelow) === '… 15 more not shown (15 above)');
  assert('navigation wraps over the full candidate list in both directions',
    wrappedUp.selected === 19 && wrappedUp.start === 15 && wrappedDown.selected === 0 && wrappedDown.start === 0);
  assert('a one-row grant still keeps the selected candidate visible',
    (() => {
      const one = completionWindow(20, 11, 1);
      return one.start === 11 && one.end === 12 && one.selected === 11;
    })());
}

header('prompt region — draft, completion menu, recall row and hint share one grant');

{
  let worst = 0;
  for (const maxRows of [1, 2, 3, 5, 8, 13, 24]) {
    for (const draftRows of [1, 2, 40]) {
      for (const completions of [0, 3, 9]) {
        for (const hasHint of [false, true]) {
          for (const hasRecall of [false, true]) {
            const plan = planPromptBox({
              maxRows,
              draftRows,
              completions,
              moreCompletions: completions === 9,
              hasHint,
              hasRecall,
            });
            const window = draftWindow(draftRows, draftRows - 1, plan.draftRows);
            const drawn =
              (window.end - window.start) +
              (window.notice ? 1 : 0) +
              (plan.completionItems > 0 ? 2 + plan.completionItems + (plan.completionMore ? 1 : 0) : 0) +
              (plan.recall ? RECALL_INDICATOR_ROWS : 0) +
              (plan.hint ? 2 : 0);
            worst = Math.max(worst, drawn - maxRows);
          }
        }
      }
    }
  }
  assert('everything the prompt region draws fits the rows it was granted', worst <= 0);
}

assert('a roomy region shows the menu, the hint and the whole draft',
  (() => {
    const plan = planPromptBox({ maxRows: 20, draftRows: 3, completions: 9, moreCompletions: true, hasHint: true });
    return plan.completionItems === 9 && plan.completionMore && plan.hint && plan.draftRows >= 3;
  })());
assert('the hint is the first thing dropped',
  !planPromptBox({ maxRows: 13, draftRows: 1, completions: 9, moreCompletions: true, hasHint: true }).hint);
assert('a menu with no room for an entry is not drawn at all',
  planPromptBox({ maxRows: 3, draftRows: 1, completions: 9, moreCompletions: false, hasHint: false }).completionItems === 0);
assert('a partly shown menu says there is more',
  planPromptBox({ maxRows: 6, draftRows: 1, completions: 9, moreCompletions: false, hasHint: false }).completionMore);
assert('the draft keeps its cursor row even with one row to spend',
  planPromptBox({ maxRows: 1, draftRows: 40, completions: 0, moreCompletions: false, hasHint: false }).draftRows === 1);

// The recall indicator is one budgeted row like everything else here: it outranks the
// hint (it says why the draft just changed), yields to the menu the other arrow key is
// driving, and is never drawn on a grant that has no row for it.
assert('a recall walk is granted its one row when there is room',
  planPromptBox({ maxRows: 8, draftRows: 1, completions: 0, moreCompletions: false, hasHint: false, hasRecall: true }).recall);
assert('the recall row outranks the hint',
  (() => {
    const plan = planPromptBox({ maxRows: 2, draftRows: 1, completions: 0, moreCompletions: false, hasHint: true, hasRecall: true });
    return plan.recall && !plan.hint;
  })());
assert('a region with one row keeps the cursor row and drops the recall indicator',
  (() => {
    const plan = planPromptBox({ maxRows: 1, draftRows: 3, completions: 0, moreCompletions: false, hasHint: false, hasRecall: true });
    return !plan.recall && plan.draftRows === 1;
  })());
assert('no walk, no row: the region is exactly what it was before recall existed',
  planPromptBox({ maxRows: 8, draftRows: 1, completions: 0, moreCompletions: false, hasHint: false }).recall === false &&
    promptBoxWanted({ draftRows: 1, completions: 0, moreCompletions: false, hasHint: false }) ===
      promptBoxWanted({ draftRows: 1, completions: 0, moreCompletions: false, hasHint: false, hasRecall: false }));
assert('and an open walk wants exactly one row more',
  promptBoxWanted({ draftRows: 2, completions: 3, moreCompletions: true, hasHint: true, hasRecall: true }) -
    promptBoxWanted({ draftRows: 2, completions: 3, moreCompletions: true, hasHint: true }) === RECALL_INDICATOR_ROWS);


const searchWanted = promptBoxWanted({
  draftRows: 1,
  completions: 0,
  moreCompletions: false,
  hasHint: false,
  searchMatches: 5,
  moreSearchMatches: true,
});
assert('reverse search title, matches and omission row are all counted', searchWanted === 8);
assert('a roomy reverse search receives its bounded matches and omission row', (() => {
  const plan = planPromptBox({
    maxRows: 8,
    draftRows: 1,
    completions: 0,
    moreCompletions: false,
    hasHint: false,
    searchMatches: 5,
    moreSearchMatches: true,
  });
  return plan.search && plan.searchItems === 5 && plan.searchMore &&
    plan.draftRows + 1 + plan.searchItems + 1 === 8;
})());
assert('a short reverse-search frame keeps the draft and title, then states omissions', (() => {
  const plan = planPromptBox({
    maxRows: 3,
    draftRows: 1,
    completions: 9,
    moreCompletions: true,
    hasHint: true,
    hasRecall: true,
    searchMatches: 5,
  });
  return plan.search && plan.searchItems === 0 && plan.searchMore &&
    plan.completionItems === 0 && !plan.recall && !plan.hint && plan.draftRows === 1;
})());

header('tool panel — summaries before detail');

{
  let worst = 0;
  for (const maxRows of [0, 1, 2, 5, 12, 45]) {
    for (const count of [0, 1, 3, 10]) {
      for (const detailRows of [0, 4, 41]) {
        const tools = Array.from({ length: count }, () => ({ detailRows }));
        const plan = planToolPanel(tools, maxRows);
        const drawn =
          plan.entries.reduce((total, entry) => total + 1 + entry.detailRows + (entry.hiddenDetailRows > 0 ? 1 : 0), 0) +
          (plan.hiddenTools > 0 ? 1 : 0);
        worst = Math.max(worst, drawn - maxRows);
      }
    }
  }
  assert('the panel never draws more rows than it was granted', worst <= 0);
}

assert('the measured 41-row expanded input is cut and says so',
  (() => {
    const plan = planToolPanel([{ detailRows: 41 }], 6);
    const entry = plan.entries[0];
    return entry !== undefined && entry.detailRows < 41 && entry.hiddenDetailRows > 0;
  })());
assert('everything fitting is shown untouched',
  planToolPanel([{ detailRows: 3 }], 12).entries[0]?.hiddenDetailRows === 0);
assert('more calls than rows collapse into one counted line',
  (() => {
    const plan = planToolPanel(Array.from({ length: 10 }, () => ({ detailRows: 0 })), 4);
    return plan.entries.length === 3 && plan.hiddenTools === 7;
  })());
assert('the collapsed line names how many calls it stands for',
  hiddenToolsNotice(7) === '… 7 more tool calls running' && hiddenToolsNotice(1) === '… 1 more tool call running');
assert('a cut detail names how many rows are missing',
  hiddenDetailNotice(37) === '… 37 more input rows not shown');

header('permission box — the question never yields');

{
  let worst = 0;
  for (const maxRows of [1, 4, 6, 8, 11, 25, 41]) {
    for (const blocks of [[], [1], [1, 14], [14, 14, 14]]) {
      const plan = planPermissionBox(blocks, maxRows);
      // Counted exactly the way `PermissionPrompt` draws it.
      const drawn = plan.compact
        ? 1 + (plan.summary ? 1 : 0) + (plan.notice ? 1 : 0)
        : PERMISSION_BOX_FIXED_ROWS +
          plan.blocks.reduce((total, block) => total + (block.rows > 0 ? block.rows + 2 : 0), 0) +
          (plan.notice ? 1 : 0);
      worst = Math.max(worst, drawn - maxRows);
    }
  }
  assert('the box, including the line about what it hid, fits its grant', worst <= 0);
}

assert('a 50-row terminal shows every detail untouched — the approve scenario',
  (() => {
    const plan = planPermissionBox([1, 14], 41);
    return plan.blocks.every((block) => block.hiddenRows === 0) && plan.hiddenBlocks === 0 && !plan.compact;
  })());
assert('a 24-row terminal cuts detail but keeps the box',
  (() => {
    const plan = planPermissionBox([1, 14], 11);
    return !plan.compact && plan.blocks.some((block) => block.hiddenRows > 0 || block.rows === 0);
  })());
assert('below the box\'s fixed cost only the question is drawn',
  planPermissionBox([1, 14], 5).compact);
assert('what the box hid is stated, blocks included',
  hiddenPermissionNotice(12, 1) === '… 12 detail rows in 1 hidden block not shown — the terminal is too short' &&
  hiddenPermissionNotice(1, 0) === '… 1 detail row not shown — the terminal is too short');

header('rendered height — what Ink actually draws, not what we counted');

/**
 * Rows Ink lays out for a component at a given width.
 *
 * This is the assertion the arithmetic above cannot make on its own: the plans are
 * exact only if the components draw one row per row they were granted, and the one
 * thing that would break that silently is Ink's own word wrap disagreeing with
 * `wrapToRows`. `renderToString` runs the real layout, so a disagreement shows up
 * here as a height instead of as a cleared screen in front of a user.
 */
function renderedRows(element: React.ReactElement, columns: number): number {
  const output = renderToString(element, { columns });
  return output === '' ? 0 : output.split('\n').length;
}

{
  // The measured case: expanded input of a 300-line file write — 4 bounded logical
  // lines, 41 terminal rows at 80 columns.
  const input = {
    path: '/repo/src/x.ts',
    content: Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n'),
  };
  const tools = [
    { id: 't1', name: 'fileEditor', summary: 'fileEditor create: /repo/src/x.ts', startedAt: Date.now(), input },
  ];

  let worst = 0;
  for (const columns of [40, 80, 100]) {
    for (const maxRows of [1, 2, 4, 8, 20, 60]) {
      const rendered = renderedRows(
        React.createElement(ActiveToolCalls, { tools, frame: 0, toolDetailsExpanded: true, columns, maxRows }),
        columns,
      );
      worst = Math.max(worst, rendered - maxRows);
    }
  }
  assert('the tool panel Ink draws is never taller than its grant', worst <= 0);

  // Ten concurrent calls, the shape parallel subagents produce.
  const many = Array.from({ length: 10 }, (_, index) => ({
    id: `t${index}`,
    name: 'bash',
    summary: `bash: sleep ${index}`,
    startedAt: Date.now(),
    input: { command: `sleep ${index}` },
  }));
  let worstMany = 0;
  for (const maxRows of [1, 3, 7, 12]) {
    worstMany = Math.max(
      worstMany,
      renderedRows(
        React.createElement(ActiveToolCalls, { tools: many, frame: 0, toolDetailsExpanded: false, columns: 80, maxRows }),
        80,
      ) - maxRows,
    );
  }
  assert('ten concurrent calls fit whatever the panel was granted', worstMany <= 0);
}

{
  const long = 'x'.repeat(900);
  const request = {
    toolName: 'fileEditor',
    kind: 'write' as const,
    summary: `fileEditor str_replace: /tmp/target/${'deep/'.repeat(20)}file.ts`,
    details: [
      { label: 'Path', value: '/tmp/target/file.ts' },
      { label: 'With', value: long },
      { label: 'Reason', value: Array.from({ length: 30 }, (_, index) => `reason line ${index + 1}`).join('\n') },
    ],
    input: {},
    risk: 'dangerous' as const,
    riskReason: 'outside the project',
    source: { kind: 'parent' as const, label: 'parent' },
    suggestions: [],
    withdrawn: NEVER_WITHDRAWN,
  };

  let worst = 0;
  for (const columns of [40, 80, 100]) {
    for (const maxRows of [1, 2, 3, 5, 6, 9, 14, 41]) {
      const rendered = renderedRows(
        React.createElement(PermissionPrompt, { request, waiting: 0, columns, maxRows }),
        columns,
      );
      worst = Math.max(worst, rendered - maxRows);
    }
  }
  assert('the permission box Ink draws is never taller than its grant', worst <= 0);

  for (const maxRows of [1, 2, 3, 5]) {
    const output = renderToString(
      React.createElement(PermissionPrompt, { request, waiting: 0, columns: 80, maxRows }),
      { columns: 80 },
    );
    assert(`a ${maxRows}-row grant still asks the question`, output.includes('allow?'));
  }
}

{
  const draft = Array.from({ length: 200 }, (_, index) => `pasted line ${index + 1}`).join('\n');
  // Both completion sources, because their rows are drawn differently and only their
  // *height* is shared: a command row is name plus description, a path row is one long
  // string that must truncate rather than wrap, and the path menu's title carries a
  // note. A path menu is also the case with far more matches than rows, so the
  // "… n more" line is the normal state rather than the edge one.
  const menus = [
    { kind: 'command' as const, note: undefined, items: [] as string[] },
    {
      kind: 'command' as const,
      note: undefined,
      items: ['tasks', 'usage', 'effort', 'model', 'agents', 'compact', 'exit', 'skill', 'plan', 'extra'],
    },
    {
      kind: 'path' as const,
      note: 'bounded scan: 4000 paths',
      items: Array.from(
        { length: 40 },
        (_, index) => `.trellis/tasks/archive/2026-08/08-17-live-frame-chrome/research/probe-results-${index}.md`,
      ),
    },
  ];
  let worst = 0;
  for (const columns of [40, 80]) {
    for (const maxRows of [1, 2, 3, 6, 11, 24]) {
      for (const menu of menus) {
        for (const hint of [undefined, 'working… /tasks lists jobs · ctrl+c cancels this turn']) {
          // The recall indicator joins the matrix rather than getting a check of its own:
          // it is a redrawn participant, and the long form (position plus a bound note) is
          // the one that would wrap on a 40-column terminal if it were not truncated.
          for (const recallIndicator of [
            undefined,
            promptRecallIndicator({
              entries: ['a', 'b'],
              index: 1,
              pending: false,
              note: 'newest 100 of 137, 3 session(s) not read, 2 long prompt(s) skipped',
            }),
          ]) {
            const layout = layoutEditor(draft, columns, { offset: draft.length, affinity: 'upstream' });
            const rendered = renderedRows(
              React.createElement(InputBox, {
                layout,
                completions: menu.items,
                completionKind: menu.kind,
                completionNote: menu.note,
                selectedCompletion: 0,
                editable: true,
                hint,
                recallIndicator,
                offset: { top: 0, left: 0 },
                maxRows,
              }),
              columns,
            );
            worst = Math.max(worst, rendered - maxRows);
          }
        }
      }
    }
  }
  assert('the prompt region Ink draws is never taller than its grant', worst <= 0);

  // The note is a suffix of the title row, never a row of its own: the budget counts
  // the menu as title + entries + overflow, so an extra heading row is an overflow.
  const noted = renderToString(
    React.createElement(InputBox, {
      layout: layoutEditor('@src', 80, { offset: 4, affinity: 'upstream' }),
      completions: ['src/', 'src/tui/'],
      completionKind: 'path',
      completionNote: 'bounded scan: 4000 paths',
      selectedCompletion: 0,
      editable: true,
      hint: undefined,
      recallIndicator: undefined,
      offset: { top: 0, left: 0 },
      maxRows: 24,
    }),
    { columns: 80 },
  );
  assert('a path menu names its own kind', noted.includes('files (↑/↓ to select, tab to complete)'));
  assert('and states its bound on that same row',
    /files \(.*\) — bounded scan: 4000 paths:/.test(noted));
  assert('path rows carry no slash prefix', noted.includes('❯ src/') && !noted.includes('❯ /src/'));

  const overflowItems = Array.from({ length: 20 }, (_, index) => `item-${String(index).padStart(2, '0')}`);
  const renderOverflow = (selectedCompletion: number): string => renderToString(
    React.createElement(InputBox, {
      layout: layoutEditor('/', 80, { offset: 1, affinity: 'upstream' }),
      completions: overflowItems,
      completionKind: 'command',
      completionNote: undefined,
      selectedCompletion,
      editable: true,
      hint: undefined,
      recallIndicator: undefined,
      offset: { top: 0, left: 0 },
      maxRows: 24,
    }),
    { columns: 80 },
  );
  const renderedCases = [
    { name: 'first', selected: 0, marker: '❯ /item-00', notice: '… 1 more not shown (1 below)' },
    { name: 'middle', selected: 10, marker: '❯ /item-10', notice: '… 1 more not shown (1 above)' },
    { name: 'last', selected: 19, marker: '❯ /item-19', notice: '… 1 more not shown (1 above)' },
    { name: 'wrapped', selected: moveCompletionSelection(0, 20, -1), marker: '❯ /item-19', notice: '… 1 more not shown (1 above)' },
  ];
  for (const renderedCase of renderedCases) {
    const output = renderOverflow(renderedCase.selected);
    assert(`${renderedCase.name} selection renders exactly one visible marker`,
      output.match(/❯/g)?.length === 1 && output.includes(renderedCase.marker));
    assert(`${renderedCase.name} selection states the window omissions truthfully`,
      output.includes(renderedCase.notice));
  }
  const middleOutput = renderOverflow(10);
  assert('a middle window preserves the original candidate order',
    middleOutput.indexOf('/item-03') < middleOutput.indexOf('/item-10') &&
    middleOutput.indexOf('/item-10') < middleOutput.indexOf('/item-17'));


  const layout = layoutEditor(draft, 80, { offset: draft.length, affinity: 'upstream' });
  const windowed = renderToString(
    React.createElement(InputBox, {
      layout,
      completions: [],
      completionKind: 'command',
      completionNote: undefined,
      selectedCompletion: 0,
      editable: true,
      hint: undefined,
      recallIndicator: undefined,
      offset: { top: 0, left: 0 },
      maxRows: 11,
    }),
    { columns: 80 },
  );
  assert('a windowed draft says how many rows it is not showing',
    /… \d+ draft rows not shown/.test(windowed));
  assert('and shows the newest rows, where the cursor is',
    windowed.includes('pasted line 200') && !windowed.includes('pasted line 1\n'));

  // The window is a *view*. Submission reads the editor value, and the layout the
  // view is sliced from still holds every row — so a windowed draft is still sent
  // whole. (`verify-tui.ts multiline` is the end-to-end half of this: a multi-row
  // draft submits as one prompt with its newlines intact.)
  assert('windowing leaves the draft the editor holds untouched',
    layout.rows.length === 200 && layout.rows.map((row) => row.text).join('\n') === draft);
  // Where the row goes matters as much as how tall it is: under the draft it describes
  // and above the menu, so a windowed draft's cursor row (counted from the top of the
  // frame by `useCursor`) is not moved by it.
  const recalled = renderToString(
    React.createElement(InputBox, {
      layout: layoutEditor('/review the diff', 80, { offset: 16, affinity: 'upstream' }),
      completions: ['review'],
      completionKind: 'command',
      completionNote: undefined,
      selectedCompletion: 0,
      editable: true,
      hint: undefined,
      recallIndicator: promptRecallIndicator({ entries: ['/review the diff', 'older'], index: 0, pending: false, note: undefined }),
      offset: { top: 0, left: 0 },
      maxRows: 24,
    }),
    { columns: 80 },
  );
  {
    const lines = recalled.split('\n');
    const draftRow = lines.findIndex((line) => line.includes('you> /review the diff'));
    const indicatorRow = lines.findIndex((line) => line.includes('history 1/2'));
    const menuRow = lines.findIndex((line) => line.includes('commands ('));
    assert('the recall indicator is one row, below the draft and above the menu',
      draftRow >= 0 && indicatorRow === draftRow + 1 && menuRow > indicatorRow);
    assert('and it states the position and the keys on that one row',
      lines[indicatorRow]?.includes('history 1/2 · ↑ older ↓ newer') === true);
  }

  const view = draftWindow(layout.rows.length, 199, 11);
  assert('the drawn rows are a contiguous slice of the draft, ending at the cursor',
    view.end === 200 && view.start === 200 - (11 - 1) &&
    layout.rows.slice(view.start, view.end).map((row) => row.text).join('\n') ===
      draft.split('\n').slice(view.start).join('\n'));
}

report();
