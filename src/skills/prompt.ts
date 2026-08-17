/**
 * Prompt ordering for the official AgentSkills plugin.
 *
 * The SDK appends `<available_skills>` on every BeforeInvocationEvent. Darwin's
 * later hook moves that exact text block ahead of current working context and the
 * final cache point. Only explicit Darwin-owned shapes are accepted; an unknown
 * block array is left untouched rather than flattened or guessed at.
 */
import { CachePointBlock, TextBlock } from '@strands-agents/sdk';
import type { LocalAgent, SystemPrompt } from '@strands-agents/sdk';

const WORKING_CONTEXT_TAG = 'working-context';
const AVAILABLE_SKILLS_OPEN = '<available_skills>';
const AVAILABLE_SKILLS_CLOSE = '</available_skills>';

/** Reorders one official catalogue block for the imminent model request. */
export function orderOfficialSkillsPrompt(agent: LocalAgent): boolean {
  const prompt = agent.systemPrompt;
  if (!Array.isArray(prompt)) return false;

  const parsed = parseKnownPrompt(prompt);
  if (parsed === undefined || parsed.catalogue === undefined) return false;

  agent.systemPrompt = [
    new TextBlock(parsed.base),
    parsed.catalogue,
    ...(parsed.workingContext === undefined ? [] : [parsed.workingContext]),
    ...(parsed.cachePoint === undefined ? [] : [parsed.cachePoint]),
  ];
  return true;
}

/**
 * Replaces current working context while preserving a separate official catalogue
 * and removes the prior cache point so the runtime can apply the current plan.
 */
export function refreshKnownPrompt(
  prompt: SystemPrompt | undefined,
  fragment: string,
): SystemPrompt | undefined {
  if (typeof prompt === 'string') {
    // Pre-migration uncached/OpenAI snapshots stored the whole prompt as one
    // string. Split only standalone trailing blocks: project instructions may
    // legitimately mention either tag as prose and must remain byte-identical.
    const withContext = splitTrailingBlock(prompt, WORKING_CONTEXT_TAG);
    const withoutContext = withContext?.prefix ?? prompt.trimEnd();
    const legacy = splitTrailingBlock(withoutContext, 'available-skills');
    const base = legacy?.prefix ?? withoutContext;
    return base === '' ? undefined : [new TextBlock(base), new TextBlock(fragment)];
  }
  if (!Array.isArray(prompt)) return undefined;

  const parsed = parseLegacyCachedPrompt(prompt) ?? parseKnownPrompt(prompt);
  if (parsed === undefined) return undefined;
  return [
    new TextBlock(parsed.base),
    ...(parsed.catalogue === undefined ? [] : [parsed.catalogue]),
    new TextBlock(fragment),
    ...(parsed.cachePoint === undefined ? [] : [parsed.cachePoint]),
  ];
}

/** A conservative parser for prompt arrays Darwin itself assembles. */
function parseKnownPrompt(prompt: SystemPrompt): PromptParts | undefined {
  if (!Array.isArray(prompt) || prompt.length === 0) return undefined;

  let cachePoint: CachePointBlock | undefined;
  const cacheIndexes = prompt.flatMap((block, index) =>
    block instanceof CachePointBlock ? [index] : [],
  );
  if (cacheIndexes.length > 1) return undefined;
  const cacheIndex = cacheIndexes[0];
  if (cacheIndex !== undefined) {
    // Normal stored shape: cache last. During BeforeInvocationEvent the official
    // plugin has just appended its catalogue after that cache point, so the one
    // other accepted position is immediately before the final catalogue block.
    const lastIndex = prompt.length - 1;
    const beforeOfficialAppend =
      cacheIndex === lastIndex - 1 &&
      prompt[lastIndex] instanceof TextBlock &&
      isCatalogue((prompt[lastIndex] as TextBlock).text);
    if (cacheIndex !== lastIndex && !beforeOfficialAppend) return undefined;
    cachePoint = prompt[cacheIndex] as CachePointBlock;
  }
  const withoutCache = prompt.filter((block) => !(block instanceof CachePointBlock));
  if (withoutCache.some((block) => !(block instanceof TextBlock))) return undefined;

  let catalogue: TextBlock | undefined;
  let workingContext: TextBlock | undefined;
  const baseParts: string[] = [];

  for (const block of withoutCache as TextBlock[]) {
    if (isCatalogue(block.text)) {
      if (catalogue !== undefined) return undefined;
      catalogue = block;
      continue;
    }
    if (isWorkingContext(block.text)) {
      if (workingContext !== undefined) return undefined;
      workingContext = new TextBlock(extractWorkingContext(block.text) ?? block.text);
      const base = stripWorkingContextText(block.text);
      if (base !== '') baseParts.push(base);
      continue;
    }
    baseParts.push(block.text);
  }

  if (baseParts.length !== 1) return undefined;
  const base = (baseParts[0] ?? '').trimEnd();
  if (base === '') return undefined;
  return { base, catalogue, workingContext, cachePoint };
}

