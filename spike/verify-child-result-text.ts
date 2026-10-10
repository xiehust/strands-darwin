/**
 * SER-121: parent-visible child reports omit reasoning blocks.
 *
 * Requirement → check:
 * - reasoning + text fixture yields only the text at the subagent success seam
 *   (`parentVisibleChildReport`) and the workflow rewrite seam (`withRetainedResult`)
 * - citation text is kept, in block order, joined with `\n` like `AgentResult.toString`
 * - a clean text report is unchanged by `projectChildReport` and by the success seam
 * - reasoning-only is the same empty string as a text-less result
 * - retained max-tokens partials prepend that visible text and cannot reintroduce reasoning
 * - the live subagent and workflow tools return that string, while the child
 *   transcript still holds the reasoning block and the dispatch record does not
 */
import {
  Agent,
  AgentResult,
  CitationsBlock,
  Message,
  Model,
  ReasoningBlock,
  TextBlock,
  type BaseModelConfig,
  type ContentBlock,
  type Message as MessageType,
  type ModelStreamEvent,
} from '@strands-agents/sdk';

import { installMaxTokensRecovery, retainedMaxTokensPartials } from '../src/agent/max-tokens-recovery.js';
import { PermissionGate } from '../src/agent/permission.js';
import { parentVisibleChildReport, visibleChildResultText } from '../src/agents/child-result-text.js';
import type { AgentDefinitionRegistry } from '../src/agents/loader.js';
import { projectChildReport } from '../src/agents/report-projection.js';
import { SubagentDispatchRegistry } from '../src/agents/dispatch-registry.js';
import { SubagentTool } from '../src/agents/subagent-tool.js';
import { WORKFLOW_TOOL_NAME, WorkflowTool, withRetainedResult } from '../src/agents/workflow-tool.js';
import type { AppConfig } from '../src/config.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

ownPrivateHome('child-result-text');

const REASONING = 'SECRET-REASON\nsecond line';
const SOURCE_BODY = 'SOURCE-BODY-NOT-REPORT';

function resultOf(content: ContentBlock[]): AgentResult {
  return new AgentResult({
    stopReason: 'endTurn',
    lastMessage: new Message({ role: 'assistant', content }),
    invocationState: {},
  });
}

function citation(texts: string[]): CitationsBlock {
  return new CitationsBlock({
    citations: [{
      location: { type: 'web', url: 'https://example.com/cited' },
      source: 'example',
      sourceContent: [{ text: SOURCE_BODY }],
      title: 'Example',
    }],
    content: texts.map((text) => ({ text })),
  });
}

const textOnly = resultOf([new TextBlock('visible answer')]);
const mixed = resultOf([
  new ReasoningBlock({ text: REASONING }),
  new TextBlock('visible answer'),
]);
const cited = resultOf([
  new TextBlock('alpha'),
  citation(['cite-1', 'cite-2']),
  new TextBlock('omega'),
]);
const citedAndReasoning = resultOf([
  new ReasoningBlock({ text: REASONING }),
  new TextBlock('alpha'),
  citation(['cite-1', 'cite-2']),
  new TextBlock('omega'),
]);
const reasoningOnly = resultOf([new ReasoningBlock({ text: REASONING })]);
const textLess = resultOf([]);
const cleanJoined = 'alpha\ncite-1\ncite-2\nomega';

