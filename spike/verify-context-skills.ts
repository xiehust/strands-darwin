/**
 * SER-106: the /context breakdown expands the skills-catalogue aggregate into one
 * bounded row per catalogued skill — the same one-countTokens-per-component rule,
 * a failed count as `not reported` (never 0), the MAX bound with `… N more`,
 * deterministic catalogue order, and byte-identical aggregate/total//status lines.
 * No model call, no network — the "model" below is the SDK's own base heuristic.
 */
import {
  CachePointBlock,
  Message,
  Model,
  TextBlock,
  type BaseModelConfig,
  type CountTokensOptions,
  type ModelStreamEvent,
  type StreamOptions,
} from '@strands-agents/sdk';

import {
  BASE_PROMPT_LABEL,
  BUILTIN_TOOLS_LABEL,
  CATALOGUE_NOT_INJECTED,
  SKILLS_CATALOGUE_LABEL,
  SKILL_LABEL_PREFIX,
  WORKING_CONTEXT_LABEL,
  measureContextBreakdown,
  skillCatalogueEntries,
  type ComponentCounter,
  type ContextComponent,
} from '../src/agent/context-breakdown.js';
import type { ContextEstimate } from '../src/agent/runtime.js';
import {
  MAX_BREAKDOWN_SKILL_ROWS,
  formatContextBreakdown,
  formatContextReport,
  formatContextReportWithBreakdown,
  formatContextValue,
  formatWindowShare,
} from '../src/tui/context-format.js';
import { assert, header, report } from './shared.js';

/** The SDK's base heuristic (`chars/4` text), nothing else. */
class HeuristicModel extends Model<BaseModelConfig> {
  override updateConfig(): void {}
  override getConfig(): BaseModelConfig {
    return { modelId: 'fake.heuristic' };
  }
  override async *stream(_messages: Message[], _options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    throw new Error('never streamed');
  }
}
const heuristic = new HeuristicModel();

/** A `<skill>` block exactly as the SDK's `_generateSkillsXml` emits one. */
const skillBlock = (name: string, description: string) =>
  `<skill>\n<name>${name}</name>\n<description>${description}</description>\n<location>/skills/${name}/SKILL.md</location>\n</skill>`;
const catalogueOf = (blocks: string[]) => ['<available_skills>', ...blocks, '</available_skills>'].join('\n');
const grouped = (value: number) => value.toLocaleString('en-US');
const component = (label: string, tokens: number | undefined): ContextComponent => ({ label, tokens });

header('/context — per-skill catalogue parsing');
const zeta = skillBlock('zeta', 'Last alphabetically, first in the catalogue');
const alpha = skillBlock('alpha', 'Escaped &lt;/skill&gt; &amp; &lt;name&gt; boundaries stay data');
const catalogue = catalogueOf([zeta, alpha]);
const entries = skillCatalogueEntries(catalogue);
assert('entries are read from the live catalogue in catalogue order, never sorted',
  entries.length === 2 && entries[0]?.name === 'zeta' && entries[1]?.name === 'alpha');
assert('each entry carries its whole <skill> block byte for byte',
  entries[0]?.block === zeta && entries[1]?.block === alpha);
assert('SDK-escaped markup inside a description cannot spoof a skill or name boundary',
  skillCatalogueEntries(catalogueOf([alpha])).length === 1 &&
  skillCatalogueEntries(catalogueOf([alpha]))[0]?.name === 'alpha');
assert('a <skill> block without a <name> is stated as (unnamed), not dropped',
  skillCatalogueEntries(catalogueOf(['<skill>\n<description>x</description>\n</skill>']))[0]?.name === '(unnamed)');
assert('a catalogue without skills yields no entries',
  skillCatalogueEntries('<available_skills>\nNo skills are currently available.\n</available_skills>').length === 0);

