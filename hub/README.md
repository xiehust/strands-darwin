# darwin collaboration hub — design

Status: **implemented and verified locally; not yet deployed.** This directory holds the hub
service and its infrastructure. It is an independent package: own `package.json` and lockfile,
not a member of the root `pnpm-workspace.yaml`, never shipped in the `strands-darwin` npm package.
Building the Lambda bundle also needs the repository's root install (it bundles `zod` and
`src/collaboration/hub-wire.ts` from there).

```bash
cd hub && pnpm install
pnpm test                         # handlers through the local hub (also runs in the root pnpm test)
pnpm synth                        # CloudFormation + Lambda bundle, no AWS calls
AWS_REGION=us-west-2 pnpm stack-deploy   # creates the stack; writes cdk-outputs.json (not `pnpm deploy`: a pnpm built-in)
pnpm mint-token --note laptop     # one 10-minute single-use token, printed once
darwin collaborate hub enroll <HubUrl> <token> --name laptop   # on each machine
pnpm list-nodes | pnpm revoke-node <nodeId>
pnpm verify-deployed              # live acceptance (throwaway nodes, revoked at the end)
```

## 0. Implementation notes — where the code differs from the design below

The design sections are kept as written for their reasoning; these deviations win.

| Design said | Implemented | Why |
| --- | --- | --- |
| State in `~/.darwin/hub/` (`node.json`, `pins.json`, …) | `~/.darwin/collaboration/hub-node.json` and `hub-state.json` (pins, blocks, unpublished projects) | The gate's existing collaboration protections (sensitive read path, un-ruleable, model access denied before rules/hooks) cover the private key with no new rule |
| CLI `darwin hub …`, TUI `/hub` | `darwin collaborate hub …` and `/collaborate hub …` (`enroll` CLI-only) | The gate already denies model-issued `collaborate` controls; no new built-in command name |
| `ping` route on a mock integration | No `ping` route; the 4-minute heartbeat re-sends `register` | `register` both resets the idle timer and refreshes the endpoint TTL |
| GSIs on `Endpoints` | None; bounded scans (≤1024 rows) | Single-user scale; fewer moving parts |
| `/status` line | Hub state in `/collaborate status` and `collaborate hub status` | One surface, no new `/status` row |
| `spike/verify-hub-gate.ts` | Gate checks live in `verify-hub-transport.ts` | Same assertions, one suite |
| Reserved concurrency 10 | Off by default; `pnpm stack-deploy -c reservedConcurrency=<n>` | Reservation fails on accounts with a low concurrency quota |
| — | Lambda bundle is ESM (`index.mjs`) | A CJS bundle next to `"type": "module"` loses its exports when loaded locally |
| — | Every client socket ends via one handler bound to both `error` and `close` | Node 22's undici fires only `error` (no `close`, `readyState` stuck at CONNECTING) when the upgrade is refused |
| — | Unreachable hub: 30 capped-backoff attempts, then pause | Bound for unattended reconnects, alongside the three-refusal pause |
| — | A verified sender becomes a known reply target (≤64) | So a peer turn can answer without a fresh `peer_discover` |
| AGENTS.md row (§13) | Section "Collaboration hub — enrollment is the grant" in `docs/architecture/load-bearing-decisions.md` | AGENTS.md is at its 32 KiB preload cap; a row past the cap would be invisible |

## 1. Scope and settled decisions

The hub lets darwin sessions on **different machines** exchange the same literal peer messages
that local collaboration (SER-104, [local-collaboration.md](../docs/architecture/local-collaboration.md))
exchanges over Unix sockets. It is a **relay and node directory**, not a new collaboration model:
peer turns, causal budgets, the permission gate and peer-origin denials stay in darwin and are
unchanged. It implements the "future Hub seam" that document reserves (`PeerTransport`,
versioned `PeerAddress`/`PeerEnvelope`).

