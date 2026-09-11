# AgentCore Memory requirement-to-test checklist

The checklist was derived before implementation; this table records its verification locations.

The sections below are historical SDK-migration results. The later upload-v2 redesign
supersedes their sparse/memory-result exclusion and 32000-byte upload-input contract;
non-upload request and preference policies are unchanged. Its current requirement map
and measured results are in [upload projection verification](agentcore-upload-projection-verification.md).

## Final Host SDK migration acceptance (7b10466, 2026-09-11)

Independent diff review and `pnpm typecheck` passed. One uninterrupted Host `pnpm test`
completed with exit 0, 6,643 PASS lines and zero FAIL, including 253 AgentCore checks.
Free real-pty completion passed 72 checks; Host `pnpm build` passed and refreshed dist.
Logs: `/tmp/darwin-agentcore-sdk-host-{typecheck,full-test,completion,build}.log`.

Built Darwin preference, episode and reflection queries against the existing AWS resource
all succeeded with empty results using the current instance role. This is read-connectivity
proof only: no events were uploaded, no records deleted, no resource imported/redeployed,
and no extraction, nonempty response or write-IAM behavior is claimed. Host removed only
legacy `cliPath` from private config, preserving resource/strategy IDs, requested actor,
automatic project isolation, preferences enabled and manual uploads. File mode remains 0600.
Earlier worker-only and failed-run results below retain their original scope.

## Host live-read compatibility correction after 262cb91

Host observed a successful raw SDK read-only RetrieveMemoryRecords response with
`memoryRecordSummaries: []` and a top-level string `searchType`. SDK 3.1127.0 drops that
unmodeled envelope field, so Darwin's raw-versus-decoded comparison rejected the response.
This is evidence of an empty live retrieval only, not extraction or nonempty live-record
validation. No resource/account identifiers or record content were copied into this fixture.

The compatibility exception is exact: only RetrieveMemoryRecords, only top-level
`searchType`, nonempty string capped by `MAX_SEARCH_TYPE_CHARS = 64` (UTF-16 code units),
without control/format/surrogate/line-separator characters. Omit this hint before comparing
raw records with SDK-decoded records. It never becomes record data or policy; other unknown
fields, nested content/metadata, scope, Date handling, bounded errors and all other operations
remain unchanged. No SDK update, credential-chain, configuration or manual-policy changes.

Verification:
- The new default loopback retrieval envelope reproduced bounded-validation failure before
  the fix: `/tmp/darwin-agentcore-search-type-before.log` (exit 1).
- `pnpm tsx spike/verify-agentcore-memory.ts`: **253 passed, 0 failed**, isolated HOME and
  synthetic signed loopback HTTP only. Empty/nonempty records, retained metadata named
  `searchType`, exact length limit, malformed type/oversize/control characters, unrelated
  top-level/nested fields, wrong namespace, and Get/Delete/CreateEvent exclusion covered.
  Existing AssumeRole, timestamp-proof, runtime gate, cancellation and outbox tests pass.
  Log: `/tmp/darwin-agentcore-search-type-regression.log`.
- `pnpm typecheck` and `git diff --check`: passed. Full gate intentionally not run.

Host owns repeat live read-only acceptance and the final full gate. This worker made no
AWS calls, cloud mutations, global configuration edits or iteration-log changes; extraction
remains unverified.


## Host correction after 414ab9b: credential isolation and timestamp re-review

The focused offline reproduction failed the real AssumeRole chain and missing re-review
notice on 414ab9b. Static-profile/container coverage at that revision did not prove role
profiles. The prior full-suite result below remains a result for that revision, not acceptance
of these corrections.

- The official client's configured default-provider factory now builds an independent
  credential chain/HTTP handler. Nested STS never inherits the memory abort/JSON guard;
  the guard still rejects missing or unregistered memory signals. No deep or transitive
  imports, additional dependency, global environment mutation or credential override.
- Nested credential-client configuration excludes environment/shared-config service endpoint
  URLs and sets one attempt, while preserving standard credential-service region selection.
  Credential-source settings (container URIs, metadata disabling, SSO, credential processes)
  retain standard SDK behavior. The owned credential handler is destroyed with the memory client.
