/** Deterministic, network-free contracts for Darwin's composed visual language. */
import { renderToString } from 'ink';
import React from 'react';

import type { AgentRuntime, RuntimeInfo } from '../src/agent/runtime.js';
import { NEVER_WITHDRAWN } from '../src/agent/permission.js';
import { Header } from '../src/tui/App.js';
import { InputBox } from '../src/tui/InputBox.js';
import { MessageList } from '../src/tui/MessageList.js';
import { PermissionPrompt } from '../src/tui/PermissionPrompt.js';
import { layoutEditor } from '../src/tui/prompt-editor.js';
import type { HistoryItem } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const plain = (value: string): string => value.replace(ANSI, '');
const rows = (value: string): number => plain(value).split('\n').length;

const info: RuntimeInfo = {
  config: {
    provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6', region: 'us-west-2',
    modelChoices: [], maxTokens: 64_000, summaryRatio: 0.8, preserveRecentMessages: 10,
    contextWarnRatio: 0.8, permissionMode: 'default', promptCache: true,
    promptCacheTtl: '5m', thinkingEffort: 'high', trajectory: true, diagnostics: false,
  },
  projectRoot: '/workspace', permissionMode: 'default', sessionId: 'session-visual', resumed: false,
  skillNames: ['commit-message', 'review', 'trellis-before-dev'], skillProblems: [],
  commandNames: ['release', 'doctor'], commandProblems: [],
  agentNames: ['general', 'research'], agentProblems: [],
  projectInstructions: { path: '/workspace/AGENTS.md', bytes: 4096, truncated: false },
  projectInstructionsProblem: undefined, systemPromptSource: 'default', systemPromptPath: undefined,
  systemPromptProblem: undefined, workingContextProblem: undefined,
  promptCache: { enabled: true, parts: ['tools', 'system prompt', 'conversation'], ttl: '5m', problem: undefined },
  thinking: { enabled: true, requested: 'high', effective: 'high', problem: undefined },
  mcpConfigPath: '/workspace/.darwin/mcp.json', mcpConfigPaths: ['/workspace/.darwin/mcp.json'],
  mcpOverriddenServerNames: [], permissionRulesPath: '/home/test/rules.json', hookSources: [],
  mcpIgnoredConfigPath: undefined, mcpServerCount: 2,
  toolNames: ['bash', 'fileEditor', 'imageViewer'], trajectoryFile: '/tmp/trajectory.jsonl',
  diagnosticsFile: undefined,
};
const runtime = {
  info,
  config: info.config,
  permissionMode: 'default',
  allowRuleCount: 2,
  promptCache: info.promptCache,
  thinking: info.thinking,
} as unknown as AgentRuntime;

header('visual language — compact status-first header');
const headerOutput = plain(renderToString(<Header runtime={runtime} status="idle" />, { columns: 80 }));
assert('identity and live state lead the header', headerOutput.startsWith('◆ DARWIN · ready'));
assert('model line retains cache and effort state', headerOutput.includes('cache 5m') && headerOutput.includes('effort high'));
assert('mode appears exactly once', headerOutput.split('mode:').length - 1 === 1);
assert('capabilities are summarized by count', headerOutput.includes('loaded: 3 skills · 2 commands · 2 agents · 2 MCP servers'));
assert('capability inventories are not dumped', !headerOutput.includes('commit-message') && !headerOutput.includes('fileEditor'));
// The pre-SER-016 fixture drew eight rows at 80 columns: identity, model, mode,
// AGENTS.md, MCP, skills, wrapped help, and its margin. Compact may only shrink it.
assert(`baseline header does not grow (${rows(headerOutput)} <= 8 rows)`, rows(headerOutput) <= 8);

header('visual language — ANSI-stripped transcript hierarchy');
const history: HistoryItem[] = [
  { kind: 'user', id: 'u', text: 'Review this change.' },
  { kind: 'assistant', id: 'a', text: 'Looks sound.', part: 'whole', codeOpen: false },
  { kind: 'tool', id: 't', name: 'bash', summary: 'bash: pnpm typecheck', status: 'ok', preview: '', inputPreview: '', expanded: false },
  { kind: 'notice', id: 'ni', text: 'session resumed', severity: 'info' },
  { kind: 'notice', id: 'nw', text: 'cache unavailable', severity: 'warn' },
  { kind: 'notice', id: 'ne', text: 'turn failed', severity: 'error' },
];
const transcript = plain(renderToString(
  <MessageList history={history} liveText="" liveCodeOpen={false} columns={80} maxLiveRows={8} staticEpoch={0} />,
  { columns: 80 },
));
for (const marker of ['you>', 'darwin>', 'tool · ✓', 'info ·', 'warn !', 'error !']) {
  assert(`transcript marker survives without colour: ${marker}`, transcript.includes(marker));
}

header('visual language — active composer and completion selection');
const composer = plain(renderToString(
  <InputBox
    layout={layoutEditor('/m', 80, { offset: 2, affinity: 'downstream' })}
    completions={['model', 'mode']}
    completionKind="command"
    completionNote={undefined}
    selectedCompletion={1}
    editable
    hint={undefined}
    recallIndicator={undefined}
    offset={{ top: 0, left: 0 }}
    maxRows={8}
  />,
  { columns: 80 },
));
assert('composer keeps its explicit active prompt marker', composer.includes('you> /m'));
assert('selected completion has a textual pointer', composer.includes('❯ /mode'));
assert('unselected completion is textually different', composer.includes('  /model'));

