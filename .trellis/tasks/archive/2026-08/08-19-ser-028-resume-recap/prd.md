# PRD — SER-028: resumed-session human recap

## Origin

SER-028 in `docs/research/backlog_index.md`, from the peer-product research run in
`docs/research/research_2026-08-19.md` at `2026-08-19T14:12:37Z`. Claude Code restores a
one-line human recap; Codex and OpenCode make saved-chat resume visible; DeepSeek supports an
append-only replay projection. Darwin currently restores model history but starts the TUI with
an empty human transcript.

## Goal

When an interactive TUI restores an existing conversation, show a small, honest startup recap
of the last completed request and assistant answer before the prompt, without changing the
conversation or any durable session state.

## Requirements

- Only a genuinely restored interactive session receives a recap. Fresh sessions and headless
  runs remain unchanged.
- Read the exact restored session's existing `trajectory.jsonl` through the tolerant trajectory
  reader and ordinary replay reducer. Never infer recap text from SDK messages or add a second
  session store.
- Show only the last turn with a recorded `turnEnded`: its user request and assistant answer.
  State that earlier transcript is omitted; never render the full prior transcript.
- Bound request and answer independently by Unicode code points and logical lines, with explicit
  truncation markers. Keep the 120x50 startup frame safe.
- State source limitations honestly: reader damage, capped/dropped payload, no completed turn,
  missing/unreadable record, or trajectory recording disabled. A missing record is normal for a
  session created before trajectory recording or while recording was disabled.
- The recap is immutable startup transcript/history rendered through `<Static>`, not a header or
  permanent live-frame row. `/clear` removes it with the old transcript.
- Loading/rendering the recap makes no model or network call, injects no synthetic model message,
  and mutates neither trajectory bytes, SDK snapshot, resume pointer, agent messages nor
  resumability semantics.

## Acceptance criteria

- [ ] A real restorable SDK snapshot plus matching trajectory, launched with `--resume <id>`,
      shows a bounded recap naming the last completed request and answer before `you>`.
- [ ] Missing/disabled, damaged, incomplete and payload-omitted records degrade explicitly.
- [ ] Focused offline verification proves Unicode/line bounds, exact-last-turn selection, tolerant
      damage handling and byte-identical trajectory reads.
- [ ] A free 120x50 pty scenario hashes trajectory, snapshot and `last-session.json` before/after
      startup; observes no added trajectory record; exits without a model/network call; and proves
      a fresh TUI has no recap.
- [ ] Focused replay/session/TUI checks, `pnpm typecheck`, one final `pnpm test`, Trellis validation
      and `git diff --check` pass.
- [ ] Architecture/spec documentation records the new startup-recap contract.
