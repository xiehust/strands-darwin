# AgentCore upload projection redesign — acceptance checklist

Only isolated HOME fixtures, public SDK events/runtime and signed loopback HTTP are used. No private outbox inspection, cloud calls, configuration migration or archive backfill.

## Requirement-to-test checklist (before implementation)

| ID | Observable contract | Planned verification |
| --- | --- | --- |
| U1 | Literal multiline/slash/markup/secret-like goals and arbitrary tools/MCP arguments/text/JSON results; one identity-bound input/result per TOOL | Projection fixtures and actual runtime |
| U2 | No assistant prose/reasoning or binary/image bytes; no child/history/path/offload hydration; separate publicProse unchanged | SDK content fixtures, runtime image fixture, existing preference/local-memory suites |
| U3 | Original >8000-codepoint tail survives >1MiB trajectory, with offload on and off; immutable events/trajectory and error identity | Actual scripted runtime and trajectory/offload suites |
| U4 | 8KiB action, 256KiB serialized request, <=100 items and <=100KB/message; Unicode/control/escaping exact; head/tail ranges and source limits explicit | Byte/range assertions, huge/deep/wide/array fixtures |
| U5 | Bounded live memory/traversal/pending turns/actions; reserve goal/closing facts; favor late, failed and recovery actions, chronological pairs; categorized omissions | Capacity/priority and lifecycle fixtures |
| U6 | Cancel/missing results explicit; no task-success inference or metadata-only empty entries; quality facts in pending/preview | Cancellation, goal-free and outcome fixtures |
| U7 | Disabled performs no collection; nondurable/saturated/failure/early-return/close clean up without cross-turn mixing or network | Actual runtime plus settlement/queue fixtures |
| U8 | >64KiB event read-only CLI roundtrip and exact manual preview/hash/send; coherent request/state caps without widening proofs/receipts/non-upload | Real filesystem, CLI and signed loopback |
| U9 | Legacy immutable body/hash/token/proofs readable unchanged; OTHER-only refusal; order/reservations/retries/cancel/idempotency unchanged | Existing and expanded AgentCore suite |
| U10 | English/Chinese READMEs, narrative/reference/configuration and architecture agree; AGENTS <32768 bytes; full gates then commit/build | Targeted documentation scan, pnpm test, pnpm typecheck, pnpm build |

## Second Host acceptance corrections after 1e77608

The preceding acceptance did not cover A–F. This pass keeps the same repository-only
scope and setup-skill policy; no immutable entry is migrated, no cloud request or
new wake/upload channel is introduced.

| Gap | Correction and regression proof |
| --- | --- |
| A: exhausted surrogate ranges | Shared linear codepoint clipping; empty ranges stay empty, only genuine high/low pairs move boundaries. Zero-budget original and shrink fixtures include lone surrogates, exact offsets and bounded elapsed work. |
| B: generic media filtering | `type: image/audio` business JSON remains exact; actual SDK media source and MCP data+mimeType shapes plus binary views remain excluded. |
| C: evicted pending status | Ledger keeps bounded summary correlation; status, exitCode and failure update, failed result text can recover a body with explicit missing input. Both completion orders, duplicate fallback and summary eviction counters are tested; summaries include invocationScope. |
| D: background final results | Ack is separate, never final success. Original hook-time completion updates an open origin; after seal, bounded original evidence is consumed once by existing ordinary parent forwarding, with original turn/ordinal/invocation reference. Actual runtime tests cover wait-in-turn, between turns, during next turn, cancel/shutdown, duplicate hook/forward/result, transformed downstream report, no idle candidate, no synthetic USER and immutable old body. |
| E: detached queue losses | Ten immediate settlements retain eight jobs and count exactly two omitted turns, separate from the collector-turn bound. |
| F: authorization/lifecycle | Previously sendable v1 USER/TOOL fixture starts with exact old body/hash/token and existing preview proof; read-only preview and signed-loopback send preserve them. Failure/nondurable/early-return/prestream checks assert release before shutdown and next-turn isolation; actual post-initialize failure verifies cloud ownership in startup unwind. |

Background state retains at most 64 copied origin identities, 16 result bodies of at most
8 KiB, and weak state/event identity keys (no child/Agent/event graph retained). Pending
correlation/capacity/cancellation losses are explicit; no background body can cause idle
publication. The next receiving turn still needs ordinary durable settlement and manual
preview/send. An absent next turn cannot upload the result. Unrelated/ambiguous identities
remain refused. SDK synthetic completion history is never traversed or hydrated.

### Second-pass verification results

