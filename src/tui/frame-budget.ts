/**
 * How the redrawn part of the frame is divided between everything that wants rows.
 *
 * Round 1 bounded the streaming answer against a *measured* chrome height: the
 * header and the box below it were measured with `useBoxMetrics`, and whatever was
 * left over went to the answer. That works only while the chrome itself is
 * bounded, and it is not — measured with `spike/probe-live-frame-overflow.tsx`
 * (numbers defended in `spike/verify-frame-budget.ts`): a 13-row
 * draft in a 24-row terminal already takes Ink's `clearTerminal` branch (2
 * whole-screen clears, scrollback included, per added row), and one in-flight tool
 * call with details expanded draws 41 rows from caps that count logical lines and
 * code points rather than terminal rows.
 *
 * So the budget is inverted here. Instead of measuring what the furniture took and
 * giving the answer the rest, every participant states what it *wants* and what it
 * cannot usefully go below, and this module hands out the rows. Nothing here
 * depends on a measurement of the boxes being bounded, so the budget cannot
 * oscillate; the one thing still measured is the header, whose height depends on
 * nothing below it.
 *
 * The order is fixed and follows what the user cannot act without: the prompt
 * region (the draft they are typing, or the question they must answer) is served
 * first, the tool panel next, the still-arriving answer last — it is the one
 * participant whose content is already guaranteed to reach `<Static>` history in
 * full. The counter-rule is the share ceiling below, so "served first" cannot mean
 * "takes everything".
 */
import { diffLineEmphasis, diffLineTone, type DiffEmphasis } from './edit-diff.js';
import { wrapToRows } from './live-text.js';
import { SHELL_TOOL_NAME } from './shell-command.js';
import { expandedToolInput, permissionDetail } from './tool-detail-presentation.js';

/**
 * The row Ink needs to not treat the frame as fullscreen.
 *
 * `renderInteractiveFrame` calls a frame `isFullscreen` at `outputHeight >= rows`
 * and clears the whole screen when the next one shrinks below that
 * (`isLeavingFullscreen`), so "fits" has to mean strictly shorter than the
 * viewport.
 */
export const SPARE_FRAME_ROW = 1;

/** What one participant of the live frame is asking for. */
export interface FrameClaim {
  /** Rows it would use if the terminal were unlimited. */
  readonly wanted: number;
  /** Rows below which it stops being useful; never granted more than are left. */
  readonly floor: number;
  /**
   * Exempt from the share ceiling below.
   *
   * For the permission box, which is modal: the loop is blocked until it is
   * answered, so the running call it is asking about and the answer that arrived
   * before it are not what the row is needed for. Measured cost of getting this
   * wrong: the box was granted half the frame while a tool call was active, cut its
   * last detail row, and the row it cut was the `… truncated N code points` marker
   * — the line that says the value shown is not the whole value, in the one box
   * where that matters.
   */
  readonly modal?: boolean;
}

export interface FrameClaims {
  /** Viewport height. */
  readonly rows: number;
  /** Measured header height, including its bottom margin. */
  readonly headerRows: number;
  /** The `thinking…` row, when it is drawn. */
  readonly thinkingRows: number;
  /** Permission box, or the draft with its completion menu and hint. */
  readonly prompt: FrameClaim;
  /** Running tool calls. */
  readonly tools: FrameClaim;
  /** Parent progress checklist, shown only after a successful update this turn. */
  readonly plan?: FrameClaim;
  /**
   * Queued mid-turn submissions, listed above the input box (SER-027). Optional
   * because most frames have none; absent means `{ wanted: 0, floor: 0 }`.
   */
  readonly queued?: FrameClaim;
  /** The still-arriving answer, label and margin included. */
  readonly live: FrameClaim;
}

export interface FrameGrants {
  readonly prompt: number;
  readonly tools: number;
  readonly plan: number;
  readonly queued: number;
  readonly live: number;
  /**
   * True when someone was granted less than its floor — the terminal is smaller
   * than the furniture. Nothing in the UI may spend a row saying so (the header
   * contract), but a check can assert it and a participant can degrade on it.
   */
  readonly degraded: boolean;
}

