#!/usr/bin/env node
/**
 * Rolls the research path for one `self-evolution-research` run.
 *
 * Why a script rather than "pick one": a model asked to choose its own research
 * direction will keep choosing the familiar one. Peer-product comparison was the
 * only path the workflow had, so every run re-derived the same kind of finding and
 * darwin's own rough edges — the frame, the logs, the SDK features it never
 * adopted — were never anybody's assignment. A weighted draw makes the unfamiliar
 * path *arrive* instead of having to be argued for.
 *
 * Two properties make the roll worth trusting:
 *
 * - **The odds are exact.** Weights are whole halves, and the draw runs over
 *   half-units (`DRAW_UNITS_PER_WEIGHT`) rather than over the weights themselves, so
 *   the documented share is exactly the implemented share and no rounding drifts. A
 *   weight that is not a whole half throws at load rather than quietly biasing a
 *   path. The share is printed as a percentage only for the reader's benefit.
 * - **The record distinguishes a roll from a decision.** `path-source` is either
 *   `roll` (with the raw draw, so the outcome can be audited against the weights)
 *   or `override` — a run that was told which path to take must never be able to
 *   present that as chance.
 *
 * The draw uses `crypto.randomInt`, which is uniform over the range and needs no
 * seed. There is deliberately no `--seed`: a reproducible roll is a roll somebody
 * can shop for.
 */
import { randomInt } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * The paths, with their weights. Order is fixed: the draw maps onto these ranges
 * in sequence, so reordering the array changes which draw yields which path (the
 * odds are unaffected, but a recorded draw would no longer audit).
 *
 * Weights are `2:0.5:1:1.5:5`. Peer research keeps the plurality — it is the path
 * with outside evidence, and the one whose findings have historically survived the
 * score gate — while the self-review paths are no longer equal to each other: TUI
 * polish draws twice as often as `sdk`, `open` sits between them, and observability
 * keeps the smallest non-trivial share.
 */
export const RESEARCH_PATHS = [
  {
    id: 'tui',
    weight: 2,
    focus: 'TUI interaction and visual polish',
    scope:
      'How darwin looks and feels while it works: the live frame, streaming and history rendering, prompts and completion, colour and severity, layout under a small terminal, keyboard editing.',
  },
  {
    id: 'observability',
    weight: 0.5,
    focus: 'logging and observability',
    scope:
      'What an operator can find out afterwards: notices and diagnostics, the trajectory record, usage and cost reporting, background job and subagent visibility, what a failure leaves behind.',
  },
  {
    id: 'sdk',
    weight: 1,
    focus: 'Strands SDK capabilities darwin does not use yet',
    scope:
      'The SDK surface darwin has not adopted — hooks, plugins, interventions, conversation managers, model and tool features — measured against what darwin hand-rolls or does without. Read the repository\'s recorded SDK contracts first (start from `AGENTS.md` and the architecture documents it points to); a "missing" SDK feature is often a recorded contract.',
  },
  {
    id: 'open',
    weight: 1.5,
    focus: 'anything else worth improving',
    scope:
      'Deliberately unscoped: performance, correctness, permissions, configuration, docs, verification, developer ergonomics. The direction still needs repository evidence and still faces the score gate.',
  },
  {
    id: 'peer',
    weight: 5,
    focus: 'comparable coding-agent product analysis',
    scope:
      'The sourced peer comparison in section 3.3 of the skill: Claude Code, Codex, DeepSeek harness, PenguinHarness, and at least one further relevant product.',
  },
];

export const TOTAL_WEIGHT = RESEARCH_PATHS.reduce((sum, path) => sum + path.weight, 0);

/**
 * The draw runs over half-units, not over the weights: a weight of `0.5` cannot be
 * a range of integers, and rounding it to one would hand that path twice its share.
 * Halving the unit is the smallest change that keeps the draw an integer — which is
 * what `randomInt` needs and what makes a recorded draw auditable.
 */
export const DRAW_UNITS_PER_WEIGHT = 2;

export const TOTAL_DRAW_UNITS = TOTAL_WEIGHT * DRAW_UNITS_PER_WEIGHT;

