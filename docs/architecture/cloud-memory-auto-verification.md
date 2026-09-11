# Project-scoped cloud-memory auto verification

Original implementation baseline: `e23ba1d`; consent/launch correction: `1f7966b`.
Historical gates below apply only to those source sets, not the final source unless stated.

## Final independent Host acceptance — 2026-09-11

Accepted `fbd46cc`, `1f7966b`, `adf4252`, `d01ec71` and test-only `0f91ea9` together.
Host independently ran `pnpm typecheck` and uninterrupted `pnpm test` on final production
source: **7,610 PASS lines, zero FAIL**. This includes auto99, acceptance122, integrity303,
lifecycle189, storage121, upload120 and AgentCore263. Managed task
`bg-59cef082-e5fb-4329-900e-73b0d5819200` subsequently failed the extra free pty warning
assertion described below; that failure is not hidden by the passing fast gate.

After the test-only wrap correction, Host verified `src/` bytes unchanged, then independently
ran `tui cloudAuto` **4/0**, `tui completion` **74/0**, and `pnpm build`, all exit 0 in
`bg-26039afe-170c-4390-a9c2-242f5d9fdc8d`. Dist and built-in skills are refreshed. Diff
checks are clean; AGENTS is 32,758 bytes. No production full-gate rerun was needed for the
assertion-only change. Final reviewer reproduced the raced held-sidecar/manual-acceptance
case; its signed-loopback regression is now part of storage121.

No real project auto enablement, legacy deletion or live Memory upload was performed.
Legacy cleanup and mode changes still require direct user TUI commands. Batch 128 in
`docs/iteration-log.md` records milestones, pause/resume, each worker task/spend, the earlier
Host typo that accidentally started then stopped model-calling TUI checks, and all relevant
failure history. No live AWS IAM/extraction or guaranteed shutdown delivery claim.

## Post-d01ec71 free-TUI assertion correction

Host reported uninterrupted `pnpm typecheck` and `pnpm test` passing on `d01ec71`
(**7610 PASS, 0 FAIL**). Its subsequent free `cloudAuto` check failed 3/1; the chain
stopped before completion/build. A diagnostic run captured the actual 120-column PTY:
`Content may include \r\nsecrets.` followed by `Auto-accepted local bodies retained 7 days;`
and the ready prompt. Both warnings were present; the exact substring assertion rejected
the rendered line wrap after the long scope identities, not missing warning text.
Capture task: `bg-da8309fa-95e3-4593-8e95-92d41e6ab4f3`.

Only the test changes: wait for the anchored notice end, normalize rendered whitespace,
and require the complete secrets and seven-day retention clauses. Temporary diagnostics
were removed. No production wording or behavior changes, and no full gate rerun.
Focused checks **2026-09-11 11:09:19–11:09:47 UTC**: free `cloudAuto` **4/0**, free
`completion` **74/0**, then typecheck **exit 0**; task
`bg-07222ded-f08d-4e62-9eca-a155ef64a623` records
`FOCUSED cloudAuto=0 completion=0 typecheck=0`. No model/cloud calls or real config/outbox
mutations; the PTY suites use their owned temporary HOME. Host's iteration log is untouched.

## Post-adf4252 held-read acceptance race

Host review reproduced native manual acceptance completing while an automatic pass was
paused after reading a held sidecar. The stale verdict blocked a later same-session token
for that earned pass, although unrelated sessions progressed. `drainAuto` now revalidates
terminal receipts/accepted sidecars and decides whether to block under the existing outbox
sender lock. The initial sidecar read stays outside that lock, so manual send can complete
there. No extra pass, timer, state deletion, quota change or manual-body rewrite is added.

The signed-loopback storage regression pauses that exact read, completes a peer controller's
native preview/hash/send, then releases the pass. It verifies same-session and unrelated
progress, exactly eight automatic slots, an untouched overflow candidate (no self-reschedule),
no duplicate request, zero manual quota charge, and unchanged body/proof/held-sidecar/ACK.
The initial regression reproduced starvation; its additional assumption that manual send
writes an auto receipt was corrected to inspect the durable accepted sidecar instead.

