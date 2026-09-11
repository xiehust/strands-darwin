# Project-scoped cloud-memory auto verification

Baseline: `e23ba1d`. Sole implementation worker; no live cloud/config/outbox operations.

## Requirement-to-test checklist (before implementation)

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

- Policy: explicit typed registry, max 1024 projects / 1 MiB config; same stable cloud project identity. No resource/actor/model/permission override. Root auto without a matching authorization falls back to manual with guidance.
- Quota: 500 attempts / 104857600 exact wire-body bytes per UTC day by default; positive bounded overrides, max 100000 attempts / 107374182400 bytes. Reservations conservatively count unknown acknowledgements and cancellation, shared across explicit-ID checkouts.
- Storage: 4096 bodies / 512 pending / 32768 outbox entries; 7-day expiry only for auto-accepted bodies. Permanent receipts: 256 hash-prefix partitions × 4096 files, plus unchanged legacy ledger. Full state refuses before removal, never evicts proof.
- Work: publication uses a local-only lock, sender/cleanup the original outbox lock. At most eight candidates/activity, three attempts/token, 250/500ms cancellable retry. No idle daemon or forced shutdown upload; cancellation/clear/shutdown stop owned requests with a two-second drain.
- Legacy cleanup: at most 256 current-binding unaccepted non-v2 entries; locked manifest hash confirmation, all tombstones before any removal, restart-safe committed manifest. Implementation tests operate only on owned synthetic fixtures.

## Verification evidence

- Final production-source gate: `pnpm test` then `pnpm typecheck`, once, both exit 0 (2026-09-11 09:11–09:20 UTC). New auto suite: **99 passed, 0 failed**. Existing upload: **120 passed**; AgentCore: **263 passed**; config: **415 passed**. Setup/doctor and all other fast suites passed in the full gate.
- Relevant free pty: `pnpm tsx spike/verify-tui.ts cloudAuto` **4 passed**; `pnpm tsx spike/verify-tui.ts completion` **74 passed**. No model calls.
- Corrected during focused verification: stale single-model session fields overriding effective project policy, Smithy Uint8Array wire-body accounting, absent-override runtime shape compatibility, persistent permanent-stop state, shared-explicit-project quotas, and local publication independent of sender network lock.
- `git diff --check` clean. `AGENTS.md`: **32758 bytes**, below 32768.
- All network verification used signed loopback with synthetic credentials. No real project config enablement, real user outbox cleanup, external cloud calls/mutations, dependencies, push or history rewrite. Host owns the iteration log.

## Operational limits

No live AWS IAM/extraction claim. No automatic preference adoption or cloud deletion. Explicitly approved arbitrary shell/filesystem access is not a sandbox. Cooperative config writers lock; unrelated external edits observed before publication refuse, but arbitrary noncooperating same-user filesystem races are not a security boundary. Crash-held locks require manual inspection. No daemon or guaranteed shutdown upload; pending work may wait for later ordinary activity. Retention is local auto-accepted bodies only, fixed seven days; daily quotas are configurable but storage remains finite. A capacity refusal can omit a new candidate visibly; existing pending/manual data and token proof are not evicted.