/**
 * Divides the rows below the header between prompt, tool panel, parent plan,
 * queued listing and live answer.
 *
 * A grant never exceeds what is left, so darwin never *chooses* to overflow: with
 * a viewport smaller than the furniture the frame still fits and the participants
 * render their degraded form. The only overflow this cannot prevent is a header
 * taller than the terminal, which this module does not own.
 *
 * The parent plan ranks after the tool panel, then the queued listing (SER-027),
 * then the answer. Plan and queue both state omitted content; the user can act on
 * queued work (`Up` takes it back), while the answer already lives in `<Static>`
 * in full and still yields last of all.
 */
export function frameBudget(claims: FrameClaims): FrameGrants {
  const available = Math.max(0, claims.rows - SPARE_FRAME_ROW - claims.headerRows - claims.thinkingRows);
  const planClaim = claims.plan ?? { wanted: 0, floor: 0 };
  const queuedClaim = claims.queued ?? { wanted: 0, floor: 0 };

  let remaining = available;
  const prompt = grant(
    claims.prompt,
    remaining,
    claims.tools.wanted + planClaim.wanted + queuedClaim.wanted + claims.live.wanted,
  );
  remaining -= prompt;
  const tools = grant(claims.tools, remaining, planClaim.wanted + queuedClaim.wanted + claims.live.wanted);
  remaining -= tools;
  const plan = grant(planClaim, remaining, queuedClaim.wanted + claims.live.wanted);
  remaining -= plan;
  const queued = grant(queuedClaim, remaining, claims.live.wanted);
  remaining -= queued;
  const live = Math.max(0, Math.min(claims.live.wanted, remaining));

  return {
    prompt,
    tools,
    plan,
    queued,
    live,
    degraded:
      prompt < Math.min(claims.prompt.floor, claims.prompt.wanted) ||
      tools < Math.min(claims.tools.floor, claims.tools.wanted) ||
      plan < Math.min(planClaim.floor, planClaim.wanted) ||
      queued < Math.min(queuedClaim.floor, queuedClaim.wanted) ||
      live < Math.min(claims.live.floor, claims.live.wanted),
  };
}

/**
 * One participant's share.
 *
 * While something of lower priority still wants rows, no one may claim more than
 * half of what is left — otherwise a pasted 200-row draft would be served first
 * and correctly leave the streaming answer nothing at all. With nothing lower
 * waiting, the ceiling is the whole remainder, so a tall draft *does* fill an idle
 * screen.
 */
function grant(claim: FrameClaim, remaining: number, lowerWants: number): number {
  if (remaining <= 0 || claim.wanted <= 0) return 0;
  const shares = lowerWants > 0 && claim.modal !== true;
  const ceiling = shares ? Math.max(claim.floor, Math.ceil(remaining / 2)) : remaining;
  return Math.max(0, Math.min(claim.wanted, remaining, Math.max(claim.floor, Math.min(ceiling, remaining))));
}

/* ------------------------------------------------- rows bounded content occupies */

/** Indent every expanded tool-input row carries; not available to the text. */
export const TOOL_INPUT_INDENT = '           ';

/** Indent every permission detail row carries; not available to the text. */
export const PERMISSION_DETAIL_INDENT = '  ';

/**
 * One counted terminal row of bounded content, with the diff tone its logical
 * line carried. Tone rides the row the budget counts — never a second pass over
 * the text — so a wrapped continuation of a `+ `/`- ` line keeps its colour and
 * the coloured rows are exactly the rows the height came from. The optional
 * intraline emphasis span rides the same row for the same reason: it is UTF-16
 * offsets *into `text`*, styling only, so the counted string never changes.
 */
export interface BoundedContentRow {
  readonly text: string;
  readonly tone?: 'add' | 'remove';
  /** Changed span within `text` to render bold; never alters the text itself. */
  readonly emphasis?: DiffEmphasis;
}

/**
 * One logical line as counted rows, tone and intraline emphasis riding along.
 *
 * The emphasis range names offsets in the *logical line*; each wrapped row is a
 * contiguous slice of it, located by scanning forward (word wrap only drops
 * whitespace at wrap points), so the range is intersected per row. Lines
 * containing tabs skip emphasis — `wrapToRows` expands them, which would skew
 * the offsets — and keep their tone; the `+ `/`- ` markers stay the durable
 * statement either way.
 */