| Decision | Choice |
| --- | --- |
| Transport | API Gateway **WebSocket** API + Lambda + DynamoDB (no CloudFront, ALB, ECS) |
| Tenancy | Single user. The AWS account that deploys the hub is the administrator; no admin console |
| Enrollment | One-time token only (no IAM / instance-role enrollment) |
| Authorization | **Every enrolled, active, not locally blocked node may collaborate with every other one**, cross-project included, with no per-pair human confirmation |
| Cross-machine project identity | Automatic: normalized `git remote origin` URL |
| Publishing | Sessions on an enrolled node publish by default; `darwin hub publish off` (per project, persisted) and `/collaborate off` (per session) opt out |
| Message confidentiality | Ed25519 signatures end to end in v1; end-to-end encryption deferred to a later phase |
| Local rules | Unchanged. Same-machine cross-project pairs still need `confirm --persist`; the hub never routes a node to itself |
| Deployment | `us-west-2`, default `execute-api` hostname, AWS CDK (TypeScript) |
| Code location | `hub/` in this repository, independently installed |

Non-goals: durable mailboxes, processed-delivery receipts, automatic retry, shared-write locking,
multi-user accounts, a web UI, hub-side scheduling or any model work in the cloud.

## 2. Service limits that shape the design

Checked against the API Gateway WebSocket quota table and Lambda authorizer documentation:

| Limit | Value | Consequence |
| --- | --- | --- |
| Lambda authorizer | `$connect` route only; sees the handshake request only | Authentication is a signed assertion in handshake headers (§6); later frames are bound by `connectionId` |
| Idle connection timeout | 10 minutes | Client sends `ping` every 4 minutes; `ping` is a mock integration (no Lambda) |
| Connection duration | 2 hours, not adjustable | Client reconnects proactively at ~110 minutes: open new, move endpoints, close old |
| Frame / message size | 32 KB / 128 KB | 4096-byte text + envelope + signature fits one frame; hub rejects frames over 16 KiB, as local does |
| Integration timeout | 29 s | Every handler is one lookup plus at most one `PostToConnection` fan-out |
| New connections | 500/s per account and Region (default) | Irrelevant for one user; stage throttling bounds abuse cost |
| AWS WAF | Not supported for WebSocket APIs | Abuse bounded by stage/route throttling, early authorizer rejection and per-node counters |

DynamoDB TTL deletion is asynchronous, so **no correctness decision relies on TTL deletion**:
every read compares `expiresAt` itself; TTL only garbage-collects.

Node: darwin requires `>=22`, where global `WebSocket` exists; its non-standard `headers` option
(undici) was verified on v22.19.0 to reach the server's upgrade request. The client checks the
capability at startup and disables only the hub transport (with a notice) when absent. No new
darwin dependency.

## 3. Architecture

```
darwin A ──wss + signed handshake headers──> API Gateway WebSocket API (stage "v1")
                                               ├─ $connect    → authorizer λ, connect λ
                                               ├─ $disconnect → disconnect λ
                                               ├─ register / unregister / discover / send / ack → λ
                                               └─ ping        → mock integration
darwin B <──── PostToConnection ──────────────┘              │
                                                          DynamoDB
darwin (enroll) ──https POST /enroll──> API Gateway HTTP API → enroll λ
operator scripts (deployer's AWS credentials) ──> DynamoDB + @connections (mint token, revoke node)
```

Delivery is synchronous: the `send` handler looks up the target endpoint's `connectionId` and
calls `PostToConnection`. There is no cross-instance routing problem (API Gateway owns the
connections) and **no message storage**: an offline target yields `offline` immediately.

### Routes

| Route | Handler | Purpose |
| --- | --- | --- |
| `$connect` | authorizer + connect | Verify node assertion (§6); write `Connections` |
| `$disconnect` | disconnect | Delete the connection and the endpoints it registered |
| `register` / `unregister` | endpoints | Publish / retire one session endpoint on this connection |
| `discover` | discover | List live endpoints of **other** active nodes (≤32, plus `omitted`) |
| `send` | send | Validate, bind sender, rate-limit, dedupe, deliver (§8) |
| `ack` | ack | Relay "queued at target" back to the sender's connection |
| `ping` | mock | Keep-alive only |
| `POST /enroll` (HTTP API) | enroll | Redeem a one-time token (§5) |
| `GET /time` (HTTP API) | time | Server epoch ms, so a refused client can tell clock skew from revocation |

