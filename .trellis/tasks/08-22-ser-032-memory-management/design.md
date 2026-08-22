# Design — SER-032 local memory management

## Authority and files

`state.json` becomes the versioned, bounded, strictly validated authority under the existing project-keyed `memory/` directory. It contains generated entries, explicit user notes, omitted-turn count, and bounded generated-ID suppressions. `index.md` and `topics/*.md` remain human-readable projections; runtime prompt loading renders from validated state rather than trusting Markdown. Atomic rename of `state.json` is the commit point.

Generated entries carry `origin: generated`, trajectory provenance, `freshness: unvalidated`, and `sensitivity: heuristic-filtered`. User entries carry `origin: user`, authored time, `freshness: unvalidated`, and `sensitivity: heuristic-screened`. These are honest pipeline states, not claims that code is current or secrets are impossible.

## Mutation flow

The runtime exposes one local management method, available only to TUI dispatch. It parses no arbitrary path. Store operations validate the canonical memory root without following an escaping symlink, load/validate bounded state with `O_NOFOLLOW`, compute the complete next state, write human projections, atomically commit state, then replace the known learned-memory prompt fragment synchronously. Prompt replacement is prepared/validated before disk mutation and preserves skills, working context, and the sole final cache point.

The scheduler serializes management against rebuild work. Rebuild reads existing valid state, preserves user notes and suppressions, filters deterministic generated IDs through suppressions, applies total bounds, then commits the same schema. Unknown forget targets and rejected remembers perform no write.

## Command/output

`src/memory/command.ts` owns strict grammar and bounded report formatting. Bare `/memory` aliases only `list`; no other aliases. List numbers are one-based over the displayed bounded ordering. Command handling is local and idle-only through the existing notice history surface; it never reaches `runtime.send()`.

## Verification

A focused offline suite constructs real runtimes with the capture model, exercises list/show/remember/forget/rebuild and prompt ordering, corrupt/symlink/path inputs, byte-identity sentinels, bounds, and fresh/successor runtimes. Existing command/help/completion, memory, clear, prompt/cache, frame, and full offline suites cover integration.