- A real `role_arn`/`source_profile` profile signs STS with synthetic source credentials;
  loopback STS XML yields credentials that sign the AgentCore request. Adversarial global,
  service-specific and profile endpoint URLs never become request hosts. STS 503 produces
  one request despite `AWS_MAX_ATTEMPTS=4`. Paused STS requests released after cancel/total
  timeout produce no late AgentCore HTTP. Existing profile/container/IMDS-disable checks remain.
- A real private approval proof containing CLI `dateTimeValue: ...+00:00` is withheld when
  SDK Date normalization produces `...000Z`. The stored proof is byte-identical, never migrated.
  Local approval checking adds bounded status guidance to inspect and confirm the new hash.
  Fresh matching metadata approval survives startup; revoked proofs do not trigger re-review.
  No record schema/hash, outbox, namespace, Get/Delete condition or resource identity changed.

Verification: focused `pnpm tsx spike/verify-agentcore-memory.ts --transport-only`:
**88 passed, 0 failed**; `pnpm typecheck` and whitespace checks passed. **No full suite rerun**
in this correction. Host owns the full
acceptance gate and real read-only retrieval. Logs: `/tmp/darwin-agentcore-host-corrections-before.log`
(reproduced failures), `/tmp/darwin-agentcore-host-corrections-final.log` (final focused result).
No cloud mutation, resource/IAM change, global config edit or iteration-log edit was performed.


## Approved SDK data-plane migration from 16f8a9c

The requirements map was established before transport edits. `verify-agentcore-memory.ts`
retains the meaningful policy coverage of the prior 173-check baseline. Obsolete AWS CLI
skeleton/env-filter/stdin/paramfile assertions are replaced, not silently counted as policy
coverage. The stopped seven-file paramfile repair was never accepted: Linux Node pipe sockets
failed AWS CLI `file:///dev/stdin` reopening (ENXIO/252), and the old fixture missed that failure.
This migration makes no retroactive passing claim for that repair.

| Observable requirement | Local verification location/behavior |
|---|---|
| Actual public AWS Commands, one pinned direct dependency | `verifyTransport` plus policy capture: real SDK serializers/signing and loopback server, never response-only client mocks; package/lock pin 3.1127.0 |
| Namespace variables, stable token, roles and timestamp | Existing manual send/retry captures now check actual SDK HTTP: projectid, USER/TOOL/OTHER, byte-identical retry bodies, ISO outbox Date serialized as epoch seconds |
| 32000-byte input, 256 KiB success/8 KiB error before SDK parsing | Exact multibyte boundary, oversize no HTTP; streamed oversized success/error; invalid JSON; real TLS connection timeout and body hang |
| Finite remote structure and no metadata laundering | Date/metadata normalization, unknown top-level/record/content/envelope fields refused, scalar coercion refused and unchanged wrong-type data rejected by existing policy; excessive depth/count rejected before SDK decoding; original malicious scope/XML/preference tests retained |
| Total deadline and pre/postcredential cancellation | Pre-abort, immediate cancel, delayed credentials with signal/Agent/deadline/destroy; promise returns before provider release and released provider never reaches handler |
| One attempt, no raw errors, isolated cancel/destroy | 503 count exactly one, fixed safe HTTP-status error; concurrent two-Agent requests; cancel leaves next call usable, destroy latches/forwards |
| Official credentials, configured region, endpoint exclusion | Environment signing; fresh CLI profile/shared-config and container token/token-file retrieval on loopback; IMDS disabled no-credential failure; endpoint env/shared-config ignored without mutation |
| No runtime executable/files, compatible legacy config | Transport import scan; missing legacy executable ignored with bounded notice; malformed legacy values/unknown keys refused; status and standalone CLI surface deprecation |
| Actual permission gate before network, parent-only tools | Original runtime default/plan/deny/yolo/allow and child-catalogue cases now count signed HTTP requests |
| Manual immutable outbox/proof/receipts, privacy | Original recorder, ordered retry/restart, real failed pnpm command, image/bang/custom/assistant/memory exclusion, preview proof, discard/cleanup/capacity/crash cases unchanged |
| Explicit preference confirmation, revocation, policy escape | Original compact/multiline object and extraction-array cases, cross-project proof checks, inspection race, once-only startup, literal dollar/XML escape and malformed prompt refusal |
| Cancellation during disk windows/send/compact/shutdown | Original deterministic real I/O observers before/after publication and cached preparation; no later approval/network/model call; received acknowledgement persists |
| Standalone management remains read-only | Original real CLI nonzero failure/cancel/invalid mutation and model-bash broad allow cases; no proof writes or implicit upload |
| Resource/actor/namespaces retained, infrastructure deferred | Config/scope hash paths unchanged; no global edits, resource IDs in examples or service calls. CLI schema/import limitations documented, no infra code |