function contentRows(
  line: string,
  width: number,
  tone: 'add' | 'remove' | undefined,
  emphasis: DiffEmphasis | undefined,
): BoundedContentRow[] {
  const mappable = emphasis !== undefined && !line.includes('\t') ? emphasis : undefined;
  let cursor = 0;
  return wrapToRows(line, width).map((text) => {
    const row: { text: string; tone?: 'add' | 'remove'; emphasis?: DiffEmphasis } = { text };
    if (tone !== undefined) row.tone = tone;
    if (mappable !== undefined && text !== '') {
      const found = line.indexOf(text, cursor);
      const at = found === -1 ? cursor : found;
      cursor = at + text.length;
      const start = Math.max(mappable.start, at) - at;
      const end = Math.min(mappable.end, at + text.length) - at;
      if (start < end) row.emphasis = { start, end };
    }
    return row;
  });
}

/**
 * The expanded input of one running call, as terminal rows.
 *
 * `expandedToolInput` bounds what is *read* — 100 logical lines, 8000 code points —
 * and that is not a height: measured at 80 columns, one 300-line file write came
 * back as 4 logical lines and **41 terminal rows**. This is the function that turns
 * the one unit into the other, and both the panel and the budget call it, so they
 * cannot disagree about how tall the panel is.
 */
export function toolInputRows(input: unknown, columns: number, toolName?: string): readonly BoundedContentRow[] {
  const width = Math.max(1, columns - TOOL_INPUT_INDENT.length);
  // The `!` pseudo-tool's "input" is its live output tail — already plain,
  // already bounded (`liveShellTail`) — so it is wrapped as-is rather than
  // JSON-stringified onto one escaped line.
  const lines =
    toolName === SHELL_TOOL_NAME && typeof input === 'string'
      ? input === '' ? [] : input.split('\n')
      : expandedToolInput(input, toolName);
  // Only fileEditor inputs are diff projections; a bash command that happens
  // to start with `- ` must not turn red — nor gain an emphasis span.
  const isDiff = toolName === 'fileEditor';
  const emphasis = isDiff ? diffLineEmphasis(lines) : [];
  return lines.flatMap((line, index) =>
    contentRows(line, width, isDiff ? diffLineTone(line) : undefined, emphasis[index]),
  );
}

/**
 * Whether one running call's detail rows are drawn. Ctrl+B's session-wide toggle
 * for real tools; always on for the `!` pseudo-tool, whose live output tail is
 * the point of running it. One predicate, used by both the claims computation in
 * `App.tsx` and the panel in `ToolCallPanel.tsx`, so what is counted and what is
 * drawn cannot be two different answers.
 */
export function toolDetailsVisible(toolName: string, toolDetailsExpanded: boolean): boolean {
  return toolDetailsExpanded || toolName === SHELL_TOOL_NAME;
}

/**
 * One permission detail block's value, as terminal rows. `diff` marks a block
 * whose value is diff text, and is what scopes the tone: a bash command whose
 * line starts with `- ` stays plain.
 */
export function permissionDetailRows(value: string, columns: number, diff = false): readonly BoundedContentRow[] {
  const width = Math.max(1, columns - PERMISSION_DETAIL_INDENT.length);
  const lines = permissionDetail(value);
  const emphasis = diff ? diffLineEmphasis(lines) : [];
  return lines.flatMap((line, index) =>
    contentRows(line, width, diff ? diffLineTone(line) : undefined, emphasis[index]),
  );
}

