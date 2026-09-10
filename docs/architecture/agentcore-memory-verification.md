# AgentCore Memory requirement-to-test checklist

The checklist was derived before implementation; this table records its verification locations.

## Implementation verification results

- `pnpm typecheck`: passed after correcting the durable assistant projection to `contentBlockEvent` and existing type contracts.
- Focused `verify-agentcore-memory.ts`: 78 passed, 0 failed.
- `verify-tui.ts completion`: 72 passed, 0 failed, including disabled cloud-command dispatch.
- One `pnpm test` invocation: stopped at config (three missing table/fixture coverage assertions). Added the root key to both field tables and the all-keys fixture; the corrected config suite passed. Continued the unchanged suite inventory from the interruption through its final suite with private HOME and network-disabled price fetching; all remaining suites passed. Earlier green suites were not repeated. This is full inventory coverage across the initial and continuation runs, not a claim that the single `pnpm test` command exited zero.
- Opt-in live suite: skipped, no disposable resource configured. No live AWS Memory claim.
- `AGENTS.md`: exactly 32768 bytes after condensing only the pertinent memory invariant.

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
| CLI prerequisite and custom namespaceVariables | Installed skeleton capability refusal; synthetic compatible fixture captures lowercase projectid |
| TUI/headless discoverability, no added live rows | Existing command/status surfaces; `verify-tui.ts completion`; help/status/CLI suites in full gate |
| English/Chinese README, narrative guide, reference and architecture | `docs/user-guide/agentcore-memory*.md`, links and reference grammar checks |
| Real-service verification only with disposable resource | `verify-agentcore-memory-live.ts` skips by default; explicit synthetic actor/config/consent required |

## Known verification boundary

AWS CLI 2.36.21's CreateEvent input skeleton lacks extractionConfig; output skeleton generation
fails its own record-ID/union placeholders. Installed service-2.json confirms retrieval/get
shapes; current AWS docs confirm namespaceVariables. Offline subprocess fixtures exercise the
newer schema contract but do not prove service extraction, endpoint namespace semantics, IAM,
or generation latency. No disposable resource was provided, so live verification is not claimed.

Candidate persistence is detached local work. A crash before it completes can omit a turn;
there is no archive repair. Filesystem adversaries racing ancestor replacement, multiple
independent senders, and AWS idempotency retention beyond the documented service contract
are not proven by the single-process fixture. Host config and the AWS strategy provisioning
remain trusted inputs. A short plain user goal may still be confidential; manual preview is
mandatory and the projection is not a secret detector guarantee.