### SDK migration verification (2026-09-11)

- `pnpm typecheck`: exit 0; `git diff --check`: clean; AGENTS 32,753 bytes (cap 32,768).
- Focused `--transport-only`: **75 passed, 0 failed** (`/tmp/darwin-agentcore-sdk-transport-accepted.log`).
- Free `verify-tui.ts completion`: **72 passed, 0 failed** (`/tmp/darwin-agentcore-sdk-completion.log`).
- One full `pnpm test` after source stabilization: **115 suites, exit 0**, including **217 AgentCore checks, 0 failed** (`/tmp/darwin-agentcore-sdk-full-test.log`). The runner gives every suite a private HOME and disables remote model-price fetching.
- Earlier local failures were corrected, not counted as passes: the new HTTP fixture initially set a header after `writeHead`; a later numeric-content negative case incorrectly expected transport rejection rather than the unchanged record-policy rejection. Final coverage exercises both boundaries.
- pnpm installed the exact approved package through normal supply-chain checks. Its ordinary transitive resolution consolidated Smithy dependencies and updated the credential-provider peer resolution; no second direct dependency or policy bypass was added.

Historical Host results in later sections describe their named revisions only. Host owns
live read-only acceptance, global `cliPath` removal and the iteration log; synthetic upload
is not authorized. No service request, resource change, IAM change or global config edit
was performed. Commit/build completion is reported by the implementation worker.

## Narrow final Host corrections after d9b2b73

Host's independent `pnpm typecheck` and full `pnpm test` at d9b2b73 passed (exit 0,
`/tmp/darwin-agentcore-host-test.log`). This pass does not rerun that inventory.

- AWS's documented consolidated `ExistingMemory` / `updated_memory` object is accepted,
  with optional language; extraction arrays remain supported. Compact/multiline bytes and
  hashes survive inspect/confirm/startup, corrected hashes invalidate old approval, malformed
  required fields still fail closed. Generated context remains data, never quote evidence.
- Per-command abort signals span filesystem awaits, atomic publication, capability preflight
  and later CLI launches. Deterministic scheduling seams pause real state reads/writes (not
  fabricated results): cancel before approval/attempt publication, after reservation and local
  revocation, and before acknowledgement persistence. No new AWS mutation/approval follows
  cancellation; already-issued effects and acknowledgements remain recorded. Cloud close
  tracks management and drains up to two seconds, reports a timeout, and bars late mutation.
- Runtime send/compact check the captured cancellation generation after local preparation
  and before invocation. Paused local proof reads after completed startup yield zero model
  calls on cancel, and the next turn succeeds without another cloud retrieval. Actual runtime
  shutdown while idle management awaits publication is covered too.

Focused verification: AgentCore **173**, clear-session **44**, rewind **39**, compact
**84**, lifecycle-hooks **20** passed, each with zero failures; `pnpm typecheck` and
`git diff --check` passed. Logs: `/tmp/agentcore-narrow-tests.log` and
`/tmp/agentcore-narrow-verify-*.log`. No live AWS mutation, new dependency, full-suite rerun,
or Host iteration-log change.


## Initial implementation verification (c36e90e, before Host corrections)

