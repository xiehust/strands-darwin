# SER-040 conversation-only rewind

## Goal

Add `/rewind` as an in-session, conversation-only branch from an earlier completed prompt boundary. The source session remains authoritative, immutable and resumable; the selected prompt becomes an editable draft in a fresh successor runtime.

## Requirements

- Before an eligible invocation and only while rewind capacity remains, create a Strands SDK immutable snapshot of the authoritative Agent state and, only after that prompt completes successfully, catalogue the snapshot with bounded prompt metadata.
- Bound total rewind-owned immutable snapshot creation and catalogue reads at 100 per session. Failed/cancelled captures count; at capacity ordinary turns continue without a new rewind checkpoint. Use only bounded public SDK listings, never trajectory reconstruction.
- `/rewind` lists only completed prompts from the live source session. Failed, cancelled, in-progress, over-bound, unmapped, stale and unavailable boundaries are excluded or refused with an honest local explanation.
- Restoring creates a fresh session through the existing `AgentRuntime.create()` assembly. Restore the selected SDK snapshot into that successor, then re-apply current learned-memory, working-context and prompt-cache placement contracts.
- Inherit the predecessor's live permission mode, MCP clients and background-task process ownership exactly as `/clear` does. Retire the predecessor only after successful successor assembly and restore.
- Put the selected prompt back into the editor without sending it. The successor must not move the resume pointer until its first completed turn.
- Never truncate, rewrite or reconstruct the source session, its mutable latest snapshot, immutable snapshots, catalogue or trajectory while branching. Never mutate or revert workspace state.
- The branch notice must explicitly say the workspace is unchanged and that workspace files, shell and `!` effects, hooks, MCP writes, subagents, background jobs and learned-memory files were not rewound.
- Add `/rewind` to canonical completion and `/help`, grow `MAX_COMPLETIONS`, and keep the chooser within the existing frame budget and keyboard ownership rules.
- Preserve `/clear` successor ownership and shutdown semantics. Only `src/agent/runtime.ts` may construct `Agent`.

## Acceptance Criteria

- [ ] Offline tests prove immutable snapshots are captured at the initial/pre-invocation boundary, never exceed 100 across successes/failures/cancellation, and are catalogued only for successful completed prompts; the 101st eligible ordinary turn still runs and updates latest state.
- [ ] `trajectory: false` supports rewind; failed turns and resumed sessions report only real eligible checkpoints.
- [ ] Branching leaves source latest/immutable snapshots, catalogue, trajectory, workspace and resume pointer byte-identical.
- [ ] The selected SDK checkpoint is restored into a fresh session and the selected prompt returns to the editor unsent; source remains resumable.
- [ ] Busy, stale, unmapped, in-progress and no-checkpoint cases refuse safely.
- [ ] The successor inherits live permission mode, MCP clients and background-task ownership; restored skills/system prompt plus current memory/working context/cache ordering remain valid.
- [ ] The resume pointer moves only after a successor turn completes.
- [ ] The notice states workspace unchanged and names every omitted side-effect domain required above.
- [ ] `/rewind` appears in completion and `/help`; `MAX_COMPLETIONS` grows; a free pty scenario exercises selection and branching.
- [ ] Focused offline checks, completion, typecheck, full `pnpm test`, build, Trellis validation and repository checks pass without a provider call.
- [ ] Documentation updates preserve the trajectory authority boundary and record rewind as a load-bearing decision.

## Out of Scope

- Filesystem rollback, Git reset/revert, shell process rollback, hook/MCP compensation, subagent undo, background-job cancellation, learned-memory rollback or trajectory-based model reconstruction.
- Destructive in-place conversation truncation, cross-session checkpoint selection, automatic resend of the selected prompt, dependency upgrades or provider calls.
