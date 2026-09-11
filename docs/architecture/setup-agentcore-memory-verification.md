# `/setup-agentcore-memory` verification checklist

Implementation scope: bundled-guide workflow refinement and offline command/skill tests, not
provisioning or a deterministic wizard. Existing-first preflight reuses the real config loader,
offline doctor and read-only cloud-memory commands; doctor has no network or write path.

Host accepted the refinement at `ced186c` (2026-09-11): independent diff review, typecheck and
one uninterrupted full `pnpm test` passed (6,649 counted PASS rows, zero FAIL), including the
new preflight evidence fixtures, setup contract assertions and four runtime/pty recovery cases.
Host build plus relocated `--dist` activation/npm dry-run checks passed. Artifacts:
`/tmp/darwin-preflight-host-{typecheck,test,build,dist}.log`. Runtime/doctor/permission code,
dependencies, AGENTS.md and real configuration are unchanged. No actual cloud setup ran.

Preflight regression checklist:
- Full guide → sensitive config read → doctor/local status/bounded SDK read → healthy stop →
  conditional actor/default or targeted repair questions. Arguments/yolo are never mutation consent.
- Missing file/field and intentional false are distinct; invalid JSON/schema and unreadable
  config block repair rather than falling through. Existing actor/resource/scope/settings survive.
- Empty retrieval succeeds; disabled preferences may be checked without enabling/adopting.
  Local status/doctor zero alone are not connectivity. Unrelated doctor warnings stay separate.
- HTTP denial, timeout, invalid response, wrong namespace and unavailable credentials remain
  failures, with bounded redacted categories, not absence, success or automatic reset.
- Unchanged healthy setup stops without questions, writes or restart. Explicit reconfiguration
  reports original health before targeted consent. Extraction/write/topology remain unverified.

`setup-memory-preflight.ts` is invoked by the setup suite: private HOME, isolated region/credentials,
real loader/doctor/standalone CLI and signed SDK requests through the existing loopback seam.
Filesystem snapshots cover bytes, file mtimes and modes; only synthetic server logs are excluded.
A directory at config.json exercises unreadable (EISDIR) semantics without depending on chmod
under root. Scripted healthy/missing/failed replies test both headless drivers' full-guide delivery;
only normal session/trajectory writes are allowed. They do not prove arbitrary model compliance.

Host acceptance at `1b6362c` (2026-09-11): independent diff review, typecheck and one uninterrupted
full `pnpm test` passed. The log contains 6,645 counted PASS rows, zero FAIL, plus the new setup
contract assertions and four immediate/queued × text/image runtime/pty recovery cases.
Additional Host checks passed: completion/help 74, path completion 27, build, relocated `dist`
activation and npm dry-run package footprint. Logs: `/tmp/darwin-setup-host-{typecheck,test,
completion,path-completion,build,dist}.log`. The bundled guide is 14,259 bytes; AGENTS.md is
32,748 bytes. No cloud provisioning, installs or real user configuration changes were performed.
Both accepted commits and worker spend are recorded in iteration-log Batch 125.

| Contract | Independent check |
| --- | --- |
| Required bundled guide; project/global `.darwin` and `.agents` skills/custom commands cannot shadow it | New setup suite: actual `scanSkills`/`loadCustomCommands`, private HOME, missing/malformed/empty guide fixtures |
| Exact case-insensitive slash grammar; bare starts setup; optional remainder preserved, not consent | New setup suite: actual `AgentRuntime.expandSlashCommand`, unknown suffix/prose cases |
| Full official activation, single catalogue entry, no guide in ambient system prompt | New setup suite: real runtime plus offline model request capture and `load_skill` activation; text/structured headless drivers deliver the full guide and return questions |
| Expansion has no tool, file/config or cloud effects; normal send keeps literal user trajectory | New setup suite: filesystem snapshots, tool events, offline send and recorded `userInput` |
| Activation failure stops and returns failed literal input/image plus later queued user entries, preserving newer drafts and held shell reports | Loader fixtures; `verify-setup-recovery.ts`: four real runtime/pty cases, removed private setup root, no later drain or failed userInput, repair/remove and retry |
| Busy submission stays literal and expands only on the next turn | Existing queue suites plus setup queue case |
| Help/completion uses canonical description once; every built-in fits the offered cap | New suite plus real `verify-tui.ts completion` (including `/help`) |
| Existing config first, doctor/local status/live readonly read, healthy stop before questions; setup/repair consent only as needed | Structural guide-order and safety pins; real loader/doctor/loopback CLI cases; scripted healthy/missing/failed turns in both headless formats (delivery, not live-model compliance) |
| Defaults/config preserve confirmed deviations, sensitive reads, private mode, no credentials, restart | Actual config loader retains upload off/preferences false/nondefault timeout/region; guide assertions permit confirmed retention/KMS key while namespace JSON stays invariant |
| Resource reuse/create schema, exact namespaces, pagination, ACTIVE checks, bounded idempotent wait | Parsed request JSON compared with runtime scope and pinned AWS control-plane shape; guide contract assertions |
| Install consent, bundled runtime vs control-plane/optional infra CLI, import fidelity, IAM/cost/TTL limits | Guide contract assertions; no installs or AWS calls |
| Read-only verification distinguishes local status/connectivity from extraction, topology and write proof | Empty/read-only nonempty loopback retrieval, failure fixtures and guide assertions; no real AWS verification |
| User-only preference/upload handoff, privacy projection, no fake consent or auto-seeding | Guide contract assertions and existing AgentCore suite |
| Completion reports complete vs pending and every requested outcome | Guide contract assertions |
| Installed guide is self-contained and shipped without repository docs | Post-commit build; relocated dist loader/activation; `npm pack --dry-run --ignore-scripts` manifest |
| English/Chinese discovery, narrative guide and reference; bounded architecture instructions | Documentation link/content checks and AGENTS byte cap |
| Existing command/skill behavior stays intact | Focused init/workflow/skill suites; typecheck; one full `pnpm test`; completion pty |

The setup guide is an agent workflow, not a deterministic consent sandbox. Offline scripted responses prove delivery and ordinary streaming/recording, not arbitrary live-model obedience or AWS provisioning correctness.