These results describe the original pass, not acceptance of the Host review findings below.

- `pnpm typecheck`: passed after correcting the durable assistant projection to `contentBlockEvent` and existing type contracts.
- Focused `verify-agentcore-memory.ts`: 78 passed, 0 failed.
- `verify-tui.ts completion`: 72 passed, 0 failed, including disabled cloud-command dispatch.
- One `pnpm test` invocation: stopped at config (three missing table/fixture coverage assertions). Added the root key to both field tables and the all-keys fixture; the corrected config suite passed. Continued the unchanged suite inventory from the interruption through its final suite with private HOME and network-disabled price fetching; all remaining suites passed. Earlier green suites were not repeated. This is full inventory coverage across the initial and continuation runs, not a claim that the single `pnpm test` command exited zero.
- Opt-in live suite: skipped, no disposable resource configured. No live AWS Memory claim.
- `AGENTS.md`: exactly 32768 bytes after condensing only the pertinent memory invariant.


## Host correction regressions

`verify-agentcore-memory.ts` uses real SDK event constructors and the actual runtime recorder;
no handwritten `as never` event fixtures remain. Its Host-regression sections cover:

1. Literal `$&`, dollar-backtick and dollar-apostrophe in approved pretty JSON survive actual runtime confirm, send, forget and edited-record inspection. Prompt replacement failure is enforced.
2. Read-only standalone CLI inspect/preview write no proof; mutable verbs exit nonzero. An actual model bash call under `bash:*` cannot invoke CLI confirm/send/delete. REPL mutation is unavailable too; arbitrary shell remains outside this boundary.
3. Captured CreateEvent USER preference text and TOOL command/result roles validate against CLI 2.36.42's local service shapes. OTHER carries source/outcome, never a task-success claim.
4. Actual runtime executes a failing `pnpm test` in a private fixture project; its durable outbox must retain command order, SDK transport status, failed command outcome and exit 1 through SDK serialization.
5. Runtime image transcription, bang report and expanded custom prompt sentinels never enter assistant upload prose, even with preferences false and no tools. SDK memory-result/paraphrase exclusion remains covered.
6. Hierarchical mixed episode/reflection response is scope-checked first, then filtered with underfill. XML sibling language/summary roots and compact/multiline preference JSON are exercised; malformed and wrong-scope records fail closed.
7. Config accepts 64/rejects 65 characters; synthetic-only credential environment capture verifies required chain flags and endpoint exclusion.
8. A paused real CLI inspection and another controller's forget cannot resurrect approval. Competing no-clobber writers leave one complete state record; a real process killed at staging publishes no partial final JSON. Partial staging cannot count as events or attempts; repeated user cleanup resumes from receipts after body/ack removal.
9. Real CLI subprocess refusals, missing executable and cancellation return nonzero, separate from displayed prose.
10. Actual send/send/compact fetch count is one per runtime; local cross-project revoke needs no network. Actual denied PreCompact makes no CLI request.
11. Explicit discard releases declined ordering, an active lock refuses cleanup, accepted cleanup retains no-repeat receipts, and a 33rd durable turn can persist/send after cleaning 32 accepted bodies.

Correction verification:

- `pnpm typecheck`: passed on the final source.
- `pnpm tsx spike/verify-agentcore-memory.ts`: **133 passed, 0 failed**. An earlier regression run reported 123 passed/3 failed (SIGINT exit-zero from imported SDK bash, actual ToolUseData/transport-success wire handling, temporary attempt counting). All three were corrected and retained as passing tests. Intermediate typecheck errors in newly added test constructors/optional prompt restoration were also corrected.
- Focused compatibility: config **415**, compact **84**, CLI args **43**, npm patch format **52**, runtime image input **5**, status **105**, help **37**; each passed with zero failures. Each process used a private HOME. The initial compatibility command used an ineffective price-fetch environment name; no cloud Memory operation was run, and the final AgentCore suite explicitly disables price fetching with `DARWIN_MODEL_PRICES_FETCH=off`.
- `verify-tui.ts completion`: **72 passed, 0 failed**.
- Opt-in live verification: skipped, no disposable resource/consent. No live service claim.
- `git diff --check`: passed. `AGENTS.md`: **32762 bytes**. No dependency/lockfile changes.