/** Rows the prompt region would draw with nothing bounding it. */
export function promptBoxWanted(input: {
  readonly draftRows: number;
  readonly completions: number;
  readonly moreCompletions: boolean;
  readonly hasHint: boolean;
  /** One bounded pending clipboard-image fact row. */
  readonly hasAttachment?: boolean;
  /** The prompt-recall indicator row; absent when no recall walk is open. */
  readonly hasRecall?: boolean;
  /** Search title plus these bounded match rows (and, when needed, one omission row). */
  readonly searchMatches?: number;
  readonly moreSearchMatches?: boolean;
}): number {
  const menu = input.completions > 0 ? 2 + input.completions + (input.moreCompletions ? 1 : 0) : 0;
  const search = input.searchMatches === undefined
    ? 0
    : 1 + input.searchMatches + (input.moreSearchMatches === true ? 1 : 0);
  return input.draftRows + menu + search + (input.hasAttachment === true ? 1 : 0) +
    (input.hasRecall === true ? RECALL_INDICATOR_ROWS : 0) + (input.hasHint ? 2 : 0);
}

/**
 * Rows the prompt-recall indicator draws when it is granted one.
 *
 * One, and it lives here rather than beside the walk it describes because this module
 * owns every row count in the region: a second definition is how a box comes to draw
 * one more row than the budget handed it.
 */
export const RECALL_INDICATOR_ROWS = 1;

/** Rows the tool panel would draw with nothing bounding it. */
export function toolPanelWanted(tools: readonly ToolRowsClaim[]): number {
  return tools.reduce((total, tool) => total + 1 + tool.detailRows, 0);
}

/** Rows the permission box would draw with nothing bounding it. */
export function permissionBoxWanted(blockRows: readonly number[], fixedRows = PERMISSION_BOX_FIXED_ROWS): number {
  return fixedRows + blockRows.reduce((total, rows) => total + rows + 2, 0);
}

/**
 * Width available to text inside the permission box: its border and `paddingX`.
 *
 * Not cosmetic arithmetic — wrapping the details to the terminal's width instead of
 * the box's made a 900-character value 25 rows tall by the budget's count and 27 by
 * Ink's, which is a cleared screen at 40 columns.
 */
export const PERMISSION_BOX_CHROME_COLUMNS = 4;

/* ------------------------------------------------------------------ the draft */

/** The rows of the draft a bounded prompt region can show, and what it hides. */
export interface DraftWindow {
  /** First layout row drawn. */
  readonly start: number;
  /** One past the last layout row drawn. */
  readonly end: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
  /** Draw the line about the hidden rows; false when there was no row to spare. */
  readonly notice: boolean;
}

/**
 * The window of draft rows to draw: the newest rows that fit, moved to keep the
 * cursor inside.
 *
 * A draft is not an answer — the row being edited must be visible whatever the
 * scroll position implies, because rows Ink dropped are rows the cursor cannot be
 * seen on. Exactly one row is reserved for the notice whenever anything is hidden,
 * above and below together, so the height is decided in one step instead of
 * depending on a window it has not chosen yet. With a single row to spend, the row
 * the cursor is on wins over the line that would say rows are missing.
 */
export function draftWindow(totalRows: number, cursorRow: number, maxRows: number): DraftWindow {
  if (maxRows <= 0) return { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: totalRows, notice: false };
  if (totalRows <= maxRows) return { start: 0, end: totalRows, hiddenAbove: 0, hiddenBelow: 0, notice: false };

  const notice = maxRows > 1;
  const capacity = maxRows - (notice ? 1 : 0);
  const start = Math.max(0, Math.min(cursorRow - capacity + 1, totalRows - capacity));
  const end = Math.min(totalRows, start + capacity);
  return { start, end, hiddenAbove: start, hiddenBelow: totalRows - end, notice };
}

/** One line about the draft rows that are not on screen. */
export function hiddenDraftNotice(hiddenAbove: number, hiddenBelow: number): string {
  const parts: string[] = [];
  if (hiddenAbove > 0) parts.push(`${hiddenAbove} above`);
  if (hiddenBelow > 0) parts.push(`${hiddenBelow} below`);
  const total = hiddenAbove + hiddenBelow;
  return `… ${total} draft ${total === 1 ? 'row' : 'rows'} not shown (${parts.join(', ')})`;
}