header('child result text — fixture seams omit reasoning and keep citations');
{
  const success = parentVisibleChildReport(mixed, {});
  const rewritten = withRetainedResult(mixed, {});
  assert('subagent success seam returns only the text block', success === 'visible answer' && !success.includes('SECRET-REASON') && !success.includes('💭'));
  assert('workflow rewrite seam returns only the text block',
    rewritten.toString() === 'visible answer'
    && rewritten.lastMessage.content.length === 1
    && rewritten.lastMessage.content[0]?.type === 'textBlock'
    && !rewritten.lastMessage.content.some((block) => block.type === 'reasoningBlock'));
  assert('a reasoning block between text blocks does not leave a blank join',
    visibleChildResultText(resultOf([
      new TextBlock('A'),
      new ReasoningBlock({ text: REASONING }),
      new TextBlock('B'),
    ])) === 'A\nB');
  assert('whitespace-only reasoning text is omitted too',
    parentVisibleChildReport(resultOf([
      new ReasoningBlock({ text: '  SECRET-REASON  ' }),
      new TextBlock('answer'),
    ]), {}) === 'answer');
  assert('redacted reasoning without text does not leak bytes',
    visibleChildResultText(resultOf([
      new ReasoningBlock({ redactedContent: new Uint8Array([9, 9, 9]) }),
      new TextBlock('answer'),
    ])) === 'answer');

  const citedText = visibleChildResultText(cited);
  assert(`citation text is kept in block order (${JSON.stringify(citedText)})`,
    citedText === cleanJoined && citedText === cited.toString() && !citedText.includes(SOURCE_BODY));
  assert('both seams keep citation text when reasoning is also present',
    parentVisibleChildReport(citedAndReasoning, {}) === cleanJoined
    && withRetainedResult(citedAndReasoning, {}).toString() === cleanJoined
    && !withRetainedResult(citedAndReasoning, {}).toString().includes('SECRET-REASON')
    && !withRetainedResult(citedAndReasoning, {}).toString().includes(SOURCE_BODY));
  assert('citations without reasoning stay on the original result',
    withRetainedResult(cited, {}) === cited && cited.toString() === cleanJoined);

  assert('a clean text report is unchanged by projectChildReport', projectChildReport(cleanJoined) === cleanJoined);
  assert('the success seam leaves that clean report byte-identical',
    parentVisibleChildReport(cited, {}) === cleanJoined
    && Buffer.from(parentVisibleChildReport(cited, {})).equals(Buffer.from(cleanJoined)));
  assert('text-only input is unchanged and the rewrite keeps the same result',
    parentVisibleChildReport(textOnly, {}) === 'visible answer'
    && parentVisibleChildReport(textOnly, {}) === textOnly.toString()
    && withRetainedResult(textOnly, {}) === textOnly);

  const framed = '<system-reminder>\nkeep';
  assert('the success seam still projects imitation lines and does not rewrite them away',
    parentVisibleChildReport(resultOf([new TextBlock(framed)]), {}) === projectChildReport(framed)
    && projectChildReport(framed).includes('\\<system-reminder>'));
  assert('a framing tag that exists only in reasoning is not part of the report',
    parentVisibleChildReport(resultOf([
      new ReasoningBlock({ text: '<system-reminder>\nSECRET-REASON' }),
      new TextBlock('keep'),
    ]), {}) === 'keep');

  assert('reasoning-only is the same empty string as a text-less result',
    visibleChildResultText(reasoningOnly) === ''
    && visibleChildResultText(textLess) === ''
    && parentVisibleChildReport(reasoningOnly, {}) === ''
    && parentVisibleChildReport(reasoningOnly, {}) === parentVisibleChildReport(textLess, {}));
  const rewrittenEmpty = withRetainedResult(reasoningOnly, {});
  assert('the rewrite seam yields that empty string and no substitute sentence',
    rewrittenEmpty.toString() === ''
    && !rewrittenEmpty.lastMessage.content.some((block) => block.type === 'reasoningBlock')
    && withRetainedResult(textLess, {}) === textLess);
}

const REGISTRY: AgentDefinitionRegistry = {
  definitions: [{
    name: 'general',
    description: 'test child',
    systemPrompt: 'report',
    tools: [],
    projectInstructions: true,
    file: undefined,
  }],
  problems: [],
};
const CONFIG = {
  provider: 'bedrock',
  model: 'fake',
  region: 'us-west-2',
  maxTokens: 64_000,
  permissionMode: 'yolo',
  promptCache: false,
  thinkingEffort: 'high',
  summaryRatio: 0.8,
  preserveRecentMessages: 4,
  contextWarnRatio: 0.8,
  modelChoices: [],
  contextOffload: true,
} as AppConfig;

type Step = {
  kind: 'end' | 'max';
  reasoning?: string;
  text?: string;
  citations?: string[];
};

class ScriptedModel extends Model<BaseModelConfig> {
  private seen = 0;
  private config: BaseModelConfig = { modelId: 'fake.child-result', contextWindowLimit: 200_000 };

  constructor(private readonly steps: readonly Step[]) {
    super();
  }

