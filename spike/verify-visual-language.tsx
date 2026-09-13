/** Deterministic, network-free contracts for Darwin's composed visual language. */
import { spawnSync } from 'node:child_process';

import { renderToString } from 'ink';
import React from 'react';

import type { AgentRuntime, RuntimeInfo } from '../src/agent/runtime.js';
import { NEVER_WITHDRAWN } from '../src/agent/permission.js';
import { Header, workingStatusIndex } from '../src/tui/App.js';
import { InputBox } from '../src/tui/InputBox.js';
import { MessageList } from '../src/tui/MessageList.js';
import { PermissionPrompt } from '../src/tui/PermissionPrompt.js';
import { layoutEditor } from '../src/tui/prompt-editor.js';
import type { HistoryItem } from '../src/tui/turn-state.js';
import { assert, header, report } from './shared.js';

const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const plain = (value: string): string => value.replace(ANSI, '');
const rows = (value: string): number => plain(value).split('\n').length;

const FORCED_COLOR_FIXTURE = 'DARWIN_VISUAL_LANGUAGE_FORCED_COLOR_FIXTURE';
if (process.env[FORCED_COLOR_FIXTURE] === '1') {
  const history: HistoryItem[] = [
    { kind: 'user', id: 'u', text: 'question' },
    { kind: 'assistant', id: 'a', text: 'answer', part: 'whole', codeOpen: false },
    { kind: 'tool', id: 't', name: 'bash', summary: 'bash: pnpm test', status: 'ok', preview: '', inputPreview: '', expanded: false },
    { kind: 'notice', id: 'ni', text: 'memory report\nsecond line', severity: 'info' },
    { kind: 'notice', id: 'nw', text: 'cache unavailable', severity: 'warn' },
    { kind: 'notice', id: 'ne', text: 'turn failed', severity: 'error' },
  ];
  process.stdout.write(renderToString(
    <MessageList history={history} liveText="" liveCodeOpen={false} columns={80} maxLiveRows={8} staticEpoch={0} />,
    { columns: 80 },
  ));
  process.stdout.write(renderToString(
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
  process.exit(0);
}

const info: RuntimeInfo = {
  config: {
    provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6', region: 'us-west-2',
    modelChoices: [], maxTokens: 64_000, summaryRatio: 0.8, preserveRecentMessages: 10,
    contextWarnRatio: 0.8, permissionMode: 'default', promptCache: true,
    contextOffload: true,
    promptCacheTtl: '5m', thinkingEffort: 'high', trajectory: true, diagnostics: false,
  },
  projectRoot: '/workspace', permissionMode: 'default', sessionId: 'session-visual', resumed: false,
  skillNames: ['commit-message', 'review', 'trellis-before-dev'], skillProblems: [],
  commandNames: ['release', 'doctor'], commandProblems: [],
  agentNames: ['general', 'research'], agentProblems: [],
  projectInstructions: { filename: 'AGENTS.md', path: '/workspace/AGENTS.md', bytes: 4096, truncated: false },
  projectInstructionsProblem: undefined, projectInstructionsProblemFile: undefined, systemPromptSource: 'default', systemPromptPath: undefined,
  systemPromptProblem: undefined, promptSections: { base: 'BASE', instructions: undefined }, workingContextProblem: undefined,
  promptCache: {
    enabled: true,
    automatic: false,
    parts: ['tools', 'system prompt', 'conversation'],
    ttl: '5m',
    problem: undefined,
  },
  thinking: { enabled: true, requested: 'high', effective: 'high', problem: undefined },
  mcpConfigPath: '/workspace/.darwin/mcp.json', mcpConfigPaths: ['/workspace/.darwin/mcp.json'],
  mcpOverriddenServerNames: [], permissionRulesPath: '/home/test/rules.json', hookSources: [], hookShadowNotices: [],
  shellEnv: { withheld: [], passthrough: [] },
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
const workingFrameA = renderToString(<Header runtime={runtime} status="streaming" frame={0} />, { columns: 80 });
const workingFrameB = renderToString(<Header runtime={runtime} status="streaming" frame={1} />, { columns: 80 });
const workingHeaderA = plain(workingFrameA);
const workingHeaderB = plain(workingFrameB);
assert('working animation advances while preserving the exact status text and row count',
  workingStatusIndex(0) !== workingStatusIndex(1) &&
  workingHeaderA.startsWith('◆ DARWIN · working') &&
  workingHeaderB.startsWith('◆ DARWIN · working') &&
  rows(workingHeaderA) === rows(workingHeaderB));
for (const columns of [14, 16, 20, 40, 80]) {
  const first = plain(renderToString(<Header runtime={runtime} status="streaming" frame={0} />, { columns }));
  const next = plain(renderToString(<Header runtime={runtime} status="streaming" frame={6} />, { columns }));
  assert(`working animation stays height-stable at ${columns} columns`, rows(first) === rows(next));
}

header('visual language — background activity stays in one header row');
assert('no running tasks leaves the baseline unchanged', !headerOutput.includes('⠋') && !headerOutput.includes('/tasks'));
for (const status of ['idle', 'streaming', 'awaiting-permission', 'compacting', 'shell'] as const) {
  for (const columns of [14, 20, 30, 40, 80]) {
    const base = plain(renderToString(<Header runtime={runtime} status={status} />, { columns }));
    const active = plain(renderToString(<Header runtime={runtime} status={status} runningTaskCount={2} />, { columns }));
    assert(`${status}: activity adds no rows at ${columns} columns`, rows(base) === rows(active));
    for (let frame = 1; frame <= 10; frame += 1) {
      const next = plain(renderToString(<Header runtime={runtime} status={status} runningTaskCount={2} frame={frame} />, { columns }));
      assert(`${status}: frame ${frame} keeps layout stable at ${columns} columns`,
        rows(next) === rows(active) && next.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '⠋') === active);
      if (columns === 80) assert(`${status}: frame ${frame} advances or wraps only the marker`,
        frame === 10 ? next === active : next !== active);
    }
    if (columns === 80) assert(`${status}: foreground state and background count coexist`,
      active.split('\n')[0]?.includes('⠋ 2 tasks running · /tasks') === true);
  }
}
const activeIdle = plain(renderToString(<Header runtime={runtime} runningTaskCount={1} />, { columns: 80 }));
assert('idle with a job remains ready and shows a singular running label',
  activeIdle.startsWith('◆ DARWIN · ready · ⠋ 1 task running · /tasks'));

const shadowRuntime = {
  ...runtime,
  info: {
    ...info,
    hookShadowNotices: [{
      layer: 'project .darwin',
      directory: '/workspace/.darwin/hooks',
      shadowed: ['/workspace/.darwin/hooks.json'],
    }],
  },
} as unknown as AgentRuntime;
const shadowHeader = plain(renderToString(<Header runtime={shadowRuntime} status="idle" />, { columns: 120 }));
assert('hook-directory shadowing is visible in the startup header',
  shadowHeader.includes('hooks: project .darwin /workspace/.darwin/hooks shadows /workspace/.darwin/hooks.json'));

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

header('visual language — forced-color informational contrast');
const colored = spawnSync(process.execPath, ['--import', 'tsx', import.meta.filename], {
  env: { ...process.env, FORCE_COLOR: '3', [FORCED_COLOR_FIXTURE]: '1' },
  encoding: 'utf8',
});
assert('forced-color fixture renders successfully', colored.status === 0 && colored.error === undefined);
const coloredTranscript = colored.stdout;
const sgrFor = (marker: string): readonly number[] => {
  const markerAt = coloredTranscript.indexOf(marker);
  if (markerAt < 0) return [];
  const preceding = coloredTranscript.slice(0, markerAt);
  const start = preceding.lastIndexOf('\u001B[');
  if (start < 0) return [];
  const match = /^\u001B\[([\d;]*)m/.exec(coloredTranscript.slice(start));
  return match?.[1]?.split(';').filter(Boolean).map(Number) ?? [];
};
const hasSgr = (marker: string, code: number): boolean => sgrFor(marker).includes(code);
assert('informational marker has the semantic accent', hasSgr('info ·', 36));
assert('informational body dims every line using terminal-native intensity',
  coloredTranscript.includes('\u001B[2mmemory report\u001B[22m\n\u001B[2msecond line\u001B[22m'));
assert('user and assistant bodies remain at normal intensity',
  ['question', 'answer'].every((text) => !hasSgr(text, 2)));
assert('warning and error retain distinct semantic colors without dimming',
  coloredTranscript.includes('\u001B[33mwarn ! cache unavailable\u001B[39m')
    && coloredTranscript.includes('\u001B[31merror ! turn failed\u001B[39m'));
assert('ANSI stripping preserves exact informational report bytes',
  plain(coloredTranscript).includes('info · memory report\nsecond line'));
assert('assistant, tool identity, composer and selected completion share the cyan accent',
  ['darwin>', 'tool ·', 'you> ', '❯ /mode'].every((marker) => hasSgr(marker, 36)));
assert('tool outcome stays success green while its identity remains cyan',
  hasSgr('tool ·', 36) && hasSgr('✓ ', 32));
assert('muted completion metadata uses default foreground intensity, not fixed gray',
  hasSgr('/model', 2) && !coloredTranscript.includes('\u001B[90m'));
assert('active composer and completion focus do not use reverse-video SGR',
  !coloredTranscript.includes('\u001B[7m') && !coloredTranscript.includes('\u001B[27m'));

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
  'Diff (+1 -1):', '-   return n + 2;', '+   return n * 2;',
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
  diffStat: { added: 1, removed: 1 },
}];
const editTranscript = plain(renderToString(
  <MessageList history={editHistory} liveText="" liveCodeOpen={false} columns={80} maxLiveRows={8} staticEpoch={0} />,
  { columns: 80 },
));
for (const marker of ['- old line', '+ new line', 'command: str_replace']) {
  assert(`finished edit keeps the diff after ANSI stripping: ${marker}`, editTranscript.includes(marker));
}
assert('the +N -N stat rides the existing summary row, before the truncatable path',
  editTranscript.includes('fileEditor str_replace (+1 -1): /workspace/src/calc.ts'));

// The default compact mode: the complete diff rows and the stat are stated
// without Ctrl+T — finished rows land in `<Static>` scrollback, so nothing is
// withheld. The intraline bold is enhancement only, so the stripped text is
// exactly the diff.
const compactEditHistory: HistoryItem[] = [{
  kind: 'tool', id: 'tc', name: 'fileEditor', summary: 'fileEditor str_replace: /workspace/src/calc.ts',
  status: 'ok', preview: '', expanded: false,
  inputPreview: '  function scale(n) {\n-   return n + 2;\n+   return n * 2;\n  }',
  diffStat: { added: 3, removed: 1 },
}];
const compactTranscript = plain(renderToString(
  <MessageList history={compactEditHistory} liveText="" liveCodeOpen={false} columns={80} maxLiveRows={8} staticEpoch={0} />,
  { columns: 80 },
));
for (const marker of [
  '  function scale(n) {', '-   return n + 2;', '+   return n * 2;', '(+3 -1)',
]) {
  assert(`compact finished edit states ${marker}`, compactTranscript.includes(marker));
}
assert('the compact excerpt carries no Input label — it is the diff itself',
  !compactTranscript.includes('Input:'));

// SER-055: a `replace_all: true` finished row states its scope on one row above
// the same one pair; the stat stays the pair's and the summary is untouched.
const replaceAllHistory: HistoryItem[] = [{
  kind: 'tool', id: 'ta', name: 'fileEditor', summary: 'fileEditor str_replace: /workspace/src/calc.ts',
  status: 'ok', preview: '', expanded: false,
  inputPreview: 'replace_all: every occurrence\n- token\n+ TOKEN',
  diffStat: { added: 1, removed: 1 },
}];
const replaceAllTranscript = plain(renderToString(
  <MessageList history={replaceAllHistory} liveText="" liveCodeOpen={false} columns={80} maxLiveRows={8} staticEpoch={0} />,
  { columns: 80 },
));
for (const marker of ['replace_all: every occurrence', '- token', '+ TOKEN', 'fileEditor str_replace (+1 -1): /workspace/src/calc.ts']) {
  assert(`replace_all finished row states ${marker}`, replaceAllTranscript.includes(marker));
}
assert('the replace_all row precedes the pair',
  replaceAllTranscript.indexOf('replace_all: every occurrence') < replaceAllTranscript.indexOf('- token'));

header('visual language — markdown answers keep their plain text');
// The full projection contracts live in verify-markdown.tsx; this guards the
// composed surface: a markdown-bearing answer drawn through MessageList still
// reads as the exact committed text once ANSI is stripped, markers included.
const markdownHistory: HistoryItem[] = [
  { kind: 'assistant', id: 'md1', text: '## Plan\nUse `pnpm test` — it is **fast**.', part: 'first', codeOpen: false },
  { kind: 'assistant', id: 'md2', text: '```ts\nconst ok = true;\n```', part: 'last', codeOpen: false },
  // Block markers (SER-047): bullets, ordered markers, a `>` prefix and table
  // pipes are dimmed in place, so the row still reads as its committed text.
  { kind: 'assistant', id: 'md3', text: '- first item\n  - nested item\n2. second item\n> quoted advice\n| a | b |\n|---|---|', part: 'last', codeOpen: false },
];
const markdownTranscript = plain(renderToString(
  <MessageList history={markdownHistory} liveText="" liveCodeOpen={false} columns={120} maxLiveRows={8} staticEpoch={0} />,
  { columns: 120 },
));
for (const marker of ['## Plan', 'Use `pnpm test` — it is **fast**.', '```ts', 'const ok = true;',
  '- first item', '  - nested item', '2. second item', '> quoted advice', '| a | b |', '|---|---|']) {
  assert(`markdown answer survives ANSI stripping verbatim: ${marker}`, markdownTranscript.includes(marker));
}
assert('the pieced markdown answer still names darwin once',
  markdownTranscript.split('\n').filter((line) => line === 'darwin>').length === 1);

report();