Focused checks, **2026-09-11 10:55:54–10:57:00 UTC**: storage **121 passed, 0 failed**,
then `pnpm typecheck` **exit 0** (`FOCUSED storage=0 typecheck=0`, task
`bg-0c2c5ea6-4cb1-408c-a579-861e5899231a`). No full gate was rerun for this narrow fix:
the green full gate below belongs to `adf4252`; Host owns the next complete acceptance gate.
The review probe was read only; all execution used repository tests/private fixtures.
No real config/outbox/cloud mutation, dependency change or Host iteration-log edit occurred.

## A–G correction checklist and evidence at adf4252

Preserve `1f7966b`'s canonical local consent binding and config-lock launch linearization;
manual stored body/hash/preview bytes remain unchanged. Initial isolated suites passed:
`verify-cloud-memory-integrity.ts` **303**, lifecycle **140**, storage **114**.
Review then added peer session-stop launch coordination, originating-signal ownership,
cancelled-pass/fresh-activity handoff and persistent suspension notices. The extended lifecycle
suite exposed an epoch-wide stop on a session-only refusal (182 passed/1 failed); the sender
now holds only that origin. Adapted auto99, acceptance122 and upload120 passed. Initial
typecheck found two fixture type errors (SDK ToolUseData versus block; durable union annotation),
corrected without changing runtime behavior. Final focused/full-gate evidence is recorded below.

| Finding | Required contract | Current regression evidence | Status |
| --- | --- | --- | --- |
| A | Semantic flags and 512-identity obligation ledger outlive both 64-body/96-summary windows; safely matched final result can resolve once after both evictions, before seal. Detection is bounded, not complete source discovery; media/truncation/unknown-length omissions alone do not veto. | Integrity suite: descriptors without getter evaluation, both evictions, delayed/duplicate completions, ambiguity/ledger overflow, late origins and no-veto controls; payload/preview facts and bounds agree. | Passed in final full gate (303) |
| B | Durable settlement and natural driver-completion seal join in either order. Final SDK event alone, abandonment or cancellation stays manual; original `endTurn`, errors and stored evidence remain truthful. | Lifecycle suite: actual scripted runtime, real fileEditor/trajectory writes, final-yield abandonment, both append/seal orders and cancellation windows, exact provider-error identity; held bodies remain unchanged on later activity/restart. | Passed (189, shared with C) |
| C | After the background-delegation guard, suspend predecessor synchronously before first await; durable origin-session `*.session-stop.json` bars successor/restart stale drains. Stale checkpoint/construction failure stays conservatively manual with cloud-status notice; tools remain usable, future successor sessions inherit project auto, received ACKs survive. | Lifecycle suite: paused successor factories, success/failure/stale checkpoint, restarted origin, real SDK background-delegation guard and delayed ACK publication, signed loopback requests. | Passed (189, shared with B) |
| D | Skip accepted ACKs/receipts and tombstones before held/order/slot accounting; manual ACKs consume none of the eight request slots. | Storage suite: accepted/held/tombstone fixtures, same- and other-session progress, exact request/quota accounting. | Passed in final full gate (114, shared with E–G) |
| E | Body/pending-capacity refusal still earns finite authorized uncancelled expiry/drain; omitted candidate never retries/backfills. Caps stay 4096/512; only auto-accepted bodies older than seven days expire, manual protected; no daemon. | Storage suite: actual runtime activity against seeded 4096-body/512-pending caps, receipt preservation, later ordinary activity, UTC budget rollover and cancellation/manual-stop controls. | Passed in final full gate (114, shared with D/F/G) |
| F | `pending [accepted] [after <64hex>]`: default actionable includes held/cleanup, accepted separate; both counts, 64/page and next cursor. Stable token order, not snapshot; new earlier tokens require restart. Same CLI grammar, no network/write/proof. | Storage suite: more than 64 rows in both views, accepted prefix cannot hide pending, stopped origin/cleanup discoverability, exported CLI reader parity and malformed grammar refusals, byte-zero mutation/network. | Passed in final full gate (114, shared with D/E/G) |
| G | Fresh reconsent resets HTTP 403 epoch stop, not held ordering barrier; explicitly discard first held token before later same-session drain. | Storage suite: signed 403, peer fresh epoch discovered by original controller, barrier before discard, later/new-epoch and restart progress, old stop bytes unchanged. | Passed in final full gate (114, shared with D–F) |

