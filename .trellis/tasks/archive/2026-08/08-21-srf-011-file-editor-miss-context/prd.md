# PRD — SRF-011: recover exact str_replace misses with bounded context

## Origin

Backlog direction SRF-011 (`docs/research/backlog_index.md`) from reflection finding F3
(`docs/reflections/reflection_2026-08-21_session-20260821-054705633.md`): a stale exact
`old_str` at trajectory seq 236–237 failed, and the next turn had to rediscover current text before
a corrected exact retry at seq 239–240. The Host owns the dirty backlog row; this task must not
modify or stage that file.

## Goal

When the SDK-vended `fileEditor str_replace` cannot find `old_str` verbatim, preserve the exact
failure and append enough bounded, line-numbered current context to support a corrected exact retry.
No recovery path may mutate fuzzily or write on a miss.

## Requirements

- Extend only the version-pinned SDK-private zero-occurrence `str_replace` path. Darwin continues
  importing the SDK singleton directly; do not wrap the tool, duplicate its schema, or intercept its
  provider-facing result.
- Exact matching and successful replacement remain byte-compatible. A miss remains an error, never
  retries, never substitutes the advisory match, and performs zero sandbox writes.
- Select advisory context deterministically from current content with documented fixed bounds on
  file work, `old_str` work, excerpt lines, and excerpt line width. Tied candidates choose one
  deterministic location.
- Emit a conservative explicit absence reason when `old_str` exceeds the advisory search cap or no
  sufficiently close textual candidate exists. Never dump arbitrary beginning/end content.
- Clearly separate the original error from advisory context, identify that no fuzzy replacement was
  attempted, number current lines, and state excerpt/line truncation honestly.
- Preserve sandbox path/read/write ownership, the 1 MiB read limit, directories/missing paths,
  validation order, multiple-occurrence errors, all view behavior, Unicode scalar boundaries, file
  bytes and metadata on miss, and all provider schema/input fields.

## Acceptance criteria

- [ ] A real provider-facing tool call with a stale near-match returns an error plus bounded,
      line-numbered current context that contains the correction text.
- [ ] No useful match is explicit; equally close candidates choose deterministically; huge and
      adversarial `old_str`/file inputs stay bounded; Unicode output is intact.
- [ ] Failed calls leave bytes and write metadata unchanged and call the sandbox write primitive
      zero times; an exact match still writes exactly the requested replacement.
- [ ] Unrelated validation, size, missing-path, directory, and multiple-occurrence errors retain
      their existing shape without advisory context.
- [ ] The regenerated pnpm patch applies to the installed SDK and its JavaScript passes syntax
      checking; `pnpm tsx spike/verify-file-editor.ts`, `pnpm typecheck`, `pnpm test`, and
      `pnpm build` pass.
- [ ] SDK contract, AGENTS load-bearing index if needed, and Trellis artifacts document the pinned
      behavior and upgrade checks; commit excludes the Host-owned backlog file.
