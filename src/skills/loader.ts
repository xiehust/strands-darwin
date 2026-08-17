/**
 * Darwin's product-policy layer over the SDK's official Agent Skills model.
 *
 * `Skill` owns frontmatter parsing and the instruction data model. This file owns
 * only the behaviour that is specific to Darwin: bundled skills are required and
 * reserved, project skills override global skills, and optional failures are
 * isolated for the startup UI to report.
 */
import type { Dirent } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Skill } from '@strands-agents/sdk/vended-plugins/skills';

import { darwinDir, userDarwinDir } from '../paths.js';

export const SKILL_FILENAME = 'SKILL.md';
export const SKILLS_DIRNAME = 'skills';

/** Assets live beside this module in both `src/` and copied `dist/src/` output. */
export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL('./builtin', import.meta.url));
export const REQUIRED_BUILTIN_SKILLS = ['developer', 'self-evolution-research'] as const;

/** A skill directory that could not be used, kept so the UI can surface it. */
export interface SkillProblem {
  directory: string;
  reason: string;
}

export interface SkillScan {
  /** Official SDK Skill instances, already filtered into Darwin precedence order. */
  skills: Skill[];
  problems: SkillProblem[];
}

type SkillOwner = 'built-in' | 'project' | 'global';

/**
 * Scans bundled, project and global skill directories.
 *
 * Required built-ins come first and fail startup when broken. Optional layers are
 * project then global so a valid project definition claims its name first; an
 * invalid definition claims nothing and cannot hide a valid lower layer.
 */
export async function scanSkills(
  root: string,
  options: { builtinSkillsDir?: string } = {},
): Promise<SkillScan> {
  const builtinSkillsDir = options.builtinSkillsDir ?? BUILTIN_SKILLS_DIR;
  const globalSkillsDir = path.join(userDarwinDir(), SKILLS_DIRNAME);
  const projectSkillsDir = path.join(darwinDir(root), SKILLS_DIRNAME);
  const skills: Skill[] = [];
  const problems: SkillProblem[] = [];
  const seen = new Map<string, { directory: string; owner: SkillOwner }>();

  const builtinEntries = orderBuiltinEntries(
    await readdir(builtinSkillsDir, { withFileTypes: true }),
  );
  await scanDirectory(builtinSkillsDir, builtinEntries, 'built-in', skills, problems, seen);
  for (const required of REQUIRED_BUILTIN_SKILLS) {
    if (!skills.some((skill) => skill.name.toLowerCase() === required)) {
      throw new Error(`Required built-in ${required} skill is missing from ${builtinSkillsDir}`);
    }
  }

  for (const [directory, owner] of [[projectSkillsDir, 'project'], [globalSkillsDir, 'global']] as const) {
    if (directory === builtinSkillsDir) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      // Missing or unreadable optional roots carry no attributable skill entry.
      continue;
    }
    await scanDirectory(directory, sortedDirectories(entries), owner, skills, problems, seen);
  }

  return { skills, problems };
}

function orderBuiltinEntries(entries: readonly Dirent[]): Dirent[] {
  const directories = sortedDirectories(entries);
  const required = REQUIRED_BUILTIN_SKILLS.flatMap((name) =>
    directories.filter((entry) => entry.name === name),
  );
  const requiredNames = new Set<string>(REQUIRED_BUILTIN_SKILLS);
  return [...required, ...directories.filter((entry) => !requiredNames.has(entry.name))];
}

function sortedDirectories(entries: readonly Dirent[]): Dirent[] {
  return entries
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function scanDirectory(
  skillsDir: string,
  entries: readonly Dirent[],
  owner: SkillOwner,
  skills: Skill[],
  problems: SkillProblem[],
  seen: Map<string, { directory: string; owner: SkillOwner }>,
): Promise<void> {
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const directory = path.join(skillsDir, entry.name);
    const skillFile = path.join(directory, SKILL_FILENAME);

    let raw: string;
    try {
      raw = await readFile(skillFile, 'utf8');
    } catch (error) {
      if (owner === 'built-in') {
        throw new Error(`Required built-in skill asset could not be read at ${skillFile}: ${describe(error)}`);
      }
      if (isMissing(error)) {
        // A directory without SKILL.md is not a skill. This matches the SDK's
        // directory scanner and keeps optional grouping folders silent.
        continue;
      }
      problems.push({ directory, reason: `could not read ${SKILL_FILENAME}: ${describe(error)}` });
      continue;
    }

    const parsed = parseOfficialSkill(raw, directory, entry.name);
    if ('reason' in parsed) {
      if (owner === 'built-in') {
        throw new Error(`Invalid built-in skill at ${directory}: ${parsed.reason}`);
      }
      problems.push({ directory, reason: parsed.reason });
      continue;
    }

    const key = parsed.name.toLowerCase();
    const duplicateOf = seen.get(key);
    if (duplicateOf !== undefined) {
      problems.push({
        directory,
        reason: duplicateOf.owner === 'built-in'
          ? `skill name "${parsed.name}" is reserved by built-in skill ${path.basename(duplicateOf.directory)}`
          : `duplicate skill name "${parsed.name}" (already defined by ${duplicateOf.directory})`,
      });
      continue;
    }

    seen.set(key, { directory, owner });
    skills.push(parsed);
  }
}

/**
 * Hands frontmatter/body parsing to the official SDK. Darwin keeps two product
 * compatibility decisions: a missing name defaults to the directory, and the
 * established name grammar remains `[A-Za-z0-9_-]+` rather than the SDK's stricter
 * lowercase/hyphen recommendation.
 */
function parseOfficialSkill(raw: string, directory: string, dirName: string): Skill | { reason: string } {
  try {
    const parsed = parseWithDefaultName(raw, dirName);
    const name = parsed.name.trim();
    const description = parsed.description.trim();

    if (description === '') {
      return { reason: `${SKILL_FILENAME} frontmatter is missing a "description" field` };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return {
        reason: `skill name ${JSON.stringify(name)} must contain only letters, numbers, hyphens and underscores`,
      };
    }

    // `Skill.fromContent` parsed every field. Reconstructing the official model
    // only supplies its host path without imposing the SDK's optional
    // name-equals-directory warning on Darwin's established naming contract.
    return new Skill({
      name,
      description,
      instructions: parsed.instructions,
      path: directory,
      allowedTools: parsed.allowedTools,
      metadata: parsed.metadata,
      license: parsed.license,
      compatibility: parsed.compatibility,
    });
  } catch (error) {
    return { reason: officialReason(error) };
  }
}

function parseWithDefaultName(raw: string, dirName: string): Skill {
  try {
    return Skill.fromContent(raw);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "SKILL.md content must have a 'name' field in frontmatter") {
      throw error;
    }

    const withName = raw.replace(
      /^(\s*---\s*\r?\n)/,
      `$1name: ${JSON.stringify(dirName)}\n`,
    );
    return Skill.fromContent(withName);
  }
}

function officialReason(error: unknown): string {
  const message = describe(error);
  if (message === "SKILL.md content must have a 'description' field in frontmatter") {
    return `${SKILL_FILENAME} frontmatter is missing a "description" field`;
  }
  return /yaml/i.test(message) ? `invalid YAML frontmatter: ${message}` : message;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