/** Migrates snapshots written before official AgentSkills used separate blocks. */
function parseLegacyCachedPrompt(prompt: SystemPrompt): PromptParts | undefined {
  if (!Array.isArray(prompt) || prompt.length !== 2) return undefined;
  const [text, cachePoint] = prompt;
  if (!(text instanceof TextBlock) || !(cachePoint instanceof CachePointBlock)) return undefined;
  const withContext = splitTrailingBlock(text.text, WORKING_CONTEXT_TAG);
  if (withContext === undefined) return undefined;
  const legacy = splitTrailingBlock(withContext.prefix, 'available-skills');
  if (legacy === undefined || legacy.prefix === '') return undefined;
  return {
    base: legacy.prefix,
    // The legacy catalogue used Darwin's old XML shape and has no official
    // lastInjectedXml state. Drop it so official AgentSkills injects exactly one
    // current catalogue on the first resumed invocation.
    catalogue: undefined,
    workingContext: new TextBlock(withContext.block),
    cachePoint,
  };
}

interface TrailingBlock {
  /** Prefix with only the separator newlines before the block removed. */
  prefix: string;
  /** Exact standalone block text, without separator newlines. */
  block: string;
}

/**
 * Splits only a whole block at the end of a string. Searching backward from the
 * exact closing tag prevents an earlier literal opening-tag mention in project
 * instructions from becoming the migration boundary.
 */
function splitTrailingBlock(text: string, tag: string): TrailingBlock | undefined {
  const trimmed = text.trimEnd();
  const close = `</${tag}>`;
  if (!trimmed.endsWith(close)) return undefined;
  const open = `<${tag}>`;
  const start = trimmed.lastIndexOf(open, trimmed.length - close.length);
  if (start === -1) return undefined;
  const before = trimmed.slice(0, start);
  if (before !== '' && !before.endsWith('\n\n')) return undefined;
  return {
    prefix: before.replace(/\n+$/, ''),
    block: trimmed.slice(start),
  };
}

interface PromptParts {
  base: string;
  catalogue: TextBlock | undefined;
  workingContext: TextBlock | undefined;
  cachePoint: CachePointBlock | undefined;
}

function isCatalogue(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(AVAILABLE_SKILLS_OPEN) && trimmed.endsWith(AVAILABLE_SKILLS_CLOSE);
}

function isWorkingContext(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(`<${WORKING_CONTEXT_TAG}>`) && trimmed.endsWith(`</${WORKING_CONTEXT_TAG}>`);
}

function extractWorkingContext(text: string): string | undefined {
  return text.match(new RegExp(`<${WORKING_CONTEXT_TAG}>[\\s\\S]*?</${WORKING_CONTEXT_TAG}>`))?.[0];
}

function stripWorkingContextText(text: string): string {
  const block = new RegExp(`\\n*<${WORKING_CONTEXT_TAG}>[\\s\\S]*?</${WORKING_CONTEXT_TAG}>`, 'g');
  return text.replace(block, '').trimEnd();
}