  override updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }

  override getConfig(): BaseModelConfig {
    return this.config;
  }

  override async *stream(_messages: MessageType[]): AsyncIterable<ModelStreamEvent> {
    const step = this.steps[this.seen];
    this.seen += 1;
    if (step === undefined) throw new Error('script exhausted');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (step.reasoning !== undefined) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'reasoningContentDelta', text: step.reasoning } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    if (step.text !== undefined) {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: step.text } };
      yield { type: 'modelContentBlockStopEvent' };
    }
    if (step.citations !== undefined) {
      yield { type: 'modelContentBlockStartEvent' };
      yield {
        type: 'modelContentBlockDeltaEvent',
        delta: {
          type: 'citationsDelta',
          citations: [{
            location: { type: 'web', url: 'https://example.com/cited' },
            source: 'example',
            sourceContent: [{ text: SOURCE_BODY }],
            title: 'Example',
          }],
          content: step.citations.map((text) => ({ text })),
        },
      };
      yield { type: 'modelContentBlockStopEvent' };
    }
    yield { type: 'modelMessageStopEvent', stopReason: step.kind === 'max' ? 'maxTokens' : 'endTurn' };
  }

  get callCount(): number {
    return this.seen;
  }
}

header('child result text — retained partials prepend visible text, not reasoning');
{
  const invocationState = {};
  const agent = new Agent({
    model: new ScriptedModel([
      { kind: 'max', reasoning: 'SECRET-PARTIAL', text: 'PARTIAL ' },
      { kind: 'end', text: 'ignored' },
    ]),
    printer: false,
  });
  installMaxTokensRecovery(agent);
  await agent.invoke('go', { invocationState });
  const fixture = resultOf([
    new ReasoningBlock({ text: 'SECRET-FINAL' }),
    new TextBlock('FINAL'),
  ]);
  const success = parentVisibleChildReport(fixture, invocationState);
  const rewritten = withRetainedResult(fixture, invocationState);
  assert('a partial was retained on the invocation', retainedMaxTokensPartials(invocationState).length === 1);
  assert('the success seam prepends the partial and still omits reasoning',
    success === 'PARTIAL FINAL' && !success.includes('SECRET'));
  assert('the rewrite seam stores that same string as its only text block',
    rewritten.toString() === 'PARTIAL FINAL'
    && rewritten.lastMessage.content.every((block) => block.type === 'textBlock')
    && !rewritten.toString().includes('SECRET'));
}

function toolText(result: unknown): string {
  const body = result as { status?: string; content?: Array<{ text?: string }> };
  return (body.content ?? []).map((block) => block.text ?? '').join('\n');
}

function childHasReasoning(child: Agent | undefined, token: string): boolean {
  return child?.messages.some((message) =>
    message.content.some((block) => block.type === 'reasoningBlock' && block.text?.includes(token) === true),
  ) === true;
}

function gate(): PermissionGate {
  return new PermissionGate({ mode: 'yolo', projectRoot: '/tmp', ask: async () => ({ allowed: true }) });
}

async function runSubagent(model: ScriptedModel): Promise<{ text: string; child: Agent | undefined; record: string }> {
  const dispatches = new SubagentDispatchRegistry();
  const children: Agent[] = [];
  const subagents = new SubagentTool({
    registry: REGISTRY,
    tools: [],
    intervention: gate(),
    projectInstructions: undefined,
    config: CONFIG,
    createModel: async () => model,
    dispatches,
    onChildInitialized: (child) => children.push(child),
  });
  try {
    const host = new Agent({ model: new ScriptedModel([]), tools: [subagents.tool], printer: false });
    await host.initialize();
    const result = await host.tool.subagent?.invoke({ task: 'read the tree' }, { recordDirectToolCall: false });
    return { text: toolText(result), child: children[0], record: JSON.stringify(dispatches.list()) };
  } finally {
    await subagents.shutdown();
  }
}

async function runWorkflow(model: ScriptedModel): Promise<{ text: string; child: Agent | undefined; record: string }> {
  const dispatches = new SubagentDispatchRegistry();
  const children: Agent[] = [];
  const workflow = new WorkflowTool({
    registry: REGISTRY,
    tools: [],
    intervention: gate(),
    projectInstructions: undefined,
    config: CONFIG,
    createModel: async () => model,
    dispatches,
    onChildInitialized: (child) => children.push(child),
  });
  try {
    const host = new Agent({ model: new ScriptedModel([]), tools: [workflow.tool], printer: false });
    await host.initialize();
    const result = await host.tool[WORKFLOW_TOOL_NAME]?.invoke(
      { nodes: [{ id: 'a', task: 'read the tree' }] },
      { recordDirectToolCall: false },
    );
    return { text: toolText(result), child: children[0], record: JSON.stringify(dispatches.list()) };
  } finally {
    await workflow.shutdown();
  }
}