header('visual language — information-equivalent permission modal');
const request = {
  toolName: 'bash', kind: 'execute' as const, summary: 'bash: pnpm test',
  details: [{ label: 'Command', value: 'pnpm test' }], input: { command: 'pnpm test' },
  risk: 'dangerous' as const, riskReason: 'runs a process',
  source: { kind: 'child' as const, label: 'general#dispatch-1', dispatchId: 'dispatch-1' },
  suggestions: [
    { rule: 'bash:pnpm *', label: 'pnpm *' },
    { rule: 'bash', label: 'all bash' },
  ],
  withdrawn: NEVER_WITHDRAWN,
};
const permission = plain(renderToString(
  <PermissionPrompt request={request} waiting={2} columns={120} maxRows={20} />,
  { columns: 120 },
));
for (const detail of [
  '◆ permission required', '(execute — runs a process)', '2 more queued',
  '[general#dispatch-1] bash: pnpm test', 'Command:', 'pnpm test',
  'allow? y n always: a=pnpm * A=all bash esc=deny',
]) {
  assert(`permission modal retains ${detail}`, permission.includes(detail));
}

header('visual language — file edits render as marker-stable line diffs');
const editInput = {
  command: 'str_replace',
  path: '/workspace/src/calc.ts',
  old_str: '  return n + 2;',
  new_str: '  return n * 2;',
};
const editRequest = {
  toolName: 'fileEditor', kind: 'write' as const, summary: 'fileEditor str_replace: /workspace/src/calc.ts',
  // The gate's blocks as `classify()` builds them; the box must collapse exactly
  // the `editContent` pair into one diff and keep everything else stated.
  details: [
    { label: 'Path', value: editInput.path },
    { label: 'Operation', value: 'str_replace' },
    { label: 'Replace', value: editInput.old_str, editContent: true },
    { label: 'With', value: editInput.new_str, editContent: true },
  ],
  input: editInput,
  risk: 'dangerous' as const, riskReason: 'writes inside the project',
  source: { kind: 'parent' as const, label: 'parent' },
  suggestions: [
    { rule: 'fileEditor:/workspace/src/**', label: '/workspace/src/**' },
    { rule: 'fileEditor', label: 'all fileEditor' },
  ],
  withdrawn: NEVER_WITHDRAWN,
};
const editPermission = plain(renderToString(
  <PermissionPrompt request={editRequest} waiting={0} columns={120} maxRows={20} />,
  { columns: 120 },
));
for (const detail of [
  '[parent] fileEditor str_replace: /workspace/src/calc.ts',
  'Path:', '/workspace/src/calc.ts', 'Operation:', 'str_replace',
  'Diff:', '-   return n + 2;', '+   return n * 2;',
  'allow? y n always: a=/workspace/src/** A=all fileEditor esc=deny',
]) {
  assert(`edit modal retains ${detail}`, editPermission.includes(detail));
}
assert('raw Replace/With blocks are the diff now', !editPermission.includes('Replace:') && !editPermission.includes('With:'));
assert('removal marker precedes addition marker',
  editPermission.indexOf('-   return n + 2;') < editPermission.indexOf('+   return n * 2;'));

const editHistory: HistoryItem[] = [{
  kind: 'tool', id: 'te', name: 'fileEditor', summary: 'fileEditor str_replace: /workspace/src/calc.ts',
  status: 'ok', preview: 'edited /workspace/src/calc.ts', expanded: true,
  inputPreview: 'command: str_replace\npath: /workspace/src/calc.ts\n- old line\n+ new line',
}];
const editTranscript = plain(renderToString(
  <MessageList history={editHistory} liveText="" liveCodeOpen={false} columns={80} maxLiveRows={8} staticEpoch={0} />,
  { columns: 80 },
));
for (const marker of ['- old line', '+ new line', 'command: str_replace']) {
  assert(`finished edit keeps the diff after ANSI stripping: ${marker}`, editTranscript.includes(marker));
}

header('visual language — markdown answers keep their plain text');
// The full projection contracts live in verify-markdown.tsx; this guards the
// composed surface: a markdown-bearing answer drawn through MessageList still
// reads as the exact committed text once ANSI is stripped, markers included.
const markdownHistory: HistoryItem[] = [
  { kind: 'assistant', id: 'md1', text: '## Plan\nUse `pnpm test` — it is **fast**.', part: 'first', codeOpen: false },
  { kind: 'assistant', id: 'md2', text: '```ts\nconst ok = true;\n```', part: 'last', codeOpen: false },
];
const markdownTranscript = plain(renderToString(
  <MessageList history={markdownHistory} liveText="" liveCodeOpen={false} columns={120} maxLiveRows={8} staticEpoch={0} />,
  { columns: 120 },
));
for (const marker of ['## Plan', 'Use `pnpm test` — it is **fast**.', '```ts', 'const ok = true;']) {
  assert(`markdown answer survives ANSI stripping verbatim: ${marker}`, markdownTranscript.includes(marker));
}
assert('the pieced markdown answer still names darwin once',
  markdownTranscript.split('\n').filter((line) => line === 'darwin>').length === 1);

report();
