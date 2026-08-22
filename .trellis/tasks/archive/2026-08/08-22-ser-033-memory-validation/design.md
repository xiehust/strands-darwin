# SER-033 design

## State and anchor model

Bump the strict memory manifest to v2 and accept/migrate v1 in memory. Each generated fact may carry one exact anchor: project-relative POSIX path, UTF-8 line number, SHA-256 of the exact normalized line, and line code-point count. Extraction derives an anchor only when a fact exactly matches one unique bounded line in a safe current project file named in that fact; otherwise the fact remains unanchored and therefore unknown. Persist bounded validation metadata on generated entries; never add validation fields to user notes.

## Validation and eligibility

Add a memory validation module owning canonical-root containment, no-follow bounded reads, exact line/hash checks, age classification, and the single eligible state/index projection. Status precedence is expired at/after the horizon, then unknown for absent/unsafe/unreadable evidence, invalid for deterministic mismatch/deletion, valid only for exact matches. A horizon of 0 disables expiry. Validation metadata can be atomically persisted in the memory store for audit, but source bytes are read-only.

`loadMemoryIndex` accepts horizon/clock options and returns the eligible rendered index. `runMemoryCommand` accepts the same options, validates before list/show and before rendering the post-mutation index. `AgentRuntime.create` supplies config horizon before agent construction; the existing factory consequently covers fresh/resumed/clear. Runtime management supplies the same live config.

## Bounds and degradation

Use a finite generated-entry/fact count, path length, source file byte/line/code-point bounds, fatal UTF-8 decoding, canonical root checks, regular-file/no-follow opens, and post-read stability checks. Validation exceptions become unknown and omit generated context; corrupt memory state keeps existing refusal behavior. Reports expose path/line/hash prefix/state/reason only, never source text.

## Verification

Extend the focused memory/config suites and add validation fixtures. Exercise runtime prompt refresh seams, model switch inheritance, exact expiry boundary, restored source reactivation, and before/after hashes for all observed non-memory files. Then run typecheck, one full `pnpm test`, build, Trellis validation, and scoped git/AGENTS checks.
