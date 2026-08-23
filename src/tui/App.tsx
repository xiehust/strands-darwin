/**
 * The TUI root and its state machine.
 *
 * Status transitions: `idle → streaming|compacting → idle`, with
 * `awaiting-permission` entered from `streaming` whenever the gate asks a
 * question and left when the user answers.
 *
 * Ctrl+C is handled here rather than by Ink (`exitOnCtrlC: false` at the render
 * call): during a turn the first press cancels that turn but keeps the session,
 * because losing a long conversation to a stray interrupt is worse than an
 * unfinished answer; a second press within a short window, or any press while
 * idle, exits. Ctrl+D always exits.
 */
import { Box, Text, useApp, useBoxMetrics, useInput, usePaste, useStdout, useWindowSize, type DOMElement } from 'ink';
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';

import { AGENTS_FILENAME, MAX_INSTRUCTIONS_BYTES } from '../agent/instructions.js';
import type { DiagnosticsLog } from '../agent/diagnostics.js';
import {
  APPROVAL_MODES,
  describeApprovalMode,
  isApprovalMode,
  type AllowRuleEntry,
  type PermissionDecision,
} from '../agent/permission.js';
import type { AgentRuntime, CompactResult, ContextEstimate, UsageTotals } from '../agent/runtime.js';
import { formatUsageValue, usageBuckets, usageRows, cacheEffectivenessRows, type UsageBuckets } from '../agent/usage.js';
import { runWithStreamResumption, STREAM_CONTINUATION_NOTICE } from '../agent/stream-resumption.js';

import { routeSdkLogs } from '../agent/sdk-logging.js';
import { SYSTEM_PROMPT_FILENAME } from '../agent/system-prompt.js';
import {
  isThinkingEffort,
  THINKING_EFFORTS,
  type ThinkingPlan,
} from '../agent/thinking.js';
import { CONFIG_FILENAME } from '../config.js';
import type { AppConfig, ModelChoice } from '../config.js';
import { BUILTIN_COMMAND_NAMES } from '../commands/custom-commands.js';
import { MCP_CONFIG_FILENAME, mcpConfigCandidates } from '../mcp/registry.js';
import { DARWIN_DIRNAME } from '../paths.js';
import type { TrajectoryStatus } from '../trajectory/writer.js';
import { exportTranscript } from '../trajectory/export.js';
import {
  readPromptHistory,
  type PromptHistory,
} from '../trajectory/prompt-history.js';
import {
  InputBox,
  MAX_COMPLETIONS,
  completionSelection,
  moveCompletionSelection,
  type CompletionKind,
} from './InputBox.js';
import { busySuffix } from './busy-suffix.js';
import { LIVE_BLOCK_CHROME_ROWS, wrapToRows } from './live-text.js';
import { fenceOpenAfter } from './markdown.js';
import {
  PERMISSION_BOX_FIXED_ROWS,
  frameBudget,
  promptBoxWanted,
  queueListWanted,
  toolDetailsVisible,
  toolInputRows,
  toolPanelWanted,
} from './frame-budget.js';
import { MessageList } from './MessageList.js';
import { PermissionPrompt, permissionBoxClaim } from './PermissionPrompt.js';
import { welcomeLayout } from './WelcomeHeader.js';
import { ActiveToolCalls } from './ToolCallPanel.js';
import { QueuedMessages } from './QueuedMessages.js';
import type { PermissionQueue } from './permission-queue.js';
import {
  backspaceAtCursor,
  deleteAtCursor,
  deleteWordBefore,
  insertAtCursor,
  killToRowEdge,
  layoutEditor,
  moveHorizontal,
  moveToRowEdge,
  moveVertical,
  type EditorValue,
} from './prompt-editor.js';
import {
  NO_WORKSPACE_PATHS,
  applyPathCompletion,
  matchWorkspacePaths,
  pathCompletionQuery,
  scanWorkspacePaths,
  workspacePathsNote,
  type WorkspacePaths,
} from './path-completion.js';
import {
  openPromptRecall,
  promptRecallIndicator,
  stepPromptRecall,
  type PromptRecall,
  type RecallDirection,
} from './prompt-recall.js';
import { queuedCountHint, refusesToQueue, takeBackDraft } from './prompt-queue.js';
import {
  composeShellReport,
  parseShellCommand,
  projectShellOutput,
  runShellCommand,
  type RunningShellCommand,
} from './shell-command.js';

import { formatTaskCompletion, formatTasksReport } from './task-format.js';
import { formatDispatchCompletion, formatDispatchesReport } from './subagent-format.js';
import { createContextWarnLatch, formatContextReport } from './context-format.js';
import { formatHelpReport } from './help-format.js';
import { formatMcpReport } from './mcp-format.js';
import { formatPromptCache, formatStatusReport, formatThinking } from './status-format.js';
import { PlanChecklist } from './PlanChecklist.js';
import { initialTurnState, turnReducer, type HistoryItem, type TurnAction } from './turn-state.js';
import { visualColor, visualMarker } from './visual-language.js';

/** Window in which a second Ctrl+C means "exit", not "cancel again". */
const DOUBLE_INTERRUPT_MS = 2000;
const SPINNER_INTERVAL_MS = 90;

/**
 * How long one workspace path scan is reused before the next `@` re-reads the tree.
 *
 * Long enough that completing `@src/tui/App.tsx` one segment at a time is a single
 * scan, short enough that a file the agent just wrote is offered the next time the
 * user reaches for it. Staleness is only ever a missing row: an accepted completion
 * is text, so a path that has since moved costs a wrong argument to a tool call the
 * user can see, not a silent read of the wrong file.
 */
const PATH_SCAN_TTL_MS = 5000;

/**
 * Header height assumed before the first layout pass: this project's own header,
 * rounded up. Guessing high only costs a few rows of the first streamed frame;
 * guessing low costs the scrollback.
 */
const ASSUMED_HEADER_ROWS = 14;

/** C0 controls except LF and tab, plus DEL: never treated as draft text. */
const NON_TEXT_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Erase the screen, the scrollback and home the cursor — Ink's own `clearTerminal`,
 * spelled out here because `ansi-escapes` is Ink's dependency and not darwin's.
 *
 * Written exactly once per `/clear`, through Ink's stdout writer. This is the same
 * sequence Ink's pathological over-tall-frame branch writes per render, which is what
 * `frame-budget.ts` exists to avoid: one deliberate clear on an explicit command is a
 * different thing from one per text delta.
 */
const CLEAR_TERMINAL = '\u001B[2J\u001B[3J\u001B[H';

/** Canonicalizes terminal line endings and drops controls without losing layout. */
function normalizeDraftText(value: string): string {
  return value.replace(/\r+\n/g, '\n').replace(/\r/g, '\n').replace(NON_TEXT_CONTROLS, '');
}

type Status = 'idle' | 'streaming' | 'shell' | 'compacting' | 'awaiting-permission';

