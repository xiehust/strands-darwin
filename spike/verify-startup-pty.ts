/** Real-pty startup ownership and handoff verification; no model or network calls. */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Agent } from '@strands-agents/sdk';

import {
  createSessionManager,
  sessionPaths,
  snapshotPath,
  trajectoryPath,
  writePointer,
} from '../src/agent/session.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/agent/system-prompt.js';
import { TrajectoryRecorder } from '../src/trajectory/writer.js';
import { recordStream } from '../src/trajectory/stream.js';
import { CaptureModel } from './offline-model.js';
import { assert, header, ownPrivateHome, report } from './shared.js';
import { REPO_ROOT, startTui } from './tui-driver.js';

const HOME = ownPrivateHome('startup-pty');
const ROOT = path.join(HOME, 'project');
const ENTRY = path.join(REPO_ROOT, 'spike/fixtures/startup-cli.ts');
const READY = path.join(ROOT, 'runtime-ready');
const EXIT_TIMEOUT_MS = 20_000;
process.env['HOME'] = HOME;
const WELCOME_ANCHOR = '██████╗  █████╗ ██████╗ ██╗    ██╗██╗███╗   ██╗';
const occurrences = (value: string, needle: string): number => value.split(needle).length - 1;
const operationalFrame = (value: string): string => value.slice(value.lastIndexOf('◆ DARWIN ·'));

async function writeConfig(): Promise<void> {
  await mkdir(path.join(HOME, '.darwin'), { recursive: true });
  await writeFile(path.join(HOME, '.darwin/config.json'), JSON.stringify({
    provider: 'bedrock',
    model: 'us.anthropic.invalid-startup-fixture',
    permissionMode: 'yolo',
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    trajectory: true,
    memory: false,
  }));
}

