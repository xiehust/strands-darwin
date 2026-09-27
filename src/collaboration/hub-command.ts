/**
 * User-only hub controls: `darwin collaborate hub …` and `/collaborate hub …` (hub/README.md §5,
 * §7, §9). Never a model tool; the gate denies model-issued `collaborate` controls and reads of
 * the collaboration directory before rules and hooks. `enroll` is CLI-only so a token never enters
 * a session transcript, trajectory or prompt recall.
 */
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { enrollResponseSchema, fingerprint, generateNodeKeys, nodeNameSchema, shortFingerprint, tokenSchema, uuidSchema } from './hub-wire.js';
import { readHubNode, readHubState, removeHubNode, updateHubState, writeHubNode } from './hub-store.js';
import { canonicalProject, checkStore } from './storage.js';
import type { LocalCollaboration } from './local.js';

export const HUB_GRAMMAR = 'collaborate hub status|nodes|leave|publish on|publish off|block <node>|unblock <node>; CLI only: hub enroll <url> <token> [--name <label>]';

type HubArgs =
  | { verb: 'status' | 'nodes' | 'leave' }
  | { verb: 'publish'; on: boolean }
  | { verb: 'block' | 'unblock'; node: string }
  | { verb: 'enroll'; url: string; token: string; name?: string };

/** Pure grammar preflight: nothing is read, written or contacted on a malformed command. */
export function parseHubArgs(args: readonly string[]): HubArgs {
  const [verb, a, b, c, d] = args;
  const fail = (): never => { throw new Error(`Usage: ${HUB_GRAMMAR}`); };
  if ((verb === 'status' || verb === 'nodes' || verb === 'leave') && args.length === 1) return { verb };
  if (verb === 'publish' && args.length === 2 && (a === 'on' || a === 'off')) return { verb, on: a === 'on' };
  if ((verb === 'block' || verb === 'unblock') && args.length === 2 && uuidSchema.safeParse(a).success) return { verb, node: a! };
  if (verb === 'enroll' && (args.length === 3 || (args.length === 5 && c === '--name')) && tokenSchema.safeParse(b).success && a && a.length <= 512) {
    if (args.length === 5 && !nodeNameSchema.safeParse(d).success) fail();
    return { verb, url: a, token: b!, ...(args.length === 5 ? { name: d! } : {}) };
  }
  return fail();
}

/** https, or plain http/ws only to a loopback host (the local hub). */
function safeUrl(value: string, kinds: 'http' | 'ws'): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const secure = kinds === 'http' ? 'https:' : 'wss:';
  const plain = kinds === 'http' ? 'http:' : 'ws:';
  if (url.protocol !== secure && !(url.protocol === plain && loopback)) throw new Error(`hub ${kinds} URL must use ${secure} (plain ${plain} only to loopback)`);
  if (url.username || url.password) throw new Error('hub URL must not carry credentials');
  return url;
}

function defaultName(): string {
  const name = os.hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'darwin';
  return nodeNameSchema.safeParse(name).success ? name : 'darwin';
}

async function enroll(url: string, token: string, name: string): Promise<string> {
  checkStore(true); // same owner-private creation as first collaboration startup
  if (readHubNode()) throw new Error('This HOME is already enrolled; run darwin collaborate hub leave first');
  const base = safeUrl(url, 'http');
  const keys = generateNodeKeys();
  const node = randomUUID();
  const response = await fetch(new URL('/enroll', base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, node, name, publicKey: keys.publicKey }), signal: AbortSignal.timeout(15_000), redirect: 'error' });
  const parsed = enrollResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !parsed.success || parsed.data.node !== node || parsed.data.fingerprint !== fingerprint(keys.publicKey)) throw new Error('enrollment refused (token expired, already used, or not for this hub)');
  const wsUrl = safeUrl(parsed.data.wsUrl, 'ws').toString();
  await writeHubNode({ version: 1, hubUrl: base.origin, wsUrl, audience: parsed.data.audience, node, name, publicKey: keys.publicKey, privateKey: keys.privateKey, fingerprint: parsed.data.fingerprint, enrolledAt: Date.now() });
  return [
    `Enrolled node ${node} (${name}) at ${base.origin}.`,
    `Fingerprint ${shortFingerprint(parsed.data.fingerprint)} (full ${parsed.data.fingerprint}).`,
    'Every enrolled, active node collaborates with this one without per-pair confirmation. New sessions publish to the hub',
    'when their project has a network git origin; opt a project out with: darwin collaborate hub publish off',
  ].join('\n');
}

