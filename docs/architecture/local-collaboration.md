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
| Final human/peer failure cannot silently drain another peer; explicit user on restores admission without changing grants; exact interruption still continues once | `verify-collaboration-failures.ts`: original 30-second human hold timeout and throwing peer model in real PTYs, queued marker absent from captured requests, endpoint retired, restart and continuation controls |
| Stale prefix cannot spend challenge budget; grammar fails before any state/probe/model work | `verify-collaboration-failures.ts`: 40 endpoints in actual directory order, first 32 retired registrations restored, 8 live found by API and CLI; absent/existing state hashes, socket sentinel and offline model-call log |
| Every begun failed headless peer has bounded outcome/error provenance; initial human result survives; later peers never drain | `verify-collaboration-failures.ts`: throwing offline model in text/json/stream-json, exact request counts, final peer outcome/error and stream event, unstarted peer excluded, successful single-continuation controls |

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

Final TUI turn failure closes the local endpoint before publishing idle and visibly drops the peer
inbox, regardless of whether the failed turn was human or peer. A normal human prompt cannot reopen
admission; explicit user `on` publishes a new incarnation without changing project-pair grants.
This is outside `runWithStreamResumption`, so the one exact interruption continuation retains its
inbox until its final outcome. Cancellation and successor semantics remain unchanged. Headless also
closes/drops on failure and stops the drain. Begun failed peers gain a bounded structured error and
failure outcome (plus attributed `turn.failed` in stream-json); unstarted peers are not claimed as
processed. A completed human reply survives subsequent peer failure in every output format, while
the run still reports failure and exits 1. No new driver loop or output transaction is introduced.

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

Discovery validates bounded private registration metadata and socket type/ownership/existence during
the existing 256-entry scan, before reserving one of 32 expensive challenge slots. Missing, invalid or
non-socket remnants do not hide later live candidates. Metadata-valid but dead sockets can still cost
a probe; there is no unbounded search or janitor. `omitted` counts scanned registrations not returned,
`uninspected` is its metadata-valid but unchallenged subset, and `scanLimited` states that the further
remainder is unknown. CLI/TUI share pure grammar preflight before policy mutation, registration or
probe; no-argument verbs are strict. Malformed CLI grammar, like other refusals, exits 1; a returned
report (including a send awaiting human confirmation) exits 0. Send text remains literal.

The runtime's discovery excludes its own endpoint before allocating challenge slots, while standalone
CLI discovery has no requesting endpoint and continues to list all authenticated addresses. `omissions`
breaks the scanned-but-not-returned total into self, unusable registration/socket, failed challenge and
probe-limit counts; it never returns private parsing errors or credentials. The original scan/probe caps
and no-cleanup contract are unchanged. Real socket tests pin self exclusion even with 40 endpoints and
reconcile the reason buckets against `omitted`.

`self` is a credential-free runtime endpoint projection, not the global policy's enabled bit. It states
active/address and a bounded inactive reason plus user-only recovery guidance. TUI status shares that
projection so an enabled policy cannot masquerade as a listening session. No automatic reopen or new
control channel is introduced. `localSessions` reuses the existing bounded read-only `readLocalAgents`
reader, projects only other same-project live lease holders, and preserves inventory omissions/limits.
Lease/PID is unauthenticated diagnostic data, never a send target; `not-discovered` does not assert the
reason an endpoint is absent. Older/non-registering processes remain outside the inventory. Tests use
real child processes and lease files, including a living child with a retired endpoint, and verify
own/foreign lease exclusion, global-enabled/local-inactive status, zero inbox work, and unchanged leases.
The canonical project and inventory key are captured before asynchronous reads, so a retargeted project
alias cannot substitute another project's lease holders. If endpoint inspection fails, the runtime
returns an explicit unavailable state and unknown counts (`null`), retaining its self/lease diagnostics
without exposing private exceptions or weakening send authorization. A final self filter fences an
incarnation published during probe waits; the existing send-time self guard remains.

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

Queued lifetime and drop notice. Admission requires `sent` within 60 s (replay window); an admitted
message then stays deliverable until its chain expires, because a busy receiver otherwise dropped
acknowledged work silently after 60 s, and a reply after chain expiry would be refused anyway. An
unref'd per-message sweep at chain expiry drops it and sends the sender one runtime notice on a
fresh read-only chain, outside the model's causal budget (≤ one per admitted id). The notice is a
fixed text grammar (`dropNoticeText` in `protocol.ts`) because the deployed hub validates a strict
envelope schema; the sender intercepts it before admission — never queued, never a model turn —
and shows it only for an id it got `Queued` for from that exact endpoint (bounded `sentTo`, 64);
anything else is `unmatched peer notice`, and `peer_send` refuses notice-shaped text. Revocation,
blocking, retirement and shutdown drops send no notice. Still no processed-delivery receipt: the
reply itself is that.

Automatic resend. A matched notice proves the message was never processed, so — unlike an
ambiguous acknowledgement, which is still never replayed — the sender's runtime resends it itself:
same text, same hop and read-only ceiling, a fresh chain (so the eventual reply is allowed),
outside the model's causal budget, at most `MAX_AUTO_RESENDS` (3) times per original send, each
visible as a notice (`resent k/3 as <id>`). A resend that is refused or ambiguous is reported and
not retried. After the third resend also expires, the recipient's final notice envelope is queued
once as a `deliveryFailure` peer input: the ordinary idle drain and `peerInput` record, with its
own framing ("Local darwin runtime notice", attempts count), and `peer_send` refused for that turn
so the model reports to its user instead of looping. It was chosen over handing each notice to the
model because the expired chain would refuse the model's resend anyway, and a model-driven resend
loop costs a turn per cycle with no bound but the model's judgement.

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
`PeerTransport` seam. The collaboration hub ([hub/README.md](../../hub/README.md), decision
"Collaboration hub — enrollment is the grant") implements that seam as version 2 addresses and
envelopes over an authorized remote transport, with its own node authentication, trust scope,
consent (enrolment), expiry/receipt semantics and abuse limits. Everything in this document still
holds for the local transport, which continues to accept only `transport: "local"`.

## Focused Host correction

Host's independent edge-case acceptance of `eb010f2` found final TUI failure draining queued peer
work, stale registration filenames exhausting discovery before validation, late CLI grammar refusal,
and missing structured peer-failure outcomes. The corrections above are limited to those paths.
`verify-collaboration-failures.ts` is in the fast runner and supports source and compiled execution;
optional `discovery`, `tui`, or `headless` selects one section for diagnosis. Compiled PTY entries run
with Node rather than looking for a second dependency installation under `dist/`.

The first focused run passed discovery/grammar, both real TUI failure controls, interruption recovery
and text headless controls, then stopped on a new test expecting `Error` instead of the SDK-observed
`ModelError`. The assertion was corrected to the actual SDK error class; production error text and
class are not rewritten. Focused headless/discovery sections, the existing collaboration transport
and driver suites, and `pnpm typecheck` then passed. With source settled, the complete `pnpm test`
(including all new regression sections), free `verify-tui.ts completion`, and `git diff --check`
passed together on 2026-09-26 (worker task `bg-957506fd-a546-416c-a028-1c21006da3a5`).
Post-commit `pnpm build` and compiled collaboration/regression suites remain the final worker step;
the worker report records their actual outcome, not this pre-build source record.
Host retains independent acceptance and the research/log state.

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