/** How a bounded prompt region spends its rows. */
export interface PromptBoxPlan {
  /** Rows granted to the draft window, notice included. */
  readonly draftRows: number;
  /** Completion entries to draw; `0` leaves the menu out entirely. */
  readonly completionItems: number;
  /** Draw the `… n more` line under the entries. */
  readonly completionMore: boolean;
  /** Draw the search title row. */
  readonly search: boolean;
  /** Prompt-history search match rows to draw under its title row. */
  readonly searchItems: number;
  /** Draw the search omission row after visible matches. */
  readonly searchMore: boolean;
  /** Draw the pending clipboard-image fact row. */
  readonly attachment: boolean;
  /** Draw the prompt-recall indicator row. */
  readonly recall: boolean;
  /** Draw the status hint. */
  readonly hint: boolean;
}

/**
 * Splits the prompt region's grant between draft, completion menu, recall indicator
 * and hint.
 *
 * The draft keeps a floor first (its cursor row, plus the notice row it needs as
 * soon as it is windowed), then the menu — a list of commands nobody can see is a
 * list nobody uses — then the recall indicator, then the hint, which is the only
 * purely informational row here and so the first to go. Whatever is left goes back to
 * the draft, which is why an idle terminal shows a long draft in full.
 *
 * Recall outranks the hint and yields to the menu on purpose: it is the one row that
 * says *why the draft just changed under the user's hands*, so it is worth more than a
 * standing reminder of which commands exist — and worth less than the list the other
 * arrow key is currently driving.
 */
export function planPromptBox(input: {
  readonly maxRows: number;
  readonly draftRows: number;
  readonly completions: number;
  readonly moreCompletions: boolean;
  readonly hasHint: boolean;
  readonly hasAttachment?: boolean;
  /** A recall walk is open, so the indicator wants its one row. */
  readonly hasRecall?: boolean;
  /** Search title plus a bounded result list; absent when search is closed. */
  readonly searchMatches?: number;
  readonly moreSearchMatches?: boolean;
}): PromptBoxPlan {
  const maxRows = Math.max(0, input.maxRows);
  const draftFloor = Math.min(maxRows, input.draftRows <= 1 ? 1 : 2);
  let spare = maxRows - draftFloor;

  // Search is modal within the editor: while open it replaces completion/recall chrome.
  // Its title is useful even for loading, empty and no-match states. A partly granted
  // result list spends its last row saying what was hidden.
  let search = false;
  let searchItems = 0;
  let searchMore = false;
  if (input.searchMatches !== undefined && spare >= 1) {
    search = true;
    const matches = Math.max(0, input.searchMatches);
    const matchRows = Math.max(0, spare - 1);
    searchMore = input.moreSearchMatches === true || matchRows < matches;
    const omissionRows = searchMore && matchRows > 0 ? 1 : 0;
    searchItems = Math.min(matches, Math.max(0, matchRows - omissionRows));
    searchMore = searchMore && matchRows > 0;
    spare -= 1 + searchItems + (searchMore ? 1 : 0);
  }

  // marginTop + the "commands (…)" title + one row per entry + the overflow line.
  const menuWanted = input.searchMatches === undefined && input.completions > 0
    ? 2 + input.completions + (input.moreCompletions ? 1 : 0)
    : 0;
  const menuRows = Math.min(menuWanted, Math.max(0, spare));
  // A partly granted menu pays for its own "… n more" row out of the grant, so the
  // entries it drops are not dropped silently.
  const moreRow = menuRows < menuWanted ? 1 : input.moreCompletions ? 1 : 0;
  const completionItems = Math.max(0, Math.min(input.completions, menuRows - 2 - moreRow));
  // Two rows of chrome with no entry under them says less than nothing, so a menu
  // that cannot show one entry costs nothing at all.
  if (completionItems > 0) spare -= menuRows;
  // The pending attachment is actionable editor state, so it precedes recall/hint.
  const attachmentRows = input.hasAttachment === true && spare >= 1 ? 1 : 0;
  spare -= attachmentRows;



  // One row, or it is not drawn at all — the same all-or-nothing rule the hint has.
  const recallRows = input.hasRecall === true && spare >= RECALL_INDICATOR_ROWS ? RECALL_INDICATOR_ROWS : 0;
  spare -= recallRows;

  // The hint is one row plus the blank row above it, or it is not drawn: a block
  // granted half of what it draws is exactly how a frame outgrows its budget.
  const hintRows = input.hasHint && spare >= 2 ? 2 : 0;
  spare -= hintRows;

  return {
    draftRows: draftFloor + Math.max(0, spare),
    completionItems,
    completionMore: completionItems > 0 && moreRow === 1,
    search,
    searchItems,
    searchMore,
    attachment: attachmentRows > 0,
    recall: recallRows > 0,
    hint: hintRows > 0,
  };
}