header('/context — per-skill measurement over an injected counter');
const base = 'BASE PROMPT';
const workingContext = '<working-context>\n- working directory: /w\n</working-context>';
const live = [
  new TextBlock(base),
  new TextBlock(catalogue),
  new TextBlock(workingContext),
  new CachePointBlock({ cacheType: 'default' }),
];
const promptCalls: string[] = [];
const counter: ComponentCounter = async (_messages, options) => {
  promptCalls.push(String(options.systemPrompt ?? ''));
  return heuristic.countTokens(_messages, options);
};
const inputs = { systemPrompt: live, composed: { base, instructions: undefined }, tools: [], servers: [], messages: [] };
const measured = await measureContextBreakdown(inputs, counter);
assert('the aggregate catalogue row is still counted as one system-prompt section, unchanged',
  measured.systemPrompt.map((row) => row.label).join('|') ===
    [BASE_PROMPT_LABEL, SKILLS_CATALOGUE_LABEL, WORKING_CONTEXT_LABEL].join('|') &&
  measured.systemPrompt[1]?.tokens === Math.ceil(catalogue.length / 4));
assert('one row per catalogued skill, in catalogue order, counted from its own block text',
  measured.skills.map((row) => row.label).join('|') === `${SKILL_LABEL_PREFIX}zeta|${SKILL_LABEL_PREFIX}alpha` &&
  measured.skills[0]?.tokens === Math.ceil(zeta.length / 4) &&
  measured.skills[1]?.tokens === Math.ceil(alpha.length / 4));
const promptSections = promptCalls.filter((text) => text !== '');
assert('exactly one countTokens call per skill — the per-skill calls are the two blocks, once each, in order',
  promptSections.join('|') === [base, catalogue, zeta, alpha, workingContext].join('|') &&
  promptSections.filter((text) => text === zeta).length === 1 &&
  promptSections.filter((text) => text === alpha).length === 1);

header('/context — per-skill rows');
const estimate: ContextEstimate = { estimatedTokens: 10_000, messageCount: 2, windowTokens: 200_000 };
const lines = formatContextReportWithBreakdown(estimate, measured).split('\n');
const aggregateIndex = lines.indexOf(
  `  ${SKILLS_CATALOGUE_LABEL} ~${grouped(Math.ceil(catalogue.length / 4))} tokens · ${formatWindowShare(Math.ceil(catalogue.length / 4), 200_000)}`);
assert('the total line stays byte-identical to the report without a breakdown',
  lines[0] === formatContextReport(estimate));
assert('/status renders the same context value — formatContextValue never sees the breakdown',
  lines[0] === `estimated context — ${formatContextValue(estimate)}`);
assert('the aggregate catalogue row is byte-identical to its pre-SER-106 form',
  aggregateIndex > 0 &&
  lines[aggregateIndex] === `  system prompt · skills catalogue ~${grouped(Math.ceil(catalogue.length / 4))} tokens · ${formatWindowShare(Math.ceil(catalogue.length / 4), 200_000)}`);
assert('per-skill rows expand directly under the aggregate: `skill · <name> ~N tokens · P%`',
  lines[aggregateIndex + 1] === `  ${SKILL_LABEL_PREFIX}zeta ~${grouped(Math.ceil(zeta.length / 4))} tokens · ${formatWindowShare(Math.ceil(zeta.length / 4), 200_000)}` &&
  lines[aggregateIndex + 2] === `  ${SKILL_LABEL_PREFIX}alpha ~${grouped(Math.ceil(alpha.length / 4))} tokens · ${formatWindowShare(Math.ceil(alpha.length / 4), 200_000)}` &&
  lines[aggregateIndex + 3]?.startsWith(`  ${WORKING_CONTEXT_LABEL} `) === true);