Server-initiated frames: `deliver`, `ack`, `node-enrolled`, `node-revoked`, `endpoint-gone`.

### Tables (on-demand, point-in-time recovery on, TTL attribute `expiresAt`)

| Table | Key | Attributes |
| --- | --- | --- |
| `Nodes` | `nodeId` | `publicKey` (Ed25519, SPKI base64), `fingerprint`, `name`, `status` (`active`/`revoked`), `enrolledAt`, `revokedAt?` |
| `Connections` | `connectionId` | `nodeId`, `connectedAt`, `expiresAt` (connect + 2 h) |
| `Endpoints` | `endpointId` | `connectionId`, `nodeId`, `project`, `projectLabel`, `session`, `expiresAt` (heartbeat + 10 min); GSI `nodeId`, GSI `connectionId` |
| `Tokens` | `sha256(token)` | `expiresAt` (mint + 10 min), `note` |
| `Replay` | `kind#value` | Connect nonces, envelope ids, per-node rate windows; `expiresAt` |

Lambda logging rule: handlers log route, ids, sizes and outcomes, **never `text`, envelope bodies,
tokens or signatures**. A test greps captured logs for a sentinel string.

## 4. Identities and addresses

| Identity | Lifetime | Where it lives |
| --- | --- | --- |
| Account | The AWS account hosting the hub | Implicit; operator scripts use its credentials |
| Node | One darwin installation (`~/.darwin`) on one machine, from enroll to revoke/leave | `Nodes` row; private key in `~/.darwin/hub/node.json` |
| Endpoint | One parent runtime incarnation (new on restart, `/clear`, `/rewind`, failure-retire) | `Endpoints` row while connected; same UUID rules as local |

The hub node id is a **fresh UUID generated at enrollment** and stored in `node.json`; it is
deliberately independent of the local collaboration node UUID in `policy.json`, so revoking and
re-enrolling a machine never changes its local-transport identity.

### Address version 2

Version 1 (`transport: "local"`, `project` = canonical absolute root) stays byte-identical.
The hub adds a discriminated variant; `addressSchema` becomes a union:

```ts
{ version: 2, transport: "hub", node: UUID, endpoint: UUID,
  project: string,      // normalized remote identity, e.g. "github.com/xiehust/strands-darwin"
  session: string }     // same regex as v1
```

The envelope keeps its shape (`version`, `id`, `sender`, `target`, `sent`, `chain`, `text`) with
hub addresses on both sides; a mixed local/hub envelope is invalid.

### Project identity (automatic)

1. `git -C <project root> remote get-url origin` (argument array, no shell, 2 s timeout).
2. Parse as URL or scp-like `user@host:path`. Drop scheme, **userinfo (a token may live there) and
   port**, lowercase host, strip trailing `/` and `.git`, collapse `//`.
   `git@github.com:Org/Repo.git` and `https://tok@github.com/Org/Repo` both become
   `github.com/Org/Repo` (path case preserved; hosts differ in case sensitivity).
3. Result must match `^[a-z0-9.-]+(/[A-Za-z0-9._~-]+){1,8}$` and be ≤256 bytes.
4. No git, no `origin`, local-path remotes (`/srv/x.git`, `file://`) or any failure: **hub disabled
   for that project** with one notice; never fall back to an absolute path.

The absolute path never leaves the machine. `projectLabel` (last path segment) is display-only.
The identity is **sender-asserted**: attribution for the reader, never an authorization input.

## 5. Enrollment (one-time token)

1. **Mint** — on a machine with the deployer's AWS credentials:
   `pnpm --dir hub mint-token [--note <text>]`. It generates 32 random bytes, writes only
   `sha256(token)` with a 10-minute `expiresAt` to `Tokens`, and prints the token once as
   `dhub1_<base64url>`. Nothing else stores the plaintext.