/* ------------------------------------------------------------- the tool panel */

/** One running tool call's row claim. */
export interface ToolRowsClaim {
  /** Rows of expanded input this call would draw. */
  readonly detailRows: number;
}

/** What a bounded tool panel draws. */
export interface ToolPanelPlan {
  /** Per shown call: rows of input drawn, and rows of input it had to leave out. */
  readonly entries: readonly { readonly detailRows: number; readonly hiddenDetailRows: number }[];
  /** Calls with no row at all; drawn as one collapsed line. */
  readonly hiddenTools: number;
}

/**
 * Fits the running calls into `maxRows`.
 *
 * Summaries come before detail: a call the user cannot see is a call they do not
 * know is running, while expanded input is a display preference they toggled and
 * can toggle back. When even the summaries do not fit, the last row becomes the
 * collapsed count — one row that says how many calls it is standing in for.
 *
 * An entry costs `1 + detailRows + (hiddenDetailRows > 0 ? 1 : 0)` rows: the
 * summary, the input rows, and the row spent saying what was left out. That notice
 * row is why a call whose detail is cut to nothing reports nothing — with no free
 * row there is nowhere to say it, and the panel would otherwise overflow to
 * apologise. The `tool details: expanded` notice in history still records the mode.
 */
export function planToolPanel(tools: readonly ToolRowsClaim[], maxRows: number): ToolPanelPlan {
  // No rows at all means an invisible panel: there is nowhere to even say that a
  // call is running. `frameBudget` reports that as `degraded`.
  if (tools.length === 0 || maxRows <= 0) {
    return { entries: [], hiddenTools: 0 };
  }

  if (tools.length > maxRows) {
    const shown = Math.max(0, maxRows - 1);
    return {
      entries: tools.slice(0, shown).map(() => ({ detailRows: 0, hiddenDetailRows: 0 })),
      hiddenTools: tools.length - shown,
    };
  }

  let spare = maxRows - tools.length;
  const entries = tools.map((tool) => {
    if (tool.detailRows === 0 || spare <= 0) return { detailRows: 0, hiddenDetailRows: 0 };
    if (tool.detailRows <= spare) {
      spare -= tool.detailRows;
      return { detailRows: tool.detailRows, hiddenDetailRows: 0 };
    }
    // One of the granted rows pays for the notice, so detail never just stops.
    const drawn = spare - 1;
    spare = 0;
    return drawn <= 0
      ? { detailRows: 0, hiddenDetailRows: 0 }
      : { detailRows: drawn, hiddenDetailRows: tool.detailRows - drawn };
  });

  return { entries, hiddenTools: 0 };
}

/** One line about tool input rows that did not fit. */
export function hiddenDetailNotice(hiddenRows: number): string {
  return `… ${hiddenRows} more input ${hiddenRows === 1 ? 'row' : 'rows'} not shown`;
}

/** One line standing in for the calls the panel had no room for. */
export function hiddenToolsNotice(hiddenTools: number): string {
  return `… ${hiddenTools} more tool ${hiddenTools === 1 ? 'call' : 'calls'} running`;
}

/* --------------------------------------------------------- the queued listing */

/** What a bounded queued-messages listing draws (SER-027). */
export interface QueueListPlan {
  /** Entries drawn, oldest (next to send) first; each is one row. */
  readonly shown: number;
  /** Entries standing behind the `… n more queued` row. */
  readonly hiddenEntries: number;
}

/** Rows the queued listing would draw with nothing bounding it: one per entry. */
export function queueListWanted(entries: number): number {
  return entries;
}

/**
 * Fits the queued listing into `maxRows`.
 *
 * The head of the queue is what drains next, so when rows run out the oldest
 * entries stay and one row states the rest — the same truncation vocabulary as
 * the tool panel. A single granted row for several entries goes entirely to the
 * notice: one entry shown while others hide silently would misstate the queue.
 */