- Source-stable upload focus: **120 passed, 0 failed**, `/tmp/darwin-upload-second-final-focus.log`.
- Affected AgentCore suite: **263 passed, 0 failed**, `/tmp/darwin-upload-second-memory.log`;
  includes sendable v1 pre-existing authorization and unchanged signed-loopback payload.
- Source-stable typecheck: exit 0, `/tmp/darwin-upload-second-final-typecheck.log`.
- An intermediate typecheck caught a test assigning SDK readonly `status`; the fixture now
  constructs a new ToolResultBlock through the supported mutable event.result seam.
- The single source-stable `pnpm test` invocation stopped at AgentCore with **6,052 PASS
  lines and two failed ordering assertions**, `/tmp/darwin-upload-second-full-test.log`.
  The fixture reused one state across turns and selected the cancelled turn by substring
  across the whole preview (including missing-result text). It now uses per-turn SDK state
  and parsed outcome. Production source was not changed. Only the affected suite/typecheck
  and the never-reached fail-fast tail ran afterward; no second full gate.
- Repaired affected suite: **263 passed, 0 failed**, `/tmp/darwin-upload-second-memory-repair.log`;
  final typecheck also exits 0. The 17 never-reached suites all exit 0, **722 PASS lines,
  zero FAIL**, `/tmp/darwin-upload-second-gate-tail.log`. Thus every gate suite has a passing
  result on the final production source, but the original monolithic invocation did fail.
- Final `git diff --check` is clean. Post-commit build result is reported in the handoff.
- Setup skill and Host-owned iteration log unchanged. No actual outbox/config/cloud access,
  dependency changes, autonomous Darwin launch, developer skill or push.

## Host acceptance corrections after e947ff7 (historical)

The initial green suites below did not cover the Host's six reproductions. These
corrections change repository projection/hooks/docs only; immutable private entries,
configuration, preference policy, transport and storage contracts remain untouched.

| Gap | Correction and new proof in `spike/verify-agentcore-upload.ts` |
| --- | --- |
| Hidden per-side cap | Descriptor snapshot followed by serialized full-action allocation; exact 3 KiB/6 KiB results with tiny input, 6 KiB input with tiny result, and escaping-sensitive complete content |
| Collection endings/siblings | Complete short multi-block results and 32-block boundary; long first block plus final summary; 80-block/100-element arrays retain 16 head + 16 tail exact indices with omitted middle; 5 KiB/50 KiB stdout retains stderr/cwd/exitCode |
| Getter side effects | Nested array getter and throwing getter, SDK text-field accessor, unchanged event references/descriptors and zero evaluations |
| False pairing on ID reuse | Separate invocation-state scopes with same ID interleaved; same-state overlapping and sequential reuse refuse ambiguous attribution, never attach an old result to a new action |
| Stale setup policy | Built-in setup skill now permits broad public textual evidence and states exclusions/risks; `verify-setup-agentcore-memory.ts` pins the full policy. Historical 32000-byte contract remains explicitly superseded at the top of the older checklist |
| Missed public results | Actual runtime batch cancellation and executor generator failure have zero After hooks and retain labelled ToolResultEvent fallbacks; denial keeps execution evidence; output transformation cannot overwrite it. Real SDK background acknowledgement precedes the completion hook, is retained, and actual late completion leaves prior candidate/new turn unchanged |

Execution evidence is **pre-after-hook**, not necessarily final model-visible output.
A fallback is only an actually observed public result, not recovered history. Missing or
ambiguous identity is explicit. After collection closes, background results cannot update
an old candidate; SDK synthetic completion messages are not traversed. BeforeTools batch
intent inspection shares the 32-entry prefix/suffix bound; skipped batch middle calls may
have unmatched public results, explicitly counted, rather than fabricated input pairs.
`batchEntriesOmitted` counts skipped message entries separately from internal events; the
80-call cancellation fixture checks 32 paired results and 48 unmatched results.
Within one invocation state the public SDK supplies no attempt token for reused IDs:
subsequent pairing is deliberately refused, including retries. A 512-key ledger keeps
identity tombstones; saturation reports unmatched results rather than forgetting identity.
Temporary descriptor snapshots are bounded (128 visited values, depth 8, 32 entries per
container, 8192 copied bytes/string) and pruned before retention. Allocation serializes
only these bounded copies, never a source object. Detailed ranges still address the original
text after further allocation cuts. The existing 8 KiB action / 256 KiB request caps remain.
Object enumeration and Proxy execution still have no hard real-time guarantee.

### Correction verification results

- Final `pnpm tsx spike/verify-agentcore-upload.ts`: **75 passed, 0 failed**;
  `/tmp/darwin-upload-correction-focused.log`. Includes both-side Unicode/escaping
  reallocation with exact original ranges/byte counts and identity-ledger saturation.