2. **Enroll** — on the target machine, a user-only CLI verb:
   `darwin hub enroll <https-url> <token> [--name <label>]`.
   darwin generates an Ed25519 key pair (`node:crypto`), then `POST /enroll` with
   `{token, nodeId, publicKey, name}`.
3. **Redeem** — the enroll handler runs one `TransactWriteItems`: delete `Tokens[sha256(token)]`
   with condition `attribute_exists AND expiresAt > now`, and put `Nodes[nodeId]` with condition
   `attribute_not_exists`. Either both happen or neither: a token redeems at most once, an existing
   node id is never overwritten. Every failure returns the same `enrollment refused` (no oracle).
4. **Store** — `~/.darwin/hub/node.json` = `{version:1, hubUrl, wsUrl, nodeId, name, privateKey,
   publicKey, fingerprint, enrolledAt}` under the existing owner-private rules (0700 dir, 0600
   exclusive temp file, fsync + rename, NOFOLLOW/fstat reads, corrupt/foreign/symlink → fail closed).
5. **Announce** — the hub broadcasts `node-enrolled {nodeId, name, fingerprint, enrolledAt}` to
   every live connection; darwin shows one Static notice. `darwin hub status` prints the node's
   own fingerprint (first 16 hex of `sha256(SPKI)`, grouped) and the known nodes.

Revocation and exit:

- `pnpm --dir hub revoke-node <nodeId>`: set `status=revoked` (conditional), `DeleteConnection`
  for each of its connections, delete its endpoints, broadcast `node-revoked {nodeId}`.
- `darwin hub leave`: closes its connection (`$disconnect` drops its endpoints), then removes
  `~/.darwin/hub/`.
  The server row is revoked only by the operator script (a leaked key must not be able to hide by
  "leaving"; an actual compromise is handled by `revoke-node`).
- Re-enrolling a revoked machine creates a **new node id** (and key); a revoked id never returns.

## 6. Connection authentication

One-shot signed assertion in handshake headers (the authorizer cannot run a challenge round):

```
X-Darwin-Node:  <nodeId>
X-Darwin-Ts:    <epoch ms>
X-Darwin-Nonce: <16 random bytes, base64url>
X-Darwin-Sig:   Ed25519(privateKey, "darwin-hub-connect/v1\n<apiId>/<stage>\n<nodeId>\n<ts>\n<nonce>")
```

Authorizer (REQUEST type; identity sources name the four headers so a request missing any is
refused before invocation; **authorizer result caching must be off** — every nonce is single-use —
and the deploy check reads the deployed authorizer configuration to prove it):

1. Parse and bound every header; reject otherwise.
2. `Nodes[nodeId]` exists and `status = active`.
3. `|now − ts| ≤ 60 s`.
4. Ed25519 verify over the exact string, which binds this API id and stage (a signature cannot be
   replayed against another deployment).
5. Conditional put `Replay["nonce#" + nodeId + nonce]` with `expiresAt = now + 5 min`; an existing
   item means replay → deny.
6. Allow with context `{nodeId}`. The connect handler writes `Connections` from that context.

Credentials never appear in query strings (access logs), frames or model-visible output. After
`$connect`, the hub identifies the sender of every frame solely by `connectionId → nodeId`, and
re-checks `status = active` on every `send`.

## 7. Authorization: enrollment is the grant

**Rule:** a hub message is admitted when the sender node is `active` at the hub, not blocked
locally, and its envelope signature verifies against the key pinned for that node. Project pair,
same/different project, and first contact do not matter. There is **no pending request and no
human confirmation** on the hub transport. The trust root is therefore the AWS account (who can
mint tokens) plus the hub's `Nodes` directory; §10 states what that costs.

Safeguards that need no confirmation and are kept on purpose:

1. **Pin once, never re-key.** The first envelope (or `discover` row) naming a node stores
   `{nodeId → publicKey, fingerprint, firstSeen}` in `~/.darwin/hub/pins.json` (owner-private,
   ≤256 entries, atomic, locked like `policy.json`). A later different key for the same id is
   refused on send and receive with a visible notice; the only remedy is operator `revoke-node`
   plus re-enroll (new id). A compromised hub can therefore not swap a known node's key.
