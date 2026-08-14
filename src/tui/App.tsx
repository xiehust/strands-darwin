/**
 * The TUI root and its state machine.
 *
 * Status transitions: `idle → streaming → idle`, with `awaiting-permission`
 * entered from `streaming` whenever the gate asks a question and left when the
 * user answers.
 *
 * Ctrl+C is handled here rather than by Ink (`exitOnCtrlC: false` at the render
 * call): during a turn the first press cancels that turn but keeps the session,
 * because losing a long conversation to a stray interrupt is worse than an
 * unfinished answer; a second press within a short window, or any press while
 * idle, exits. Ctrl+D always exits.
 */
import { Box, Text, useApp, useInput } from 'ink';
import React, { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';

import { AGENTS_FILENAME, MAX_INSTRUCTIONS_BYTES } from '../agent/instructions.js';
import type { PromptCachePlan } from '../agent/prompt-cache.js';
import type { AgentRuntime } from '../agent/runtime.js';
import { SYSTEM_PROMPT_FILENAME } from '../agent/system-prompt.js';
import { CONFIG_FILENAME } from '../config.js';
import { MCP_CONFIG_FILENAME } from '../mcp/registry.js';
import { DARWIN_DIRNAME } from '../paths.js';
import { InputBox } from './InputBox.js';
import { MessageList } from './MessageList.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { ActiveToolCalls } from './ToolCallPanel.js';
import type { PermissionQueue } from './permission-queue.js';
import { initialTurnState, turnReducer } from './turn-state.js';

/** Window in which a second Ctrl+C means "exit", not "cancel again". */
const DOUBLE_INTERRUPT_MS = 2000;
const SPINNER_INTERVAL_MS = 90;

/** C0 controls and DEL: never treated as typed text. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Drops control characters so a chunk of pasted text stays usable. */
function stripControls(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

type Status = 'idle' | 'streaming' | 'awaiting-permission';

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

  const completions = computeCompletions(draft, runtime.info.skillNames);

  // Spinner tick, only while something is actually running.
  useEffect(() => {
    if (effectiveStatus !== 'streaming') return;
    const timer = setInterval(() => setFrame((f) => f + 1), SPINNER_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [effectiveStatus]);

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

      if (text === '/exit' || text === '/quit') {
        exit();
        return;
      }

      setDraft('');
      setSelectedCompletion(0);
      dispatch({ type: 'userInput', text });

      // A `/skill-name` command sends the skill's full text instead of the
      // literal command. Unknown slash commands fall through as ordinary input.
      let toSend = text;
      try {
        const expanded = await runtime.expandSlashCommand(text);
        if (expanded !== null) {
          dispatch({ type: 'notice', text: `loaded skill "${expanded.skill.name}"` });
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
    [exit, runtime, runTurn],
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

    if (status !== 'streaming' && pendingPermission === undefined) {
      exit();
      return;
    }

    if (previous !== undefined && now - previous < DOUBLE_INTERRUPT_MS) {
      exit();
      return;
    }

    interruptedAt.current = now;
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
      if (typed === 'y' || typed === 'Y') permissions.answer(true);
      else if (typed === 'n' || typed === 'N' || key.escape) permissions.answer(false);
      return;
    }

    if (effectiveStatus === 'streaming') return;

    if (key.return) {
      // With a completion highlighted, Enter accepts it rather than submitting a
      // half-typed skill name.
      if (completions.length > 0) {
        acceptCompletion();
        return;
      }
      void submit(draft);
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

    // Pasted text (and anything a pty sends in one write) arrives as a chunk that
    // may contain a newline. Submit at the newline instead of discarding the whole
    // chunk for containing a control character.
    const newlineAt = typed.search(/[\r\n]/);
    if (newlineAt !== -1) {
      const head = stripControls(typed.slice(0, newlineAt));
      if (head === '' && completions.length > 0) {
        acceptCompletion();
        return;
      }
      void submit(draft + head);
      return;
    }

    const printable = stripControls(typed);
    if (printable === '') return;

    setDraft((current) => current + printable);
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
          disabled={effectiveStatus === 'streaming'}
          hint={effectiveStatus === 'streaming' ? 'working… ctrl+c cancels this turn' : undefined}
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
        {info.config.provider}/{info.config.model} · session {info.sessionId}
        {info.resumed ? ' (resumed)' : ''}
        {formatPromptCache(info.promptCache)}
      </Text>
      {info.permissionMode === 'yolo' ? (
        // Yellow: yolo disables a safety layer, same convention as other warnings.
        <Text color="yellow">mode: yolo — every tool call runs without confirmation</Text>
      ) : (
        <Text dimColor>mode: {info.permissionMode}</Text>
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
      <Text dimColor>/exit to quit · ctrl+c cancels a turn</Text>
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

/** Skill names matching a `/prefix`, or none when the input is not a bare command. */
export function computeCompletions(input: string, skillNames: readonly string[]): string[] {
  if (!input.startsWith('/')) return [];
  // Once there is a space the command is complete and arguments are being typed.
  if (input.includes(' ')) return [];

  const prefix = input.slice(1).toLowerCase();
  return skillNames.filter((name) => name.toLowerCase().startsWith(prefix));
}
