# AgentCore Memory requirement-to-test checklist

The checklist was derived before implementation; this table records its verification locations.

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

All tests are offline unless explicitly labelled live. No resource was provisioned or real repository/user content uploaded.

| Requirement | Verification |
|---|---|
| Default-off, no cloud state/network/tools, local memory unchanged | `verify-agentcore-memory.ts` disabled real-runtime cases; existing four memory suites in `pnpm test` |
| Host-only actor/resource/region/strategies, independent project scope | Strict config rejections and cross-actor/project record/outbox tests |
| Correct searchQuery/strategy/namespacePath transport, no fabricated filter | Captured real subprocess argv/stdin assertions; installed CLI service model and input skeleton |
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

Installed AWS CLI 2.36.42's CreateEvent input skeleton now includes extractionConfig;
CreateMemory includes namespaceKeys. Captured synthetic USER/TOOL/OTHER payloads are checked
against its installed service model, including namespace value max64. This is local schema
verification, not service extraction, IAM, or generation latency proof. No disposable resource
was provided; no cloud resource or upload was used in the correction pass.

Candidate persistence is detached local work. A crash before it completes can omit a turn;
there is no archive repair. Cross-controller inspection/revocation and exclusive state
publication are covered above, but filesystem adversaries racing ancestor replacement and
AWS idempotency retention beyond the documented service contract remain unproven. Interrupted
staging is ignored, not deleted; legacy corrupt final entries and crash-held active locks
need explicit manual repair. The receipt ledger is bounded at 256 and never silently evicted. Host config and the AWS strategy provisioning
remain trusted inputs. A short plain user goal may still be confidential; manual preview is
mandatory and the projection is not a secret detector guarantee.
