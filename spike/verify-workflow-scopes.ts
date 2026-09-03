/**
 * Offline SER-065 contracts: declared `writeScopes` on `workflow` nodes.
 *
 * Validation refuses overlapping scopes on unordered nodes and malformed entries
 * before any child, model or dispatch exists; enforcement rides the existing
 * permission gate — a scoped child's out-of-scope `fileEditor` write is denied
 * (never prompted) while `view`, unscoped nodes, `subagent` dispatches and the
 * parent are untouched. Stub models, a stub `fileEditor`, no network.
 * Run: pnpm tsx spike/verify-workflow-scopes.ts
 */
import { Agent, Model, tool as sdkTool } from '@strands-agents/sdk';
import type { BaseModelConfig, Message, ModelStreamEvent } from '@strands-agents/sdk';
import { z } from 'zod';

import { PermissionGate, writeScopeViolation, type ApprovalMode } from '../src/agent/permission.js';
import { SubagentDispatchRegistry } from '../src/agents/dispatch-registry.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import { SubagentTool, SUBAGENT_TOOL_NAME } from '../src/agents/subagent-tool.js';
import {
  MAX_WRITE_SCOPES,
  WORKFLOW_TOOL_NAME,
  WorkflowTool,
  normalizeWriteScope,
  scopesOverlap,
} from '../src/agents/workflow-tool.js';
import { assert, header, report } from './shared.js';

/** Never created: the `fileEditor` below is a stub, so no path is touched. */
const ROOT = '/tmp/darwin-workflow-scopes-project';

const registry: AgentDefinitionRegistry = {
  definitions: [
    { name: 'general', description: 'offline child', systemPrompt: 'offline', tools: undefined, file: '/tmp/general.md' },
  ],
  problems: [],
};

/** Records every write/view that reached the tool body — i.e. cleared the gate. */
const reached: Array<{ command: string; path: string }> = [];
const fileEditorStub = sdkTool({
  name: 'fileEditor',
  description: 'stub of the SDK file editor; records what the gate let through',
  inputSchema: z.object({
    command: z.string(),
    path: z.string().optional(),
    file_text: z.string().optional(),
    old_str: z.string().optional(),
    new_str: z.string().optional(),
    insert_line: z.number().optional(),
  }),
  callback: (input) => {
    reached.push({ command: input.command, path: input.path ?? '' });
    return 'ok';
  },
});

type Step = { tool: Record<string, unknown> } | { text: string };

/** One step per model call: a `fileEditor` tool use, or the final text. */
class ScriptedChildModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'offline.scripted', contextWindowLimit: 100_000 };
  private index = 0;
  constructor(private readonly label: string, private readonly steps: Step[]) { super(); }
  override updateConfig(config: BaseModelConfig): void { this.config = { ...this.config, ...config }; }
  override getConfig(): BaseModelConfig { return this.config; }
  override async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    const step = this.steps[this.index] ?? { text: `${this.label} done` };
    this.index += 1;
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if ('tool' in step) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: 'fileEditor', toolUseId: `${this.label}-${this.index}` },
      };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(step.tool) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
      return;
    }
    yield { type: 'modelContentBlockStartEvent' };
    yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  }
}

interface Fixture {
  workflow: WorkflowTool;
  subagent: SubagentTool;
  dispatches: SubagentDispatchRegistry;
  children: Agent[];
  asks: string[];
  created: () => number;
}

function fixture(models: Model<BaseModelConfig>[], mode: ApprovalMode = 'default'): Fixture {
  const dispatches = new SubagentDispatchRegistry({ heartbeatIntervalMs: 20 });
  const asks: string[] = [];
  const gate = new PermissionGate({
    mode,
    projectRoot: ROOT,
    ask: async (request) => {
      asks.push(`${request.source.label}: ${request.summary}`);
      return { allowed: true };
    },
    dispatchSource: (agentId) => dispatches.sourceFor(agentId),
  });
  const children: Agent[] = [];
  let created = 0;
  const shared = {
    registry,
    tools: [fileEditorStub],
    intervention: gate,
    projectInstructions: undefined,
    config: { model: 'offline', provider: 'bedrock', region: 'us-west-2' } as never,
    createModel: async () => {
      created += 1;
      return models.shift()!;
    },
    dispatches,
    onChildInitialized: (agent: Agent) => children.push(agent),
  };
  return {
    workflow: new WorkflowTool(shared),
    subagent: new SubagentTool(shared),
    dispatches,
    children,
    asks,
    created: () => created,
  };
}

