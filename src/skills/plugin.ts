/**
 * Skills packaged as an SDK `Plugin`.
 *
 * Plugin evaluation (SDK 1.12, read from `plugins/plugin.d.ts`): the interface is
 * sufficient for this job, so skills ship as a plugin rather than loose wiring.
 * It provides exactly the two hooks needed:
 *
 * - `getTools(): Tool[]` — the registry auto-registers `load_skill`, so the
 *   runtime never has to know skills contribute a tool.
 * - `initAgent(agent)` — receives the agent, and `LocalAgent.systemPrompt` is a
 *   writable `string | SystemContentBlock[]`. The agent reads `this.systemPrompt`
 *   at each model call, and `initAgent` runs during `agent.initialize()` (before
 *   any model call), so appending there reliably reaches the first request.
 *
 * The one thing Plugin does not offer is a dedicated prompt-contribution hook, so
 * injection is a string append guarded to the plain-string case.
 *
 * This mirrors how the Python SDK exposes `AgentSkills` as a plugin, which keeps
 * the swap to official TypeScript support close to a deletion.
 */
import { tool } from '@strands-agents/sdk';
import type { LocalAgent, Plugin, Tool } from '@strands-agents/sdk';
import { z } from 'zod';

import {
  formatSkillForModel,
  loadSkill,
  renderAvailableSkills,
  scanSkills,
  type Skill,
  type SkillProblem,
} from './loader.js';

export class SkillsPlugin implements Plugin {
  readonly name = 'strands-darwin:skills';

  private constructor(
    readonly skills: readonly Skill[],
    readonly problems: readonly SkillProblem[],
  ) {}

  /** Scans `<root>/skills/` and returns a plugin ready to attach to an Agent. */
  static async load(root: string): Promise<SkillsPlugin> {
    const { skills, problems } = await scanSkills(root);
    return new SkillsPlugin(skills, problems);
  }

  initAgent(agent: LocalAgent): void {
    const fragment = renderAvailableSkills(this.skills);
    if (fragment === undefined) return;

    const current = agent.systemPrompt;
    if (current === undefined) {
      agent.systemPrompt = fragment;
      return;
    }
    if (typeof current === 'string') {
      agent.systemPrompt = `${current}\n\n${fragment}`;
      return;
    }
    // Block-array prompts carry cache points and guard content whose ordering
    // matters; appending blindly could invalidate a cache boundary. The runtime
    // only ever sets a string, so refuse loudly instead of guessing.
    throw new Error(
      'SkillsPlugin cannot inject into a block-array system prompt. ' +
        'Pass the system prompt as a string, or extend this method to append a text block deliberately.',
    );
  }

  getTools(): Tool[] {
    // No skills means no tool: advertising load_skill with nothing to load only
    // invites the model to call it and get an error.
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
        callback: async ({ name }) => {
          const skill = this.find(name);
          if (skill === undefined) {
            return {
              error: `No skill named ${JSON.stringify(name)}.`,
              availableSkills: this.skills.map((s) => s.name),
            };
          }
          const loaded = await loadSkill(skill);
          return { instructions: formatSkillForModel(loaded, skill) };
        },
      }),
    ];
  }

  /** Case-insensitive so `/Commit-Message` finds `commit-message`. */
  find(name: string): Skill | undefined {
    const wanted = name.trim().toLowerCase();
    return this.skills.find((skill) => skill.name.toLowerCase() === wanted);
  }
}

export interface ExpandedSkillCommand {
  skill: Skill;
  /** Message text to send in place of the user's raw slash command. */
  message: string;
}

/**
 * Expands a `/skill-name` slash command into a message carrying the skill's full
 * text, for the manual-invocation path.
 *
 * Returns null when the input is not a slash command or names no known skill, so
 * the caller can treat it as ordinary input. That keeps unrelated slash commands
 * (`/exit`) and plain prose working, and avoids swallowing a typo into a
 * confusing agent turn.
 *
 * Anything after the skill name is preserved as the user's request, so
 * `/commit-message make it terse` still carries the instruction.
 */
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

  const loaded = await loadSkill(skill);
  const request =
    remainder === ''
      ? `Apply the "${skill.name}" skill to what we are working on.`
      : remainder;

  // Say the instructions are already here: the system prompt tells the model to
  // call load_skill before using a skill, and it otherwise obeys that even when
  // the full text is already inlined, wasting a round trip on every command.
  const alreadyLoaded =
    `The full instructions for the "${skill.name}" skill are included above — ` +
    `do not call load_skill for it.`;

  return {
    skill,
    message: `${formatSkillForModel(loaded, skill)}\n\n${alreadyLoaded}\n\n${request}`,
  };
}
