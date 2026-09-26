# Local collaboration (SER-104)

Implementation design and requirement-to-test checklist. Host owns acceptance and research state.

## Contracts and independent checks

| Contract | Independent executable evidence |
| --- | --- |
| Same canonical project automatically exchanges literal text both ways; exact endpoint identities, no discovery-triggered work | `verify-collaboration.ts`: two real endpoint processes; `verify-collaboration-drivers.ts`: real offline SDK runtimes |
| Unknown cross-project pair refuses with pending request; one human confirmation is symmetric, durable across new processes; revoke fences queued and future input | `verify-collaboration.ts`: CLI confirmation, restart, concurrent approvals/revocation, delivery recheck |
| Owner-private bounded atomic trust and endpoint storage; corrupt/symlink/forged/stale data fail closed | `verify-collaboration.ts`: real temporary HOME negative controls and socket frames |
| Bounded frames, connections, timeout, expiry, queue, deduplication and causal replies; queued acknowledgement is not processing | `verify-collaboration.ts`: hostile/partial/flood frames and loop/queue limits |
| Parent-only ordinary tools; plan and sensitive-policy protections; no model trust grants or permission laundering | `verify-collaboration-drivers.ts`: real gated tool requests and child catalogue checks |
| Peer provenance is not user input, recall, rewind, memory quote or cloud consent; slash/shell/at/framing stay literal | `verify-collaboration-drivers.ts`: captured model requests, trajectory/replay/recall/catalogue, memory refusal |
| Idle-only TUI delivery, busy/permission ownership, cancellation/successor fencing; headless bounded drain and honest structured events | `verify-collaboration-drivers.ts`: real PTY and normal headless driver, lifecycle negatives |
| Existing leases, `/agents`, task wakes and plain streaming unchanged; canonical help/completion and source/built CLI work | Existing affected suites, free completion, new CLI tests against source and build |

## Design

### Runtime, driver and provenance seams

`LocalCollaboration` owns only a parent session's inbox, endpoint and bounded causal state.
`AgentRuntime.create()` adds the two ordinary tools, filters them from children, and starts the
endpoint after successful assembly. No SDK loop/executor is replaced. TUI subscription publishes
bounded Static notices; its idle effect shares the prompt queue's draining latch and yields to
user/task entries, permission ownership and session management. It calls the existing `runTurn`.
The headless driver closes admission after its normal invocation, then runs up to eight admitted
messages through its existing text/structured streaming functions. No timer starts model work.

`send()` takes a typed `PeerInput` origin, rechecks its exact target/authorization immediately before
`agent.stream()`, suppresses UserPromptSubmit and user quote provenance, and skips rewind capture.
Trajectory opens `peerInput` (literal model input plus envelope), never `userInput`; replay prints the
same sender/text notice, prompt recall remains userInput-only. Memory/cloud controllers receive an
empty user quote. Peer memory saves are denied outright. Structured peer starts name their origin;
final output retains the user answer separately from bounded peer results. Model text still streams
normally. Clear/rewind create new UUIDs and retire the old inbox. Cancellation requires user `on`
to publish a fresh endpoint. A generation fence also rejects a startup superseded by cancellation
or overlapping user `on` commands, so it cannot publish an orphan endpoint. No pending text is
reinterpreted as a successor's user input.

### Trust and IPC