export function App({
  runtime: initialRuntime,
  permissions,
  initialHistory = [],
  startNewSession,
}: {
  readonly runtime: AgentRuntime;
  readonly permissions: PermissionQueue;
  /** Read-only resumed-session context, written once through the existing Static transcript. */
  readonly initialHistory?: readonly HistoryItem[];
  /**
   * Hands this conversation to a new, empty session and returns the runtime that owns
   * it — `/clear`. Optional so a driver that does not own runtime lifecycle (and so
   * could not shut the successor down) simply does not offer the command.
   */
  readonly startNewSession?: () => Promise<AgentRuntime>;
}): React.JSX.Element {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const { write: writeToTerminal } = useStdout();
  // The live session. A prop at startup, state afterwards: `/clear` replaces the
  // runtime rather than resetting one, so everything read off it — session id, usage
  // meter, trajectory recorder, context estimate — moves to the new session together,
  // and the old session's numbers cannot leak into the new transcript.
  const [runtime, setRuntime] = useState(initialRuntime);
  const [state, recordAction] = useReducer(
    turnReducer,
    initialHistory,
    (history): typeof initialTurnState => ({ ...initialTurnState, history: [...history] }),
  );
  // The ready welcome is process/App-scoped, not session-scoped. Capture its
  // complete responsive variant once so a later resize cannot mutate an item
  // that Ink's Static has already committed to scrollback.
  const [initialWelcome] = useState(() => welcomeLayout(columns, rows));
  // Swapped whole rather than branched per call: with `diagnostics` off — the default —
  // `dispatch` *is* the reducer's own dispatch, so not one of the ~50 notice sites
  // below pays anything, and the mirror cannot be forgotten at a new one either.
  const dispatch = useMemo(
    () => withNoticeDiagnostics(recordAction, runtime.diagnostics),
    [recordAction, runtime],
  );
  const [status, setStatus] = useState<Status>('idle');
  const [editor, setEditorState] = useState<EditorValue>({
    text: '',
    cursor: { offset: 0, affinity: 'downstream' },
  });
  // React may render after several stdin events have already arrived. Keep one
  // immediate editor mirror so batched events cannot read different generations
  // of the draft and cursor.
  const editorRef = useRef(editor);
  const setEditor = useCallback((next: EditorValue | ((current: EditorValue) => EditorValue)) => {
    const value = typeof next === 'function' ? next(editorRef.current) : next;
    editorRef.current = value;
    setEditorState(value);
  }, []);
  const draft = editor.text;
  const layout = layoutEditor(draft, columns, editor.cursor);
  const preferredColumn = useRef<number | undefined>(undefined);

  // The frame's fixed furniture. Only the header is *measured*: its height depends
  // on nothing below it, so measuring it cannot oscillate. Everything else states
  // what it wants and `frameBudget` hands out the rows — see `frame-budget.ts` for
  // why the round-1 arrangement (measure the chrome, give the answer the rest) was
  // not enough once the chrome turned out to be unbounded too.
  const headerRef = useRef<DOMElement>(null);
  const chromeRef = useRef<DOMElement>(null);
  const header = useBoxMetrics(headerRef);
  // Still measured, but only for the cursor: `useBoxMetrics` is parent-relative and
  // `useCursor` is frame-absolute, so `InputBox` needs its parent's offset.
  const chrome = useBoxMetrics(chromeRef);

  // Like the editor and recall mirrors below, completion selection must advance on
  // each stdin event immediately. The visible marker and Tab/Enter acceptance then
  // read the same full-list identity even when a terminal batches arrow keys.
  const [selectedCompletion, setSelectedCompletionState] = useState(0);
  const selectedCompletionRef = useRef(selectedCompletion);
  const setSelectedCompletion = useCallback((next: number | ((current: number) => number)) => {
    const value = typeof next === 'function' ? next(selectedCompletionRef.current) : next;
    selectedCompletionRef.current = value;
    setSelectedCompletionState(value);
  }, []);
  const [frame, setFrame] = useState(0);
  const interruptedAt = useRef<number | undefined>(undefined);
  /** Wall-clock start of the in-flight turn; undefined whenever no turn is running. */
  const turnStartedAt = useRef<number | undefined>(undefined);
  const contextWarnLatch = useRef(createContextWarnLatch());
  /** One trajectory-problem notice per session; the recorder latches the failure itself. */
  const trajectoryWarned = useRef(false);
  /** Same, once, for the diagnostics log: it latches its own failure too. */
  const diagnosticsWarned = useRef(false);
  /** One bounded learned-memory degradation notice per runtime. */
  const memoryWarned = useRef(false);
  /** True while `/clear` is assembling the successor runtime; see the handler. */
  const clearing = useRef(false);
  /** Kill handle of the running `!` command; undefined whenever none is running. */
  const shellRun = useRef<RunningShellCommand | undefined>(undefined);
  /** Distinguishes the live panel rows of successive `!` commands. */
  const shellRunCount = useRef(0);
  /**
   * Bounded `!` reports awaiting the next model-bound prompt (PRD D5). They ride
   * ahead of that prompt's text through the ordinary send path — never injected
   * into `agent.messages`, never a turn of their own — and `/clear` drops them
   * with the conversation they were destined for.
   */
  const pendingShellReports = useRef<string[]>([]);
  /**
   * The prompt queue (SER-027, superseding SER-010's no-queue contract by explicit
   * user decision): submissions made while a turn streams or a `!` command runs,
   * oldest first. Drained one entry per idle through the ordinary submit path;
   * taken back into the editor by `Up`; returned unsent after a cancel or a failed
   * turn; dropped by `/clear` with the conversation. The ref is the same
   * immediate mirror `editorRef` is: batched stdin events must read one
   * generation of the queue.
   */
  const [queued, setQueuedState] = useState<readonly string[]>([]);
  const queuedRef = useRef(queued);
  const setQueued = useCallback((next: readonly string[]) => {
    queuedRef.current = next;
    setQueuedState(next);
  }, []);
  /** True from a user Ctrl+C (or a turn failure) until the busy state it aborted ends. */
  const turnAborted = useRef(false);
  /** Latch: one queue entry in flight through submit(); see the drain effect. */
  const draining = useRef(false);
  /** Re-arms the drain effect after an entry whose submit left every dep unchanged. */
  const [drainCycle, setDrainCycle] = useState(0);

  const pendingPermission = useSyncExternalStore(
    (onChange) => permissions.subscribe(onChange),
    permissions.getSnapshot,
    permissions.getSnapshot,
  );

  // A pending confirmation outranks streaming: the loop is blocked on it.
  const effectiveStatus: Status = pendingPermission !== undefined ? 'awaiting-permission' : status;

  // Built-ins stay first, then project commands, then skills. Collision filtering
  // happens in the command loader so every row here is actually invokable.
  const commandCompletions = computeCompletions(draft, [
    ...BUILTIN_COMMAND_NAMES,
    ...runtime.info.commandNames,
    ...runtime.info.skillNames,
  ]);

  // The second source, consulted only when the first has nothing: a `/prefix` and an
  // `@` mention cannot both be under the cursor, but deciding it in one place keeps
  // "which menu is this" a fact rather than a coincidence of two predicates.
  const pathQuery = commandCompletions.length > 0
    ? undefined
    : pathCompletionQuery(draft, editor.cursor.offset);
  const [workspacePaths, setWorkspacePaths] = useState<WorkspacePaths>(NO_WORKSPACE_PATHS);
  // Scan bookkeeping lives in a ref so a finished scan cannot re-trigger the effect
  // that started it. Keyed on the project root: `/clear` hands over a new runtime
  // for the same tree, and re-reading it for that would be work for nothing.
  const pathScan = useRef({ root: '', scannedAt: 0, inFlight: false });
  const pathMenuOpen = pathQuery !== undefined;
  const pathQueryText = pathQuery?.text;

  // Nothing here is awaited by a keystroke: the editor renders from whatever the last
  // scan produced (nothing, on the first `@`) and re-renders when one lands. Started
  // by the first trigger rather than at startup, so a session that never mentions a
  // path never walks the tree at all.
  useEffect(() => {
    if (!pathMenuOpen) return;
    const root = runtime.info.projectRoot;
    const state = pathScan.current;
    if (state.inFlight) return;
    if (state.root === root && Date.now() - state.scannedAt < PATH_SCAN_TTL_MS) return;
    state.root = root;
    state.inFlight = true;
    // Deliberately not cancelled when the query closes: the reading describes the
    // tree, not the query, so keeping it is what makes the *next* `@` instant. A
    // discarded result would also have to un-stamp `scannedAt`, or a query abandoned
    // mid-scan would leave the menu empty for the whole TTL.
    void scanWorkspacePaths(root)
      .then(setWorkspacePaths)
      .finally(() => {
        state.inFlight = false;
        state.scannedAt = Date.now();
      });
  }, [pathMenuOpen, runtime]);

  const pathCompletions = useMemo(
    () => (pathQueryText === undefined ? [] : matchWorkspacePaths(workspacePaths.paths, pathQueryText)),
    [pathQueryText, workspacePaths],
  );

  // Prompt recall. `undefined` history means "not read yet", which is a different
  // answer from an empty reading and is stated as such on the indicator row: claiming
  // a project has no earlier prompts before its record has been opened would be a lie
  // in the one row the user is reading.
  const [history, setHistory] = useState<PromptHistory | undefined>(undefined);
  const [recall, setRecallState] = useState<PromptRecall | undefined>(undefined);
  // Same immediate-mirror reason as `editorRef`: several stdin events can be batched
  // into one React pass, and two Up presses in that pass must walk two entries.
  const recallRef = useRef(recall);
  const setRecall = useCallback((next: PromptRecall | undefined) => {
    recallRef.current = next;
    setRecallState(next);
  }, []);
  // Read bookkeeping, in a ref for the same reason the path scan's is: a landed read
  // must not re-trigger the thing that started it. `stale` is set when a turn ends —
  // that is when the turn's own `userInput` line reaches the file (one append per turn),
  // so the next Up re-reads instead of offering a history that stops one prompt short.
  const historyRead = useRef({ root: '', inFlight: false, stale: true });
  const requestHistory = useCallback(() => {
    const root = runtime.info.projectRoot;
    const state = historyRead.current;
    if (state.inFlight) return;
    if (state.root === root && !state.stale) return;
    state.root = root;
    state.inFlight = true;
    state.stale = false;
    // Never awaited by a keystroke, exactly like the workspace scan: the editor renders
    // from whatever the last reading produced (nothing, on the very first Up) and
    // re-renders when one lands. `readPromptHistory` cannot reject.
    void readPromptHistory(root)
      .then(setHistory)
      .finally(() => {
        state.inFlight = false;
      });
  }, [runtime]);

  const completionKind: CompletionKind = commandCompletions.length > 0 ? 'command' : 'path';
  const completions = completionKind === 'command' ? commandCompletions : pathCompletions;
  const completionNote =
    completionKind === 'path' && completions.length > 0 ? workspacePathsNote(workspacePaths) : undefined;
  // One row while a walk is open, composed where the walk lives so the budget below and
  // the box that draws it are counting the same thing.
  const recallIndicator = recall === undefined ? undefined : promptRecallIndicator(recall);

  // Every participant of the redrawn frame states what it wants; the header is the
  // only one measured. The grants are what each box is then allowed to draw, and
  // `frame-budget.ts` owns the priority between them (prompt, tools, answer) as
  // well as the share ceiling that stops the first from taking everything.
  //
  // The busy rows' live readout, recomputed on every spinner tick below: elapsed
  // wall clock from the turn's start ref, spend from `runtime.usage` — a synchronous
  // in-memory read of the SDK's accumulator, which counts a model call when it
  // finishes (the same reading mid-turn `/usage` reports as "not counted yet").
  // No second interval, no I/O, and nothing of it while idle or compacting.
  const busyElapsedMs = effectiveStatus === 'streaming' && turnStartedAt.current !== undefined
    ? Date.now() - turnStartedAt.current
    : undefined;
  const streamingHint = hintForStatus(
    effectiveStatus,
    busyElapsedMs === undefined ? undefined : busySuffix(busyElapsedMs, liveSpend(runtime)),
    queued.length,
  );
  const activeToolClaims = state.activeTools.map((tool) => ({
    detailRows: toolDetailsVisible(tool.name, state.toolDetailsExpanded)
      ? toolInputRows(tool.input, columns, tool.name).length
      : 0,
  }));
  const offeredCompletions = Math.min(completions.length, MAX_COMPLETIONS);
  const liveTextRows = state.liveText === '' ? 0 : wrapToRows(state.liveText, columns).length;
  const thinkingRows = state.thinking && effectiveStatus === 'streaming' ? 1 : 0;

  const grants = frameBudget({
    rows,
    headerRows: header.hasMeasured ? header.height : ASSUMED_HEADER_ROWS,
    thinkingRows,
    prompt:
      pendingPermission === undefined
        ? {
            wanted: promptBoxWanted({
              draftRows: layout.rows.length,
              completions: offeredCompletions,
              moreCompletions: completions.length > offeredCompletions,
              hasHint: streamingHint !== undefined,
              hasRecall: recallIndicator !== undefined,
            }),
            // The row the cursor is on. Everything else in the region can go.
            floor: 1,
          }
        : {
            wanted: permissionBoxClaim(pendingPermission, permissions.waiting, columns),
            // The box keeps its heading, summary and decision row while it can:
            // a question that scrolled off the frame blocks the agent loop.
            floor: PERMISSION_BOX_FIXED_ROWS,
            // And it is never asked to share with the call it is asking about: it
            // is modal, so those rows are not what the answer or the spinner need.
            modal: true,
          },
    tools: {
      wanted: toolPanelWanted(activeToolClaims),
      floor: activeToolClaims.length > 0 ? 1 : 0,
    },
    plan: {
      wanted: state.livePlan.length === 0 ? 0 : state.livePlan.length + 1,
      // One row still names the checklist and states its full item count.
      floor: state.livePlan.length === 0 ? 0 : 1,
    },
    // The queued listing (SER-027): one row per entry, cut entries stated by the
    // queue's own notice row. Floor 0 — the busy hint's count keeps a fully cut
    // listing from going invisible.
    queued: { wanted: queueListWanted(queued.length), floor: 0 },
    // The answer yields first: it is the one participant whose content is already
    // guaranteed to reach `<Static>` history in full.
    live: { wanted: liveTextRows === 0 ? 0 : liveTextRows + LIVE_BLOCK_CHROME_ROWS, floor: 0 },
  });

  // Spinner tick, while a model is actually streaming or a `!` command is running —
  // the running command's panel row carries the same spinner and elapsed suffix.
  // `/compact` waits on its own model calls too, but has no per-call tool panel to
  // animate.
  useEffect(() => {
    if (effectiveStatus !== 'streaming' && effectiveStatus !== 'shell') return;
    const timer = setInterval(() => setFrame((f) => f + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [effectiveStatus]);

  // A `!` command must not outlive the TUI that ran it: on unmount (Ctrl+D, /exit,
  // a second Ctrl+C) the group gets the same TERM→KILL reaping a cancel gives it.
  useEffect(() => () => shellRun.current?.kill(), []);

  // The SDK's default logger writes to the console, which tears this frame. It has
  // something to say now that `/model` exists: switching away from Claude with a
  // reasoning block in the history makes the OpenAI adapter warn, once per
  // request, that it is dropping it. Surfaced as a notice instead of swallowed —
  // the model is losing part of its own history and that is worth one line.

  useEffect(
    () => routeSdkLogs((entry) => dispatch({ type: 'notice', text: `sdk ${entry.level}: ${entry.message}`, severity: entry.level })),
    [dispatch],
  );

  // Where the diagnostics went, said once, in the transcript. A frame row is not an
  // option — the header shares its height with the permission box and the tool panel,
  // which is the contract `spike/verify-tui.ts approve` enforces on a 50-row terminal —
  // and a file nobody can find is a file nobody reads. Only when the run asked for it.
  useEffect(() => {
    const file = runtime.info.diagnosticsFile;
    if (file === undefined) return;
    dispatch({ type: 'notice', text: `diagnostics: recording SDK debug/info to ${file}` });
  }, [dispatch, runtime]);

  // Terminal task events are transcript-only observers: they never alter turn
  // status, active tools, permissions, or the agent loop. React dispatch also
  // causes an immediate idle render; cleanup prevents shutdown notices after exit.
  useEffect(
    () => runtime.subscribeToBackgroundTasks((task) => {
      dispatch({ type: 'notice', text: formatTaskCompletion(task) });
    }),
    [runtime],
  );

  // Same observer-only contract for finished delegations: a notice, never a status
  // change. Concurrent children finish in an order nobody scripted, so a dispatch
  // that ends mid-turn (or while a prompt is up) has to be able to say so without
  // touching the live frame's ownership.
  useEffect(
    () => runtime.subscribeToSubagentDispatches((dispatched) => {
      dispatch({ type: 'notice', text: formatDispatchCompletion(dispatched) });
    }),
    [runtime],
  );

  /**
   * Puts every queued entry back into the editor, unsent — ahead of any typed
   * text, one per line, cursor at the end — and says so. The take-back gesture
   * and the post-abort return share this so "what a cancel does to the queue"
   * and "what `Up` does to the queue" cannot drift apart; `withNotice` is the
   * only difference (the gesture explains itself).
   */
  const returnQueuedToEditor = useCallback((withNotice: boolean): boolean => {
    const entries = queuedRef.current;
    if (entries.length === 0) return false;
    const text = takeBackDraft(entries, editorRef.current.text);
    setQueued([]);
    setEditor({ text, cursor: { offset: text.length, affinity: 'upstream' } });
    preferredColumn.current = undefined;
    setSelectedCompletion(0);
    if (withNotice) {
      dispatch({
        type: 'notice',
        text: `${entries.length} queued ${entries.length === 1 ? 'message' : 'messages'} returned to the editor, not sent`,
      });
    }
    return true;
  }, [dispatch, setEditor, setQueued]);

  const runTurn = useCallback(
    async (text: string) => {
      turnStartedAt.current = Date.now();
      turnAborted.current = false;
      setStatus('streaming');
      try {
        await runWithStreamResumption(
          text,
          async (turnInput) => {
            for await (const event of runtime.send(turnInput)) {
              dispatch({ type: 'streamEvent', event });
            }
          },
          (error) => {
            // The failed attempt is a complete transcript/trajectory fact before the
            // next ordinary turn starts. Keep the busy owner and queued work intact.
            dispatch({ type: 'turnEnded' });
            dispatch({
              type: 'notice',
              text: `turn failed: ${error.message}`,
              severity: 'error',
            });
            dispatch({ type: 'notice', text: STREAM_CONTINUATION_NOTICE, severity: 'warn' });
          },
        );
        await runtime.markResumable();
      } catch (error) {
        // A failed turn must not kill the session; the user may want to retry.
        // It also must not send the queue: auto-resending into an error is how
        // retry loops start, so the queue is returned to the editor below.
        turnAborted.current = true;
        dispatch({
          type: 'notice',
          text: `turn failed: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'error',
        });
      } finally {
        dispatch({ type: 'turnEnded' });
        setStatus('idle');
        // Cleared with the status, so a cancelled or failed turn stops the busy
        // readout in the same breath as the tick that was redrawing it.
        turnStartedAt.current = undefined;
        interruptedAt.current = undefined;
        // The turn's own `userInput` line reaches the record when the turn closes (one
        // append per turn), so this is the moment the reading in memory is one prompt
        // short. Marked, never re-read here: the next `Up` pays for it, and a session
        // that never recalls never opens the file at all.
        historyRead.current.stale = true;
      }

      // A cancelled or failed turn never silently sends the queue (SER-027): what
      // was queued behind it comes back to the editor, visible and unsent, and the
      // drain effect below finds nothing to send.
      if (turnAborted.current) {
        turnAborted.current = false;
        returnQueuedToEditor(true);
      }

      // Post-turn context-pressure check: reuse the configurable warning latch
      // and existing Static transcript notice — no second threshold or live row.
      // Compaction remains an explicit user command. A failed estimate is silently
      // dropped so this advisory path cannot mask the completed turn above it.
      try {
        const estimate = await runtime.contextEstimate();
        const notice = contextWarnLatch.current.check(estimate, runtime.config.contextWarnRatio);
        if (notice !== null) dispatch({ type: 'notice', text: notice, severity: 'warn' });
      } catch {
        // best-effort
      }

      // Same shape for the trajectory: read after the turn, never during it, and at
      // most once per session. The recorder latches its first failure, so this says
      // "the record stopped here" exactly when that is news — a session that keeps
      // working with a short record must not do so silently.
      const trajectoryProblem = runtime.trajectoryStatus?.problem;
      if (trajectoryProblem !== undefined && !trajectoryWarned.current) {
        trajectoryWarned.current = true;
        dispatch({
          type: 'notice',
          text: `trajectory: ${trajectoryProblem}`,
          // The session is unaffected, so this is a degradation, not a failure.
          severity: 'warn',
        });
      }

      // And the same for the diagnostics log, on the same terms: it latched, the turn
      // did not notice, and the user has to be told once that the file they are tailing
      // stopped growing — including when it stopped because it filled its budget.
      const diagnosticsProblem = runtime.diagnosticsStatus?.problem;
      if (diagnosticsProblem !== undefined && !diagnosticsWarned.current) {
        diagnosticsWarned.current = true;
        dispatch({ type: 'notice', text: `diagnostics: ${diagnosticsProblem}`, severity: 'warn' });
      }

      const memoryProblem = runtime.memoryStatus?.problem;
      if (memoryProblem !== undefined && !memoryWarned.current) {
        memoryWarned.current = true;
        dispatch({ type: 'notice', text: `learned memory: ${memoryProblem}`, severity: 'warn' });
      }

    },
    [returnQueuedToEditor, runtime],
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (text === '') return;

      // A bounded pure projection of canonical commands and fixed input controls.
      // It owns every whitespace-separated /help form before the busy guard, so an
      // argument is rejected locally and a valid report remains available while a
      // turn or user `!` command is running. No runtime accessor, tool, or I/O is
      // involved; the existing transcript notice is its only output surface.
      if (/^\/help(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        dispatch({
          type: 'notice',
          text: text === '/help' ? formatHelpReport() : '/help takes no arguments',
        });
        return;
      }

      // Answered from the SDK's meter, never sent to the model: a report on token
      // spend that costs a turn of its own would be self-defeating. Handled before
      // the busy check, so it also answers mid-turn — a long turn is exactly when
      // the question comes up, and reading a counter cannot disturb one.
      if (text === '/usage') {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        dispatch({
          type: 'notice',
          text: formatUsageReport(runtime.usage, runtime.config, runtime.info.resumed, status === 'streaming', runtime.lastTurnUsage),
        });
        return;
      }

      // Also before the busy check, and for a stronger reason than /usage: a turn
      // makes many model calls, so "think harder" is worth acting on while one is
      // running — the level applies from the next call on. It reconfigures the live
      // model rather than sending anything, so it cannot disturb the turn.
      if (text === '/effort' || text.startsWith('/effort ')) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        applyEffortCommand(runtime, text, dispatch);
        return;
      }

      // Before the busy check for the strongest reason of all: mid-turn is exactly
      // when the enforcement policy needs changing — the model is about to write
      // something that should have been planned first, or the user has stopped
      // wanting to confirm every call. It sends nothing and rebuilds nothing: the
      // gate takes the new mode for its next decision and withdraws any decision
      // still pending, so no call is judged half by one mode and half by another.
      if (text === '/mode' || text.startsWith('/mode ')) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        applyModeCommand(runtime, text, dispatch);
        return;
      }

      // Before the busy check for the same reason as /mode: revocation only ever
      // *narrows* what runs silently, and mid-turn is exactly when a rule that
      // turned out too broad needs pulling — the gate stops honouring it before
      // this handler returns, so the very next matching call prompts. User-only
      // like /mode: this never reaches the agent, and there is no tool that can
      // invoke it. Additions have no path through here; they stay exclusively
      // with the permission-prompt grant flow.
      if (text === '/permissions' || text.startsWith('/permissions ')) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        applyPermissionsCommand(runtime, text, dispatch);
        return;
      }

      // User-only local memory management. Like permission revocation, forgetting
      // narrows future context synchronously; remember is an explicit typed command,
      // never a model tool. Keep it idle-only so a running request cannot race a
      // system-prompt replacement.
      if (/^\/memory(?:\s|$)/.test(text)) {
        if (status !== 'idle') {
          dispatch({ type: 'notice', text: '/memory does not queue — run it after current work finishes' });
          return;
        }
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        try {
          const result = await runtime.manageMemory(text);
          dispatch({ type: 'notice', text: result.text });
        } catch (error) {
          dispatch({
            type: 'notice',
            text: `memory command failed: ${error instanceof Error ? error.message : String(error)}`,
            severity: 'warn',
          });
        }
        return;
      }


      // Reads the manager directly rather than entering the model/tool loop. Like
      // /usage it remains available mid-turn and cannot queue or cancel work.
      if (/^\/tasks(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        if (text !== '/tasks') {
          dispatch({ type: 'notice', text: '/tasks takes no arguments' });
          return;
        }
        try {
          const tasks = await runtime.listBackgroundTasks();
          dispatch({ type: 'notice', text: formatTasksReport(tasks) });
        } catch (error) {
          dispatch({
            type: 'notice',
            text: `could not list background tasks: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }

      // Reads the dispatch registry directly, exactly like /tasks reads the task
      // manager: no model call, no tool event, and available mid-turn — the moment
      // several children are working is when "who is running what" gets asked.
      if (/^\/agents(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        if (text !== '/agents') {
          dispatch({ type: 'notice', text: '/agents takes no arguments' });
          return;
        }
        dispatch({ type: 'notice', text: formatDispatchesReport(runtime.listSubagentDispatches()) });
        return;
      }

      // Free like /usage: the count is the SDK's character heuristic, so asking
      // costs nothing, sends nothing, and can be answered mid-turn — the moment
      // a long turn makes "how big has this grown" worth asking.
      if (/^\/context(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        if (text !== '/context') {
          dispatch({ type: 'notice', text: '/context takes no arguments' });
          return;
        }
        try {
          dispatch({ type: 'notice', text: formatContextReport(await runtime.contextEstimate()) });
        } catch (error) {
          dispatch({
            type: 'notice',
            text: `could not estimate context: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        return;
      }

      // Reads the recorder's own counters — no file access, no model call — so it
      // belongs with the other local reports above the busy check. Read-only by
      // design: search, fork and replay work over *past* sessions and live on the
      // `darwin trajectory` subcommand, where their output is not competing with a
      // live frame for height.
      if (/^\/trajectory(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        if (text !== '/trajectory') {
          dispatch({ type: 'notice', text: '/trajectory takes no arguments' });
          return;
        }
        dispatch({
          type: 'notice',
          text: formatTrajectoryReport(runtime.trajectoryStatus, runtime.info.sessionId),
          severity: runtime.trajectoryStatus?.problem === undefined ? 'info' : 'warn',
        });
        return;
      }

      // Writes this session's transcript — the same `formatReplay` projection the
      // `darwin trajectory replay` verb prints — to a file the user names. A pure
      // *reader* over the record, so it belongs with the local reports above the
      // busy check: reading mid-turn just sees the file one turn short, and the
      // small local write is awaited because the notice *is* its result. Every
      // outcome comes back as a notice; a failed export never costs the session.
      if (/^\/export(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        const outcome = await exportTranscript({
          argument: text.slice('/export'.length).trim(),
          projectRoot: runtime.info.projectRoot,
          sessionId: runtime.info.sessionId,
          recordFile: runtime.trajectoryStatus?.file,
        });
        dispatch({ type: 'notice', text: outcome.text, severity: outcome.severity });
        return;
      }

      // Reads the projection of the MCP clients the runtime already holds — no
      // model call, and deliberately no connection attempt, so asking about a
      // server cannot change its state. Available mid-turn like /tasks: a server
      // that failed at startup contributed zero tools silently, and "where did my
      // tools go" is asked exactly while the model is visibly not finding them.
      if (/^\/mcp(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        if (text !== '/mcp') {
          dispatch({ type: 'notice', text: '/mcp takes no arguments' });
          return;
        }
        const candidates = mcpConfigCandidates(runtime.info.projectRoot);
        dispatch({
          type: 'notice',
          text: formatMcpReport(runtime.listMcpServers(), {
            configPaths: runtime.info.mcpConfigPaths,
            overriddenServerNames: runtime.info.mcpOverriddenServerNames,
            ignoredConfigPath: runtime.info.mcpIgnoredConfigPath,
            candidatePaths: [candidates.global, candidates.preferred, candidates.fallback],
          }),
        });
        return;
      }

      // One consolidated read of state the session already holds (SER-026), on the
      // /mcp precedent: a formatter over existing accessors, never a new information
      // channel — no model call, no connection attempt, no mutation. Above the busy
      // check because a scrolled-away header is the use case, and mid-turn is when
      // "what is this session actually configured as" gets asked.
      if (/^\/status(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        if (text !== '/status') {
          dispatch({ type: 'notice', text: '/status takes no arguments' });
          return;
        }
        // The /context machinery, degraded rather than fatal: a failed estimate
        // costs one line of the report, never the report.
        let context: ContextEstimate | undefined;
        let contextProblem: string | undefined;
        try {
          context = await runtime.contextEstimate();
        } catch (error) {
          contextProblem = error instanceof Error ? error.message : String(error);
        }
        dispatch({
          type: 'notice',
          text: formatStatusReport({
            config: runtime.config,
            sessionId: runtime.info.sessionId,
            resumed: runtime.info.resumed,
            promptCache: runtime.promptCache,
            thinking: runtime.thinking,
            mode: runtime.permissionMode,
            allowRuleCount: runtime.allowRuleCount,
            mcpServers: runtime.listMcpServers(),
            skillNames: runtime.info.skillNames,
            trajectory: runtime.trajectoryStatus,
            diagnostics: runtime.diagnosticsStatus,
            usage: runtime.usage,
            turnInFlight: status === 'streaming',
            context,
            ...(contextProblem !== undefined && { contextProblem }),
          }),
        });
        return;
      }

      // Everything below needs the agent, and the SDK runs one turn at a time.
      // A submission while a turn streams or a `!` command runs is **queued**
      // (SER-027 — deliberately superseding SER-010's "retained, never queued"
      // contract, by explicit user product decision, 2026-08-19): it leaves the
      // editor, is listed above the input box, counted on the busy hint, and is
      // sent through this same path when the session returns to idle. Two
      // deliberate exceptions keep the old refusal shape:
      // - compaction owns the keyboard entirely, so this branch is a safety net;
      // - `/clear`, `/compact`, `/model`, `/exit` and `/quit` replace the session
      //   or the process, and running one minutes later, unprompted, is worse
      //   than asking for a second Enter — they refuse, draft retained.
      if (status !== 'idle') {
        if (status === 'compacting') {
          dispatch({ type: 'notice', text: 'still compacting — press enter again once it finishes' });
          return;
        }
        if (refusesToQueue(text)) {
          dispatch({
            type: 'notice',
            text:
              status === 'shell'
                ? `${text.split(/\s/, 1)[0]} does not queue — press enter again when the ! command finishes`
                : `${text.split(/\s/, 1)[0]} does not queue — press enter again once the turn ends`,
          });
          return;
        }
        // Nothing is dispatched and nothing is recorded here: a queued entry
        // becomes a `userInput` only at the moment it is actually sent, and one
        // taken back or dropped by /clear was never sent at all.
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        setQueued([...queuedRef.current, text]);
        return;
      }

      // A user-typed shell command (SER-024). Deliberately *below* the busy check —
      // submitted mid-turn it queues like a prompt (SER-027, the Claude Code shape:
      // shell commands are held until the turn ends and run one at a time), and a
      // drained `!` re-enters here at idle. And deliberately *not*
      // through the permission gate: the gate's subject is model tool calls, and a
      // user running their own command needs no approval from themselves — the
      // transcript row, the trajectory record and the held report are the honesty
      // this bargain costs. That reasoning covers plan mode too: plan constrains
      // the model's writes, not the user's hands.
      const shellCommand = parseShellCommand(text);
      if (shellCommand !== undefined) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        if (shellCommand === '') {
          dispatch({ type: 'userInput', text });
          dispatch({ type: 'notice', text: '! runs a shell command: !<command>' });
          return;
        }
        // The normalized echo (`!` + trimmed command) is also what a replayed
        // `shellCommand` record prints, so live and replay show one user row.
        dispatch({ type: 'userInput', text: `!${shellCommand}` });
        shellRunCount.current += 1;
        const id = `shell-${shellRunCount.current}`;
        dispatch({ type: 'shellStarted', id, command: shellCommand });
        setStatus('shell');
        turnAborted.current = false;
        try {
          const run = runShellCommand(shellCommand, {
            cwd: runtime.info.projectRoot,
            onOutput: (tail) => dispatch({ type: 'shellOutput', id, tail }),
          });
          shellRun.current = run;
          const result = await run.done;
          const output = projectShellOutput(result.output);
          const outcome = {
            command: shellCommand,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
          };
          // One bounded projection, three surfaces (PRD D4): the finished
          // transcript row, the trajectory record, and the report held for the
          // next prompt.
          dispatch({ type: 'shellCommand', ...outcome, output });
          runtime.recordShellCommand({ ...outcome, output });
          pendingShellReports.current.push(composeShellReport(outcome, output));
        } finally {
          // Whatever happened, the prompt is freed: a `!` command can time out or
          // be killed, but it cannot wedge the session.
          shellRun.current = undefined;
          setStatus('idle');
          interruptedAt.current = undefined;
        }
        // A user-cancelled `!` never silently sends the queue, exactly like a
        // cancelled turn (SER-027): what was queued behind it comes back to the
        // editor, visible and unsent. A timeout is not a cancel — the user asked
        // for nothing there, so the queue drains normally.
        if (turnAborted.current) {
          turnAborted.current = false;
          returnQueuedToEditor(true);
        }
        return;
      }

      if (text === '/exit' || text === '/quit') {
        exit();
        return;
      }

      // Deliberately *below* the busy check, with /compact and /model rather than with
      // the local reports above it: this replaces the conversation the running turn is
      // streaming into, and the SDK's session snapshot is written when that turn ends —
      // so a mid-turn switch would hand the old session's manager a conversation it no
      // longer owns. `/clear` is idle-only, and the wording says why.
      if (/^\/clear(?:\s|$)/.test(text)) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        if (text !== '/clear') {
          dispatch({ type: 'notice', text: '/clear takes no arguments' });
          return;
        }
        if (startNewSession === undefined) {
          dispatch({ type: 'notice', text: '/clear is not available in this driver', severity: 'warn' });
          return;
        }
        // The switch awaits an assembly (skills, tools, a new Agent), and `status` stays
        // idle throughout — so without this latch a second enter could start a second
        // successor and leak the first.
        if (clearing.current) {
          dispatch({ type: 'notice', text: 'still starting the new session — press enter again once it appears' });
          return;
        }
        clearing.current = true;
        const previousSessionId = runtime.info.sessionId;
        let next: AgentRuntime;
        try {
          next = await startNewSession();
        } catch (error) {
          // Nothing was released: the session that was live is still live.
          dispatch({
            type: 'notice',
            text: `could not start a new session; still in ${previousSessionId}: ${error instanceof Error ? error.message : String(error)}`,
            severity: 'error',
          });
          return;
        } finally {
          clearing.current = false;
        }

        // `<Static>` cannot be recalled, so a fresh screen means clearing the terminal —
        // once, here, not the per-render clear the live-frame budget exists to prevent.
        // Routed through Ink's own stdout writer so the frame is torn down and restored
        // around it, and paired with the reducer's `<Static>` remount, which is what
        // makes Ink drop the transcript it would otherwise replay on the next
        // whole-screen redraw.
        writeToTerminal(CLEAR_TERMINAL);
        dispatch({ type: 'clear' });
        setRuntime(next);
        // Per-session latches, reset with the session they were latched for.
        contextWarnLatch.current = createContextWarnLatch();
        trajectoryWarned.current = false;
        diagnosticsWarned.current = false;
        // Held `!` reports were destined for the conversation just set aside; the
        // successor starts empty, and the old session's record still has them.
        pendingShellReports.current = [];
        // The queue dies with the conversation it was typed at (SER-027): nothing
        // was sent, so nothing is recorded — the entries simply never existed.
        setQueued([]);
        // Mirrored to the *successor's* diagnostics log: the memoized `dispatch` still
        // points at the predecessor's, which this switch has just closed.
        withNoticeDiagnostics(recordAction, next.diagnostics)({
          type: 'notice',
          text:
            `cleared — new session ${next.info.sessionId}. Previous session ${previousSessionId} is saved and ` +
            `resumable (darwin --session ${previousSessionId}); background jobs and MCP servers keep running.`,
        });
        return;
      }

      if (text === '/compact' || text.startsWith('/compact ')) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        if (text !== '/compact') {
          dispatch({ type: 'notice', text: '/compact takes no arguments' });
          return;
        }
        setStatus('compacting');
        try {
          const result = await runtime.compact();
          dispatch({ type: 'notice', text: formatCompactReport(result) });
        } catch (error) {
          dispatch({
            type: 'notice',
            text: `compaction failed; conversation restored: ${error instanceof Error ? error.message : String(error)}`,
            severity: 'error',
          });
        } finally {
          setStatus('idle');
        }
        return;
      }

      // Deliberately *after* the busy check, unlike /effort: that only adjusts the
      // live model's config, while this replaces the model object outright, which
      // would change the model under a turn that is already streaming from it.
      if (text === '/model' || text.startsWith('/model ')) {
        setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        await applyModelCommand(runtime, text, dispatch);
        return;
      }

      setEditor({ text: '', cursor: { offset: 0, affinity: 'downstream' } });
      setSelectedCompletion(0);
      dispatch({ type: 'userInput', text });

      // Skills and project commands send their expanded prompt instead of the
      // literal command. Unknown slash input falls through as ordinary input.
      let toSend = text;
      try {
        const expanded = await runtime.expandSlashCommand(text);
        if (expanded !== null) {
          dispatch({
            type: 'notice',
            text:
              expanded.kind === 'skill'
                ? `loaded skill "${expanded.skill.name}"`
                : `loaded command "/${expanded.command.name}"`,
          });
          toSend = expanded.message;
        }
      } catch (error) {
        dispatch({
          type: 'notice',
          text: `could not expand ${text}: ${error instanceof Error ? error.message : String(error)}`,
          severity: 'error',
        });
      }

      // Reports from `!` commands run since the last turn ride ahead of this
      // prompt (PRD D5): one string through the ordinary send path, so the
      // trajectory's `userInput` line stays exactly what the model received.
      const shellReports = pendingShellReports.current;
      if (shellReports.length > 0) {
        pendingShellReports.current = [];
        toSend = `${shellReports.join('\n\n')}\n\n${toSend}`;
      }

      await runTurn(toSend);
    },
    [dispatch, exit, recordAction, returnQueuedToEditor, runtime, runTurn, setEditor, setQueued, startNewSession, status, writeToTerminal],
  );

  // The drain (SER-027): when the session is idle and nothing owns the keyboard,
  // the oldest queued entry goes back through the ordinary submit path — its own
  // turn for a prompt, its own run for a `!`, its own `userInput` recorded at
  // this moment and not before. One entry at a time: `draining` latches while an
  // entry is in flight (submit awaits expansion before it flips `status`, and a
  // render in that window must not double-dequeue), and `drainCycle` re-arms the
  // effect after an entry — a local command, say — that left every other dep
  // unchanged. Never while a permission decision is pending (the queue is held
  // untouched under a prompt) and never while `/clear` is assembling a successor.
  useEffect(() => {
    if (draining.current || status !== 'idle' || pendingPermission !== undefined || clearing.current) return;
    const next = queuedRef.current[0];
    if (next === undefined) return;
    draining.current = true;
    setQueued(queuedRef.current.slice(1));
    void submit(next).finally(() => {
      draining.current = false;
      setDrainCycle((cycle) => cycle + 1);
    });
  }, [drainCycle, pendingPermission, queued, setQueued, status, submit]);

  /**
   * Answers the pending confirmation and, when the user picked an "always allow"
   * option, remembers the rule.
   *
   * The gate honours the rule from the decision alone, so the write to
   * `~/.darwin/config.json` is reported rather than awaited: a failed write means
   * "this session only", which the user has to be told, but it must not delay the
   * tool call they just approved.
   */
  const answerPermission = useCallback(
    (decision: PermissionDecision) => {
      permissions.answer(decision);
      const rule = decision.rule;
      if (rule === undefined) return;

      runtime.saveAllowRule(rule).then(
        () => {
          dispatch({
            type: 'notice',
            text: `always allowing ${rule} — saved to ${runtime.info.permissionRulesPath}`,
          });
        },
        (error: unknown) => {
          dispatch({
            type: 'notice',
            text:
              `always allowing ${rule} for this session only — could not write ` +
              `${runtime.info.permissionRulesPath}: ${error instanceof Error ? error.message : String(error)}`,
            // The rule still applies this session, so a degradation, not a failure.
            severity: 'warn',
          });
        },
      );
    },
    [permissions, runtime],
  );

  /** Any edit ends the walk: the draft is the user's again, not an entry from the record. */
  const endRecall = useCallback(() => {
    if (recallRef.current !== undefined) setRecall(undefined);
  }, [setRecall]);

  const acceptCompletion = useCallback(() => {
    // Recompute from the immediate editor mirror for the same batched-input reason
    // path splicing does below. Arrow events may have advanced the ref before React
    // commits the render that derives `completions`; acceptance must use that row's
    // candidate source, not a stale closure from the frame before navigation.
    const currentCommandCompletions = computeCompletions(editorRef.current.text, [
      ...BUILTIN_COMMAND_NAMES,
      ...runtime.info.commandNames,
      ...runtime.info.skillNames,
    ]);
    const currentPathQuery = currentCommandCompletions.length > 0
      ? undefined
      : pathCompletionQuery(editorRef.current.text, editorRef.current.cursor.offset);
    const currentCompletionKind: CompletionKind = currentCommandCompletions.length > 0 ? 'command' : 'path';
    const currentCompletions = currentCompletionKind === 'command'
      ? currentCommandCompletions
      : currentPathQuery === undefined
        ? []
        : matchWorkspacePaths(workspacePaths.paths, currentPathQuery.text);
    const selected = completionSelection(selectedCompletionRef.current, currentCompletions.length);
    const chosen = currentCompletions[selected];
    if (chosen === undefined) return;
    if (currentCompletionKind === 'path') {
      // Re-derived from the immediate editor mirror rather than from the render's
      // `pathQuery`: several stdin events can be batched into one React pass, and
      // splicing a path at an offset the draft has moved past would corrupt it.
      const query = pathCompletionQuery(editorRef.current.text, editorRef.current.cursor.offset);
      if (query === undefined) return;
      // Text, and only text. Nothing about the chosen path is opened, stat-ed for
      // content or sent anywhere — the whole point of the Codex shape over
      // OpenCode's is that file bytes keep going through the gated `fileEditor` read.
      setEditor(applyPathCompletion(editorRef.current, query, chosen));
    } else {
      setEditor({ text: `/${chosen} `, cursor: { offset: chosen.length + 2, affinity: 'upstream' } });
    }
    preferredColumn.current = undefined;
    setSelectedCompletion(0);
    endRecall();
  }, [endRecall, runtime, setEditor, setSelectedCompletion, workspacePaths]);

  /**
   * Puts a recalled prompt in the draft, cursor at its end.
   *
   * The end, not the start, is what makes walking further back work on a multi-row
   * prompt: `Up` moves up through its rows first and only steps to an older entry from
   * the top one, which is the rule that leaves `moveVertical` intact.
   */
  const applyRecalled = useCallback((text: string) => {
    setEditor({ text, cursor: { offset: text.length, affinity: 'upstream' } });
    preferredColumn.current = undefined;
    // A recalled `/…` prompt reopens the command menu, so the selection has to start
    // from the top of it rather than from wherever the last menu was left.
    setSelectedCompletion(0);
  }, [setEditor]);

  /**
   * `Up` as queue take-back (SER-027), or `false` when this keypress is not one.
   *
   * Consulted after the completion menu and before prompt recall, and it fires
   * only when the queue is non-empty, no recall walk is open (an open walk keeps
   * its own `Up` semantics — one can only open while the queue is empty, and this
   * guard makes that structural), and the cursor sits on the **first visual row**
   * of the draft, the empty draft included. Every other keypress falls through:
   * below the first row `Up` is still cursor movement, and with an empty queue
   * recall is exactly as reachable as before this feature existed. One press
   * takes the whole queue back — entries one per line, ahead of any typed text.
   */
  const takeBackQueued = useCallback((): boolean => {
    if (queuedRef.current.length === 0 || recallRef.current !== undefined) return false;
    const value = editorRef.current;
    const shape = layoutEditor(value.text, columns, value.cursor);
    if (shape.cursor.row !== 0) return false;
    return returnQueuedToEditor(false);
  }, [columns, returnQueuedToEditor]);

  /**
   * `Up`/`Down` as prompt recall, or `false` when this keypress is not recall at all.
   *
   * Returning `false` is the whole contract: the caller then falls through to
   * `moveVertical`, so cursor movement in a multi-line draft is untouched, and a
   * completion menu never reaches here because `App` handles menu selection first.
   * State is read from the mirrors rather than from the render, because several stdin
   * events can arrive in one React pass.
   */
  const stepRecall = useCallback((direction: RecallDirection): boolean => {
    const current = recallRef.current;
    const value = editorRef.current;

    if (current === undefined) {
      // Only from an empty draft: typed text is never replaced by a recalled prompt,
      // which is why no stashed draft has to exist for this to be safe.
      if (direction !== 'older' || value.text !== '') return false;
      // A reading that a finished turn has marked stale — or one still arriving — opens a
      // *pending* walk rather than offering last time's answer: the prompt a user wants
      // right after a turn is usually the one that turn just sent. Read before
      // `requestHistory()`, which clears the flag it is asking about. (A record append is
      // scheduled at turn end, not awaited, so a prompt whose write is still in flight
      // arrives in the reading after it — sub-millisecond in practice.)
      const known =
        historyRead.current.stale || historyRead.current.inFlight ? undefined : history;
      // Started here rather than at startup, like the workspace scan: a session that
      // never presses Up never opens a record.
      requestHistory();
      const opened = openPromptRecall(known);
      setRecall(opened.recall);
      if (opened.text !== undefined) applyRecalled(opened.text);
      return true;
    }

    // Laid out from the mirror, not from the render's `layout`: that one may describe a
    // draft an earlier event in this same batch has already replaced.
    const shape = layoutEditor(value.text, columns, value.cursor);
    const cursorRow = shape.cursor.row;
    const rowCount = shape.rows.length;
    // Inside a walk the arrows still move the cursor first: older only from the top
    // row, newer only from the bottom one. Nothing above or below to move to is what
    // makes the key mean "step in history" instead.
    if (direction === 'older' ? cursorRow !== 0 : cursorRow !== rowCount - 1) return false;

    const step = stepPromptRecall(current, direction);
    setRecall(step.recall);
    if (step.text !== undefined) applyRecalled(step.text);
    return true;
  }, [applyRecalled, columns, history, requestHistory, setRecall]);

  // A walk opened before the read landed is finished here, once, and only while the
  // draft is still the empty one it was opened on — a read that lands after the user
  // started typing must not overwrite what they typed.
  useEffect(() => {
    const current = recallRef.current;
    if (current === undefined || !current.pending) return;
    if (history === undefined || editorRef.current.text !== '') return;
    const opened = openPromptRecall(history);
    setRecall(opened.recall);
    if (opened.text !== undefined) applyRecalled(opened.text);
  }, [applyRecalled, history, setRecall]);

  const handleInterrupt = useCallback(() => {
    const now = Date.now();
    const previous = interruptedAt.current;

    if (status === 'idle' && pendingPermission === undefined) {
      exit();
      return;
    }

    if (previous !== undefined && now - previous < DOUBLE_INTERRUPT_MS) {
      exit();
      return;
    }

    interruptedAt.current = now;
    if (status === 'shell') {
      // The user's own `!` command: TERM its group now, KILL after the grace. The
      // completion path in submit() reports it as killed and frees the prompt —
      // and, because this was a user cancel, returns the queue to the editor
      // unsent (SER-027) instead of draining it.
      turnAborted.current = true;
      shellRun.current?.kill();
      dispatch({ type: 'notice', text: 'interrupted — press ctrl+c again to exit' });
      return;
    }
    if (status === 'compacting') {
      dispatch({ type: 'notice', text: 'compaction cannot be cancelled safely — press ctrl+c again to exit' });
      return;
    }

    // Deny anything waiting so the loop is not left blocked on a prompt. Not
    // close(): the session survives a cancelled turn, so later turns must still
    // be able to ask for approval. The abort mark is what keeps the queue from
    // being silently sent when the cancelled turn winds down (SER-027).
    turnAborted.current = true;
    permissions.denyPending();
    runtime.cancel();
    dispatch({ type: 'notice', text: 'interrupted — press ctrl+c again to exit' });
  }, [exit, pendingPermission, permissions, runtime, status]);

  useInput((typed, key) => {
    if (key.ctrl && typed === 'd') {
      exit();
      return;
    }

    if (key.ctrl && typed === 'c') {
      handleInterrupt();
      return;
    }

    // Confirmations take the keyboard while one is pending.
    if (pendingPermission !== undefined) {
      if (typed === 'y' || typed === 'Y') answerPermission({ allowed: true });
      else if (typed === 'n' || typed === 'N' || key.escape) answerPermission({ allowed: false });
      // Lowercase takes the narrow offer, uppercase the whole tool — the more
      // sweeping choice costs the more deliberate keystroke.
      else if (typed === 'a' || typed === 'A') {
        const suggestions = pendingPermission.suggestions;
        const chosen = typed === 'a' ? suggestions[0] : suggestions[suggestions.length - 1];
        if (chosen !== undefined) answerPermission({ allowed: true, rule: chosen.rule });
      }
      return;
    }

    // Display-only and session-local. It is deliberately after permission
    // ownership, but before editor commands, so the draft and cursor are untouched.
    if (key.ctrl && typed === 'b') {
      dispatch({ type: 'toggleToolDetails' });
      return;
    }

    // Compaction rewrites the conversation outside the agent loop and owns the
    // editor until that atomic operation finishes. Global, permission, and
    // display-only controls above still work; no draft operation below does.
    if (status === 'compacting') return;

    // Readline-style editing chords. After permission ownership (a pending
    // prompt still owns 'a'/'e'), before the generic ctrl/meta ignore below.
    if (key.ctrl && (typed === 'a' || typed === 'e')) {
      setEditor((current) => ({
        ...current,
        cursor: moveToRowEdge(layoutEditor(current.text, columns, current.cursor), typed === 'a' ? 'start' : 'end'),
      }));
      preferredColumn.current = undefined;
      return;
    }

    if (key.ctrl && (typed === 'k' || typed === 'u')) {
      setEditor((current) =>
        killToRowEdge(current, layoutEditor(current.text, columns, current.cursor), typed === 'k' ? 'end' : 'start'),
      );
      preferredColumn.current = undefined;
      setSelectedCompletion(0);
      endRecall();
      return;
    }

    if (key.ctrl && typed === 'w') {
      setEditor((current) => deleteWordBefore(current));
      preferredColumn.current = undefined;
      setSelectedCompletion(0);
      endRecall();
      return;
    }

    // No guard for a streaming turn: typing during one stays allowed, and a
    // submission during one is queued in submit() (SER-027) — local commands
    // like /usage still answer mid-turn immediately. (A pending confirmation is
    // different — it took the keyboard above, because the loop is blocked until
    // it is answered, and the queue is held untouched while it is up.)

    if (key.return) {
      // A trailing backslash is an explicit continuation marker. Consume it so
      // the prompt sent later contains the intended newline, not editor syntax.
      if (editorRef.current.text.endsWith('\\')) {
        const text = `${editorRef.current.text.slice(0, -1)}\n`;
        setEditor({ text, cursor: { offset: text.length, affinity: 'upstream' } });
        preferredColumn.current = undefined;
        setSelectedCompletion(0);
        endRecall();
        return;
      }

      // With a completion highlighted, Enter accepts it rather than submitting a
      // half-typed skill name.
      if (completions.length > 0) {
        acceptCompletion();
        return;
      }
      // Submitting is the end of the walk too: the record's entry has become this
      // session's prompt, and the indicator has nothing left to describe.
      endRecall();
      void submit(editorRef.current.text);
      return;
    }
    // A pty or terminal may batch printable text with Enter on either side of
    // the same event. Depending on line discipline, that terminator reaches Ink
    // as CR, LF, or CRLF (occasionally doubled); keep one Enter's semantics and
    // preserve the printable text. A single LF remains Ctrl+J below.
    const leadingEnter = typed.length > 1 ? typed.match(/^[\r\n]+/)?.[0] : undefined;
    const trailingEnter = typed.length > 1 ? typed.match(/[\r\n]+$/)?.[0] : undefined;
    const batchedEnter = leadingEnter ?? trailingEnter;
    if (batchedEnter !== undefined) {
      const payload = leadingEnter === undefined
        ? typed.slice(0, -batchedEnter.length)
        : typed.slice(batchedEnter.length);
      const beforeEnter = leadingEnter === undefined
        ? insertAtCursor(editorRef.current, normalizeDraftText(payload))
        : editorRef.current;
      if (beforeEnter.text.endsWith('\\')) {
        const text = `${beforeEnter.text.slice(0, -1)}\n`;
        const continued = { text, cursor: { offset: text.length, affinity: 'upstream' } } as const;
        setEditor(leadingEnter === undefined ? continued : insertAtCursor(continued, normalizeDraftText(payload)));
        preferredColumn.current = undefined;
        setSelectedCompletion(0);
        endRecall();
        return;
      }
      const next = leadingEnter === undefined
        ? beforeEnter
        : insertAtCursor(beforeEnter, normalizeDraftText(payload));
      // Mirrored into the editor *before* submitting, so a submission the busy
      // check refuses (SER-027's /clear-family exception keeps SER-010's retention
      // shape) leaves the batched text visible in the draft instead of silently
      // dropping it — a pty or paste can deliver `text\r` as one event, and
      // retention must not depend on how the terminal chunked the keystrokes. An
      // accepted or queued submission clears it anyway.
      setEditor(next);
      preferredColumn.current = undefined;
      setSelectedCompletion(0);
      endRecall();
      void submit(next.text);
      return;
    }

    // Terminals encode Ctrl+J as LF, distinct from the CR emitted by Enter.
    // Ink does not expose an `enter` flag, so the literal input is the contract.
    if (typed === '\n') {
      setEditor((current) => insertAtCursor(current, '\n'));
      preferredColumn.current = undefined;
      setSelectedCompletion(0);
      endRecall();
      return;
    }

    if (key.tab && completions.length > 0) {
      acceptCompletion();
      return;
    }

    if (key.upArrow && completions.length > 0) {
      setSelectedCompletion((i) => moveCompletionSelection(i, completions.length, -1));
      return;
    }

    if (key.downArrow && completions.length > 0) {
      setSelectedCompletion((i) => moveCompletionSelection(i, completions.length, 1));
      return;
    }

    if (key.leftArrow || key.rightArrow) {
      setEditor((current) => ({
        ...current,
        cursor: moveHorizontal(
          current.text,
          current.cursor,
          key.leftArrow ? -1 : 1,
          layoutEditor(current.text, columns, current.cursor),
        ),
      }));
      preferredColumn.current = undefined;
      return;
    }

    if (key.home || key.end) {
      setEditor((current) => ({
        ...current,
        cursor: moveToRowEdge(layoutEditor(current.text, columns, current.cursor), key.home ? 'start' : 'end'),
      }));
      preferredColumn.current = undefined;
      return;
    }

    if (key.upArrow || key.downArrow) {
      // The Up chain, in fixed precedence (SER-027 joined it): the completion
      // menu already took both keys above; queue take-back is consulted next,
      // then recall — each answers `false` for every keypress that is ordinary
      // cursor movement, which is what leaves a multi-line draft's rows navigable.
      if (key.upArrow && takeBackQueued()) return;
      if (stepRecall(key.upArrow ? 'older' : 'newer')) return;
      const moved = moveVertical(layout, key.upArrow ? -1 : 1, preferredColumn.current);
      setEditor((current) => ({ ...current, cursor: moved.cursor }));
      preferredColumn.current = moved.preferredColumn;
      return;
    }

    if (key.backspace || key.delete) {
      setEditor((current) => key.backspace ? backspaceAtCursor(current) : deleteAtCursor(current));
      preferredColumn.current = undefined;
      setSelectedCompletion(0);
      endRecall();
      return;
    }

    // Ignore chords and non-printable keys; take everything else as text.
    if (key.ctrl || key.meta || key.escape || typed === '') return;

    // A terminal without bracketed-paste support can still deliver a whole write
    // here. Preserve every line just like usePaste rather than submitting at the
    // first one and silently dropping the rest.
    const printable = normalizeDraftText(typed);
    if (printable === '') return;

    setEditor((current) => insertAtCursor(current, printable));
    preferredColumn.current = undefined;
    setSelectedCompletion(0);
    endRecall();
  });

  usePaste((pasted) => {
    // Permission and compaction own all input while visible/busy, including paste.
    if (pendingPermission !== undefined || status === 'compacting') return;

    const text = normalizeDraftText(pasted);
    if (text === '') return;
    setEditor((current) => insertAtCursor(current, text));
    preferredColumn.current = undefined;
    setSelectedCompletion(0);
    endRecall();
  });

  return (
    <Box flexDirection="column">
      <Box ref={headerRef} flexDirection="column">
        <Header runtime={runtime} status={effectiveStatus} />
      </Box>
      <MessageList
        history={state.history}
        {...(state.staticEpoch === 0 ? { welcome: initialWelcome } : {})}
        liveText={state.liveText}
        liveCodeOpen={fenceOpenAfter(state.committedAnswer)}
        columns={columns}
        maxLiveRows={grants.live}
        staticEpoch={state.staticEpoch}
      />

      <Box ref={chromeRef} flexDirection="column">
        {/* The reduced busy suffix — elapsed only, since the hint row below already
            states the spend. Truncated, never wrapped, so its counted `thinkingRows`
            of 1 stays true at every width with the suffix on it. */}
        {state.thinking && effectiveStatus === 'streaming' && (
          <Text dimColor wrap="truncate-end">{`thinking…${busyElapsedMs === undefined ? '' : busySuffix(busyElapsedMs, undefined)}`}</Text>
        )}
        <ActiveToolCalls
          tools={state.activeTools}
          frame={frame}
          toolDetailsExpanded={state.toolDetailsExpanded}
          columns={columns}
          maxRows={grants.tools}
        />
        <PlanChecklist plan={state.livePlan} maxRows={grants.plan} />

        {/* Queued mid-turn submissions (SER-027), above the input box like the
            peer shape — and above the permission box too: the queue is held
            untouched while a decision is pending, and held state must stay
            visible. A sibling here, so InputBox's parent-relative metrics absorb
            its height and the cursor stays on its draft row. */}
        <QueuedMessages entries={queued} maxRows={grants.queued} />

        {pendingPermission !== undefined ? (
          <PermissionPrompt
            request={pendingPermission}
            waiting={permissions.waiting}
            columns={columns}
            maxRows={grants.prompt}
          />
        ) : (
          <InputBox
            layout={layout}
            completions={completions}
            completionKind={completionKind}
            completionNote={completionNote}
            selectedCompletion={selectedCompletion}
            editable={effectiveStatus !== 'compacting'}
            offset={{ top: chrome.top, left: chrome.left }}
            maxRows={grants.prompt}
            hint={streamingHint}
            recallIndicator={recallIndicator}
          />
        )}
      </Box>
    </Box>
  );
}

/** The hint row under the draft, or nothing when the session is idle. */
function hintForStatus(status: Status, busyReadout?: string, queuedCount = 0): string | undefined {
  if (status === 'streaming') {
    // The live readout rides directly behind `working…`, ahead of the static command
    // hints: the row is one truncated <Text>, so on a narrow terminal the tail is what
    // goes missing, and the tail should be the part that never changes. The queue
    // count (SER-027) rides with it: even a listing cut to nothing stays counted here.
    return `working…${busyReadout ?? ''}${queuedCountHint(queuedCount)} /tasks lists jobs · /agents lists dispatches · /usage reports tokens · ctrl+c cancels this turn`;
  }
  // Elapsed lives on the command's own panel row, so this row can stay static.
  if (status === 'shell') return `running ! command…${queuedCountHint(queuedCount)} ctrl+c cancels it`;
  return status === 'compacting' ? 'compacting conversation…' : undefined;
}

/**
 * The session's reported spend, or undefined when the meter cannot be read.
 *
 * Read per spinner tick, so it follows `startTurnSpend`'s cannot-throw precedent: a
 * failure degrades the suffix to elapsed-only rather than becoming a render error.
 */
function liveSpend(runtime: AgentRuntime): UsageBuckets | undefined {
  try {
    return usageBuckets(runtime.usage, runtime.config);
  } catch {
    return undefined;
  }
}

export function Header({
  runtime,
  status = 'idle',
}: {
  readonly runtime: AgentRuntime;
  readonly status?: Status;
}): React.JSX.Element {
  const info = runtime.info;
  const instructions = info.projectInstructions;
  // Live, not info.permissionMode: /mode moves it mid-session, and a header still
  // naming the startup policy would be worse than no header — this row is the only
  // place the effective mode is stated, and it must not gain a second one.
  const mode = runtime.permissionMode;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={visualColor.identity} bold>{visualMarker.identity} DARWIN</Text>
        <Text dimColor> · {headerStatus(status)}</Text>
      </Text>
      <Text dimColor>
        {/* Live, not info.config: /model changes both mid-session, and a header
            that still names the previous model is worse than no header. */}
        {runtime.config.provider}/{runtime.config.model} · session {info.sessionId}
        {info.resumed ? ' (resumed)' : ''}
        {formatPromptCache(runtime.promptCache)}
        {formatThinking(runtime.thinking)}
      </Text>
      {mode === 'yolo' ? (
        // Yellow: yolo disables a safety layer, same convention as other warnings.
        <Text color={visualColor.warning}>mode: yolo — every tool call runs without confirmation</Text>
      ) : mode === 'plan' ? (
        // One existing row, not a new one: the header competes with permission and
        // tool detail for frame height. Rules remain stored but cannot bypass plan.
        <Text color={visualColor.warning}>
          mode: plan — read-only; write and execute calls are denied
          {runtime.allowRuleCount > 0 ? ` · ${runtime.allowRuleCount} allow rule(s) ignored` : ''}
        </Text>
      ) : (
        // Rule count rides along on this line rather than taking one of its own:
        // see the frame-height comment below.
        <Text dimColor>
          mode: {mode}
          {runtime.allowRuleCount > 0 ? ` · ${runtime.allowRuleCount} allow rule(s)` : ''}
        </Text>
      )}
      {instructions !== undefined &&
        (instructions.truncated ? (
          <Text color={visualColor.warning}>
            {AGENTS_FILENAME}: loaded ({formatBytes(instructions.bytes)}, truncated to{' '}
            {MAX_INSTRUCTIONS_BYTES / 1024} KB)
          </Text>
        ) : (
          <Text dimColor>
            {AGENTS_FILENAME}: loaded ({formatBytes(instructions.bytes)})
          </Text>
        ))}
      {info.projectInstructionsProblem !== undefined && (
        <Text color={visualColor.warning}>
          {AGENTS_FILENAME}: skipped — {info.projectInstructionsProblem}
        </Text>
      )}
      {/* Silent only for the built-in prompt: a replaced prompt changes how the
          agent behaves, so it must be visible without reading the config. */}
      {info.systemPromptSource === 'config' && (
        <Text dimColor>
          system prompt: overridden by {DARWIN_DIRNAME}/{CONFIG_FILENAME}
        </Text>
      )}
      {info.systemPromptSource === 'file' && (
        <Text dimColor>
          system prompt: {DARWIN_DIRNAME}/{SYSTEM_PROMPT_FILENAME}
        </Text>
      )}
      {info.systemPromptProblem !== undefined && (
        <Text color={visualColor.warning}>
          system prompt: using the default — {info.systemPromptProblem}
        </Text>
      )}
      {/* Only the failure: the working context itself is unremarkable, and the
          header cannot afford a line for something that worked. */}
      {info.workingContextProblem !== undefined && (
        <Text color={visualColor.warning}>
          working context: no directory listing — {info.workingContextProblem}
        </Text>
      )}
      {/* Cost-relevant, so it is stated rather than assumed. Only the "asked for
          but impossible" case gets a line of its own: the header is part of the
          live frame, and every line it grows by is one line of permission prompt
          or tool output that Ink drops off a short terminal. */}
      {info.promptCache.problem !== undefined && (
        <Text color={visualColor.warning}>prompt cache: off — {info.promptCache.problem}</Text>
      )}
      {/* Same rule as the cache problem above: the level itself rides on the model
          line, and only a gap between what was asked for and what the model can
          actually do earns a line — thinking depth is both a cost and a quality
          decision, so a silent downgrade is not acceptable. */}
      {runtime.thinking.problem !== undefined && (
        <Text color={visualColor.warning}>thinking: {runtime.thinking.problem}</Text>
      )}
      {hasCapabilities(info) && (
        <Text dimColor>
          loaded: {formatCapabilities(info)} · type / for commands
        </Text>
      )}
      {info.mcpIgnoredConfigPath !== undefined && (
        <Text color={visualColor.warning}>
          mcp: using {DARWIN_DIRNAME}/{MCP_CONFIG_FILENAME} — {info.mcpIgnoredConfigPath} ignored
        </Text>
      )}
      {info.hookShadowNotices.map((notice) => (
        <Text key={notice.directory} color={visualColor.warning} wrap="truncate-end">
          hooks: {notice.layer} {notice.directory} shadows {notice.shadowed.join(', ')}
        </Text>
      ))}

      {info.skillProblems.map((problem) => (
        <Text key={problem.directory} color={visualColor.warning}>
          skill skipped: {problem.directory} — {problem.reason}
        </Text>
      ))}
      {info.commandProblems.map((problem) => (
        <Text key={problem.file} color={visualColor.warning}>
          command skipped: {problem.file} — {problem.reason}
        </Text>
      ))}
      {info.agentProblems.map((problem) => (
        <Text key={problem.file} color={visualColor.warning}>
          agent skipped: {problem.file} — {problem.reason}
        </Text>
      ))}
      {/* Extends the existing line rather than adding one: see the frame-height
          comment above. `/trajectory` is deliberately not listed — the line is full,
          and the completion menu already advertises it with a description. */}
      <Text dimColor>
        / for actions · @ for paths · ctrl+c cancels · /exit quits
      </Text>
    </Box>
  );
}

function headerStatus(status: Status): string {
  switch (status) {
    case 'idle':
      return 'ready';
    case 'streaming':
      return 'working';
    case 'shell':
      return 'running !';
    case 'compacting':
      return 'compacting';
    case 'awaiting-permission':
      return 'permission needed';
  }
}

function hasCapabilities(info: AgentRuntime['info']): boolean {
  return info.skillNames.length + info.commandNames.length + info.agentNames.length + info.mcpServerCount > 0;
}

function formatCapabilities(info: AgentRuntime['info']): string {
  const capabilities = [
    capabilityCount(info.skillNames.length, 'skill'),
    capabilityCount(info.commandNames.length, 'command'),
    capabilityCount(info.agentNames.length, 'agent'),
    capabilityCount(info.mcpServerCount, 'MCP server'),
  ];
  return capabilities.filter((value): value is string => value !== undefined).join(' · ');
}

function capabilityCount(count: number, label: string): string | undefined {
  return count > 0 ? `${count} ${label}${count === 1 ? '' : 's'}` : undefined;
}

/** Sizes are shown so an accidentally huge AGENTS.md is visible at a glance. */
function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Provider-aware token counters as a labelled block.
 *
 * Numbers are aligned rather than run together on one line: the point of asking
 * is to compare them (a large cache read next to a small input is the cache
 * working), and that comparison is what a column makes readable. An unavailable
 * provider metric remains text rather than masquerading as numeric zero.
 */
export function formatUsageReport(
  usage: UsageTotals,
  config: AppConfig,
  resumed: boolean,
  turnInFlight = false,
  lastTurn?: UsageTotals,
): string {
  const rows = usageRows(usage, config);
  const derived = cacheEffectivenessRows(usage, config);
  const labelWidth = Math.max(...rows.map(({ label }) => label.length), ...derived.map(({ label }) => label.length));
  const lines = [
    ...rows.map(({ label, value }) => ({ label, rendered: formatUsageValue(value) })),
    ...derived.map(({ label, value }) => ({ label, rendered: value ?? 'not reported' })),
  ].map(({ label, rendered }) => `  ${label.padEnd(labelWidth)}  ${rendered.padStart(12)}`);

  // "This run" is the honest scope: the SDK's meter is per-process, so a resumed
  // session's earlier spend is simply not knowable here.
  const heading = resumed
    ? 'token usage — this run (resumed: earlier runs are not counted)'
    : 'token usage — this run';
  // Asked mid-turn, the totals are the ones from before it: the meter accumulates
  // a model call when it finishes. Said out loud, because numbers that do not move
  // while the agent is visibly working read as a broken counter.
  const footer = turnInFlight ? ['  (the turn in flight is not counted yet)'] : [];

  // Last-turn section: only when a turn has completed. Mid-turn, lastTurn is the
  // previous completed turn, labelled clearly so it is not mistaken for the
  // in-flight one.
  const lastTurnSection = lastTurn === undefined ? [] : formatLastTurnSection(lastTurn, config, labelWidth);

  return [heading, ...lines, ...footer, ...lastTurnSection].join('\n');
}

/**
 * One-section "last turn (previous turn)" block, reusing the same label
 * width as the parent table for visual alignment.
 */
function formatLastTurnSection(lastTurn: UsageTotals, config: AppConfig, labelWidth: number): string[] {
  const lastRows = usageRows(lastTurn, config);
  const lastDerived = cacheEffectivenessRows(lastTurn, config);
  const allLastWidth = Math.max(
    labelWidth,
    ...lastRows.map(({ label }) => label.length),
    ...lastDerived.map(({ label }) => label.length),
  );
  const lastLines = [
    ...lastRows.map(({ label, value }) => ({ label, rendered: formatUsageValue(value) })),
    ...lastDerived.map(({ label, value }) => ({ label, rendered: value ?? 'not reported' })),
  ].map(({ label, rendered }) => `  ${label.padEnd(allLastWidth)}  ${rendered.padStart(12)}`);
  return ['last turn (previous turn)', ...lastLines];
}

/**
 * Wraps a reducer dispatch so every notice is also written to the diagnostics log,
 * with the severity it was shown at — or hands the dispatch straight back when there
 * is no log, which is the default.
 *
 * Outside the reducer, never inside it: `turnReducer` is pure and shared with
 * `trajectory replay`, so a side effect in it would both fire twice under React's
 * strict double-invocation and make replaying a record write to a log. Wrapping the
 * dispatch instead means no notice site had to change, and a notice added later is
 * mirrored without anyone remembering to do it.
 *
 * The action reaches the reducer unchanged and unconditionally: the log is a copy of
 * what the transcript said, and a broken log may not cost the user the line itself.
 */
export function withNoticeDiagnostics(
  dispatch: (action: TurnAction) => void,
  log: DiagnosticsLog | undefined,
): (action: TurnAction) => void {
  if (log === undefined) return dispatch;
  return (action: TurnAction) => {
    // `write` is synchronous and swallows its own failures, so this cannot delay or
    // deny the render below; the severity defaults exactly as the reducer defaults it.
    if (action.type === 'notice') log.notice(action.text, action.severity ?? 'info');
    dispatch(action);
  };
}

/**
 * What this session has recorded, or why it has not.
 *
 * "This run" is the honest scope for the counters, exactly as in the usage report:
 * the file may hold earlier runs of the same session (recording continues across
 * `--resume`), but this process only knows what it appended itself. The reader is
 * pointed at the file rather than told a total it cannot trust.
 */
export function formatTrajectoryReport(
  status: TrajectoryStatus | undefined,
  sessionId: string,
): string {
  if (status === undefined) {
    return [
      'trajectory: not recording (trajectory: false)',
      `  set "trajectory": true in ~/${DARWIN_DIRNAME}/${CONFIG_FILENAME} to record this session`,
    ].join('\n');
  }

  const lines = [
    status.active ? 'trajectory: recording' : 'trajectory: stopped',
    `  file              ${status.file}`,
    `  records this run  ${groupDigits(status.recordsThisRun)}`,
    `  bytes this run    ${groupDigits(status.bytesThisRun)}`,
  ];
  if (status.truncationsThisRun > 0) {
    // Said out loud: a capped record is still a faithful record of *what happened*,
    // but not of every byte, and a reader deserves to know before quoting it.
    lines.push(`  truncated fields  ${groupDigits(status.truncationsThisRun)} (size caps)`);
  }
  if (status.problem !== undefined) lines.push(`  problem           ${status.problem}`);
  lines.push(`  replay it with:   darwin trajectory replay ${sessionId}`);
  return lines.join('\n');
}

/** Formats the context reduction from `/compact` without implying billing savings. */
export function formatCompactReport(result: CompactResult): string {
  if (!result.compacted) {
    return `conversation already compact — ${result.messagesBefore} message(s), nothing old enough to summarize`;
  }

  return [
    `conversation compacted — ${groupDigits(result.messagesBefore)} → ${groupDigits(result.messagesAfter)} messages`,
    `  estimated context tokens  ${groupDigits(result.estimatedTokensBefore)} → ${groupDigits(result.estimatedTokensAfter)}`,
    `  estimated tokens saved    ${groupDigits(result.estimatedTokensSaved)}`,
  ].join('\n');
}

/** Explicit locale: the report should read the same on every machine. */
function groupDigits(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Runs `/effort`, dispatching whatever notice it earns.
 *
 * Reporting and setting share one entry point because they share one answer: what
 * the model is doing now. A bad level changes nothing and says what the levels
 * are, rather than falling through to the model as a prompt.
 *
 * The level is in effect the moment {@link AgentRuntime.changeThinkingEffort}
 * returns, so — exactly as with an accepted allow-rule — the `~/.darwin/config.json`
 * write is reported rather than awaited: a failed write means "this session only",
 * which the user has to be told but must not wait for.
 */
function applyEffortCommand(
  runtime: AgentRuntime,
  text: string,
  dispatch: (action: TurnAction) => void,
): void {
  const argument = text.slice('/effort'.length).trim().toLowerCase();

  if (argument === '') {
    dispatch({ type: 'notice', text: `thinking effort: ${describeThinking(runtime.thinking)}` });
    return;
  }

  if (!isThinkingEffort(argument)) {
    dispatch({
      type: 'notice',
      text:
        `${argument} is not a thinking effort level — expected one of ${THINKING_EFFORTS.join(', ')}\n` +
        `  thinking effort: ${describeThinking(runtime.thinking)} (unchanged)`,
    });
    return;
  }

  const { plan, saved } = runtime.changeThinkingEffort(argument);
  const applied = `thinking effort: ${describeThinking(plan)}`;
  saved.then(
    () => {
      dispatch({ type: 'notice', text: `${applied} — saved to ~/${DARWIN_DIRNAME}/${CONFIG_FILENAME}` });
    },
    (error: unknown) => {
      dispatch({
        type: 'notice',
        text:
          `${applied}, this session only — could not write ` +
          `~/${DARWIN_DIRNAME}/${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
        // The level is live already; only its persistence degraded.
        severity: 'warn',
      });
    },
  );
}

/**
 * Runs `/mode`, dispatching whatever notice it earns.
 *
 * Reporting and switching share one entry point, like `/effort` and `/model`: both
 * answer "what is being enforced right now". An unusable argument changes nothing,
 * names the valid modes, and never falls through to the model as a prompt.
 *
 * Nothing is awaited and nothing is written: this is session-scoped state by
 * design, so — unlike `/effort` and `/model` — there is no "saved to …" half of the
 * report. The notice says so, because a user who has met the other two commands
 * will otherwise assume the mode is remembered.
 */
function applyModeCommand(
  runtime: AgentRuntime,
  text: string,
  dispatch: (action: TurnAction) => void,
): void {
  const argument = text.slice('/mode'.length).trim().toLowerCase();
  const available = `  available: ${APPROVAL_MODES.join(', ')} · /mode <name> switches for this session only`;

  if (argument === '') {
    dispatch({
      type: 'notice',
      text: `permission mode: ${describeApprovalMode(runtime.permissionMode)}\n${available}`,
    });
    return;
  }

  if (!isApprovalMode(argument)) {
    dispatch({
      type: 'notice',
      text:
        `${argument} is not a permission mode — expected one of ${APPROVAL_MODES.join(', ')}\n` +
        `  permission mode: ${describeApprovalMode(runtime.permissionMode)} (unchanged)`,
    });
    return;
  }

  const change = runtime.changePermissionMode(argument);
  if (change.previous === change.mode) {
    dispatch({
      type: 'notice',
      text: `already in ${change.mode} mode — ${describeApprovalMode(change.mode)}\n${available}`,
    });
    return;
  }

  // The withdrawal line is the visible half of the in-flight contract: a prompt
  // that vanished or a classifier check that was abandoned must be accounted for,
  // or the user is left wondering which mode answered their question.
  const withdrawn =
    change.withdrawn === 0
      ? ''
      : `\n  ${change.withdrawn} pending tool decision(s) withdrawn and re-decided under ${change.mode}`;
  dispatch({
    type: 'notice',
    text:
      `permission mode: ${describeApprovalMode(change.mode)} (was ${change.previous})${withdrawn}\n` +
      `  this session only — ~/${DARWIN_DIRNAME}/${CONFIG_FILENAME} is unchanged`,
    // Widening enforcement is a warning, exactly as the header colours yolo.
    ...(change.mode === 'yolo' ? { severity: 'warn' as const } : {}),
  });
}

/**
 * The `/permissions` listing: every live allow-rule, numbered, with its origin.
 *
 * Origin is stated per rule because the two kinds answer different questions —
 * a `configured` rule was a deliberate entry in the project's permission-rules
 * file, a `granted this session` rule is minutes old and the more likely
 * revocation target. Exported for the free spike, like `formatUsageReport`.
 */
export function formatPermissionRulesReport(
  entries: readonly AllowRuleEntry[],
  rulesFile: string,
): string {
  if (entries.length === 0) {
    return (
      'no allow-rules in effect — every non-safe call asks\n' +
      `  rules come from the permission prompt\u2019s "always allow" options, or from ${rulesFile}`
    );
  }
  const rows = entries.map(
    (entry, index) =>
      `  ${index + 1}. ${entry.rule} — ${entry.origin === 'configured' ? 'configured' : 'granted this session'}`,
  );
  return [
    `allow-rules in effect (${entries.length}) — configured rules load from ${rulesFile}`,
    ...rows,
    '  /permissions revoke <n|rule|all> revokes; new rules come only from the permission prompt',
  ].join('\n');
}

/**
 * Runs `/permissions`, dispatching whatever notice it earns.
 *
 * Listing and revoking share one entry point, like `/mode`: both answer "what
 * runs without asking right now". This command can only ever *narrow*: there is
 * no argument form that adds or rewrites a rule, so a parsing bug costs an
 * unrevoked rule (visible in the listing) or an extra prompt, never a widening.
 *
 * Revocation takes effect on the gate synchronously — the very next matching
 * tool call prompts again — and the file write is reported rather than awaited,
 * exactly like the grant flow: a failed write means the rule is gone for this
 * session but will load again next process, and the notice says so.
 */
export function applyPermissionsCommand(
  runtime: AgentRuntime,
  text: string,
  dispatch: (action: TurnAction) => void,
): void {
  const argument = text.slice('/permissions'.length).trim();
  const usage = 'usage: /permissions — list allow-rules · /permissions revoke <n|rule|all>';

  if (argument === '') {
    dispatch({
      type: 'notice',
      text: formatPermissionRulesReport(runtime.listAllowRules(), runtime.info.permissionRulesPath),
    });
    return;
  }

  const separator = argument.search(/\s/);
  const verb = separator === -1 ? argument : argument.slice(0, separator);
  // The verb is case-insensitive; the target never is, because rules are exact
  // strings and `bash:PNPM *` is not `bash:pnpm *`.
  const target = separator === -1 ? '' : argument.slice(separator).trim();

  if (verb.toLowerCase() !== 'revoke') {
    dispatch({ type: 'notice', text: `${verb} is not a /permissions subcommand\n  ${usage}` });
    return;
  }
  if (target === '') {
    dispatch({ type: 'notice', text: `revoke needs a target\n  ${usage}` });
    return;
  }

  const entries = runtime.listAllowRules();
  let targets: readonly string[];
  if (target.toLowerCase() === 'all') {
    targets = entries.map((entry) => entry.rule);
    if (targets.length === 0) {
      dispatch({ type: 'notice', text: 'no allow-rules in effect — nothing to revoke' });
      return;
    }
  } else {
    // An index from the listing, or the exact rule string. Index wins for a
    // purely numeric target: rules carry a tool name, so none is all digits.
    const index = /^\d+$/.test(target) ? Number(target) : undefined;
    const chosen = index !== undefined ? entries[index - 1] : entries.find((entry) => entry.rule === target);
    if (chosen === undefined) {
      dispatch({
        type: 'notice',
        text: `${target} matches no live allow-rule — nothing revoked\n  /permissions lists them with their numbers`,
      });
      return;
    }
    targets = [chosen.rule];
  }

  const { removed, saved } = runtime.revokeAllowRules(targets);
  const headline =
    removed.length === 1
      ? `revoked ${removed[0]} — the next matching call will ask again`
      : `revoked ${removed.length} allow-rules — the next matching calls will ask again`;
  saved.then(
    () => {
      dispatch({ type: 'notice', text: `${headline}\n  removed from ${runtime.info.permissionRulesPath}` });
    },
    (error: unknown) => {
      dispatch({
        type: 'notice',
        text:
          `${headline}, but this session only — could not write ` +
          `${runtime.info.permissionRulesPath}: ${error instanceof Error ? error.message : String(error)}\n` +
          '  a fresh process will load the rule again',
        // The gate already stopped honouring it; only the file lost out.
        severity: 'warn',
      });
    },
  );
}


/** One line covering both what was asked for and what the model will actually do. */
function describeThinking(plan: ThinkingPlan): string {
  if (plan.problem !== undefined) return `${plan.requested} — ${plan.problem}`;
  return plan.requested;
}

/**
 * Runs `/model`, dispatching whatever notice it earns.
 *
 * Listing and switching share one entry point for the same reason `/effort` does:
 * both answer "which model am I talking to". An unresolvable argument changes
 * nothing and prints the list, rather than falling through to the model as a
 * prompt — a mistyped model name is not a question worth paying for.
 *
 * The switch is awaited (building a model can need a dynamic import) but the
 * `~/.darwin/config.json` write is not, exactly as with `/effort` and an accepted
 * allow-rule: a failed write means "this session only", which must be reported and
 * must not be waited for.
 */
async function applyModelCommand(
  runtime: AgentRuntime,
  text: string,
  dispatch: (action: TurnAction) => void,
): Promise<void> {
  const argument = text.slice('/model'.length).trim();
  const choices = runtime.modelChoices;

  if (argument === '') {
    dispatch({ type: 'notice', text: formatModelList(choices) });
    return;
  }

  const target = resolveModelChoice(choices, argument);
  if (target === undefined) {
    dispatch({
      type: 'notice',
      text: `no configured model matches ${JSON.stringify(argument)}\n${formatModelList(choices)}`,
    });
    return;
  }
  if (target === 'ambiguous') {
    dispatch({
      type: 'notice',
      text: `${JSON.stringify(argument)} matches more than one model — be more specific\n${formatModelList(choices)}`,
    });
    return;
  }
  if (target.enabled) {
    dispatch({ type: 'notice', text: `already on ${target.name}\n${formatModelList(choices)}` });
    return;
  }

  let result;
  try {
    result = await runtime.changeModel(target);
  } catch (error) {
    // The session is still on the old model — changeModel builds before it swaps —
    // so this is a report, not a broken state.
    dispatch({
      type: 'notice',
      text:
        `could not switch to ${target.name}: ${error instanceof Error ? error.message : String(error)}\n` +
        `  still on ${describeChoice(choices.find((choice) => choice.enabled) as ModelChoice)}`,
      severity: 'error',
    });
    return;
  }

  const applied =
    `model: ${describeChoice(result.choice)}\n` +
    `  thinking effort: ${describeThinking(result.thinking)}\n` +
    `  prompt cache: ${result.promptCache.problem ?? (result.promptCache.enabled ? result.promptCache.parts.join(', ') : 'off')}`;

  result.saved.then(
    () => {
      dispatch({ type: 'notice', text: `${applied}\n  saved to ~/${DARWIN_DIRNAME}/${CONFIG_FILENAME}` });
    },
    (error: unknown) => {
      dispatch({
        type: 'notice',
        text:
          `${applied}\n  this session only — could not write ` +
          `~/${DARWIN_DIRNAME}/${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
        // The switch already happened; only its persistence degraded.
        severity: 'warn',
      });
    },
  );
}

/** The catalogue, one row each, with the live entry marked. */
function formatModelList(choices: readonly ModelChoice[]): string {
  const rows = choices.map(
    (choice) => `  ${choice.enabled ? '*' : ' '} ${choice.index + 1}. ${describeChoice(choice)}`,
  );
  return [
    choices.length === 1 ? 'one model configured:' : `${choices.length} models configured:`,
    ...rows,
    ...(choices.length === 1
      ? [`  add a "models" array to ~/${DARWIN_DIRNAME}/${CONFIG_FILENAME} to switch between several`]
      : ['  switch with /model <number|name>']),
  ].join('\n');
}

/** `name (provider/model-id)`, collapsing the name when it is the model id. */
function describeChoice(choice: ModelChoice): string {
  const { name, fields } = choice;
  const target = `${fields.provider}/${fields.model}`;
  return name === fields.model ? target : `${name} (${target})`;
}

/**
 * Resolves a `/model` argument to a choice: a 1-based position, an exact name, or
 * a unique case-insensitive substring of either the name or the model id.
 *
 * Three ways rather than one because the same list is addressed by eye ("2"), by
 * habit ("sol") and by paste ("openai.gpt-5.6-sol"). A substring that matches
 * several entries returns `'ambiguous'` instead of the first hit: picking one
 * would switch to a model the user did not name.
 *
 * An all-digits argument is *only* ever a position — never a substring. Falling
 * through would let `/model 4` land on `claude-sonnet-4-6` because its id happens
 * to contain a 4, which is the worst kind of match: plausible, silent and wrong.
 */
export function resolveModelChoice(
  choices: readonly ModelChoice[],
  argument: string,
): ModelChoice | 'ambiguous' | undefined {
  const needle = argument.toLowerCase();

  if (/^\d+$/.test(argument)) {
    const position = Number(argument);
    return position >= 1 && position <= choices.length ? choices[position - 1] : undefined;
  }

  const exact = choices.filter((choice) => choice.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];

  const partial = choices.filter(
    (choice) =>
      choice.name.toLowerCase().includes(needle) || choice.fields.model.toLowerCase().includes(needle),
  );
  if (partial.length === 1) return partial[0];
  return partial.length > 1 ? 'ambiguous' : undefined;
}

/** Command names matching a `/prefix`, or none when the input is not a bare command. */
export function computeCompletions(input: string, commandNames: readonly string[]): string[] {
  if (!input.startsWith('/')) return [];
  // Once there is a space the command is complete and arguments are being typed.
  if (input.includes(' ')) return [];

  const prefix = input.slice(1).toLowerCase();
  return commandNames.filter((name) => name.toLowerCase().startsWith(prefix));
}
