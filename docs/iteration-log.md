# How darwin develops darwin — the iteration log

A human remains the developer of record: they state the requirement, approve the plan, resolve
product or permission decisions, and independently accept the result. The implementation itself
is written by the current darwin running in this repository; once accepted and committed, that
revision becomes the darwin used to write the next one. `AGENTS.md`, the Trellis task records,
and the verification scripts carry constraints and evidence from one generation to the next.

The control loop has evolved along with the product. The first self-development runs piped
scripted input into the plain `dev-repl`. Headless `-p` turns and explicit session continuation
then made that exchange machine-readable; managed background bash jobs and `/tasks` made long
child runs observable without blocking the interactive session. Today the built-in `/developer`
workflow lets an interactive darwin act as the Host for another headless darwin: the Host requests
and reviews a plan, continues the same child session for implementation, monitors it in the
background, and independently inspects the diff and runs acceptance checks. Unresolved product
choices and authorization still go back to the human. In other words, darwin can now operate the
supervision machinery that was once driven by hand, without removing the human decision boundary.

Every entry below is a shipped commit, not a roadmap item, and every implementation was written
and submitted by darwin itself. **Every `/developer` supervision run must append its batch record
here before it reports completion** — the log is part of the paper trail, same as the Trellis
task history.

## Capability milestones (after the v0.0.1 baseline)

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-14 | `848fac1` | Remember permission approvals as constrained wildcard rules |
| 2026-08-14 | `6226ecb` | Add adaptive thinking effort and live `/effort` changes |
| 2026-08-14 | `d3032a3`, `1851492`, `dd1503c` | Add Bedrock Mantle/OpenAI, multiple model configs, and live `/model` switching |
| 2026-08-14 | `780ec93` | Add explicit `/compact` conversation compaction |
| 2026-08-14 | `72320b0` | Support multiline prompt input |
| 2026-08-14 | `476a74f` | Add project-defined slash commands |
| 2026-08-14 | `41ad79a` | Add isolated subagent delegation |
| 2026-08-14 | `ae1689d` | Add project tool-lifecycle hooks |
| 2026-08-14 | `65c22d5` | Add session-owned background bash jobs |
| 2026-08-14 | `18bec63` | Add `/tasks` background-job monitoring |
| 2026-08-14 | `12aa7d8` | Add one-shot headless mode with persistent session continuation |
| 2026-08-14 | `3a189fd` | Add the built-in `/developer` Host-supervisor workflow |

## Supervised iteration batches

Each batch is one `/developer` run: an interactive Host darwin supervising a single persistent
headless child session through planning, per-round implementation, and independent acceptance
(fast suites on every round; pty scenarios and live spikes from the Host where a round warrants
them).

### Batch 1 — TUI interaction and polish (2026-08-15)

Five mandated rounds plus one acceptance-driven fix, all in child session
`session-20260815-070446825`. Host acceptance re-ran the pty scenarios `completion`, `cursor`,
`multiline`, `approve`, `deny`, `bashExit`, `tasks`, and `alwaysAllow` against real model calls;
the one failure found (`alwaysAllow`) predated the batch and became its sixth commit.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `247b6e6` | Show elapsed time on running tool calls |
| 2026-08-15 | `e7f6b00` | Add readline editing chords (Ctrl+A/E/K/U/W) to the prompt |
| 2026-08-15 | `23cae09` | Color notices by severity (error red, degradation yellow) |
| 2026-08-15 | `b75186e` | Collapse failed tool previews from the tail, keep `DENIED:` heads |
| 2026-08-15 | `dae8da7` | Describe built-in commands in the completion menu |
| 2026-08-15 | `e099373` | Fix the stale `alwaysAllow` pty scenario (rules moved to the project-keyed file) |

### Batch 2 — token efficiency, prompt cache, context management (2026-08-15)

Five rounds in the same child session, planned against measured SDK behavior (free heuristic
`countTokens`, per-model context-window table, the vended `ContextOffloader` plugin). Host
acceptance included `verify-prompt-cache-live.ts` both on the default path and with
`contextOffload` enabled. A parallel interactive session landed `a601d8f`
(configurable Bedrock stream idle timeout) in the same tree mid-batch.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `0bdcd3c` | Add `/context`: estimated context tokens and model-window share |
| 2026-08-15 | `6a2a7d2` | Derive cache hit ratio and served-from-cache rows in `/usage` |
| 2026-08-15 | `a2788d0` | Warn once when context crosses `contextWarnRatio` of the window |
| 2026-08-15 | `32d19a1` | Show the per-turn token delta in `/usage` |
| 2026-08-15 | `115e6c0` | Offload oversized tool results behind `contextOffload` (SDK plugin, session-scoped storage) |

### Batch 3 — child spend visibility and offload hardening (2026-08-15)

Three rounds closing the loop the batches themselves exposed: a supervised child's token spend
was invisible to the Host, `maxResultTokens` could crash startup with a raw SDK throw, and
offload storage accumulation was undocumented. The batch-3 report was the first to include the
per-child usage table its own first round made possible.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `f574b81` | Headless runs report token spend as a `usage:` stderr record; `/developer` aggregates it |
| 2026-08-15 | `359465a` | Reject a `maxResultTokens` the offloader cannot accept (measured floor: 1001) |
| 2026-08-15 | `7372216` | State that offload storage accumulates by design; pin reference durability with a test |

### Batch 4 — self-evolution research workflow (2026-08-15)

One planning and one implementation round in child session
`session-20260815-145125890`. The first managed task,
`bg-ec73fd80-194a-4c4d-abd0-0f7d785ec0c8`, failed deterministically before any
model, session, or usage record because the Host accidentally passed an extra `--`.
Planning then succeeded in `bg-674aa247-1395-4bd6-a1ac-807fd94c12e5`, and implementation
succeeded in `bg-efcaecdf-1652-4217-a418-d200b9e84072`.

The implementation delegation prohibited commits, so Host acceptance was completed before the
user's later explicit commit-and-push request. The Host inspected the complete diff, including the
new `SKILL.md`, backlog index, research report template, and Trellis artifacts. Host acceptance
re-ran `verify-skills.ts` (84 passed, 0 failed), `pnpm typecheck`, and `pnpm test` successfully;
the test run emitted the expected MCP `continueOnError` diagnostic for
`DARWIN_DEFINITELY_UNSET` on stderr and still exited 0. `pnpm build` plus the compiled-skill grep
passed, and `npm pack --dry-run --json` contained both the `developer` and
`self-evolution-research` packaged `SKILL.md` assets. Trellis task validation passed with only
the existing max-file-byte truncation warnings for the large SDK contract spec, and
`git diff --check` passed.

| Date | Commit | Milestone |
|---|---|---|
| 2026-08-15 | `f905229` | Add the built-in self-evolution research workflow, persistent ranked backlog/report contracts, required-built-in verification, and concise product/spec documentation |
| 2026-08-15 | `731003e` | Normalize developer usage into independently costed input, cache-read, cache-write, and output buckets |