2. **Enrollment is announced.** `node-enrolled` produces one Static notice on every live session
   (TUI) or one `hub:` stderr line (headless). An unexpected enrollment is visible without action.
3. **Local veto.** `darwin hub block <nodeId>` / `unblock <nodeId>` (user-only, un-ruleable, denied
   to the model) is checked on send, admission, dequeue and immediately before SDK invocation —
   the same four points where local collaboration re-checks its grant generation. Blocking works
   even when the hub is compromised.
4. **Revocation propagates.** `send` re-reads sender status; `node-revoked` makes every receiver
   drop queued messages from that node (visible notice) and refuse it thereafter, mirroring local
   `revoke` fencing queued input.
5. **Peer-turn limits are unchanged and runtime-owned:** `peerInput` is never user authority;
   ordinary gate prompts still apply outside yolo; peer-origin unsafe bash, policy/config/AGENTS
   writes and memory saves are denied even in yolo; plan ceiling propagates; 4 hops, one send per
   peer turn, 5-minute chains, inbox 8, 16 admissions/minute, dedupe 256 ids.

Item 5 is what bounds a rogue enrolled node: it can make a session *read and answer*, not make it
act beyond what the local gate allows for peer-origin work.

Local collaboration rules are **not** changed: same-machine cross-project pairs still need
`confirm --persist`. `discover` excludes the caller's own node, so the hub is never a way around
that. (Cross-machine is thus more permissive than same-machine cross-project; aligning them is a
separate decision.)

## 8. Message flow and wire frames

All frames are JSON text, ≤16 KiB, validated with strict zod schemas on both sides. The schemas
live in one pure module, `src/collaboration/hub-wire.ts` (zod + `node:crypto` only, no filesystem
or darwin runtime imports); the hub's esbuild bundles it by relative import, so there is exactly
one definition. Signatures are over `JSON.stringify` of the **zod-parsed** value, whose key order
is the schema's, so both sides serialize identically.

**Client → hub**

```
{action:"register",   endpoint, project, projectLabel, session}          → {ok} | {error}
{action:"unregister", endpoint}
{action:"discover"}                                                      → {endpoints:[...], omitted}
{action:"send",  envelope, sig}      sig = Ed25519(sender key, canonical JSON of envelope)
{action:"ack",   id, status:"queued"|"refused", reason?}
{action:"ping"}
```

`register` is also the endpoint heartbeat (re-sent every 4 minutes with `ping`). An endpoint id
can only be registered on a connection of the node that first registered it.

**Hub → client**

```
{type:"deliver", envelope, sig, senderKey, senderFingerprint}
{type:"sendResult", id, status:"delivered"|"offline"|"rejected", reason?}
{type:"ack", id, status, reason?}          relayed from the target
{type:"node-enrolled", nodeId, name, fingerprint, enrolledAt}
{type:"node-revoked", nodeId}
{type:"endpoint-gone", endpoint}
```

**Send, step by step**

1. **Sender darwin A** (`peer_send`): target is a hub endpoint from the last `discover`; target
   node not blocked; pinned key (if any) matches the discover row; causal budget available.
   Build the envelope (hub addresses, existing chain rules), sign, send.
2. **`send` handler:** schema and size; `envelope.sender.node == Connections[connectionId].nodeId`
   and `sender.endpoint` registered on this connection (the hub never trusts the claimed sender);
   sender `active`; per-node rate window (60 sends/min, 600/hour; conditional-update counters in
   `Replay`); `sent` within ±60 s; look up the target endpoint, check its `expiresAt` and target
   node `active`; conditional put `Replay["msg#" + id]` = `{senderConnection, targetConnection}`
   (dedupe, 2 min); `PostToConnection(deliver)`.
   `GoneException` deletes the stale endpoint and yields `offline`. The hub never stores `text`.
