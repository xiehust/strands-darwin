/**
 * SER-090 — workspace trust for repository-supplied executable configuration.
 *
 * Free suite: no model call, no network, private HOME. The checkout under test carries
 * everything darwin would arm at launch — a root `.mcp.json` whose only server is
 * `sh -c 'touch <marker>'`, a `.darwin/hooks.json` `TurnComplete` hook touching a second
 * marker, and a `.darwin/config.json` with legacy `permissionRules` — so every "did it
 * run" question has a file-existence answer.
 *
 * Proves, in order: the inventory lists all three without either marker appearing;
 * the decision store lives under `~/.darwin/projects/<key>/trust.json`, a committed
 * in-repo `.darwin/trust.json` is ignored, and a malformed store reads as undecided
 * with a bounded notice; an untrusted `AgentRuntime.create` spawns nothing, loads no
 * project hook file and grants no legacy rule, its `/clear` successor inherits the
 * decision, and `/mcp` + `/status` name the held items; a stored `trusted: true` arms
 * all three exactly as before (server spawned, hook fired, rule granted); an empty
 * inventory needs no prompt; and a real headless `-p` run (the offline `startup-cli`
 * fixture, CaptureModel, through `cli.ts` → `runHeadlessProcess`) in the untrusted
 * project writes exactly one `trust:` stderr line and leaves both markers absent,
 * while the same run after acceptance spawns the server.
 *
 * The interactive modal is `spike/verify-tui.ts trust`; the additive `run.started.trust`
 * field is `spike/verify-headless-structured.ts`.
 *
 * Run: pnpm tsx spike/verify-workspace-trust.ts
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { AgentRuntime, setRuntimeModelFactoryForTest } from '../src/agent/runtime.js';
import { allowAllBridge } from '../src/agent/permission.js';
import {
  describeHeld,
  heldLabels,
  inventoryIsEmpty,
  inventoryWorkspace,
  needsTrustPrompt,
  readTrustDecision,
  resolveWorkspaceTrust,
  trustDecisionPath,
  withTrustState,
  workspaceTrustReport,
  writeTrustDecision,
} from '../src/agent/workspace-trust.js';
import { configPath, loadProjectPolicy } from '../src/config.js';
import { mcpConfigCandidates, readMcpServerConfigs } from '../src/mcp/registry.js';
import { userProjectDir } from '../src/paths.js';
import { formatMcpReport } from '../src/tui/mcp-format.js';
import { formatStatusReport, type StatusFacts } from '../src/tui/status-format.js';
import { formatTrustNotice, trustInventoryRows, trustPromptRows, TRUST_PROMPT_FIXED_ROWS } from '../src/tui/trust-format.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';

const HOME = ownPrivateHome('workspace-trust');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
/** What `spike/fixtures/startup-cli.ts`'s CaptureModel answers — the proof the run never reached a provider. */
const FIXTURE_REPLY = 'provider calls are forbidden in the startup fixture';

// SECTION: fixtures

/** Every darwin runtime here answers from the offline model; a provider call would be a bug. */
setRuntimeModelFactoryForTest(async () => new CaptureModel('ok'));

/** The only config the runtimes read: a Bedrock model id so the factory above is what would be swapped in. */
await writeFile(
  configPath(),
  `${JSON.stringify({ permissionMode: 'default', model: 'us.anthropic.claude-sonnet-4-6', region: 'us-west-2', memory: false }, null, 2)}\n`,
  'utf8',
);

interface Checkout {
  root: string;
  /** Touched by the `.mcp.json` server command — exists iff the server was spawned. */
  mcpMarker: string;
  /** Touched by the `TurnComplete` hook — exists iff the hook ran. */
  hookMarker: string;
}