// Loud at load, because a weight that is not a whole half would otherwise become a
// silently biased range rather than an error.
for (const path of RESEARCH_PATHS) {
  const units = path.weight * DRAW_UNITS_PER_WEIGHT;
  if (!Number.isInteger(units) || units <= 0) {
    throw new RangeError(`weight for ${path.id} must be a positive multiple of ${1 / DRAW_UNITS_PER_WEIGHT}, received ${String(path.weight)}`);
  }
}

/** `tui=2 observability=0.5 sdk=1 open=1.5 peer=5` — the weights, for the record. */
export function formatWeightTable() {
  return RESEARCH_PATHS.map((path) => `${path.id}=${path.weight}`).join(' ');
}

export function findResearchPath(id) {
  return RESEARCH_PATHS.find((path) => path.id === id);
}

/**
 * Maps a draw in `[0, TOTAL_DRAW_UNITS)` onto a path.
 *
 * Out of range throws rather than clamping: a clamp would silently bias the first
 * or last path, which is the one bug this whole file exists to avoid.
 */
export function pathForDraw(draw) {
  if (!Number.isInteger(draw) || draw < 0 || draw >= TOTAL_DRAW_UNITS) {
    throw new RangeError(`draw must be an integer in [0, ${TOTAL_DRAW_UNITS}), received ${String(draw)}`);
  }
  let cursor = 0;
  for (const path of RESEARCH_PATHS) {
    cursor += path.weight * DRAW_UNITS_PER_WEIGHT;
    if (draw < cursor) return path;
  }
  // Unreachable while the guard above holds; kept so a future weight bug is loud.
  throw new RangeError(`no path covers draw ${draw}`);
}

/** Exact for these weights: every weight over 10 terminates in one decimal place. */
function formatShare(weight) {
  const percent = (weight * 100) / TOTAL_WEIGHT;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

/**
 * The block a research run copies verbatim into its report.
 *
 * One `key: value` per line, so the report shows the same text the script printed
 * and a reader can re-check the outcome against the weights and the draw.
 */
export function formatRoll({ path, draw, source, at }) {
  return [
    `research-path: ${path.id}`,
    `focus: ${path.focus}`,
    `share: ${formatShare(path.weight)} (weight ${path.weight} of ${TOTAL_WEIGHT})`,
    `draw: ${draw === undefined ? 'none — path was not rolled' : `${draw} of ${TOTAL_DRAW_UNITS} half-units`}`,
    `path-source: ${source}`,
    `rolled-at: ${at}`,
    `weights: ${formatWeightTable()}`,
  ].join('\n');
}

const USAGE = [
  'Usage: node roll-research-path.mjs [--path <id>]',
  '',
  `  (no arguments)   roll one path; weights ${formatWeightTable()}`,
  '  --path <id>      record a user-directed path instead of rolling',
  '  --help           print this',
  '',
  'Paths:',
  ...RESEARCH_PATHS.map((path) => `  ${path.id.padEnd(14)} ${formatShare(path.weight).padStart(5)}  ${path.focus}`),
].join('\n');

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let requested;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--path') {
      requested = argv[index + 1];
      index += 1;
      if (requested === undefined) {
        process.stderr.write(`error: --path needs a path id\n${USAGE}\n`);
        return 2;
      }
      continue;
    }
    // Refused rather than ignored: a typo'd flag must not quietly become a roll.
    process.stderr.write(`error: unexpected argument ${JSON.stringify(arg)}\n${USAGE}\n`);
    return 2;
  }

  const at = new Date().toISOString();

  if (requested !== undefined) {
    const path = findResearchPath(requested);
    if (path === undefined) {
      process.stderr.write(`error: unknown path ${JSON.stringify(requested)}\n${USAGE}\n`);
      return 2;
    }
    process.stdout.write(`${formatRoll({ path, draw: undefined, source: 'override (user-directed)', at })}\n`);
    return 0;
  }

  const draw = randomInt(TOTAL_DRAW_UNITS);
  process.stdout.write(`${formatRoll({ path: pathForDraw(draw), draw, source: 'roll', at })}\n`);
  return 0;
}

// Only when executed, so a test can import the weights and the mapping.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
