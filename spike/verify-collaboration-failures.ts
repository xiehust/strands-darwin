/** SER-104 Host regressions: real private files/sockets, production PTY and offline CLI.
 * Source: pnpm tsx spike/verify-collaboration-failures.ts
 * Built: node dist/spike/verify-collaboration-failures.js
 * The human-failure control deliberately waits out the fixture's original 30s hold.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { LocalCollaboration, discoverPeers, socketPath } from '../src/collaboration/local.js';
import { readPolicy, policyCommand, requestCooperation } from '../src/collaboration/storage.js';
import { collaborationCommand } from '../src/collaboration/command.js';
import { startTui } from './tui-driver.js';

const home = mkdtempSync('/tmp/cf-');
process.env['HOME'] = home;
process.env['DARWIN_MODEL_PRICES_FETCH'] = 'off';
process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
const ext = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const fixture = fileURLToPath(new URL(`./fixtures/collaboration-cli.${ext}`, import.meta.url));
const cli = fileURLToPath(new URL(`../src/cli.${ext}`, import.meta.url));
const loader = ext === 'ts' ? ['--import', import.meta.resolve('tsx')] : [];
const env = { HOME: home, DARWIN_MODEL_PRICES_FETCH: 'off', AWS_EC2_METADATA_DISABLED: 'true' };
const store = path.join(home, '.darwin/collaboration');
const policy = path.join(store, 'policy.json');

async function waitFor(test: () => boolean | Promise<boolean>, label: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await test()) return; await delay(25); }
  throw new Error(`Timed out: ${label}`);
}
function requests(project: string): any[] {
  const file = path.join(project, 'peer-requests.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function targetFor(project: string, sender: LocalCollaboration) {
  let found;
  await waitFor(async () => { found = (await discoverPeers()).endpoints.find(p => p.project === project && p.endpoint !== sender.address!.endpoint); return !!found; }, 'target endpoint');
  return found! as NonNullable<LocalCollaboration['address']>;
}
async function deliver(sender: LocalCollaboration, target: string, text: string): Promise<void> {
  sender.beginHumanTurn(); assert.match(await sender.send(target, text), /^Queued/);
}
function launch(entry: string, args: string[], cwd: string) {
  const child = spawn(process.execPath, [...loader, entry, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { child, done, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function command(args: string[]) {
  const run = launch(fixture, ['collaborate', ...args], home);
  try { await waitFor(() => run.child.exitCode !== null, 'CLI exits'); return { code: await run.done, stdout: run.stdout, stderr: run.stderr }; }
  finally { run.child.kill(); }
}
function stateHash(dir: string): string {
  const hash = createHash('sha256');
  function visit(file: string): void {
    if (!existsSync(file)) { hash.update('absent'); return; }
    const stat = lstatSync(file);
    hash.update(JSON.stringify([path.relative(dir, file), stat.mode, stat.ino, stat.mtimeMs]));
    if (stat.isDirectory()) for (const name of readdirSync(file).sort()) visit(path.join(file, name));
    else if (stat.isFile()) hash.update(readFileSync(file));
  }
  visit(dir); return hash.digest('hex');
}

async function discoveryAndGrammar(): Promise<void> {
  const malformed = [
    ...['status', 'list', 'pending', 'relations', 'on', 'off'].map(verb => [verb, 'UNEXPECTED']),
    ['confirm', 'invalid', '--persist'], ['confirm', randomUUID()], ['confirm', randomUUID(), '--persist', 'extra'],
    ['revoke', 'invalid'], ['revoke', 'a'.repeat(64), 'extra'],
    ['send', 'invalid', 'text'], ['send', randomUUID(), ''],
  ];
  for (const args of malformed) {
    const result = await command(args);
    assert.equal(result.code, 1); assert.match(result.stderr, /collaborate:/); assert.equal(result.stdout, '');
    assert(!existsSync(path.join(home, '.darwin')), 'bad grammar must not initialize storage');
  }
  const locals: LocalCollaboration[] = [];
  try {
    for (let n = 0; n < 40; n++) { const local = new LocalCollaboration(home, `discovery-${n}`); await local.start(); assert(local.address); locals.push(local); }
    const capped = await discoverPeers();
    assert.equal(capped.endpoints.length, 32); assert.equal(capped.uninspected, 8); assert.equal(capped.omitted, 8); assert.equal(capped.scanLimited, false);
    assert.deepEqual(capped.omissions, { self: 0, unusableRegistrationOrSocket: 0, challengeFailed: 0, probeLimit: 8 });
    const requester = locals[0]!;
    const scoped = await requester.discover();
    assert.equal(scoped.endpoints.length, 32, 'self cannot consume one of the 32 peer slots');
    assert(!scoped.endpoints.some(endpoint => endpoint.endpoint === requester.address!.endpoint));
    assert.equal(scoped.self.active, true); assert.deepEqual(scoped.self.address, requester.address);
    assert(scoped.omissions);
    assert.deepEqual(scoped.omissions, { self: 1, unusableRegistrationOrSocket: 0, challengeFailed: 0, probeLimit: 7 });
    assert.equal(scoped.omitted, Object.values(scoped.omissions).reduce((sum, value) => sum + value, 0));
    assert.equal(scoped.uninspected, scoped.omissions.probeLimit);
    assert.equal(scoped.localSessions.state, 'missing', 'no invented lease holders when the session store is absent');
    assert.deepEqual(scoped.localSessions.rows, []);
    const ordered: string[] = [];
    const dir = opendirSync(store);
    try { for (let entry = dir.readSync(); entry; entry = dir.readSync()) if (/^[a-f0-9-]{36}\.json$/.test(entry.name)) ordered.push(entry.name); }
    finally { dir.closeSync(); }
    assert.equal(ordered.length, 40);
    const saved = new Map(ordered.slice(0, 32).map(name => [name, readFileSync(path.join(store, name))]));
    for (const name of saved.keys()) locals.find(local => local.address?.endpoint === name.slice(0, -5))!.close('simulate crash remnant');
    await delay(50);
    for (const [name, bytes] of saved) writeFileSync(path.join(store, name), bytes, { mode: 0o600 });
    // Include both invalid metadata and a non-socket path in the stale prefix.
    writeFileSync(path.join(store, ordered[0]!), '{invalid');
    writeFileSync(socketPath(ordered[1]!.slice(0, -5)), 'not a socket', { mode: 0o600 });
    const before = stateHash(store);
    const result = await discoverPeers();
    const expected = locals.flatMap(local => local.address ? [local.address.endpoint] : []).sort();
    assert.equal(expected.length, 8);
    assert.deepEqual(result.endpoints.map(p => p.endpoint), expected);
    assert.equal(result.omitted, 32); assert.equal(result.uninspected, 0); assert.equal(result.scanLimited, false);
    assert.deepEqual(result.omissions, { self: 0, unusableRegistrationOrSocket: 32, challengeFailed: 0, probeLimit: 0 });
    assert.equal(stateHash(store), before, 'discovery neither deletes stale entries nor changes policy/registrations');
    const listing = launch(cli, ['collaborate', 'list'], home);
    try {
      await waitFor(() => listing.child.exitCode !== null, 'standalone discovery');
      assert.equal(await listing.done, 0, listing.stderr);
      assert.deepEqual(JSON.parse(listing.stdout).endpoints.map((p: any) => p.endpoint), expected);
    } finally { listing.child.kill(); }
    for (const bytes of saved.values()) assert(!JSON.stringify(result).includes(JSON.parse(bytes.toString()).secret), 'no credential disclosure');
    assert.equal(stateHash(store), before);
    console.log('PASS discovery: 32 stale-prefix entries do not hide 8 live endpoints; bounds, omissions, CLI and zero cleanup');

    const trapLocal = locals.find(local => local.address)!;
    const literal = '  /clear\n!literal @AGENTS.md  ';
    const sent = await command(['send', trapLocal.address!.endpoint, literal]);
    assert.equal(sent.code, 0, sent.stderr); assert.match(sent.stdout, /^Queued/);
    assert.equal(trapLocal.take()!.envelope.text, literal, 'CLI preserves quoted leading/trailing whitespace and command-like text');
    const trapId = trapLocal.address!.endpoint;
    const trapFile = path.join(store, `${trapId}.json`); const trapBytes = readFileSync(trapFile);
    trapLocal.close('replace with probe sentinel'); await delay(50);
    writeFileSync(trapFile, trapBytes, { mode: 0o600 });
    let probes = 0;
    const trap = net.createServer(socket => { probes++; socket.destroy(); });
    await new Promise<void>(resolve => trap.listen(socketPath(trapId), resolve)); chmodSync(socketPath(trapId), 0o600);
    try {
      const failedChallenge = await discoverPeers();
      assert(probes > 0, 'positive control: sentinel detects real challenge connections'); probes = 0;
      assert.equal(failedChallenge.omissions.challengeFailed, 1);
      assert.equal(failedChallenge.omitted, Object.values(failedChallenge.omissions).reduce((sum, value) => sum + value, 0));
      const hash = stateHash(store);
      for (const args of malformed) {
        const result = await command(args);
        assert.equal(result.code, 1); assert.equal(result.stdout, '');
        await assert.rejects(collaborationCommand(trapLocal, args.join(' ')), /collaborate/);
        assert.equal(stateHash(store), hash, 'malformed CLI/TUI leaves policy, metadata and socket entries byte/inode-identical');
      }
      assert.equal(probes, 0, 'invalid grammar opens no socket');
      assert.equal(requests(home).length, 0, 'no invalid CLI command invokes the offline model');
    } finally { await new Promise<void>(resolve => trap.close(() => resolve())); }
    console.log('PASS strict CLI/TUI grammar: absent/existing state hashes, no probes/model calls, exact exit 1');
  } finally { for (const local of locals) local.close('discovery controls complete'); }
}

async function tuiFailures(): Promise<void> {
  for (const kind of ['human', 'peer', 'continuation'] as const) {
    const project = path.join(home, `tui-${kind}`); mkdirSync(project);
    const foreign = path.join(home, `foreign-${kind}`); mkdirSync(foreign);
    await requestCooperation(project, foreign);
    await policyCommand(['confirm', readPolicy().pending[0]!.id, '--persist']);
    const grants = readPolicy().pairs;
    const sender = new LocalCollaboration(project, `sender-${kind}`); await sender.start();
    const tui = startTui({ cwd: project, entry: fixture, cols: 140, rows: 42, env });
    try {
      await tui.waitFor('you>', { timeoutMs: 30_000, settleMs: 100 });
      const target = await targetFor(project, sender);
      const invalid = tui.mark(); const policyBefore = readFileSync(policy);
      tui.submit('/collaborate list UNEXPECTED');
      await tui.waitFor('collaborate: /collaborate', { from: invalid, settleMs: 100 });
      assert.deepEqual(readFileSync(policy), policyBefore); assert.equal(requests(project).length, 0);
      const mark = tui.mark();
      if (kind === 'human') tui.submit('hold peer queue');
      else await deliver(sender, target.endpoint, kind === 'peer' ? 'hold peer failure' : 'hold peer interruption');
      await waitFor(() => requests(project).length === 1, 'held TUI model request');
      const marker = 'SHOULD_NOT_AUTO_RUN_AFTER_FAILURE';
      await deliver(sender, target.endpoint, marker);
      await tui.waitFor('peer queued', { from: mark, settleMs: 100 });
      assert.equal(requests(project).length, 1);
      if (kind !== 'human') writeFileSync(path.join(project, 'release-failure'), 'release');
      if (kind === 'continuation') {
        await tui.waitFor('continuing once from retained conversation', { from: mark, settleMs: 100 });
        await waitFor(() => requests(project).length === 3, 'one continuation, then queued peer');
        await tui.waitUntil(() => !tui.frame.includes('working…'), { settleMs: 200 });
        assert(!tui.screen.slice(mark).includes('Collaboration paused'));
        assert.equal((await targetFor(project, sender)).endpoint, target.endpoint);
        assert.deepEqual(readPolicy().pairs, grants);
        console.log('PASS TUI exact interruption: one continuation retains inbox and endpoint; queued peer runs only after recovery');
      } else {
        await tui.waitFor('Collaboration paused after turn failure', { from: mark, timeoutMs: 40_000, settleMs: 100 });
        await tui.waitFor('peer messages dropped: 1', { from: mark, settleMs: 100 });
        if (kind === 'human') assert(tui.screen.includes('Peer fixture hold timed out'));
        else assert(tui.screen.includes('Peer fixture deliberate failure'));
        await delay(1000);
        assert.equal(requests(project).length, 1, 'final failure cannot automatically start a second model call');
        assert(!JSON.stringify(requests(project)).includes(marker));
        assert(!existsSync(path.join(store, `${target.endpoint}.json`)), 'failed endpoint retired');
        sender.beginHumanTurn(); await assert.rejects(sender.send(target.endpoint, 'new admission must fail'));
        assert.deepEqual(readPolicy().pairs, grants, 'failure never changes durable grants');
        // A normal human turn can proceed, but it cannot silently reopen peer admission.
        const human = tui.mark(); tui.submit('explicit human recovery');
        await tui.waitFor('PEER_OFFLINE_REPLY', { from: human, settleMs: 100 });
        assert.equal(requests(project).length, 2); assert(!existsSync(path.join(store, `${target.endpoint}.json`)));
        const on = tui.mark(); tui.submit('/collaborate on');
        await tui.waitFor('This endpoint:', { from: on, settleMs: 100 });
        const fresh = await targetFor(project, sender); assert.notEqual(fresh.endpoint, target.endpoint);
        assert.deepEqual(readPolicy().pairs, grants, 'user on preserves project grants');
        await deliver(sender, fresh.endpoint, 'fresh admitted work after user on');
        await waitFor(() => requests(project).length === 3, 'explicit user on permits fresh peer work');
        await tui.waitUntil(() => !tui.frame.includes('working…'), { settleMs: 200 });
        assert(!JSON.stringify(requests(project)).includes(marker), 'dropped message is never replayed on restart');
        console.log(`PASS TUI ${kind} failure: queued peer dropped, admission fenced, no silent model call; human on recovers with grants intact`);
      }
      tui.submit('/exit'); assert.equal(await tui.exitedWithin(10_000), 0);
    } finally { tui.kill(); sender.close('TUI failure control complete'); }
  }
}

async function headlessFailures(): Promise<void> {
  for (const format of ['text', 'json', 'stream-json']) for (const interruption of [false, true]) {
    const project = path.join(home, `headless-${format}-${interruption}`); mkdirSync(project);
    const sender = new LocalCollaboration(project, 'headless-sender'); await sender.start();
    const run = launch(fixture, ['-p', 'hold peer queue', '--output-format', format], project);
    try {
      await waitFor(() => requests(project).length === 1, 'headless human model held');
      const target = await targetFor(project, sender);
      const action = interruption ? 'hold peer interruption' : 'hold peer failure';
      await deliver(sender, target.endpoint, action);
      await deliver(sender, target.endpoint, 'SUBSEQUENT_PEER_MUST_NOT_DRAIN_ON_FAILURE');
      writeFileSync(path.join(project, 'release-peer'), 'release human');
      await waitFor(() => requests(project).length === 2, 'headless peer model held');
      writeFileSync(path.join(project, 'release-failure'), 'release peer');
      await waitFor(() => run.child.exitCode !== null, 'headless exits after final outcome');
      assert.equal(await run.done, interruption ? 0 : 1, run.stderr);
      assert.equal(requests(project).length, interruption ? 4 : 2, 'no peer drain after final failure; exactly one interruption continuation');
      assert.equal(JSON.stringify(requests(project)).includes('SUBSEQUENT_PEER_MUST_NOT_DRAIN_ON_FAILURE'), interruption);
      assert(!existsSync(path.join(store, `${target.endpoint}.json`)), 'headless failure/success reaps endpoint');
      if (format === 'text') {
        assert(run.stdout.includes('PEER_OFFLINE_REPLY'), 'completed human reply survives later peer failure');
        assert(run.stderr.includes('peer input'));
        if (!interruption) { assert(run.stderr.includes('Peer fixture deliberate failure')); assert(run.stderr.includes('peer messages dropped: 1')); }
      } else {
        const rows = run.stdout.trim().split('\n').map(line => JSON.parse(line));
        const result = rows.at(-1)!;
        assert.equal(result.result, 'PEER_OFFLINE_REPLY', 'initial user result stays separate, including on overall failure');
        assert.equal(result.outcome, interruption ? 'success' : 'failure');
        assert.equal(result.peerTurns.length, interruption ? 2 : 1, 'queued is not processed: only begun peers get outcomes');
        const peer = result.peerTurns[0];
        assert.equal(peer.peer.text, action); assert.equal(peer.peer.sender.endpoint, sender.address!.endpoint); assert.equal(peer.peer.target.endpoint, target.endpoint);
        assert.equal(peer.outcome, interruption ? 'success' : 'failure');
        if (!interruption) {
          assert.equal(peer.result, undefined);
          assert.equal(peer.error.stage, 'turn'); assert.equal(peer.error.name, 'ModelError');
          assert.match(peer.error.message, /^Peer fixture deliberate failure/);
          assert.equal(peer.error.truncated, true); assert([...peer.error.message].length <= 8000);
          assert(result.warnings.some((w: any) => w.message.includes('peer messages dropped: 1')));
          if (format === 'stream-json') {
            const failures = rows.filter(row => row.type === 'turn.failed' && row.origin === 'peer');
            assert.equal(failures.length, 1); assert.deepEqual(failures[0].error, peer.error);
            assert.equal(failures[0].outcome, 'failure'); assert.deepEqual(failures[0].peer, peer.peer);
            assert.equal(rows.filter(row => row.type === 'turn.started' && row.origin === 'peer').length, 1);
          }
        } else { assert.equal(peer.error, undefined); assert.equal(result.continued, true); }
        if (format === 'json') assert.equal(rows.length, 1);
      }
      console.log(`PASS ${format} headless ${interruption ? 'single interruption recovery' : 'peer failure'}: human reply retained, bounded peer outcome, exact model-call count and endpoint teardown`);
    } finally { run.child.kill(); sender.close('headless failure control complete'); }
  }
}

try {
  // Optional section for focused diagnosis; the normal runner always executes all.
  const section = process.argv[2];
  assert(section === undefined || ['discovery', 'tui', 'headless'].includes(section), 'section: discovery|tui|headless');
  if (section === undefined || section === 'discovery') await discoveryAndGrammar();
  if (section !== 'discovery') {
    mkdirSync(path.join(home, '.darwin'), { mode: 0o700, recursive: true });
    writeFileSync(path.join(home, '.darwin/config.json'), JSON.stringify({ provider: 'bedrock', model: 'fake.offline-capture', region: 'us-west-2', promptCache: false, contextOffload: false, memory: false, permissionMode: 'yolo' }));
    if (section === undefined || section === 'tui') await tuiFailures();
    if (section === undefined || section === 'headless') await headlessFailures();
  }
  console.log(`PASS collaboration Host regressions: ${section ?? 'all sections'}`);
} finally { rmSync(home, { recursive: true, force: true }); }
