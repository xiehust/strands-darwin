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
import { Box, Text, useApp, useInput, usePaste } from 'ink';
import React, { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';

import { AGENTS_FILENAME, MAX_INSTRUCTIONS_BYTES } from '../agent/instructions.js';
import type { PermissionDecision } from '../agent/permission.js';
import type { PromptCachePlan } from '../agent/prompt-cache.js';
import type { AgentRuntime, CompactResult, UsageTotals } from '../agent/runtime.js';
import { routeSdkLogs } from '../agent/sdk-logging.js';
import { SYSTEM_PROMPT_FILENAME } from '../agent/system-prompt.js';
import {
  isThinkingEffort,
  THINKING_EFFORTS,
  type ThinkingPlan,
} from '../agent/thinking.js';
import { CONFIG_FILENAME } from '../config.js';
import type { ModelChoice } from '../config.js';
import { BUILTIN_COMMAND_NAMES } from '../commands/custom-commands.js';
import { MCP_CONFIG_FILENAME } from '../mcp/registry.js';
import { DARWIN_DIRNAME } from '../paths.js';
import { InputBox } from './InputBox.js';
import { MessageList } from './MessageList.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { ActiveToolCalls } from './ToolCallPanel.js';
import type { PermissionQueue } from './permission-queue.js';
import { initialTurnState, turnReducer, type TurnAction } from './turn-state.js';

/** Window in which a second Ctrl+C means "exit", not "cancel again". */
const DOUBLE_INTERRUPT_MS = 2000;
const SPINNER_INTERVAL_MS = 90;

/** C0 controls except LF and tab, plus DEL: never treated as draft text. */
const NON_TEXT_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Canonicalizes terminal line endings and drops controls without losing layout. */
function normalizeDraftText(value: string): string {
  return value.replace(/\r+\n/g, '\n').replace(/\r/g, '\n').replace(NON_TEXT_CONTROLS, '');
}

type Status = 'idle' | 'streaming' | 'compacting' | 'awaiting-permission';

export function App({
  runtime,
  permissions,
}: {
  readonly runtime: AgentRuntime;
  readonly permissions: PermissionQueue;
}): React.JSX.Element {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(turnReducer, initialTurnState);
  const [status, setStatus] = useState<Status>('idle');
  const [draft, setDraft] = useState('');
  const [selectedCompletion, setSelectedCompletion] = useState(0);
  const [frame, setFrame] = useState(0);
  const interruptedAt = useRef<number | undefined>(undefined);

  const pendingPermission = useSyncExternalStore(
    (onChange) => permissions.subscribe(onChange),
    permissions.getSnapshot,
    permissions.getSnapshot,
  );

  // A pending confirmation outranks streaming: the loop is blocked on it.
  const effectiveStatus: Status = pendingPermission !== undefined ? 'awaiting-permission' : status;

  // Built-ins stay first, then project commands, then skills. Collision filtering
  // happens in the command loader so every row here is actually invokable.
  const completions = computeCompletions(draft, [
    ...BUILTIN_COMMAND_NAMES,
    ...runtime.info.commandNames,
    ...runtime.info.skillNames,
  ]);

  // Spinner tick, only while a model is actually streaming. `/compact` waits on
  // its own model calls too, but has no per-call tool panel to animate.
  useEffect(() => {
    if (effectiveStatus !== 'streaming') return;
    const timer = setInterval(() => setFrame((f) => f + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [effectiveStatus]);

  // The SDK's default logger writes to the console, which tears this frame. It has
  // something to say now that `/model` exists: switching away from Claude with a
  // reasoning block in the history makes the OpenAI adapter warn, once per
  // request, that it is dropping it. Surfaced as a notice instead of swallowed —
  // the model is losing part of its own history and that is worth one line.
  useEffect(
    () => routeSdkLogs((entry) => dispatch({ type: 'notice', text: `sdk ${entry.level}: ${entry.message}` })),
    [dispatch],
  );

  const runTurn = useCallback(
    async (text: string) => {
      setStatus('streaming');
      try {
        for await (const event of runtime.send(text)) {
          dispatch({ type: 'streamEvent', event });
        }
        await runtime.markResumable();
      } catch (error) {
        // A failed turn must not kill the session; the user may want to retry.
        dispatch({
          type: 'notice',
          text: `turn failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      } finally {
        dispatch({ type: 'turnEnded' });
        setStatus('idle');
        interruptedAt.current = undefined;
      }
    },
    [runtime],
  );

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (text === '') return;

      // Answered from the SDK's meter, never sent to the model: a report on token
      // spend that costs a turn of its own would be self-defeating. Handled before
      // the busy check, so it also answers mid-turn — a long turn is exactly when
      // the question comes up, and reading a counter cannot disturb one.
      if (text === '/usage') {
        setDraft('');
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        dispatch({
          type: 'notice',
          text: formatUsageReport(runtime.usage, runtime.info.resumed, status === 'streaming'),
        });
        return;
      }

      // Also before the busy check, and for a stronger reason than /usage: a turn
      // makes many model calls, so "think harder" is worth acting on while one is
      // running — the level applies from the next call on. It reconfigures the live
      // model rather than sending anything, so it cannot disturb the turn.
      if (text === '/effort' || text.startsWith('/effort ')) {
        setDraft('');
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        applyEffortCommand(runtime, text, dispatch);
        return;
      }

      // Everything below needs the agent, and the SDK runs one turn at a time. The
      // draft is deliberately left in the box so nothing typed is lost — but it is
      // not queued either: sending a prompt written minutes earlier, on its own,
      // is worse than making the user press enter again.
      if (status !== 'idle') {
        dispatch({
          type: 'notice',
          text:
            status === 'compacting'
              ? 'still compacting — press enter again once it finishes'
              : 'still working — press enter again once the turn ends (ctrl+c cancels it)',
        });
        return;
      }

      if (text === '/exit' || text === '/quit') {
        exit();
        return;
      }

      if (text === '/compact' || text.startsWith('/compact ')) {
        setDraft('');
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
        setDraft('');
        setSelectedCompletion(0);
        dispatch({ type: 'userInput', text });
        await applyModelCommand(runtime, text, dispatch);
        return;
      }

      setDraft('');
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
        });
      }

      await runTurn(toSend);
    },
    [exit, runtime, runTurn, status],
  );

  /**
   * Answers the pending confirmation and, when the user picked an "always allow"
   * option, remembers the rule.
   *
   * The gate honours the rule from the decision alone, so the write to
   * `.darwin/config.json` is reported rather than awaited: a failed write means
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
            text: `always allowing ${rule} — saved to ${DARWIN_DIRNAME}/${CONFIG_FILENAME}`,
          });
        },
        (error: unknown) => {
          dispatch({
            type: 'notice',
            text:
              `always allowing ${rule} for this session only — could not write ` +
              `${DARWIN_DIRNAME}/${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
          });
        },
      );
    },
    [permissions, runtime],
  );

  const acceptCompletion = useCallback(() => {
    const chosen = completions[selectedCompletion] ?? completions[0];
    if (chosen === undefined) return;
    setDraft(`/${chosen} `);
    setSelectedCompletion(0);
  }, [completions, selectedCompletion]);

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
    if (status === 'compacting') {
      dispatch({ type: 'notice', text: 'compaction cannot be cancelled safely — press ctrl+c again to exit' });
      return;
    }

    // Deny anything waiting so the loop is not left blocked on a prompt. Not
    // close(): the session survives a cancelled turn, so later turns must still
    // be able to ask for approval.
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

    // No guard for a streaming turn: typing during one stays allowed, and the
    // draft is held back in submit() instead. That is what lets a local command
    // like /usage be answered mid-turn, without ever queueing a prompt into a
    // busy agent. (A pending confirmation is different — it took the keyboard
    // above, because the loop is blocked until it is answered.)

    if (key.return) {
      // A trailing backslash is an explicit continuation marker. Consume it so
      // the prompt sent later contains the intended newline, not editor syntax.
      if (draft.endsWith('\\')) {
        setDraft((current) => `${current.slice(0, -1)}\n`);
        setSelectedCompletion(0);
        return;
      }

      // With a completion highlighted, Enter accepts it rather than submitting a
      // half-typed skill name.
      if (completions.length > 0) {
        acceptCompletion();
        return;
      }
      void submit(draft);
      return;
    }

    // A pty or terminal may batch printable text and its final Enter into one
    // event. Preserve the text, but keep the trailing CR's submit semantics.
    if (typed.length > 1 && typed.endsWith('\r')) {
      const text = draft + normalizeDraftText(typed.slice(0, -1));
      if (text.endsWith('\\')) {
        setDraft(`${text.slice(0, -1)}\n`);
        setSelectedCompletion(0);
        return;
      }
      void submit(text);
      return;
    }

    // Terminals encode Ctrl+J as LF, distinct from the CR emitted by Enter.
    // Ink does not expose an `enter` flag, so the literal input is the contract.
    if (typed === '\n') {
      setDraft((current) => `${current}\n`);
      setSelectedCompletion(0);
      return;
    }

    if (key.tab && completions.length > 0) {
      acceptCompletion();
      return;
    }

    if (key.upArrow && completions.length > 0) {
      setSelectedCompletion((i) => (i - 1 + completions.length) % completions.length);
      return;
    }

    if (key.downArrow && completions.length > 0) {
      setSelectedCompletion((i) => (i + 1) % completions.length);
      return;
    }

    if (key.backspace || key.delete) {
      setDraft((current) => current.slice(0, -1));
      setSelectedCompletion(0);
      return;
    }

    // Ignore chords and non-printable keys; take everything else as text.
    if (key.ctrl || key.meta || key.escape || typed === '') return;

    // A terminal without bracketed-paste support can still deliver a whole write
    // here. Preserve every line just like usePaste rather than submitting at the
    // first one and silently dropping the rest.
    const printable = normalizeDraftText(typed);
    if (printable === '') return;

    setDraft((current) => current + printable);
    setSelectedCompletion(0);
  });

  usePaste((pasted) => {
    // The permission prompt owns all input while visible, including paste.
    if (pendingPermission !== undefined) return;

    const text = normalizeDraftText(pasted);
    if (text === '') return;
    setDraft((current) => current + text);
    setSelectedCompletion(0);
  });

  return (
    <Box flexDirection="column">
      <Header runtime={runtime} />
      <MessageList history={state.history} liveText={state.liveText} />

      {state.thinking && effectiveStatus === 'streaming' && <Text dimColor>thinking…</Text>}
      <ActiveToolCalls tools={state.activeTools} frame={frame} />

      {pendingPermission !== undefined ? (
        <PermissionPrompt request={pendingPermission} waiting={permissions.waiting} />
      ) : (
        <InputBox
          value={draft}
          completions={completions}
          selectedCompletion={selectedCompletion}
          disabled={effectiveStatus === 'streaming' || effectiveStatus === 'compacting'}
          hint={
            effectiveStatus === 'streaming'
              ? 'working… /usage reports tokens · ctrl+c cancels this turn'
              : effectiveStatus === 'compacting'
                ? 'compacting conversation…'
                : undefined
          }
        />
      )}
    </Box>
  );
}

function Header({ runtime }: { readonly runtime: AgentRuntime }): React.JSX.Element {
  const info = runtime.info;
  const instructions = info.projectInstructions;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>darwin</Text>
      <Text dimColor>
        {/* Live, not info.config: /model changes both mid-session, and a header
            that still names the previous model is worse than no header. */}
        {runtime.config.provider}/{runtime.config.model} · session {info.sessionId}
        {info.resumed ? ' (resumed)' : ''}
        {formatPromptCache(runtime.promptCache)}
        {formatThinking(runtime.thinking)}
      </Text>
      {info.permissionMode === 'yolo' ? (
        // Yellow: yolo disables a safety layer, same convention as other warnings.
        <Text color="yellow">mode: yolo — every tool call runs without confirmation</Text>
      ) : (
        // Rule count rides along on this line rather than taking one of its own:
        // see the frame-height comment below.
        <Text dimColor>
          mode: {info.permissionMode}
          {runtime.allowRuleCount > 0 ? ` · ${runtime.allowRuleCount} allow rule(s)` : ''}
        </Text>
      )}
      {instructions !== undefined &&
        (instructions.truncated ? (
          <Text color="yellow">
            {AGENTS_FILENAME}: loaded ({formatBytes(instructions.bytes)}, truncated to{' '}
            {MAX_INSTRUCTIONS_BYTES / 1024} KB)
          </Text>
        ) : (
          <Text dimColor>
            {AGENTS_FILENAME}: loaded ({formatBytes(instructions.bytes)})
          </Text>
        ))}
      {info.projectInstructionsProblem !== undefined && (
        <Text color="yellow">
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
        <Text color="yellow">
          system prompt: using the default — {info.systemPromptProblem}
        </Text>
      )}
      {/* Cost-relevant, so it is stated rather than assumed. Only the "asked for
          but impossible" case gets a line of its own: the header is part of the
          live frame, and every line it grows by is one line of permission prompt
          or tool output that Ink drops off a short terminal. */}
      {info.promptCache.problem !== undefined && (
        <Text color="yellow">prompt cache: off — {info.promptCache.problem}</Text>
      )}
      {/* Same rule as the cache problem above: the level itself rides on the model
          line, and only a gap between what was asked for and what the model can
          actually do earns a line — thinking depth is both a cost and a quality
          decision, so a silent downgrade is not acceptable. */}
      {runtime.thinking.problem !== undefined && (
        <Text color="yellow">thinking: {runtime.thinking.problem}</Text>
      )}
      {info.mcpConfigPath !== undefined && <Text dimColor>mcp: {info.mcpServerCount} server(s)</Text>}
      {info.mcpIgnoredConfigPath !== undefined && (
        <Text color="yellow">
          mcp: using {DARWIN_DIRNAME}/{MCP_CONFIG_FILENAME} — {info.mcpIgnoredConfigPath} ignored
        </Text>
      )}
      {info.skillNames.length > 0 && (
        <Text dimColor>skills: {info.skillNames.join(', ')} — type / to use one</Text>
      )}
      {info.skillProblems.map((problem) => (
        <Text key={problem.directory} color="yellow">
          skill skipped: {problem.directory} — {problem.reason}
        </Text>
      ))}
      {info.commandProblems.map((problem) => (
        <Text key={problem.file} color="yellow">
          command skipped: {problem.file} — {problem.reason}
        </Text>
      ))}
      {info.agentProblems.map((problem) => (
        <Text key={problem.file} color="yellow">
          agent skipped: {problem.file} — {problem.reason}
        </Text>
      ))}
      {/* Extends the existing line rather than adding one: see the frame-height
          comment above. */}
      <Text dimColor>
        /exit to quit · /usage for token counts · /effort sets thinking depth · ctrl+c cancels a turn
      </Text>
    </Box>
  );
}

/** Sizes are shown so an accidentally huge AGENTS.md is visible at a glance. */
function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Cache state as a suffix on the model line rather than a line of its own — see the
 * comment in {@link Header}. Empty when nothing is cached: the off case is either the
 * user's own choice (silent) or reported there as a warning.
 */
function formatPromptCache(plan: PromptCachePlan): string {
  if (!plan.enabled) return '';
  const ttl = plan.ttl ?? 'on';
  // Only the anthropic provider ends up with a single part, and "cache on" there
  // would overstate what is actually being cached.
  return plan.parts.length === 1 ? ` · cache ${ttl} (${plan.parts[0]})` : ` · cache ${ttl}`;
}

/**
 * Thinking depth as a suffix on the model line — same reasoning as
 * {@link formatPromptCache}. Always shown: unlike caching there is no "off" state
 * to stay quiet about, and the level is worth knowing *before* spending a turn at
 * it. A clamped level shows what will actually happen, not what was asked for; the
 * reason is the yellow line in {@link Header}.
 */
function formatThinking(plan: ThinkingPlan): string {
  if (!plan.enabled || plan.effective === undefined) return ' · no thinking';
  return ` · effort ${plan.effective}`;
}

/**
 * The four counters Bedrock bills separately, as a labelled block.
 *
 * Numbers are aligned rather than run together on one line: the point of asking
 * is to compare them (a large cache read next to a small input is the cache
 * working), and that comparison is what a column makes readable.
 */
export function formatUsageReport(
  usage: UsageTotals,
  resumed: boolean,
  turnInFlight = false,
): string {
  const rows: readonly (readonly [string, number])[] = [
    ['input', usage.inputTokens],
    ['cache read', usage.cacheReadInputTokens],
    ['cache write', usage.cacheWriteInputTokens],
    ['output', usage.outputTokens],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = rows.map(
    ([label, value]) => `  ${label.padEnd(labelWidth)}  ${groupDigits(value).padStart(9)}`,
  );

  // "This run" is the honest scope: the SDK's meter is per-process, so a resumed
  // session's earlier spend is simply not knowable here.
  const heading = resumed
    ? 'token usage — this run (resumed: earlier runs are not counted)'
    : 'token usage — this run';
  // Asked mid-turn, the totals are the ones from before it: the meter accumulates
  // a model call when it finishes. Said out loud, because numbers that do not move
  // while the agent is visibly working read as a broken counter.
  const footer = turnInFlight ? ['  (the turn in flight is not counted yet)'] : [];
  return [heading, ...lines, ...footer].join('\n');
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
 * returns, so — exactly as with an accepted allow-rule — the `.darwin/config.json`
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
      dispatch({ type: 'notice', text: `${applied} — saved to ${DARWIN_DIRNAME}/${CONFIG_FILENAME}` });
    },
    (error: unknown) => {
      dispatch({
        type: 'notice',
        text:
          `${applied}, this session only — could not write ` +
          `${DARWIN_DIRNAME}/${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
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
 * `.darwin/config.json` write is not, exactly as with `/effort` and an accepted
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
    });
    return;
  }

  const applied =
    `model: ${describeChoice(result.choice)}\n` +
    `  thinking effort: ${describeThinking(result.thinking)}\n` +
    `  prompt cache: ${result.promptCache.problem ?? (result.promptCache.enabled ? result.promptCache.parts.join(', ') : 'off')}`;

  result.saved.then(
    () => {
      dispatch({ type: 'notice', text: `${applied}\n  saved to ${DARWIN_DIRNAME}/${CONFIG_FILENAME}` });
    },
    (error: unknown) => {
      dispatch({
        type: 'notice',
        text:
          `${applied}\n  this session only — could not write ` +
          `${DARWIN_DIRNAME}/${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
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
      ? [`  add a "models" array to ${DARWIN_DIRNAME}/${CONFIG_FILENAME} to switch between several`]
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
