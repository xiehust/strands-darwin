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
    // string, including Darwin's old catalogue. Remove it before official
    // AgentSkills injects the one current catalogue on the resumed invocation.
    const base = stripWorkingContextText(stripLegacyCatalogues(prompt));
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
  const catalogue = extractLegacyCatalogue(text.text);
  if (catalogue === undefined) return undefined;
  const withoutCatalogue = text.text.replace(catalogue, '').trimEnd();
  const working = extractWorkingContext(withoutCatalogue);
  const base = stripWorkingContextText(withoutCatalogue);
  if (base === '' || working === undefined) return undefined;
  return {
    base,
    // The legacy catalogue used Darwin's old XML shape and has no official
    // lastInjectedXml state. Drop it so official AgentSkills injects exactly one
    // current catalogue on the first resumed invocation.
    catalogue: undefined,
    workingContext: new TextBlock(working),
    cachePoint,
  };
}

function extractLegacyCatalogue(text: string): string | undefined {
  return text.match(/\n*<available-skills>[\s\S]*?<\/available-skills>/)?.[0];
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

function stripLegacyCatalogues(text: string): string {
  return text.replace(/\n*<available-skills>[\s\S]*?<\/available-skills>/g, '').trimEnd();
}