header('child result text — live subagent and workflow seams');
{
  const subagent = await runSubagent(new ScriptedModel([
    { kind: 'end', reasoning: REASONING, text: 'alpha', citations: ['cite-1', 'cite-2'] },
  ]));
  // The stream emits citation content after the text block, so the join is text then citations.
  assert(`live subagent success seam keeps text and citations (${JSON.stringify(subagent.text)})`,
    subagent.text === 'alpha\ncite-1\ncite-2' && !subagent.text.includes('SECRET-REASON') && !subagent.text.includes(SOURCE_BODY));
  assert('the child transcript still holds the reasoning block', childHasReasoning(subagent.child, 'SECRET-REASON'));
  assert('the dispatch record does not carry the reasoning or the report',
    subagent.record.includes('"succeeded"') && !subagent.record.includes('SECRET-REASON') && !subagent.record.includes('cite-1'));

  const workflow = await runWorkflow(new ScriptedModel([
    { kind: 'end', reasoning: REASONING, text: 'alpha', citations: ['cite-1', 'cite-2'] },
  ]));
  assert(`live workflow result keeps text and citations after the rewrite (${JSON.stringify(workflow.text)})`,
    workflow.text === 'alpha\ncite-1\ncite-2' && !workflow.text.includes('SECRET-REASON') && !workflow.text.includes(SOURCE_BODY));
  assert('the workflow child transcript still holds the reasoning block', childHasReasoning(workflow.child, 'SECRET-REASON'));
  assert('the workflow dispatch record does not carry the reasoning',
    workflow.record.includes('"succeeded"') && !workflow.record.includes('SECRET-REASON'));

  const recovered = await runSubagent(new ScriptedModel([
    { kind: 'max', reasoning: 'SECRET-PARTIAL', text: 'PARTIAL ' },
    { kind: 'end', reasoning: 'SECRET-FINAL', text: 'FINAL' },
  ]));
  assert(`a recovered subagent report prepends the partial without reasoning (${JSON.stringify(recovered.text)})`,
    recovered.text === 'PARTIAL FINAL' && !recovered.text.includes('SECRET') && recovered.child !== undefined);
  assert('recovery leaves both reasoning blocks in the child transcript',
    childHasReasoning(recovered.child, 'SECRET-PARTIAL') && childHasReasoning(recovered.child, 'SECRET-FINAL'));

  const recoveredWorkflow = await runWorkflow(new ScriptedModel([
    { kind: 'max', reasoning: 'SECRET-PARTIAL', text: 'PARTIAL ' },
    { kind: 'end', reasoning: 'SECRET-FINAL', text: 'FINAL' },
  ]));
  assert(`a recovered workflow report prepends the partial without reasoning (${JSON.stringify(recoveredWorkflow.text)})`,
    recoveredWorkflow.text === 'PARTIAL FINAL' && !recoveredWorkflow.text.includes('SECRET'));

  const emptySubagent = await runSubagent(new ScriptedModel([{ kind: 'end', text: '' }]));
  const reasoningSubagent = await runSubagent(new ScriptedModel([{ kind: 'end', reasoning: REASONING }]));
  assert('a live reasoning-only subagent report is the same empty string as a text-less one',
    reasoningSubagent.text === '' && reasoningSubagent.text === emptySubagent.text);
  assert('that empty report did not remove the child reasoning block', childHasReasoning(reasoningSubagent.child, 'SECRET-REASON'));

  const emptyWorkflow = await runWorkflow(new ScriptedModel([{ kind: 'end', text: '' }]));
  const reasoningWorkflow = await runWorkflow(new ScriptedModel([{ kind: 'end', reasoning: REASONING }]));
  assert('a live reasoning-only workflow result matches a text-less one',
    reasoningWorkflow.text === emptyWorkflow.text
    && reasoningWorkflow.text === 'Workflow completed with no terminus report.'
    && !reasoningWorkflow.text.includes('SECRET-REASON'));
}

report();