function status(local: LocalCollaboration | undefined, root: string): string {
  const node = readHubNode();
  const state = readHubState();
  let project: string | undefined;
  try { project = canonicalProject(root); } catch { /* reported as unknown */ }
  return JSON.stringify({
    enrolled: node !== undefined,
    ...(node ? { node: node.node, name: node.name, hub: node.hubUrl, fingerprint: shortFingerprint(node.fingerprint), fullFingerprint: node.fingerprint } : {}),
    ...(local ? { session: { state: local.hub.state, ...(local.hub.reason ? { reason: local.hub.reason } : {}), endpoint: local.hub.address ?? null } } : {}),
    thisProjectPublishes: project === undefined ? 'unknown' : !state.unpublished.includes(project),
    pinnedNodes: state.pins.length,
    blockedNodes: state.blocked,
    rule: 'Enrolled, active, not blocked nodes collaborate without confirmation; keys are pinned on first sight and never re-keyed.',
  }, null, 2);
}

function nodes(): string {
  const state = readHubState();
  return JSON.stringify({ nodes: state.pins.map(pin => ({ node: pin.node, name: pin.name, fingerprint: shortFingerprint(pin.fingerprint), firstSeen: new Date(pin.firstSeen).toISOString(), blocked: state.blocked.includes(pin.node) })), note: 'Pinned on first sight. Compare fingerprints with `darwin collaborate hub status` on the other machine.' }, null, 2);
}

/** `local` is the live session (TUI) or undefined (standalone CLI). */
export async function hubCommand(local: LocalCollaboration | undefined, root: string, args: readonly string[], cli: boolean): Promise<string> {
  const parsed = parseHubArgs(args);
  switch (parsed.verb) {
    case 'status': return status(local, root);
    case 'nodes': return nodes();
    case 'enroll':
      if (!cli) throw new Error('hub enroll is CLI-only so the token never enters a session transcript: run darwin collaborate hub enroll <url> <token> in a shell');
      return enroll(parsed.url, parsed.token, parsed.name ?? defaultName());
    case 'leave': {
      local?.hub.close();
      const removed = await removeHubNode();
      return removed ? 'Left the hub on this HOME: identity and private key removed. The hub row stays until the operator runs revoke-node; re-enrolling issues a new node id.' : 'Not enrolled.';
    }
    case 'publish': {
      const project = canonicalProject(root);
      await updateHubState(state => {
        state.unpublished = state.unpublished.filter(entry => entry !== project);
        if (!parsed.on) state.unpublished.push(project);
      });
      if (local && !parsed.on) local.hub.close();
      if (local && parsed.on && local.active) local.hub.start(local.project, true);
      return `Hub publishing ${parsed.on ? 'on' : 'off'} for ${project}${local ? '; applied to this session' : '; applies to new sessions'}.`;
    }
    case 'block':
    case 'unblock': {
      await updateHubState(state => {
        state.blocked = state.blocked.filter(node => node !== parsed.node);
        if (parsed.verb === 'block') state.blocked.push(parsed.node);
      });
      if (parsed.verb === 'block') local?.dropHubNode(parsed.node, 'node blocked by the user');
      return parsed.verb === 'block' ? `Blocked ${parsed.node}: its messages are refused and queued ones dropped, whatever the hub says.` : `Unblocked ${parsed.node}.`;
    }
  }
}