/** A checkout carrying all three repository-supplied layers, none of them yet consented to. */
async function checkout(label: string): Promise<Checkout> {
  const root = await mkdtemp(path.join(os.tmpdir(), `darwin-trust-${label}-`));
  const mcpMarker = path.join(root, 'mcp-server-ran');
  const hookMarker = path.join(root, 'turn-complete-hook-ran');
  await mkdir(path.join(root, '.darwin'), { recursive: true });
  await writeFile(
    path.join(root, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { probe: { command: 'sh', args: ['-c', `touch ${mcpMarker}`] } } }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(root, '.darwin', 'hooks.json'),
    `${JSON.stringify({
      TurnComplete: [{ matcher: '*', hooks: [{ type: 'command', command: `touch ${hookMarker}` }] }],
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(root, '.darwin', 'config.json'),
    `${JSON.stringify({ permissionRules: { allow: ['bash:pnpm *', 'bash:git status'], deny: ['bash:rm *'] } }, null, 2)}\n`,
    'utf8',
  );
  return { root, mcpMarker, hookMarker };
}

async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file: string, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await settle(25);
  }
  return existsSync(file);
}

function statusFacts(runtime: AgentRuntime): StatusFacts {
  return {
    config: runtime.config,
    sessionId: runtime.info.sessionId,
    resumed: false,
    promptCache: runtime.promptCache,
    thinking: runtime.thinking,
    mode: runtime.permissionMode,
    allowRuleCount: runtime.allowRuleCount,
    denyRuleCount: runtime.denyRuleCount,
    mcpServers: runtime.listMcpServers(),
    skillNames: runtime.info.skillNames,
    hookSources: runtime.info.hookSources,
    hookShadowNotices: runtime.info.hookShadowNotices,
    shellEnv: runtime.info.shellEnv,
    workspaceTrust: runtime.info.workspaceTrust,
    projectRoot: runtime.info.projectRoot,
    homeDir: HOME,
    trajectory: runtime.trajectoryStatus,
    diagnostics: runtime.diagnosticsStatus,
    usage: runtime.usage,
    modelPrice: runtime.modelPrice,
    modelShares: runtime.modelShares,
    childUsage: runtime.childUsage,
    callStats: runtime.callStats,
    cacheMisses: runtime.cacheMissReport(),
    turnInFlight: false,
    context: undefined,
    contextProblem: 'not estimated in this suite',
  };
}

function mcpReport(runtime: AgentRuntime): string {
  const candidates = mcpConfigCandidates(runtime.info.projectRoot);
  return formatMcpReport(runtime.listMcpServers(), {
    configPaths: runtime.info.mcpConfigPaths,
    overriddenServerNames: runtime.info.mcpOverriddenServerNames,
    ignoredConfigPath: runtime.info.mcpIgnoredConfigPath,
    candidatePaths: [candidates.global, candidates.preferred, candidates.fallback],
    heldServers: runtime.info.workspaceTrust.heldMcpServers,
  });
}

// SECTION: inventory-and-store

header('workspace trust — the inventory lists what the checkout would arm, and arms none of it');
const first = await checkout('inventory');
const inventory = await inventoryWorkspace(first.root);
assert('the hook file is listed with its dialect and event counts',
  inventory.hookSources.length === 1 &&
  inventory.hookSources[0]!.file === path.join(first.root, '.darwin', 'hooks.json') &&
  inventory.hookSources[0]!.dialect === 'native' &&
  inventory.hookSources[0]!.eventCounts['TurnComplete'] === 1);
assert('the MCP server is listed with its command, args and declaring file',
  inventory.mcpServers.length === 1 &&
  inventory.mcpServers[0]!.name === 'probe' &&
  inventory.mcpServers[0]!.command === 'sh' &&
  inventory.mcpServers[0]!.args?.[1] === `touch ${first.mcpMarker}` &&
  inventory.mcpServers[0]!.file === path.join(first.root, '.mcp.json'));
assert('the legacy rule fallback is listed with its allow/deny counts',
  inventory.legacyRules?.file === path.join(first.root, '.darwin', 'config.json') &&
  inventory.legacyRules.allow === 2 && inventory.legacyRules.deny === 1);
assert('the inventory reads cleanly — no loader problem', inventory.problems.length === 0);
await settle(300);
assert('inventorying spawned no MCP server (marker absent)', !existsSync(first.mcpMarker));
assert('inventorying ran no hook (marker absent)', !existsSync(first.hookMarker));
assert('the inventory is not empty, so the interactive driver would ask', !inventoryIsEmpty(inventory));

const modalRows = trustPromptRows({ state: 'undecided', inventory }, first.root, 12);
assert('the modal names the project root', modalRows.intro.startsWith(first.root));
assert('the modal lists hooks, mcp and rules rows',
  modalRows.items.some((row) => row.startsWith('hooks   .darwin/hooks.json') && row.includes('TurnComplete ×1')) &&
  modalRows.items.some((row) => row.startsWith('mcp     probe — sh -c') && row.includes('(.mcp.json)')) &&
  modalRows.items.some((row) => row.startsWith('rules   .darwin/config.json — 2 allow, 1 deny')));
assert('the modal names the user-owned decision file, never one inside the repository',
  modalRows.consequence.includes(trustDecisionPath(first.root)) && !modalRows.consequence.includes(path.join(first.root, '.darwin')));
const tiny = trustPromptRows({ state: 'undecided', inventory }, first.root, TRUST_PROMPT_FIXED_ROWS + 2);
assert('a short terminal bounds the item rows and states the remainder as `… N more`',
  tiny.items.length === 2 && tiny.hidden === 2 && tiny.items[1]!.startsWith('… 2 more'));
assert('the unbounded row list has one row per inventory item', trustInventoryRows({ state: 'undecided', inventory }, first.root).length === 3);

header('workspace trust — the decision store is user-owned; the repository cannot grant itself trust');
const undecided = await resolveWorkspaceTrust(first.root);
assert('no stored decision reads as undecided', undecided.state === 'undecided' && undecided.problem === undefined);
assert('undecided plus a non-empty inventory needs the prompt', needsTrustPrompt(undecided));
assert('the store lives under ~/.darwin/projects/<key>/trust.json',
  trustDecisionPath(first.root) === path.join(userProjectDir(first.root), 'trust.json') &&
  trustDecisionPath(first.root).startsWith(path.join(HOME, '.darwin', 'projects')));

// A committed file in the checkout, in the store's exact shape, at the path a
// careless reader might consult. It must count for nothing.
await writeFile(path.join(first.root, '.darwin', 'trust.json'), `${JSON.stringify({ trusted: true, decidedAt: new Date().toISOString() })}\n`, 'utf8');
assert('a committed .darwin/trust.json inside the repository is ignored',
  (await resolveWorkspaceTrust(first.root)).state === 'undecided');

await mkdir(path.dirname(trustDecisionPath(first.root)), { recursive: true });
await writeFile(trustDecisionPath(first.root), '{ not json', 'utf8');
const malformed = await resolveWorkspaceTrust(first.root);
assert('a malformed store reads as undecided with a bounded notice, never a crash',
  malformed.state === 'undecided' && malformed.problem !== undefined && malformed.problem.includes('not valid JSON'));
await writeFile(trustDecisionPath(first.root), JSON.stringify({ trusted: 'yes' }), 'utf8');
const wrongShape = await readTrustDecision(first.root);
assert('a wrongly shaped store is undecided and says what was expected',
  wrongShape.decision === undefined && wrongShape.problem?.includes('expected { "trusted": boolean') === true);

const written = await writeTrustDecision(first.root, false, () => new Date('2026-09-15T12:00:00.000Z'));
const stored = JSON.parse(await readFile(trustDecisionPath(first.root), 'utf8')) as Record<string, unknown>;
assert('writing stores exactly { trusted, decidedAt }',
  Object.keys(stored).sort().join(',') === 'decidedAt,trusted' && stored['trusted'] === false &&
  stored['decidedAt'] === '2026-09-15T12:00:00.000Z' && written.trusted === false);
assert('a stored refusal reads as untrusted and is not asked again',
  (await resolveWorkspaceTrust(first.root)).state === 'untrusted' && !needsTrustPrompt(await resolveWorkspaceTrust(first.root)));
assert('the checkout is still marker-free after every store operation', !existsSync(first.mcpMarker) && !existsSync(first.hookMarker));

header('workspace trust — an empty inventory sees nothing new');
const plain = await mkdtemp(path.join(os.tmpdir(), 'darwin-trust-plain-'));
const plainTrust = await resolveWorkspaceTrust(plain);
assert('a project declaring nothing has an empty inventory', inventoryIsEmpty(plainTrust.inventory));
assert('…and never needs the prompt', !needsTrustPrompt(plainTrust));
assert('…and holds nothing back even while undecided',
  describeHeld(workspaceTrustReport(plainTrust), plain) === undefined && formatTrustNotice(workspaceTrustReport(plainTrust), plain) === undefined);
await rm(plain, { recursive: true, force: true });

header('workspace trust — the loaders skip held layers without reading them');
const heldPolicy = await loadProjectPolicy(first.root, { projectLayers: 'held' });
assert('held: no project hook source, no legacy rules',
  heldPolicy.hookSources.length === 0 && heldPolicy.allowRules.length === 0 && heldPolicy.denyRules.length === 0 && heldPolicy.legacyRules === false);
const armedPolicy = await loadProjectPolicy(first.root);
assert('armed (the default): the project hook file and the legacy rules load as before',
  armedPolicy.hookSources.includes(path.join(first.root, '.darwin', 'hooks.json')) &&
  armedPolicy.allowRules.length === 2 && armedPolicy.denyRules.length === 1 && armedPolicy.legacyRules);
const heldMcp = await readMcpServerConfigs(first.root, { projectLayer: 'held' });
assert('held: the project MCP file is not read', heldMcp.servers === undefined && heldMcp.configPaths.length === 0);
const armedMcp = await readMcpServerConfigs(first.root);
assert('armed: the project MCP file is read as before', armedMcp.servers !== undefined && 'probe' in armedMcp.servers);
await writeFile(path.join(first.root, '.darwin', 'hooks.json'), '{ broken', 'utf8');
const brokenInventory = await inventoryWorkspace(first.root);
assert('an unparseable hook file is inventoried as unreadable rather than thrown',
  brokenInventory.hookSources.length === 0 && brokenInventory.problems.length === 1 &&
  brokenInventory.problems[0]!.file === path.join(first.root, '.darwin') && !inventoryIsEmpty(brokenInventory));
let heldLoaded = true;
try {
  await loadProjectPolicy(first.root, { projectLayers: 'held' });
} catch {
  heldLoaded = false;
}
assert('held: the unparseable project hook file cannot fail startup either', heldLoaded);
await rm(first.root, { recursive: true, force: true });

// SECTION: runtime

header('workspace trust — an untrusted runtime arms nothing the checkout declares');
const second = await checkout('runtime');
const untrusted = withTrustState(await resolveWorkspaceTrust(second.root), 'untrusted');
const heldRuntime = await AgentRuntime.create({
  projectRoot: second.root,
  session: { kind: 'new' },
  permissionBridge: allowAllBridge,
  workspaceTrust: untrusted,
});
try {
  await settle(400);
  assert('the .mcp.json server was not spawned (marker absent)', !existsSync(second.mcpMarker));
  assert('no MCP client exists for the held server', heldRuntime.listMcpServers().length === 0 && heldRuntime.info.mcpServerCount === 0);
  assert('the project hook file is not an active hook source', !heldRuntime.info.hookSources.includes(path.join(second.root, '.darwin', 'hooks.json')));
  assert('no legacy allow or deny rule was granted', heldRuntime.allowRuleCount === 0 && heldRuntime.denyRuleCount === 0);
  heldRuntime.observeTurnComplete('success', 'interactive');
  await settle(400);
  assert('publishing TurnComplete runs no held hook (marker absent)', !existsSync(second.hookMarker));
  const trust = heldRuntime.info.workspaceTrust;
  assert('info.workspaceTrust names the state and every held item',
    trust.state === 'untrusted' &&
    trust.heldHookFiles.length === 1 && trust.heldMcpServers.length === 1 && trust.heldMcpServers[0]!.name === 'probe' &&
    trust.heldLegacyRules?.allow === 2 && trust.heldLegacyRules.deny === 1);
  const labels = heldLabels(trust, second.root);
  assert('the held labels are project-relative and one per item',
    labels.join(' | ') === 'hooks: .darwin/hooks.json | mcp: probe (.mcp.json) | rules: .darwin/config.json (2 allow, 1 deny)');
  const notice = formatTrustNotice(trust, second.root)!;
  assert('the transcript notice states the omission and how to be asked again',
    notice.startsWith('trust: project not trusted — held back: hooks: .darwin/hooks.json, mcp: probe (.mcp.json), rules:') &&
    notice.includes(`delete ${trustDecisionPath(second.root)}`));
  const mcp = mcpReport(heldRuntime);
  assert('/mcp lists the held server as held (untrusted project) with no connection attempt',
    mcp.startsWith('mcp servers (1)') && mcp.includes('probe  held (untrusted project) — declared in') && mcp.includes('no connection attempted'));
  const status = formatStatusReport(statusFacts(heldRuntime));
  assert('/status carries the held server on its mcp row', /mcp\s+none configured · 1 held \(untrusted project\): probe/.test(status));
  assert('/status carries the held hook file and legacy rules on its hooks row',
    /hooks\s+none · 1 held \(untrusted project\): \.darwin\/hooks\.json · legacy rules held: \.darwin\/config\.json \(2 allow, 1 deny\)/.test(status));

  header('workspace trust — the /clear successor inherits the decision');
  const successor = await heldRuntime.startNewSession();
  try {
    await settle(300);
    assert('the successor is still untrusted with the same held items',
      successor.info.workspaceTrust.state === 'untrusted' && successor.info.workspaceTrust.heldMcpServers.length === 1);
    assert('the successor spawned nothing and granted nothing',
      !existsSync(second.mcpMarker) && successor.allowRuleCount === 0 && successor.listMcpServers().length === 0);
  } finally {
    await successor.shutdown();
  }
} finally {
  // The successor took over the process-owned resources; the predecessor was retired by the switch.
}

header('workspace trust — a stored acceptance arms everything exactly as before');
await writeTrustDecision(second.root, true);
const trusted = await resolveWorkspaceTrust(second.root);
assert('the stored acceptance reads as trusted and needs no prompt', trusted.state === 'trusted' && !needsTrustPrompt(trusted));
const armedRuntime = await AgentRuntime.create({
  projectRoot: second.root,
  session: { kind: 'new' },
  permissionBridge: allowAllBridge,
  workspaceTrust: trusted,
});
try {
  assert('the .mcp.json server was spawned (marker present)', await waitForFile(second.mcpMarker));
  assert('the project hook file is an active hook source', armedRuntime.info.hookSources.includes(path.join(second.root, '.darwin', 'hooks.json')));
  assert('the legacy rules were granted', armedRuntime.allowRuleCount === 2 && armedRuntime.denyRuleCount === 1);
  armedRuntime.observeTurnComplete('success', 'interactive');
  assert('publishing TurnComplete runs the hook (marker present)', await waitForFile(second.hookMarker));
  assert('info.workspaceTrust holds nothing', armedRuntime.info.workspaceTrust.state === 'trusted' && heldLabels(armedRuntime.info.workspaceTrust, second.root).length === 0);
  assert('no transcript notice for a trusted project', formatTrustNotice(armedRuntime.info.workspaceTrust, second.root) === undefined);
  assert('/mcp names the server as a configured one, not a held one', !mcpReport(armedRuntime).includes('held (untrusted project)'));
  // `withheld (` on the shell-env row is a different word; only the trust suffixes are checked.
  const armedStatus = formatStatusReport(statusFacts(armedRuntime));
  assert('/status rows carry no held suffix',
    !armedStatus.includes('held (untrusted project)') && !armedStatus.includes('held (project trust undecided)') && !armedStatus.includes('legacy rules held'));
} finally {
  await armedRuntime.shutdown();
}
await rm(second.root, { recursive: true, force: true });

// SECTION: headless

/**
 * One real `darwin -p` through `cli.ts`, with the offline `startup-cli` fixture as the
 * model factory; `cwd` is the checkout and HOME the private one, so `-p` resolves the
 * same store this suite wrote.
 */
async function headless(cwd: string): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const child = spawn(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    [path.join(REPO_ROOT, 'spike', 'fixtures', 'startup-cli.ts'), '-p', 'say ok'],
    { cwd, env: { ...process.env, HOME, DARWIN_MODEL_PRICES_FETCH: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const code = await Promise.race([
    new Promise<number | null>((resolve) => child.once('close', resolve)),
    new Promise<never>((_, reject) => setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('headless run did not exit'));
    }, 60_000)),
  ]);
  return { code, stderr, stdout };
}

header('workspace trust — headless never asks: undecided holds the layers and says so once');
const third = await checkout('headless');
const undecidedRun = await headless(third.root);
const trustLines = undecidedRun.stderr.split('\n').filter((line) => line.startsWith('trust: '));
assert('the run completed with the fixture reply', undecidedRun.code === 0 && undecidedRun.stdout.includes(FIXTURE_REPLY));
assert('exactly one `trust:` stderr line', trustLines.length === 1);
assert('the line names every held item',
  trustLines[0]?.includes('project trust undecided — held back: hooks: .darwin/hooks.json, mcp: probe (.mcp.json), rules: .darwin/config.json (2 allow, 1 deny)') === true);
assert('the .mcp.json server never ran (marker absent)', !existsSync(third.mcpMarker));
assert('the TurnComplete hook never ran (marker absent)', !existsSync(third.hookMarker));
assert('headless stored no decision', (await readTrustDecision(third.root)).decision === undefined);

header('workspace trust — headless applies a stored acceptance');
await writeTrustDecision(third.root, true);
const trustedRun = await headless(third.root);
assert('the run completed with the fixture reply', trustedRun.code === 0 && trustedRun.stdout.includes(FIXTURE_REPLY));
assert('no `trust:` line for a trusted project', !trustedRun.stderr.split('\n').some((line) => line.startsWith('trust: ')));
assert('the .mcp.json server was spawned (marker present)', existsSync(third.mcpMarker));
await rm(third.root, { recursive: true, force: true });

report();