async function waitForFile(file: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pendingMotionAndHandoff(): Promise<void> {
  header('startup pty — pending motion hands one terminal to the ready App');
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await rm(READY, { force: true });
  process.env['DARWIN_STARTUP_FIXTURE_DELAY_MS'] = '700';
  process.env['DARWIN_STARTUP_FIXTURE_MODE'] = 'ready';
  process.env['DARWIN_STARTUP_FIXTURE_READY_FILE'] = READY;

  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 80, rows: 24 });
  try {
    await tui.waitFor('initializing', { timeoutMs: 10_000 });
    assert('startup is visible before runtime reaches its ready checkpoint',
      await access(READY).then(() => false, () => true));
    await tui.waitUntil((screen) =>
      ['· initializing', '∙ initializing', '● initializing'].filter((marker) => screen.includes(marker)).length >= 2,
    { timeoutMs: 10_000, label: 'at least two startup motion frames' });
    assert('startup changes while real initialization remains pending',
      ['· initializing', '∙ initializing', '● initializing'].filter((marker) => tui.screen.includes(marker)).length >= 2);

    await waitForFile(READY);
    await tui.waitFor('you>', { timeoutMs: 20_000, settleMs: 300 });
    assert('startup disappears completely from the settled frame',
      !/initializing|restoring session|selection in progress/.test(tui.frame));
    assert('handoff leaves exactly one ready identity and one prompt',
      (tui.frame.match(/◆ DARWIN · ready/g) ?? []).length === 1 &&
      (tui.frame.match(/you>/g) ?? []).length === 1);
    assert('ready handoff commits one welcome to scrollback before the compact header',
      occurrences(tui.screen, WELCOME_ANCHOR) === 1
        && tui.screen.indexOf(WELCOME_ANCHOR) < tui.screen.lastIndexOf('◆ DARWIN · ready'));
    assert('the one-shot welcome is absent from the settled operational frame',
      !operationalFrame(tui.frame).includes(WELCOME_ANCHOR));

    const beforeResize = tui.mark();
    tui.resize(100, 30);
    await tui.waitFor('◆ DARWIN · ready', { timeoutMs: 10_000, from: beforeResize, settleMs: 200 });
    assert('terminal resize does not mutate or repeat the committed welcome',
      occurrences(tui.screen, WELCOME_ANCHOR) === 1 && !tui.frame.includes(WELCOME_ANCHOR));

    const beforeHelp = tui.mark();
    tui.submit('/help');
    await tui.waitFor('help — local controls', { timeoutMs: 10_000, from: beforeHelp, settleMs: 200 });
    assert('the ordinary App owns usable input after handoff', tui.screen.slice(beforeHelp).includes('info ·'));
    assert('a local command does not repeat the one-shot welcome', occurrences(tui.screen, WELCOME_ANCHOR) === 1);
    const beforeClear = tui.mark();
    tui.submit('/clear');
    await tui.waitFor('cleared — new session', { timeoutMs: 20_000, from: beforeClear, settleMs: 200 });
    assert('/clear does not remount or repeat the process welcome', occurrences(tui.screen, WELCOME_ANCHOR) === 1);
    assert('/clear successor live frame contains no welcome', !tui.frame.includes(WELCOME_ANCHOR));

    tui.submit('/exit');
    assert('the handed-off App exits cleanly', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
}

async function startupError(): Promise<void> {
  header('startup pty — known startup error removes the animation cleanly');
  await rm(READY, { force: true });
  process.env['DARWIN_STARTUP_FIXTURE_DELAY_MS'] = '350';
  process.env['DARWIN_STARTUP_FIXTURE_MODE'] = 'config-error';
  process.env['DARWIN_STARTUP_FIXTURE_READY_FILE'] = READY;
  const tui = startTui({ cwd: ROOT, entry: ENTRY, cols: 32, rows: 3 });
  try {
    await tui.waitFor('◆ darwin', { timeoutMs: 10_000 });
    assert('short startup uses the bounded single-row fallback',
      tui.screen.includes('◆ darwin · initializing') && !tui.screen.includes('selection in progress'));
    await tui.waitFor('fixture startup configuration failed', { timeoutMs: 10_000, settleMs: 100 });
    assert('configuration failure keeps the existing actionable message',
      tui.screen.includes('Configuration problem:'));
    assert('known startup failure exits one without hanging', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 1);
    assert('the final error output has no startup state after Ink unmounts',
      !tui.screen.slice(tui.screen.lastIndexOf('Configuration problem:')).includes('initializing'));
  } finally {
    tui.kill();
  }
}

async function missingSessionError(): Promise<void> {
  header('startup pty — missing resume is a clean refusal with no fallback');
  process.env['DARWIN_STARTUP_FIXTURE_DELAY_MS'] = '0';
  process.env['DARWIN_STARTUP_FIXTURE_MODE'] = 'ready';
  const sessionsRoot = path.dirname(sessionPaths(ROOT).pointerFile);
  const before = await readdir(sessionsRoot).catch(() => [] as string[]);
  const tui = startTui({
    cwd: ROOT,
    entry: ENTRY,
    args: ['--resume', 'session-does-not-exist'],
    cols: 80,
    rows: 24,
  });
  try {
    await tui.waitFor('Run `darwin sessions` to list resumable ones.', { timeoutMs: 10_000, settleMs: 100 });
    assert('missing resume keeps the established local refusal',
      tui.screen.includes('Session "session-does-not-exist" does not exist in this project.'));
    assert('missing resume exits one without hanging', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 1);
    const errorTail = tui.screen.slice(tui.screen.lastIndexOf('error:'));
    assert('the final missing-session error has no startup state', !errorTail.includes('initializing'));
  } finally {
    tui.kill();
  }
  const after = await readdir(sessionsRoot).catch(() => [] as string[]);
  assert('missing resume creates no fallback session', JSON.stringify(after) === JSON.stringify(before));
}

async function seedResume(): Promise<{ sessionId: string; files: readonly string[] }> {
  const sessionId = 'session-startup-resume';
  const manager = createSessionManager(ROOT, sessionId);
  const model = new CaptureModel('startup resume answer', 'fake.startup-resume');
  const agent = new Agent({
    id: 'darwin',
    model,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    sessionManager: manager,
    printer: false,
  });
  await agent.initialize();
  const trajectory = trajectoryPath(ROOT, sessionId);
  const recorder = new TrajectoryRecorder({
    file: trajectory,
    run: {
      session: sessionId,
      agentId: 'darwin',
      darwinVersion: 'test',
      provider: 'bedrock',
      model: 'fake.startup-resume',
      permissionMode: 'yolo',
      thinkingEffort: 'high',
      resumed: false,
      restoredMessages: 0,
    },
  });
  for await (const _ of recordStream(agent.stream('startup resume request'), recorder.beginTurn('startup resume request'))) {
    // Seed a real SDK snapshot and exact trajectory recap.
  }
  await recorder.close();
  await manager.saveSnapshot({ target: agent, isLatest: true });
  await writePointer(ROOT, sessionId);
  assert('resume fixture uses exactly one local seed call', model.calls.length === 1);
  const files = [trajectory, snapshotPath(ROOT, sessionId, 'darwin'), sessionPaths(ROOT).pointerFile] as const;
  return { sessionId, files };
}

async function resumedHandoff(): Promise<void> {
  header('startup pty — resumed handoff preserves durable session bytes');
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  const { sessionId, files } = await seedResume();
  const before = await Promise.all(files.map(async (file) => hash(await readFile(file))));
  process.env['DARWIN_STARTUP_FIXTURE_DELAY_MS'] = '350';
  process.env['DARWIN_STARTUP_FIXTURE_MODE'] = 'ready';
  process.env['DARWIN_STARTUP_FIXTURE_READY_FILE'] = READY;
  const tui = startTui({ cwd: ROOT, entry: ENTRY, args: ['--resume', sessionId], cols: 100, rows: 30 });
  try {
    await tui.waitFor('restoring session', { timeoutMs: 20_000 });
    await tui.waitFor(/resume recap · [1-9]\d* restored model message\(s\)/, { timeoutMs: 20_000, settleMs: 300 });
    const welcomeAt = tui.screen.indexOf(WELCOME_ANCHOR);
    const recapAt = tui.screen.indexOf('resume recap ·');
    assert('resumed handoff commits one welcome before its read-only recap',
      welcomeAt >= 0 && occurrences(tui.screen, WELCOME_ANCHOR) === 1 && recapAt > welcomeAt);
    assert('resumed welcome is absent from the settled operational frame',
      !operationalFrame(tui.frame).includes(WELCOME_ANCHOR));

    assert('resume recap reaches the ordinary ready prompt with the seeded turn',
      tui.screen.includes('startup resume request') &&
      tui.screen.includes('startup resume answer') &&
      tui.frame.includes('◆ DARWIN · ready') &&
      tui.frame.includes('you>'));
    assert('resume startup has disappeared at handoff', !tui.frame.includes('restoring session'));
    tui.submit('/exit');
    assert('resumed startup exits without a model turn', (await tui.exitedWithin(EXIT_TIMEOUT_MS)) === 0);
  } finally {
    tui.kill();
  }
  const after = await Promise.all(files.map(async (file) => hash(await readFile(file))));
  assert('resume startup and recap leave trajectory, snapshot, and pointer byte-identical',
    before.every((value, index) => value === after[index]));
}

await writeConfig();
await pendingMotionAndHandoff();
await startupError();
await missingSessionError();
await resumedHandoff();
report();
