# PRD — SRF-005: clamp oversized fileEditor view end to EOF

## Origin

Backlog direction SRF-005 (`docs/research/backlog_index.md`) from reflection finding F3
(`docs/reflections/reflection_2026-08-19_session-20260819-094621980.md`): a request for
`view_range: [1, 100]` against a 41-line file failed and forced an immediate `[1, -1]` retry.
The Host owns backlog, reflection, and iteration-log closure; this task must not edit them.

## Goal

Normalize only an otherwise-valid positive `fileEditor view` end line beyond EOF to EOF, while
preserving the SDK-vended tool's schema, output format, validation, I/O, and write behavior.

## Requirements

- `[1, 100]` against a 41-line regular text file succeeds and emits exactly lines 1–41 in the
  existing numbered `cat -n` format, without duplication, omission, or a write.
- Clamp only a positive end line above the file's effective line count. The existing `-1` EOF
  sentinel and in-range positive ranges remain byte-compatible.
- Invalid starts (including starts beyond EOF), start/end ordering errors, and zero or negative
  endpoints other than the `-1` end sentinel remain explicit failures.
- Empty files, directories, missing files, decoding/binary behavior, the 1 MiB size limit, path
  validation, and all create/replace/insert behavior remain unchanged.
- Use the smallest established extension seam. A version-pinned SDK patch is permitted because
  `fileEditor` is SDK-vended, but no agent-loop fork, Darwin-side output rewrite, dependency, or
  provider/network call is permitted.

## Acceptance criteria

- [ ] Focused offline coverage drives the real SDK tool through its provider-facing `stream()`
      path/schema against real files and proves exact EOF output and zero writes.
- [ ] Focused coverage pins oversized-end success, invalid bounds, sentinel/in-range
      compatibility, and unchanged non-regular/error/size behavior.
- [ ] `pnpm tsx spike/verify-file-editor.ts`, `pnpm typecheck`, and `pnpm test` pass.
- [ ] The SDK contract/spec records the pinned behavior and upgrade check.
- [ ] Trellis artifacts validate and the implementation is committed without Host-owned docs.