Focused verification, 2026-09-11 10:19:24–10:20:54 UTC: lifecycle **183**, storage
**114**, integrity **303**, acceptance **122**, followed by `pnpm typecheck`; all passed
(exit 0). The earlier affected run also passed auto **99** and upload compatibility **120**.
The final source set includes restored-session stop-state fail-closed handling. Full gate
begun at 10:21:25 UTC was deliberately stopped at 10:22:23: final review found the earlier
reservation-stage session-stop wording still triggered an epoch-wide stop. The message now
matches the final-launch path; the peer regression covers both timings. Corrected lifecycle
passed **189**, then typecheck passed at 10:22:59. The 10:23:04 restart was interrupted by
user cancellation; its log has no final gate result and is not counted as passing.

Resumed full gate, 10:32:50–10:40:01 UTC: **test=1, typecheck=0**. The existing
`verify-agentcore-memory.ts` fixture parsed the new `pending` count header as a token.
Token-row parsing restored 262 checks; a remaining capacity assertion still counted header
and guidance lines. Filtering event rows preserved the same assertions without any further
production change. Corrected focused suite, 10:41:31–10:42:06 UTC: **263 passed, 0 failed**,
exit 0.

**Final source-settled full gate, 2026-09-11 10:42:06–10:52:53 UTC: `pnpm test` exit 0,
then `pnpm typecheck` exit 0.** Task `bg-a565620b-6607-446f-9709-a24f37be930b` records
`FINAL_GATE test=0 typecheck=0`. All registered fast suites completed, including AgentCore
**263**, upload **120**, auto **99**, acceptance **122**, integrity **303**, lifecycle
**189**, storage **114**, each with zero failures. The tracked `src/`/`spike/` diff SHA256
was `48ca800bd8bd743a766ee1902ce46f7f0f92fd5d61f5fca69341ec4a2202b688` before and after;
all three new-suite SHA256 values also matched. No source changes followed, only this evidence
record. `git diff --check` passed; `AGENTS.md` remains 32758 bytes. Commit and required
post-commit build results are reported in the worker's completion report.

Additional lifecycle coverage pauses a peer after its pre-coordination checks, commits the
origin stop under the shared launch lock, then proves the peer cannot launch and future
successor events still send. A late validated ACK cannot swallow a new turn's drain trigger;
a cancelled delayed settlement cannot borrow an unfinished next turn's fresh signal or perform
retention. Suspension stays explicit after local/peer reconsent and restored-session refresh.
New CLI pagination proof calls the exported CLI reader in its private fixture. No extra green
PTY suites are rerun merely for reconfirmation (`cloudAuto` and `completion` are the verified
parser names). No live IAM/extraction verification. Required full suites retain their existing
isolated subprocess fixtures. AGENTS and the Host-owned iteration log are untouched; no
setup-skill change is needed.

## Historical requirement-to-test checklist (original implementation)

