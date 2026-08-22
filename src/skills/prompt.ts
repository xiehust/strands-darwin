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
const LEARNED_MEMORY_TAG = 'learned-memory';
const AVAILABLE_SKILLS_OPEN = '<available_skills>';
const AVAILABLE_SKILLS_CLOSE = '</available_skills>';
const LEGACY_SKILLS_TAG = 'available-skills';
const LEGACY_SKILLS_PROLOGUE = [
  `<${LEGACY_SKILLS_TAG}>`,
  'Skills are instruction sets for specific tasks. When a request matches one,',
  'call the load_skill tool with its name to read the full instructions before',
  'you begin. Only the name and description are shown here.',
].join('\n');
const LEGACY_WORKING_PROLOGUE = [
  `<${WORKING_CONTEXT_TAG}>`,
  'Where this session started. The directory listing and the date are a snapshot taken at',
  'startup, not live state: re-check anything that may have changed since, including your own',
  'edits. Paths are absolute unless stated otherwise.',
].join('\n');

/** Reorders one official catalogue block for the imminent model request. */
export function orderOfficialSkillsPrompt(agent: LocalAgent): boolean {
  const prompt = agent.systemPrompt;
  if (!Array.isArray(prompt)) return false;

  const parsed = parseKnownPrompt(prompt);
  if (parsed === undefined || parsed.catalogue === undefined) return false;

  agent.systemPrompt = [
    new TextBlock(parsed.base),
    parsed.catalogue,
    ...(parsed.learnedMemory === undefined ? [] : [parsed.learnedMemory]),
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
  fragment: string | undefined,
  learnedMemory?: string | null,
): SystemPrompt | undefined {
  if (typeof prompt === 'string') {
    // Pre-migration uncached/OpenAI snapshots stored the whole prompt as one
    // string. Split only standalone trailing blocks: project instructions may
    // legitimately mention either tag as prose and must remain byte-identical.
    const legacy = splitLegacyPrompt(prompt);
    if (legacy !== undefined) {
      return refreshParsedPrompt({ base: legacy.base, workingContext: new TextBlock(legacy.workingContext) }, fragment, learnedMemory);
    }
    // A fresh base/project prompt has no historical structural prologue. If one
    // is present but the complete suffix cannot be proven, refuse instead of
    // treating potentially stale blocks as generic base text.
    if (prompt.includes(LEGACY_SKILLS_PROLOGUE) || prompt.includes(LEGACY_WORKING_PROLOGUE)) {
      return undefined;
    }
    const base = prompt.trimEnd();
    return base === '' ? undefined : refreshParsedPrompt({ base }, fragment, learnedMemory);
  }
  if (!Array.isArray(prompt)) return undefined;

  const legacy = parseLegacyCachedPrompt(prompt);
  if (legacy !== undefined) return refreshParsedPrompt(legacy, fragment, learnedMemory);
  if (isAmbiguousLegacyCachedPrompt(prompt)) return undefined;
  const parsed = parseKnownPrompt(prompt);
  if (parsed === undefined) return undefined;
  return refreshParsedPrompt(parsed, fragment, learnedMemory);
}

function refreshParsedPrompt(
  parsed: PromptParts,
  workingContext: string | undefined,
  learnedMemory: string | null | undefined,
): SystemPrompt {
  const memoryBlock = learnedMemory === null
    ? undefined
    : learnedMemory === undefined ? parsed.learnedMemory : new TextBlock(learnedMemory);
  return [
    new TextBlock(parsed.base),
    ...(parsed.catalogue === undefined ? [] : [parsed.catalogue]),
    ...(memoryBlock === undefined ? [] : [memoryBlock]),
    ...(workingContext === undefined
      ? parsed.workingContext === undefined ? [] : [parsed.workingContext]
      : [new TextBlock(workingContext)]),
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
  let learnedMemory: TextBlock | undefined;
  let workingContext: TextBlock | undefined;
  const baseParts: string[] = [];

  for (const block of withoutCache as TextBlock[]) {
    if (isCatalogue(block.text)) {
      if (catalogue !== undefined) return undefined;
      catalogue = block;
      continue;
    }
    if (isLearnedMemory(block.text)) {
      if (learnedMemory !== undefined) return undefined;
      learnedMemory = block;
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
  return { base, catalogue, learnedMemory, workingContext, cachePoint };
}

/** Migrates snapshots written before official AgentSkills used separate blocks. */
function parseLegacyCachedPrompt(prompt: SystemPrompt): PromptParts | undefined {
  if (!Array.isArray(prompt) || prompt.length !== 2) return undefined;
  const [text, cachePoint] = prompt;
  if (!(text instanceof TextBlock) || !(cachePoint instanceof CachePointBlock)) return undefined;
  const legacy = splitLegacyPrompt(text.text);
  if (legacy === undefined) return undefined;
  return {
    base: legacy.base,
    // The legacy catalogue used Darwin's old XML shape and has no official
    // lastInjectedXml state. Drop it so official AgentSkills injects exactly one
    // current catalogue on the first resumed invocation.
    catalogue: undefined,
    workingContext: new TextBlock(legacy.workingContext),
    cachePoint,
  };
}

function isAmbiguousLegacyCachedPrompt(prompt: SystemPrompt): boolean {
  if (!Array.isArray(prompt) || prompt.length !== 2) return false;
  const [text, cachePoint] = prompt;
  return (
    text instanceof TextBlock &&
    cachePoint instanceof CachePointBlock &&
    (text.text.includes(LEGACY_SKILLS_PROLOGUE) || text.text.includes(LEGACY_WORKING_PROLOGUE))
  );
}

interface LegacyPromptParts {
  base: string;
  workingContext: string;
}

/**
 * Recognizes exactly the historical Darwin suffix:
 * `<fixed skills prologue>…</available-skills>\n\n<fixed working prologue>…</working-context>`.
 * Fixed prologues establish the outer openings; known adjacency establishes both
 * boundaries. Literal opening-tag text inside project rules or either body is data.
 */
function splitLegacyPrompt(text: string): LegacyPromptParts | undefined {
  const trimmed = text.trimEnd();
  const workingClose = `</${WORKING_CONTEXT_TAG}>`;
  if (!trimmed.endsWith(workingClose)) return undefined;

  const skillsBoundary = `</${LEGACY_SKILLS_TAG}>\n\n${LEGACY_WORKING_PROLOGUE}`;
  const boundary = trimmed.lastIndexOf(skillsBoundary);
  if (boundary === -1) return undefined;
  const workingStart = boundary + `</${LEGACY_SKILLS_TAG}>\n\n`.length;
  const workingContext = trimmed.slice(workingStart);
  if (!workingContext.startsWith(LEGACY_WORKING_PROLOGUE)) return undefined;

  const beforeClose = trimmed.slice(0, boundary);
  const skillsSeparator = `\n\n${LEGACY_SKILLS_PROLOGUE}`;
  const skillsStart = beforeClose.lastIndexOf(skillsSeparator);
  if (skillsStart === -1) return undefined;
  const base = beforeClose.slice(0, skillsStart);
  const skillsBody = beforeClose.slice(skillsStart + 2);
  if (base === '' || !skillsBody.startsWith(LEGACY_SKILLS_PROLOGUE)) return undefined;
  return { base, workingContext };
}

interface PromptParts {
  base: string;
  catalogue?: TextBlock | undefined;
  learnedMemory?: TextBlock | undefined;
  workingContext?: TextBlock | undefined;
  cachePoint?: CachePointBlock | undefined;
}

function isCatalogue(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(AVAILABLE_SKILLS_OPEN) && trimmed.endsWith(AVAILABLE_SKILLS_CLOSE);
}

function isLearnedMemory(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith(`<${LEARNED_MEMORY_TAG}>`) && trimmed.endsWith(`</${LEARNED_MEMORY_TAG}>`);
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