3. **Receiver darwin B:** verify signature with the pinned key (pin on first sight); sender not
   blocked; envelope target is one of *this* connection's live endpoints; TTL/chain/hop/dedupe as
   today; enqueue into the existing `LocalCollaboration` inbox as a `peerInput` turn; send `ack`
   (`queued` or `refused` with a bounded reason). The `ack` handler relays it only when the frame
   arrives on the `targetConnection` recorded under `msg#id`, and at most once, so no other node
   can forge "queued".
4. **Result semantics** (unchanged from local): `delivered` means handed to B's connection;
   `ack queued` means in B's inbox — never "processed". No durable inbox, no hub retry; if A's
   connection drops before a result, the outcome is **ambiguous** and is reported, never replayed.

The signature covers the whole envelope, including `target`, `chain` and `sent`, so the hub cannot
redirect, re-chain or re-time a message without breaking it. It does not hide `text` from the hub
(v1 is signed, not encrypted).

## 9. darwin client changes

| Area | Change |
| --- | --- |
| `src/collaboration/hub-wire.ts` (new, pure) | v2 address/envelope/frame schemas, canonical sign/verify, fingerprint, remote-URL normalization |
| `src/collaboration/hub-store.ts` (new) | `node.json`, `pins.json`, `blocks.json`, `publish.json` via the existing owner-private helpers in `storage.ts` |
| `src/collaboration/hub-transport.ts` (new) | `HubTransport implements PeerTransport`: connect with signed headers, `ping` every 4 min, rotate at ~110 min, register/heartbeat endpoints, verify/pin/block on receive, feed the existing inbox |
| `protocol.ts` / `local.ts` | `addressSchema` becomes the v1/v2 union (v1 bytes unchanged); `LocalCollaboration` owns both transports and routes `peer_send` by where the target UUID was discovered; admission/dequeue/pre-invoke re-checks add "node active and not blocked" |
| `peer_discover` / `peer_send` | Result gains `transport` per endpoint and a bounded `hub:{state, omitted}`; local and hub lists are capped separately at 32. **Tool descriptions are rewritten** to state the hub rule (enrolled nodes are automatic), since the model reads them |
| `peerPrompt` | Hub messages say "Remote peer message via hub" instead of "Local peer message"; same NOT-a-user-instruction framing |
| CLI `darwin hub` | `enroll <url> <token> [--name]`, `status`, `nodes`, `block <nodeId>`, `unblock <nodeId>`, `publish on\|off`, `leave`. Shared grammar preflight before any state/network work, as `collaborate` has |
| TUI `/hub` | Same verbs **except `enroll`**, which is CLI-only so a token never enters a session transcript or prompt recall |
| Permission gate | `~/.darwin/hub/` joins the sensitive-read paths (dangerous, un-ruleable, prompted even in plan); a model-issued `darwin hub …` is denied before rules and hooks, like `darwin collaborate` |
| `/status` | One line from the existing collaboration accessor: `hub: connected (node <short>, N endpoints)` or the disabled reason |
| Headless | Unchanged drain rules; hub notices go to stderr as one `hub:` line each |

**Connection lifecycle** (unattended code, so bounded):

- Reconnect with exponential backoff and jitter: 1 s, 2 s, 4 s … capped at 60 s.
- An authorizer refusal (HTTP 403 on upgrade) is deterministic. After **3 consecutive** refusals
  the transport **pauses** with a stated reason (`node revoked or clock skew — run darwin hub
  status`) until the user runs a `hub` verb or a new session starts. The client reads
  `GET /time` from the HTTP API to tell skew from revocation.
- A send whose `sendResult` never arrives (connection dropped, 10 s timeout) is reported as
  `ambiguous` and never replayed, matching local semantics.
- Rotation: open the new connection, re-`register` every endpoint, then close the old one. A
  message delivered to the old connection during the overlap is still received; nothing is replayed.

## 10. Threat model and explicit limits