- `pnpm tsx spike/verify-setup-agentcore-memory.ts`: **all offline contracts passed**;
  `/tmp/darwin-upload-correction-setup.log`. Policy pins, scripted runtime activation,
  isolated local checks and signed loopback only; no cloud request.
- Final `pnpm typecheck`: exit 0; `/tmp/darwin-upload-correction-typecheck.log`.
- One source-settled `pnpm test`: exit 0, **6,733 PASS lines, zero FAIL**;
  `/tmp/darwin-upload-correction-full-test.log`. Includes unchanged **261 AgentCore**
  checks and the setup/upload suites. No separate repeat of the unchanged AgentCore suite.
- Initial correction verification caught one optional-property type error and a test
  expecting `taskId` instead of the SDK's literal `Task ID:` acknowledgement; both
  corrected before the final gate. All six Host reproductions now have explicit proofs.
- `git diff --check`: clean. Nine repository files changed; no private entry reads or
  mutations, real config, cloud, dependency, iteration-log or history changes. Post-commit
  build and copied-skill equality are reported in the final handoff.

## Initial implementation and measured results (historical)

### Focused checks

- `pnpm tsx spike/verify-agentcore-upload.ts`: **45 passed, 0 failed** (`/tmp/darwin-upload-final-focused.log`). Covers U1–U7: literal goals, arbitrary MCP, public subagent/memory text, image exclusion, exact source ranges, UTF-8/control escaping, deep/wide/million-element arrays, pending/action/turn windows, failure/recovery/tail selection, distinct omissions, late invocation isolation, synchronous nonthrowing observation, queue saturation, delayed publication after close timeout, real runtime early return and nondurable cleanup.
- The real runtime runs 80 tool actions per turn with 54,000-character original results and late tail markers, with offload both on and off. Each trajectory exceeds 1 MiB. Tests inspect actual offloaded/non-offloaded SDK history and verify original late tail capture and immutable trajectory bytes. No path or offload read supplies the candidate. ModelError identity is preserved (the SDK itself wraps a plain Error).
- `pnpm tsx spike/verify-agentcore-memory.ts`: **261 passed, 0 failed** (`/tmp/darwin-upload-agentcore-check.log`). Covers U8–U9 and U2 policy regressions: >64 KiB event roundtrip, standalone read-only CLI preview without proof writes, no send before user preview/hash, actual SDK serialization/signing to loopback, exact payload content, legacy OTHER-only refusal with unchanged bytes/hash/token, tight proof/non-upload caps, order, reservations, retries, idempotency and cancellation. Existing image/bang/custom assistant-exclusion and preference adoption checks remain.
- Pre-gate `pnpm typecheck`: passed. Initial fixture errors were corrected (SDK JSON input typing and the verified recorder `openFile` failure seam).
- Current English/Chinese READMEs, upload narrative, configuration/reference and architecture rationale updated. Historical SDK acceptance is explicitly marked as superseded for upload policy. AGENTS remains **32,748 bytes** (<32,768). No iteration-log append by this worker.

### Deliberate limits and confidentiality

All tool kinds and original textual content are eligible; this is **not a confidentiality guarantee** and may include secrets. No assistant prose/reasoning, SDK media/binary content, child-conversation traversal, path reads or offload/archive hydration. No automatic uploads, extra model calls or model summaries. Existing private entries were neither inspected nor modified; legacy compatibility is tested with synthetic isolated fixtures.

Collector memory is bounded by eight transient turns and eight detached jobs, each retaining at most 64 full actions, 96 lightweight summaries and an 8 KiB goal. JSON visits/depth/container entries and retained metadata are capped. Strings above 262,144 UTF-16 units explicitly report original byte length as unknown to avoid an unbounded scan; original UTF-16 length, retained UTF-8 bytes and ranges remain exact. Unmarked upstream loss cannot be detected. JavaScript object enumeration/Proxy execution is not a hard real-time guarantee; normal public SDK input is JSON, thrown observer faults are counted and swallowed. This implementation does not establish live AWS IAM/extraction behavior.

### Full gate and delivery

- Final source-settled `pnpm test`: exit 0, **6,699 PASS lines, zero FAIL**, including the 261 AgentCore checks and 45 upload checks, plus trajectory, offload, local-memory, clear/rewind, config and CLI regressions. Log: `/tmp/darwin-upload-full-test.log`.
- Final `pnpm typecheck`: exit 0. Log: `/tmp/darwin-upload-final-typecheck.log`.
- `git diff --check`: clean. No changes to trajectory, local-memory validation, preference-record validation, dependencies, real configuration, private outboxes or the iteration log.
- Commit and post-commit `pnpm build` are the delivery steps; their exact result is reported in the worker's final handoff rather than predicting a commit hash here.