[The user reference](../user-guide/reference.md#local-collaboration) specifies exact grammar,
wire/file schemas and caps. Policy reads/writes validate bounded owner-private regular files with
NOFOLLOW/NONBLOCK/fstat. HOME/.darwin traversal is canonical, owned and not foreign-writable;
collaboration is 0700. Locking serializes the fresh read and atomic fsync/rename update. No stale
lock is stolen: manual recovery after a crash sacrifices availability rather than resurrecting a
revoked relationship. Confirmation and revocation remove pending requests atomically, so an old
request cannot race a revoke into restoring trust. Grant/generation IDs change authorization
identity; regrant/on does not validate a previously queued message.

An endpoint has a full address (version, local transport, durable local node UUID, fresh endpoint
UUID, canonical project, session ID), diagnostic PID and random 256-bit HMAC credential. Credentials
stay in the private directory, never tools or frames. Recipient identity is target-signed; sender
identity is checked against its private registration and a fresh signed socket challenge. Replaying
a valid frame is deduplicated through its lifetime. The UUID is a process incarnation, not a PID:
a stale PID or replaced socket cannot sign the required response. There is no durable inbox or
processed receipt. Unknown outcome after network failure is explicitly ambiguous, never retried.

### Authority and bounded automation

Peer tools cannot choose trust, origin, chain ID, hop, budget or read-only ceiling. Same-project
admission needs no cooperation approval; unknown project pairs produce a bounded pending request
and exact human confirmation command even under yolo/headless. The ordinary gate protects incoming
tool work. Plan applies locally and propagates as a narrowing ceiling along the chain. Known
collaboration policy/credential access and model-issued collaboration CLI are denied before rules
or hooks. Peer-origin unsafe bash, policy/config/AGENTS paths and memory saves are denied; allowed
ordinary file edits can still run outside plan. Denials latch peer sends until a genuine human
turn, including across synthetic wakes. The same peer ID keeps its outgoing budget across the one
existing stream-interruption continuation. No classifier decides whether an answer deserves another
turn. Four reply hops, one outgoing/peer turn, two admissions/endpoint/chain and a five-minute chain
lifetime stop loops; queue, connection, frame and admission-rate caps bound floods.

### Explicit limitations and future Hub seam

This is **same OS user local IPC, not a security isolation boundary against malicious same-UID
arbitrary code**. That code can read private credentials, replace registrations or invoke the
user CLI, just as it can edit Darwin's policy. Root is not excluded by filesystem DAC. The gate is
not an OS sandbox and does not infer the semantics of arbitrary scripts/MCP tools or prevent all
indirect permission laundering. Text framing is attribution, not a prompt-injection guarantee.
Peers are not shared-write-safe; users must coordinate edits. Text enters the configured model
provider's ordinary request and durable local conversation/trajectory. Cooperation is not consent
to adopt cloud preferences or quote peers as the user; separately authorized tool-output cloud
uploads keep their existing policy. There is no new remote transfer channel.

Node builtins supply POSIX Unix sockets only; Windows and socket paths over 103 bytes fail closed
with a notice, not TCP fallback. Canonicalization happens inside that guarded startup: a missing
project disables only collaboration, never otherwise-valid runtime assembly. Owner-private storage is required; a permissive inherited umask is
not silently repaired. Dead endpoint files can remain after SIGKILL; discovery skips them and is
bounded, not a janitor. No malicious-UID filesystem race isolation is claimed.

`PeerAddress`/`PeerEnvelope` are versioned, carry a local node identity, and cross the small
`PeerTransport.send(target,text)` seam. A future Hub adapter would need an explicitly authorized
remote address/transport, authenticated node ownership, remote trust scope, transfer consent,
expiry/receipt semantics and matching abuse limits. None are implemented here: no Hub server,
remote listener, cloud storage, remote authentication infrastructure, dependencies or speculative
routing/scheduler framework. The current schema rejects any transport other than `local`.

## Verification record

Worker source verification (2026-09-26): both new suites run in `pnpm test`; the final
`pnpm typecheck`, complete `pnpm test`, bounded-help suite and free `verify-tui.ts completion`
passed together. Listed affected lease/listing, permission, streaming/headless, task-wake,
trajectory, clear/rewind and frame-budget checks are included in that gate. Post-commit acceptance
also requires `pnpm build` and `node dist/spike/verify-collaboration.js`, which exercises the compiled
standalone CLI as well as compiled real endpoint processes.

Earlier attempts were not accepted: review found and fenced overlapping endpoint startups;
the gate found missing-project canonicalization escaping the optional feature boundary,
alphabetical command order and exact legacy `/list-agents` help compatibility; completion found
the long peer description clipping its name. Each has a targeted correction/independent check.
The standalone HTTP check needs the runner's `DARWIN_MODEL_PRICES_FETCH=off` environment; omitting
it trips the pricing fetch sentinel, not a permitted HTTP tool call. Existing tests were not weakened.

Baseline supplied by Host: unchanged source gate passed at ee9e1d7; source start was clean 692ae6e.
The initial review-driver retained-draft timeout was transient and passed on focused/full reruns
without code edits; this implementation does not change those review tests. Host owns final acceptance.
All cooperation writes during verification use temporary private HOMEs. The real account's existing
`.darwin` is group-writable (775), so local endpoint startup there requires an owner permission repair;
no real global policy, directory permissions or cooperation relation was changed.