| Adversary | Can | Cannot | Response |
| --- | --- | --- | --- |
| AWS account compromise | Mint tokens, enroll a rogue node, read text in Lambda, drop traffic | Forge or re-key an already pinned node | Enrollment notice; `block`; rotate the account; peer-turn limits bound the rogue node's effect |
| Token leaked within its 10 min | Enroll one rogue node | Reuse the token | Enrollment notice; `revoke-node`; `block` |
| Node private key leaked | Impersonate that node | Impersonate other nodes | `revoke-node` (every receiver drops and refuses it); re-enroll yields a new id |
| Hub bug or compromised handler | Drop, delay (≤60 s TTL), observe text and metadata; serve a fake key for a node **not yet pinned** | Alter, redirect, re-chain or replay a signed envelope | Pins; receiver dedupe/TTL; `darwin hub nodes` shows fingerprints for manual comparison |
| Remote prompt injection | Put text into a peer turn | Approve permissions, change policy/config/AGENTS, save memory, run peer-origin unsafe bash | Existing peer-origin rules; the gate stays authoritative |
| Flood / cost | Spend its own rate window | Exceed stage throttles, per-node windows or reserved Lambda concurrency | Throttles and caps (§12) |

Stated limits, carried over from local collaboration and extended:

- Not an OS sandbox; same-UID malicious code on a node can read that node's private key.
- First sight of a node is trust-on-first-use **without a human**, by decision; a hub that is
  already malicious at that moment can plant a key. Fingerprints are available for manual checks.
- v1 text is visible to the hub operator (AWS). Not stored, not logged, but not end-to-end encrypted.
- No delivery guarantee, no durable inbox, no processed receipt, no shared-write coordination.
- The sender-asserted project identity is attribution only; two different repos with the same
  normalized remote are indistinguishable by design.

## 11. Verification plan

Hub handlers are written against two small interfaces — `Store` (DynamoDB or in-memory, same
conditional-write semantics) and `Gateway` (`postToConnection`/`deleteConnection`, AWS or local)
— so the **same handler code** runs in Lambda and in `hub/src/local-server.ts`, a
dependency-free local hub (Node `http` upgrade + a minimal RFC 6455 text-frame codec, ≤16 KiB,
no extensions). That lets darwin's own suites exercise real transports without AWS or new deps.

| Suite | Where | Proves |
| --- | --- | --- |
| `spike/verify-hub-wire.ts`† | darwin, free | v1 schema bytes unchanged; v2 schema; sign/verify with every envelope field tampered; fingerprint; normalization table (scp/https/ssh, userinfo and port stripped, `.git`, case) and refusals (no origin, local path, `file://`, over-long) |
| `spike/verify-hub-transport.ts`† | darwin, free | Two real `LocalCollaboration` runtimes with separate temporary HOMEs as two nodes through the local hub: enroll, discover, send, `peerInput` turn, ack; pin on first sight, re-key refused, `block` fences queued input, `node-revoked` drops the inbox; 403×3 pause; ambiguous result not replayed; rotation keeps endpoints; enroll absent from TUI grammar |
| `spike/verify-hub-gate.ts`† | darwin, free | `~/.darwin/hub/` is dangerous and un-ruleable, prompted even in plan; model `darwin hub` denied before rules/hooks; hub peer-origin unsafe bash / policy / memory save denied in yolo; tool descriptions state the hub rule |
| `hub/spike/verify-handlers.ts` | hub package, free | Authorizer negatives (bad sig, other stage, skew, replayed nonce, revoked, missing header); single-use token under concurrent redemption (in-memory store); sender binding; forged `ack`; rate windows; `text`-sentinel absent from captured logs |
| `hub/spike/verify-deployed.ts` | *live*, AWS | Deployed config (authorizer caching off, throttles, reserved concurrency, log retention); two enrollments; concurrent redemption of one token → exactly one success; round trip with ack between two nodes; revoke broadcast; CloudWatch log search finds no sentinel text |
| Existing | darwin | `verify-collaboration*.ts`, permissions, headless, trajectory, `tui completion` unchanged and passing |

Final acceptance also includes one manual run between two real machines (this EC2 host plus one
other), recorded in the iteration log.

## 12. Layout and milestones