const noWindow = formatContextReportWithBreakdown({ estimatedTokens: 1_234, messageCount: 1, windowTokens: undefined }, measured).split('\n');
assert('an unknown window keeps the per-skill token figure and omits the share',
  noWindow.includes(`  ${SKILL_LABEL_PREFIX}zeta ~${grouped(Math.ceil(zeta.length / 4))} tokens`) &&
  !noWindow.some((line) => line.startsWith(`  ${SKILL_LABEL_PREFIX}`) && line.includes('%')));

header('/context — a failed per-skill count');
const failing: ComponentCounter = async (_messages, options: CountTokensOptions) => {
  if (options.systemPrompt === zeta) throw new Error('counting refused');
  return heuristic.countTokens(_messages, options);
};
const degraded = await measureContextBreakdown(inputs, failing);
const degradedLines = formatContextBreakdown(degraded, 200_000);
assert('a skill whose count failed reads `not reported`, never 0, while its neighbour is still counted',
  degraded.skills[0]?.tokens === undefined &&
  degraded.skills[1]?.tokens === Math.ceil(alpha.length / 4) &&
  degradedLines.includes(`  ${SKILL_LABEL_PREFIX}zeta not reported`) &&
  !degradedLines.some((line) => line.startsWith(`  ${SKILL_LABEL_PREFIX}`) && line.includes('~0 tokens')));

header('/context — per-skill bounds');
const manySkills = Array.from({ length: MAX_BREAKDOWN_SKILL_ROWS + 2 }, (_, index) =>
  component(`${SKILL_LABEL_PREFIX}s-${index}`, 100 * (index + 1)));
const shell = {
  systemPrompt: [component(SKILLS_CATALOGUE_LABEL, 5_000)],
  builtinTools: component(BUILTIN_TOOLS_LABEL, 1_000),
  mcpServers: [],
  conversation: [],
};
const capped = formatContextBreakdown({ ...shell, skills: manySkills }, 200_000);
const skillRows = capped.filter((line) => line.startsWith(`  ${SKILL_LABEL_PREFIX}`));
assert('skill rows are capped at the shared list bound with the remainder counted',
  skillRows.length === MAX_BREAKDOWN_SKILL_ROWS &&
  capped[capped.indexOf(skillRows[skillRows.length - 1] ?? '') + 1] === '  … 2 more skills');
assert('the cap keeps catalogue order — the first shown row is the first catalogued skill',
  skillRows[0] === `  ${SKILL_LABEL_PREFIX}s-0 ~100 tokens · <1%`);
assert('one skill over the cap reads the singular',
  formatContextBreakdown({ ...shell, skills: manySkills.slice(0, MAX_BREAKDOWN_SKILL_ROWS + 1) }, 200_000)
    .includes('  … 1 more skill'));
assert('no skills means no skill rows and no remainder line',
  !formatContextBreakdown({ ...shell, skills: [] }, 200_000)
    .some((line) => line.includes(SKILL_LABEL_PREFIX) || line.includes('more skill')));

header('/context — catalogues without entries');
const emptyCatalogue = '<available_skills>\nNo skills are currently available.\n</available_skills>';
const emptyLive = [new TextBlock(base), new TextBlock(emptyCatalogue), new CachePointBlock({ cacheType: 'default' })];
const emptyMeasured = await measureContextBreakdown(
  { ...inputs, systemPrompt: emptyLive }, counter);
assert('an empty catalogue keeps its aggregate row and grows no per-skill rows',
  emptyMeasured.systemPrompt[1]?.label === SKILLS_CATALOGUE_LABEL && emptyMeasured.skills.length === 0);
const beforeInjection = await measureContextBreakdown(
  { ...inputs, systemPrompt: [new TextBlock(base)] }, counter);
assert('a catalogue not yet injected stays a stated absence and grows no per-skill rows',
  beforeInjection.systemPrompt[1]?.label === SKILLS_CATALOGUE_LABEL &&
  beforeInjection.systemPrompt[1]?.absent === CATALOGUE_NOT_INJECTED &&
  beforeInjection.skills.length === 0);

report();