export function planQueueList(entries: number, maxRows: number): QueueListPlan {
  if (entries <= 0 || maxRows <= 0) return { shown: 0, hiddenEntries: entries };
  if (entries <= maxRows) return { shown: entries, hiddenEntries: 0 };
  const shown = Math.max(0, maxRows - 1);
  return { shown, hiddenEntries: entries - shown };
}

/** One line standing in for the queued entries the listing had no room for. */
export function hiddenQueuedNotice(hiddenEntries: number): string {
  return `… ${hiddenEntries} more queued`;
}

/* --------------------------------------------------------- the permission box */

/**
 * Rows the box costs before any detail: the border, the heading, the summary, and
 * the decision row with the blank row above it.
 */
export const PERMISSION_BOX_FIXED_ROWS = 6;

/** What a bounded permission box draws. */
export interface PermissionBoxPlan {
  /** Rows of each detail block, in order; a block granted 0 rows is hidden. */
  readonly blocks: readonly { readonly rows: number; readonly hiddenRows: number }[];
  /** Blocks with no rows at all. */
  readonly hiddenBlocks: number;
  /** Draw the box without its border and detail blocks: the question only. */
  readonly compact: boolean;
  /** Draw the summary row. False only when a single row is left for the question. */
  readonly summary: boolean;
  /** Draw the line about what was left out. */
  readonly notice: boolean;
}

/**
 * Fits the permission box into `maxRows`.
 *
 * The heading, the summary and the decision row are never what yields: a prompt
 * whose question scrolled off the frame is a prompt that cannot be answered, and
 * this is the one box in the TUI where a silently shortened view would be a
 * security problem rather than a cosmetic one. So detail is cut from the bottom,
 * every cut is counted, and the row that states the cut is reserved before any
 * detail is handed out.
 *
 * `fixedRows` is passed in rather than assumed: on a narrow terminal the heading
 * and the decision row wrap, and a box that budgeted one row for each of them
 * would overflow by exactly the rows it did not count.
 *
 * Below the fixed cost the box drops its border and its details rather than its
 * question, and keeps stating what it hid for as long as it has a row for it. The
 * last thing standing, at one row, is `allow?` itself.
 */
export function planPermissionBox(
  blockRows: readonly number[],
  maxRows: number,
  fixedRows = PERMISSION_BOX_FIXED_ROWS,
): PermissionBoxPlan {
  const wanted = blockRows.reduce((total, rows) => total + rows + 2, 0);
  const detailBudget = maxRows - fixedRows;
  const needsNotice = wanted > Math.max(0, detailBudget);

  if (maxRows < fixedRows + (needsNotice ? 1 : 0)) {
    // Compact: the decision row, then the summary, then the line about what is
    // missing — in that order, because that is the order they stop being optional.
    return {
      blocks: blockRows.map((rows) => ({ rows: 0, hiddenRows: rows })),
      hiddenBlocks: blockRows.length,
      compact: true,
      summary: maxRows >= 2,
      notice: maxRows >= 3 && wanted > 0,
    };
  }

  let spare = detailBudget - (needsNotice ? 1 : 0);
  let hiddenBlocks = 0;
  const blocks = blockRows.map((rows) => {
    // A blank row and the label have to be paid before a single detail row shows.
    if (spare < 3) {
      hiddenBlocks += 1;
      return { rows: 0, hiddenRows: rows };
    }
    const granted = Math.min(rows, spare - 2);
    spare -= granted + 2;
    return { rows: granted, hiddenRows: rows - granted };
  });

  return { blocks, hiddenBlocks, compact: false, summary: true, notice: needsNotice };
}

/** One line about detail rows the box could not show. */
export function hiddenPermissionNotice(hiddenRows: number, hiddenBlocks: number): string {
  const rows = `${hiddenRows} detail ${hiddenRows === 1 ? 'row' : 'rows'}`;
  const blocks = hiddenBlocks > 0 ? ` in ${hiddenBlocks} hidden ${hiddenBlocks === 1 ? 'block' : 'blocks'}` : '';
  return `… ${rows}${blocks} not shown — the terminal is too short`;
}
