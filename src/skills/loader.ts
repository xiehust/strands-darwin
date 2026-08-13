/**
 * Skill discovery and loading.
 *
 * The only hand-built subsystem in this project: the TypeScript SDK has no Skills
 * support yet (the Python SDK ships an `AgentSkills` plugin). Semantics follow the
 * Agent Skills convention — a `SKILL.md` per directory with YAML frontmatter, and
 * progressive disclosure: only names and descriptions go into the system prompt,
 * with full text fetched on demand.
 *
 * Frontmatter is parsed with `gray-matter` rather than a hand-rolled reader. Real
 * SKILL.md files quote strings, wrap long descriptions across lines and carry
 * fields we do not model; a five-line parser silently mangles those, and the
 * loader's job is to be forgiving about author formatting.
 */
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import matter from 'gray-matter';

/** Directories checked for supporting files when a skill is loaded. */
export const RESOURCE_DIRS = ['scripts', 'references', 'assets'] as const;

export const SKILL_FILENAME = 'SKILL.md';
export const SKILLS_DIRNAME = 'skills';

export interface Skill {
  name: string;
  description: string;
  /** Absolute path to the skill's SKILL.md. */
  skillFile: string;
  /** Absolute path to the directory containing SKILL.md. */
  directory: string;
}

/** A skill directory that could not be used, kept so the UI can surface it. */
export interface SkillProblem {
  directory: string;
  reason: string;
}

export interface SkillScan {
  skills: Skill[];
  problems: SkillProblem[];
}

/**
 * Scans `<root>/skills/*​/SKILL.md`.
 *
 * A malformed skill is collected into `problems` and skipped rather than thrown:
 * one bad directory should never stop the agent from starting, and the user still
 * needs to be told why their skill is not showing up.
 */
export async function scanSkills(root: string): Promise<SkillScan> {
  const skillsDir = path.join(root, SKILLS_DIRNAME);

  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    // No skills directory at all is the common case, not a problem to report.
    return { skills: [], problems: [] };
  }

  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];
  const seen = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = path.join(skillsDir, entry.name);
    const skillFile = path.join(directory, SKILL_FILENAME);

    let raw: string;
    try {
      raw = await readFile(skillFile, 'utf8');
    } catch {
      // A directory without SKILL.md is not a skill; ignore it silently so
      // unrelated folders under skills/ do not generate noise.
      continue;
    }

    const parsed = parseSkill(raw, directory, skillFile, entry.name);
    if ('reason' in parsed) {
      problems.push({ directory, reason: parsed.reason });
      continue;
    }

    const duplicateOf = seen.get(parsed.name);
    if (duplicateOf !== undefined) {
      problems.push({
        directory,
        reason: `duplicate skill name "${parsed.name}" (already defined by ${duplicateOf})`,
      });
      continue;
    }

    seen.set(parsed.name, directory);
    skills.push(parsed);
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, problems };
}

function parseSkill(
  raw: string,
  directory: string,
  skillFile: string,
  dirName: string,
): Skill | { reason: string } {
  let data: Record<string, unknown>;
  try {
    ({ data } = matter(raw) as unknown as { data: Record<string, unknown> });
  } catch (error) {
    return { reason: `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}` };
  }

  const description = readString(data['description']);
  if (description === undefined) {
    return { reason: `${SKILL_FILENAME} frontmatter is missing a "description" field` };
  }

  // The directory name is a sensible fallback for `name`, and matches how authors
  // usually expect a skill to be addressed.
  const name = readString(data['name']) ?? dirName;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return {
      reason: `skill name ${JSON.stringify(name)} must contain only letters, numbers, hyphens and underscores`,
    };
  }

  return { name, description, skillFile, directory };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * The system-prompt fragment advertising available skills.
 *
 * Names and descriptions only — this is the progressive-disclosure half of the
 * design. Returns undefined when there is nothing to advertise so callers can
 * skip appending an empty section.
 */
export function renderAvailableSkills(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) return undefined;

  const entries = skills.map((skill) => `  <skill name="${skill.name}">${skill.description}</skill>`);
  return [
    '<available-skills>',
    'Skills are instruction sets for specific tasks. When a request matches one,',
    'call the load_skill tool with its name to read the full instructions before',
    'you begin. Only the name and description are shown here.',
    ...entries,
    '</available-skills>',
  ].join('\n');
}

export interface LoadedSkill {
  name: string;
  /** Full SKILL.md text, frontmatter included. */
  content: string;
  /** Relative paths of files in the skill's resource directories. */
  resources: string[];
}

/**
 * Reads a skill's full instructions plus a listing of its resource files.
 *
 * The file list matters as much as the text: skills routinely tell the model to
 * run `scripts/foo.py` or consult `references/bar.md`, and the model needs to know
 * those exist and where they are.
 */
export async function loadSkill(skill: Skill): Promise<LoadedSkill> {
  const content = await readFile(skill.skillFile, 'utf8');
  const resources: string[] = [];

  for (const dirName of RESOURCE_DIRS) {
    const found = await listFilesRecursively(path.join(skill.directory, dirName));
    resources.push(...found.map((file) => path.join(dirName, file)));
  }

  return { name: skill.name, content, resources };
}

async function listFilesRecursively(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Resource directories are optional.
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const nested = await listFilesRecursively(path.join(dir, entry.name));
      files.push(...nested.map((file) => path.join(entry.name, file)));
    } else {
      files.push(entry.name);
    }
  }
  return files.sort();
}

/**
 * Formats a loaded skill for the model, as both the `load_skill` result and the
 * slash-command expansion use the same shape.
 */
export function formatSkillForModel(loaded: LoadedSkill, skill: Skill): string {
  const sections = [`<skill name="${loaded.name}" directory="${skill.directory}">`, loaded.content];

  if (loaded.resources.length > 0) {
    sections.push(
      '',
      'Files bundled with this skill (paths are relative to the skill directory above):',
      ...loaded.resources.map((file) => `  ${file}`),
    );
  }
  sections.push('</skill>');
  return sections.join('\n');
}
