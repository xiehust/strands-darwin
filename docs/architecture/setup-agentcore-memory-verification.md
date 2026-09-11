# `/setup-agentcore-memory` verification checklist

Implementation scope: offline command/skill integration, not provisioning. Host owns the iteration log.

| Contract | Independent check |
| --- | --- |
| Required bundled guide; project/global `.darwin` and `.agents` skills/custom commands cannot shadow it | New setup suite: actual `scanSkills`/`loadCustomCommands`, private HOME, missing/malformed/empty guide fixtures |
| Exact case-insensitive slash grammar; bare starts setup; optional remainder preserved, not consent | New setup suite: actual `AgentRuntime.expandSlashCommand`, unknown suffix/prose cases |
| Full official activation, single catalogue entry, no guide in ambient system prompt | New setup suite: real runtime plus offline model request capture and `load_skill` activation; text/structured headless drivers deliver the full guide and return questions |
| Expansion has no tool, file/config or cloud effects; normal send keeps literal user trajectory | New setup suite: filesystem snapshots, tool events, offline send and recorded `userInput` |
| Activation failure stops instead of sending unguided input | Loader/activation failure fixtures and offline TUI failure scenario |
| Busy submission stays literal and expands only on the next turn | Existing queue suites plus setup queue case |
| Help/completion uses canonical description once; every built-in fits the offered cap | New suite plus real `verify-tui.ts completion` (including `/help`) |
| Actor question/stop, reuse confirmation, grouped defaults, arguments/yolo/headless not consent | Guide contract assertions and offline scripted question turn; not a claim of live model compliance |
| Defaults/config preserve existing settings, sensitive reads, private mode, no credentials, restart | Parsed guide JSON validated by actual config loader; guide contract assertions |
| Resource reuse/create schema, exact namespaces, pagination, ACTIVE checks, bounded idempotent wait | Parsed request JSON compared with runtime scope and pinned AWS control-plane shape; guide contract assertions |
| Install consent, bundled runtime vs control-plane/optional infra CLI, import fidelity, IAM/cost/TTL limits | Guide contract assertions; no installs or AWS calls |
| Read-only verification distinguishes local status/connectivity from extraction and write proof | Guide contract assertions; no live verification |
| User-only preference/upload handoff, privacy projection, no fake consent or auto-seeding | Guide contract assertions and existing AgentCore suite |
| Completion reports complete vs pending and every requested outcome | Guide contract assertions |
| Installed guide is self-contained and shipped without repository docs | Post-commit build; relocated dist loader/activation; `npm pack --dry-run --ignore-scripts` manifest |
| English/Chinese discovery, narrative guide and reference; bounded architecture instructions | Documentation link/content checks and AGENTS byte cap |
| Existing command/skill behavior stays intact | Focused init/workflow/skill suites; typecheck; one full `pnpm test`; completion pty |

The setup guide is an agent workflow, not a deterministic consent sandbox. Offline scripted responses prove delivery and ordinary streaming/recording, not arbitrary live-model obedience or AWS provisioning correctness.