| ID | Requirement | Planned proof | Result |
| --- | --- | --- | --- |
| P1 | Strict typed project overrides, identity/precedence/isolation, both model forms, switches/successors | `verify-cloud-memory-auto`: registry, file forms, model writers, actual runtime clear/rewind; `verify-config` 415 checks | passed, including actual live model switch |
| P2 | Atomic private locked config writes; fresh read, cancellation, symlink/no-clobber, unrelated preservation | owned filesystem overlap/two-process lock, noncooperating edit, cancellation and mode; existing config tests | passed |
| U1 | User-only idle auto/manual; immediate persistent policy, notice, exact grammar; CLI read-only | free `tui cloudAuto` 4 checks; completion 74; spawned CLI mutation refusals | passed |
| E1 | New durable v2 only; separate provenance/hash/epoch, no previews/backfill; existing manual unchanged | actual runtime signed loopback; pre-enable open turn, manual pending, old epochs; upload suite 120, memory suite 263 | passed |
| E2 | Closed failed tasks allowed; cancel/incomplete/collection faults held; ack-only excluded; genuine late results allowed | failed result/endTurn, missing/ack, observer/unmatched/accessor cases, original late identity; existing actual background forwarding suite | passed |
| S1 | Shared sender, max 3 stable attempts, exact wire bytes, UTC quotas, race/restart reservations | signed 429/503/200, three-503 cap, multibyte exact bytes, boundary/rollover/corruption, two-process quota and shared explicit-ID checkouts | passed |
| S2 | Revocation/scope checks at launch; bounded retry/cancel/ack/lifecycle; order without cross-session starvation | delayed reservation revoke/cancel/ack, shutdown, retry cancel, unrelated session progress, permanent stop restart, publication while sender locked | passed |
| R1 | Auto-only accepted-body 7-day expiry; durable bounded receipts; finite pending/accepted caps | owned aged ack expiry with receipt retained, manual preservation, 260 receipts, full 4096-file partition, 512 pending refusal | passed |
| L1 | User-only legacy batch preview/hash, lock/manifest/TOCTOU/recovery; preserve foreign/v2/accepted | changed manifest zero-removal; partial tombstone cancellation then fresh-controller completion; v2/manual accepted preserved; current binding validated | passed |
| D1 | EN/zh guides/reference/config, setup skill, architecture/index; AGENTS <32768 bytes | bilingual schema tables (`verify-config`), setup and doctor suites; AGENTS 32758 bytes | passed |
| G1 | Focused checks, then final production-source full test/typecheck once; commit then build | final gate 2026-09-11 09:11–09:20 UTC: test=0, typecheck=0; commit/build reported by worker | gate passed |

## Design and bounds

- Policy: explicit typed registry, max 1024 projects / 1 MiB config; canonical working-tree SHA256 override/consent key, separate from the unchanged cloud namespace/quota identity. Authorization v2 additionally binds the local key; v1 is held pending user reconfirmation, never migrated. No resource/actor/model/permission override. Root auto without a matching authorization falls back to manual with guidance.
- Quota: 500 attempts / 104857600 exact wire-body bytes per UTC day by default; positive bounded overrides, max 100000 attempts / 107374182400 bytes. Reservations conservatively count unknown acknowledgements and cancellation, shared across explicit-ID checkouts.
- Integrity/lifecycle: semantic flags and a 512-key obligation ledger are independent of 64 action bodies/96 summaries. Detection is bounded; presentation loss is not itself a veto. An eight-turn join requires natural driver completion plus durable settlement, in either order. Predecessor suspension precedes the first transition await, after the background guard; durable per-origin-session stop markers keep old sessions manual across restart without revoking successor policy. Received ACKs remain truthful.
- Storage: 4096 bodies / 512 pending / 32768 outbox entries; only auto-accepted bodies older than seven days expire. Permanent receipts: 256 hash-prefix partitions × 4096 files, plus unchanged legacy ledger. Full state refuses new publication visibly, never evicts proof/manual data. That uncancelled authorized activity still earns finite expiry/drain, not a retry/backfill of the omitted candidate.
- Work: publication uses a local-only lock, sender/cleanup the original outbox lock. At most eight candidates/pass, with publication-triggered coalesced followups and same-process session serialization; terminal ACKs/receipts/tombstones are skipped before held/order/slots, including raced manual ACKs. No held/budget/order self-retry. Three attempts/token, 250/500ms cancellable retry. No idle daemon or forced shutdown upload; cancellation/clear/shutdown stop owned requests with a two-second drain.
- Pending reader: `pending [accepted] [after <64hex>]`, same TUI/CLI grammar; actionable including held/cleanup by default, accepted separate, both counts and ≤64 rows/page with next cursor. No network/write/proof. Stable token order is not a snapshot; restart for newly added earlier tokens.
- Permanent-stop recovery: fresh consent resets the old HTTP 403 epoch latch, not the held first entry. Explicit discard resolves that ordering barrier before later same-session auto drain; old stop bytes remain unchanged.
- Legacy cleanup: at most 256 current-binding unaccepted non-v2 entries; locked manifest hash confirmation, all tombstones before any removal, restart-safe committed manifest. Implementation tests operate only on owned synthetic fixtures.