The full already-covered inventory was deliberately not repeated; Host owns its acceptance
rerun and iteration log. The real `pnpm test` failure inside the regression is a synthetic
private-project script exiting 1, not a rerun of Darwin's full inventory.

### Historical pre-SDK requirement map

The following rows describe the earlier CLI implementation, not the current transport. The
SDK replacement map above supersedes only transport rows. No resource was provisioned or
real repository/user content uploaded in those verification passes.

| Requirement | Verification |
|---|---|
| Default-off, no cloud state/network/tools, local memory unchanged | `verify-agentcore-memory.ts` disabled real-runtime cases; existing four memory suites in `pnpm test` |
| Host-only actor/resource/region/strategies, independent project scope | Strict config rejections and cross-actor/project record/outbox tests |
| Correct searchQuery/strategy/namespacePath transport, no fabricated filter | Captured subprocess argv/stdin assertions and installed CLI service model (the later paramfile repair was stopped, not accepted) |
| Parent-only ordinary network gate, plan and deny before CLI | Actual AgentRuntime default/plan/approved/yolo-deny cases; actual child catalogue assertion |
| Bounded safe XML, evidence/action order, confidence semantics | XML attack cases, record scope/metadata rejections, ordered evidence assertions |
| No generated explicitness as preference proof | Startup without approval, confirm-before-inspect refusal, visible hash adoption |
| Cross-project preference reuse, immediate forget, edits invalidate | Separate controllers/projects; changed cloud content; live prompt removal |
| Startup bounded failure/cancel before model, clear/rewind refresh | Actual runtime missing CLI, cancellation with zero model calls, successor/rewind cases |
| New durable turns only, no streaming network, conservative projection | Real TrajectoryRecorder settlement; failed/cancelled/closed turn previews; no unauthorized subprocess |
| Exclude memory output/paraphrases and private tool dumps | Synthetic memory-return and assistant-paraphrase sentinels; error-log omission |
| Preview authorization, exact bytes, truthful event acceptance | Send-without-preview refusal; captured CreateEvent body; acknowledgement wording |
| Restart idempotency, ordering, finite retry | Accepted restart makes no CLI call; earlier-turn refusal; three identical failed request bodies, fourth refused |
| No shell injection; bounded timeout/cancel/output; state safety | Real executable fixture; timeout/abort/large stdout/missing path; symlink refusal |
| CLI prerequisite and custom namespaceVariables | Installed 2.36.42 skeleton capability success and captured service-model payload validation; incompatible fixture still refused |
| TUI/headless discoverability, no added live rows | Existing command/status surfaces; `verify-tui.ts completion`; help/status/CLI suites in full gate |
| English/Chinese README, narrative guide, reference and architecture | `docs/user-guide/agentcore-memory*.md`, links and reference grammar checks |
| Real-service verification only with disposable resource | `verify-agentcore-memory-live.ts` skips by default; explicit synthetic actor/config/consent required |

## Known verification boundary

Historical CLI 2.36.42 skeleton/service-model checks were local schema proof only. Current
SDK serialization/signing/HTTP checks likewise do not prove live IAM, service extraction or
generation latency. No disposable resource or synthetic-upload authorization was provided
for this SDK migration. Host owns real read-only acceptance separately.

Candidate persistence is detached local work. A crash before it completes can omit a turn;
there is no archive repair. Cross-controller inspection/revocation and exclusive state
publication are covered above, but filesystem adversaries racing ancestor replacement and
AWS idempotency retention beyond the documented service contract remain unproven. Interrupted
staging is ignored, not deleted; legacy corrupt final entries and crash-held active locks
need explicit manual repair. The receipt ledger is bounded at 256 and never silently evicted. Host config and the AWS strategy provisioning
remain trusted inputs. A short plain user goal may still be confidential; manual preview is
mandatory and the projection is not a secret detector guarantee.