```
hub/
  README.md               this design
  package.json            independent; aws-cdk-lib, constructs, @aws-sdk/{client-dynamodb,
                          lib-dynamodb, client-apigatewaymanagementapi}, esbuild, tsx, typescript
  src/handlers/           authorizer, connect, disconnect, endpoints, discover, send, ack, enroll, time
  src/store.ts            Store interface;  store-memory.ts | store-dynamo.ts
  src/gateway.ts          Gateway interface; gateway-local.ts | gateway-aws.ts
  src/local-server.ts     dependency-free local hub (tests, offline development)
  src/lambda/             thin Lambda entry points: wire handlers to store-dynamo + gateway-aws
  infra/app.ts, infra/hub-stack.ts   CDK stack
  scripts/                mint-token, revoke-node, list-nodes
  spike/                  verify-handlers, verify-deployed
```

**Import boundary.** darwin's free suites import `hub/src/local-server.ts`, and the root
`tsconfig` compiles whatever they import. So the closure of `handlers/`, `store.ts`,
`store-memory.ts`, `gateway.ts`, `gateway-local.ts` and `local-server.ts` may import only Node
built-ins, `zod` and `src/collaboration/hub-wire.ts`; AWS SDK imports live only in
`store-dynamo.ts`, `gateway-aws.ts`, `lambda/`, `infra/` and `scripts/`. `verify-hub-transport.ts`
checks the boundary by scanning that closure's import specifiers. The Lambda bundle resolves
`zod` and `hub-wire.ts` from the repository, so building the hub requires the root install too.

Infrastructure defaults: Lambda `nodejs22.x` on arm64, 256 MB; reserved concurrency 10 per
function family; CloudWatch log retention 14 days; WebSocket stage throttling rate 20/s, burst 50;
HTTP API throttling rate 2/s, burst 5; DynamoDB on-demand with point-in-time recovery; `Nodes`
table `RETAIN` on stack deletion, others `DESTROY`; stack outputs the WebSocket and HTTP URLs.

Milestones, one commit each, each gated by `pnpm typecheck` + `pnpm test` + its suites:

1. **Wire and identity** — `hub-wire.ts`, v1/v2 address union, normalization; `verify-hub-wire.ts`.
2. **Hub handlers** — `hub/` package, `Store`/`Gateway`, handlers, local server; `verify-handlers.ts`.
3. **darwin transport** — `hub-store.ts`, `hub-transport.ts`, `LocalCollaboration` routing, CLI/TUI
   verbs, gate rules, tool descriptions, `/status` line; `verify-hub-transport.ts`, `verify-hub-gate.ts`.
4. **Deploy** — CDK stack, operator scripts, deploy to `us-west-2`; `verify-deployed.ts`; manual
   two-machine run.
5. **Docs** — decisions-doc section and AGENTS.md row (§13), user guide in English and Chinese,
   `local-collaboration.md` seam paragraph updated; `pnpm build`.

## 13. Draft load-bearing decision (added to the decisions doc when implemented)

Proposed AGENTS.md row:

| Decision (doc §) | Load-bearing invariant | Code | Checks |
| --- | --- | --- | --- |
| Collaboration hub — enrollment is the grant, the hub is a relay | Hub transport admits a message iff sender node is active at the hub, not locally blocked, and its Ed25519 envelope signature matches the key pinned on first sight (re-key refused); no per-pair confirmation, local-transport rules unchanged and the hub never routes a node to itself; one-time token enrollment is CLI-only; the hub stores no text and logs none; peer-turn limits, peer-origin denials and ambiguous-never-replayed semantics are the local ones; `~/.darwin/hub/` sensitive and un-ruleable | `src/collaboration/hub-*.ts`, `hub/` | `verify-hub-wire.ts`†, `verify-hub-transport.ts`†, `verify-hub-gate.ts`†, `hub/spike/verify-deployed.ts` (*live*) |

The decisions-doc section will carry the rationale in §1, §7 and §10 of this document, in
particular why the hub transport is deliberately more permissive than same-machine cross-project
collaboration, so a later change does not "restore" a confirmation step by mistake.
