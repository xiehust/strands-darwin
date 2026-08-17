/**
 * Darwin's compatibility adapter around the official SDK `AgentSkills` plugin.
 *
 * The SDK owns parsing, catalogue injection, activation state and bounded resource
 * listing. Darwin keeps one model-facing contract — `load_skill({ name })` — so
 * existing prompts, permissions and child allowlists do not see a second `skills`
 * tool with a different schema.
 */
import { tool } from '@strands-agents/sdk';
import type {
  InvokableTool,
  LocalAgent,
  Plugin,
  Tool,
  ToolContext,
} from '@strands-agents/sdk';
import { AgentSkills, Skill } from '@strands-agents/sdk/vended-plugins/skills';
import { z } from 'zod';

import { scanSkills, type SkillProblem } from './loader.js';

/** Explicitly bound: the SDK also bounds resource recursion to three levels. */
export const MAX_SKILL_RESOURCE_FILES = 20;
const SKILL_STATE_KEY = 'darwin_agent_skills';

type OfficialSkillsTool = InvokableTool<{ skill_name: string }, string>;

export class SkillsPlugin implements Plugin {
  readonly name = 'darwin:skills';
  private readonly official: AgentSkills;
  private readonly officialTool: OfficialSkillsTool;
  private agent: LocalAgent | undefined;

  private constructor(
    readonly skills: readonly Skill[],
    readonly problems: readonly SkillProblem[],
    maxResourceFiles: number,
  ) {
    this.official = new AgentSkills({
      skills: [...skills],
      maxResourceFiles,
      stateKey: SKILL_STATE_KEY,
    });
    const nativeTools = this.official.getTools();
    const native = nativeTools[0];
    if (nativeTools.length !== 1 || native?.name !== 'skills' || !('invoke' in native)) {
      throw new Error('Official AgentSkills plugin did not provide an invokable skills tool.');
    }
    this.officialTool = native as OfficialSkillsTool;
  }

  /** Scans Darwin's layers and builds an adapter over official SDK Skill objects. */
  static async load(
    root: string,
    options: { maxResourceFiles?: number } = {},
  ): Promise<SkillsPlugin> {
    const { skills, problems } = await scanSkills(root);
    return new SkillsPlugin(
      skills,
      problems,
      options.maxResourceFiles ?? MAX_SKILL_RESOURCE_FILES,
    );
  }

  async initAgent(agent: LocalAgent): Promise<void> {
    this.agent = agent;
    await this.official.initAgent(agent);
  }

  getTools(): Tool[] {
    if (this.skills.length === 0) return [];
    const known = this.skills.map((skill) => skill.name).join(', ');

    return [
      tool({
        name: 'load_skill',
        description:
          `Read the full instructions for one of the available skills before starting a task ` +
          `it applies to. Available skills: ${known}.`,
        inputSchema: z.object({
          name: z.string().describe('Name of the skill to load'),
        }),
        callback: async ({ name }, context) => {
          const skill = this.find(name);
          if (skill === undefined) return this.notFound(name);
          if (context === undefined) {
            throw new Error('load_skill requires a ToolContext with an agent reference');
          }
          return { instructions: await this.activate(skill, context) };
        },
      }),
    ];
  }

  /** Case-insensitive for both the compatibility tool and `/Commit-Message`. */
  find(name: string): Skill | undefined {
    const wanted = name.trim().toLowerCase();
    return this.skills.find((skill) => skill.name.toLowerCase() === wanted);
  }

  /** Official activation, used by both the tool callback and slash expansion. */
  async activate(skill: Skill, context?: ToolContext): Promise<string> {
    const liveContext = context ?? this.slashContext(skill);
    return this.officialTool.invoke({ skill_name: skill.name }, liveContext);
  }

  getActivatedSkills(agent: LocalAgent): readonly string[] {
    return this.official.getActivatedSkills(agent);
  }

  private notFound(name: string): { error: string; availableSkills: string[] } {
    return {
      error: `No skill named ${JSON.stringify(name)}.`,
      availableSkills: this.skills.map((skill) => skill.name),
    };
  }

  private slashContext(skill: Skill): ToolContext {
    const agent = this.agent;
    if (agent === undefined) {
      throw new Error(`Cannot expand /${skill.name} before the skills plugin is initialized.`);
    }
    return {
      agent,
      invocationState: {},
      toolUse: {
        name: 'load_skill',
        toolUseId: `slash-${skill.name}`,
        input: { name: skill.name },
      },
      interrupt: () => {
        throw new Error('load_skill activation does not support interrupts');
      },
    };
  }
}

export interface ExpandedSkillCommand {
  skill: Skill;
  /** Message text to send in place of the user's raw slash command. */
  message: string;
}

/** Expands `/skill-name [request]` through the official activation path. */
export async function expandSkillCommand(
  plugin: SkillsPlugin,
  input: string,
): Promise<ExpandedSkillCommand | null> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const withoutSlash = trimmed.slice(1);
  const separator = withoutSlash.search(/\s/);
  const name = separator === -1 ? withoutSlash : withoutSlash.slice(0, separator);
  const remainder = separator === -1 ? '' : withoutSlash.slice(separator).trim();

  const skill = plugin.find(name);
  if (skill === undefined) return null;

  const instructions = await plugin.activate(skill);
  const request = remainder === ''
    ? `Apply the "${skill.name}" skill to what we are working on.`
    : remainder;
  const alreadyLoaded =
    `The full instructions for the "${skill.name}" skill are included above — ` +
    `do not call load_skill for it.`;

  return {
    skill,
    message: `${instructions}\n\n${alreadyLoaded}\n\n${request}`,
  };
}
