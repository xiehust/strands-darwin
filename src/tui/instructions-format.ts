/**
 * The header's project-instructions rows as plain text.
 *
 * One pure projection over `RuntimeInfo`, so the row names the file that was
 * actually loaded (AGENTS.md or its CLAUDE.md fallback) rather than a hard-coded
 * name, and so the wording can be checked without rendering the header.
 */
import {
  type InstructionsFilename,
  type ProjectInstructionsSummary,
} from '../agent/instructions.js';

/** Sizes are shown so an accidentally huge instructions file is visible at a glance. */
export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** `AGENTS.md: loaded (4.0 KB)` — with the cap named when the file was cut. */
export function formatInstructionsLoadedRow(instructions: ProjectInstructionsSummary): string {
  const size = formatBytes(instructions.bytes);
  return instructions.truncated
    ? `${instructions.filename}: loaded (${size}, truncated to ${instructions.maxBytes / 1024} KiB)`
    : `${instructions.filename}: loaded (${size})`;
}

/** `CLAUDE.md: skipped — EISDIR: …` — the file that was present but unusable. */
export function formatInstructionsProblemRow(file: InstructionsFilename, problem: string): string {
  return `${file}: skipped — ${problem}`;
}