## Historical Host acceptance corrections after fbd46cc

The original gate below passed but did not establish current-project isolation or native
revocation linearization. Host review found four blockers; the new isolated
`verify-cloud-memory-acceptance.ts` supplements (not replaces) the original suite.

| Blocker | Correction and regression evidence |
| --- | --- |
| Shared cloud ID widened consent | Native auto A/manual A versus unrelated B with shared cloud ID; symlink alias and real git worktree; v1/copy rejection; visible local key/cloud namespace; exact manual bytes unchanged |
| Await after fresh authority read | All stop/quota/attempt/credential waits precede a shared config-writer lock. Inside: fresh read, validate, synchronous request-handler start; boxed response awaited only after lock release. Twenty pause/mutation cases plus a cross-process writer at handler invocation, manual during pending response and retained acknowledgement |
| Manual/off controller missed new overrides | Local refresh on new turn/model/clear/rewind/status, no backfill; actual offline runtimes from both modes, malformed config ordinary turn, fully disabled controller-free |
| Publication kick dropped during active snapshot | Coalesced followup passes and same-process outbox ownership; held-response same/other-session publication, revoke/cancel/rotate/budget/retry matrices, three-attempt bound and old-epoch exclusion |

Focused correction checks (2026-09-11 09:35–09:36 UTC): acceptance **122 passed**,
upload **120 passed**, AgentCore **263 passed**, then `pnpm typecheck` exit 0.
The new fixture initially emitted an invalid acknowledgement because Smithy places memoryId
in the path, not the body; correcting that fixture resolved seven failures without weakening
production acknowledgement validation. Source-settled full gate (2026-09-11
09:36:58–09:45:30 UTC): `pnpm test` exit 0, then `pnpm typecheck` exit 0.
No production-source changes followed that gate; only this evidence record was updated.
Host owns the iteration log; no darwin worker or live TUI suite was launched. The explicitly
required focused/full suites retain their owned offline CLI/subprocess fixtures. Host's old
green auto99/cloudAuto4/completion74 were not separately rerun merely for confirmation.

## Verification evidence (original implementation)

- Final production-source gate: `pnpm test` then `pnpm typecheck`, once, both exit 0 (2026-09-11 09:11–09:20 UTC). New auto suite: **99 passed, 0 failed**. Existing upload: **120 passed**; AgentCore: **263 passed**; config: **415 passed**. Setup/doctor and all other fast suites passed in the full gate.
- Relevant free pty: `pnpm tsx spike/verify-tui.ts cloudAuto` **4 passed**; `pnpm tsx spike/verify-tui.ts completion` **74 passed**. No model calls.
- Corrected during focused verification: stale single-model session fields overriding effective project policy, Smithy Uint8Array wire-body accounting, absent-override runtime shape compatibility, persistent permanent-stop state, shared-explicit-project quotas, and local publication independent of sender network lock.
- `git diff --check` clean. `AGENTS.md`: **32758 bytes**, below 32768.
- All network verification used signed loopback with synthetic credentials. No real project config enablement, real user outbox cleanup, external cloud calls/mutations, dependencies, push or history rewrite. Host owns the iteration log.

## Operational limits

No live AWS IAM/extraction claim. No automatic preference adoption or cloud deletion. Explicitly approved arbitrary shell/filesystem access is not a sandbox. Cooperative config writers lock; unrelated external edits observed before publication refuse, but arbitrary noncooperating same-user filesystem races are not a security boundary. Crash-held locks require manual inspection. No daemon or guaranteed shutdown upload; pending work may wait for later ordinary activity. Retention is local auto-accepted bodies only, fixed seven days; daily quotas are configurable but storage remains finite. A capacity refusal can omit a new candidate visibly; existing pending/manual data and token proof are not evicted.