async function host(...tools: Array<WorkflowTool['tool']>): Promise<Agent> {
  const agent = new Agent({ model: new ScriptedChildModel('host', []), tools, printer: false });
  await agent.initialize();
  return agent;
}

type DirectResult = { status?: string; content?: Array<{ text?: string }> };

function resultText(result: unknown): string {
  return ((result as DirectResult).content ?? []).map((block) => block.text ?? '').join('\n');
}

/** Every tool-result text a child received, in order — where `DENIED:` reasons land. */
function childToolResults(child: Agent): string[] {
  const texts: string[] = [];
  for (const message of child.messages) {
    for (const block of message.content) {
      if (block.type !== 'toolResultBlock') continue;
      for (const inner of block.content) if (inner.type === 'textBlock') texts.push(inner.text);
    }
  }
  return texts;
}

const node = (id: string, writeScopes?: string[], task = `work on ${id}`) =>
  ({ id, task, ...(writeScopes === undefined ? {} : { writeScopes }) });

header('write scopes — segment-wise overlap and normalization (pure)');
{
  assert('a directory scope covers a file beneath it', scopesOverlap('src/tui', 'src/tui/App.tsx'));
  assert('overlap is symmetric', scopesOverlap('src/tui/App.tsx', 'src/tui'));
  assert('equal scopes overlap', scopesOverlap('src/tui', 'src/tui'));
  assert('a string prefix is NOT an overlap: src/tu vs src/tui', !scopesOverlap('src/tu', 'src/tui'));
  assert('siblings do not overlap', !scopesOverlap('src/tui', 'src/agent'));
  assert('leading ./ and trailing / are stripped', normalizeWriteScope('n', './src/tui/') === 'src/tui');
  assert('inner . and redundant separators normalize', normalizeWriteScope('n', 'src//./tui') === 'src/tui');
  assert('a file scope survives normalization', normalizeWriteScope('n', 'src/tui/App.tsx') === 'src/tui/App.tsx');
  const refused = (entry: string): string => {
    try {
      normalizeWriteScope('n', entry);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  assert('an absolute entry is refused naming node and entry', /Node "n" writeScopes entry "\/abs".*absolute/.test(refused('/abs')));
  assert('a parent-escaping entry is refused', /escapes the project root/.test(refused('../x')));
  assert('a normalized escape (a/../..) is refused', /escapes the project root/.test(refused('a/../..')));
  assert('an empty entry is refused', /is empty/.test(refused('')));
  assert('a "." entry is refused', /is empty/.test(refused('.')));
  assert('a "./" entry is refused', /is empty/.test(refused('./')));
  assert('a NUL byte is refused', /NUL byte/.test(refused('src/\0tui')));
  const long = refused(`/${'x'.repeat(500)}\n${'y'.repeat(500)}`);
  assert('the refusal quotes a bounded one-line entry', long.length < 260 && !long.includes('\n'));
}

header('write scopes — gate violation predicate (pure)');
{
  const scopes = ['src/tui', 'docs/guide.md'];
  const violation = (toolName: string, input: unknown) => writeScopeViolation(toolName, input, scopes, ROOT);
  assert('a relative create inside a directory scope is within scope',
    violation('fileEditor', { command: 'create', path: 'src/tui/App.tsx' }) === undefined);
  assert('an absolute path under the project root resolves into scope',
    violation('fileEditor', { command: 'str_replace', path: `${ROOT}/src/tui/deep/x.ts` }) === undefined);
  assert('a file scope covers exactly that file',
    violation('fileEditor', { command: 'insert', path: 'docs/guide.md' }) === undefined
    && violation('fileEditor', { command: 'insert', path: 'docs/guide.md.bak' })?.path === 'docs/guide.md.bak');
  assert('a string-prefix sibling (src/tuix) is outside scope',
    violation('fileEditor', { command: 'create', path: 'src/tuix/z.ts' })?.command === 'create');
  assert('a path escaping the project is outside every scope',
    violation('fileEditor', { command: 'create', path: '../outside.ts' })?.path === '../outside.ts');
  assert('a traversal that lands back inside scope is within scope',
    violation('fileEditor', { command: 'create', path: 'src/agent/../tui/x.ts' }) === undefined);
  assert('a missing path is outside scope and stated as such',
    violation('fileEditor', { command: 'create' })?.path === '(no path)');
  assert('view is never judged', violation('fileEditor', { command: 'view', path: '/etc/passwd' }) === undefined);
  assert('bash is never judged', violation('bash', { command: 'echo x > src/agent/x.ts' }) === undefined);
  assert('other tools are never judged', violation('memory_save', { key: 'a:b' }) === undefined);
}

header('write scopes — unordered overlap refused before any construction; ordered admitted');
{
  const f = fixture([]);
  const h = await host(f.workflow.tool);
  const invoke = (input: unknown) => h.tool[WORKFLOW_TOOL_NAME]!.invoke(input as never, { recordDirectToolCall: false });

  const overlap = (await invoke({ nodes: [node('a', ['src/tui']), node('b', ['src/tui/App.tsx'])] })) as DirectResult;
  const text = resultText(overlap);
  assert('two unordered nodes with src/tui vs src/tui/App.tsx are refused naming both ids and both scopes',
    overlap.status === 'error' && /Nodes "a" and "b" declare overlapping writeScopes \("src\/tui" and "src\/tui\/App\.tsx"\)/.test(text)
    && /no edge path orders them/.test(text) && text.length < 400);
  const transitiveUnordered = (await invoke({
    nodes: [node('a', ['src/tui']), node('c'), node('b', ['src/tui/App.tsx'])],
    edges: [['a', 'c']],
  })) as DirectResult;
  assert('an edge to an unrelated node does not order the overlapping pair',
    transitiveUnordered.status === 'error' && /Nodes "a" and "b"/.test(resultText(transitiveUnordered)));
  assert('refusals construct zero models, children and dispatches',
    f.created() === 0 && f.children.length === 0 && f.dispatches.list().length === 0);

  const bad: Array<[string, unknown, RegExp]> = [
    ['an absolute entry', { nodes: [node('a', ['/abs'])] }, /Node "a" writeScopes entry "\/abs" is absolute/],
    ['a parent-escaping entry', { nodes: [node('a', ['../x'])] }, /Node "a" writeScopes entry "\.\.\/x" escapes the project root/],
    ['an empty entry', { nodes: [node('a', [''])] }, /Node "a" writeScopes entry "" is empty/],
    ['a "." entry', { nodes: [node('a', ['.'])] }, /Node "a" writeScopes entry "\." is empty/],
    ['a NUL entry', { nodes: [node('a', ['src/\0x'])] }, /contains a NUL byte/],
    ['nine entries', { nodes: [node('a', Array.from({ length: MAX_WRITE_SCOPES + 1 }, (_, i) => `dir${i}`))] }, new RegExp(`at most ${MAX_WRITE_SCOPES} path prefixes`)],
    ['an empty scope list', { nodes: [node('a', [])] }, /at least one path prefix/],
  ];
  for (const [what, input, pattern] of bad) {
    const result = (await invoke(input)) as DirectResult;
    const message = resultText(result);
    assert(`${what} is a bounded refusal (${JSON.stringify(message.slice(0, 70))}…)`,
      result.status === 'error' && pattern.test(message) && message.length < 400 && !message.includes('\n    at '));
  }
  assert('bad entries construct zero models, children and dispatches',
    f.created() === 0 && f.children.length === 0 && f.dispatches.list().length === 0);
}

{
  const f = fixture([new ScriptedChildModel('a', []), new ScriptedChildModel('b', [])]);
  const h = await host(f.workflow.tool);
  const ordered = (await h.tool[WORKFLOW_TOOL_NAME]!.invoke(
    { nodes: [node('a', ['./src/tui/']), node('b', ['src/tui/App.tsx'])], edges: [['a', 'b']] } as never,
    { recordDirectToolCall: false },
  )) as DirectResult;
  assert('the same pair connected by an edge is admitted and runs', ordered.status !== 'error' && f.dispatches.list().length === 2);
  assert('every node dispatch carries its normalized scopes for the gate',
    f.dispatches.sourceFor(f.children[0]!.id)?.writeScopes?.join() === 'src/tui'
    && f.dispatches.sourceFor(f.children[1]!.id)?.writeScopes?.join() === 'src/tui/App.tsx');
}
{
  const f = fixture([new ScriptedChildModel('a', []), new ScriptedChildModel('c', []), new ScriptedChildModel('b', [])]);
  const h = await host(f.workflow.tool);
  const transitive = (await h.tool[WORKFLOW_TOOL_NAME]!.invoke(
    { nodes: [node('a', ['src/tui']), node('c'), node('b', ['src/tui/App.tsx'])], edges: [['b', 'c'], ['c', 'a']] } as never,
    { recordDirectToolCall: false },
  )) as DirectResult;
  assert('a transitive path through an unscoped node (in either direction) orders the pair',
    transitive.status !== 'error' && f.dispatches.list().every((entry) => entry.state === 'succeeded'));
}
{
  const f = fixture([new ScriptedChildModel('a', []), new ScriptedChildModel('b', [])]);
  const h = await host(f.workflow.tool);
  const disjoint = (await h.tool[WORKFLOW_TOOL_NAME]!.invoke(
    { nodes: [node('a', ['src/tu']), node('b', ['src/tui'])] } as never,
    { recordDirectToolCall: false },
  )) as DirectResult;
  assert('src/tu vs src/tui on unordered nodes is NOT an overlap', disjoint.status !== 'error' && f.dispatches.list().length === 2);
  const unscoped = fixture([new ScriptedChildModel('a', []), new ScriptedChildModel('b', [])]);
  const uh = await host(unscoped.workflow.tool);
  const plain = (await uh.tool[WORKFLOW_TOOL_NAME]!.invoke(
    { nodes: [node('a'), node('b')] } as never, { recordDirectToolCall: false },
  )) as DirectResult;
  assert('nodes without writeScopes take no part in the check and carry none',
    plain.status !== 'error' && unscoped.children.every((child) => unscoped.dispatches.sourceFor(child.id)?.writeScopes === undefined));
}

header('write scopes — the gate denies out-of-scope fileEditor writes, never prompts; view and unscoped nodes untouched');
{
  reached.length = 0;
  const scopedChild = new ScriptedChildModel('ui', [
    { tool: { command: 'create', path: 'src/tui/App.tsx', file_text: 'x' } },
    { tool: { command: 'create', path: 'src/agent/rogue.ts', file_text: 'x' } },
    { tool: { command: 'view', path: 'src/agent/rogue.ts' } },
    { tool: { command: 'str_replace', path: `${ROOT}/src/tui/deep/y.ts`, old_str: 'a', new_str: 'b' } },
    { tool: { command: 'insert', path: '../outside.ts', insert_line: 0, new_str: 'x' } },
    { tool: { command: 'create', path: 'src/tuix/z.ts', file_text: 'x' } },
    { text: 'ui done' },
  ]);
  const plainChild = new ScriptedChildModel('plain', [
    { tool: { command: 'create', path: 'src/agent/anywhere.ts', file_text: 'x' } },
    { tool: { command: 'create', path: '../outside-plain.ts', file_text: 'x' } },
    { text: 'plain done' },
  ]);
  const f = fixture([scopedChild, plainChild]);
  const h = await host(f.workflow.tool);
  const result = (await h.tool[WORKFLOW_TOOL_NAME]!.invoke(
    { nodes: [node('ui', ['src/tui']), node('plain')], edges: [['ui', 'plain']] } as never,
    { recordDirectToolCall: false },
  )) as DirectResult;
  assert('the workflow completes; denials are ordinary tool results, not node failures', result.status !== 'error');

  const uiReached = reached.slice(0, 3).map((entry) => `${entry.command}:${entry.path}`);
  assert('in-scope create, out-of-scope view and absolute in-scope str_replace reached the tool, in order',
    uiReached.join(' ') === `create:src/tui/App.tsx view:src/agent/rogue.ts str_replace:${ROOT}/src/tui/deep/y.ts`);
  assert('out-of-scope create, project-escaping insert and the src/tuix prefix trick never reached the tool',
    !reached.some((entry) => entry.path === 'src/agent/rogue.ts' && entry.command === 'create')
    && !reached.some((entry) => entry.path === '../outside.ts')
    && !reached.some((entry) => entry.path === 'src/tuix/z.ts'));

  const ui = f.children[0]!;
  const uiSource = f.dispatches.sourceFor(ui.id)!;
  const denials = childToolResults(ui).filter((text) => text.startsWith('DENIED:'));
  assert('exactly three denials reached the scoped child', denials.length === 3);
  assert('each denial names the dispatch label, the offending path and the declared scopes',
    denials.every((text) => text.includes(`Workflow node ${uiSource.label}`) && text.includes('writeScopes [src/tui]'))
    && denials[0]!.includes('fileEditor create on src/agent/rogue.ts')
    && denials[1]!.includes('fileEditor insert on ../outside.ts')
    && denials[2]!.includes('fileEditor create on src/tuix/z.ts'));
  assert('each denial tells the model not to retry outside its scope and stays bounded',
    denials.every((text) => text.includes('Do not retry this write') && text.length < 500));
  assert('the scoped node was never prompted — not even for the project-escaping write default mode would ask about',
    !f.asks.some((ask) => ask.startsWith(uiSource.label)));

  const plain = f.children[1]!;
  const plainSource = f.dispatches.sourceFor(plain.id)!;
  assert('the unscoped node\u2019s writes behave exactly as today: in-project runs silently, project-escaping prompts and runs',
    reached.some((entry) => entry.path === 'src/agent/anywhere.ts')
    && reached.some((entry) => entry.path === '../outside-plain.ts')
    && f.asks.length === 1 && f.asks[0] === `${plainSource.label}: fileEditor create: ../outside-plain.ts`
    && childToolResults(plain).every((text) => !text.startsWith('DENIED:')));
}

header('write scopes — scope denial holds in yolo mode and precedes plan mode');
{
  reached.length = 0;
  const yolo = fixture([new ScriptedChildModel('y', [
    { tool: { command: 'create', path: 'src/agent/rogue.ts', file_text: 'x' } },
    { tool: { command: 'create', path: 'src/tui/ok.ts', file_text: 'x' } },
    { text: 'done' },
  ])], 'yolo');
  const yh = await host(yolo.workflow.tool);
  await yh.tool[WORKFLOW_TOOL_NAME]!.invoke({ nodes: [node('y', ['src/tui'])] } as never, { recordDirectToolCall: false });
  assert('yolo still denies the out-of-scope write and runs the in-scope one',
    reached.map((entry) => entry.path).join() === 'src/tui/ok.ts'
    && childToolResults(yolo.children[0]!).filter((text) => text.startsWith('DENIED:')).length === 1);

  const plan = fixture([new ScriptedChildModel('p', [
    { tool: { command: 'create', path: 'src/agent/rogue.ts', file_text: 'x' } },
    { text: 'done' },
  ])], 'plan');
  const ph = await host(plan.workflow.tool);
  await ph.tool[WORKFLOW_TOOL_NAME]!.invoke({ nodes: [node('p', ['src/tui'])] } as never, { recordDirectToolCall: false });
  const planDenial = childToolResults(plan.children[0]!).find((text) => text.startsWith('DENIED:')) ?? '';
  assert('in plan mode the scope reason wins over the plan reason', planDenial.includes('declared writeScopes') && !planDenial.includes('Plan mode'));
}

header('write scopes — a subagent dispatch carries no scopes and is unaffected');
{
  reached.length = 0;
  const f = fixture([new ScriptedChildModel('s', [
    { tool: { command: 'create', path: 'src/agent/anywhere.ts', file_text: 'x' } },
    { text: 'subagent done' },
  ])]);
  const h = await host(f.subagent.tool);
  const result = (await h.tool[SUBAGENT_TOOL_NAME]!.invoke(
    { task: 'write somewhere' } as never, { recordDirectToolCall: false },
  )) as DirectResult;
  assert('the subagent write reaches the tool with no denial and no prompt',
    result.status !== 'error' && reached.length === 1 && f.asks.length === 0
    && childToolResults(f.children[0]!).every((text) => !text.startsWith('DENIED:')));
  assert('its dispatch source carries no writeScopes', f.dispatches.sourceFor(f.children[0]!.id)?.writeScopes === undefined);
}

header('write scopes — description states the contract');
{
  const f = fixture([]);
  const description = f.workflow.tool.description;
  assert('the workflow description explains writeScopes, refusal, denial and the bash exclusion',
    description.includes('writeScopes') && description.includes('refused') && description.includes('denied')
    && description.includes('bash is not covered'));
  assert('the subagent description is unchanged by scopes', !f.subagent.tool.description.includes('writeScopes'));
}

report();
